# mods/ — 玩家自定义游戏

这个目录里的每个 `*.mjs` 都会被房间服务器自动加载并注册成一个可玩的游戏。

```js
// mods/mygame.mjs
import { GameError } from '../src/engine/game-error.js';
import { shuffle, mulberry32 } from '../src/engine/cards.js';

class MyGame {
  constructor({ playerNames = [], random } = {}) { /* … */ }
  start() { /* 开局，返回 snapshot() */ }
  applyAction(seat, action) { /* 校验并应用；非法就 throw new GameError('CODE', '说明') */ }
  snapshot() { /* 公共状态 */ }
  viewFor(seat) { /* 该座位能看到的状态：公共信息 + 本人手牌 */ }
  addPlayer(name) { /* 大厅加人 */ }
}

// 导出一个 game 定义（或 export default），Host 就能托管它：
export const game = {
  key: 'mygame',
  name: '我的游戏',
  card: 'MY',          // 大厅卡片上的短标签
  min: 2, max: 6,
  create: ({ playerNames, options, random }) => new MyGame({ playerNames, options, random }),
  ai: (game, seat) => null,   // 可选：机器人接管该座位时返回动作
};
```

要点：

- **`key` 必须唯一**，且不能与内置游戏重名（`uno` / `doudizhu` / `exploding` / `liarsbar` / `grab21`）。
- 只依赖 `src/engine/`，**不要**依赖 Node 专有模块——同一个文件可能在浏览器里跑。
- `applyAction` 里的一切校验都要**抛错**（`GameError`），服务器只认「抛错=非法」，不要返回 `false` 之类的软失败。

装载与装卸：

```bash
node bin/serve.mjs                 # 启动时自动加载 mods/*.mjs
curl localhost:8766/api/mods       # 已装游戏 + 目录里的文件
curl -X POST localhost:8766/api/mods/reload          # 重新扫描
curl -X DELETE localhost:8766/api/mods/mygame        # 移出启用目录（对局中会拒绝）
curl -X POST localhost:8766/api/mods/enable/mygame   # 移回并重载
```

移除的 mod 会被移动到 `mods/disabled/`（已在 `.gitignore` 里），随时可以启用回来——
这样"卸载"是持久的，不会在重启后被无条件重新加载。
