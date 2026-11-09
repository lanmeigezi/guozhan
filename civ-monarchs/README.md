# 群星君主 · 文明推演（civ-monarchs）

把 B 站视频【文明与地图】12 个大模型扮演君主谁能带领人类走向星际文明？里的玩法，做成**一个可分发、可直接跑、能对接 SillyTavern 的独立包**。

对接模式沿用上一次「AI 辅助国战模拟」的架构：**独立后端服务（单一权威状态） + SillyTavern 原生扩展 + 发布 zip**；确定性规则基线、LLM 只出高层意图、stateId/requestId 双闸、防提示注入、令牌只存内存等纪律全部保留。

---

## 0. 0.4.0 新增：离线单机 APK（2026-11-08）

群星君主现已作为**第 9 款游戏**做进桌游合集 APK：飞行模式下完整玩一局，无需 PC、无需服务器；愿意时可在「LLM 设置」填自己的 OpenAI 兼容端点与 Key，让指定席位由模型出意图。

| 项 | 值 |
|---|---|
| APK | `D:\酒馆游戏\release\桌游合集-guozhan-1.26.apk`（versionCode 28 / 1,178,911 B） |
| 入口 | APK 原生首屏「群星君主 · 单机」；桌面浏览器首页选「群星君主」→「本地对战」 |
| 实现 | `android/`（浏览器化 bundle + BrowserHost + UI + 3 套验收 + 壳工程备份） |
| 完整说明 | [`android/README.md`](android/README.md) |
| 命令 | `node android/build-bundle.mjs` → `node android/verify.mjs` → `node android/verify-ui.mjs` → `node android/verify-browser.mjs` → `node android/build-apk.mjs` |

要点：0.3.0 的 `src/` / `config/` / `web/` 一行未改；同步 sha256 让 PC 与手机存档双向兼容；席位身份、API Key 不落盘；`rules.ai`（并发 3 / 15s / 320 tokens）沿用，且只有显式点「让模型推演本回合」才联网；所有模型提示词经防注入包裹且不含席位身份。验收：核心 14/14、界面 8/8、真实 Chromium 全链路通过、原 33 项 + 桌游合集 139 项不回归。

---

## 1. 与视频 / 原项目的关系（先说清楚边界）

视频简介里 UP 主写明了还原该效果必需的两条改造：

> 1、将 api 重新封装成 mcp 或其他可以被 Harness 调用的形式，然后将内置 Agent SDK 替换成需要的 Harness
> 2、修改推演的规则（1.4.0 已和引擎层剥离），降低推演的强度，提高 DM 模型修改的权重

原项目 [guaner-334/civ-atlas](https://github.com/guaner-334/civ-atlas) 是一个 **AGPL-3.0、TypeScript/React、3.6 万球面地块**的浏览器端星球生成器，没有后端服务，AI 部分只是内置的 Agent SDK。

**本包不复刻、不内嵌、不分发该引擎的任何源码与素材**，而是做一个零依赖的「同玩法」轻量实现，并正面补齐上面两条改造：

| 视频 / 原项目的缺口 | 本包的做法 |
|---|---|
| 没有原生 MCP，Harness 接不进来 | 内置 `src/mcp/server.js`：stdio JSON-RPC 2.0 的 MCP 服务器，14 个工具把 REST API 1:1 映射出去，并带 `instructions` 操作纪律。酒馆、Claude、ChatGPT、WorkBuddy、自写 Agent 都能当 DM/君主 |
| 内置 Agent SDK 绑死 | `src/ai/adapter.js` 做成可替换适配器；`config/monarchs.json` 里 12 个席位可**分别绑定不同的 OpenAI 兼容模型**；未配 Key 的席位自动降级离线确定性君主 |
| 推演规则与引擎耦合、强度太高 | `config/rules.json` 独立成规则层：`simulation.strength`（默认 0.35，降低自然演化）与 `dm.weight`（默认 0.75，放大 DM 修正）两个旋钮，改 JSON 即生效，不动引擎代码。DM 干预类型沿用原引擎的 `boost / disaster / protect / ally / declare / cede / found / halt / unity / policy / treaty / unrest / keep / destroy` 命名，便于迁移 |
| 只有网页 | 四个入口：SillyTavern 扩展、内置网页客户端、MCP、纯聊天角色卡 + 世界书 |

如果你确实要接官方 civ-atlas 引擎（获得真实球面地图与编年史），见 [`docs/ENGINE-BRIDGE.md`](docs/ENGINE-BRIDGE.md)：那里给出引擎 API / 干预类型与本包命令的映射表与替换步骤。

---

## 2. 相比上一个「国战包」的改进

| 项 | 上一个包（guozhan） | 本包 |
|---|---|---|
| 运行依赖 | Node 24 + `npm ci` + tsup 构建 + dist | **零依赖、零构建**：Node ≥20，`node src/server/main.js` 直接跑，整包可拷贝到离线机器 |
| 协议同步 | `protocol.browser.js` 由构建脚本生成，需源码指纹闸门防漂移 | `/api/protocol` **运行时协商**：扩展不内置副本，改规则重启即同步 |
| 双向通信 | WebSocket（跨机需 wss + caddy） | **SSE**（标准 HTTP、对 NAT/手机后台更宽容，断线用 `from=offset` 补发） |
| AI 接入 | 单 AI 军师 | 12 个席位可各绑一个模型 + 可选 DM 模型，缺 Key 自动降级 |
| Harness | 仅酒馆扩展 | 酒馆 + 网页 + **原生 MCP** + 角色卡/世界书 |
| 入口 | 扩展 + 网页 | 扩展 + 网页 + MCP + **纯聊天也能玩**（14 张卡 + 世界书） |
| 规则可调 | 配置化兵种/战斗公式 | 额外把「推演强度 / DM 权重」做成一等旋钮，直接对应视频的改造 2 |
| 席位 | 需凑齐玩家才能开局 | **默认 12 席全人机托管，缺人也能开**；人类随时凭 seat token 接管；席位身份对任何模型不可见（0.2.0 新增） |
| 实测驱动修正 | — | 0.3.0 用 3 个子代理真实试玩 2 回合，据结果修掉文风聚类泄漏、开局一击亡国、并发下令 409 摩擦 |

保留下来的：单一权威核心、确定性引擎（种子 RNG 状态可序列化）、LLM 零数值裁决、CAS + 幂等、视角信息隔离、拒绝码由服务端给出、防提示注入包裹、令牌只存内存、默认 opt-in。

---

## 3. 快速开始（30 秒）

```bash
cd civ-monarchs
node src/server/main.js            # 默认 http://127.0.0.1:8790
```

浏览器打开 `http://127.0.0.1:8790/` 就是自带客户端，点「连接」即可。默认房间 `room-1`、DM 全知视角、12 个离线君主，**不需要任何 API Key 就能完整推演**。

一键验收：

```bash
npm run verify     # 33 项测试（含席位盲化 / 试玩回归）+ 端到端 smoke
npm run pack       # 生成 3 个发布 zip 与 SHA256SUMS
```

---

## 4. 四个入口

### A. SillyTavern 扩展（主入口）
把 `extensions/sillytavern-civ-monarchs/` 打包成 zip → 酒馆「安装扩展」，或直接拷进 `data/default-user/extensions/`。填 seat token 即以人类席位下令，填房主管理令牌可在面板里把任意席位设为「人类 / 人机」。详见 [扩展 README](extensions/sillytavern-civ-monarchs/README.md)。

### B. 网页客户端
服务自带，无需额外进程：`http://127.0.0.1:8790/`。

### C. MCP（任意 Harness 当 DM）
```bash
npm start                    # 终端 1
npm run mcp                  # 终端 2，或被 MCP 客户端直接拉起
```
MCP 客户端配置示例见 `mcp-client.example.json`。★该通道刻意**不提供任何可读取席位分配的工具**，创建房间得到的席位凭证也只写入进程日志给人类房主，不回传给模型：
```json
{
  "mcpServers": {
    "civ-monarchs": {
      "command": "node",
      "args": ["D:/酒馆游戏/civ-monarchs/src/mcp/server.js"],
      "env": { "CIV_API_BASE": "http://127.0.0.1:8790", "CIV_ROOM_ID": "room-1", "CIV_TOKEN": "" }
    }
  }
}
```

### D. 纯聊天（角色卡 + 世界书）
导入 `cards/` 里的 DM 卡、12 张君主卡与世界书，不需要后端即可跑叙事版推演。详见 [cards/README.md](cards/README.md)。**该模式不产生权威数值**。

---

## 5. 玩法与规则

- 一张 8×6 = 48 州的星球地图（东西环形相连），12 个文明各据两州（首都 + 一邻州）起家；一次攻城不会直接亡国。同种子逐位可复现。
- 纪元前 3000 年起，每 25 年一回合，最多 120 回合。
- 每位君主每回合提交 **一条意图**：`invest / research / expand / attack / diplomacy / fortify / stabilize / colonize`，可带强度 1–3 与一句台词。资源、战斗、时代、胜负全部由引擎裁决。
- 时代阶梯：部落 → 城邦 → 王国 → 帝国 → 工业 → 信息 → 太空 → 星际（科技阈值 0/60/160/300/480/660/820/1000）。
- 胜利：率先进入「星际」且拥有 ≥2 处外星殖民地；打满回合则按综合分判胜。
- 结算顺序：**君主意图 → DM 修正 → 自然演化 → 时代跃迁 → 胜负 → 编年史**。

改 `config/rules.json` 即可调整全部数值；改 `config/world.json` 换种子或地形分布；改 `config/monarchs.json` 换 12 个席位的人格与模型。

---

## 6. 席位：人机托管、人类接管与身份盲化

**问题**：12 个席位凑不齐人就没法开局；而一旦标明某国是「玩家」还是「电脑」，模型的行为与叙事就会失真。0.2.0 把这两件事一起解决。

| 角色 | 谁在决策 | 谁能看到分配 |
|---|---|---|
| 人机席位（默认） | 确定性君主 / 可选外部模型 | 只有人类房主 |
| 人类席位 | 真人凭 seat token 在扩展 / 网页 / MCP 下令 | 只有人类房主 |
| 房主（管理） | 不下令，只设置席位、查看诊断 | — |

`config/seats.json` 默认：

```json
{ "defaultControl": "ai", "humanSeats": [], "policy": "auto", "autoFill": true, "blindSeats": true }
```

- **默认全人机**：启动后不提交任何意图也能直接结算，12 国每回合都有举动。
- **人类接管**：`POST /api/rooms` 返回每国一枚 `seatTokens`，填进扩展/网页的 Bearer 令牌即成为该国人类席位；或由房主在管理面板把某国设为 `human`。
- **未下令策略** `policy`：`auto`（默认，人机临时补一条，行为与其他国家一致，不卡开局）/ `wait`（阻塞推进等真人）/ `skip`（留空，会暴露空缺，不建议用于盲局）。
- **房主管理令牌**：创建房间返回一次性 `adminToken`（默认房间在启动时打印到控制台），通过 `X-Admin-Token` 头调用 `/seats`。**绝不转发给任何模型、不要写进角色卡或世界书**。

### 盲化的五道保障（重点）

1. **敏感数据不进权威状态**：`control / claimed / model / modelLabel / adapter / apiKeyEnv` 只存在房间层；`state.civs` 用白名单构造，快照再白名单裁剪一次。
2. **行为一致 + 文体一致**：结算前 `ensureDecisions` 为所有未下令的存活文明补位，模型看到的永远是「十二国皆有举动」；**所有席位（人类 / 人机 / 外部模型）的台词在落库前由 `src/core/voice.js` 以同一确定性生成器、用史官笔法重写**，原始 note 不落库、不进编年史、不进存档。这是 0.3.0 试玩后补的：原先人机用固定短句池、人类写个性化台词，编年史里立刻形成可聚类的「套语组 vs 个性化组」。`submitted`（谁已提交）字段被彻底删除。
3. **通道全脱敏**：快照不给 DM 视角的 `decisions` 内容；事件流不带席位名单、提交数量、补位数量、模型席位数量；编年史、战报、存档、`/auto` 回执、幂等缓存同样无身份信息。
4. **管理视图隔离**：`/seats`、`/models`、`/auto` 诊断仅房主可见；MCP **不提供任何可读取席位分配的工具**，`civ_new_game` 把凭证写到 stderr 而不是回传模型。
5. **提示词纪律**：君主 / DM 系统提示词、MCP `instructions`、12 张君主卡、DM 卡、世界书、战报注入包裹都明确禁止推测、询问或暗示控制者身份。

`tests/blindness.test.js` 逐通道做正则回归，`npm run verify` 会跑这套检查。

### 0.3.0 试玩实测（3 个子代理 · 2 回合）

以 3 个独立子代理各持一枚 seat token 扮演人类君主、其余 9 席人机托管，真实跑了两回合。结论：**能玩**，且三个代理都没能判断其他席位由谁控制。但暴露三个问题，均已修复并加回归测试：

| 试玩发现 | 影响 | 修复 |
|---|---|---|
| 编年史里 8 国台词是 4 句套语各复用 2 次、另 4 国个性化；三个代理都做出「模板组 8 国 / 个性化组 4 国」的风格聚类，而 3 个人类席位恰好有 3 个落在后者 | 文风分组成为身份的间接线索 | `src/core/voice.js` 对所有席位统一润色，组合空间约 864；实测 12/12 台词唯一 |
| 人类席位青岚第 1 回合被一次攻城打掉唯一州，直接 `CIV_ELIMINATED`，第 2 回合无法下令 | 开局即出局 | 开局每国两州；实测首回合 12/12 存活 |
| 3 席并发下令时 2 个收到 `409 STALE_REVISION`（`stateId` 含决策队列，任一席位提交都会换版本） | 多人同回合下令反复重试 | `stateId` 不再包含同回合决策队列，仅随局面 / 回合推进变化；实测 3 席并发全 200、0 次 409 |

复测数据：个性化原文 0 条进编年史、身份标记 0 条、12 国台词全唯一、首回合 12 国存活、并发无 CAS 冲突。

## 7. 把 12 个席位接成真正的大模型

`config/monarchs.json` 每个席位：

```json
{
  "id": "civ-01", "modelLabel": "DeepSeek",
  "model": { "adapter": "deterministic", "model": "", "apiKeyEnv": "CIV_MODEL_01_KEY" }
}
```

把 `adapter` 改成 `"openai"`、`model` 填真实模型 ID（如 `deepseek-chat`），并设置环境变量 `CIV_MODEL_01_KEY=sk-...`（可选 `CIV_MODEL_01_BASE_URL` 覆盖默认端点）。每个席位可用不同厂商，正是视频的「12 个大模型」。

- 顶层 `defaults.baseUrl` 是默认 OpenAI 兼容端点，可整体换成任意网关。
- ★`modelLabel` / `model` / `adapter` 属于**房主管理信息**：模型绑定从 `config/monarchs.json` 读取，不写入权威状态，也不会出现在快照、编年史、战报、存档或任何提示词里。给某席位绑模型不会让对局中任何一方察觉。
- 缺 Key / 缺模型 ID / 超时 / 输出不合法 JSON → 该席位自动降级离线君主，**推演不中断**。
- `rules.ai` 控制并发（默认 3）、单席超时（15s）、单席 token 上限（320）。
- 可选 DM 模型：`CIV_DM_KEY` + `CIV_DM_MODEL`（+ `CIV_DM_BASE_URL`），在 `/auto?includeDm=true` 时主动提交修正。
- 成本估算见 [`docs/COST.md`](docs/COST.md)。

查看当前 12 席状态：`GET /api/rooms/room-1/models`（不返回任何 Key）。

---

## 8. API 速查

| 用途 | 端点 |
|---|---|
| 健康 / 协议 | `GET /api/health`、`GET /api/protocol` |
| 房间 | `GET/POST /api/rooms`（`withSeats:true` 返回 12 个席位令牌，仅此一次） |
| 快照 / 布局 / 合法动作 | `GET /api/rooms/{id}/snapshot?seat=`、`/layout`、`/actions?seat=` |
| 提交意图 / DM 修正 | `POST /api/rooms/{id}/decisions`、`/dm` → `{stateId, requestId, decisions/edits[]}` |
| 结算 / 自动推演 | `POST /api/rooms/{id}/advance`、`/auto` |
| 编年史 / 战报 / 模型 | `GET /api/rooms/{id}/chronicle?from=`、`/report`、`/models` |
| 事件流 | `GET /api/rooms/{id}/events?from=latest`（SSE，`from=<offset>` 断线补发） |
| 存档 | `GET /api/rooms/{id}/save`、`POST /api/rooms/{id}/load`、`POST /reset` |
| 席位管理（房主专用） | `GET/POST /api/rooms/{id}/seats`、`GET /models`，均需 `X-Admin-Token` 头 |
| 本席位 | `GET /api/rooms/{id}/my-seat`（只回答自己，不给全局分布） |

写操作必须带最近一次读到的 `stateId`（409 `STALE_REVISION` 时重新拉快照），并建议带 `requestId` 幂等键。**同一回合内多个席位并发提交不会互相使 `stateId` 失效**；只有局面变化或回合推进后才需要重新取快照。

---

## 9. 部署与安全

环境变量（见 `.env.example`）：

| 变量 | 说明 |
|---|---|
| `CIV_PORT` / `CIV_HOST` | 默认 `8790` / `127.0.0.1` |
| `CIV_TOKEN` | 设置后所有 API 需要 `Authorization: Bearer`；未设置仅适合本机/可信内网 |
| `CIV_ORIGINS` | 逗号分隔的 Origin 白名单（酒馆页面地址必须包含） |
| `CIV_API_BASE` / `CIV_ROOM_ID` | MCP 侧连接目标 |

`deploy/` 提供 Dockerfile、compose（非 root、只读根文件系统、端口只绑回环）与 Caddy 反代示例。

安全边界：默认 opt-in 零流量；令牌（含房主管理令牌）只存页面内存；`pagehide` 抹除；席位令牌做视角隔离；**席位身份对任何模型不可见**（见第 6 节）；战报注入带 `[群星编年 · 游戏数据开始/结束]` 包裹；服务端文本一律 `textContent` 渲染；命令拒绝原因以服务端拒绝码为准。

---

## 10. 目录结构

```
config/        rules.json / monarchs.json / world.json / seats.json（改这里，不改代码）
src/core/      RNG / 地图 / 命令闸门 / 确定性引擎 / 状态与存档 / seats.js 席位控制与补位 / voice.js 史官统一润色
src/ai/        模型适配器 / 提示词契约 / 12 席并发编排 / DM 模型
src/server/    零依赖 HTTP + SSE + 房间与鉴权（管理视图隔离）
src/mcp/       原生 MCP（stdio JSON-RPC，无席位读取工具）
extensions/    SillyTavern 原生扩展（含房主席位管理面板）
cards/         DM 卡 + 12 君主卡 + 世界书（含席位盲化常驻条目）
web/           自带网页客户端（含创建房间与席位管理）
tests/         node:test 确定性 / API / MCP 契约 / blindness 反泄漏回归
scripts/       gen-cards / smoke / pack
deploy/        Docker / compose / Caddy
docs/          引擎桥接说明 / 成本控制
```

---

## 11. 许可与致谢

- 本包代码为 MIT，**不包含 `civ-atlas` 的任何源码、字体、图像或素材**；原项目为 AGPL-3.0，若你把官方引擎接进来，请遵守其许可证。
- 玩法灵感来自 B 站视频 BV1onxb6rEeE（UP 主「再改需求是修勾」）与 [civ-atlas](https://github.com/guaner-334/civ-atlas)。
- 架构纪律参考上一轮「AI 辅助国战模拟」包，以及 `tavern-battle-mcp` 的 CAS/幂等/防提示注入做法。
