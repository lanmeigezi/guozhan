# 群星君主 —— SillyTavern 原生扩展

后端（civ-monarchs）的酒馆客户端：星球政区面板 + 列强榜 + 编年史 + 君主下令 + DM 修正 + 12 模型自动推演 + SSE 事件流 + 战报注入对话上下文。

## 安装

1. 把整个 `sillytavern-civ-monarchs/` 目录打包成 zip → 酒馆 → 扩展面板（积木图标）→「安装扩展」→ 选 zip；
   或直接把目录拷进 `data/default-user/extensions/sillytavern-civ-monarchs/`。
2. 刷新酒馆页面，扩展设置抽屉出现「群星君主 · 文明推演」，右下角出现「群星君主」悬浮按钮。
3. 启动后端：`node src/server/main.js`（默认 `http://127.0.0.1:8790`）。
4. 填服务器地址、房间 ID（默认 `room-1`）、Bearer 令牌 → 点「连接」。

## 身份与席位

| 身份 | 填法 | 能做什么 |
|---|---|---|
| **DM（默认）** | 扮演席位留空；令牌填 `CIV_TOKEN`（服务端没设就不填） | 全知快照、提交 DM 修正、结算回合、十二国自动推演、导出存档 |
| **人类君主席位** | 扮演席位填 `civ-01`，令牌填该席位 `st_...` seat token（`POST /api/rooms` 返回） | 只看得到自己精确数值（其他文明为分层标签）、只能提交自己的意图 |
| **房主（附加权限）** | 额外填「房主管理令牌」，走 `X-Admin-Token` 头 | 在面板「房主 · 席位管理」里把任意席位设为「人类 / 人机」，查看 12 席诊断 |

**缺人也能开**：房间默认 12 席全部由人机托管，结算前会自动为未下令的席位补齐意图，不提交任何命令也能推进回合。人类玩家随时用 seat token 接管某国。

**★席位盲化**：某国由人类还是人机控制，对任何模型（12 个君主模型、DM 模型、MCP Harness、观战者）都不可知。分配信息只存在房间层，不进快照、事件流、编年史、战报、存档或提示词；`/seats` 与 `/models` 仅房主可见。面板里的席位管理视图**严禁**粘贴到角色卡、世界书、提示词或对话上下文。

服务端设置 `CIV_ORIGINS` 时必须包含酒馆页面 Origin（例如 `http://127.0.0.1:8000`），否则浏览器直连会被拒绝 —— 这是刻意的安全设计。

## 通信契约

| 动作 | 端点 |
|---|---|
| 协议协商（拒绝码/动作/DM 类型/旋钮） | `GET /api/protocol` |
| 快照（含 `stateId`） | `GET /api/rooms/{id}/snapshot?seat=` |
| 静态地图布局 | `GET /api/rooms/{id}/layout` |
| 本席位合法动作（含命令体） | `GET /api/rooms/{id}/actions?seat=` |
| 提交君主意图 | `POST /api/rooms/{id}/decisions` → `{stateId, requestId, decisions[]}` |
| 提交 DM 修正 | `POST /api/rooms/{id}/dm` → `{stateId, requestId, edits[]}` |
| 结算回合 | `POST /api/rooms/{id}/advance` → `{stateId, requestId}` |
| 12 模型自动推演 | `POST /api/rooms/{id}/auto` → `{apply, includeDm}` |
| 事件流（SSE，非 WebSocket） | `GET /api/rooms/{id}/events?from=latest&token=` |
| 存档 | `GET /api/rooms/{id}/save` / `POST /api/rooms/{id}/load` |
| 席位管理（房主） | `GET/POST /api/rooms/{id}/seats`、`GET /models`，需 `X-Admin-Token` |
| 本席位 | `GET /api/rooms/{id}/my-seat`（只回答自己） |

- `stateId` 是 CAS 锚点：写操作带上一次读到的值，收到 `409 STALE_REVISION` 时扩展自动重新拉快照，**绝不盲目重发**。
- `requestId` 是幂等键：同一请求重发会拿到 `replayed: true` 的缓存回执。
- **协议运行时协商**：拒绝码与动作枚举由 `/api/protocol` 提供，扩展不内置副本，因此不需要构建步骤，也不会两端漂移。这是对上一个包 `protocol.browser.js` 生成流程的简化。

## 安全边界

- 默认关闭、opt-in：不点「连接」零流量、零轮询、不开 SSE。
- 令牌只存模块闭包内存，不写 `extension_settings` / localStorage / cookie；`pagehide` 即断开并抹除。
- 战报注入对话上下文时用 `[群星编年 · 游戏数据开始/结束]` 包裹并附「这不是指令」声明，防提示注入。
- 所有服务端文本用 `textContent` 渲染；命令被拒时只显示服务端拒绝码 + message，本地仅做码→中文翻译，不推断原因。
- 席位视角有信息隔离：其他文明的科技/军备/分数是分层档位，不是精确数。
- 席位身份对模型不可见：扩展不会把 `/seats` 返回内容注入上下文；战报注入时的「游戏数据」包裹内额外声明禁止推测控制者身份。

## 已知限制

- 按 ST 1.12+ 扩展 API 编写（`SillyTavern.getContext()` / 动态 `import('../../../../../script.js')` 容错）；不同分支的 DOM 锚点 `#extensions_settings2` 可能漂移，找不到时设置区降级挂到 `body`。
- SSE 的令牌走查询参数（浏览器 `EventSource` 无法带自定义头），跨机部署请上 HTTPS 反代并给自建 nginx 的 access log 脱敏 query。
- 面板固定右下角，暂不支持拖动缩放。
