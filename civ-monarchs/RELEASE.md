# 群星君主 0.4.0 · 发布说明

**生成日期**：2026-11-08　**运行环境**：Node.js ≥ 20（后端包）/ Android 5.0+（离线单机 APK）　**依赖**：无（不执行 `npm ci`，也不联网）

## 0.4.0 新增：离线单机 APK

按 `HANDOFF.md` §8.1.1 路径 B，把群星君主做成桌游合集 APK 的第 9 款游戏。0.3.0 的后端 / 扩展 / 卡片 / 网页源码一行未改。

| 项 | 值 |
|---|---|
| 成品 | `D:\酒馆游戏\release\桌游合集-guozhan-1.26.apk`（1,178,911 B，versionCode 28，debug 签名） |
| 同版副本 | `D:\酒馆游戏\apk\桌游合集-1.26-debug.apk` |
| 校验和 | `D:\酒馆游戏\release\civ-monarchs-apk-1.26-SHA256SUMS.txt`；APK SHA256 `c648ee1ae2dac3ced391ef75e3f58185f79d10d0fd78467c8ec0921edde126a8` |
| 源码 | `android/`（bundle 生成器、BrowserHost、UI、3 套验收、壳工程备份）、`board-games/app/src/main/assets/www/` |
| 说明 | `android/README.md` |
| 一键复现 | `node android/build-bundle.mjs && node android/verify.mjs && node android/verify-ui.mjs && node android/verify-browser.mjs && node android/build-apk.mjs` |

验收：核心 14/14、界面 8/8、真实 Chromium `file://` 全链路通过；`apksigner verify` 通过、APK 内 6 个资源逐字节一致；0.3.0 的 33 项测试 + smoke 与桌游合集 139 项均不回归。飞行模式实测推进 12 回合（时代跃迁、0 次网络请求）并跑到第 120 回合判胜。

`npm run pack` 现在产出 **0.4.0** 三个 zip；旧的 0.3.0 包保持不动。

## 三个包（0.3.0 起的 Node 后端包，仍然适用）

| 文件 | 用途 | 装法 |
|---|---|---|
| `civ-monarchs-0.4.0-YYYYMMDD.zip` | 完整发布包：后端、扩展、卡片、网页、**离线单机 APK 源码**、文档、测试、部署 | 解压到任意目录，`node civ-monarchs-0.4.0/src/server/main.js` |
| `sillytavern-civ-monarchs-0.4.0.zip` | 纯 SillyTavern 扩展（zip 根目录就是 `manifest.json`） | 酒馆 → 扩展面板 → 安装扩展 → 选 zip |
| `civ-monarchs-cards-0.4.0.zip` | DM 卡 + 12 张君主卡 + 世界书 | 酒馆角色管理 / 世界书管理 → 导入 JSON |

`SHA256SUMS.txt` 给出三个包的校验和；`PACKAGE-MANIFEST.txt` 列出主包内容。校验：

```bash
sha256sum -c SHA256SUMS.txt
```

主包**不含** `node_modules`、`.git`、`.env`、任何 API Key、运行时存档与日志。配置样例是 `.env.example`。

## 部署流程

1. 解压主包，进入 `civ-monarchs-0.4.0/`。
2. `node src/server/main.js` → `http://127.0.0.1:8790/`，网页客户端点「连接」即可玩（无需 Key）。
3. 酒馆：安装扩展 zip → 扩展设置里填 `http://<服务器>:8790`、房间 `room-1`、Bearer 令牌 → 连接。
4. 跨机：设 `CIV_TOKEN` 与 `CIV_ORIGINS`（必须包含酒馆页面 Origin），用 `deploy/` 的 compose + Caddy 上 HTTPS；SSE 的 `?token=` 会进反代日志，请脱敏。
5. MCP：把 `mcp-client.example.json` 的 `mcpServers` 合并到客户端配置；或 `npm run mcp` 手动拉起。
6. 想让 12 个席位分别接真实大模型：改 `config/monarchs.json`（`adapter: "openai"` + 模型 ID），并设 `CIV_MODEL_XX_KEY`；详见 README 第 7 节。
7. **缺人也能开**：默认 12 席全人机托管，无需任何配置即可结算。要让人类接管，用网页「创建房间并领取凭证」拿到 `seatTokens`，把对应令牌填进酒馆/网页的 Bearer 字段；房主用 `adminToken`（`X-Admin-Token`）在管理面板调整席位。`config/seats.json` 控制默认分配与未下令策略。

## 验收

```bash
npm run verify                     # 33 项测试 + 端到端 smoke（Node 后端）
npm run pack                       # 重新生成三个 0.4.0 zip
node android/verify.mjs            # 离线单机核心 14 项
node android/verify-ui.mjs         # 前端界面 8 项
node android/verify-browser.mjs    # 真实 Chromium file:// 全链路
node android/build-apk.mjs         # 一键出 APK 1.26 + 签名/资源校验
```

## 本版做了什么

- **0.4.0 · 离线单机 APK**：作为桌游合集第 9 款游戏进入 `桌游合集-guozhan-1.26.apk`（1.26 修复终局按钮：phase==='ended' 时结算/推演按钮置灰）。浏览器化 bundle（13 模块 / 同步 sha256 shim / config 内嵌）、BrowserHost 内存调用替代 REST+SSE、8 页签触屏 UI、localStorage 存档、自接 LLM（Android 走原生 HTTPS 通道绕开 CORS）+ 四类降级、席位盲化不落盘。详见 `android/README.md`。
- **0.3.0 · 子代理试玩驱动修正**：3 个独立子代理各扮一位人类君主、实跑 2 回合，结论「能玩且身份盲化成立」，但发现并修掉三项：① 史官统一润色所有席位台词（`src/core/voice.js`），消除「套语组 vs 个性化组」的文风聚类泄漏；② 开局每国两州，避免一次攻城即 `CIV_ELIMINATED`；③ `stateId` 不再包含同回合决策队列，消除多席位并发下令的 409 摩擦。复测：并发 3 席全 200、12 国台词全唯一、个性化原文 0 条入编年史、首回合 12/12 存活。
- **0.2.0 新增 · 人机席位 + 席位盲化**：默认 12 席全人机托管、缺人即可开局；人类凭 seat token 接管；房主管理令牌可设置 human/ai。控制者身份与模型绑定只存在房间层，不进权威状态、快照、事件流、编年史、战报、存档、提示词或 MCP 工具输出。结算前自动补位保证「十二国皆有举动」，行为层也无法反推。新增 `tests/blindness.test.js` 逐通道回归。
- 把视频的两条改造要求落地：原生 MCP 服务器（14 个工具 + 操作纪律 instructions）替换内置 Agent SDK；规则与引擎剥离，`simulation.strength` / `dm.weight` 两个旋钮可调。
- 12 个君主席位可分别绑定不同 OpenAI 兼容模型，缺 Key / 超时 / 输出不合法自动降级离线君主。
- 四个入口：SillyTavern 扩展（SSE + 运行时协议协商）、自带网页客户端、MCP、纯聊天角色卡 + 世界书。
- 确定性引擎：种子 RNG 状态可序列化、存档逐位复现、视角信息隔离；LLM 零数值裁决。
- 安全边界：CAS `stateId` + 幂等 `requestId`、拒绝码由服务端给出、令牌只存内存、防提示注入包裹、`textContent` 渲染。

## 已知限制

- 离线单机 APK 未在真实 Android 设备 / 模拟器上回归（本机无设备）；已在同引擎 Chromium headless `file://` 跑通全链路，APK 签名与资源逐字节校验通过。真实 LLM 端点调用也用 mock 验证，未接真实 Key。
- 地图是 48 州网格，**不是**官方 civ-atlas 的 3.6 万球面地块；需要真实球面地图/王朝世系请按 `docs/ENGINE-BRIDGE.md` 替换引擎层。
- 扩展按 SillyTavern 1.12+ 扩展 API 编写，不同分支的 DOM 锚点可能漂移（找不到 `#extensions_settings2` 时降级挂 `body`）；未在全版本真实酒馆回归。
- SSE 令牌走查询参数（浏览器 EventSource 限制），跨机必须 HTTPS 反代且日志脱敏。
- 纯聊天角色卡只做叙事，不产生权威数值。
- `seats.policy = wait` 会阻塞推进直到真人下令（房主可见等待名单），`skip` 会留下空缺从而可能被间接推断，盲局请用默认的 `auto`。
- 君主提交的原始台词由史官统一润色后写入编年史，玩家原文只在本次 HTTP 回执中出现、不落库。这是 0.3.0 为消除文风聚类泄漏做的取舍。
- 未配置 Key 时 12 席均为离线确定性君主；「12 个大模型同台」需要自行配置端点与 Key。

## 许可

本包代码 MIT；不含 `civ-atlas` 的任何源码与素材。官方项目为 AGPL-3.0，接入并分发时请遵守其许可证。玩法灵感来自 B 站 BV1onxb6rEeE。
