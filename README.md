# 桌游合集 · Tabletop Games

> A zero-dependency, **server-authoritative** tabletop game collection with a pure-JS rules core and
> **LAN multiplayer** (WebSocket room + UDP auto-discovery). Five games ship in the box:
> **UNO · 斗地主 · 炸弹猫 · 骗子酒馆 · 抢21**.
> 零依赖、纯 JavaScript 的联机桌游合集：规则核心与网络完全解耦，同一份代码在 Node 和浏览器/WebView 里都能跑。

---

## 为什么值得一看 / Why

- **零依赖**：没有 `npm install`，只用 Node 内置模块（`node:http` / `node:dgram` / `node:crypto`）。克隆下来就能跑。
- **权威主机（server-authoritative）**：只有服务器持有真实牌局状态。客户端只发**意图**（"我要出这张牌"），服务器按规则校验后再给每个座位广播**个性化视图**（自己的手牌 + 公共信息）——所以**不可能作弊，也不可能各端不同步**。
- **传输无关**：规则核心只认一个 `Transport` 接口。局域网用 WebSocket、手机蓝牙用 Native 桥、单元测试用内存回环——**同一份引擎**。
- **每个游戏自带 AI**，可以单人开一局看效果。
- **UDP 自动发现**：同一局域网里玩家不用抄 IP，一条命令就能列出所有房间。

---

## 快速开始

```bash
git clone <this-repo> && cd tabletop-games
node --version        # 需要 Node >= 18

# 1) 主机开一局（默认 UNO，端口 8766）
npm run serve
#    或指定游戏/端口：
node bin/serve.mjs 9000 doudizhu

# 2) 同一局域网的其他玩家：自动找房间（不用记 IP）
npm run find
#    Found 1 room(s):
#      uno room @ 192.168.1.20
#        game    : uno  (1/8 players)
#        join ws : ws://192.168.1.20:8766/ws
#        open    : http://192.168.1.20:8766/
```

拿到 `ws://…` 后，用任意 WebSocket 客户端按下面的协议接入即可（仓库里的 `Client` 类已经写好了）。

---

## 五个游戏

| key | 名称 | 人数 | 说明 |
| --- | --- | --- | --- |
| `uno` | UNO | 2–8 | 经典 UNO，含 +2/+4、变色、UNO 报牌 |
| `doudizhu` | 斗地主 | 3 | 叫地主 + 完整牌型（顺子/连对/飞机/三带/炸弹/王炸），AI 会组多张牌、农民不压队友 |
| `exploding` | 炸弹猫 | 2–5 | 抽牌躲炸弹；攻击牌、恩惠牌、同色猫偷牌、两张洗混重置、拆弹选放回位置 |
| `liarsbar` | 骗子酒馆 | 3–5 | 吹牛+揭穿；输了要用六膛左轮**开枪**（俄罗斯轮盘） |
| `grab21` | 抢21 | 2–6 | 轮流累加点数，凑到 21 获胜，超过归零 |

---

## 局域网联机是怎么做的

```
         ┌──────────────── 主机（node bin/serve.mjs）────────────────┐
         │  Host（权威牌局）  ←→  WsServer（RFC6455，零依赖）        │
         │        ▲                        ▲                        │
         │        │  UDP:8767  发现应答     │  TCP:8766  /ws         │
         └────────┼────────────────────────┼────────────────────────┘
                  │                        │
        玩家A: discoverRooms() ────────────┘
              拿到 ws://…/ws → WebSocket → Client → 只发意图、收自己的视图
```

- **房间服务器** `src/lan/room.mjs`：HTTP（`/api/room` 加入信息、`/api/mods` 游戏列表、静态页）+ WebSocket（`/ws` 协议）。
- **自动发现** `src/lan/discovery.mjs`：主机在 UDP 8767 应答探测包，玩家广播一次探测即可列出所有房间。
- **一行代码开房**：

```js
import { startLanRoom, findRooms } from './src/lan/index.mjs';

const room = await startLanRoom({ game: 'doudizhu', port: 8766 });
console.log(room.lanWsUrl);       // ws://192.168.x.x:8766/ws
// 玩家侧
const rooms = await findRooms();  // [{ name, game, ws, players, max }]
```

细节与排障见 [`docs/LAN.md`](docs/LAN.md)。

---

## 目录结构

```
tabletop-games/
├─ src/
│  ├─ index.js            公开入口（浏览器安全，零依赖）
│  ├─ engine/             传输无关的机器：协议、权威主机、客户端、游戏注册表
│  │   ├─ protocol.js     线协议：4 字节长度前缀 + JSON 分帧
│  │   ├─ transport.js    Transport 契约（send/close/onMessage/onDisconnect）
│  │   ├─ host.js         权威房间：校验动作、广播个性化视图
│  │   ├─ client.js       玩家端薄封装
│  │   ├─ games.js        游戏注册表（内置 + mod）
│  │   ├─ cards.js        牌组 / 洗牌 / 可复现随机数
│  │   ├─ loopback.js     内存回环传输（测试/单机预览）
│  │   └─ ws.js           零依赖 RFC6455 WebSocket 服务端/客户端传输
│  ├─ games/              五个规则引擎（各自独立，只依赖 engine）
│  ├─ lan/                局域网联机模块：room.mjs + discovery.mjs + mods.mjs
│  └─ bt/                 安卓 WebView 蓝牙桥（把原生字节包成 Transport）
├─ bin/                   serve.mjs（开房） · find.mjs（找房）
├─ test/                  node:test 单元测试 + e2e-lan.mjs（真 WebSocket 多客户端对局）
└─ docs/                  架构说明 · 局域网指南
```

---

## 加一个自己的游戏

游戏只要满足 `Game` 接口，就能被主机托管、被 AI 托管、被联机分发：

```js
export const game = {
  key: 'mygame', name: '我的游戏', card: 'MY', min: 2, max: 6,
  create: ({ playerNames, options, random }) => new MyGame({ playerNames, options, random }),
  ai: (game, seat) => ({ kind: 'play', cardId }) | null,   // 可选
};

// 类需要实现：
//   start()                      开局
//   applyAction(seat, action)    应用并校验一个动作（非法就抛 GameError）
//   snapshot()                   公共状态
//   viewFor(seat)                某个座位的个性化视图（含自己的手牌）
//   addPlayer(name)              大厅加人
```

把文件放进 `mods/` 目录也会被自动注册（见 `src/lan/mods.mjs`，`/api/mods` 可列出/装卸）。

---

## 测试与自校验

```bash
npm test          # 全部单元测试（规则 / 协议 / 同步 / 蓝牙桥 / 发现）—— 单进程内跑，不 spawn
npm run test:e2e  # 端到端：真起房间 + 真 WebSocket + 多客户端把 4 个游戏各打一局到出结果
```

`test/e2e-lan.mjs` 会为每个游戏创建一个真实房间、接入多个 `Client`、用各游戏自带的 AI 驱动整局，并断言「正常结束且只剩一个赢家」——这是对**规则 + 协议 + 服务器 + 客户端**的联合验证。

---

## License

[MIT](LICENSE) © 2024 UNO-BT contributors
