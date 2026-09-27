/**
 * Client half of the wallpaper theme bundle.
 *
 * Owns two things the Host cannot: the wallpaper layer itself, and the glass
 * surfaces. The layer is a fixed element inserted as the first child of
 * `<html>`, so it paints behind `<body>`; the glass comes from rewriting two
 * surface tokens with an alpha channel rather than from touching the frame's
 * class names, which are hashed and not addressable from outside.
 *
 * The originals are read with this plugin's own overrides temporarily removed,
 * so repeated theme switches never compound one alpha onto another.
 */
window.__ModuleLoader__.load({
  id: '@local/wallpaper-theme',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STORAGE_KEY = 'wallpaper-theme:v1'

    /**
     * Bumped whenever a stored number stops meaning what it used to.
     *
     * Settings written by an older build are ignored rather than read back: the
     * panel has been through several designs, and honouring a stale value would
     * silently undo the current one on the next launch.
     */
    const STORAGE_VERSION = 5
    const LAYER_ID = 'wallpaper-theme-layer'

    /**
     * Glass token groups, each carrying its own opacity.
     *
     * `surface` is the application frame. `component` is every popup layer —
     * dropdown menus, option rows, cards — and is kept separate because a menu
     * has to stay readable while the frame behind it goes thin; one shared value
     * forces a choice between a washed-out frame and an unreadable menu.
     *
     * `--dsw-menu-surface-fill` is the dropdown panel token; the three layer
     * tokens are the stacked component fills used by option rows and cards.
     */
    const GLASS_TOKENS = [
      ['--dsw-alias-bg-base', 'surface'],
      ['--dsw-specific-sidebar-fill', 'surface'],
      // The popup plate. Every menu in this interface paints its plate with this one
      // token, whichever element it happens to be, so thinning the token makes all of
      // them glass at once. Element selectors reached one menu and missed the next —
      // which is exactly how one popup stayed a 58% white card while another had no
      // plate at all. Its own group keeps the 毛玻璃不透明 slider in charge of it.
      ['--dsw-menu-surface-fill', 'menu'],
      ['--dsw-alias-bg-layer-1', 'component'],
      ['--dsw-alias-bg-layer-2', 'component'],
      ['--dsw-alias-bg-layer-3', 'component'],
    ]

    /** The surface token whose base colour anchors the text-hierarchy blend. */
    const SURFACE_BASE_TOKEN = '--dsw-alias-bg-base'

    /**
     * Text tokens driven by the RGB control, each paired with how far it blends
     * toward the surface colour.
     *
     * Blending keeps secondary and tertiary opaque. Reducing their alpha instead
     * renders the whole hierarchy semi-transparent — most of the interface reads
     * those two tokens, so it looks washed out, and a light choice over a light
     * surface becomes nearly invisible.
     */
    const LABEL_TOKENS = [
      ['--dsw-alias-label-primary', 0],
      ['--dsw-alias-label-secondary', 0.28],
      ['--dsw-alias-label-tertiary', 0.46],
    ]

    /** Injected stylesheet id carrying the outer-glow rules. */
    const GLOW_STYLE_ID = 'wallpaper-theme-glow'

    /** Injected stylesheet id carrying the frosted-glass rules. */
    const GLASS_STYLE_ID = 'wallpaper-theme-glass'

    /** Injected stylesheet id carrying the frame's own fill. */
    const SURFACE_STYLE_ID = 'wallpaper-theme-surface'

    /** Marks an element turned into frosted glass. */
    const GLASS_ATTR = 'data-wp-glass'

    /**
     * Marks glass that has stepped out of the way of a popup inside it.
     *
     * The mark itself stays: the fill has to keep being cleared and the rim is
     * welcome. Only the filter is cancelled, because an element carrying one becomes
     * the backdrop root of everything painted inside it — and the suggestion list the
     * composer's plus opens is rendered inside the composer card.
     */
    const GLASS_FLAT_ATTR = 'data-wp-flat'

    /**
     * Marks an element whose own fill is merely cleared.
     *
     * Inline metadata — usage counters, token meters, code chips — has to lose
     * its solid fill, but giving it a blur and a rim light draws a bezel around
     * a label. These get the transparent background only.
     */
    const GLASS_CLEAR_ATTR = 'data-wp-clear'

    /**
     * Marks an element whose plate is removed without any glass around it.
     *
     * A 28x28 glyph button is a marker, not a pane: a rim light on something that
     * small reads as dirt rather than as glass. The fill and the text colour are
     * still taken over, but no blur and no edge light are added.
     */
    const GLASS_BARE_ATTR = 'data-wp-bare'

    /** The account chip. It owns no list row, so it must never collect the pane. */
    const ACCOUNT_ROW = '[class*="_trigger"][data-signed-out]'

    /**
     * Find the list row a click landed in, in the left column.
     *
     * Workspaces and the conversation list are separate components with separate
     * class names, so the row is recognised by shape instead: something in the
     * left column, one row tall, whose class ends in `Row` or `Item`. Naming each
     * module's row class instead meant every new list needed another guess.
     *
     * The account chip is refused outright. Its wrapper also carries a class ending
     * in `Row`, so the shape test used to claim it and left the pane sitting under
     * the avatar and the nickname — the highlight looked like it had escaped its
     * list, which is exactly how it was reported.
     * @param {EventTarget | null} target
     * @returns {Element | null}
     */
    function rowFor(target) {
      let node = target instanceof Element ? target : null
      if (node !== null && node.closest(ACCOUNT_ROW) !== null) return null
      while (node !== null && node !== document.body) {
        const rect = node.getBoundingClientRect()
        if (rect.left < 320 && rect.width > 120 && rect.width < 340 && rect.height >= 24 && rect.height <= 48) {
          const name = typeof node.className === 'string' ? node.className : ''
          const local = name.split(' ').map(part => {
            const cut = part.indexOf('_')
            return cut < 0 ? part : part.slice(cut + 1)
          }).join(' ')
          if (/(?:^|\s)\w*(?:Row|Item)(?:\s|$)/u.test(local)) return node
        }
        node = node.parentElement
      }
      return null
    }

    /** Marks the one workspace row or conversation row chosen by the last click. */
    const PICKED_ATTR = 'data-wp-picked'

    /** Title of the row chosen by the last click, used to find it again. */
    let pickedLabel = null

    /**
     * Move the highlight onto the row that was just clicked.
     *
     * The application gives no readable marker for which row is current, so the
     * choice is tracked here. Every mark is cleared before the new one is set, so
     * exactly one row carries it — clicking several in a row moves the pane
     * rather than stacking one on each.
     * @param {MouseEvent} event
     */
    function trackPickedRow(event) {
      const row = rowFor(event.target)
      if (row === null) return
      pickedLabel = (row.textContent || '').trim().slice(0, 40)
      for (const other of document.querySelectorAll(`[${PICKED_ATTR}]`)) {
        if (other !== row) other.removeAttribute(PICKED_ATTR)
      }
      row.setAttribute(PICKED_ATTR, '1')
    }

    /**
     * Re-apply the highlight after the list re-renders.
     *
     * Opening a conversation rebuilds the sidebar, and a rebuild drops the mark
     * because the framework owns those nodes — which is why the pane appeared and
     * then vanished. The row is found again by its title and re-marked, and only
     * when the mark is missing, so this costs nothing on an idle screen.
     */
    function paintPicked() {
      if (pickedLabel === null) return
      const current = document.querySelector(`[${PICKED_ATTR}]`)
      if (current !== null && (current.textContent || '').trim().slice(0, 40) === pickedLabel) return
      for (const stale of document.querySelectorAll(`[${PICKED_ATTR}]`)) stale.removeAttribute(PICKED_ATTR)
      for (const el of document.querySelectorAll('[class*="Row"], [class*="Item"]')) {
        if (el.closest(ACCOUNT_ROW) !== null) continue
        if ((el.textContent || '').trim().slice(0, 40) !== pickedLabel) continue
        const rect = el.getBoundingClientRect()
        if (rect.left >= 320 || rect.width <= 120 || rect.width >= 340) continue
        if (rect.height < 24 || rect.height > 48) continue
        el.setAttribute(PICKED_ATTR, '1')
        return
      }
    }

    /** Marks a full-window mask that has been left behind with no dialog. */
    const STUCK_MASK_ATTR = 'data-wp-stuck-mask'

    // The click highlight used to live here. A global click listener picked the
    // sidebar row a click landed in by shape — anything in the left column one row
    // tall whose class ends in `Row` or `Item` — and the wrapper around the account
    // chip matched that test, so a standing glass pane appeared under the avatar
    // and the nickname and stayed there until some other row was clicked. The
    // current wallpaper plugins carry no such behaviour, so it is gone from here
    // as well: nothing in this theme marks a row because it was clicked.

    /**
     * The tone that stays legible on top of a given colour.
     * @param {string} hex a six digit colour such as `#ff3b30`.
     * @returns {string} a near black or near white tone.
     */
    function readableOn(hex) {
      const value = Number.parseInt(hex.slice(1), 16)
      const red = (value >> 16) & 0xff
      const green = (value >> 8) & 0xff
      const blue = value & 0xff
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
      return luminance > 140 ? TEXT_TONES.dark[0] : TEXT_TONES.light[0]
    }

    /**
     * Stop a leftover backdrop from swallowing every click in the application.
     *
     * The settings screen leaves its full-window mask in the tree after the panel
     * closes. Interactive and covering the window, it then intercepts every click,
     * which reads as buttons that have stopped working. Neutralised only while no
     * dialog is present, so a real modal keeps behaving normally.
     */
    function neutraliseStuckMask() {
      const hasDialog = document.querySelector('[role=dialog]') !== null
      for (const element of document.querySelectorAll(`[${STUCK_MASK_ATTR}]`)) {
        if (hasDialog) element.removeAttribute(STUCK_MASK_ATTR)
      }
      if (hasDialog) return
      for (const element of document.querySelectorAll('[class*="_mask"]')) {
        const rect = element.getBoundingClientRect()
        if (rect.width < window.innerWidth * 0.85 || rect.height < window.innerHeight * 0.85) continue
        if (element.getAttribute(STUCK_MASK_ATTR) === null) element.setAttribute(STUCK_MASK_ATTR, '1')
      }
    }

    /**
     * Containers that keep their own fill: the frame and the columns it holds.
     *
     * Matched on the CSS-module *local* name (`<hash>_<local>`), which survives a
     * rebuild even though the hash in front of it does not.
     */
    const GLASS_EXCLUDE = '[class*="_frame"], [class*="_sidebarCol"], [class*="_centerCol"],'
      // Workspace rows. They live in their own module rather than inside the
      // sidebar column, so the column check never reached them and the marking
      // pass put a glass frame and a rim on every one of them.
      + ' [class*="_root"], [class*="_projectRow"]'

    /**
     * Rows that must keep the application's own state styling.
     *
     * Menu and list rows paint a highlight only on hover or when chosen. Giving
     * them a permanent glass layer would leave every option looking selected, so
     * they keep whatever the app draws for the current state.
     */
    const GLASS_SKIP = '[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option]'

    /**
     * Popups: a menu surface, or an element carrying the ARIA role of one.
     *
     * Nothing that holds one of these may be glassed. An element with a backdrop
     * filter becomes the backdrop root for everything painted inside it, so a glassed
     * composer card left the suggestion list the plus opens — rendered inside that
     * card — sampling the card's own output instead of the page behind it. That one
     * popup stayed flat and clear while every other menu in the interface looked
     * right, which is exactly how it was reported.
     */
    const POPUP_HELD = '[data-menu-material], [role=menu], [role=listbox]'

    /** Subtrees that get no treatment at all — message footers and readout rows. */
    const GLASS_SKIP_SUBTREE = '[class*="_actions"], [class*="_endInfo"], [class*="_dock"],'
      + ' [aria-label^="选择模型"], [aria-label^="访问模式"],'
      // The account row. Both shapes of it — the settings card that holds the
      // round avatar and the nickname, and the sidebar chip — are about 44 to 60
      // pixels tall and paint a fill, so the panel pass reached them and drew a
      // rim around the avatar and the name. Matched structurally rather than by
      // hash: the class prefixes change on every rebuild, the avatar suffix and
      // the signed-out attribute do not.
      + ' [class*="_card"]:has([class*="_avatar"]), [class*="_accountInfo"],'
      // The account row and the two boxes around it. The trigger alone was not
      // enough: the container it sits in was still collected once the row painted
      // a hover or expanded fill, and the plate came back as a grey card with a rim.
      + ' [class*="_anchor"]:has(> [class*="_trigger"][data-signed-out]), [class*="_root"]:has(> [class*="_anchor"] > [class*="_trigger"][data-signed-out]),'
      + ' [class*="_panelRow"]:has([class*="_trigger"][data-signed-out]),'
      // The question card's option rows. They are tall enough to pass the panel test
      // and were collecting a plate each, so every option looked chosen at once. They
      // are styled from their own state instead — see the rules below.
      + ' [class*="_options"] [class*="_option"], [class*="_options"] [class*="_customRow"],'
      // The plugin's own settings panel, start to finish. It is the one place in the
      // interface that must not be themed by the theme's own pass.
      + ' [data-wp-panel], [data-wp-panel] *,'
      + ' [class*="_trigger"][data-signed-out],'
      // The application's own menu surface. Its inner material layer already paints
      // the menu fill and the 40px frost the theme's --dsw-menu-backdrop-filter
      // names; marking it replaced that blur with this plugin's five-pixel one and
      // cleared the fill, which is what flattened every popup into a plain plate.
      + ' [data-menu-material],'
      // Nothing in an open popup is touched — not its rows, and not the popup
      // itself. Writing attributes onto its rows disturbs the render that owns
      // them, which closed the menu the instant it opened, and a mark left behind
      // drew the box the rows should not have. The popup surface is the same story:
      // the marking pass reaches it (it is tall and painted), and a glass mark
      // there clears the plate and swaps the theme's 40px frost for this plugin's,
      // which is what turned popups into flat or empty panes. Static rules style
      // both of them above.
      + ' [role=menu], [role=listbox], [role=menu] *, [role=listbox] *'

    /**
     * Minimum height for a surface to be treated as a panel.
     *
     * Controls — sidebar rows, form selects, buttons, toggles — are 22 to 44px
     * tall; panels — the composer card, the settings dialog, an open menu — start
     * around 64px. Filtering on that gap is more reliable than enumerating areas
     * to exclude, which kept needing another entry every round.
     */
    const GLASS_PANEL_MIN_HEIGHT = 60

    /** Coerce one persisted colour into 0-255 channels, or null when absent. */
    function readColor(value) {
      if (value === null || typeof value !== 'object') return null
      const channels = ['r', 'g', 'b'].map(key => Math.min(255, Math.max(0, Math.round(Number(value[key])))))
      return channels.some(channel => !Number.isFinite(channel)) ? null : { r: channels[0], g: channels[1], b: channels[2] }
    }

    /** Which built-in appearance is active. The plugin defers to it everywhere. */
    function currentTheme() {
      return document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
    }

    /** Offscreen canvas the wallpaper is sampled through. */
    let sampleCanvas = null

    /** The tone the text was last switched to, so a flip can be logged once. */
    let lastAutoLight = null

    /**
     * Average luminance of the current wallpaper frame, or null when it cannot
     * be read yet.
     *
     * The image is drawn down to 32x32 and read back, which is cheap enough to
     * run while a video plays. The wallpaper is served from this document's own
     * origin, so the canvas is never tainted.
     */
    function sampleLuminance() {
      const layer = document.getElementById(LAYER_ID)
      const media = layer === null ? null : layer.firstElementChild
      if (media === null || media === undefined) return null
      if (media.tagName === 'VIDEO' && media.readyState < 2) return null
      if (media.tagName === 'IMG' && !media.complete) return null
      if (sampleCanvas === null) {
        sampleCanvas = document.createElement('canvas')
        sampleCanvas.width = 32
        sampleCanvas.height = 32
      }
      const context = sampleCanvas.getContext('2d', { willReadFrequently: true })
      if (context === null) return null
      try {
        context.drawImage(media, 0, 0, 32, 32)
        const { data } = context.getImageData(0, 0, 32, 32)
        let total = 0
        for (let index = 0; index < data.length; index += 4) {
          total += 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]
        }
        return total / (data.length / 4)
      } catch {
        return null
      }
    }

    /** Text tones for each backdrop, most prominent first. */
    const TEXT_TONES = {
      light: ['rgb(252, 252, 253)', 'rgb(206, 208, 212)', 'rgb(160, 163, 169)'],
      dark: ['rgb(15, 17, 21)', 'rgb(70, 74, 80)', 'rgb(122, 126, 133)'],
    }

    /** Text tones chosen by the most recent successful sample. */
    let lastTones = null
    let lastInverted = null

    /**
     * Write the current tones onto every scope that declares a palette.
     *
     * The settings screen is rendered into a portal, and a portal may carry its
     * own palette declaration — a token written on `<body>` then never reaches
     * it, which is why the settings text kept the theme's own colours. The same
     * values are written onto the dialog itself, and re-written whenever a
     * portal mounts.
     */
    function paintTones() {
      if (lastTones === null || lastInverted === null) return
      for (const scope of [document.body, document.querySelector('[role=dialog]')]) {
        if (scope === null || scope === undefined) continue
        // Written only when the value actually changes. An unconditional write is
        // itself a DOM mutation, which re-fires the observer that called this —
        // a loop that kept the application re-rendering and closed an open menu
        // the moment it appeared.
        const write = (token, value) => {
          if (value === null || value === undefined) return
          if (scope.style.getPropertyValue(token) === value) return
          scope.style.setProperty(token, value)
        }
        LABEL_TOKENS.forEach(([token], index) => {
          write(token, lastTones[index] ?? lastTones[0])
        })
        write('--dsw-alias-label-primary-inverted', lastInverted)
        write('--dsw-alias-label-primary-foreground', lastInverted)
        // Captions and hints carry their own tokens, which the three-step
        // hierarchy above does not reach.
        write('--dsw-alias-label-caption', lastTones[2])
        write('--dsw-alias-label-dimmed', lastTones[2])
        write('--dsw-alias-label-document-preview', lastTones[1])
      }
    }

    /**
     * Point the text at whichever of the two tones stands out against the frame.
     *
     * A dead band around the midpoint keeps a video that hovers there from
     * strobing: the tone only flips once the backdrop is clearly on one side.
     * @returns true when a sample was taken, so the caller knows to keep polling.
     */
    function applyAutoContrast() {
      if (!state.autoContrast) return false
      const wallpaper = sampleLuminance()
      if (wallpaper === null) return false
      // The text does not sit on the wallpaper alone. The surface fill is painted
      // over it, so at a high opacity a bright frame decides the contrast and the
      // wallpaper barely matters. Judging the wallpaper on its own put white text
      // on an opaque white sheet.
      const coverage = Math.min(1, Math.max(0, state.surface / 100))
      // The fill that covers the wallpaper follows the theme, so its brightness is
      // read from the live base colour: white in the light palette, near-black in
      // the dark one. A fixed 255 assumed the frame was always light.
      const base = channels(readOriginalTokens()[0])
      const fillLuminance = base === null
        ? 255
        : 0.2126 * base[0] + 0.7152 * base[1] + 0.0722 * base[2]
      const luminance = wallpaper * (1 - coverage) + fillLuminance * coverage
      const light = luminance < 128
      if (lastAutoLight !== null && light !== lastAutoLight && Math.abs(luminance - 128) < 22) {
        return true
      }
      lastAutoLight = light
      // A colour picked by hand wins over the sampled one. Only a plain six digit
      // hex is accepted, so a half-typed or malformed value can never blank out
      // every label in the window.
      const custom = typeof state.customTextColor === 'string' && /^#[0-9a-f]{6}$/iu.test(state.customTextColor)
        ? state.customTextColor
        : null
      lastTones = custom === null
        ? TEXT_TONES[light ? 'light' : 'dark']
        : [custom, custom, custom]
      // Badges such as the product mark are drawn inverted: the primary label
      // colour becomes their plate and this pair becomes their text. A colour
      // chosen by hand has no relation to the wallpaper, so its readable partner
      // is derived from its own brightness — otherwise a light custom colour put
      // light text on a light plate and the mark became a blank block.
      lastInverted = custom === null
        ? TEXT_TONES[light ? 'dark' : 'light'][0]
        : readableOn(custom)
      paintTones()
      return true
    }

    /**
     * Persisted selection; every numeric field is a user unit, not an internal one.
     *
     * `fontColor` holds one entry per built-in appearance. Storing a single
     * colour would override the theme token in both, which takes the built-in
     * light/dark switch away from the user; per-theme entries leave that switch
     * in charge and only tint the theme it was chosen for.
     */
    let state = {
      current: null,
      surface: 30,
      component: 20,
      blur: 8,
      glassAlpha: 0,
      glassBlur: 40,
      menuBlur: 40,
      customTextColor: null,
      autoContrast: true,
      fontColor: { light: null, dark: null },
      glow: { r: 120, g: 170, b: 255 },
      glowStrength: 0,
    }

    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')
      if (saved !== null && typeof saved === 'object') {
        // A colour stored before per-appearance support carries no theme tag.
        // Luminance decides which appearance it was chosen for: a light colour
        // only makes sense over a dark surface and vice versa, so filing it by
        // brightness keeps the other appearance on the theme's readable default.
        const legacy = readColor(saved.fontColor?.r !== undefined ? saved.fontColor : null)
        const legacyLuminance = legacy === null
          ? 0
          : 0.2126 * legacy.r + 0.7152 * legacy.g + 0.0722 * legacy.b
        state = {
          current: saved.current ?? null,
          // The stored numbers are only trusted when they come from this version
          // of the panel. Older builds wrote values from a different design, and
          // reading those back would undo the current look on first launch.
          version: STORAGE_VERSION,
          surface: saved.version === STORAGE_VERSION && typeof saved.surface === 'number' ? saved.surface : 30,
          component: saved.version === STORAGE_VERSION && typeof saved.component === 'number' ? saved.component : 20,
          blur: saved.version === STORAGE_VERSION && typeof saved.blur === 'number' ? saved.blur : 8,
          glassAlpha: saved.version === STORAGE_VERSION && typeof saved.glassAlpha === 'number' ? saved.glassAlpha : 0,
          glassBlur: saved.version === STORAGE_VERSION && typeof saved.glassBlur === 'number' ? saved.glassBlur : 40,
          menuBlur: saved.version === STORAGE_VERSION && typeof saved.menuBlur === 'number' ? saved.menuBlur : 40,
          customTextColor: saved.version === STORAGE_VERSION && typeof saved.customTextColor === 'string'
            ? saved.customTextColor
            : null,
          autoContrast: saved.autoContrast !== false,
          fontColor: {
            light: readColor(saved.fontColor?.light),
            dark: readColor(saved.fontColor?.dark),
          },
          glow: readColor(saved.glow) ?? { r: 120, g: 170, b: 255 },
          glowStrength: typeof saved.glowStrength === 'number' ? saved.glowStrength : 0,
        }
      }
    } catch {
      // A corrupt entry falls back to the defaults above.
    }

    /** Persist the current selection. */
    function save() {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      } catch {
        // Storage may be unavailable; the session keeps working regardless.
      }
    }

    /** Parse a CSS colour into channels, or return null when the form is unknown. */
    function channels(value) {
      const text = String(value ?? '').trim()
      const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/iu.exec(text)
      if (hex !== null) {
        const digits = hex[1]
        const rgb = digits.length >= 6 ? digits.slice(0, 6) : digits.slice(0, 3)
        const expanded = rgb.length === 3 ? rgb.split('').map(part => part + part).join('') : rgb
        return [0, 2, 4].map(offset => Number.parseInt(expanded.slice(offset, offset + 2), 16))
      }
      const rgb = /^rgba?\(([^)]+)\)$/iu.exec(text)
      if (rgb !== null) {
        const parts = rgb[1].split(/[\s,/]+/u).filter(part => part !== '')
        if (parts.length < 3) return null
        const values = parts.slice(0, 3).map(part => part.endsWith('%')
          ? Math.round(Number.parseFloat(part) * 2.55)
          : Number.parseFloat(part))
        return values.every(Number.isFinite) ? values : null
      }
      return null
    }

    /** Rewrite one colour at a new alpha. */
    function withAlpha(value, alpha) {
      const parts = channels(value)
      if (parts === null) return null
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`
    }

    /**
     * Read the glass tokens as the theme defines them.
     *
     * This plugin's overrides live as inline styles on `<body>`, so removing
     * them for the duration of one computed-style read exposes the theme's own
     * value instead of the alpha this plugin wrote last time. That is what makes
     * repeated light/dark switches idempotent.
     */
    function readOriginalTokens() {
      const body = document.body
      const names = GLASS_TOKENS.map(([token]) => token)
      const saved = names.map(token => [token, body.style.getPropertyValue(token), body.style.getPropertyPriority(token)])
      for (const token of names) body.style.removeProperty(token)
      const values = names.map(token => window.getComputedStyle(body).getPropertyValue(token).trim())
      for (const [token, value, priority] of saved) {
        if (value !== '') body.style.setProperty(token, value, priority)
      }
      return values
    }

    /**
     * Repaint every glass group at its own opacity.
     *
     * The palette is declared on `<body>` — the element carrying
     * `data-ds-dark-theme` — so the overrides have to land there too. Writing
     * them on `<html>` leaves every descendant reading the theme's own value.
     */
    function applySurfaces(attempt = 0) {
      const body = document.body
      // Fills that make a freshly opened screen flash white.
      //
      // Two kinds live here. Flat near-white hover and selection highlights, which
      // no scan can see because a hover style does not exist in the computed tree
      // while the pointer is elsewhere. And the solid card fills the settings
      // screens paint themselves with: a JavaScript pass over the whole document
      // cannot finish inside a frame, so those cards show their own white for one
      // frame before it runs. Clearing the tokens means both are already correct
      // on their very first paint.
      const FLAT_TOKENS = [
        // Proven necessary: this pair paints the flat white hover and selection
        // bars, and no scan can see a hover style.
        '--dsw-alias-interactive-bg-hover-solid',
        '--dsw-alias-bg-multi-select',
        // Settings screens paint their cards with these, and a JavaScript pass
        // cannot finish inside a frame, so the cards would flash white first.
        '--dsw-alias-settings-card-fill',
        '--dsw-alias-bg-module-platform',
        '--dsw-alias-bg-document-preview',
        // The button fills are deliberately NOT cleared. A switch is a control
        // and draws its track from one of them; clearing it left the track with
        // no fill at all, which over a dark wallpaper reads as a solid black pill
        // with an invisible knob.
      ]
      for (const token of FLAT_TOKENS) body.style.setProperty(token, 'transparent')
      if (state.current === null) {
        for (const [token] of GLASS_TOKENS) body.style.removeProperty(token)
        // The menu frost is written from the blur slider a few lines below, so it
        // has to come back with the wallpaper: a value left behind kept every
        // popup blurred at the plugin's setting after the wallpaper was cleared.
        body.style.removeProperty('--dsw-menu-backdrop-filter')
        return
      }
      const originals = readOriginalTokens()
      // The palette stylesheet may not be on the page yet when the plugin boots.
      // An empty read would parse as "not a colour" and strip the overrides
      // instead of writing them, so wait for the tokens before deciding.
      if (originals.some(value => value === '') && attempt < 12) {
        window.setTimeout(() => applySurfaces(attempt + 1), 250)
        return
      }
      // One value governs the whole interface. The frame, the sidebar and the
      // cards all resolve to the same alpha, so no seam appears where two dials
      // would have met, and the panel keeps a single opacity slider.
      const interfaceAlpha = Math.min(1, Math.max(0, state.surface / 100))
      // A menu is a sheet of glass, not a card. The veil is deliberately almost
      // nothing: a backdrop blur averages whatever sits behind it, so a bright
      // wallpaper under 40px of frost already arrives as a pale wash, and any white
      // laid on top of that turns the popup into a flat white plate — which is what
      // the 20% and 58% versions looked like. Five per cent keeps text legible and
      // leaves the wallpaper's own colour showing through; the 毛玻璃不透明 slider
      // adds the rest when a more solid surface is wanted.
      const glassSheet = Math.min(1, Math.max(0, state.glassAlpha / 100))
      const alphas = {
        surface: interfaceAlpha,
        component: interfaceAlpha,
        menu: 0.05 + glassSheet * 0.45,
      }
      const surfaceChannels = channels(originals[0])
      GLASS_TOKENS.forEach(([token, group], index) => {
        // Every surface token is painted with the base colour, so the frame, the
        // sidebar and the window's title strip all resolve to one shade. Left to
        // their own tokens they differ by a few points — #fff against #f9fafb —
        // which reads as a seam where the title bar meets the column below it.
        const source = group === 'surface' && surfaceChannels !== null
          ? `rgb(${surfaceChannels[0]}, ${surfaceChannels[1]}, ${surfaceChannels[2]})`
          : originals[index]
        const next = withAlpha(source, alphas[group])
        if (next === null) body.style.removeProperty(token)
        else body.style.setProperty(token, next)
      })
      // The menu frost belongs to the application: its theme names it with
      // --dsw-menu-backdrop-filter and every popup surface reads that token. The
      // menu-blur slider writes it here rather than layering a second blur of its
      // own on top, so one value governs every popup. 40px is what the theme ships.
      // A popup keeps a floor of frost. The theme ships 40px, and a save made
      // before the two blur sliders were merged still carries 5 — with only five
      // pixels behind it the liquid sheet has nothing to sit on and reads as a flat
      // grey card, which is the look this floor exists to prevent. The slider
      // raises the frost from there.
      const sheetBlur = Math.max(24, Math.round(state.glassBlur))
      body.style.setProperty('--dsw-menu-backdrop-filter',
        `blur(${sheetBlur}px) saturate(195%)`)

      // Several components carry a `_frame` class. The window frame is the
      // outermost of them — the others sit inside it, and each would add another
      // coat over the content area: three layers there against one over the
      // sidebar. Picking by size chose the wrong one, a list frame that covers
      // only the content column, leaving the sidebar and title strip bare.
      let carrier = null
      for (const element of document.querySelectorAll('[class*="_frame"]')) {
        const parent = element.parentElement
        if (parent !== null && parent.closest('[class*="_frame"]') !== null) continue
        carrier = element
        break
      }
      for (const element of document.querySelectorAll('[data-wp-surface]')) {
        if (element !== carrier) element.removeAttribute('data-wp-surface')
      }
      if (carrier !== null) carrier.setAttribute('data-wp-surface', '1')

      // The fill is an inset shadow rather than a background: a shadow paints
      // above the element's own colour, and so above this plugin's wallpaper
      // layer, where a body background would sit underneath and never show.
      // The fill follows the theme's own base colour rather than a fixed white.
      // Hardcoding white left the frame bright while every token-driven surface
      // went near-black in dark mode, which reads as dead patches.
      const fillColour = surfaceChannels === null
        ? 'rgb(255, 255, 255)'
        : `rgb(${surfaceChannels[0]}, ${surfaceChannels[1]}, ${surfaceChannels[2]})`
      ensureStyle(SURFACE_STYLE_ID).textContent = [
        '[class*="_frame"], [class*="_centerCol"], [class*="_root"],'
          + ' [class*="_header"], [class*="_tabHost"] {',
        '  background-color: transparent !important;',
        '  box-shadow: none !important;',
        '}',
        `[data-wp-surface] { box-shadow: inset 0 0 0 9999px ${withAlpha(fillColour, alphas.surface)} !important; }`,
      ].join('\n')
    }

    /** The wallpaper layer, created on first use. */
    function ensureLayer() {
      const existing = document.getElementById(LAYER_ID)
      if (existing !== null) return existing
      const layer = document.createElement('div')
      layer.id = LAYER_ID
      layer.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;'
      document.documentElement.insertBefore(layer, document.body)
      return layer
    }

    /** Stream a local file through the Host route registered by this bundle. */
    function mediaUrl(path) {
      return `/wallpaper/file?path=${encodeURIComponent(path)}`
    }

    /** Repaint the layer for the current selection. */
    function applyLayer() {
      const layer = ensureLayer()
      layer.replaceChildren()
      if (state.current === null) return
      // Blur samples past the edges, so the media is scaled to cover the bleed.
      const filter = `blur(${state.blur}px)`
      const common = `width:100%;height:100%;object-fit:cover;display:block;transform:scale(1.08);filter:${filter};`
      const element = document.createElement(state.current.kind === 'video' ? 'video' : 'img')
      element.setAttribute('aria-hidden', 'true')
      element.src = mediaUrl(state.current.path)
      element.style.cssText = common
      if (state.current.kind === 'video') {
        element.autoplay = true
        element.loop = true
        element.muted = true
        element.playsInline = true
        element.setAttribute('muted', '')
        element.setAttribute('playsinline', '')
      }
      layer.append(element)
      if (state.current.kind === 'video') void element.play().catch(() => {})
    }

    /**
     * Tint the text tokens from the colour chosen for the active appearance.
     *
     * The overrides live as inline styles, which outrank the theme's own rules,
     * so they are only written for the appearance the user tinted and removed
     * for the other one. That keeps the built-in light/dark switch driving the
     * palette instead of being shadowed by this plugin.
     *
     * Every variant is written as an opaque `rgb()`; hierarchy comes from
     * blending toward the theme's base fill rather than from alpha.
     */
    function applyFontColor() {
      const body = document.body
      // While auto contrast is on it owns the text colour; a stale value written
      // here would fight the sampler on every frame.
      if (state.autoContrast && lastAutoLight !== null) return
      const chosen = state.fontColor[currentTheme()]
      if (chosen === null || chosen === undefined) {
        for (const [token] of LABEL_TOKENS) body.style.removeProperty(token)
        return
      }
      // Read the theme's own base fill with this plugin's overrides taken out,
      // so the blend target follows a light/dark switch.
      const baseIndex = GLASS_TOKENS.findIndex(([token]) => token === SURFACE_BASE_TOKEN)
      const base = channels(readOriginalTokens()[baseIndex < 0 ? 0 : baseIndex])
      const surface = base === null ? { r: 255, g: 255, b: 255 } : { r: base[0], g: base[1], b: base[2] }
      for (const [token, ratio] of LABEL_TOKENS) {
        const mixed = ratio === 0 ? chosen : {
          r: Math.round(chosen.r + (surface.r - chosen.r) * ratio),
          g: Math.round(chosen.g + (surface.g - chosen.g) * ratio),
          b: Math.round(chosen.b + (surface.b - chosen.b) * ratio),
        }
        body.style.setProperty(token, `rgb(${mixed.r}, ${mixed.g}, ${mixed.b})`)
      }
    }

    /**
     * Install the outer-glow rules on body-level portals.
     *
     * The dropdown wrapper carries a hashed CSS-module class, so the rule keys
     * off structure instead: a body child that holds a menu, listbox or dialog
     * directly is the portal surface. `:has()` keeps this independent of the
     * module hash, which changes whenever the owning package is rebuilt.
     */
    function applyGlow() {
      const existing = document.getElementById(GLOW_STYLE_ID)
      if (state.glowStrength <= 0) {
        if (existing !== null) existing.remove()
        return
      }
      const { r, g, b } = state.glow
      const strength = Math.min(1, Math.max(0, state.glowStrength / 100))
      const ring = `rgba(${r}, ${g}, ${b}, ${(0.30 + 0.50 * strength).toFixed(3)})`
      const halo = `rgba(${r}, ${g}, ${b}, ${(0.14 + 0.46 * strength).toFixed(3)})`
      const radius = Math.round(14 + 34 * strength)
      const spread = Math.round(4 + 22 * strength)
      const css = [
        'body > div:has(> [role=menu]),',
        'body > div:has(> [role=listbox]),',
        'body > div:has(> [role=dialog]) {',
        `  box-shadow: 0 0 0 1px ${ring}, 0 0 ${radius}px ${spread}px ${halo} !important;`,
        '}',
      ].join('\n')
      const style = existing ?? document.createElement('style')
      if (existing === null) {
        style.id = GLOW_STYLE_ID
        document.head.append(style)
      }
      style.textContent = css
    }

    /** Alpha channel of a computed colour; 1 when it carries no alpha. */
    function isLightFill(value) {
      const match = /rgba?\(([^)]+)\)/u.exec(String(value))
      if (match === null) return false
      const parts = match[1].split(/[\s,/]+/u).filter(part => part !== '').map(Number)
      if (parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) return false
      return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2] >= 200
    }

    /**
     * Every painted or interactive rounded surface outside the frame.
     *
     * Rounded corners are the reliable signal: the frame, both columns and the
     * plain wrappers all compute `border-radius: 0px`, while every component —
     * button, popover, dialog, card, list row — is rounded. Selecting by shape
     * rather than by class keeps this working after a rebuild, when every
     * CSS-module hash changes.
     */
    function collectGlassTargets() {
      const glassed = []
      const cleared = []
      const bare = []
      // Every ancestor of an open popup, collected once so the walk stays linear.
      const holdsPopup = new Set()
      for (const popup of document.querySelectorAll(POPUP_HELD)) {
        for (let node = popup.parentElement; node !== null; node = node.parentElement) holdsPopup.add(node)
      }
      for (const element of document.querySelectorAll('body *')) {
        // Only the frame and the two columns themselves are skipped — their
        // subtrees hold every component this pass exists to reach, so matching
        // ancestors here would exclude the whole interface.
        if (element.matches(GLASS_EXCLUDE)) {
          // The frame and its columns were never meant to be treated. They are
          // tall enough to pass the panel test, and their rim light draws a
          // one-pixel white line along the top of the content area. A mark left
          // by an earlier paint has to be withdrawn here as well.
          element.removeAttribute(GLASS_ATTR)
          element.removeAttribute(GLASS_CLEAR_ATTR)
          continue
        }
        if (element.matches(GLASS_SKIP)) continue
        // Verdicts are dropped as well as withheld here: an element skipped by
        // subtree may already carry a mark from an earlier paint.
        if (element.closest(GLASS_SKIP_SUBTREE) !== null) {
          element.removeAttribute(GLASS_ATTR)
          element.removeAttribute(GLASS_CLEAR_ATTR)
          continue
        }
        // An element holding an open popup steps aside without losing its glass: the
        // mark stays, so the fill remains cleared and the rim stays drawn, and only
        // the filter is cancelled. Withdrawing the mark outright brought the
        // application's own opaque fill back, which turned the composer into a white
        // box the moment the plus menu opened. The attribute is cleared again on the
        // first pass after the popup closes.
        if (holdsPopup.has(element)) {
          if (element.getAttribute(GLASS_FLAT_ATTR) === null) element.setAttribute(GLASS_FLAT_ATTR, '1')
        } else if (element.getAttribute(GLASS_FLAT_ATTR) !== null) {
          element.removeAttribute(GLASS_FLAT_ATTR)
        }
        // Already-sorted elements keep their verdict: clearing a fill changes the
        // computed colour this pass reads, so re-measuring would drop them and
        // they would flip back on the following scan.
        if (element.getAttribute(GLASS_ATTR) !== null) { glassed.push(element); continue }
        if (element.getAttribute(GLASS_CLEAR_ATTR) !== null) { cleared.push(element); continue }
        if (element.getAttribute(GLASS_BARE_ATTR) !== null) { bare.push(element); continue }
        const rect = element.getBoundingClientRect()
        // The floor is deliberately low: inline code chips are about 32x21 and an
        // earlier 40x24 floor silently excluded every one of them, leaving solid
        // white bars in the middle of the conversation.
        if (rect.width < 20 || rect.height < 12) continue
        const style = window.getComputedStyle(element)
        // Icon-sized controls — copy, retry, the composer's plus — are markers,
        // not surfaces, so they never get a panel treatment. A light fill is
        // still cleared: the plus button paints one and it reads as a white dot
        // over the wallpaper. Darker fills stay, so a send button keeps its hue.
        if (rect.width <= 44 && rect.height <= 44) {
          // Any fill, dark or light. These are glyph buttons — send, attach, the
          // file chip — and the plate behind the glyph is exactly what the
          // wallpaper should show through. Restricting this to light fills left
          // the dark ones sitting on the glass as opaque discs.
          if (style.backgroundColor !== 'rgba(0, 0, 0, 0)') bare.push(element)
          continue
        }
        const radius = Number.parseFloat(style.borderTopLeftRadius)
        const rounded = Number.isFinite(radius) && radius > 0
        // A computed colour starting with `rgb(` carries no alpha channel, so it
        // is fully opaque. That is the tell for a square block that still paints
        // a solid fill — code blocks are exactly this shape.
        const solid = style.backgroundColor.startsWith('rgb(')
        const painted = style.backgroundColor !== 'rgba(0, 0, 0, 0)'
        const interactive = element.tagName === 'BUTTON' || element.tagName === 'A'
          || element.hasAttribute('aria-label') || element.hasAttribute('role')
        if (!rounded && !solid) continue
        if (!painted && !interactive) continue
        // Panels only. A control — a sidebar row, a form select, a button, a
        // toggle — stays plain and keeps nothing from this pass. Anything short
        // that still paints a solid fill only gets that fill cleared, which is
        // what stops a solid block from showing through the wallpaper.
        // The sidebar's rows are never glassed — the pass gave some of them a
        // permanent frame while leaving others bare, so the column looked
        // mismatched. Their plates are still cleared, because a button in that
        // column keeps its own white fill otherwise. Excluding the whole column
        // from the scan instead stripped those clears and brought the white back.
        const inSidebar = element.closest('[class*="_sidebarCol"]') !== null
        if (inSidebar && element.getAttribute(GLASS_ATTR) !== null) element.removeAttribute(GLASS_ATTR)
        if (rect.height >= GLASS_PANEL_MIN_HEIGHT && !inSidebar) glassed.push(element)
        // Any painted fill, not just a light one. Restricting this to light fills
        // left every dark plate untouched, so a solid primary button kept its own
        // colour and never became part of the glass.
        else if (painted) {
          // Wide enough to read as a pane gets the glass; a small glyph button is
          // stripped bare instead, because a rim on 28 pixels looks like dirt.
          if (rect.width >= 60) cleared.push(element)
          else bare.push(element)
        }
      }
      return { glassed, cleared, bare }
    }

    /**
     * Stamp each collected element with the treatment it earned.
     *
     * The verdict is recorded on the element itself, so a later scan does not
     * re-derive it from a colour this plugin has already rewritten.
     */
    function applyGlassTargets() {
      const { glassed, cleared, bare } = collectGlassTargets()
      for (const element of glassed) {
        if (element.getAttribute(GLASS_ATTR) === null) element.setAttribute(GLASS_ATTR, '1')
      }
      for (const element of cleared) {
        if (element.getAttribute(GLASS_CLEAR_ATTR) === null) element.setAttribute(GLASS_CLEAR_ATTR, '1')
      }
      for (const element of bare) {
        if (element.getAttribute(GLASS_BARE_ATTR) === null) element.setAttribute(GLASS_BARE_ATTR, '1')
      }
    }

    /**
     * Find or create the injected stylesheet with one id.
     */
    function ensureStyle(id) {
      const existing = document.getElementById(id)
      if (existing !== null) return existing
      const style = document.createElement('style')
      style.id = id
      document.head.append(style)
      return style
    }

    /**
     * Give every marked surface the liquid-glass treatment.
     *
     * Four parts, in the order they read on screen:
     *
     * 1. `backdrop-filter` blurs, then pushes saturation and brightness up —
     *    that lift is what makes the pane look lit rather than merely smudged.
     * 2. Inset highlights on all four edges: bright along the top, faint along
     *    the bottom, so the rim catches light the way a bevelled edge does.
     *    Drawing the rim with inset shadows rather than a real `border` avoids
     *    changing any element's box size.
     * 3. A soft inner bloom, which fills the pane with a little light.
     * 4. A soft drop shadow, which lifts the pane off the wallpaper.
     *
     * The sheen is a separate gradient rather than a `::before`, because a
     * pseudo-element would need `position: relative` on elements whose layout
     * this plugin must not disturb.
     */
    function applyGlass() {
      applyGlassTargets()
      const lit = 'rgba(255, 255, 255, 0.80)'
      /** Glass blur radius, driven by the panel's one blur slider. */
      const radius = Math.max(0, Math.round(state.glassBlur))
      /** Glass fill, driven by the 毛玻璃不透明 slider. */
      const glassAlpha = Math.min(1, Math.max(0, state.glassAlpha / 100))
      const glassFill = glassAlpha <= 0 ? 'transparent' : `rgba(255, 255, 255, ${glassAlpha})`

      const faint = 'rgba(255, 255, 255, 0.15)'
      const edge = 'rgba(255, 255, 255, 0.28)'
      ensureStyle(GLASS_STYLE_ID).textContent = [
        `[${GLASS_ATTR}] {`,
        `  backdrop-filter: blur(${radius}px) saturate(180%) brightness(1.06) !important;`,
        `  -webkit-backdrop-filter: blur(${radius}px) saturate(180%) brightness(1.06) !important;`,
        // The fill is the 毛玻璃不透明 control. At zero the application's own
        // colour is cleared and only the blur and the rim light are left in front
        // of the wallpaper; raising it lays a white veil back over the artwork.
        `  background-color: ${glassFill} !important;`,
        `  box-shadow: inset 0 1px 0 0 ${lit}, inset 0 -1px 0 0 ${faint},`
          + ` inset 1px 0 0 0 ${edge}, inset -1px 0 0 0 ${edge},`
          + ' 0 6px 20px -6px rgba(0, 0, 0, 0.18) !important;',
        '}',
        // Glass standing in front of an open popup: every layer of the rule above is
        // kept — the cleared fill and the rim — and only the filter is dropped, so the
        // popup inside it can reach the page behind instead of sampling this element.
        `[${GLASS_FLAT_ATTR}] {`,
        '  backdrop-filter: none !important;',
        '  -webkit-backdrop-filter: none !important;',
        '}',
        // The chosen option paints a solid bar. Its computed background is
        // transparent, so the paint comes from a background image or a
        // pseudo-element — clearing every layer is what actually removes it.
        '[role=menuitemradio][aria-checked=true], [role=menuitemcheckbox][aria-checked=true],'
          + ' [role=option][aria-selected=true] {',
        '  background-color: transparent !important;',
        '  background-image: none !important;',
        '  box-shadow: none !important;',
        '}',
        '[role=menuitemradio][aria-checked=true]::before, [role=menuitemradio][aria-checked=true]::after,'
          + ' [role=option][aria-selected=true]::before, [role=option][aria-selected=true]::after {',
        '  background-color: transparent !important;',
        '  background-image: none !important;',
        '  box-shadow: none !important;',
        '}',
        // List group headers paint their own sticky band from the menu surface
        // colour, so they keep a visible bar even after that token is thinned.
        // They are square and translucent, which is why the surface collector
        // never reached them. Matched on the CSS-module local name, which
        // survives a rebuild even though the hash in front of it does not.
        '[class*="_groupTitle"] {',
        '  background-color: transparent !important;',
        '  background-image: none !important;',
        '}',
        // The session list ends in a fade gradient that masks scrolled content
        // against the sidebar fill. That fill is nearly transparent now, so the
        // gradient's own end colour shows up as a grey bar above the footer.
        '[class*="_fade"] { background-image: none !important; }',
        // Chat bubbles paint their own opaque plate. They run about 42px tall and
        // so fall below the panel threshold, which is why the marking pass never
        // reached them. Cleared by class, which is deterministic and needs no scan.
        '[class*="_bubble"] { background-color: transparent !important; }',
        // Badges such as 内置 and 新任务默认 are re-rendered whenever a preset is
        // chosen. A marking pass cannot be relied on to reach every one of them in
        // time, so a freshly rendered badge kept its own solid plate beside ones
        // already converted — the family looked mismatched. Matched by class here,
        // which applies to each of them the moment it exists.
        '[class*="_tag"] {',
        '  background-color: transparent !important;',
        '  background-image: none !important;',
        `  backdrop-filter: blur(${radius}px) saturate(180%) brightness(1.06) !important;`,
        `  -webkit-backdrop-filter: blur(${radius}px) saturate(180%) brightness(1.06) !important;`,
        `  box-shadow: inset 0 1px 0 0 ${lit}, inset 0 -1px 0 0 ${faint},`
          + ` inset 1px 0 0 0 ${edge}, inset -1px 0 0 0 ${edge} !important;`,
        '  color: var(--dsw-alias-label-primary) !important;',
        '}',
        // The composer sits in a seat that fades the scrolling content out towards
        // the background. With the frame now lighter than the gradient's end
        // colour, that fade reads as a dark band across the bottom of the window.
        '[class*="_composerSeat"] {',
        '  background-image: none !important;',
        '  box-shadow: none !important;',
        '}',
        // Inline metadata keeps only the cleared fill: a blur and a rim light on
        // a small label draws a bezel around text that is not a surface.
        `[${GLASS_CLEAR_ATTR}] {`,
        '  background-color: transparent !important;',
        // The plate is not always a colour. A primary button paints its fill as a
        // gradient, and clearing only the colour left that plate standing while
        // the text was already repainted for a bare backdrop — dark on dark.
        '  background-image: none !important;',
        // Same glass as the panels: with its own plate removed, a badge or button
        // reads as a pane rather than as loose text floating on the wallpaper.
        `  backdrop-filter: blur(${radius}px) saturate(180%) brightness(1.06) !important;`,
        `  -webkit-backdrop-filter: blur(${radius}px) saturate(180%) brightness(1.06) !important;`,
        `  box-shadow: inset 0 1px 0 0 ${lit}, inset 0 -1px 0 0 ${faint},`
          + ` inset 1px 0 0 0 ${edge}, inset -1px 0 0 0 ${edge} !important;`,
        // With the plate gone the text sits on the wallpaper, so it takes the
        // sampled tone. A badge designed as a solid chip keeps the label colour
        // meant for its plate and would otherwise disappear.
        '  color: var(--dsw-alias-label-primary) !important;',
        '}',
        // Settings nav rows paint a flat #f1f3f5 on hover. That is a literal
        // colour compiled into the stylesheet, not a reference to the hover
        // token, so overriding the token leaves it untouched — confirmed by
        // hovering the row and reading rgb(241, 243, 245) back. Matched on the
        // module's local class name, which survives a rebuild.
        // No glass on a sidebar row at all: plain text, whatever its state. The
        // application's own hover colour is a literal compiled into its
        // stylesheet, so it is cleared here — no token reaches it, and no scan can
        // see a hover style.
        '[class*="_navCell"]:hover, [class*="_navCell"][class*="_active"],'
          + ' [class*="_navCell"][aria-current], [class*="_navCell"][data-active],'
          + ' [class*="_navCell"][class*="_selected"] {',
        '  background-color: transparent !important;',
        '  background-image: none !important;',
        '  box-shadow: none !important;',
        '  backdrop-filter: none !important;',
        '  -webkit-backdrop-filter: none !important;',
        '}',
        // The account row is one of those plain rows, and it stays plain in every
        // state. Clicking it left a grey plate under the avatar and the nickname —
        // the container painted a highlight once the menu was open. Both boxes and
        // the button itself are flattened, matched through the button with direct
        // children so no other element that happens to share those class suffixes
        // is reached.
        '[class*="_anchor"]:has(> [class*="_trigger"][data-signed-out]), [class*="_root"]:has(> [class*="_anchor"] > [class*="_trigger"][data-signed-out]),'
          + ' [class*="_trigger"][data-signed-out], [class*="_trigger"][data-signed-out]:hover, [class*="_trigger"][data-signed-out]:active,'
          + ' [class*="_trigger"][data-signed-out]:focus, [class*="_trigger"][data-signed-out]:focus-visible,'
          + ' [class*="_trigger"][data-signed-out][aria-expanded=true] {',
        // The shorthand, so a background image or a gradient the application paints
        // for one of those states cannot survive beside the cleared colour.
        '  background: transparent !important;',
        '  background-image: none !important;',
        '  box-shadow: none !important;',
        '  backdrop-filter: none !important;',
        '  -webkit-backdrop-filter: none !important;',
        '  border-color: transparent !important;',
        '}',
        // The list rows carry a frosted filter and an outline of their own. Left in
        // place every session looked lit at once and the highlight could not be
        // told apart from its neighbours, which read as the selection accumulating.
        // The border and the shadow are cleared for the same reason: they drew a
        // frame around every row whether or not it was the chosen one.
        '[class*="_sessionRow"], [class*="_projectRow"] {',
        '  backdrop-filter: none !important;',
        '  -webkit-backdrop-filter: none !important;',
        '  border-color: transparent !important;',
        '  box-shadow: none !important;',
        '}',
        // The plugins entry keeps its pane at all times. It is a standing door into
        // the plugin screen rather than one of the list rows the click highlight
        // moves between, so it is styled on its own class and never cleared.
        '[class*="_panelRow"] {',
        '  background-color: rgba(255, 255, 255, 0.16) !important;',
        `  backdrop-filter: blur(${radius}px) saturate(180%) brightness(1.06) !important;`,
        `  -webkit-backdrop-filter: blur(${radius}px) saturate(180%) brightness(1.06) !important;`,
        `  box-shadow: inset 0 1px 0 0 ${lit}, inset 0 -1px 0 0 ${faint},`
          + ` inset 1px 0 0 0 ${edge}, inset -1px 0 0 0 ${edge} !important;`,
        '}',
        // The account chip is rendered into the same sidebar slot family, so the row
        // it sits in carries this very class. That is why the pane under the avatar
        // and the nickname never went away: it was never a hover state to clear, it
        // was this standing rule, and the earlier attempts only ever reached the
        // button and the two boxes inside the row. Cancelled for the one wrapper
        // that holds the account button, and for no other row.
        '[class*="_panelRow"]:has([class*="_trigger"][data-signed-out]) {',
        '  background: transparent !important;',
        '  backdrop-filter: none !important;',
        '  -webkit-backdrop-filter: none !important;',
        '  box-shadow: none !important;',
        '  border-color: transparent !important;',
        '}',
        // The desktop update chip, hidden. An unsigned package ships no app-update.yml,
        // so this build has no update source at all and the chip sits in its error phase
        // offering 重试更新 for a check that can never succeed. Scoped to the settings
        // trigger row, which also holds the settings trigger and the connection
        // indicator; the account section's own indicator is a different class owner and
        // is left untouched.
        '[class*="_triggerRow"] [class*="_indicator"] { display: none !important; }',
        // The question card's options paint nothing of their own, and the chosen one
        // carries the glass instead — the same pane the sidebar rows use, so a click
        // reads as the glass moving onto the answer rather than as a row lighting up.
        // The application marks the choice itself with its own selected class, so no
        // tracking is needed here and the pane survives every re-render.
        '[class*="_options"] [class*="_option"]:not([class*="_optionSelected"]),'
          + ' [class*="_options"] [class*="_customRow"] {',
        '  background: transparent !important;',
        '  background-image: none !important;',
        '  box-shadow: none !important;',
        '  backdrop-filter: none !important;',
        '  -webkit-backdrop-filter: none !important;',
        '  border-color: transparent !important;',
        '}',
        '[class*="_options"] [class*="_optionSelected"] {',
        '  background-color: rgba(255, 255, 255, 0.16) !important;',
        `  backdrop-filter: blur(${radius}px) saturate(180%) brightness(1.06) !important;`,
        `  -webkit-backdrop-filter: blur(${radius}px) saturate(180%) brightness(1.06) !important;`,
        `  box-shadow: inset 0 1px 0 0 ${lit}, inset 0 -1px 0 0 ${faint},`
          + ` inset 1px 0 0 0 ${edge}, inset -1px 0 0 0 ${edge} !important;`,
        '  border-color: transparent !important;',
        '}',
        // The row chosen by the last click — a workspace or a conversation. Exactly one
        // carries the mark, because the click handler clears the others before setting
        // it, so the pane follows the click instead of accumulating. Declared after the
        // two rules above so it wins for the one row that has it. The account chip is
        // refused by the handler itself, so it can never collect this pane.
        `[${PICKED_ATTR}] {`,
        '  background-color: rgba(255, 255, 255, 0.16) !important;',
        `  backdrop-filter: blur(${radius}px) saturate(180%) brightness(1.06) !important;`,
        `  -webkit-backdrop-filter: blur(${radius}px) saturate(180%) brightness(1.06) !important;`,
        `  box-shadow: inset 0 1px 0 0 ${lit}, inset 0 -1px 0 0 ${faint},`
          + ` inset 1px 0 0 0 ${edge}, inset -1px 0 0 0 ${edge} !important;`,
        '}',

        // Dialogs and popups are also matched by role, so they are correct from
        // their very first paint instead of from the first scan. The scan walks
        // the whole document and cannot finish inside a frame; these two selectors
        // need no JavaScript at all.
        '[role=dialog] {',
        `  backdrop-filter: blur(${radius}px) saturate(180%) brightness(1.06) !important;`,
        `  -webkit-backdrop-filter: blur(${radius}px) saturate(180%) brightness(1.06) !important;`,
        '  background-color: transparent !important;',
        `  box-shadow: inset 0 1px 0 0 ${lit}, inset 0 -1px 0 0 ${faint},`
          + ` inset 1px 0 0 0 ${edge}, inset -1px 0 0 0 ${edge},`
          + ' 0 6px 20px -6px rgba(0, 0, 0, 0.18) !important;',
        '}',
        // Liquid glass for every popup. The theme's own plate is 58% white, which
        // over a photograph reads as a flat grey card rather than as glass; a sheet
        // of glass is mostly the artwork itself, held together by its edge. The
        // numbers are the recipe the liquid wallpaper plugin documents: 40px blur,
        // 195% saturation. The plate itself comes from the menu token further up,
        // which every popup reads, so no element selector is involved at all.
        // The edge belongs on that same plate: a rim drawn on the inner viewport —
        // where the suggestion list keeps its `role=listbox` — sat as a square
        // outline a few pixels inside the rounded sheet.
        '[data-menu-material] {',
        `  box-shadow: inset 0 1px 0 0 ${lit}, inset 0 -1px 0 0 ${faint},`
          + ` inset 1px 0 0 0 ${edge}, inset -1px 0 0 0 ${edge},`
          + ' 0 12px 32px -12px rgba(0, 0, 0, 0.45) !important;',
        '}',
        // The composer card is left exactly as the application styles it. An earlier
        // attempt moved its backdrop filter onto a pseudo-element, on the theory that
        // a filter on the card was confining the blur of the menus rendered inside
        // it. A rendered comparison proved that theory wrong — a filter on an
        // ancestor does not affect a descendant's backdrop filter at all — and the
        // pseudo only added a second blurred layer behind the card, which the plus
        // menu then sat on top of. Reverted: the card keeps its own filter and no
        // extra layer is inserted behind it.
        // The suggestion list fades its last row into the application's own menu
        // colour. That token is not part of this theme, so the fade would paint an
        // opaque sixteen-pixel strip along the bottom of an otherwise clear popup.
        '[data-trigger-menu][data-overflow-below]::after { background-image: none !important; }',
        // Inline code chips paint a near-white fill of their own. Clearing by tag
        // is blunt, but `code` is the one element that always does it, and the
        // collected pass misses the copies that live outside the viewport.
        'code { background-color: transparent !important; }',
        // The window header draws a one-pixel bottom border, which reads as a
        // white line across the top of every screen.
        'header[class*="_header"] { border-bottom-color: transparent !important; }',
        // The content column stacks its own fill on top of the frame's, so it
        // reads whiter than the title strip, which has only the frame behind it.
        // Both are cleared together, so the chrome reads as one piece of glass
        // with no white band anywhere across the top.
        '[data-windows-titlebar] [class*="_frame"]::before {',
        '  background-color: transparent !important;',
        '}',
        // With the chrome fully transparent the sidebar and the content column
        // blur into one another, and the layout loses its boundary. A hairline on
        // the sidebar's inner edge restores it without bringing back a fill.
        // Drawn with an inset shadow rather than a border so nothing shifts by a
        // pixel.
        '[class*="_sidebarCol"] {',
        '  box-shadow: inset -1px 0 0 0 rgba(255, 255, 255, 0.22) !important;',
        '}',
        // The centre column carries a 16px top-left radius. It was invisible while
        // the column had a fill; with the chrome transparent it reads as a notch
        // bitten out of the message area.
        '[class*="_centerCol"] { border-radius: 0 !important; }',
        // The frame carries the surface fill, because it is one element covering
        // the whole window. The columns and pane wrappers paint the same colour
        // again, so they are cleared: the content area used to stack four layers
        // against the title strip's two, a seam whose depth grew with the opacity.
        //
        // The fill deliberately does NOT live on <body>. A body background is
        // promoted to the canvas and painted beneath negative z-index children,
        // so it sits under this plugin's wallpaper layer — the opacity slider
        // would move a number nothing on screen could show.
        '[class*="_centerCol"], [class*="_sidebarCol"], [class*="_root"],'
          + ' [class*="_header"], [class*="_tabHost"] {',
        '  background-color: transparent !important;',
        '}',
        // Every button in the sidebar paints a flat white on hover, from literal
        // colours compiled into the stylesheet rather than from the hover tokens —
        // so no token override reaches them, and a scan cannot see a hover style
        // at all. Cleared for the whole column instead of one class at a time.
        '[class*="_sidebarCol"] button:hover, [class*="_sidebarCol"] [role=button]:hover {',
        '  background-color: transparent !important;',
        '  background-image: none !important;',
        '}',
        // A glyph button only loses its plate. No blur and no edge light: at this
        // size a rim reads as dirt rather than as glass. The fill and the text
        // colour are still taken over.
        `[${GLASS_BARE_ATTR}] {`,
        '  background-color: transparent !important;',
        '  background-image: none !important;',
        '  box-shadow: none !important;',
        '  color: var(--dsw-alias-label-primary) !important;',
        '}',
        // The composer's two round buttons: the plus that opens the command menu and
        // the arrow that sends. Each paints a disc of its own — the plus reads
        // --dsw-specific-selector, the arrow --dsw-alias-button-info-fill — and on a
        // glass composer those discs sit as two solid stickers on the pane. The pair
        // lives inside the composer dock, which is on the skipping list, so the
        // marking pass never reached them and the bare rule above never applied.
        // Cleared by class here, scoped to the composer card, so no primary button
        // anywhere else in the application loses its fill. The arrow is switched to
        // the label colour because a white glyph on a clear pane disappears over a
        // light wallpaper.
        '[data-composer-card] [class*="_add"], [data-composer-card] [class*="_primary"],'
          + ' [class*="_tools"] [class*="_add"], [class*="_trailing"] [class*="_primary"] {',
        '  background: transparent !important;',
        '  background-image: none !important;',
        '  box-shadow: none !important;',
        '  color: var(--dsw-alias-label-primary) !important;',
        '}',
        // The discs as tokens as well. Whatever element ends up painting them, these
        // two names are what it reads — the plus takes --dsw-specific-selector and the
        // arrow --dsw-alias-button-info-fill, with a hover colour of its own — so
        // clearing the names inside the composer covers every way the paint can be
        // arranged, and no button outside the composer sees the change.
        '[data-composer-card], [class*="_tools"], [class*="_trailing"],'
          + ' [data-composer-card] [class*="_add"], [data-composer-card] [class*="_primary"],'
          + ' [class*="_tools"] [class*="_add"], [class*="_trailing"] [class*="_primary"] {',
        '  --dsw-specific-selector: transparent;',
        '  --dsw-alias-button-info-fill: transparent;',
        '  --dsw-alias-button-info-hover: transparent;',
        '}',
        // A backdrop left behind by a closed panel. Hidden and made inert, because
        // covering the window it would otherwise eat every click in the app.
        `[${STUCK_MASK_ATTR}] {`,
        '  pointer-events: none !important;',
        '  opacity: 0 !important;',
        '}',
        // The panel's own colour swatch. The application styles every input it
        // finds, which would give this a filled plate and a border.
        '.wallpaper-color {',
        '  width: 40px !important;',
        '  height: 22px !important;',
        '  padding: 0 !important;',
        '  border: none !important;',
        '  border-radius: 6px !important;',
        '  background: transparent !important;',
        '  box-shadow: none !important;',
        '  cursor: pointer;',
        '}',
        '.wallpaper-slider {',
        '  -webkit-appearance: none !important;',
        '  appearance: none !important;',
        '  background: transparent !important;',
        '  box-shadow: none !important;',
        '  height: 18px;',
        '}',
        '.wallpaper-slider::-webkit-slider-runnable-track {',
        '  height: 6px;',
        '  border-radius: 3px;',
        '  background: rgba(255, 255, 255, 0.14);',
        '  box-shadow: none;',
        '}',
        '.wallpaper-slider::-webkit-slider-thumb {',
        '  -webkit-appearance: none !important;',
        '  appearance: none !important;',
        '  width: 16px;',
        '  height: 16px;',
        '  margin-top: -5px;',
        '  border-radius: 50%;',
        `  background: rgba(255, 255, 255, 0.22);`,
        '  backdrop-filter: blur(6px) saturate(180%) brightness(1.1);',
        '  -webkit-backdrop-filter: blur(6px) saturate(180%) brightness(1.1);',
        `  box-shadow: inset 0 1px 0 0 ${lit}, 0 1px 4px rgba(0, 0, 0, 0.28);`,
        '  border: none;',
        '}',
      ].join('\n')
    }

    /** Re-apply everything after a state change. */
    function applyAll() {
      applyLayer()
      applySurfaces()
      applyFontColor()
      applyAutoContrast()
      applyGlass()
      applyGlow()
    }

    const subscribers = new Set()

    /** Broadcast a state change to the mounted panel. */
    function publish() {
      for (const listener of subscribers) listener({ ...state })
      save()
      applyAll()
    }

    /** Ask the Host to enumerate media under one directory. */
    async function scan(dir) {
      const response = await window.fetch(`/wallpaper/list?dir=${encodeURIComponent(dir)}`)
      if (!response.ok) throw new Error(`扫描失败（HTTP ${response.status}）`)
      return response.json()
    }

    // The list reuses the same mediaUrl(path) helper the wallpaper layer uses — one
    // definition, taking a path. A second helper with the same name and an object
    // argument was added here with the thumbnails, and because a later declaration
    // wins, the layer's own call started building `?path=undefined` and every pick
    // loaded nothing.

    /** Ask the Host for the Wallpaper Engine and Steam workshop roots it found. */
    async function roots() {
      const response = await window.fetch('/wallpaper/roots')
      if (!response.ok) throw new Error(`探测失败（HTTP ${response.status}）`)
      const body = await response.json()
      return Array.isArray(body.roots) ? body.roots : []
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0 24px' },
      group: {
        color: 'var(--dsw-alias-label-primary)', fontSize: '12px', fontWeight: '600',
        marginTop: '2px',
      },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      input: {
        flex: '1 1 240px', minWidth: '200px', padding: '7px 10px', fontSize: '13px',
        borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
      },
      button: {
        padding: '7px 12px', fontSize: '13px', cursor: 'pointer', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
      },
      subtle: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      label: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', width: '72px' },
      value: {
        color: 'var(--dsw-alias-label-secondary)', fontSize: '12px',
        width: '44px', textAlign: 'right',
      },
      slider: { flex: '1 1 auto', minWidth: '120px' },
      // A grid of tiles, one file each — the shape a folder view uses. Columns fill the
      // width on their own, so the panel needs no breakpoint of its own.
      list: {
        maxHeight: '320px', overflowY: 'auto', display: 'grid', gap: '6px',
        gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))',
        border: '1px solid var(--dsw-alias-border-l3)', borderRadius: '10px', padding: '8px',
      },
      item: {
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', gap: '4px',
        padding: '7px 9px', borderRadius: '7px', cursor: 'pointer', fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
      },
      // The chosen wallpaper wears the glass, the same pane the sidebar rows and the
      // question options use — clicking a tile moves it, so the selection is the glass
      // rather than a border around it.
      itemActive: {
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', gap: '4px',
        padding: '7px 9px', borderRadius: '7px', cursor: 'pointer', fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'rgba(255, 255, 255, 0.16)',
        backdropFilter: 'blur(var(--wp-glass-blur, 24px)) saturate(180%) brightness(1.06)',
        WebkitBackdropFilter: 'blur(var(--wp-glass-blur, 24px)) saturate(180%) brightness(1.06)',
        boxShadow: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.80), inset 0 -1px 0 0 rgba(255, 255, 255, 0.15),'
          + ' inset 1px 0 0 0 rgba(255, 255, 255, 0.28), inset -1px 0 0 0 rgba(255, 255, 255, 0.28)',
      },
      slider: { flex: '1 1 200px', minWidth: '160px' },
      tag: {
        fontSize: '11px', padding: '1px 6px', borderRadius: '5px',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)',
      },
      colorBlock: {
        display: 'flex', flexDirection: 'column', gap: '5px', padding: '9px 10px',
        border: '1px solid var(--dsw-alias-border-l3)', borderRadius: '10px',
      },
      // The tile's picture: 48px square, the size a folder view uses for an icon. Images
      // paint themselves lazily; a video plays in place, muted and looping, which is the
      // moving preview.
      thumb: {
        width: '48px', height: '48px', borderRadius: '6px', flex: 'none',
        objectFit: 'cover', display: 'block', background: 'rgba(255, 255, 255, 0.10)',
      },
      // Two lines of the file name, then an ellipsis — a tile is as tall as its name.
      itemName: {
        overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '11px', lineHeight: '14px',
        textAlign: 'center', width: '100%', display: '-webkit-box',
        WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-all',
      },
      channelRow: { display: 'flex', gap: '8px', alignItems: 'center' },
      channelName: { width: '16px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      channelSlider: { flex: '1 1 auto', minWidth: '120px' },
      channelValue: {
        width: '34px', textAlign: 'right', fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
      },
    }

    /** Human-readable size. */
    function formatSize(bytes) {
      if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
      if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
      return `${Math.max(1, Math.round(bytes / 1024))} KB`
    }

    /** The settings page. */
    function WallpaperPanel() {
      const [snapshot, setSnapshot] = React.useState({ ...state })
      const [dir, setDir] = React.useState('')
      const [items, setItems] = React.useState([])

      // Only the previews on screen play. A folder holds dozens of videos, and letting
      // every one of them stream at once is what put the Host process under enough load
      // to fall over — and the Host is what builds the application list, so the desktop
      // lost that too. Visible tiles keep their moving preview; the rest hold a frame.
      React.useEffect(() => {
        const videos = Array.from(document.querySelectorAll('video[data-wp-thumb]'))
        if (videos.length === 0) return undefined
        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const video = entry.target
            if (!(video instanceof HTMLVideoElement)) continue
            if (entry.isIntersecting) void video.play().catch(() => {})
            else video.pause()
          }
        }, { rootMargin: '96px' })
        for (const video of videos) observer.observe(video)
        return () => observer.disconnect()
      }, [items])
      const [found, setFound] = React.useState([])
      const [status, setStatus] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        subscribers.add(setSnapshot)
        setSnapshot({ ...state })
        return () => { subscribers.delete(setSnapshot) }
      }, [])

      React.useEffect(() => {
        let cancelled = false
        roots().then(rows => { if (!cancelled) setFound(rows) }).catch(() => {})
        return () => { cancelled = true }
      }, [])

      /** Enumerate one directory and fill the list. */
      const runScan = React.useCallback(async (target) => {
        if (target === '') { setStatus('请先填写文件夹路径'); return }
        setBusy(true)
        setStatus('正在扫描…')
        try {
          const body = await scan(target)
          setItems(body.items ?? [])
          setStatus(body.items?.length
            ? `找到 ${body.items.length} 个媒体文件${body.truncated ? '（已截断）' : ''}`
            : '这个文件夹里没有找到图片或视频')
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * Open the desktop's own folder chooser, then scan what was picked.
       *
       * The picker is provided by the shell's preload, so it is only present in
       * the desktop window; in a browser the field stays the way in.
       */
      const browse = React.useCallback(async () => {
        const picker = window.__DSH_DIRECTORY_PICKER__
        if (picker === undefined || picker === null || typeof picker.pick !== 'function') {
          setStatus('这个窗口没有文件夹选择器，请直接填写路径')
          return
        }
        try {
          const picked = await picker.pick()
          if (typeof picked !== 'string' || picked === '') return
          setDir(picked)
          void runScan(picked)
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error))
        }
      }, [runScan])

      /** Apply one entry as the wallpaper. */
      const pick = React.useCallback((item) => {
        state = { ...state, current: { path: item.path, kind: item.kind, name: item.name } }
        publish()
      }, [])

      /** Change one setting and repaint. */
      const tune = React.useCallback((key, value) => {
        state = { ...state, [key]: value }
        if (key === 'autoContrast' && value) lastAutoLight = null
        publish()
      }, [])

      /** Remove the wallpaper and restore the theme's own surfaces. */
      const clear = React.useCallback(() => {
        state = { ...state, current: null }
        publish()
      }, [])

      // The panel marks itself so the marking pass leaves it alone: these rows are the
      // plugin's own controls, and a glass plate on them would read as part of the theme
      // rather than as the settings they are.
      return h('div', {
        style: { ...styles.wrap, '--wp-glass-blur': `${Math.max(0, Math.round(snapshot.glassBlur))}px` },
        'data-wp-panel': '1',
      },
        h('div', { style: styles.subtle },
          '扫描 Wallpaper Engine 的创意工坊目录，或直接填任意文件夹。点列表里的条目即可套用；视频会自动循环播放，不限制大小。'),

        found.length > 0 && h('div', { style: styles.row },
          h('span', { style: styles.subtle }, '检测到：'),
          ...found.map(row => h('button', {
            key: row.path, type: 'button', style: styles.button,
            title: row.path,
            onClick: () => { setDir(row.path); void runScan(row.path) },
          }, row.label))),

        h('div', { style: styles.row },
          h('input', {
            style: styles.input, value: dir, spellCheck: false,
            placeholder: '文件夹路径，或单个视频/图片的完整路径',
            onChange: event => setDir(event.target.value),
            onKeyDown: event => { if (event.key === 'Enter') void runScan(dir) },
          }),
          h('button', {
            type: 'button', style: styles.button, disabled: busy,
            onClick: () => { void runScan(dir) },
          }, busy ? '扫描中…' : '扫描此文件夹'),
          h('button', {
            type: 'button', style: styles.button,
            onClick: () => { void browse() },
          }, '浏览…')),

        status !== '' && h('div', { style: styles.subtle }, status),

        items.length > 0 && h('div', { style: styles.list },
          ...items.map(item => h('div', {
            key: item.path,
            style: snapshot.current !== null && snapshot.current.path === item.path ? styles.itemActive : styles.item,
            onClick: () => pick(item),
            title: item.path,
          },
            item.kind === 'video'
              ? h('video', {
                key: 'thumb',
                style: styles.thumb,
                // Marked so the panel can find these and pause the ones off screen.
                'data-wp-thumb': '1',
                // A moving preview rather than a still: the row plays its own file, at
                // icon size. Muted and inline, which is what lets a browser start it
                // without a gesture; the fragment below still gives the first frame to
                // paint before playback begins.
                src: `${mediaUrl(item.path)}#t=0.5`,
                preload: 'metadata',
                autoPlay: true,
                loop: true,
                muted: true,
                playsInline: true,
                tabIndex: -1,
                'aria-hidden': true,
              })
              : h('img', {
                key: 'thumb',
                style: styles.thumb,
                src: mediaUrl(item.path),
                loading: 'lazy',
                alt: '',
                'aria-hidden': true,
              }),
            h('span', { style: styles.itemName }, item.name)))),

        // ---- 壁纸 ----
        h('div', { style: styles.group }, '壁纸'),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '模糊'),
          h('input', {
            className: 'wallpaper-slider', style: styles.slider, type: 'range', min: 0, max: 40, step: 1,
            value: snapshot.blur, 'aria-label': '壁纸模糊',
            onChange: event => tune('blur', Number(event.target.value)),
          }),
          h('span', { style: styles.value }, `${snapshot.blur}px`)),

        // ---- 界面 ----
        h('div', { style: styles.group }, '界面'),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '不透明'),
          h('input', {
            className: 'wallpaper-slider', style: styles.slider, type: 'range', min: 0, max: 100, step: 1,
            value: snapshot.surface, 'aria-label': '界面不透明',
            onChange: event => tune('surface', Number(event.target.value)),
          }),
          h('span', { style: styles.value }, `${snapshot.surface}%`)),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '毛玻璃模糊'),
          h('input', {
            className: 'wallpaper-slider', style: styles.slider, type: 'range', min: 0, max: 40, step: 1,
            value: snapshot.glassBlur, 'aria-label': '毛玻璃模糊',
            onChange: event => tune('glassBlur', Number(event.target.value)),
          }),
          h('span', { style: styles.value }, `${snapshot.glassBlur}px`)),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '毛玻璃不透明'),
          h('input', {
            className: 'wallpaper-slider', style: styles.slider, type: 'range', min: 0, max: 100, step: 1,
            value: snapshot.glassAlpha, 'aria-label': '毛玻璃不透明',
            onChange: event => tune('glassAlpha', Number(event.target.value)),
          }),
          h('span', { style: styles.value }, `${snapshot.glassAlpha}%`)),

        // ---- 文字 ----
        h('div', { style: styles.group }, '文字'),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '颜色'),
          h('input', {
            className: 'wallpaper-color', type: 'color', 'aria-label': '自定义文字颜色',
            value: typeof snapshot.customTextColor === 'string' ? snapshot.customTextColor : '#fcfcfd',
            onChange: event => {
              const value = event.target.value
              // The picker fires on every pointer movement while it is open, and a
              // full pass walks every element in the document to decide what to
              // mark. Running that per tick froze the window, so only the value the
              // drag settles on is applied.
              window.clearTimeout(window.__wpColorTimer)
              window.__wpColorTimer = window.setTimeout(() => { tune('customTextColor', value) }, 160)
            },
          }),
          h('button', {
            type: 'button', style: styles.button,
            onClick: () => tune('customTextColor', null),
          }, snapshot.customTextColor === null ? '自动中' : '恢复自动')),

        h('label', { style: { ...styles.row, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox', checked: snapshot.autoContrast,
            onChange: event => tune('autoContrast', event.target.checked),
          }),
          h('span', { style: styles.subtle }, '自动对比（按壁纸亮度自动切换深/浅字色）')),

        h('div', { style: styles.row },
          h('span', { style: styles.subtle },
            snapshot.current === null ? '当前未使用壁纸' : `当前：${snapshot.current.name}`),
          h('button', {
            type: 'button', style: styles.button, disabled: snapshot.current === null,
            onClick: clear,
          }, '清除壁纸')))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'wallpaper-theme',
          order: 90,
          label: '壁纸主题',
        }, WallpaperPanel))

        // Re-read the theme's tokens whenever the palette flips, so every value
        // is derived from the live colour rather than the previous theme's.
        const palette = new MutationObserver(() => { applySurfaces(); applyGlass() })
        palette.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        ctx.effect(() => () => palette.disconnect())

        // Panels, dialogs and list rows mount and unmount as the user navigates,
        // so the surfaces are re-stamped on tree changes. The work runs
        // synchronously in the callback and never on a timer: the observer fires
        // as a microtask, so a freshly inserted panel is styled before the
        // browser paints it. Any deferral shows up as a white flash.
        // Both passes are guarded, and the tone pass runs first.
        //
        // A throw in either one used to abort the pair: the marking pass would
        // stop partway through the document, which is why a chat bubble never got
        // marked, and the tone pass would never run, which is why a freshly
        // opened dialog never received the contrast colours. One bad element must
        // not be able to stop the rest.
        const tree = new MutationObserver(() => {
          try { paintTones() } catch { /* the marking pass still has to run */ }
          try { applyGlassTargets() } catch { /* one bad element is not fatal */ }
          try { neutraliseStuckMask() } catch { /* never let this break the rest */ }
          try { paintPicked() } catch { /* the highlight is cosmetic */ }
        })
        void tree
        document.addEventListener('click', trackPickedRow, true)
        tree.observe(document.body, { childList: true, subtree: true })

        ctx.effect(() => () => tree.disconnect())

        // Sample the wallpaper a few times a second so the text keeps up with a
        // playing video. The tick stops itself once a frame has been read and the
        // wallpaper is a still image, which is the common case.
        const tick = window.setInterval(() => {
          if (!applyAutoContrast()) return
          if (state.current !== null && state.current.kind === 'image') {
            window.clearInterval(tick)
          }
        }, 600)
        ctx.effect(() => () => window.clearInterval(tick))

        applyAll()
      },
    }
  },
})
