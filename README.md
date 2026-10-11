# 沉浸式翻译 独立版 (Immersive Translate Standalone)

一个无需油猴脚本管理器、可直接安装的沉浸式翻译浏览器扩展。基于沉浸式翻译官方用户脚本构建，保留全部设置与 LLM API 配置入口。

## ✨ 特性

- **开箱即用**：Chrome / Edge 开发者模式加载即用，无需安装 Tampermonkey
- **完整保留原版功能**：网页双语翻译、划词翻译、PDF/EPUB/字幕翻译、悬浮球、设置面板
- **LLM API 入口完整保留**：支持配置 OpenAI、DeepSeek、Claude、智谱及任意 OpenAI 兼容接口的 API Key，自配 Key 为浏览器直连厂商，不经过任何中转
- **流式翻译支持**：译文逐字输出，与原版体验一致

## 📦 安装

1. 下载本仓库（Code → Download ZIP）并解压，或 `git clone`
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
3. 右上角开启 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择解压后的文件夹
5. 将扩展固定到工具栏即可使用

> Chrome 每次启动可能会提示"停用开发者模式扩展"，选择保留即可。

## ⚙️ 配置 LLM API

点击页面上的悬浮球 → 主面板底部 **⚙️ Settings** → 翻译服务，可配置各家 LLM 的 API Key：

| 服务 | 说明 |
|------|------|
| OpenAI | 需自备 API Key |
| DeepSeek | 需自备 API Key |
| Claude | 需自备 API Key |
| 自定义接口 | 任意 OpenAI 兼容接口（Base URL + Key + 模型名） |

自配 Key 模式下，浏览器直连 AI 厂商 API，不经过任何第三方服务器。

## 🔧 技术实现

本项目将沉浸式翻译官方用户脚本（v1.33.3）转换为标准 Chrome MV3 扩展，核心是一个 Tampermonkey GM API 垫片层：

```
immersive.js (官方用户脚本，去除元数据头)
    ↓ 调用 GM_* API
codec.js (请求体编解码：Blob/File/FormData/ArrayBuffer ↔ base64 JSON，三处共用)
    ↓
gm-shim.js (垫片：GM API → Chrome 原生能力)
    ├── GM_xmlhttpRequest → background 中转 fetch（绕过页面 CORS，支持流式）
    │   └── 请求 ID 全局唯一（实例前缀+序号），请求体显式编码传输
    ├── GM_getValue/setValue → chrome.storage.local
    ├── GM_addValueChangeListener → chrome.storage.onChanged
    ├── GM_openInTab → chrome.tabs.create
    ├── GM_registerMenuCommand → 扩展图标右键菜单
    └── GM_addStyle / GM_addElement → DOM 操作
background.js (Service Worker：网络代理、标签页、右键菜单)
    ├── 请求按 tabId:frameId:id 隔离管理，回包按 frameId 定向投递（多 frame 不串扰）
    └── 右键菜单只在安装/更新时重建，SW 唤醒不清理
```

文件说明：

| 文件 | 说明 |
|------|------|
| `manifest.json` | MV3 清单 |
| `immersive.js` | 沉浸式翻译官方用户脚本 v1.33.3（去元数据头，非 MIT，见 ATTRIBUTION.md） |
| `codec.js` | 请求体编解码（本项目原创，MIT） |
| `gm-shim.js` | Tampermonkey GM API 垫片（本项目原创，MIT） |
| `background.js` | Service Worker：请求代理与菜单（本项目原创，MIT） |
| `tm-require.js` | Tampermonkey 官方 XHR 并行补丁（非 TM 环境自动跳过） |
| `test/` | 单测（`node --test test/`） |
| `.github/workflows/ci.yml` | CI：语法检查、manifest 校验、GM API 覆盖率、单测 |

## ⚠️ 声明

- 翻译核心代码 (`immersive.js`) 版权归沉浸式翻译 (Immersive Translate) 官方所有，取自其公开发布的用户脚本，**不受 MIT 许可覆盖**；垫片层代码 (`codec.js`、`gm-shim.js`、`background.js` 等) 为本项目原创，采用 MIT 协议。详见 [LICENSE](LICENSE) 与 [ATTRIBUTION.md](ATTRIBUTION.md)
- 本项目仅为技术学习与便利安装目的，不修改、不破解原版任何付费功能；Pro 会员鉴权由官方服务端判定
- 使用官方翻译服务时，文本会经过沉浸式翻译服务器；介意者请使用自配 LLM API 模式

## 📝 更新日志

- **v1.33.3** (2026-10-11)：首个独立版发布，基于官方用户脚本 v1.33.3
- **修复** (2026-10-11)：请求 ID 全局唯一 + 按 frame 定向回传；Blob/FormData 显式编解码；右键菜单生命周期修复；新增 CI 与单测；厘清授权范围
