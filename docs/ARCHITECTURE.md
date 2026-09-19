# 架构说明 · Architecture

```
                       ┌──────────────────────────── 一台机器 ────────────────────────────┐
  玩家 A(手机/浏览器)  │                                                                  │
        │              │   Host(权威牌局)  ──校验每条动作──►  游戏规则(uno/doudizhu/…)     │
        │              │        │                                   │                     │
        │              │        └──► 每个座位一份 viewFor(seat) ◄─────┘                     │
        │              │                                                                  │
        └── WebSocket ─┼──► WsServer(src/engine/ws.js)                                    │
  玩家 B ──────────────┼──► 或 BridgeTransport(蓝牙) / 内存回环(测试)                     │
  玩家 C ──────────────┼──► 传输层可替换：规则核心不认识 WebSocket，只认识 Transport 接口   │
                       └──────────────────────────────────────────────────────────────────┘
```

## 分层

| 层 | 目录 | 职责 | 依赖 |
| --- | --- | --- | --- |
| 规则 | `src/games/` | 每个游戏的状态机：发牌、合法动作、组合判定、AI、`viewFor` | 只依赖 `engine/` 的牌组与错误类型 |
| 引擎 | `src/engine/` | 线协议、权威主机、客户端、注册表、传输抽象、回环、WebSocket | 零第三方依赖 |
| 联机 | `src/lan/` | 房间服务器（HTTP+WS）、UDP 自动发现、mod 装载 | Node 内置 `http/dgram/fs` |
| 桥接 | `src/bt/` | 安卓 WebView 的蓝牙桥（base64 ↔ 字节） | 浏览器 API（`btoa/atob`） |

**关键设计：传输与规则互不认识。** 规则核心只要求一个 `Transport`：

```js
class Transport {
  onMessage = null;    // (bytes: Uint8Array) => void
  onDisconnect = null; // () => void
  send(bytes) {}
  close() {}
}
```

局域网用 WebSocket、手机蓝牙用原生 RFCOMM + base64 桥、单元测试用内存回环——**同一份引擎、同一份协议**。

---

## 为什么是「服务器权威」

客户端**只发意图**，服务器逐条校验后再广播：

```
玩家: { t:'act', kind:'play', cardId:'c4-red-number3-6' }        ← 只是一个请求
主机: game.playCard(seat, cardId)  ← 抛错=非法;通过=改状态
主机: 对每个座位发送 { t:'state', view: game.viewFor(seat) }      ← 各自只看到自己该看的
```

于是：

- **不可能作弊**：手牌只发给本人（`viewFor`），客户端上报的任何"我赢了"都不被采信；
- **不可能不同步**：只有一份真实状态，所有人看到的是它的投影；
- **断线可恢复**：重连后重新 `join` 即可再拿一份视图。

`viewFor(seat)` 里只有**公共信息 + 本人手牌**——这是整个设计的核心约束。

---

## 线协议

`src/engine/protocol.js`：**4 字节大端长度 + UTF-8 JSON**，`FrameDecoder` 负责把任意切分的字节流还原成消息（蓝牙/WebSocket 都可能一次到半个包或多个包）。

玩家 → 主机：`join` / `act`（`start`、`play`、`draw`、`pass`、`uno`、`chat`、游戏自定义动作）
主机 → 玩家：`lobby`(座位表) / `state`(个性化视图) / `chat` / `error` / `bye`

新增动作只需在游戏的 `applyAction(seat, action)` 里加分支——协议本身**不需要改**。

---

## Game 接口（加游戏只看这个）

```js
export const game = {
  key: 'mygame', name: '我的游戏', card: 'MY', min: 2, max: 6,
  create: ({ playerNames, options, random }) => new MyGame(...),
  ai: (game, seat) => action | null,      // 可选：让机器人接管该座位
};

class MyGame {
  start() {}                       // 开局
  applyAction(seat, action) {}     // 校验并应用；非法就 throw GameError
  snapshot() {}                    // 公共状态
  viewFor(seat) {}                 // 该座位能看到的状态（含本人手牌）
  addPlayer(name) {}               // 大厅加人
}
```

把文件放进 `mods/` 也会被 `src/lan/mods.mjs` 自动注册（`/api/mods` 可列出、装卸）。

---

## 目录速览

```
src/engine/protocol.js   帧编解码 + 消息常量
src/engine/transport.js  传输契约
src/engine/host.js       权威房间：座位、校验、广播、断线处理、聊天
src/engine/client.js     玩家端薄封装
src/engine/games.js      注册表（内置 + mod）
src/engine/cards.js      牌组/洗牌/可复现随机（mulberry32，测试用）
src/engine/loopback.js   内存回环（测试、单机预览）
src/engine/ws.js         零依赖 RFC6455 服务端与客户端传输
src/lan/room.mjs         房间服务器（HTTP + /ws + /api/*）
src/lan/discovery.mjs    UDP 广播发现
src/lan/mods.mjs         mods/*.mjs 装载
src/bt/bridge.js         蓝牙桥（base64 ↔ 字节）
bin/serve.mjs            开房 CLI
bin/find.mjs             找房 CLI
test/e2e-lan.mjs         真 WebSocket 多客户端端到端
```

---

## 自校验

| 命令 | 覆盖 |
| --- | --- |
| `npm test` | 规则/协议/同步/蓝牙桥/发现的单元测试（单进程内运行，不 spawn 子进程） |
| `npm run test:e2e` | 真房间 + 真 WebSocket + 多客户端，把每个游戏打一局到出赢家 |

测试全部使用**可复现随机数**（`mulberry32`），所以失败可稳定复现；异步断言用 `test/helpers.mjs` 的 `waitFor` 等**条件**而不是死等固定毫秒，避免忙机器上的偶发失败。
