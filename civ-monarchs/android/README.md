# 群星君主 · 离线单机 APK（0.4.0）

> 交付时间：2026-11-08　｜　对应 HANDOFF §8.1.1（路径 B：浏览器化单 APK）
> 一句话口径：**一个可安装的单 APK，飞行模式下能完整玩一局群星君主；用户愿意时可填自己的 LLM 端点与 Key，让部分席位由模型驱动。**

本目录是把 `civ-monarchs` 0.3.0（Node 后端）做进**桌游合集 APK** 的完整实现。0.3.0 的 `src/`、`config/`、`web/`、`tests/` **一行未改**，33 项原测试与 smoke 保持全绿。

---

## 1. 交付物

| 文件 | 位置 | 说明 |
|---|---|---|
| APK | `D:\酒馆游戏\release\桌游合集-guozhan-1.26.apk` | 1,178,911 B，versionCode 28 / versionName 1.26，debug 签名 |
| 同版副本 | `D:\酒馆游戏\apk\桌游合集-1.26-debug.apk` | 交付目录内的备份 |
| 校验和 | `D:\酒馆游戏\release\civ-monarchs-apk-1.26-SHA256SUMS.txt` | APK + 6 个前端资源；`cd release && sha256sum -c ...` 全部 OK |
| 纯前端产物 | `D:\酒馆游戏\release\civ-monarchs-1.26-www\` | 6 个文件，别的 WebView 壳可直接套用 |
| 前端源码 | `D:\酒馆游戏\board-games\app\src\main\assets\www\` | `index.html` / `app.js` / `style.css` / `civ-core.bundle.js` / `civ-ui.js` |
| 壳工程源码 | `android/shell/` | 从 `D:\测试\uno-bt` 备份的 Kotlin / Manifest / build.gradle / 布局，交付包自包含 |
| APK SHA256 | `c648ee1ae2dac3ced391ef75e3f58185f79d10d0fd78467c8ec0921edde126a8` | 本轮实算 |

APK 首屏新增第 9 个按钮「**群星君主 · 单机**」；点它（或任意入口）直接进离线界面，不建蓝牙服务、不连房间服务器。桌面浏览器里从 WebView 首页选「群星君主」→「本地对战（主机+AI）」同样进入。终局后「结算一回合 / 让模型推演本回合」按钮自动置灰（P2 修复）。

---

## 2. 架构

```
config/*.json ─┐
               ├─► build-bundle.mjs（零依赖 ESM→classic script）
src/core/*.js ─┤      ├─ node:crypto  → android/src/crypto-shim.js（同步纯 JS SHA-256）
src/ai/*.js  ──┤      ├─ config      → android/src/config.generated.js（4 份 JSON 内嵌）
               │      └─ 入口        → android/src/browser-host.js（BrowserHost）
               ▼
   assets/www/civ-core.bundle.js  → window.CIVMONARCHS
   assets/www/civ-ui.js           → window.CIVUI（8 页签界面、localStorage 存档）
   assets/www/app.js              → 第 9 款游戏入口 / 渲染分发 / 动作委托
   Android WebView（file://）    → 原生 BtJsBridge.civLlmChat（HttpURLConnection，无 CORS）
```

| 决策 | 做法 | 代价 |
|---|---|---|
| Node 版零改动 | bundle 层把 `node:crypto` 重定向到同步 sha256 shim；`process` 用空 env 垫片；`config` 内嵌成常量 | 多一层构建脚本；shim 需与 Node `sha256` 逐位一致（已验证） |
| 不用 REST/SSE | `BrowserHost.call(op, body)` 内存调用，事件换成回调数组；`stateId`/`requestId`/拒绝码语义不变 | 单机无多端同步（本就不需要） |
| 不做 MCP / ST 扩展 | 单机版只保留 core + 本机 UI | MCP / 酒馆扩展仍是 0.3.0 Node 版的能力 |
| LLM 双通道 | Android 走原生 `civLlmChat`（绕开 `file://` 的 CORS）；桌面浏览器走 `fetch` | 桌面浏览器直连端点仍需服务端允许 CORS |
| 席位身份不落盘 | `registry` / `llmCfg` 只存在 `createHost` 闭包；存档只有 `serialize(state)` | 读档后席位分配回到默认全人机，需在本机设置页重新接管 |

`src/core/state.js` 的 `createHash('sha256').update(str).digest('hex')` 与 shim 逐位一致：同一种子下 Node 版与浏览器版 `stateId` 相同（3 个种子含中文 / 400 字符串），Node 存档能被手机读、手机存档能被 Node 读。

---

## 3. 命令（全部可复跑）

```bash
cd D:/酒馆游戏/civ-monarchs

node android/build-bundle.mjs    # 读 config + src，生成 civ-core.bundle.js（同步到 APK 工程）
node android/verify.mjs          # 核心验收：14 项
node android/verify-ui.mjs       # 前端界面冒烟：8 项
node android/verify-browser.mjs  # 真实 Chromium file:// 全链路（需本机 Chrome）
node android/build-apk.mjs       # 同步资源 → versionCode 28 → gradle → 校验 → 出 APK
npm run verify                   # 0.3.0 Node 版 33 项测试 + 端到端 smoke
npm run pack                     # 生成 0.4.0 三个 zip + SHA256SUMS（同步到 release/）
```

`build-apk.mjs` 会：同步 6 个 `assets/www` 文件、幂等改 `versionCode/versionName`、跑 `gradle assembleDebug`、`apksigner verify`、**逐字节核对 APK 内 6 个资源与源码一致**、核对 `classes.dex` 与 bundle 入口、备份壳工程源码、出 SHA256SUMS。任一检查失败即非零退出，没有 `if X else True` 的兜底。

---

## 4. 本轮实跑的验收数据

| 验收 | 命令 | 结果 |
|---|---|---|
| 核心 | `node android/verify.mjs` | **14/14** |
| 界面 | `node android/verify-ui.mjs` | **8/8** |
| 真实浏览器 | `node android/verify-browser.mjs` | 首屏 → 选游戏 → 离线开局 → 48 州 / 8 页签 → 结算到第 2 回合 → 自动存档 39,395 B |
| 不回归（Node 版） | `npm run verify` | **33/33 测试 + smoke 全绿** |
| 不回归（桌游合集） | `cd ../board-games && npm test` | **139/139** |
| 打包 | `node android/build-apk.mjs` | BUILD SUCCESSFUL in 26s；`apksigner verify` 通过；6 个资源逐字节一致 |
| 版本 | gradle `output-metadata.json` | `versionCode 28` / `versionName "1.26"` / minSdk 21 |

核心 14 项覆盖：

1. sha256 与 Node 版逐位一致（3 种子）+ 存档双向互通（Node↔浏览器）。
2. 飞行模式无 `fetch` 推进 12 回合 → 时代 `tribe/citystate/kingdom`、网络请求 **0** 次；推进到第 120 回合判胜（胜者 `civ-04`）。
3. 第 1 回合 12 国全部下令、12 条史官台词 **12/12 唯一**。
4. 快照 / 编年史 / 战报 / 存档对 17 个禁词与 Key **0 命中**；席位视图 1 通过 / 1 拒绝且不进存档；人类意图不被覆盖。
5. 不点「让模型推演」2 回合 **0 次**模型调用；显式触发 3 席出意图、3 份提示词脱敏且带防注入包裹。
6. 缺 Key / 缺 model / 非法 JSON / 断网 **4/4** 自动降级且回合照常结算；超时（预算改写为 40ms）324ms 内全部降级并结算。
7. 过期 `stateId` → `STALE_REVISION`，`requestId` → 幂等回执；多余字段 / 未知行动被闸门拒绝。

---

## 5. 逐条对照 HANDOFF §8.1.1

| 要求 | 落地 |
|---|---|
| B1 无网可玩完整一局 | 12 国 / 48 州 / 编年史 / DM 修正 / 存档读档；实测第 120 回合判胜，0 次网络请求 |
| B2 席位 | 默认 12 席全人机；席位页点按钮切「人类 / 人机」；`policy=auto` 缺人由 `ensureDecisions` 补位，十二国每回合皆有举动 |
| B3 自接 LLM | LLM 设置页：`baseUrl` / `model` / `apiKey`（`type=password`）+ 12 席勾选 + 可选 DM 模型；OpenAI 兼容 `POST {baseUrl}/chat/completions`，输出结构化意图 JSON |
| B4 降级纪律 | 缺配置 / 超时 / 非法 JSON / 网络异常 → 该席 `deterministicDecision` 补位，推演不中断、UI 不阻塞、不重试 |
| B5 成本与延迟 | 沿用 `rules.ai`：并发 3 / 15s / 320 tokens；`civ-advance` 永不联网，只有显式点 `civ-auto` 才调用 |
| B6 席位盲化 | 身份只在闭包与本机设置页；提示词只用 `snapshotFor(state, civId)` + 合法动作 + 防注入包裹；台词由 `voice.js` 统一润色；回归测试见上 |
| B7 存档 | `localStorage['civmon-offline-v1']` 自动存；设置页可导出 / 导入 / 复制 JSON；不含 Key、不含身份字段 |
| B8 UI | 8 页签：地图 / 列强 / 编年史 / 下令 / DM 修正 / 席位 / LLM 设置 / 存档；移动端触屏 + 横屏 CSS 适配；复用桌游合集深色主题 |
| C 安全 | `INTERNET` 是安装期普通权限，未配置端点不触发网络请求；选单机时不申请蓝牙权限；Key 只在 JS 闭包与 Android 进程内存，不落盘 / 不进日志 / 不进存档 / 不对模型可见；`textContent` 与 `esc()` 渲染；防提示注入包裹保留 |
| D 不做 | 无 Node 后端、无 REST/SSE、无 MCP、无 ST 扩展、无联机、无 3.6 万球面地块、无内置 Key、不默认联网 |
| E 验收 | 见 §4；另新增单机版 3 套可复跑测试，原 33 项与桌游合集 139 项不回归 |

**混合内容说明**：页面由 `file:///android_asset/www/index.html` 加载（壳原有方式），不是 `https://` 页面，因此不存在「https 页面请求 http 子资源」的拦截。用户填局域网 `http://` 端点时，Android 走原生 `HttpURLConnection`（Manifest 已 `usesCleartextTraffic="true"`），不受 WebView CORS / mixedContent 影响；桌面浏览器直连 `http://` 端点仍受浏览器 CORS 约束，建议用支持跨域的端点或 `https://`。

---

## 6. 已知限制（未测 / 依据缺失，不推断）

- **未做真机 Android WebView 回归**：本机无已连接的 Android 设备 / 模拟器，无法 `adb install` 实机点按。已在同引擎的真实 Chromium（headless，`file://`）跑通全链路，且 APK 签名与资源逐字节校验通过，但「真机可安装并运行」仍属未实测项。
- **未接真实 LLM 端点实跑**：成功 / 失败路径都用 mock `fetch` 与原生通道契约验证；没有真实 Key，也没有对厂商端点发起过请求。
- `aapt dump badging` 在本机对中文路径 APK 会报 `Illegal byte sequence`（已知编码坑）；版本号以 gradle `output-metadata.json` 与 `apksigner verify` 为准。
- 读档后席位分配回到默认全人机（身份不落盘的取舍）；`llmCfg` 同样不恢复，每次启动需重填 Key。
- 0.3.0 的 3 个 zip 保持不动；`npm run pack` 现在产出 **0.4.0** 包，会覆盖项目内 `release/SHA256SUMS.txt` 与 `release/civ-monarchs-0.4.0-SHA256SUMS.txt`。
- 原生首屏的 3 个按钮在选中「群星君主 · 单机」时都进入同一个离线界面（不弹蓝牙设备选择 / 房间地址输入）。
