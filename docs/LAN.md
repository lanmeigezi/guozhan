# 局域网联机指南 · LAN play

同一局域网（同一个 Wi-Fi / 交换机）里，一个人开房，其他人一条命令就能找到房间。
不需要账号、不需要服务器、不需要公网。

---

## 1. 主机开房

```bash
node bin/serve.mjs                       # UNO，端口 8766，并在局域网广播
node bin/serve.mjs 9000 doudizhu         # 斗地主，端口 9000
node bin/serve.mjs --no-announce         # 关闭 UDP 广播（只用地址加入）
node bin/serve.mjs --discovery-port 8767 # 自定义发现端口
```

启动后终端会打印：

```
  斗地主 room is up  (game=doudizhu, 3-3 players)
  ─────────────────────────────────────────────────────────
  LAN address : http://192.168.1.20:8766/
  WebSocket   : ws://192.168.1.20:8766/ws
  discovery   : answering UDP probes on port 8767 — players run: node bin/find.mjs
```

> 把 `LAN address` 或 `WebSocket` 发给人也行——**不依赖发现功能**。

---

## 2. 其他玩家加入

**方式 A：自动发现（推荐）**

```bash
node bin/find.mjs
```

```
Found 1 room(s):

  doudizhu room @ 192.168.1.20
    game    : doudizhu  (1/3 players)
    join ws : ws://192.168.1.20:8766/ws
    open    : http://192.168.1.20:8766/
    from    : 192.168.1.20
```

**方式 B：直接用地址**——把主机的 `ws://…:8766/ws` 填进任何 WebSocket 客户端。

**方式 C：浏览器打开**主机的 `LAN address`（`/` 会返回状态页；把 UI 放进仓库的 `web/` 目录就会改成托管你的页面）。

代码里加入：

```js
import { Client } from './src/engine/client.js';
import { WsClientTransport } from './src/engine/ws.js';

const ws = new WebSocket('ws://192.168.1.20:8766/ws');
await new Promise((r) => ws.addEventListener('open', r));

const client = new Client({ transport: new WsClientTransport(ws) });
client.onMessage = (m) => render(m);     // lobby / state / chat / error
client.join('我的昵称');
// 需要时：client.send({ t:'act', kind:'play', cardId }) / client.send({ t:'chat', text })
```

---

## 3. 服务器接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/room` | 加入信息：`{ game, http, ws, room, players, max, phase }` |
| GET | `/api/mods` | 已装游戏列表（含 `builtin` 标记）+ `mods/` 目录文件 |
| POST | `/api/mods/reload` | 重新扫描 `mods/` |
| DELETE | `/api/mods/<key>` | 把某个 mod 移出启用目录（**对局中禁止**） |
| POST | `/api/mods/enable/<key>` | 移回并重载 |
| WS | `/ws` | 游戏协议（见 `src/engine/protocol.js`） |

所有响应都带 `Access-Control-Allow-Origin: *`，因此从浏览器/WebView（`file://` 页面）也能直接 fetch。

---

## 4. 发现协议（UDP）

一条 JSON 一个报文，带版本号，便于将来演进：

```
探测  →  广播  { "t": "TTG_DISCOVER", "v": 1 }            发往 UDP 8767
应答  ←  单播  { "t": "TTG_ROOM", "v": 1,
                 "name": "doudizhu room @ 192.168.1.20",
                 "game": "doudizhu", "ws": "ws://…/ws",
                 "http": "http://…/", "players": 1, "max": 3 }
```

- 默认广播到每个网卡的**子网广播地址** + `255.255.255.255`。
- 主机侧 `info` 可以是**函数**，所以每次应答都反映**实时人数**。
- 收不到应答也不影响游戏——直接填地址即可。
- 想自己实现客户端：`createAnnouncer()` / `discoverRooms()`（见 `src/lan/discovery.mjs`），
  或直接调 `startLanRoom({ game, port })` 一行开房。

---

## 5. 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| `find` 说没房间 | 主机是不是加了 `--no-announce`？两台机器在同一网段吗？用 `--target <主机IP>` 单播试一次 |
| 单播能通、广播不通 | 路由器/AP 开了「客户端隔离」或拦了广播；改用直接填地址 |
| 端口被占 | 换端口：`node bin/serve.mjs 9000`；UDP 发现端口也冲突就 `--discovery-port 8768` |
| 防火墙 | 放行 Node 的 **TCP 8766**（游戏）与 **UDP 8767**（发现）；只放 TCP 也能玩，只是不能自动发现 |
| 想跨公网 | 本项目只做局域网。跨网请自行用反向隧道/端口映射把 TCP 暴露出去，并把公网地址当作主机地址填 |

---

## 6. 安全边界

- 服务器**只接受玩家意图**并逐条按规则校验；它不执行客户端传来的代码，也不信任客户端上报的状态。
- 没有任何鉴权：**同网段任何人都能加入**——这是局域网派对游戏的默认预期；需要私密房间请自行加口令/隧道。
- `WebSocket` 明文（`ws://`），仅适合局域网或可信网络。
