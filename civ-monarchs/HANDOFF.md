# civ-monarchs 交接文档（给接手 Agent）

> 生成：2026-11-08 00:22 GMT+8　｜　**更新：2026-11-08 01:15 GMT+8，§8 的 APK 任务已实现并交付**
> 阅读顺序：先读 §0 摘要与 §8.0 实现结果，再按需要查其余章节。
> 本文档自包含，未参与前序对话也能接手。所有路径为绝对路径。

---

## 0. 30 秒摘要

- 项目：**群星君主 / civ-monarchs**，把 B 站视频《12 个大模型扮演君主谁能带领人类走向星际文明？》的玩法做成可分发、对接 SillyTavern 的独立包。当前版本 **0.4.0**（0.3.0 Node 后端包 + 0.4.0 离线单机 APK），已完成并验收。
- 形态：**零依赖 Node.js ≥20 后端**（HTTP + SSE）+ SillyTavern 原生扩展 + 自带网页客户端 + 原生 MCP + 角色卡/世界书。确定性规则引擎，LLM 只出高层意图。
- 关键特性：**人机席位 / 人类席位 + 席位身份对任何模型不可见**（0.2.0），以及 0.3.0 经 3 个子代理真实试玩后修掉的三个缺陷。
- 验收：`npm run verify` **33/33 测试 + 端到端 smoke 全绿**；发布包解压后独立复跑同样全绿。
- **手机 APK 已完成**（§8.0）：目标形态「离线单机，自己接 LLM 玩」按路径 B 落地，作为**桌游合集第 9 款游戏**进入 `D:\酒馆游戏\release\桌游合集-guozhan-1.26.apk`（versionCode 28 / 1,178,911 B / debug 签名）。原生首屏新增「群星君主 · 单机」，飞行模式可完整玩一局；终局后结算/推演按钮自动置灰（1.26 修复 P2）。
- 实现：`android/build-bundle.mjs` 把 core 打成 classic script（同步 sha256 shim + config 内嵌），`android/src/browser-host.js` 做内存 BrowserHost，`board-games/app/src/main/assets/www/civ-ui.js` 做 8 页签触屏 UI；Android 走原生 `BtJsBridge.civLlmChat` 绕开 `file://` 的 CORS。完整说明见 `android/README.md`。
- **0.3.0 源码零改动**：`src/`、`config/`、`web/`、`tests/` 一行未改；33 项测试 + smoke 与桌游合集 139 项均不回归。0.3.0 的三个发布 zip 保持不动，`npm run pack` 现产出 0.4.0。
- 验收：核心 14/14、界面 8/8、真实 Chromium `file://` 全链路通过、`apksigner verify` 通过、APK 内 6 个资源逐字节一致。**未测**：真机 Android WebView 安装运行、真实 LLM 端点调用（详见 `android/README.md` §6）。

---

## 1. 项目来源与目标

| 项 | 内容 |
|---|---|
| 视频 | B 站 `BV1onxb6rEeE`，UP 主「再改需求是修勾」，2026-11-01 发布 |
| 原项目 | `https://github.com/guaner-334/civ-atlas`，AGPL-3.0，TS/React/Vite，3.6 万球面地块，纯浏览器端，内置 Agent SDK，**无原生 MCP、无后端** |
| UP 主给的两条改造 | ① 把 API 封装成 MCP / Harness 可调用形式，替换内置 Agent SDK；② 剥离推演规则，降低推演强度、提高 DM 修改权重 |
| 用户初始指令 | 仿照 `D:\酒馆游戏\任务：自主构建“AI_辅助国战模拟”轻量级后端原型（分支）（分支）_2026-11-06_21-36.md` 里「对接酒馆」的模式做成一个包，「如果有更好的方式可以改进」 |
| 参考样本 | 上一轮 `guozhan` 包（Node 24 + tsup + dist + WebSocket + `protocol.browser.js` 生成副本 + SillyTavern 扩展） |

**核心决策（不要推翻）**：不 fork / 不内嵌 civ-atlas。理由：官方体量（2,360 文件、AGPL、无后端）与「发给合作酒馆服务器解压即跑」冲突，且原生 MCP 恰是要补的缺口。`docs/ENGINE-BRIDGE.md` 给出了日后替换官方引擎的接口映射（接口级设计，非已实现适配器）。

---

## 2. 当前交付物

| 文件 | 位置 |
|---|---|
| 主发布包 | `D:\酒馆游戏\release\civ-monarchs-0.3.0-20261107.zip`（约 306 KB，55 文件） |
| 纯酒馆扩展 | `D:\酒馆游戏\release\sillytavern-civ-monarchs-0.3.0.zip`（zip 根即 `manifest.json`） |
| 角色卡/世界书 | `D:\酒馆游戏\release\civ-monarchs-cards-0.3.0.zip`（DM 卡 + 12 君主卡 + 世界书） |
| 校验和 | `D:\酒馆游戏\release\civ-monarchs-0.3.0-SHA256SUMS.txt`；项目内 `civ-monarchs\release\SHA256SUMS.txt` |
| 项目源码根 | `D:\酒馆游戏\civ-monarchs\` |
| 文档 | `README.md`（总览）、`RELEASE.md`、`docs\ENGINE-BRIDGE.md`、`docs\COST.md`、`cards\README.md`、`extensions\sillytavern-civ-monarchs\README.md` |

旧 `0.1.0` / `0.2.0` 包仍留在 `release\`，**SHA256SUMS 只覆盖 0.3.0**。项目内 `release\` 与 `D:\酒馆游戏\release\` 各有一份，由 `scripts/pack.mjs` 同步。

---

## 3. 架构与不可协商的约束

```
config/*.json  →  src/core（确定性引擎 + 状态 + 席位 + 史官润色）
                →  src/server（HTTP/SSE，唯一权威状态，房间层保存身份）
                →  消费者：SillyTavern 扩展 / web/index.html / MCP stdio / 角色卡(纯聊天)
                →  src/ai（模型适配器 + 提示词 + 12 席并发编排 + 可选 DM 模型）
```

1. **确定性基线**：种子 RNG（FNV-1a → mulberry32，状态可序列化）；所有数值、战斗、时代、胜利由 `src/core/engine.js` 裁决，LLM 零裁决权。同种子 + 同命令序列逐位一致（有回归测试）。
2. **LLM 只出意图**：严格字段白名单 `civId/type/target/magnitude/note`；`validateDecisions` / `validateDmEdits` 做闸门；拒绝码由服务端给出，客户端只做「码→中文」翻译。
3. **CAS + 幂等**：`stateId`（sha256 前 20 位）+ `requestId`。**0.3.0 起 `stateId` 不含 `state.decisions`**（同回合多席位并发不互相撞 409），只随局面 / 回合推进变化。
4. **席位盲化（0.2.0，用户明确要求）**：「某国由人类还是人机控制」对任何模型、DM、观战者、MCP 都不可知。
   - 敏感数据 `control/claimed/model/modelLabel/adapter` **只存在房间层 `room.seats`**，绝不写入 `state`；快照用字段白名单；`submitted` 字段已彻底删除。
   - 行为一致：结算前 `ensureDecisions` 为所有未下令的存活文明补位 → 十二国每回合皆有举动。
   - 文体一致（0.3.0）：`src/core/voice.js` 对所有席位台词做统一史官润色，原始 note 不落库。
   - 通道脱敏：快照、事件流、编年史、战报、存档、`/auto` 回执、幂等缓存；`requestCache` 不进存档。
   - 管理视图隔离：`/seats`、`/models`、`/auto` 诊断仅房主 `adminToken`（`X-Admin-Token` 头）可见；MCP **不提供任何读取席位分配的工具**。
5. **三视角**：`admin`（人类房主，能看分配）/ `dm`（全知数值但无身份）/ `seat`（只看自己精确值，他国为 `techTier/powerTier/scoreTier` 分层档位）。
6. **运行零依赖零构建**：`node src/server/main.js` 即跑；不要引入 npm 包或构建步骤，这是相对上一个包的核心改进。
7. **许可**：本包 MIT，不含 civ-atlas 任何源码/素材；若接入官方引擎须遵守 AGPL-3.0。

---

## 4. 目录与文件职责

| 路径 | 职责 |
|---|---|
| `config/rules.json` | 推演强度 `simulation.strength=0.35`、DM 权重 `dm.weight=0.75`、时代阶梯、行动/干预表、胜利条件、AI 预算 |
| `config/monarchs.json` | 12 席人格、颜色、`modelLabel`、每席 `adapter/model/apiKeyEnv`（**仅房主管理视图可见**） |
| `config/world.json` | 种子、48 州地形与命名、初始资源 |
| `config/seats.json` | `defaultControl=ai`、`humanSeats=[]`、`policy=auto`、`autoFill=true`、`blindSeats=true`、voice 说明 |
| `src/core/rng.js` | FNV-1a/mulberry32、`canonical()` |
| `src/core/world.js` | 8×6 网格生成、环形邻接；**0.3.0 起每国首都 + 一邻州共两州** |
| `src/core/state.js` | `createGame`、`snapshotFor`、`computeStateId`、`serialize/restore`、`pushEvent`。⚠️ 目前仍 `import { createHash } from 'node:crypto'` —— 浏览器化必须改（§8.5） |
| `src/core/commands.js` | 拒绝码表、决策/DM 校验、`legalActions`（前端直接取 `action.command`，不自己拼） |
| `src/core/engine.js` | 结算顺序：君主意图 → DM 修正 → 自然演化 → 时代 → 胜负 → 编年史 |
| `src/core/seats.js` | 房间层席位注册表、`adminSeatView`、`sealDecision`（白名单 + 统一润色）、`ensureDecisions` 补位 |
| `src/core/voice.js` | 史官统一润色，组合空间约 12×6×12，纯 JS |
| `src/ai/{adapter,prompts,director}.js` | OpenAI 兼容适配器（缺 Key 降级）、提示词与防注入/盲化纪律、12 席并发编排、可选 DM 模型 |
| `src/server/{loader,app,main}.js` | 配置加载；HTTP + SSE + 房间/鉴权；启动入口 |
| `src/mcp/server.js` | stdio JSON-RPC MCP，15 个工具，`instructions` 含盲化纪律 |
| `extensions/sillytavern-civ-monarchs/` | `manifest.json` / `index.js` / `panel.css` / `lib/client.js`；运行时向 `/api/protocol` 协商协议（**无协议副本生成步骤**） |
| `web/index.html` | 单文件网页客户端（含房主席位管理面板），REST + SSE |
| `cards/` | DM 卡、12 君主卡（由 `scripts/gen-cards.mjs` 生成）、世界书（8 条，含常驻席位盲化条目） |
| `scripts/{gen-cards,smoke,pack}.mjs` | 生成卡片 / 端到端 smoke / 零依赖自写 ZIP + SHA256SUMS |
| `tests/{engine,api,blindness}.test.js` | 33 项，`node:test` |
| `deploy/` | Dockerfile / compose / Caddyfile |

---

## 5. 版本演进

| 版本 | 改动 | 动因 |
|---|---|---|
| 0.1.0 | 初始四入口包：MCP 补齐、规则旋钮、12 席可绑模型、四入口 | 初始需求 + UP 主两条改造 |
| 0.2.0 | 人机席位 / 人类接管 / 席位盲化（审计 14 处泄漏通道）、`tests/blindness.test.js`、管理令牌 | 用户：「加上人机席位，不然凑不够人不好开；但 AI 对该国是否为人类或人机是未知的」 |
| 0.3.0 | ① `voice.js` 统一润色 ② 开局每国两州 ③ `stateId` 去掉 decisions | 用户：「你自己开几个子代理试试能不能玩」→ 3 子代理实跑 2 回合后的实测缺陷 |

---

## 6. 试玩实测记录（0.3.0 的证据）

- 服务端口 8791（已停止），房间 `playtest`，3 个人类席位 `civ-01/04/08` + 9 人机；3 个独立子代理各持 seat token，仅通过 HTTP API 操作、禁止读本地文件；我作为 DM 提交 `boost` 干预并结算 2 回合。
- 三个代理都完成自主决策（大羲 `expand`→`invest`、青岚 `diplomacy`→第 2 回合 `CIV_ELIMINATED`、墨翟 `research`→`research×3`），**两轮都回答「无法判断其他席位由谁控制」**。
- 发现的三个问题与修复（详见 README §6「0.3.0 试玩实测」）：
  1. 文风聚类：8 国台词为 4 句套语各复用 2 次、另 4 国个性化；三个代理都做出「模板组 8 / 个性化组 4」聚类，而 3 个人类席位有 3 个落在个性化组 → `voice.js` 统一润色。
  2. 开局一击亡国：青岚第 1 回合被攻破唯一州即出局 → 每国两州。
  3. 并发 CAS：3 席同时下令 2 个 `409 STALE_REVISION` → `stateId` 去掉 decisions。
- 修复后复测：并发 3 席 `[200,200,200]` / 0 次 409；12 国台词 12/12 唯一；个性化原文 0 条入编年史；身份标记 0 条；首回合 12/12 存活；曜灵、星槎第 2 回合迈入「城邦」。

---

## 7. 运行 / 验收 / 部署速查

```bash
cd D:/酒馆游戏/civ-monarchs
node src/server/main.js                 # http://127.0.0.1:8790/ 自带网页客户端
npm run verify                          # 33 项测试 + 端到端 smoke
npm run pack                            # 生成 3 个 zip + SHA256SUMS，同步到 D:\酒馆游戏\release
npm run mcp                             # stdio MCP（需先启动服务）
node scripts/gen-cards.mjs              # 改 monarchs.json 后重生成 12 张卡
```

| 环境变量 | 说明 |
|---|---|
| `CIV_PORT` / `CIV_HOST` | 默认 `8790` / `127.0.0.1` |
| `CIV_TOKEN` | 设置后所有 API 需 `Authorization: Bearer` |
| `CIV_ORIGINS` | 逗号分隔 Origin 白名单（酒馆页面地址必须包含） |
| `CIV_MODEL_01_KEY` … `CIV_MODEL_12_KEY` | 每席 Key；另可 `CIV_MODEL_XX_BASE_URL` 覆盖端点 |
| `CIV_DM_KEY` / `CIV_DM_MODEL` | 可选 DM 模型 |
| `CIV_API_BASE` / `CIV_ROOM_ID` / `CIV_ADMIN_TOKEN` | MCP 侧 |

创建房间：`POST /api/rooms` 返回 `seatTokens`（每国一枚，只此一次）+ `adminToken`；默认房间 `room-1` 的 `adminToken` 启动时打印到控制台。主要端点见 README §8；协议由 `GET /api/protocol` 运行时协商。

---

## 8. ✅ 手机 APK（已完成）

### 8.0 实现结果（2026-11-08 01:15 GMT+8）

> 按 §8.1.1 规格执行，路径 B。**接手方不必再实现**，只需按需复跑与维护。

| 项 | 结果 |
|---|---|
| 成品 | `D:\酒馆游戏\release\桌游合集-guozhan-1.26.apk`（1,178,911 B，versionCode 28 / versionName 1.26，debug 签名） |
| 版本依据 | gradle `output-metadata.json`：`versionCode 28` / `versionName "1.26"` / minSdk 21；`apksigner verify` 通过 |
| SHA256 | `c648ee1ae2dac3ced391ef75e3f58185f79d10d0fd78467c8ec0921edde126a8`（见 `release/civ-monarchs-apk-1.26-SHA256SUMS.txt`） |
| 壳工程 | `D:\测试\uno-bt`（**找到并已修改**；此处修正 §8.2「壳工程源码不在本机」的旧结论），源码备份在 `android/shell/` |
| 入口 | APK 原生首屏第 8 个按钮「群星君主 · 单机」；桌面浏览器首页选「群星君主」→「本地对战」 |
| 代码 | `civ-monarchs/android/`（bundle / BrowserHost / 3 套验收 / 壳工程备份 / README）、`board-games/app/src/main/assets/www/{index.html,app.js,style.css,civ-core.bundle.js,civ-ui.js}` |
| 命令 | `node android/build-bundle.mjs` → `node android/verify.mjs`（14/14）→ `verify-ui.mjs`（8/8）→ `verify-browser.mjs`（真实 Chromium）→ `build-apk.mjs`（一键出包 + 校验） |
| 不回归 | `npm run verify` 33/33 + smoke；`cd ../board-games && npm test` 139/139 |
| 未测 | 真机 Android 设备安装运行（无设备）、真实 LLM 端点调用（无 Key，用 mock 验证成功与降级） |

关键实现取舍：① `node:crypto` 用同步纯 JS sha256 shim 替换，与 Node 版 `stateId` 逐位一致 → PC / 手机存档双向兼容；② `llmTransport` 可注入，Android 走原生 `HttpURLConnection`（`civLlmChat`，Key 只在进程内存）绕开 `file://` 的 CORS，桌面回退 `fetch`；③ 席位分配与 Key 都不落盘，读档后回到默认全人机；④ 保留 `stateId`/`requestId`、拒绝码、`validate*` 闸门与 `voice.js` 统一润色。

§8.1–§8.6 以下保留为**当时的需求与调查记录**，其中 §8.2「APK 壳工程源码不在本机」、§8.3「不能直接跑进那个 APK 壳」、§8.5「需重建 Android Studio 工程」均为实施前的结论，现已由 §8.0 取代。

### 8.1 用户诉求（已确认，无歧义）

> 「这个jev能跑在手机apk上吗」（2026-11-08 00:19）
> 「离线单机自己接llm玩」（2026-11-08 00:29，回答目标形态的追问）
> 「你把要求整理一下就行」（2026-11-08 00:29，限定本次交付范围）

- 「jev」按「这个包」理解；诉求是**把 civ-monarchs 做成和既有 `桌游合集-guozhan-*.apk` 一样的手机 APK**。
- 目标形态已明确：**离线单机 + 用户自接 LLM**。即游戏本体（确定性引擎、状态、存档、全部 UI）在手机本地 WebView 内运行，不依赖 PC / 云服务器 / 自建后端；LLM 由用户在手机上自行配置 OpenAI 兼容端点与 Key，是**可选增强**，不配置时 12 席全人机、完全离线可玩。
- 路径锁定 **B（浏览器化单 APK）**；路径 A（连常开服务器）与 C（内嵌 Node）不符合「离线单机」，不再考虑。
- **本次只整理要求，不实现代码**；实现由接手 Agent 完成。

### 8.1.1 已确认的产品要求（接手方按此执行）

#### A. 目标形态（一句话验收口径）

> 一个可安装的单 APK：飞行模式下能完整玩一局「群星君主」；用户愿意时可填自己的 LLM 端点与 Key，让部分席位由模型驱动。

「离线」指**引擎与玩法不依赖任何外部服务**；LLM 调用本身需要网络，属用户主动开启的可选项。二者不矛盾，不要为了「绝对零网络」砍掉自接 LLM。

#### B. 必须实现的功能

| # | 要求 |
|---|---|
| 1 | **无网可玩完整一局**：开局 → 连续推进 ≥10 回合 → 时代跃迁 → 星际胜利 / 终局判胜；含 12 国、48 州地图、编年史、DM 修正、存档与读档 |
| 2 | **席位**：默认 12 席全人机；任意席位可切「人类」（触屏下令）/「人机」；人类可随时用本地界面接管；`policy=auto` 缺人自动补位，保证十二国每回合皆有举动 |
| 3 | **自接 LLM**：设置页可填 `baseUrl` / `model` / `apiKey`（全局默认值 + 每席可覆盖），可选择给哪些席位启用；可选 DM 模型。调用走 OpenAI 兼容 `POST {baseUrl}/chat/completions`，输出结构化意图 JSON |
| 4 | **降级纪律**：缺 Key / 缺模型 ID / 超时 / 输出不合法 JSON / 网络不可用 → 该席位自动降级确定性君主，推演不中断、UI 不阻塞、不反复重试 |
| 5 | **成本与延迟**：沿用 `config/rules.json` 的 `rules.ai`——并发 3、单席超时 15s、`maxTokens` 320；**不得每回合自动全席调用模型**，须由用户显式点「让模型推演本回合」 |
| 6 | **席位盲化必须保持**：模型绑定信息只在本机设置页可见；任何模型收到的提示词、快照、编年史、战报都不得含「哪些席位绑了模型 / 哪些是人类 / 哪些是人机」；所有席位台词继续由 `src/core/voice.js` 统一润色；单机版需保留对应回归测试 |
| 7 | **存档**：`localStorage`（或 WebView 可用持久化），支持导出 / 导入 JSON；存档不含 Key、不含席位身份字段 |
| 8 | **UI**：复用 `web/index.html` 的地图 / 列强榜 / 编年史 / DM 面板 / 席位管理，改成移动端触屏可用；新增「LLM 设置」页 |

#### C. 安全与权限边界

- `INTERNET` 权限仅在用户填了 LLM 端点时才需要；未配置时 APK 必须能纯离线运行，**不得因权限被拒而崩溃**。
- **API Key 不落盘**：优先只存内存，每次启动重填；若确需持久化，必须明确提示 WebView `localStorage` 是明文存储并默认关闭。Key 不进日志、不进存档、不进任何对模型可见的文本；设置页用 `type=password`。
- 保留防提示注入包裹（`[群星编年 · 游戏数据开始/结束]`）与 `textContent` 渲染纪律。
- WebView 混合内容：`https://` 页面不能请求 `http://` 端点。建议用 `WebViewAssetLoader` 映射到 `https://appassets.androidplatform.net/`；若用户填局域网 `http://` 端点，需谨慎处理 `mixedContentMode` 或明确提示改用 https。

#### D. 明确不做（防止范围膨胀）

- 不做 Node 后端、不做 REST/SSE 服务（用 BrowserHost 内存调用替代）。
- 不做 MCP、不做 SillyTavern 扩展、不做蓝牙 / WebSocket 联机（桌游合集壳有蓝牙 bridge，但本需求是单机）。
- 不内嵌官方 civ-atlas 引擎、不做球面 3.6 万地块地图；保留 48 州网格。
- 不内置任何模型 Key、不代付 token、不默认联网。

#### E. 验收标准

1. **飞行模式**：安装 → 开局 → 连续推进 ≥10 回合 → 出现时代跃迁 → 导出 / 导入存档一致 → 不崩溃、无网络请求。
2. **自接 LLM**：填 Key 后指定 1–3 席由模型出意图且回执可见；断网 / 填错 Key 时这些席位自动降级、回合照常结算。
3. **盲化回归**：单机版快照 / 编年史 / 战报 / 存档不出现 `control`、`modelLabel`、`adapter`、厂商名或身份标记；12 国台词无可聚类分组。
4. **不回归**：现有 33 项 Node 版测试与 smoke 仍全绿；新增单机版测试。

#### F. 与现有代码的映射

| 类别 | 文件 |
|---|---|
| 可直接复用 | `src/core/{rng,world,commands,engine,voice,seats}.js`、`src/ai/prompts.js`、`src/ai/adapter.js` 的 fetch 调用逻辑、`web/index.html` 的 UI 结构 |
| 必须改造 | `state.js` 的 `node:crypto`（同步 sha256 注入）、`loader.js` 的 `node:fs`（config 内嵌）、`app.js` 的 `node:http`+SSE（BrowserHost）、`web/index.html` 的 fetch/SSE |
| 建议重构 | 把 `deterministicDecision` 从 `director.js` 下沉到 core，减少浏览器 bundle 对 `adapter.js` 的依赖 |

### 8.2 已完成的调查（证据，全部实测）

| 事实 | 证据 |
|---|---|
| 既有 APK 共 19 个 | `D:\酒馆游戏\release\桌游合集-guozhan-1.4.apk` … `1.22.apk`；最新 `1.22.apk`，2026-11-08 00:04，1,134,496 B |
| APK 是**纯 WebView 壳 + 静态 assets** | 内部：`classes.dex`/`classes2.dex`、`resources.arsc`、`AndroidManifest.xml`、`assets/www/{index.html,app.js,style.css,uno-core.bundle.js}`；**无 `lib/*.so`（没有内嵌 Node / libnode）** |
| 前端资源规模 | 1.22：`app.js` 161 KB、`uno-core.bundle.js` 859 KB、`style.css` 37 KB、`index.html` 621 B |
| 交互模式 | `app.js` 开头注释：`window.UnoBtAndroid` 原生蓝牙 JS bridge（host/guest）+ Web 模式（WebSocket 连房间服务器）；`index.html` 用普通 `<script src>` 加载经典脚本，**不是 ES module** |
| 有现成的零依赖 bundle 生成器 | `D:\酒馆游戏\board-games\scripts\build-web.mjs`（把 `core/src/*.js` 的 ESM 扁平化为单文件 classic script，暴露 `window.UNOKU`；注释明确：**Android WebView 从 `file://` 加载 ES module 会被当作 opaque origin，必须打成单文件**）。另有 `scripts/verify-bundle.cjs`、`D:\酒馆游戏\scripts\build-uno-engine.ts` |
| 静态资源源目录存在 | `D:\酒馆游戏\board-games\app\src\main\assets\www\` 含上述 4 个文件 |
| **APK 壳工程源码不在本机** | 全局查找 `build.gradle*` / `gradle-wrapper.jar` / `AndroidManifest.xml` / `*.kt` / `*.java` / `capacitor.config*` 在 `D:\酒馆游戏` 下**均无结果**；`D:\酒馆游戏\apk\` 只有一个 debug 成品 |
| 本机 Android 构建环境 | `java` 在 PATH；`adb` 在 PATH；`ANDROID_HOME=C:\Users\蓝莓鸽子\AppData\Local\Android\Sdk`（有 `build-tools/34.0.0`、`platforms/android-34`、`android-35`、`platform-tools`、`cmdline-tools`、`licenses`）；`gradle` / `sdkmanager` / `keytool` 不在 PATH |

### 8.3 结论

**当前形态不能直接跑进那个 APK 壳。** civ-monarchs 的核心是 Node.js HTTP 服务（`node:http` / `node:crypto` / `node:fs`）+ REST/SSE；APK 里没有 Node 运行时，WebView 只会加载 `assets/www/index.html`，所有 `fetch('/api/...')` 与 `EventSource` 都会失败 → 白屏。把 zip 解压进 assets 无效。

### 8.4 三条路径对比

> **路径已锁定 B**（§8.1「离线单机自己接 llm 玩」）。A / C 仅作背景参考，不要采用。

| 路径 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A 瘦客户端** | APK 只放 `web/index.html`（几乎不用改），填服务器地址连到 PC / 云服务器上的 Node 服务 | 改动最小，可复用现有壳；功能全（MCP 在服务端、12 模型可用） | 需要一台常开机器；手机需可达（局域网或 HTTPS + `CIV_ORIGINS`）；HTTPS 页面不能 fetch `http://`（混合内容拦截） |
| **B 浏览器化单 APK（推荐，贴合桌游合集模式）** | 把确定性引擎打成 classic-script bundle，WebView 内直接跑，存档走 localStorage | 真正离线单 APK、无需服务器、无 Node；与用户既有产物形态一致 | 需改造 `state.js` 的 `node:crypto`、config 内嵌、REST/SSE 换成内存适配器；MCP / ST 扩展 / 外部模型席位在纯离线形态不可用 |
| **C 内嵌 Node**（Termux / nodejs-mobile） | APK 内嵌 libnode，启动 `src/server/main.js`，WebView 开 `127.0.0.1:8790` | 后端代码零改动 | 包体大、需 NDK/Gradle 工程、维护状态与 Node 版本不确定；对本项目不划算 |

### 8.5 路径 B 具体改造清单（若选它）

1. **去掉 Node 内置依赖**：`src/core/state.js` 的 `createHash('sha256')` 改为可注入的 `hashImpl`（默认 Node 实现）；浏览器端提供**同步**纯 JS sha256（约 50 行）——注意 WebView 的 `crypto.subtle.digest` 是异步，而 `computeStateId` 是同步的，不能直接替换。
2. **config 内嵌**：`src/server/loader.js` 用 `node:fs` 读 JSON；打包时生成 `config.bundle.js`，把 `rules/monarchs/world/seats` 作为 JS 常量注入，或让浏览器端 `loadConfig()` 直接返回内嵌对象。
3. **BrowserHost 适配器**：照 `src/server/app.js` 的语义做一套内存实现（`snapshot / actions / decisions / dm / advance / chronicle / report / save / load / seats / my-seat`），SSE 事件换成回调数组；`web/index.html` 的 `api()` 与 `connectSSE()` 改为调用它。保持 `stateId`/`requestId`、拒绝码、席位盲化语义不变。
4. **bundle**：仿 `board-games/scripts/build-web.mjs` 写 `scripts/build-android-bundle.mjs`，零依赖把 `src/core/*.js` + `src/ai/prompts.js`（可选）扁平化为单文件 classic script，暴露 `window.CIVMONARCHS`。约束：只用命名 import/export、无 default export、无 dynamic import、无循环依赖、无 `node:` 前缀。⚠️ `seats.js → director.js → adapter.js` 用了全局 `fetch`（WebView 可用），`prompts.js`/`voice.js`/`rng.js` 纯 JS；若要完全离线，可在 bundle 中剔除 `adapter.js` 只保留 `deterministicDecision`（把 `deterministicDecision` 下沉到 core 更干净）。
5. **UI 复用**：`web/index.html` 改为 `<script src="civ-core.bundle.js"></script>` + 经典 script；保留地图、列强榜、编年史、DM 修正、席位管理、存档。存档 `serialize/restore` 已是纯 JSON → `localStorage`。
6. **WebView 设置**：`setJavaScriptEnabled(true)`、`setDomStorageEnabled(true)`；建议用 `WebViewAssetLoader` 映射到 `https://appassets.androidplatform.net/` 而非 `file://`（避免 opaque origin、混合内容与 fetch 限制）。
7. **功能裁剪说明**：纯离线 APK 保留人机席位、人类席位（触屏操作）、DM 面板、编年史、存档、盲化；MCP / SillyTavern 扩展 / 12 个外部大模型席位需要网络与 API Key，可作为可选项（需 `INTERNET` 权限）。
8. **APK 壳**：本机有 Android SDK 但**缺 Gradle/Kotlin 工程源码**，需重建 Android Studio 工程或向用户索取原工程；`gradle`/`sdkmanager`/`keytool` 需补 PATH 或走 Android Studio 内置 Gradle。产出 `assets/www/` 全套静态文件后，让壳加载即可。
9. **同步打包**：若产出 `assets/www/`，更新 `scripts/pack.mjs` 的清单，让发布包一并包含 APK 前端产物与 bundle 脚本。

### 8.6 建议接手第一步

歧义已消除（§8.1），**直接按路径 B + §8.1.1 规格执行**，无需再向用户确认目标形态。

1. 先确认能否拿到桌游合集的 Android 壳工程；拿不到就按 §8.5 重建（本机有 Android SDK，缺 Gradle/Kotlin 源码）。
2. 先做「浏览器化 bundle + 桌面浏览器验证」，确认飞行模式可玩完整一局，再套 APK 壳，降低调试成本。
3. 再叠加「LLM 设置页 + 自接模型 + 离线降级」，最后按 §8.1.1 E 的四条标准验收。
4. 全程保持 0.3.0 的 Node 版不动，33 项测试与 smoke 不回归。

---

## 9. 已知限制与踩过的坑

- **路径 / 工具**：Git Bash 的 `/tmp` 与 Windows 原生 Python 路径不互通（曾导致 `FileNotFoundError`）；跨工具传数据用管道或项目内路径。
- `SHA256SUMS.txt` 行格式 `hash␠␠filename`（两个空格），解析 `{filename: hash}` 别写反。
- `sorted(glob('*.apk'))` 是字符串排序，会把 `1.9` 当成最新；按 `os.path.getmtime` 取。
- 对话导出 md 文件名含全角引号 `“ ”`（`D:\酒馆游戏\任务：…md`），Read/Grep 时要用精确路径。
- 项目路径含中文，PowerShell 处理时注意编码；打包器 `scripts/pack.mjs` 用 UTF-8 文件名标志，已验证可解压。
- **不要删除 `.workbuddy` 目录**（项目数据，非缓存）。
- `seats.policy=wait` 会让房主看到等待名单；`skip` 会留下空缺可能被间接推断 → 盲局请用默认 `auto`。
- 玩家原创台词由史官统一润色，原文只在 HTTP 回执出现、不落库（0.3.0 为消除文风泄漏的取舍）。
- 扩展按 ST 1.12+ 编写，DOM 锚点漂移时降级挂 `body`；未在真实酒馆全版本回归。
- SSE 令牌走 `?token=` 查询参数，自建反代需脱敏 access log。
- 未在真实 SillyTavern 全版本回归；离线单机 APK 已在同引擎 Chromium headless `file://` 全链路验证，**但真机 Android WebView 未测**（无设备），真实 LLM 端点调用未测（无 Key）。
- `aapt dump badging` 对中文路径 APK 会报 `Illegal byte sequence`；版本以 gradle `output-metadata.json` + `apksigner verify` 为准。

---

## 10. 用户偏好与协作约定

- **中文**技术输出；偏好**结构化表格**、可复现的验收数据、明确的安全边界与取舍说明；风格专业严谨、结论先行。
- 明确授权「如果有更好的方式可以改进」——可以主动改进架构，但要说明改了什么、为什么、代价是什么。
- 交付前习惯**实测 + 验收**（`npm run verify`、发布包解压后独立复跑），不要只交文档。
- 发布目录习惯：`D:\酒馆游戏\release\`（与 guozhan 系列包并列），新包也要同步一份过去。
- 允许开子代理做真实试玩验证（0.3.0 就是这样发现问题的）。

---

## 11. 完成清单（原待办，2026-11-08 01:15 全部结清）

> 路径 B + §8.1.1 规格已执行完毕；唯一剩余是「真机回归」这一未测项（无设备）。

1. ✅ **找到** Android 壳工程：`D:\测试\uno-bt`（Gradle 8.9 + JDK17 + SDK 34 全可用），源码已备份到 `android/shell/`。
2. ✅ 浏览器化：同步 sha256 shim、config 内嵌、BrowserHost 替代 REST/SSE、零依赖 ESM→classic bundle、触屏 + 横屏 UI、`localStorage` 存档。
3. ✅ LLM 设置页：自填 `baseUrl/model/apiKey`、按席位启用、可选 DM 模型；缺 Key / 缺 model / 超时 / 非法 JSON / 断网均自动降级。
4. ✅ 安全边界：Key 只在 JS 闭包与 Android 进程内存、单机模式不申请蓝牙权限、原生 HTTPS 通道绕开混合内容 / CORS、防注入包裹、`esc()` 渲染、绑定信息只在本机设置页可见。
5. ✅ 双端回归：真实 Chromium `file://` 全链路 + VM 冒烟；飞行模式 12 回合 / 0 次网络请求、跑到第 120 回合判胜；自接 LLM 成功与降级；盲化 17 禁词 0 命中；33 项 + 139 项不回归。
6. ✅ 出 APK 1.25，收尾轮修 P2（终局按钮禁用）后重出 **1.26**（versionCode 28）；已更新 `pack.mjs` / `README.md` / `RELEASE.md` / `HANDOFF.md` / `android/README.md`；重跑 33 项 + smoke + 打包校验。另有 P1：guozhan 服务端 `dist` 过期，已重建并升版本到 0.9.9。
7. ⬜ 可选重构未做：`deterministicDecision` 仍在 `src/ai/director.js`；bundle 通过空 `process` 垫片容纳 `adapter.js`，实测无副作用。保持 0.3.0 源码零改动的优先于这一重构。

**后续若要做真机回归**：`adb install -r D:\酒馆游戏\release\桌游合集-guozhan-1.26.apk` → 选「群星君主 · 单机」→ 飞行模式推进 10 回合 → 导出/导入存档 → 填 LLM 端点验证与断网降级 → 推演到终局确认按钮置灰。

---

## 12. 关键路径速查

| 用途 | 绝对路径 |
|---|---|
| 项目根 | `D:\酒馆游戏\civ-monarchs` |
| 交接文档（本文） | `D:\酒馆游戏\civ-monarchs\HANDOFF.md` |
| **离线单机实现与说明** | `D:\酒馆游戏\civ-monarchs\android\README.md` |
| **一键出 APK** | `node D:\酒馆游戏\civ-monarchs\android\build-apk.mjs` |
| **Android 壳工程** | `D:\测试\uno-bt`（源码备份 `civ-monarchs\android\shell\`） |
| **APK 成品** | `D:\酒馆游戏\release\桌游合集-guozhan-1.26.apk` |
| 发布目录 | `D:\酒馆游戏\release` |
| 上一代项目（参考） | `D:\酒馆游戏`（guozhan 后端 + `board-games`） |
| 桌游合集前端源 | `D:\酒馆游戏\board-games\app\src\main\assets\www` |
| ESM→classic bundle 参考实现 | `D:\酒馆游戏\board-games\scripts\build-web.mjs` |
| 参考对话导出 | `D:\酒馆游戏\任务：自主构建“AI_辅助国战模拟”轻量级后端原型（分支）（分支）_2026-11-06_21-36.md`（23 MB / 39.9 万行，用 Grep 检索，勿整读） |
| Android SDK | `C:\Users\蓝莓鸽子\AppData\Local\Android\Sdk` |
| 工作区记忆 | `C:\Users\蓝莓鸽子\WorkBuddy\2026-11-06-21-39-14\.workbuddy\memory\2026-11-06.md`、`2026-11-07.md` |

---

## 13. 记忆文件

Workspace memory 已记录每日工作日志（`2026-11-06.md` 初始包、`2026-11-07.md` 0.2.0 席位盲化 + 0.3.0 试玩修正）。Cloud/用户级记忆不在此处，勿改写。本文档即交接权威来源。
