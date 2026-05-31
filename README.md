# Comic Image Extractor

漫画网站优先、通用网页兼容的图片提取与下载浏览器扩展。工程使用 Manifest V3 与原生 JavaScript，无构建步骤，可直接作为 Chrome / Edge 未打包扩展加载。

## 架构设计

工程采用 `Adapter + Core Engine + Download Pipeline`：

- `Adapter`：`content/adapters/` 中的漫画与通用适配器负责识别页面类型、提取漫画名/章节名、修复页码排序。
- `Core Engine`：`content/scanner.js`、`content/observer.js`、`core/` 与 `preview/` 负责扫描、去重、配置、筛选、排序和预览。
- `Download Pipeline`：`background/download-manager.js` 与 `download/` 负责自动选择单图或 ZIP 下载、并发控制、重试、命名模板和 metadata 导出。

## 目录结构

```txt
manifest.json
background/
content/
core/
download/
preview/
storage/
utils/
popup/
options/
vendor/
assets/
```

## 主要能力

- 扫描 `img[src]`、`currentSrc`、`srcset`、`picture/source`、常见懒加载属性和 CSS 背景图。
- 使用 `MutationObserver` 监听动态 DOM、懒加载、无限滚动和 SPA 路由变化。
- 漫画场景优先：长图、翻页、页码排序、章节上下文识别。
- 下载前预览：网格、列表、瀑布流，支持搜索、关键词、域名、格式和尺寸筛选。
- 命名模板：支持 `{comic}`、`{chapter}`、`{index:3}`、`{width}`、`{height}`、`{ext}`、`{site}`、`{date}`、`{time}`、`{hash}`、`{pageTitle}`。
- 下载模式：默认单图，另支持 ZIP 和自动模式；自动模式规则为 `<50` 张使用 ZIP，`>=50` 张使用单图。
- 单图下载默认使用源文件名，并按配置的请求间隔启动请求；遇到 HTTP 429 会统计数量并可一键重下这批图片。
- 默认启用避防盗链：下载期间优先让当前页面上下文预取图片；同时临时为图片域名补充来源页 `Referer` 和可用 Cookie 请求头，下载完成后自动清理规则。
- 导出 `metadata.json`。
- `metadata.json` 默认关闭；开启后会使用安全路径 `site/comic/chapter/metadata.json`，避免浏览器将文件名退化为本地化的“下载.json”。
- 设置持久化、导入、导出、重置和多模板。
- 展示模式默认使用浏览器侧边栏，也可切回窗口模式；可在顶部按钮或设置页切换。
- 预览图通过后台代理加载，AVIF/WebP/JPG/PNG 会尽量转成 PNG 缩略图再显示，避免弹窗直接请求远端图片导致 CORS、防盗链失败或 UI 抖动。
- 侧边栏/弹窗打开期间，切换标签页或当前页面加载完成会自动重新扫描并刷新预览。
- HTTP 429 图片会在 1 秒后自动重试，可停止自动重试，也可手动重试这批 429 图片。

## 安装步骤

1. 打开 Chrome 或 Edge 的扩展管理页面。
2. 开启开发者模式。
3. 选择“加载已解压的扩展”。
4. 选择本目录：`C:\Users\123\Desktop\image-extractor`。
5. 打开任意网页后点击扩展图标，执行“扫描图片”。

## 调试步骤

1. 在扩展管理页点击该扩展的“Service Worker”打开后台控制台。
2. 在目标网页打开 DevTools，查看 Content Script 是否有错误。
3. 在弹窗右键检查，查看 popup 页面日志。
4. 修改文件后，在扩展管理页点击“重新加载”，再刷新目标网页。

## 测试网站建议

- 漫画长图阅读页。
- 使用懒加载的图片站或瀑布流站点。
- 新闻或博客文章详情页。
- 电商商品详情图集页。
- 本地 HTML 测试页，包含 `img`、`srcset`、`data-src` 和 `background-image`。

## 错误排查

- 扫描数量为 0：刷新目标网页后重试，确认页面不是 `chrome://` 或 `edge://` 内置页面。
- 图片无法下载：确认扩展拥有目标域名权限，或在扩展详情页允许“所有网站”访问。
- 防盗链站点仍失败：保持“避防盗链请求头”开启并先在浏览器中正常打开该章节；如果站点需要登录，确认当前浏览器已登录，并刷新章节页后重试。
- 少数站点加载异常：在设置页关闭“避防盗链请求头”，保存后重新打开目标页再试。
- ZIP 很大导致失败：切换为单图模式，或降低单次选择数量。
- 格式转换失败：GIF/SVG 或跨源受限图片会自动回退为原格式。
- 文件名异常：检查设置页的命名模板，避免空变量或过深路径。
