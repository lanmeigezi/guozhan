// save-state.test.js — 对局存档 / 恢复核心层的测试。
//
// 重点不是「没抛错」，而是两条硬证据：
//   1. 恢复后的引擎状态与存档那一刻**逐项相等**（整份状态规范化 JSON + 各引擎关键字段清单）。
//   2. 恢复后继续打的 N 步与「同 seed 一口气打完」**完全一致**（确定性）。
// 为了做到第 2 点，测试用的是「进度可外部读写的可重放 RNG」：引擎的 random 是个有状态
// 闭包，跨 Host 实例无法传递进度，只有把调用计数对齐才能严格比对两条路径。
//
// ⚠️ 这里同时验证安全边界：快照是上帝视角数据，restoreRoom 绝不接受/写入任何令牌字段。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../src/host.js';
import { GameError } from '../src/game-error.js';
import { SAVE_VERSION, captureRoom, restoreRoom } from '../src/save-state.js';

// ---- 可重放 RNG：值 = f(seed, 第 n 次调用)，进度挂在 fn.state.calls 上 ----
function testRandom(seed) {
  const state = { calls: 0 };
  const fn = () => {
    let t = (seed ^ Math.imul(state.calls + 1, 0x9e3779b1)) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x2545ff49) >>> 0;
    t = Math.imul(t ^ (t >>> 13), 0x27d4eb2f) >>> 0;
    state.calls += 1;
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
  fn.state = state;
  return fn;
}

// ---- 建房：seat0 是本机玩家，其余是本地 AI；remote:false 避免 setTimeout 链吊住进程 ----
function buildHost(gameKey, names, random, options) {
  const host = new Host({ game: gameKey, playerName: names[0], remote: false, random, options: options || {} });
  for (const name of names.slice(1)) assert.notEqual(host.addBot(name), null, `addBot(${name}) 失败`);
  assert.equal(host.game.players.length, names.length);
  return host;
}

function startHost(host) {
  const started = host.startGame();
  assert.equal(started.ok, true, '开局失败');
}

// ---- 逐步推进：每个座位都交给注册表里的 AI 决策，走 Host.execute 这条唯一权威路径 ----
function stepOnce(host) {
  const g = host.game;
  if (g.phase !== 'playing' && g.phase !== 'bidding') return false;
  const seat = host.activeSeat();
  if (seat == null) return false;
  const act = host.ai(seat);
  if (!act) return false;
  return host.execute(seat, { kind: act.kind, ...act }).ok === true;
}

function runSteps(host, n) {
  let done = 0;
  for (let i = 0; i < n; i++) {
    if (!stepOnce(host)) break;
    done += 1;
  }
  return done;
}

// ---- 规范化 JSON（键排序），用于整份引擎状态的逐字节比对 ----
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function stateOf(host) {
  return stable(captureRoom(host).game);
}

/**
 * 把结构里的「字符串 id」按首次出现顺序换成 c0/c1/… 再比对。
 * 只给炸弹猫用：exploding.js 的 mk() 用**模块级自增计数器**发牌 id，
 * 同一进程里后建的局必然拿到另一批号码 —— 这是引擎的发牌实现，不是存档 bug。
 * 首现顺序遍历（数组按序、对象按键名排序）在两条路径上完全相同，
 * 所以规范化后依旧能抓到「两张牌在手牌里换了位置」这类真实错位。
 */
function canonIds(value) {
  const rank = new Map();
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (k === 'id' && typeof v.id === 'string') {
          if (!rank.has(v.id)) rank.set(v.id, 'c' + rank.size);
          out.id = rank.get(v.id);
        } else {
          out[k] = walk(v[k]);
        }
      }
      return out;
    }
    return v;
  };
  return stable(walk(value));
}

// ---- 各引擎的关键字段清单：手牌 / 牌堆顺序 / 回合 / 当前玩家 / 现金 / 地产等 ----
function keyFields(gameKey, host) {
  const g = host.game;
  const ids = (arr) => (arr || []).map((c) => c.id);
  switch (gameKey) {
    case 'uno':
      return {
        phase: g.phase, current: g.current, color: g.color, direction: g.direction,
        turnState: g.turnState, drawnCardId: g.drawnCardId, winner: g.winner,
        hands: g.players.map((p) => ids(p.hand)), counts: g.players.map((p) => p.hand.length),
        drawPile: ids(g.drawPile), discard: ids(g.discard),
        unoAnnounced: g.players.map((p) => p.unoAnnounced), opts: { ...g.opts },
      };
    case 'doudizhu':
      return {
        phase: g.phase, current: g.current, landlord: g.landlord, winner: g.winner,
        hands: g.players.map((p) => ids(p.hand)), drawLeft: g.diPai.map((c) => c.id),
        lastPlay: g.lastPlay ? { seat: g.lastPlay.seat, cards: ids(g.lastPlay.cards), combo: g.lastPlay.combo.type } : null,
        passCount: g.passCount, bidScores: g.bidScores.slice(), opts: { ...g.opts },
      };
    case 'exploding':
      // 这里刻意保留 {id} 对象而不是 id 字符串：炸弹猫要按 canonIds() 规范化比对，
      // 而 canonIds 只改写对象上的 id 键。
      return {
        phase: g.phase, current: g.current, winner: g.winner,
        hands: g.players.map((p) => p.hand.map((c) => ({ id: c.id }))), alive: g.players.map((p) => p.alive),
        extraDraws: g.players.map((p) => p.attack || 0),
        drawPile: g.drawPile.map((c) => ({ id: c.id })), discard: g.discard.map((c) => ({ id: c.id })),
        pendingDefuse: g.pendingDefuse ? { seat: g.pendingDefuse.seat, card: { id: g.pendingDefuse.card.id } } : null,
        pendingFavor: g.pendingFavor ? { ...g.pendingFavor } : null,
        seeTop: g.seeTop ? { seat: g.seeTop.seat, top: g.seeTop.top.slice() } : null, opts: { ...g.opts },
      };
    case 'monopoly':
      return {
        phase: g.phase, current: g.current, winner: g.winner, endReason: g.endReason,
        turnCount: g.turnCount, roll: g.roll ? { ...g.roll } : null, pending: g.pending ? { ...g.pending } : null,
        cash: g.players.map((p) => p.cash), pos: g.players.map((p) => p.pos),
        inJail: g.players.map((p) => p.inJail), bankrupt: g.players.map((p) => p.bankrupt),
        owners: g.properties.map((p) => p.ownerId), houses: g.properties.map((p) => p.houses),
        log: g.log.slice(),
      };
    case 'liarsbar':
      return {
        phase: g.phase, current: g.current, winner: g.winner, targetRank: g.targetRank,
        hands: g.players.map((p) => ids(p.hand)), alive: g.players.map((p) => p.alive),
        shots: g.players.map((p) => p.shots), bulletAt: g.players.map((p) => p.bulletAt),
        claimsThisRound: g.claimsThisRound, emptyHandSeats: g.emptyHandSeats.slice(),
        lastClaim: g.lastClaim ? { seat: g.lastClaim.seat, ids: ids(g.lastClaim.cards), claimedRank: g.lastClaim.claimedRank } : null,
        pendingRoulette: g.pendingRoulette ? { ...g.pendingRoulette } : null,
        pendingShots: g.pendingShots ? g.pendingShots.map((s) => ({ ...s })) : null,
        pendingDesignate: g.pendingDesignate, drawPile: ids(g.drawPile || []),
      };
    default:
      throw new Error('未登记的关键字段清单：' + gameKey);
  }
}

/**
 * 一款游戏的完整存档回归：
 *   参考路径（同 seed 一口气打，最多 cap 步，中途可能自然打完）
 *   vs 中断路径（打 splitAt 步 → 存档 → JSON 往返 → 新建同 gameKey 的 Host → 恢复
 *     → 再补参考路径剩下的步数），两条路径必须逐步、逐字节一致。
 */
function assertSaveRestoreDeterminism({ gameKey, names, seed, splitAt, cap, idInsensitive = false }) {
  // 与「不中断」那条路径比对时，炸弹猫要用 id 规范化（牌 id 带模块级自增号）
  const cmp = idInsensitive
    ? (x, y) => assert.equal(canonIds(captureRoom(x).game), canonIds(captureRoom(y).game))
    : (x, y) => assert.equal(stateOf(x), stateOf(y));
  const cmpFields = idInsensitive
    ? (x, y) => assert.deepEqual(canonIds(keyFields(gameKey, x)), canonIds(keyFields(gameKey, y)))
    : (x, y) => assert.deepEqual(keyFields(gameKey, x), keyFields(gameKey, y));
  // 1) 参考：不间断
  const ref = buildHost(gameKey, names, testRandom(seed));
  startHost(ref);
  const refSteps = runSteps(ref, cap);
  assert.ok(refSteps > splitAt + 4, `${gameKey} 只走了 ${refSteps} 步，中局存档点 ${splitAt} 太晚`);

  // 2) 中断 → 存档
  const randA = testRandom(seed);
  const a = buildHost(gameKey, names, randA);
  startHost(a);
  assert.equal(runSteps(a, splitAt), splitAt, `${gameKey} 没能推进到中局`);
  assert.ok(['playing', 'bidding'].includes(a.game.phase), `${gameKey} 存档时应仍在中局`);
  const payload = captureRoom(a);
  // 客户端就是走 localStorage：先做一次真实的 JSON 往返
  const wire = JSON.parse(JSON.stringify(payload));
  assert.equal(wire.v, SAVE_VERSION);
  assert.equal(wire.gameKey, gameKey);
  assert.ok(typeof wire.capturedAt === 'number' && wire.capturedAt > 0);

  // 3) 新建同 gameKey 的 Host 并恢复（RNG 进度对齐到存档那一刻）
  const randB = testRandom(seed);
  const b = buildHost(gameKey, names, randB);
  randB.state.calls = randA.state.calls;
  const info = b.restoreSave(wire);
  assert.equal(info.ok, true);
  assert.equal(info.gameKey, gameKey);
  assert.equal(info.seats, names.length);

  // 3a) 恢复瞬间：整份引擎状态 + 关键字段逐项相等
  assert.equal(stateOf(b), stateOf(a), `${gameKey} 恢复后的引擎状态与存档时刻不一致`);
  assert.deepEqual(keyFields(gameKey, b), keyFields(gameKey, a), `${gameKey} 恢复后的关键字段不一致`);

  // 3b) 原型/方法/脱敏视图都还在（Object.assign 写回而不是换实例）
  assert.equal(Object.getPrototypeOf(b.game).constructor.name, Object.getPrototypeOf(a.game).constructor.name);
  assert.equal(typeof b.game.applyAction, 'function');
  assert.equal(b.game.n, names.length, '引擎 getter 仍在原型上');
  assert.ok(b.game.viewFor(0), '恢复后仍能出脱敏视图');

  // 3c) random 重新注入：沿用 host.gameRandom
  assert.equal(b.game.random, randB, '恢复后必须用 host.gameRandom 重新注入 random');
  assert.equal(typeof b.game.random, 'function');

  // 3d) Host 层字段一致（_matchId 由 execute 用 Math.random 现造，不参与比对）
  const hostA = captureRoom(a).host;
  const hostB = captureRoom(b).host;
  delete hostA.matchId;
  delete hostB.matchId;
  assert.deepEqual(hostB, hostA, `${gameKey} 的 Host 层字段没有完整还原`);
  assert.deepEqual([...b.botSeats], [...a.botSeats]);
  assert.deepEqual([...b.llmSeats], []);
  assert.equal(b._actionSeq, a._actionSeq);
  assert.equal(b.localSeat, a.localSeat);
  assert.ok(b._idleTimer === null && b._botTimer == null && b._llmTimer == null, '恢复不该起任何定时器');
  assert.equal(b.guests.size, 0, '恢复不该造出任何传输');

  // 4) 继续推进参考路径剩下的步数：与不中断的那条路径逐字节一致 —— 确定性的硬证据
  assert.equal(runSteps(b, refSteps - splitAt), refSteps - splitAt, `${gameKey} 恢复后没能补齐剩余步数`);
  cmp(b, ref);
  cmpFields(b, ref);
}

test('存档/恢复 · UNO：中局存档 → 新 Host 恢复 → 继续打与不中断完全一致', () => {
  assertSaveRestoreDeterminism({ gameKey: 'uno', names: ['甲', '乙', '丙', '丁'], seed: 11, splitAt: 20, cap: 90 });
});

test('存档/恢复 · 斗地主：叫分/底牌/桌面牌组都能还原', () => {
  assertSaveRestoreDeterminism({ gameKey: 'doudizhu', names: ['甲', '乙', '丙'], seed: 23, splitAt: 15, cap: 60 });
});

test('存档/恢复 · 炸弹猫：牌堆顺序 / 存活 / 附加抽都能还原', () => {
  // idInsensitive=true：牌 id 带模块级自增号，跨实例号码不可比，见 canonIds() 注释
  assertSaveRestoreDeterminism({ gameKey: 'exploding', names: ['甲', '乙', '丙'], seed: 31, splitAt: 10, cap: 60, idInsensitive: true });
});

test('存档/恢复 · 大富翁：现金 / 位置 / 地产归属 / 回合数都能还原', () => {
  assertSaveRestoreDeterminism({ gameKey: 'monopoly', names: ['甲', '乙', '丙'], seed: 37, splitAt: 22, cap: 140 });
});

test('存档/恢复 · 骗子酒馆：弹仓 / 手牌 / 轮询射击队列都能还原', () => {
  assertSaveRestoreDeterminism({ gameKey: 'liarsbar', names: ['甲', '乙', '丙'], seed: 43, splitAt: 6, cap: 40 });
});

test('存档/恢复 · 未注入 random 的 Host：恢复时回落到 Math.random', () => {
  const src = buildHost('uno', ['甲', '乙'], testRandom(5));
  startHost(src);
  runSteps(src, 6);
  const payload = JSON.parse(JSON.stringify(captureRoom(src)));
  const plain = new Host({ game: 'uno', playerName: '甲', remote: false });
  plain.addBot('乙');
  plain.restoreSave(payload);
  assert.equal(plain.gameRandom, undefined);
  assert.equal(plain.game.random, Math.random, '没有 gameRandom 时必须注入 Math.random');
  assert.equal(typeof plain.game.viewFor(0).hand.length, 'number');
});

test('captureSave 是 Host 上的薄封装，与 captureRoom(host) 内容一致', () => {
  const host = buildHost('uno', ['甲', '乙', '丙'], testRandom(9));
  startHost(host);
  runSteps(host, 7);
  const viaHost = host.captureSave();
  const viaFn = captureRoom(host);
  assert.equal(stable(viaHost.game), stable(viaFn.game));
  assert.deepEqual({ ...viaHost.host, capturedAt: 0 }, { ...viaFn.host, capturedAt: 0 });
  assert.equal(viaHost.gameName, 'UNO');
  assert.equal(viaHost.phase, 'playing');
  // 快照里绝不残留 random（函数不可 JSON 化），且整份对象可直接 JSON.stringify
  assert.equal('random' in viaHost.game, false);
  assert.doesNotThrow(() => JSON.stringify(viaHost));
});

// ---------------------------------------------------------------------------
// 负例：一律抛 GameError，且 Host 保持原状（不存在半恢复）
// ---------------------------------------------------------------------------
function negCase(mutate, expectedCode) {
  const src = buildHost('uno', ['甲', '乙'], testRandom(3));
  startHost(src);
  runSteps(src, 8);
  const payload = JSON.parse(JSON.stringify(captureRoom(src)));
  const target = buildHost('uno', ['甲', '乙'], testRandom(3));
  startHost(target);
  runSteps(target, 5);
  const beforeState = stateOf(target);
  const beforeSeq = target._actionSeq;
  const beforeSeats = [...target.botSeats];
  mutate(payload);
  assert.throws(
    () => target.restoreSave(payload),
    (err) => err instanceof GameError && err.code === expectedCode,
    `期望抛 GameError(${expectedCode})`
  );
  // 原状保持不变
  assert.equal(stateOf(target), beforeState, '失败后引擎状态被改动了');
  assert.equal(target._actionSeq, beforeSeq, '失败后 Host 运行时字段被改动了');
  assert.deepEqual([...target.botSeats], beforeSeats);
  // 目标 Host 之后仍然能正常继续打
  assert.ok(stepOnce(target), '失败的恢复不能把 Host 打断');
  return target;
}

test('负例 · 版本不匹配 → SAVE_VERSION，Host 原状', () => {
  negCase((p) => { p.v = SAVE_VERSION + 1; }, 'SAVE_VERSION');
  negCase((p) => { delete p.v; }, 'SAVE_VERSION');
});

test('负例 · gameKey 不匹配 → SAVE_GAME_KEY，Host 原状', () => {
  const src = buildHost('uno', ['甲', '乙'], testRandom(3));
  startHost(src);
  runSteps(src, 6);
  const payload = JSON.parse(JSON.stringify(captureRoom(src)));
  const target = buildHost('doudizhu', ['甲', '乙', '丙'], testRandom(3));
  startHost(target);
  const before = stateOf(target);
  assert.throws(
    () => target.restoreSave(payload),
    (err) => err instanceof GameError && err.code === 'SAVE_GAME_KEY'
  );
  assert.equal(stateOf(target), before);
  assert.equal(target.game.players.length, 3);
});

test('负例 · payload 里塞函数 / Symbol / undefined / NaN → SAVE_NOT_PLAIN', () => {
  negCase((p) => { p.game.injected = () => 1; }, 'SAVE_NOT_PLAIN');
  negCase((p) => { p.game.players[0].evil = () => 1; }, 'SAVE_NOT_PLAIN'); // 嵌套也要拒绝，不许悄悄剔除
  negCase((p) => { p.game.injected = undefined; }, 'SAVE_NOT_PLAIN');
  negCase((p) => { p.game.players[0].evil = undefined; }, 'SAVE_NOT_PLAIN');
  negCase((p) => { p.game.players[0].hand[0] = undefined; }, 'SAVE_NOT_PLAIN'); // 数组元素不能剔除
  negCase((p) => { p.game.players[0].hand[0] = () => 1; }, 'SAVE_NOT_PLAIN');
  negCase((p) => { p.game.current = NaN; }, 'SAVE_NOT_PLAIN');
  negCase((p) => { p.game.current = Infinity; }, 'SAVE_NOT_PLAIN');
  negCase((p) => { p.game.players[0].evil = Symbol('x'); }, 'SAVE_NOT_PLAIN');
  negCase((p) => { p.game.players[0].when = new Date(); }, 'SAVE_NOT_PLAIN'); // Date 会变 ISO 字符串，类型丢失
  negCase((p) => { p.game.players[0].bag = new Set([1, 2]); }, 'SAVE_NOT_PLAIN');
});

test('负例 · 结构非法（不是对象 / 缺段 / 座位越界 / 名字数对不上）→ SAVE_INVALID', () => {
  negCase((p) => { p.game = null; }, 'SAVE_INVALID');
  negCase((p) => { p.host = null; }, 'SAVE_INVALID');
  negCase((p) => { p.host.botSeats = [99]; }, 'SAVE_INVALID');
  negCase((p) => { p.host.localSeat = 7; }, 'SAVE_INVALID');
  negCase((p) => { p.host.nextGuestId = 0; }, 'SAVE_INVALID');
  negCase((p) => { p.host.playerNames = ['甲']; }, 'SAVE_INVALID');
  negCase((p) => { p.host.chatLog = ['不是对象']; }, 'SAVE_INVALID');
  negCase((p) => { delete p.game.phase; }, 'SAVE_INVALID');
  const host = buildHost('uno', ['甲', '乙'], testRandom(4));
  startHost(host);
  const payload = JSON.parse(JSON.stringify(captureRoom(host)));
  assert.throws(() => restoreRoom(host, null), (e) => e instanceof GameError && e.code === 'SAVE_INVALID');
  assert.throws(() => restoreRoom(host, [payload]), (e) => e instanceof GameError && e.code === 'SAVE_INVALID');
  assert.throws(() => restoreRoom(null, payload), (e) => e instanceof GameError && e.code === 'SAVE_INVALID');
});

test('安全边界 · 令牌样字段：既不写进 Host，也不写进引擎，capture 也从不记录', () => {
  const src = buildHost('uno', ['甲', '乙'], testRandom(6));
  startHost(src);
  runSteps(src, 5);
  // 引擎上被人挂了个 token，capture 必须把它剔掉
  src.game.botToken = 'super-secret';
  src.game.accessToken = 'abc';
  const payload = JSON.parse(JSON.stringify(captureRoom(src)));
  assert.equal('botToken' in payload.game, false, 'token 类字段绝不能进快照');
  assert.equal('accessToken' in payload.game, false);
  delete src.game.botToken;
  delete src.game.accessToken;

  // 攻击者在档里塞各种 token
  payload.token = 'host-token';
  payload.host.token = 'host-token';
  payload.host.accessToken = 'x';
  payload.game.token = 'game-token';
  payload.game.players[0].token = 'hand-token';
  payload.game.players[0].sessionSecret = 'y';
  payload.game.discard[0].api_key = 'z';
  payload.host.remote = true; // 模式也不接受回灌

  const target = buildHost('uno', ['甲', '乙'], testRandom(6));
  startHost(target);
  runSteps(target, 5);
  const info = target.restoreSave(payload);
  assert.equal(info.ok, true, '带令牌的档应该被正常恢复，只是忽略令牌');
  for (const bad of ['token', 'accessToken', 'sessionSecret', 'api_key', 'botToken']) {
    assert.equal(bad in target, false, `Host 上不得出现 ${bad}`);
    assert.equal(bad in target.game, false, `引擎上不得出现 ${bad}`);
    for (const p of target.game.players) assert.equal(bad in p, false);
    for (const c of target.game.discard) assert.equal(bad in c, false);
  }
  assert.equal(target.remote, false, 'remote 由调用方构造时决定，恢复不写回');
  // 恢复后仍能正常打
  assert.ok(stepOnce(target));
});

test('安全边界 · captureRoom 只吐纯数据，不含函数/传输/回调', () => {
  const host = buildHost('uno', ['甲', '乙'], testRandom(8));
  startHost(host);
  runSteps(host, 4);
  host.chatLog.push({ from: '甲', text: '随便聊聊' });
  const payload = captureRoom(host);
  const text = JSON.stringify(payload);
  assert.equal(text.includes('onLocalUpdate'), false, '回调不应进快照');
  assert.equal(text.includes('guests'), false, '传输句柄不应进快照');
  assert.deepEqual(payload.host.chatLog, [{ from: '甲', text: '随便聊聊' }]);
  assert.deepEqual(payload.host.botSeats, [1], 'botSeats 要转成普通数组');
  assert.ok(Array.isArray(payload.host.botSeats));
  assert.ok(Array.isArray(payload.host.llmSeats));
});

test('通用深拷贝搞不定的引擎：国战（session 是类实例）→ 明确抛 SAVE_UNSUPPORTED', () => {
  const host = new Host({ game: 'guozhan', playerName: '甲', remote: false });
  host.addBot('乙');
  assert.equal(host.startGame().ok, true);
  assert.equal(host.game.phase, 'playing');
  assert.throws(
    () => host.captureSave(),
    (err) => err instanceof GameError && err.code === 'SAVE_UNSUPPORTED' && /类实例/.test(err.message),
    '国战必须报错，而不是产出一份残废的存档'
  );
});

test('客户端「继续上局」最省事的接法：空 Host 直接灌档，不用先重建座位', () => {
  const src = buildHost('uno', ['甲', '乙'], testRandom(21));
  startHost(src);
  runSteps(src, 7);
  src.chatLog.push({ from: '乙', text: '再来' });
  const wire = JSON.parse(JSON.stringify(src.captureSave()));

  // 只有 gameKey + random 的裸 Host：players 为空、localSeat 为 null
  const bare = new Host({ game: 'uno', remote: false, random: testRandom(99) });
  assert.equal(bare.game.players.length, 0);
  assert.equal(bare.localSeat, null);
  const info = bare.restoreSave(wire);
  assert.equal(info.ok, true);
  assert.equal(info.seats, 2);
  assert.deepEqual(info.playerNames, ['甲', '乙']);
  // 玩家、机器人座位、本地座位、聊天全部从档里还原
  assert.equal(bare.game.players.length, 2);
  assert.equal(bare.localSeat, 0);
  assert.deepEqual([...bare.botSeats], [1]);
  assert.deepEqual(bare.chatLog, [{ from: '乙', text: '再来' }]);
  assert.equal(stateOf(bare), stateOf(src), '空 Host 也要能一比一还原');
  // 恢复后本机玩家（seat0）能直接接着打
  const seat = bare.activeSeat();
  const act = bare.ai(seat);
  assert.equal(bare.execute(seat, { kind: act.kind, ...act }).ok, true);
});

test('lobby 阶段也能存档/恢复（客户端可能在对局开始前就退出）', () => {
  const src = buildHost('exploding', ['甲', '乙', '丙'], testRandom(13));
  const wire = JSON.parse(JSON.stringify(src.captureSave()));
  assert.equal(wire.phase, 'lobby');
  const bare = new Host({ game: 'exploding', remote: false, random: testRandom(14) });
  const info = bare.restoreSave(wire);
  assert.equal(info.ok, true);
  assert.equal(info.phase, 'lobby');
  assert.deepEqual([...bare.botSeats], [1, 2]);
  assert.equal(bare.game.players.length, 3);
  assert.equal(bare.startGame().ok, true, '恢复完的 lobby 应该能正常开局');
});

test('前向兼容 · 引擎新增的数据字段保留默认值，僵尸函数字段被清掉', () => {
  const src = buildHost('uno', ['甲', '乙'], testRandom(2));
  startHost(src);
  runSteps(src, 4);
  const wire = JSON.parse(JSON.stringify(src.captureSave()));
  const target = buildHost('uno', ['甲', '乙'], testRandom(2));
  startHost(target);
  runSteps(target, 4);
  // 模拟「新版本引擎多了一个字段 / 实例上挂着旧回调」
  target.game.newEraFeature = { mortgaged: false, count: 0 };
  target.game.staleHook = () => '僵尸引用';
  target.restoreSave(wire);
  assert.deepEqual(target.game.newEraFeature, { mortgaged: false, count: 0 }, '快照里没有的新数据字段不能被删成 undefined');
  assert.equal('staleHook' in target.game, false, '残留的回调闭包必须清掉');
  assert.equal(typeof target.game.random, 'function');
  assert.equal(target.game.staleHook, undefined);
});

test('恢复后本地玩家仍可正常操作（play/draw 走同一条 execute 权威路径）', () => {
  const src = buildHost('uno', ['甲', '乙'], testRandom(17));
  startHost(src);
  runSteps(src, 9);
  const payload = JSON.parse(JSON.stringify(src.captureSave()));
  const host = buildHost('uno', ['甲', '乙'], testRandom(17));
  startHost(host);
  host.restoreSave(payload);
  const seat = host.activeSeat();
  const act = host.ai(seat);
  const r = host.execute(seat, { kind: act.kind, ...act });
  assert.equal(r.ok, true);
  assert.equal(host._actionSeq, payload.host.actionSeq + 1);
  assert.ok(host.game.viewFor(0).hand.length >= 1);
});
