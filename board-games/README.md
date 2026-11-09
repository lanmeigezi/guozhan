# 桌游合集（board-games）

从 UNO-BT / 桌游合集 APK 抽出的零依赖房间服务与 Web 前端，随 guozhan 包一起交付。

- 游戏：UNO、斗地主、炸弹猫、骗子酒馆、国战、大富翁、狼人杀（Web 版 / 房间服务）
- **群星君主（第 9 款，仅 APK 离线单机）**：不进房间服务，直接在 Android WebView 内跑确定性引擎；详见 `../civ-monarchs/android/README.md`
- 服务端权威房间：WebSocket `/ws`，静态页面 `/`
- 可选多个服务端 LLM 玩家位（0–7，受游戏人数上限约束）：`LLM_API_KEY` / `LLM_BASE_URL`（或 `LLM_API_BASE`）/ `LLM_MODEL`
- 无需 npm install，也不需要 Android 工程

## 启动

```bash
cd board-games
node server/server.mjs 8766 uno
```

打开 `http://<主机>:8766/`。首页可选游戏；第一个加入房间的玩家所带游戏会决定房间游戏。**一个进程 = 一个房间**；需要多桌时用不同 `BOARD_GAMES_PORT` 启动多个实例。默认房间游戏可由启动参数或 `BOARD_GAMES_DEFAULT_GAME` 指定。

服务端 LLM 席位示例：

```bash
LLM_API_KEY=sk-... LLM_BASE_URL=https://api.deepseek.com/v1 LLM_MODEL=deepseek-chat \
  node server/server.mjs 8766 uno
```

浏览器/手机只看到“LLM 玩家位”开关，API key 不下发。未配置 key 时隐藏该开关。房主可以用 `＋/－` 添加多个 LLM 座位；狼人杀里每个 LLM 座位会收到只属于自己角色的夜间信息，并在白天公开发言、参与投票。**注意：任何房主都能添加 LLM 席位，公网部署请限制访问并评估模型额度消耗。**

## 积分榜

- 首页「🏆 积分榜」：**我的积分**按设备 localStorage 统计，包含本地、蓝牙与在线真人局；连接房间服务器时还会出现**本服榜**。
- 积分公式：基础分 × 人数系数 × 时长系数 × 真人系数 × 胜负系数；只给真人计分，AI/LLM 只计入人数。胜/平/负 = ×1 / ×0.4 / ×0.1，段位从新手到王者。
- 服务端把每局真人成绩追加到 `data/leaderboard.jsonl`（可用 `BOARD_GAMES_DATA_DIR` 指定目录），设备号只以 SHA-256 截断哈希落盘；`/api/leaderboard?range=today|week|all&limit=50` 提供聚合榜。
- 一个进程=一个房间，但同一数据目录可以被多个房间进程共享；文件是 append-only JSONL，读取时按 event id 去重。

## 群星君主（APK 离线单机）

`app/src/main/assets/www/` 里的 `civ-core.bundle.js` + `civ-ui.js` 是第 9 款游戏，由 `../civ-monarchs/android/build-bundle.mjs` 生成 / 同步，`index.html` 与 `app.js` 只做入口与渲染分发。它**不参与**房间服务、WebSocket、蓝牙与积分榜，也不需要 Node 后端。

- 飞行模式完整可玩；`localStorage` 自动存档（可导出 / 导入 JSON）。
- 自接 LLM 可选：`baseUrl/model/apiKey` 只存内存；Android 走原生 `civLlmChat` 绕开 `file://` 的 CORS，桌面浏览器回退 `fetch`；四类故障自动降级。
- 席位身份不落盘，提示词、快照、编年史、战报、存档均不含身份字段。
- 一键出包与校验：`node ../civ-monarchs/android/build-apk.mjs`（同步 6 个 www 文件 → gradle → 签名与逐字节核对 → `release/桌游合集-guozhan-1.26.apk`）。

## 验证

```bash
node core/test/run-all.mjs
node scripts/verify-bundle.cjs
node server/verify-socket.mjs
cd ../civ-monarchs && node android/verify.mjs && node android/verify-ui.mjs && node android/verify-browser.mjs
```

## 与 guozhan 包的关系

- guozhan 仍使用自己的 8788 端口与酒馆扩展。
- 桌游合集使用独立端口（默认 8766），由 `scripts/start-board-games.mjs` 启动。
- 酒馆扩展的“桌游合集”入口默认指向 `http://127.0.0.1:8766/`；远程部署请填公网/反代地址。
