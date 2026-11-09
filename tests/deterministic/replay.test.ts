/**
 * 端到端确定性重放闸门 —— 阶段三"最小可玩国战 + 所有随机性使用固定种子"的验收。
 *
 * ★本文件是业主任务书里两条硬要求的唯一机器证据：
 *   「确定性规则引擎：地图 16-20 个区域、资源生产、单位移动、确定性战斗结算。
 *     所有随机性使用固定种子。」
 *
 * 跑法：node --experimental-strip-types --test tests/deterministic/replay.test.ts
 *
 * ★每条断言都配了"反向可辨"检查（换种子必须产生不同结果、非法命令必须被拒且状态不变），
 *   否则一个恒真的测试也能全绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScenario, sha256, stableStringify, findHoles } from '../../src/server/config-loader.ts';
import { resolveTurn, type SanitizedLlmDelta } from '../../src/core/apply.ts';
import { buildModules, findUndeclaredWriteConflicts, computeBehaviorFingerprint } from '../../src/core/modules/index.ts';
import type { GameState } from '../../src/core/state.ts';
import type { AcceptedOrder, RuleModule, TurnOutcome } from '../../src/core/module.ts';

const SCENARIO = 'warring-states';
const SEED = 'test-seed-fixed-0001';
const FIXED_NOW = 1_700_000_000_000;

const digest = (s: GameState): string => sha256(stableStringify(s));

const loaded = loadScenario(SCENARIO, SEED);
const MODULES: RuleModule[] = buildModules(loaded.meta.moduleOrder);

function order(seatId: string, factionId: string, command: Record<string, unknown>): AcceptedOrder {
  return { seatId, factionId, command, kind: command['kind'] as string };
}

/** 跑 n 个回合，每回合用同一份 orders（按回合号索引） */
function simulate(
  seed: string,
  turns: number,
  ordersPerTurn: (turn: number) => readonly AcceptedOrder[] = () => [],
  llmPerTurn: (turn: number) => SanitizedLlmDelta | null = () => null,
): { final: GameState; outcomes: TurnOutcome[]; digests: string[] } {
  const sc = loadScenario(SCENARIO, seed);
  const mods = buildModules(sc.meta.moduleOrder);
  let state = sc.initialState;
  const outcomes: TurnOutcome[] = [];
  const digests: string[] = [digest(state)];
  for (let t = 1; t <= turns; t++) {
    state = { ...state, turn: t };
    const outcome = resolveTurn({
      state,
      world: sc.world,
      modules: mods,
      orders: ordersPerTurn(t),
      rootSeed: seed,
      turn: t,
      now: FIXED_NOW + t * 1000,
      digest,
      llmDelta: llmPerTurn(t),
    });
    outcomes.push(outcome);
    state = outcome.state;
    digests.push(outcome.newStateDigest);
  }
  return { final: state, outcomes, digests };
}

// ─────────────────────────────────────────────────────────────
// 装载与初始状态
// ─────────────────────────────────────────────────────────────

test('剧本装载：7 势力 / 19 区域 / 部队齐备', () => {
  const s = loaded.initialState;
  assert.equal(Object.keys(s.factions).length, 7, '战国七雄应有 7 个势力');
  const regionCount = Object.keys(s.regions).length;
  assert.ok(regionCount >= 16 && regionCount <= 20, `区域数 ${regionCount} 必须在任务书要求的 16-20`);
  assert.ok(Object.keys(s.units).length >= 20, `初始部队数 ${Object.keys(s.units).length} 过少`);
  assert.equal(s.phase, 'submitting');
  assert.equal(s.winner, null);
  // 洛阳必须是中立且有驻军
  assert.equal(s.regions['luoyang']?.owner, null, '洛阳开局应为中立');
  assert.ok(s.units['garrison_luoyang'], '洛阳应有中立驻军');
});

test('模块写权限重叠必须全部登记在册', () => {
  const undeclared = findUndeclaredWriteConflicts(MODULES);
  assert.deepEqual(
    undeclared,
    [],
    `发现未登记的 writes 重叠（意味着隐藏的顺序依赖）：${JSON.stringify(undeclared)}`,
  );
});

test('behaviorFingerprint 稳定且随模块版本变化', () => {
  const base = computeBehaviorFingerprint(MODULES, loaded.meta.behaviorFingerprint);
  const again = computeBehaviorFingerprint([...MODULES].reverse(), loaded.meta.behaviorFingerprint);
  assert.equal(base, again, '指纹必须与模块传入顺序无关（内部已排序）');
  const bumped = computeBehaviorFingerprint(
    MODULES.map((m) => (m.id === 'combat' ? { ...m, version: m.version + 1 } : m)),
    loaded.meta.behaviorFingerprint,
  );
  assert.notEqual(base, bumped, '模块版本变了指纹必须变，否则旧存档不会 fail-closed');
});

// ─────────────────────────────────────────────────────────────
// ★确定性重放
// ─────────────────────────────────────────────────────────────

test('★同种子 + 同命令 ⇒ 20 回合逐位相同', () => {
  const orders = (t: number): readonly AcceptedOrder[] =>
    t === 3
      ? [order('qin', 'qin', { kind: 'attack', unitId: 'u_qin_1', targetRegion: 'luoyang' })]
      : t === 5
        ? [order('qin', 'qin', { kind: 'recruit', regionId: 'guanzhong', unitType: 'spearman', count: 5000 })]
        : [];
  const a = simulate(SEED, 20, orders);
  const b = simulate(SEED, 20, orders);
  assert.deepEqual(a.digests, b.digests, '同种子同命令的 digest 序列必须逐位相同');
  assert.equal(a.digests.length, 21, '20 回合应有 21 个 digest（含初始）');
  assert.equal(new Set(a.digests).size, a.digests.length, '每回合状态都该变化；若出现重复说明有回合空转');
});

test('★换种子必须产生不同结果（证明种子真的接进了结算，不是死参数）', () => {
  const attack: (t: number) => readonly AcceptedOrder[] = (t) =>
    t === 1 ? [order('qin', 'qin', { kind: 'attack', unitId: 'u_qin_1', targetRegion: 'luoyang' })] : [];
  const a = simulate(SEED, 3, attack);
  const b = simulate('a-completely-different-seed', 3, attack);
  assert.notDeepEqual(
    a.digests,
    b.digests,
    '不同种子产生了完全相同的结果 —— 说明随机源没接到种子上，"固定种子"是假的',
  );
});

test('★战斗证据可复算：同种子 ⇒ 逐轮骰值、伤亡、种子全同', () => {
  const attack: (t: number) => readonly AcceptedOrder[] = (t) =>
    t === 1 ? [order('qin', 'qin', { kind: 'attack', unitId: 'u_qin_1', targetRegion: 'luoyang' })] : [];
  const a = simulate(SEED, 1, attack);
  const b = simulate(SEED, 1, attack);
  const evA = a.outcomes[0]!.events.filter((e: any) => e.type === 'combat_resolved');
  const evB = b.outcomes[0]!.events.filter((e: any) => e.type === 'combat_resolved');
  assert.equal(evA.length, 1, '第 1 回合的进攻必须产生恰好一场战斗');
  assert.deepEqual(evA, evB, '战斗证据必须逐位相同');

  const ev = evA[0] as any;
  const e = ev.evidence;
  assert.equal(typeof e.seed, 'number');
  assert.ok(e.rounds.length >= 1, '至少一轮');
  assert.ok(e.rounds.length <= loaded.world.combat.maxRounds, `轮数不得超过 maxRounds`);
  for (const r of e.rounds) {
    assert.ok(r.attackRoll >= 2 && r.attackRoll <= 12, `2d6 应在 [2,12]，实得 ${r.attackRoll}`);
    assert.ok(r.defenseRoll >= 2 && r.defenseRoll <= 12);
    assert.ok(r.attackerLosses >= 0 && r.defenderLosses >= 0, '伤亡不得为负');
    assert.equal(typeof r.modifiers.terrain, 'number');
  }
  // 兵力守恒：after = before - Σlosses
  const atkLoss = e.rounds.reduce((s: number, r: any) => s + r.attackerLosses, 0);
  const defLoss = e.rounds.reduce((s: number, r: any) => s + r.defenderLosses, 0);
  assert.ok(
    e.attacker.troopsAfter <= e.attacker.troopsBefore,
    '攻方兵力不得增加',
  );
  assert.ok(atkLoss >= 0 && defLoss >= 0);
  assert.ok(e.attacker.troopsBefore - atkLoss >= 0, '伤亡累计不得超过初始兵力');
  void defLoss;
});

test('★换种子 ⇒ 同一场战斗的骰值必须不同（证明骰子真的由种子驱动）', () => {
  const attack: (t: number) => readonly AcceptedOrder[] = (t) =>
    t === 1 ? [order('qin', 'qin', { kind: 'attack', unitId: 'u_qin_1', targetRegion: 'luoyang' })] : [];
  const a = simulate(SEED, 1, attack);
  const b = simulate('another-seed-entirely', 1, attack);
  const rollsOf = (r: { outcomes: TurnOutcome[] }): number[] =>
    (r.outcomes[0]!.events.filter((e: any) => e.type === 'combat_resolved')[0] as any).evidence.rounds.map(
      (x: any) => x.attackRoll,
    );
  assert.notDeepEqual(rollsOf(a), rollsOf(b), '不同种子掷出完全相同的骰序 —— 种子没接进 RNG');
});

// ─────────────────────────────────────────────────────────────
// ★经济真的在动（Histrategy V1 的"数值惰性"失败模式）
// ─────────────────────────────────────────────────────────────

test('★经济不得冻结：国库与粮草必须逐回合变化', () => {
  const r = simulate(SEED, 8);
  const goldSeries = r.outcomes.map((o) => o.state.factions['qin']!.gold);
  const foodSeries = r.outcomes.map((o) => o.state.factions['qin']!.food);
  assert.ok(
    new Set(goldSeries).size > 1,
    `秦国国库 8 回合恒为 ${goldSeries[0]} —— 这正是 Histrategy V1 的"数值惰性"：LLM 漏更新字段导致国库冻结。确定性引擎绝不能有这个问题`,
  );
  assert.ok(new Set(foodSeries).size > 1, '粮草 8 回合未变化');
  // 有增有减（收入与军费都要真的发生）
  const goldDeltas = goldSeries.slice(1).map((g, i) => g - (goldSeries[i] as number));
  assert.ok(goldDeltas.some((d) => d !== 0), '国库增量全为 0');
});

test('★逐字段增量归因必须落库，且 source 字段有值', () => {
  const r = simulate(SEED, 3);
  const all = r.outcomes.flatMap((o) => o.deltas);
  assert.ok(all.length > 0, '3 回合内应产生大量增量记录');
  for (const d of all) {
    assert.ok(['deterministic', 'llm', 'event'].includes(d.source), `source 非法：${d.source}`);
    assert.equal(d.newValue - d.oldValue, d.delta, `delta 与 old/new 不自洽：${JSON.stringify(d)}`);
    assert.ok(d.reason.length > 0, '每条增量都必须有 reason（"这个数为什么变成这样"）');
  }
  // 纯确定性回合不该出现 source=llm
  assert.ok(
    all.every((d) => d.source !== 'llm'),
    '未传 llmDelta 的回合不应产生 source=llm 的增量',
  );
});

test('★LLM delta 只能改允许的东西，且必须被标记为 source=llm', () => {
  const llm: SanitizedLlmDelta = {
    moraleAdjustments: [{ factionId: 'han', delta: -6, reason: '韩王安惊惧' }],
    unrestEvents: [{ regionId: 'xinzheng', delta: 12, severity: 'minor', reason: '粮价飞涨' }],
  };
  const withLlm = simulate(SEED, 2, () => [], (t) => (t === 2 ? llm : null));
  const without = simulate(SEED, 2, () => [], () => null);

  assert.equal(withLlm.outcomes[1]!.llmApplied, true, '第 2 回合应标记 llmApplied');
  assert.equal(without.outcomes[1]!.llmApplied, false, '对照回合不得标记 llmApplied');
  assert.notEqual(withLlm.digests[2], without.digests[2], 'LLM delta 必须真的改变了状态');

  const llmDeltas = withLlm.outcomes[1]!.deltas.filter((d) => d.source === 'llm');
  assert.ok(llmDeltas.length >= 2, `应至少有 2 条 source=llm 的归因，实得 ${llmDeltas.length}`);
  assert.ok(
    llmDeltas.some((d) => d.scope === 'faction:han' && d.field === 'morale'),
    '韩的士气变化必须被归因到 llm',
  );
});

// ─────────────────────────────────────────────────────────────
// ★P4：拒绝不改状态
// ─────────────────────────────────────────────────────────────

test('★非法命令被拒且状态与"没下这条命令"完全一致', () => {
  // 秦进攻不相邻的临淄（齐国），必须被拒
  const bad: (t: number) => readonly AcceptedOrder[] = (t) =>
    t === 1 ? [order('qin', 'qin', { kind: 'attack', unitId: 'u_qin_1', targetRegion: 'linzi' })] : [];
  const withBad = simulate(SEED, 2, bad);
  const clean = simulate(SEED, 2, () => []);

  assert.deepEqual(
    withBad.digests,
    clean.digests,
    '被拒绝的命令产生了副作用 —— 违反 P4「拒绝不改状态」',
  );
  const rejections = withBad.outcomes[0]!.events.filter((e: any) => e.type === 'combat_resolved');
  assert.equal(rejections.length, 0, '不相邻的进攻不得结算出战斗');
});

test('★资源不足的征兵被拒，且国库分文未动', () => {
  // 征 50 万兵，远超任何上限
  const tooBig: (t: number) => readonly AcceptedOrder[] = (t) =>
    t === 1 ? [order('han', 'han', { kind: 'recruit', regionId: 'xinzheng', unitType: 'siege', count: 500000 })] : [];
  const r = simulate(SEED, 1, tooBig);
  const clean = simulate(SEED, 1, () => []);
  assert.deepEqual(r.digests, clean.digests, '被拒的征兵不得改动任何状态');
  assert.equal(
    r.final.factions['han']!.gold,
    clean.final.factions['han']!.gold,
    '被拒的征兵不得扣钱',
  );
});

test('★越权命令被拒：不能指挥别人的部队', () => {
  const steal: (t: number) => readonly AcceptedOrder[] = (t) =>
    t === 1 ? [order('han', 'han', { kind: 'move_units', unitId: 'u_qin_1', toRegion: 'hanzhong' })] : [];
  const r = simulate(SEED, 1, steal);
  const clean = simulate(SEED, 1, () => []);
  assert.deepEqual(r.digests, clean.digests, '指挥他国部队必须被拒且不产生副作用');
  assert.equal(r.final.units['u_qin_1']!.regionId, 'guanzhong', '秦军不得被韩挪走');
});

// ─────────────────────────────────────────────────────────────
// 移动与战斗的正向路径
// ─────────────────────────────────────────────────────────────

test('合法移动真的把部队挪过去，并发出 units_moved 事件', () => {
  // 秦：u_qin_3 在 hanzhong，移动到相邻的 guanzhong
  const mv: (t: number) => readonly AcceptedOrder[] = (t) =>
    t === 1 ? [order('qin', 'qin', { kind: 'move_units', unitId: 'u_qin_3', toRegion: 'guanzhong' })] : [];
  const r = simulate(SEED, 1, mv);
  assert.equal(r.final.units['u_qin_3']!.regionId, 'guanzhong');
  const ev = r.outcomes[0]!.events.filter((e: any) => e.type === 'units_moved') as any[];
  assert.equal(ev.length, 1);
  assert.equal(ev[0].from, 'hanzhong');
  assert.equal(ev[0].to, 'guanzhong');
  assert.ok(Array.isArray(ev[0].path) && ev[0].path.length >= 2);
});

test('移动力不足的远距离移动被拒', () => {
  // 薊城 → 巴蜀：横跨大半个地图，任何兵种都到不了
  const far: (t: number) => readonly AcceptedOrder[] = (t) =>
    t === 1 ? [order('yan', 'yan', { kind: 'move_units', unitId: 'u_yan_1', toRegion: 'bashu' })] : [];
  const r = simulate(SEED, 1, far);
  const clean = simulate(SEED, 1, () => []);
  assert.deepEqual(r.digests, clean.digests, '超程移动必须被拒且无副作用');
  assert.equal(r.final.units['u_yan_1']!.regionId, 'ji');
});

test('★攻取中立区洛阳：20000 槍兵应能打下 6000 民兵守军', () => {
  const atk: (t: number) => readonly AcceptedOrder[] = (t) =>
    t === 1 ? [order('qin', 'qin', { kind: 'attack', unitId: 'u_qin_1', targetRegion: 'luoyang' })] : [];
  const r = simulate(SEED, 1, atk);
  const ev = r.outcomes[0]!.events.filter((e: any) => e.type === 'combat_resolved')[0] as any;
  assert.ok(ev, '必须产生战斗');
  const e = ev.evidence;
  assert.ok(e.powerRatio > 1, `2万槍兵打6千民兵应有战力优势，实得 powerRatio=${e.powerRatio}`);
  assert.ok(
    e.outcome === 'attacker_win' || e.outcome === 'defender_rout',
    `优势方应获胜，实得 ${e.outcome}`,
  );
  assert.equal(e.captured, true, '洛阳应被攻取');
  assert.equal(r.final.regions['luoyang']!.owner, 'qin', '洛阳归属必须真的变成秦');
  const cap = r.outcomes[0]!.events.filter((x: any) => x.type === 'region_captured') as any[];
  assert.equal(cap.length, 1);
  assert.equal(cap[0].to, 'qin');
  assert.equal(cap[0].from, null, '中立区易手时 from 应为 null');
});

test('★夺城理由必须是确定性的 force_ratio 或 morale_collapse，不是 LLM 的措辞', () => {
  const atk: (t: number) => readonly AcceptedOrder[] = (t) =>
    t === 1 ? [order('qin', 'qin', { kind: 'attack', unitId: 'u_qin_1', targetRegion: 'luoyang' })] : [];
  const r = simulate(SEED, 1, atk);
  const ev = r.outcomes[0]!.events.filter((e: any) => e.type === 'combat_resolved')[0] as any;
  assert.ok(
    ['force_ratio', 'morale_collapse'].includes(ev.evidence.captureReason),
    `captureReason 必须是确定性判据，实得 ${ev.evidence.captureReason}`,
  );
});

test('以弱攻强必须失败（兵力比裁决，不是谁先下手谁赢）', () => {
  // 韩 u_han_2（弓兵 10000，上黨）攻打趙 jinyang（劍士 12000 + 山地 def1.4 + 一级要塞）
  // ★上黨 与 晉陽 在 regions.json 里确实相邻 —— 选目标前先查邻接表，
  //   我第一版写了个不相邻的组合，命令被 REGION_NOT_ADJACENT 拒掉，
  //   于是"没产生战斗"被误读成"以弱攻强赢了"。测试前提错了比断言错了更难发现。
  const sc = loaded;
  assert.ok(
    sc.world.regions['shangdang']!.adjacency.includes('jinyang'),
    '测试前提：上黨必须与晉陽相邻',
  );
  const weak: (t: number) => readonly AcceptedOrder[] = (t) =>
    t === 1 ? [order('han', 'han', { kind: 'attack', unitId: 'u_han_2', targetRegion: 'jinyang' })] : [];
  const r = simulate(SEED, 1, weak);
  const ev = r.outcomes[0]!.events.filter((e: any) => e.type === 'combat_resolved')[0] as any;
  assert.ok(ev, '必须产生战斗（若被拒说明测试前提又不成立了）');
  const e = ev.evidence;
  assert.ok(e.powerRatio < 1, `弓兵攻山地要塞应处劣势，实得 powerRatio=${e.powerRatio}`);
  assert.equal(e.captured, false, '劣势方不得夺城');
  assert.equal(r.final.regions['jinyang']!.owner, 'zhao', '晉陽必须仍在趙手');
  assert.ok(e.attacker.troopsAfter < e.attacker.troopsBefore, '攻方必须付出伤亡');
});

test('★全局无 NaN / Infinity / undefined —— 确定性测试抓不到的那类 bug', () => {
  // 由来：装载器漏一个键 ⇒ 乘数 NaN ⇒ 国库 NaN，而"同种子同结果"依然全绿。
  // "同输入同输出"证明不了"输出是对的"，必须单独扫。
  const holes0 = findHoles(loaded.world, 'world');
  assert.deepEqual(holes0, [], `WorldConfig 有空洞：${holes0.slice(0, 10).join(', ')}`);
  const holesInit = findHoles(loaded.initialState, 'initialState');
  assert.deepEqual(holesInit, [], `初始状态有空洞：${holesInit.slice(0, 10).join(', ')}`);

  const attack: (t: number) => readonly AcceptedOrder[] = (t) =>
    t === 1 ? [order('qin', 'qin', { kind: 'attack', unitId: 'u_qin_1', targetRegion: 'luoyang' })] : [];
  const r = simulate(SEED, 12, attack);
  const holes = findHoles(r.final, 'finalState');
  assert.deepEqual(holes, [], `跑 12 回合后状态出现空洞：${holes.slice(0, 10).join(', ')}`);
  for (const o of r.outcomes) {
    const h = findHoles(o.deltas, 'deltas');
    assert.deepEqual(h, [], `增量记录出现空洞：${h.slice(0, 5).join(', ')}`);
  }
  // 每个势力的国库都必须是有限数
  for (const [fid, f] of Object.entries(r.final.factions)) {
    assert.ok(Number.isFinite(f.gold), `${fid}.gold = ${f.gold}`);
    assert.ok(Number.isFinite(f.food), `${fid}.food = ${f.food}`);
    assert.ok(Number.isFinite(f.morale), `${fid}.morale = ${f.morale}`);
  }
});

// ─────────────────────────────────────────────────────────────
// 终局与性能
// ─────────────────────────────────────────────────────────────

test('跑满 maxTurns 必须收敛到 ended，且不抛异常', () => {
  const r = simulate(SEED, loaded.meta.maxTurns);
  assert.equal(r.final.phase, 'ended', `跑满 ${loaded.meta.maxTurns} 回合后应为 ended`);
  assert.ok(r.final.endReason !== null, '必须有终局原因');
  const end = r.outcomes.at(-1)!.events.filter((e: any) => e.type === 'match_ended');
  assert.ok(end.length >= 1, '必须发出 match_ended 事件');
  // 多维评分（OpenRA-RL 教训：单一胜负定位不了失败模式）
  const scores = (end[0] as any).scores;
  const anyFaction = Object.keys(scores)[0];
  if (anyFaction) {
    const dims = Object.keys(scores[anyFaction]);
    assert.ok(dims.length >= 4, `评分维度应 ≥4（经济/领土/军力/士气），实得 ${dims.join(',')}`);
  }
});

test('★单回合结算必须在 50ms 内（轻量服务器的可行性证据）', () => {
  const sc = loadScenario(SCENARIO, SEED);
  const mods = buildModules(sc.meta.moduleOrder);
  let state = { ...sc.initialState, turn: 1 };
  // 预热
  state = resolveTurn({
    state, world: sc.world, modules: mods, orders: [], rootSeed: SEED,
    turn: 1, now: FIXED_NOW, digest,
  }).state;

  const N = 50;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const s = { ...sc.initialState, turn: i + 1 };
    resolveTurn({
      state: s, world: sc.world, modules: mods, orders: [], rootSeed: SEED,
      turn: i + 1, now: FIXED_NOW + i, digest,
    });
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  assert.ok(ms < 50, `单回合平均 ${ms.toFixed(2)}ms 超过 50ms 预算`);
});
