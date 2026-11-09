/**
 * 治理规则闸门：全国民心 / 地区动乱 / 基建 / 水路 1-2 格突击。
 *
 * 锁住四类事实：
 *   ① 旧剧本不启用 governance，contentHash 与行为保持旧版；
 *   ② random-front-v2 与 random-front 同种子同地图，但多出基建动作与民心/动乱反馈；
 *   ③ 低全国民心确实放大征兵/战火在本区制造的动乱，地区动乱确实惩罚本区产出与守备；
 *   ④ 基建逐级建成、降本区动乱、促本区人口、并汇总为全国民心；
 *   ⑤ 水师沿水路可突击 1-2 格，超过 2 格不行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildModules, findUndeclaredWriteConflicts } from '../../src/core/modules/index.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import { estimateBattle } from '../../src/core/modules/combat.ts';
import { buildSnapshot } from '../../src/server/room/snapshot.ts';
import {
  isAttackAdjacent,
  regionPopulation as regionPopulationOf,
  totalPopulation,
  waterRoutePath,
  type GameState,
  type WorldConfig,
} from '../../src/core/state.ts';
import type { AcceptedOrder } from '../../src/core/module.ts';
import type { DomainEvent } from '../../src/protocol/events.ts';

const SEED = 'governance-test-seed-0001';
const FIXED_NOW = 1_700_000_000_000;
const sc = loadScenario('random-front-v2', SEED, 'config');
const legacy = loadScenario('warring-states', SEED, 'config');
const MODULES = buildModules(sc.meta.moduleOrder);
const digest = (state: GameState): string => sha256(stableStringify(state));

function order(seatId: string, factionId: string, command: Record<string, unknown>): AcceptedOrder {
  return { seatId, factionId, command, kind: command['kind'] as string };
}

function clone(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

function run(state: GameState, commands: readonly AcceptedOrder[] = []): ReturnType<typeof resolveTurn> {
  return resolveTurn({
    state,
    world: sc.world,
    modules: MODULES,
    orders: commands,
    rootSeed: SEED,
    turn: state.turn,
    now: FIXED_NOW,
    digest,
  });
}

function combatEvents(out: ReturnType<typeof resolveTurn>): Array<Extract<DomainEvent, { type: 'combat_resolved' }>> {
  return (out.events as DomainEvent[]).filter(
    (e): e is Extract<DomainEvent, { type: 'combat_resolved' }> => e.type === 'combat_resolved',
  );
}

function firstFactionWithRegions(state: GameState): { fid: string; regions: string[] } {
  for (const fid of Object.keys(state.factions).sort()) {
    const regions = Object.keys(state.regions).filter((rid) => state.regions[rid]?.owner === fid).sort();
    if (regions.length >= 3) return { fid, regions };
  }
  throw new Error('夹具失效：没有拥有 ≥3 个区域的势力');
}

function regionPopulation(world: WorldConfig, state: GameState, rid: string): number {
  const def = world.regions[rid];
  const st = state.regions[rid];
  if (!def || !st) return 0;
  return def.baseManpower * (1 + (st.development - 1) * 0.25);
}

// ─────────────────────────────────────────────────────────────
// 兼容性
// ─────────────────────────────────────────────────────────────

test('★旧剧本不启用 governance：基建动作不出现，旧哈希语义不变', () => {
  assert.equal(legacy.world.governance, undefined, 'warring-states 不应被新机制污染');
  const actions = enumerateLegalActions(legacy.initialState, legacy.world, 'qin', { maxActions: 60 });
  assert.equal(actions.some((a) => a.kind === 'build_infrastructure'), false, '旧剧本不得暴露基建动作');
  for (const r of Object.values(legacy.initialState.regions)) {
    assert.equal(r.infrastructure, 0, '旧剧本初始基建必须为 0');
  }
});

test('★random-front-v2 与 random-front 同种子同地图，但启用治理规则', () => {
  const old = loadScenario('random-front', SEED, 'config');
  assert.deepEqual(sc.mapLayout.regions, old.mapLayout.regions, '同种子布局必须逐位相同');
  assert.deepEqual(sc.world.regions, old.world.regions, '同种子规则地图必须逐位相同');
  assert.deepEqual(sc.initialState.factions, old.initialState.factions, '同种子开局势力必须相同');
  assert.notEqual(sc.contentHash, old.contentHash, '治理规则不同 ⇒ 内容哈希必须不同');
  assert.ok(sc.world.governance, 'v2 必须启用 governance');
  assert.equal(sc.mapLayout.rules?.infrastructure?.levels.length, sc.world.governance!.infrastructure.maxLevel);
});

test('★快照把基建/地区动乱/全国民心系数下发给 UI（观战与己方）', () => {
  const { fid, regions } = firstFactionWithRegions(sc.initialState);
  const rid = regions[0]!;
  const state = clone(sc.initialState);
  state.regions[rid]!.infrastructure = 2;
  state.regions[rid]!.unrest = 44;
  const snap = buildSnapshot({
    state,
    world: sc.world,
    recipient: fid,
    viewer: fid,
    digest: digest(state),
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
  });
  const region = snap.regions.find((r) => r.id === rid)!;
  assert.equal(region.infrastructure, 2, '己方区域必须下发基建等级');
  assert.equal(region.unrest, 44, '己方区域必须下发地区动乱');
  const self = snap.factions.find((f) => f.isSelf)!;
  assert.equal(self.morale, state.factions[fid]!.morale);
  assert.equal(
    self.moraleFactor,
    Math.round((0.5 + self.morale / sc.world.combat.moraleCoefficient) * 100) / 100,
    '全国民心必须附带战力系数',
  );
});

// ─────────────────────────────────────────────────────────────
// 基建：动作、成本、等级、被动效果
// ─────────────────────────────────────────────────────────────

test('★合法动作包含基建，且说明本区动乱/人口/全国民心三项效果', () => {
  const { fid } = firstFactionWithRegions(sc.initialState);
  const actions = enumerateLegalActions(sc.initialState, sc.world, fid, { maxActions: 60 });
  const infra = actions.filter((a) => a.kind === 'build_infrastructure');
  assert.ok(infra.length >= 1, '启用治理的剧本必须给人类/LLM 基建选项');
  for (const a of infra) {
    assert.equal(a.command['kind'], 'build_infrastructure');
    assert.equal(typeof a.command['regionId'], 'string');
    assert.equal(typeof a.estimate?.['goldCost'], 'number');
    assert.match(String(a.description), /本区动乱.*人口.*全国民心/s, `${a.id} 的效果说明必须覆盖三项`);
  }
});

test('★修建基建：逐级、扣金、立即减本区动乱、立即加全国民心、发事件', () => {
  const { fid, regions } = firstFactionWithRegions(sc.initialState);
  const rid = regions[0]!;
  const level = sc.world.governance!.infrastructure.levels[0]!;
  const baseline = run(clone(sc.initialState));
  const out = run(clone(sc.initialState), [
    order(fid, fid, { kind: 'build_infrastructure', regionId: rid }),
  ]);
  assert.deepEqual(out.rejected, []);
  assert.equal(out.state.regions[rid]?.infrastructure, 1, '基建必须从 0 升到 1');
  const ev = (out.events as DomainEvent[]).find((e) => e.type === 'infrastructure_completed');
  assert.ok(ev && ev.type === 'infrastructure_completed', '必须发出 infrastructure_completed');
  assert.equal(ev.fromLevel, 0);
  assert.equal(ev.toLevel, 1);
  assert.equal(ev.goldSpent, level.costGold);
  assert.equal(ev.unrestRelief, level.unrestRelief);
  assert.equal(ev.moraleGained, sc.world.governance!.infrastructure.moraleOnBuild);
  assert.ok(
    (out.state.factions[fid]?.morale ?? 0) >= (baseline.state.factions[fid]?.morale ?? 0) + level.moralePoints - 1,
    '建成后全国民心应立即提升（至少不因基建被动点数为负）',
  );
  assert.ok(
    (out.state.regions[rid]?.unrest ?? 0) < (baseline.state.regions[rid]?.unrest ?? 0),
    '基建落成应立即压低本区动乱',
  );
});

test('基建拒绝面：金不足 / 已满级 都不得产生副作用', () => {
  const { fid, regions } = firstFactionWithRegions(sc.initialState);
  const rid = regions[0]!;
  const poor = clone(sc.initialState);
  // 经济模块先收税；把国库压到远超本回合收入，才能稳定测试"金不足"
  poor.factions[fid]!.gold = -1_000_000;
  const poorOut = run(poor, [order(fid, fid, { kind: 'build_infrastructure', regionId: rid })]);
  assert.equal(poorOut.rejected[0]?.code, 'INSUFFICIENT_GOLD');
  assert.equal(poorOut.state.regions[rid]?.infrastructure, 0);

  const maxed = clone(sc.initialState);
  maxed.regions[rid]!.infrastructure = 4;
  const maxedOut = run(maxed, [order(fid, fid, { kind: 'build_infrastructure', regionId: rid })]);
  assert.equal(maxedOut.rejected[0]?.code, 'INFRASTRUCTURE_MAXED');
  assert.equal(maxedOut.state.regions[rid]?.infrastructure, 4);
});

test('★基建被动效果：本区每回合减动乱、本区人口加速、基建点汇总为全国民心', () => {
  const { fid, regions } = firstFactionWithRegions(sc.initialState);
  const base = clone(sc.initialState);
  const boosted = clone(sc.initialState);
  for (const rid of regions) {
    base.regions[rid]!.unrest = 50;
    boosted.regions[rid]!.unrest = 50;
    boosted.regions[rid]!.infrastructure = 4;
  }
  const baseOut = run(base);
  const boostOut = run(boosted);
  const infra = sc.world.governance!.infrastructure;
  const lv4 = infra.levels.find((l) => l.level === 4)!;

  for (const rid of regions) {
    assert.equal(
      (baseOut.state.regions[rid]?.unrest ?? 0) - (boostOut.state.regions[rid]?.unrest ?? 0),
      lv4.unrestReductionPerTurn,
      `${rid}：基建 Lv4 每回合应多降 ${lv4.unrestReductionPerTurn} 动乱`,
    );
  }

  const expectedGrowth = Math.round(
    regions.reduce((sum, rid) => sum + regionPopulation(sc.world, boosted, rid) * lv4.populationGrowthBonus, 0),
  );
  assert.ok(expectedGrowth > 0, '夹具失效：基建增长应为正');
  assert.equal(
    (boostOut.state.factions[fid]?.manpower ?? 0) - (baseOut.state.factions[fid]?.manpower ?? 0),
    expectedGrowth,
    '基建人口增长必须按各区基建等级分别计算后汇总',
  );

  const expectedMorale = Math.floor((regions.length * lv4.moralePoints) / infra.moralePointsPerTurnPoint);
  assert.ok(expectedMorale > 0, '夹具失效：多个 Lv4 区域应产生至少 1 点民心/回合');
  assert.equal(
    (boostOut.state.factions[fid]?.morale ?? 0) - (baseOut.state.factions[fid]?.morale ?? 0),
    expectedMorale,
    '基建点必须按全国汇总提升全国民心',
  );
  assert.ok(boostOut.deltas.some((d) => d.reason.includes('基建兴农')), '人口增长必须带归因');
  assert.ok(boostOut.deltas.some((d) => d.reason.includes('基建安民')), '民心/动乱必须带归因');
});

// ─────────────────────────────────────────────────────────────
// 低民心 → 征兵/战火动乱放大
// ─────────────────────────────────────────────────────────────

test('★低全国民心放大征兵在本区制造的动乱', () => {
  const { fid, regions } = firstFactionWithRegions(sc.initialState);
  const rid = regions[0]!;
  const landType = Object.keys(sc.world.unitTypes).sort().find(
    (id) => sc.world.unitTypes[id]?.domain !== 'water' && sc.world.unitTypes[id]?.domain !== 'amphibious',
  )!;

  const high = clone(sc.initialState);
  const low = clone(sc.initialState);
  for (const state of [high, low]) {
    state.factions[fid]!.gold = 1_000_000;
    state.factions[fid]!.food = 1_000_000;
    state.factions[fid]!.manpower = 1_000_000;
    state.factions[fid]!.conscriptStreak = 0;
    state.regions[rid]!.unrest = 20;
    for (const r of regions) state.regions[r]!.infrastructure = 0;
  }
  high.factions[fid]!.morale = 70;
  low.factions[fid]!.morale = 20;
  const command = { kind: 'recruit', regionId: rid, unitType: landType, count: 1000 };
  const highOut = run(high, [order(fid, fid, command)]);
  const lowOut = run(low, [order(fid, fid, command)]);
  assert.deepEqual(highOut.rejected, [], JSON.stringify(highOut.rejected));
  assert.deepEqual(lowOut.rejected, [], JSON.stringify(lowOut.rejected));

  const highUnrest = highOut.state.regions[rid]!.unrest;
  const lowUnrest = lowOut.state.regions[rid]!.unrest;
  assert.ok(lowUnrest > highUnrest, `低民心征兵动乱应更高：low=${lowUnrest} high=${highUnrest}`);
  const factor = 1 + ((60 - 20) / 60) * sc.world.governance!.lowMoraleUnrest.maxUnrestBonus;
  const expectedExtra = Math.round(sc.world.governance!.lowMoraleUnrest.recruitBase * factor) -
    sc.world.governance!.lowMoraleUnrest.recruitBase;
  assert.equal(lowUnrest - highUnrest, expectedExtra, '差额必须正好来自低民心放大');
  assert.ok(lowOut.deltas.some((d) => d.reason.includes('征兵扰民（全国民心 20')), '归因里必须写明当前全国民心');
});

test('★低全国民心放大战火动乱，且战斗证据带民心系数与动乱拆分', () => {
  const actions = enumerateLegalActions(sc.initialState, sc.world, firstFactionWithRegions(sc.initialState).fid, { maxActions: 80 });
  const attack = actions.find((a) => a.kind === 'attack' && Number(a.estimate?.['defenderTroops']) > 0);
  assert.ok(attack, '夹具失效：开局应有一场有守军的进攻');
  const attackerId = String(attack.command['unitId']).split('_')[1] ?? '';
  const fid = Object.keys(sc.initialState.factions).find((x) => String(attack.command['unitId']).startsWith(`u_${x}_`))!;
  assert.ok(fid, `无法从 ${String(attack.command['unitId'])} 反推势力`);
  void attackerId;

  const high = clone(sc.initialState);
  const low = clone(sc.initialState);
  high.factions[fid]!.morale = 70;
  low.factions[fid]!.morale = 10;
  const highOut = run(high, [order(fid, fid, attack.command)]);
  const lowOut = run(low, [order(fid, fid, attack.command)]);
  assert.deepEqual(highOut.rejected, [], JSON.stringify(highOut.rejected));
  assert.deepEqual(lowOut.rejected, [], JSON.stringify(lowOut.rejected));
  const [highEv] = combatEvents(highOut);
  const [lowEv] = combatEvents(lowOut);
  assert.ok(highEv && lowEv, '两次进攻都必须产生战斗证据');
  assert.ok(highEv.evidence.unrest && lowEv.evidence.unrest, '证据必须带动乱拆分');
  assert.equal(typeof highEv.evidence.counters?.attackerBonus, 'number', '战斗证据必须带兵种克制加成');
  assert.equal(typeof lowEv.evidence.counters?.defenderBonus, 'number', '战斗证据必须带守方克制加成');
  assert.ok(highEv.evidence.attackerType, '战斗证据必须带攻方兵种');
  assert.ok(
    lowEv.evidence.unrest!.battle > highEv.evidence.unrest!.battle,
    `低民心战火动乱应更高：low=${lowEv.evidence.unrest!.battle} high=${highEv.evidence.unrest!.battle}`,
  );
  assert.ok(lowEv.evidence.unrest!.lowMoraleFactor > 1, '低民心系数应大于 1');
  assert.equal(highEv.evidence.unrest!.lowMoraleFactor, 1, '高民心系数应为 1');
  assert.ok(
    (lowEv.evidence.moraleFactorAttacker ?? 1) < (highEv.evidence.moraleFactorAttacker ?? 1),
    '民心必须真的进入战力系数',
  );
});

test('★地区动乱削弱本区守备（estimateBattle 与结算同一乘数）', () => {
  const { fid } = firstFactionWithRegions(sc.initialState);
  const actions = enumerateLegalActions(sc.initialState, sc.world, fid, { maxActions: 80 });
  const attack = actions.find((a) => a.kind === 'attack' && Number(a.estimate?.['defenderTroops']) > 0);
  assert.ok(attack, '夹具失效');
  const targetRegion = String(attack.command['targetRegion']);
  const unitId = String(attack.command['unitId']);
  const clean = clone(sc.initialState);
  const chaotic = clone(sc.initialState);
  clean.regions[targetRegion]!.unrest = 0;
  chaotic.regions[targetRegion]!.unrest = 100;
  const a = estimateBattle({ state: clean, world: sc.world }, fid, [unitId], targetRegion);
  const b = estimateBattle({ state: chaotic, world: sc.world }, fid, [unitId], targetRegion);
  assert.ok(a.defenderPower > 0, '夹具失效：目标区没有守军');
  assert.ok(b.defenderPower < a.defenderPower, '高动乱的守军战力必须更低');
});

test('★地区动乱降低本区金/粮产出（同一势力、仅动乱不同）', () => {
  const { fid, regions } = firstFactionWithRegions(sc.initialState);
  const clean = clone(sc.initialState);
  const chaotic = clone(sc.initialState);
  for (const rid of regions) {
    clean.regions[rid]!.unrest = 0;
    chaotic.regions[rid]!.unrest = 100;
  }
  const cleanOut = run(clean);
  const chaoticOut = run(chaotic);
  const incomeOf = (out: ReturnType<typeof resolveTurn>): number =>
    out.deltas
      .filter((d) => d.scope === `faction:${fid}` && d.field === 'gold' && d.reason.startsWith('产出+税收'))
      .reduce((s, d) => s + d.delta, 0);
  assert.ok(incomeOf(cleanOut) > incomeOf(chaoticOut), '高动乱区域的金收入必须更低');
  assert.ok(incomeOf(chaoticOut) > 0, '即使 100 动乱也不得把收入压成 0（配置上限约束）');
});

// ─────────────────────────────────────────────────────────────
// 水路：1-2 格突击
// ─────────────────────────────────────────────────────────────

test('★水师沿水路可打 1-2 格，超过 2 格不行', () => {
  const iron = loadScenario('iron-front', 'iron-front-test-seed-0001', 'config');
  const fleet = iron.world.unitTypes['riverfleet']!;
  assert.ok(fleet, '夹具失效：iron-front 缺少 riverfleet');

  assert.equal(isAttackAdjacent(iron.world, fleet, 'b1', 'c3'), true, 'b1→c3 是 2 跳水路，应可突击');
  assert.deepEqual(waterRoutePath(iron.world, 'b1', 'c3', 2), ['b1', 'b3', 'c3']);
  assert.equal(isAttackAdjacent(iron.world, fleet, 'b1', 'c6'), false, 'b1→c6 超过 2 跳，不得隔空突击');

  const acts = enumerateLegalActions(iron.initialState, iron.world, 'north', { maxActions: 80 });
  assert.ok(acts.some((a) => a.id === 'attack:u_north_3:c3'), '合法动作必须列出 2 跳水路突击');
  assert.equal(acts.some((a) => a.id === 'attack:u_north_3:c6'), false, '超过 2 跳不得出现在合法动作里');

  const out = resolveTurn({
    state: iron.initialState,
    world: iron.world,
    modules: buildModules(iron.meta.moduleOrder),
    orders: [order('north', 'north', { kind: 'attack', unitId: 'u_north_3', targetRegion: 'c3' })],
    rootSeed: 'iron-front-test-seed-0001',
    turn: 1,
    now: FIXED_NOW,
    digest,
  });
  assert.equal(out.rejected.some((r) => r.code === 'REGION_NOT_ADJACENT'), false, '2 跳突击不得被判为不相邻');
  const [ev] = combatEvents(out);
  assert.ok(ev, '2 跳突击必须产生战斗证据');
  assert.deepEqual(ev.evidence.attackPath, ['b1', 'b3', 'c3'], '证据里的航线必须是完整 2 跳航线');
});


test('启用治理/编成/外交的剧本也没有未登记的 writes 重叠', () => {
  for (const id of ['random-front-v2', 'iron-front']) {
    const loaded = loadScenario(id, SEED, 'config');
    const conflicts = findUndeclaredWriteConflicts(buildModules(loaded.meta.moduleOrder));
    assert.deepEqual(conflicts, [], `${id} 存在未登记 writes 重叠：${JSON.stringify(conflicts)}`);
  }
});

test('人口口径单一真源：totalPopulation 与 regionPopulation 一致', () => {
  const fid = Object.keys(sc.initialState.factions).sort()[0]!;
  const fromHelper = Object.keys(sc.initialState.regions)
    .filter((rid) => sc.initialState.regions[rid]!.owner === fid)
    .reduce((sum, rid) => {
      const def = sc.world.regions[rid]!;
      const st = sc.initialState.regions[rid]!;
      return sum + regionPopulationOf(def.baseManpower, st.development);
    }, 0);
  assert.equal(totalPopulation(sc.initialState, sc.world, fid), Math.floor(fromHelper));
});
