# 壁纸主题 · dsh-wallpaper-theme

> 给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的**壁纸 + 液态玻璃主题**插件。
> 扫描 Wallpaper Engine 或任意文件夹，点击即换壁纸；界面换成可调的毛玻璃质感。

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-yes-4c8dff)](https://www.npmjs.com/search?q=keywords:dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

## 功能

| 分组 | 能力 |
| --- | --- |
| **壁纸** | 扫描 Wallpaper Engine 创意工坊 / 我的项目 / 内置项目，或任意文件夹 |
| | 图片与视频壁纸；视频自动循环、静音播放 |
| | 图标网格选择器：48px 预览 + 文件名，视频为**小动态预览**（只有屏幕内可见的才播放） |
| | 点击即应用；当前使用中的格子上有一层玻璃 |
| **玻璃主题** | 界面不透明度 0–100% |
| | 毛玻璃模糊 0–40px、毛玻璃不透明度 0–100% |
| | **液态玻璃弹层**：弹出菜单、账号菜单、设置面板 |
| | **点击跟随**：侧栏工作区行、问题卡片选项、壁纸格子 —— 玻璃跟着点击移动 |
| **其他** | 文字颜色自定义 + 自动对比 |

## 截图

> 把你的两张截图放到 `docs/preview-1.png`（设置面板）与 `docs/preview-2.png`（玻璃效果），
> 然后把下面两行的注释去掉即可。

<!-- ![设置面板](docs/preview-1.png) -->
<!-- ![玻璃效果](docs/preview-2.png) -->

## 安装

### 方式一：插件商店（最简单）

在 DSH 里装上 [dsh-plugin-store](https://www.npmjs.com/package/dsh-plugin-store)，搜索 `壁纸主题` 或 `wallpaper`，点安装。

### 方式二：官方 CLI（推荐）

本插件声明了 `dsh.bundle` 清单，可以用 DSH 自带的插件命令安装：

```bash
dsh plugin add dsh-wallpaper-theme

# 桌面端指定 profile
dsh plugin --profile desktop add dsh-wallpaper-theme
```

装完重启 DSH 生效。

### 方式三：手动装进 profile

```bash
# 在 profile 目录里安装（profile 名按你的实际值，通常是 desktop 或 web）
cd "$HOME/.dsh/profiles/desktop"
npm i dsh-wallpaper-theme
```

然后在 profile 的 `cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: wallpaper-theme
      name: 'dsh-wallpaper-theme'
```

重启 DSH 生效。

### 方式四：本地开发（软链接）

```bash
git clone https://github.com/2214311960/dsh-wallpaper-theme.git
cd "$HOME/.dsh/profiles/desktop/node_modules"
# Windows（管理员或开启开发者模式）
mklink /J wallpaper-theme <你克隆到的目录>\dsh-wallpaper-theme
# macOS / Linux
ln -s /path/to/dsh-wallpaper-theme wallpaper-theme
```

再把上面那段 `insert` 加进 `cordis.patch.yml`（`name` 改成 `'@local/wallpaper-theme'`），重启即可热改代码。

## 使用

1. 打开 **设置 → 壁纸主题**；
2. 顶部会列出探测到的 Wallpaper Engine 目录，点一下即开始扫描；也可以填任意文件夹路径（支持单个文件）；
3. 在网格里点任意一格 → 壁纸立即更换，该格穿上玻璃；
4. 下面四组滑杆实时生效：**壁纸模糊 / 界面不透明 / 毛玻璃模糊 / 毛玻璃不透明**。

## 工作原理

插件分两个半区，各自只做自己能做到的事：

```
dsh-wallpaper-theme/
├─ index.js            宿主半区：扫描目录 + 流式发送文件（支持 Range 206）
├─ client.js           客户端半区：壁纸图层 + 两套注入样式表 + 设置面板
├─ cordis.patch.yml    把插件挂进 DSH 配置树
├─ package.json        插件清单（dsh.bundle / dsh.client）
└─ community/          投稿到社区清单 awesome-dsh-plugin 的条目文件
```

**为什么壁纸要走宿主路由**：界面是从 `dsh-app://app/` 加载的，`file://` 够不到本地文件，
而 data URL 必须把整个视频读进内存。所以宿主注册一条路由按需流式发送，并对 `Range` 请求回 `206`，
大视频才能拖动进度而不是整段下载。

**玻璃是怎么做出来的**：不改框架的类名（都是哈希，外部不可寻址），而是重写两个 surface 变量并带上 alpha 通道，
读取原值时先临时移除本插件自己的覆盖，这样浅色/深色主题切换仍然有效。

**点击跟随**：`data-wp-picked` 标记 + 一次捕获阶段的点击监听；问题卡片与壁纸网格直接用应用自身的选中态驱动，
所以重渲染也不会丢。设置面板自身标记 `data-wp-panel`，整块排除出主题的标记遍历 —— 自己的控件不该被自己主题化。

## 兼容性

| 项目 | 说明 |
| --- | --- |
| 平台 | Windows / macOS / Linux（壁纸目录探测针对 Windows 上的 Wallpaper Engine） |
| DSH | 0.1.7 及以上（使用 `dsh.bundle.patch` 与客户端半区注入） |
| Node | ≥ 22.15（宿主半区只用 `node:` 内建模块） |
| 运行时依赖 | **无**。不引入任何第三方包 |

### 已知限制

- 视频预览只在**可见时**播放（一屏几十个视频同时解码会拖垮宿主进程，实测会导致 DSH 宿主退出）；
- 扫描目录不会递归到子目录的**子目录**之外（按工坊结构，一层预览一层媒体）；
- 壁纸文件不做转码，格式取决于 Chromium 能解的编码。

## 社区

本插件收录于社区清单 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（分类 `theme`），
也可以在插件商店 / [dsh-market](https://github.com/dsh-market/dsh-market) 里搜到。

## 许可证

[MIT](./LICENSE) © 2026 2214311960

---

## English

A wallpaper + liquid-glass theme plugin for DeepSeek Harness. Scan a Wallpaper Engine workshop folder
(or any folder), click a tile to apply an image or video wallpaper, and tune wallpaper blur, surface
opacity, glass blur and glass opacity. Includes glass popups and a click-follow glass highlight.
No runtime dependencies. MIT licensed.
