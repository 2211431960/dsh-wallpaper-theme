/**
 * Host half of the wallpaper theme bundle.
 *
 * Two jobs: walk folders for playable media, and stream the chosen file back to
 * the renderer. The renderer loads the application over `dsh-app://app/`, whose
 * non-static requests the shell forwards to this Host's HTTP server, so a
 * registered route is the only way a local file of unbounded size can reach the
 * page — `file://` is out of reach and a data URL would have to buffer it whole.
 *
 * Range requests are answered with 206 so large videos seek instead of
 * downloading entire.
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'

/** Extensions the browser can paint as a still image. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.gif', '.bmp', '.avif', '.svg'])

/** Extensions the browser can play as a looping video. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.ogv', '.mpg', '.mpeg', '.ts'])

/** Content types keyed by extension; the fallback lets the browser sniff. */
const CONTENT_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.ogv': 'video/ogg',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ts': 'video/mp2t',
}

/** Steam library directories searched on every drive, relative to the drive root. */
const STEAM_LIBRARY_SUFFIXES = [
  'Program Files (x86)/Steam',
  'Program Files/Steam',
  'SteamLibrary',
  'Games/Steam',
  'Steam',
]

/** Wallpaper Engine's Steam application id; workshop items live under it. */
const WALLPAPER_ENGINE_APP_ID = '431960'

/** How deep a scan descends; Wallpaper Engine nests media two levels down. */
const MAX_SCAN_DEPTH = 4

/** Upper bound on returned entries, so a huge library cannot flood the list. */
const MAX_ENTRIES = 3000

/** Classify one file by extension, or return undefined when it is not media. */
function mediaKind(file) {
  const name = basename(file).toLowerCase()
  // TypeScript declarations end in `.d.ts` or `-d.ts` (the `.test-d.ts` form),
  // both of which share their extension with an MPEG transport stream. Without
  // this guard every declaration file on disk was listed as a video and buried
  // the real wallpapers in the results.
  if (name.endsWith('.d.ts') || name.endsWith('-d.ts')) return undefined
  const extension = extname(name)
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  return undefined
}

/** Recursively collect playable media under one directory. */
async function scanDirectory(root, depth, out) {
  if (depth > MAX_SCAN_DEPTH || out.length >= MAX_ENTRIES) return
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) return
    if (entry.name.startsWith('.')) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      await scanDirectory(full, depth + 1, out)
      continue
    }
    if (!entry.isFile()) continue
    const kind = mediaKind(full)
    if (kind === undefined) continue
    let size = 0
    try {
      size = (await stat(full)).size
    } catch {
      continue
    }
    out.push({ name: entry.name, path: full, kind, size, dir: root })
  }
}

/** Candidate Wallpaper Engine and Steam workshop directories present on this machine. */
function detectRoots() {
  const roots = []
  const push = (path, label) => {
    if (path !== '' && existsSync(path) && !roots.some(row => row.path === path)) roots.push({ path, label })
  }
  for (let code = 67; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`
    if (!existsSync(drive)) continue
    for (const suffix of STEAM_LIBRARY_SUFFIXES) {
      const library = join(drive, ...suffix.split('/'))
      push(join(library, 'steamapps', 'workshop', 'content', WALLPAPER_ENGINE_APP_ID), 'Steam 创意工坊')
      push(join(library, 'steamapps', 'common', 'wallpaper_engine', 'projects', 'myprojects'),
        'Wallpaper Engine 我的项目')
      push(join(library, 'steamapps', 'common', 'wallpaper_engine', 'projects', 'defaultprojects'),
        'Wallpaper Engine 内置项目')
    }
  }
  const home = process.env.USERPROFILE ?? ''
  if (home !== '') push(join(home, 'wallpaper_engine', 'projects', 'myprojects'), 'Wallpaper Engine 我的项目')
  return roots
}

/** Answer one JSON body. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(body.length))
  res.end(body)
}

/** File size, or undefined when the path is missing or is a directory. */
function fileSize(file) {
  try {
    const info = statSync(file)
    return info.isFile() ? info.size : undefined
  } catch {
    return undefined
  }
}

/**
 * Stream one local file, honouring a single byte range.
 *
 * The renderer's request reached this server through the shell's forwarding
 * layer, which drops connection-level headers, so only the range semantics
 * matter here: a 206 with `content-range` is what lets a video seek.
 */
/**
 * Send one stream without ever letting it take the process down.
 *
 * A read stream emits 'error' when the file disappears mid-read, and the response
 * emits one when the renderer aborts — which a video does on every seek. With no
 * listener, either becomes an unhandled exception and the whole Host process exits.
 * That is how the desktop lost its application list: dozens of preview videos
 * seeking at once, one aborted request, no Host left to enumerate installed apps.
 */
function pipeFile(stream, res) {
  stream.on('error', () => {
    if (!res.headersSent) res.statusCode = 500
    res.end()
  })
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

function streamFile(req, res, file) {
  const total = fileSize(file)
  if (total === undefined) {
    sendJson(res, 404, { error: 'not-found' })
    return
  }
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('content-type', CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
  const range = req.headers.range
  const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/u.exec(range) : null
  if (match === null) {
    res.statusCode = 200
    res.setHeader('content-length', String(total))
    pipeFile(createReadStream(file), res)
    return
  }
  const hasStart = match[1] !== ''
  const hasEnd = match[2] !== ''
  const start = hasStart ? Number(match[1]) : Math.max(0, total - Number(match[2]))
  const end = hasStart && hasEnd ? Number(match[2]) : total - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    res.statusCode = 416
    res.setHeader('content-range', `bytes */${total}`)
    res.end()
    return
  }
  const last = Math.min(end, total - 1)
  res.statusCode = 206
  res.setHeader('content-range', `bytes ${start}-${last}/${total}`)
  res.setHeader('content-length', String(last - start + 1))
  pipeFile(createReadStream(file, { start, end: last }), res)
}

/** The Host services this plugin needs before `apply` runs. */
export const inject = ['webServer']

/**
 * Register the wallpaper routes on the Host's HTTP carrier.
 * @param ctx - plugin context; `webServer` arrives through `inject`.
 */
export function apply(ctx) {
  const server = ctx.get('webServer')
  if (server === undefined || server === null) {
    ctx.logger?.warn?.('wallpaper-theme: webServer unavailable; routes not registered')
    return
  }
  const routes = [
    {
      kind: 'exact',
      path: '/wallpaper/roots',
      handler: (_req, res) => { sendJson(res, 200, { roots: detectRoots() }) },
    },
    {
      kind: 'exact',
      path: '/wallpaper/list',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const dir = url.searchParams.get('dir') ?? ''
        if (dir === '') {
          sendJson(res, 400, { error: 'dir-required' })
          return
        }
        const root = resolve(dir)
        if (!existsSync(root)) {
          sendJson(res, 404, { error: 'directory-not-found', dir: root })
          return
        }
        // One file is accepted as well as a folder. The desktop shell only offers a
        // directory chooser, so pasting a single file's path is the only way to
        // point at one specific wallpaper.
        if (statSync(root).isFile()) {
          const kind = mediaKind(root)
          const items = kind === undefined ? [] : [{
            name: basename(root), path: root, kind, size: statSync(root).size, dir: dirname(root),
          }]
          sendJson(res, 200, { dir: root, items, truncated: false })
          return
        }
        const out = []
        await scanDirectory(root, 0, out)
        out.sort((left, right) => left.name.localeCompare(right.name))
        sendJson(res, 200, { dir: root, items: out, truncated: out.length >= MAX_ENTRIES })
      },
    },
    {
      kind: 'exact',
      path: '/wallpaper/file',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const target = url.searchParams.get('path') ?? ''
        if (target === '') {
          sendJson(res, 400, { error: 'path-required' })
          return
        }
        streamFile(req, res, resolve(target))
      },
    },
  ]
  for (const route of routes) ctx.effect(() => server.register(route))
}
