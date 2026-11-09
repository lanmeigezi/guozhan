/**
 * 确定性 RNG 闸门。
 *
 * ★零依赖：只 import src/core/rng.ts，不需要 npm install。
 *   跑法：npm run test:core
 *   等价：node --experimental-strip-types --test tests/deterministic/rng.test.ts
 *
 * ★本闸门可自证会变红（变异测试，必须 EXIT=1）：
 *   1) 改黄金值：把下面 GOLDEN_SEED 的末位改一个数字 → 应红
 *      node -e "..." 或直接编辑后跑 npm run test:core
 *   2) 改实现：把 src/core/rng.ts 的 xorshift32 里 `x ^= x >>> 17` 改成 `x ^= x >>> 16`
 *      → GOLDEN_FIRST5 与 rollDice 黄金值应同时红
 *   3) 破坏独立性：把 forCombat 的 salt 'combat' 改成 'event' → 与 forEvent 的种子相等断言应红
 *   任何一条变异跑出来还是绿的，说明闸门没有区分力，不许签收。
 *
 * 黄金值来源：2026-10-24 实测 node v26.5.0 跑出，重算命令（临时脚本，勿留仓）：
 *   node --experimental-strip-types -e "import('./src/core/rng.ts').then(m=>{
 *     console.log(m.deriveSeed(['roomA','combat',7,'qin','chu','handan']));
 *     const g=m.DeterministicRng.fromSeed(2804400686);
 *     console.log(Array.from({length:5},()=>g.nextUint32()));
 *     console.log(m.rollDice(m.DeterministicRng.fromSeed(42),3,6,2).rolls);
 *     const R='room-seed-xyz';
 *     for (const [n,v] of Object.entries({combat:m.DeterministicRng.forCombat(R,3,'qin','chu','handan'),
 *       event:m.DeterministicRng.forEvent(R,3,'plague','handan'),
 *       unrest:m.DeterministicRng.forUnrest(R,3,'handan'),
 *       ai:m.DeterministicRng.forAi(R,3,'qin')})) console.log(n, v.seed);
 *   })"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicRng, deriveSeed, rollDice } from '../../src/core/rng.ts';

// ── 黄金值（钉死；改实现必须同步改这里并说明理由）──
const GOLDEN_SEED = 2804400686;
const GOLDEN_FIRST5 = [3005718143, 1575198571, 4023641580, 4272662331, 3286024637];
const GOLDEN_DICE_3D6P2_SEED42 = [1, 4, 1];

const COMBAT_PARTS = ['roomA', 'combat', 7, 'qin', 'chu', 'handan'] as const;

/**
 * ★各子系统 salt 前缀的黄金值。
 *
 * 为什么必须钉死而不只断言"互不相等"：salt 前缀是**持久化契约**的一部分。
 * 它一旦变动，旧存档里记录的 rngState 就对不上新的流，重放静默失真。
 * 2026-10-24 实测发现：只断言 forCombat.seed !== forEvent.seed 时，
 * 把 forCombat 的 salt 'combat' 改成 'event' 闸门**依然是绿的**（参数个数不同，
 * 种子照样不等）—— 变异无区分力。故改为逐流钉黄金值。
 */
const ROOT = 'room-seed-xyz';
const GOLDEN_STREAM_SEEDS = {
  combat: 1451902207, // forCombat(ROOT, 3, 'qin','chu','handan')
  event: 3605443383, //  forEvent (ROOT, 3, 'plague','handan')
  unrest: 3181906402, // forUnrest(ROOT, 3, 'handan')
  ai: 3065454835, //     forAi    (ROOT, 3, 'qin')
} as const;

test('派生：同输入永远同种子，且钉住黄金值', () => {
  const s1 = deriveSeed([...COMBAT_PARTS]);
  const s2 = deriveSeed([...COMBAT_PARTS]);
  assert.equal(s1, s2, '同输入必须同种子');
  assert.equal(s1, GOLDEN_SEED, '黄金值漂移 = 实现被改动了');
});

test('派生：任何一个盐变化都必须改变种子（防碰撞）', () => {
  const base = deriveSeed([...COMBAT_PARTS]);
  // 攻守互换
  assert.notEqual(base, deriveSeed(['roomA', 'combat', 7, 'chu', 'qin', 'handan']));
  // 回合 +1
  assert.notEqual(base, deriveSeed(['roomA', 'combat', 8, 'qin', 'chu', 'handan']));
  // 换房间
  assert.notEqual(base, deriveSeed(['roomB', 'combat', 7, 'qin', 'chu', 'handan']));
  // 换区域
  assert.notEqual(base, deriveSeed(['roomA', 'combat', 7, 'qin', 'chu', 'jinyang']));
  // 换子系统
  assert.notEqual(base, deriveSeed(['roomA', 'event', 7, 'qin', 'chu', 'handan']));
  assert.notEqual(base, 0, '种子 0 是 xorshift 不动点，必须避开');
});

test('同种子的两个实例产出逐位相同的序列', () => {
  const a = DeterministicRng.fromSeed(GOLDEN_SEED);
  const b = DeterministicRng.fromSeed(GOLDEN_SEED);
  const seqA = Array.from({ length: 20 }, () => a.nextUint32());
  const seqB = Array.from({ length: 20 }, () => b.nextUint32());
  assert.deepEqual(seqA, seqB);
  assert.deepEqual(seqA.slice(0, 5), GOLDEN_FIRST5, '黄金序列漂移 = 实现被改动了');
  assert.equal(new Set(seqA).size, 20, '前 20 次抽取不应重复');
});

test('快照 → 推进 → 恢复：时间线必须完全一致（重放的地基）', () => {
  const rng = DeterministicRng.fromSeed(GOLDEN_SEED);
  rng.nextUint32();
  rng.nextUint32();
  const snap = rng.snapshot();
  const forward = [rng.nextUint32(), rng.nextUint32(), rng.nextUint32()];

  const restored = DeterministicRng.restore(snap);
  const replayed = [restored.nextUint32(), restored.nextUint32(), restored.nextUint32()];

  assert.deepEqual(replayed, forward, 'restore 后必须重现同样的后续');
  assert.equal(snap.seed, GOLDEN_SEED);
  assert.equal(typeof snap.state, 'number');
  // 快照必须可 JSON 序列化（要存进 SQLite / GameState）
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
});

test('独立随机流互不干扰：多抽气候不得改变战斗骰', () => {
  const root = 'room-seed-xyz';
  const combatRef = DeterministicRng.forCombat(root, 3, 'qin', 'chu', 'handan');
  const expected = combatRef.nextUint32();

  const combat = DeterministicRng.forCombat(root, 3, 'qin', 'chu', 'handan');
  // 中间插入大量其他子系统的抽取
  const event = DeterministicRng.forEvent(root, 3, 'plague', 'handan');
  for (let i = 0; i < 50; i++) event.nextUint32();
  const unrest = DeterministicRng.forUnrest(root, 3, 'handan');
  for (let i = 0; i < 50; i++) unrest.nextUint32();

  assert.equal(combat.nextUint32(), expected, '其他流推进后战斗流必须不受影响');
  assert.notEqual(
    DeterministicRng.forCombat(ROOT, 3, 'qin', 'chu', 'handan').seed,
    DeterministicRng.forEvent(ROOT, 3, 'plague', 'handan').seed,
    '不同子系统的 salt 必须产出不同种子',
  );
  assert.notEqual(
    DeterministicRng.forAi(ROOT, 3, 'qin').seed,
    DeterministicRng.forCombat(ROOT, 3, 'qin', 'chu', 'handan').seed,
    'AI 流必须独立于战斗流',
  );
});

test('★salt 前缀是持久化契约：四条流的种子必须逐位钉死', () => {
  // 改任何一个 salt 字符串都会让旧存档的重放静默失真 ⇒ 必须红，不许"顺手改一下"
  assert.equal(
    DeterministicRng.forCombat(ROOT, 3, 'qin', 'chu', 'handan').seed,
    GOLDEN_STREAM_SEEDS.combat,
    "forCombat 的 salt 'combat' 被改动了",
  );
  assert.equal(
    DeterministicRng.forEvent(ROOT, 3, 'plague', 'handan').seed,
    GOLDEN_STREAM_SEEDS.event,
    "forEvent 的 salt 'event' 被改动了",
  );
  assert.equal(
    DeterministicRng.forUnrest(ROOT, 3, 'handan').seed,
    GOLDEN_STREAM_SEEDS.unrest,
    "forUnrest 的 salt 'unrest' 被改动了",
  );
  assert.equal(
    DeterministicRng.forAi(ROOT, 3, 'qin').seed,
    GOLDEN_STREAM_SEEDS.ai,
    "forAi 的 salt 'ai' 被改动了",
  );
  // 四条流互不相同（盐真的起作用了，不是退化成同一个）
  const seeds = Object.values(GOLDEN_STREAM_SEEDS);
  assert.equal(new Set(seeds).size, 4, '四条流的黄金种子必须互不相同');
});

test('nextInt：闭区间、全覆盖、均值合理、越界抛错', () => {
  const rng = DeterministicRng.fromSeed(12345);
  const rolls = Array.from({ length: 10000 }, () => rng.nextInt(1, 6));
  assert.ok(rolls.every((v) => v >= 1 && v <= 6), '必须落在闭区间 [1,6]');
  assert.equal(new Set(rolls).size, 6, '10000 次必须覆盖全部 6 面');
  const mean = rolls.reduce((a, b) => a + b, 0) / rolls.length;
  assert.ok(Math.abs(mean - 3.5) < 0.08, `d6 均值应≈3.5，实测 ${mean}`);

  assert.throws(() => rng.nextInt(5, 1), RangeError, '边界颠倒必须抛错，不静默交换');
  assert.throws(() => rng.nextInt(1.5, 3), TypeError, '非整数边界必须抛错');
  // 单点区间合法
  assert.equal(rng.nextInt(7, 7), 7);
});

test('nextFloat：[0,1) 且确定性', () => {
  const a = DeterministicRng.fromSeed(777);
  const b = DeterministicRng.fromSeed(777);
  const fa = Array.from({ length: 5000 }, () => a.nextFloat());
  const fb = Array.from({ length: 5000 }, () => b.nextFloat());
  assert.deepEqual(fa, fb);
  assert.ok(fa.every((v) => v >= 0 && v < 1), '必须 ∈ [0,1)');
});

test('chance：概率边界校验 + 极端值行为正确', () => {
  const rng = DeterministicRng.fromSeed(31337);
  assert.throws(() => rng.chance(1.5), RangeError);
  assert.throws(() => rng.chance(-0.1), RangeError);
  // p=0 永不发生，p=1 永远发生
  const zero = DeterministicRng.fromSeed(1);
  for (let i = 0; i < 200; i++) assert.equal(zero.chance(0), false);
  const one = DeterministicRng.fromSeed(1);
  for (let i = 0; i < 200; i++) assert.equal(one.chance(1), true);
});

test('pick：等概率、确定性、空数组抛错（不静默返回 undefined）', () => {
  const rng = DeterministicRng.fromSeed(2024);
  const items = ['a', 'b', 'c', 'd'] as const;
  const picks = Array.from({ length: 4000 }, () => rng.pick(items));
  assert.equal(new Set(picks).size, 4, '必须覆盖全部元素');
  for (const it of items) {
    const n = picks.filter((p) => p === it).length;
    assert.ok(n > 700 && n < 1300, `${it} 出现 ${n} 次，应≈1000`);
  }
  const seqA = Array.from({ length: 20 }, () => DeterministicRng.fromSeed(2024).pick(items));
  const seqB = Array.from({ length: 20 }, () => {
    const r = DeterministicRng.fromSeed(2024);
    return Array.from({ length: 20 }, () => r.pick(items));
  });
  // seqA 每项都用新实例 ⇒ 必须全是同一个元素；seqB 是单实例连抽 ⇒ 必须与另一单实例连抽逐位相同
  assert.equal(new Set(seqA).size, 1, '同种子新实例的首次抽取必须恒定');
  const r1 = DeterministicRng.fromSeed(2024);
  const r2 = DeterministicRng.fromSeed(2024);
  assert.deepEqual(
    Array.from({ length: 20 }, () => r1.pick(items)),
    Array.from({ length: 20 }, () => r2.pick(items)),
  );
  void seqB;
  assert.throws(() => rng.pick([]), RangeError);
});

test('weighted：偏向高权重、确定性、非法权重抛错', () => {
  const items = [
    { id: 'a', w: 1 },
    { id: 'b', w: 2 },
    { id: 'c', w: 3 },
  ];
  const w1 = DeterministicRng.fromSeed(999);
  const w2 = DeterministicRng.fromSeed(999);
  const p1 = Array.from({ length: 60 }, () => w1.weighted(items, (x) => x.w).id);
  const p2 = Array.from({ length: 60 }, () => w2.weighted(items, (x) => x.w).id);
  assert.deepEqual(p1, p2, '同种子必须同结果');

  const counts = p1.reduce<Record<string, number>>((m, id) => ((m[id] = (m[id] ?? 0) + 1), m), {});
  assert.ok((counts['c'] ?? 0) >= (counts['a'] ?? 0), `高权重应更常命中：${JSON.stringify(counts)}`);

  const rng = DeterministicRng.fromSeed(5);
  assert.throws(() => rng.weighted([], () => 1), RangeError, '空数组');
  assert.throws(() => rng.weighted([{ w: 0 }, { w: 0 }], (x) => x.w), RangeError, '权重总和 0');
  assert.throws(() => rng.weighted([{ w: -1 }, { w: 2 }], (x) => x.w), RangeError, '负权重');
  assert.throws(() => rng.weighted([{ w: 1 }, { w: NaN }], (x) => x.w), RangeError, 'NaN 权重');
});

test('rollDice：明细完整、可复现、总量自洽、参数校验', () => {
  const d = rollDice(DeterministicRng.fromSeed(42), 3, 6, 2);
  assert.equal(d.expr, '3d6+2');
  assert.equal(d.rolls.length, 3);
  assert.deepEqual([...d.rolls], GOLDEN_DICE_3D6P2_SEED42, '掷骰黄金值漂移 = 实现被改动了');
  assert.equal(d.total, d.rolls.reduce((a, b) => a + b, 0) + 2, 'total 必须 = sum(rolls)+modifier');
  assert.ok(d.rolls.every((v) => v >= 1 && v <= 6));

  const again = rollDice(DeterministicRng.fromSeed(42), 3, 6, 2);
  assert.deepEqual([...again.rolls], [...d.rolls], '同种子掷骰必须可复现');

  // 负修正值的 expr 格式
  assert.equal(rollDice(DeterministicRng.fromSeed(1), 1, 20, -3).expr, '1d20-3');
  assert.equal(rollDice(DeterministicRng.fromSeed(1), 2, 6, 0).expr, '2d6');

  const rng = DeterministicRng.fromSeed(1);
  assert.throws(() => rollDice(rng, 0, 6), RangeError, '0 颗骰');
  assert.throws(() => rollDice(rng, 101, 6), RangeError, '骰数超上限');
  assert.throws(() => rollDice(rng, 2, 1), RangeError, 'd1 无意义');
  assert.throws(() => rollDice(rng, 2, 6.5), RangeError, '非整数骰面');
});

test('fromSeed(0) 不得产出全零序列（xorshift 不动点防护）', () => {
  const rng = DeterministicRng.fromSeed(0);
  const seq = Array.from({ length: 10 }, () => rng.nextUint32());
  assert.ok(seq.some((v) => v !== 0), '种子 0 必须被替换成非零基值');
});
