/**
 * 地形经济 / 平民税基 / 变法代价闸门。
 *
 * 锁住：
 *   ① 平地粮产与人口增长高于山地，林地粮产最高但人口增长慢；
 *   ② 税收只按平民人口（总人口 − 兵力）征收，兵越多税越少；
 *   ③ 人口自然增长按区地形加权，且兵力吃光人口时增长为 0；
 *   ④ 新颁布国策一次性扣 5 全国民心，重复提交不得再次扣；
 *   ⑤ 山地/森林情报更贵，城市更便宜；
 *   ⑥ 林地给守军步兵 +15% 守备，骑兵不吃该加成；山地守备高于平地。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildSnapshot } from '../../src/server/room/snapshot.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { estimateBattle } from '../../src/core/modules/combat.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import { lawEnactCost, LAW_ENACT_MORALE_COST, taxMoralePerTurn } from '../../src/core/modules/economy.ts';
import { SPY_GOLD_COST, spyGoldCost } from '../../src/core/modules/statecraft.ts';
import { MapLayoutSchema } from '../../src/protocol/map-layout.ts';
import {
  civilianPopulation,
  terrainTraits,
  totalPopulation,
  type GameState,
  type WorldConfig,
} from '../../src/core/state.ts';
import type { AcceptedOrder } from '../../src/core/module.ts';

const SEED = 'terrain-economy-seed-0001';
const FIXED_NOW = 1_700_000_000_000;
const sc = loadScenario('random-front-v2', SEED, 'config');
const MODULES = buildModules(sc.meta.moduleOrder);
const digest = (state: GameState): string => sha256(stableStringify(state));

function clone<T>(value: T): any {
  return JSON.parse(JSON.stringify(value));
}

function order(seatId: string, factionId: string, command: Record<string, unknown>): AcceptedOrder {
  return { seatId, factionId, command, kind: command['kind'] as string };
}

function run(
  state: GameState,
  commands: readonly AcceptedOrder[] = [],
  world: WorldConfig = sc.world,
): ReturnType<typeof resolveTurn> {
  return resolveTurn({
    state,
    world,
    modules: MODULES,
    orders: commands,
    rootSeed: SEED,
    turn: state.turn,
    now: FIXED_NOW,
    digest,
  });
}

/** 把全地图改成同一地形，隔离地形对经济的影响 */
function worldAs(terrain: string): WorldConfig {
  const w = clone(sc.world);
  for (const def of Object.values(w.regions) as Array<{ terrain: string }>) def.terrain = terrain;
  return w;
}

function deltaSum(
  out: ReturnType<typeof resolveTurn>,
  fid: string,
  field: 'gold' | 'food' | 'manpower' | 'morale',
  reasonPrefix: string,
): number {
  return out.deltas
    .filter(
      (d) =>
        d.scope === `faction:${fid}` &&
        d.field === field &&
        d.reason.startsWith(reasonPrefix),
    )
    .reduce((s, d) => s + d.delta, 0);
}

function firstFactionWithRegions(state: GameState): { fid: string; regions: string[] } {
  for (const fid of Object.keys(state.factions).sort()) {
    const regions = Object.keys(state.regions).filter((rid) => state.regions[rid]?.owner === fid).sort();
    if (regions.length >= 3) return { fid, regions };
  }
  throw new Error('夹具失效：没有拥有 ≥3 个区域的势力');
}

test('★地形：平地粮产/人口增长高于山地，林地粮产最高但人口增长慢', () => {
  const { fid } = firstFactionWithRegions(sc.initialState);
  const base = clone(sc.initialState);
  const outPlains = run(base, [], worldAs('plains'));
  const outForest = run(base, [], worldAs('forest'));
  const outMountain = run(base, [], worldAs('mountain'));

  const food = (out: ReturnType<typeof resolveTurn>): number => deltaSum(out, fid, 'food', '粮草产出');
  const gold = (out: ReturnType<typeof resolveTurn>): number =>
    deltaSum(out, fid, 'gold', '产出+税收');
  const growth = (out: ReturnType<typeof resolveTurn>): number =>
    deltaSum(out, fid, 'manpower', '人口自然增长');

  assert.ok(food(outForest) > food(outPlains), `林地粮产应高于平地：forest=${food(outForest)} plains=${food(outPlains)}`);
  assert.ok(food(outPlains) > food(outMountain), `平地粮产应高于山地：plains=${food(outPlains)} mountain=${food(outMountain)}`);
  assert.ok(gold(outPlains) > gold(outMountain), `平地金收入（含地形产出）应高于山地：plains=${gold(outPlains)} mountain=${gold(outMountain)}`);
  assert.ok(growth(outPlains) > growth(outMountain), `平地人口增长应高于山地：plains=${growth(outPlains)} mountain=${growth(outMountain)}`);
  assert.ok(growth(outForest) < growth(outPlains), `林地人口增长应低于平地：forest=${growth(outForest)} plains=${growth(outPlains)}`);
  assert.equal(growth(outForest) > 0, true, '林地人口仍应增长（不得归零）');
  assert.ok(terrainTraits('mountain').intelCost > terrainTraits('plains').intelCost, '山地情报应更困难');
});

test('★税基只算平民：兵力吃满人口后税收归零', () => {
  const { fid, regions } = firstFactionWithRegions(sc.initialState);
  const base = clone(sc.initialState);
  const pop = totalPopulation(base, sc.world, fid);
  const civilians = civilianPopulation(base, sc.world, fid);
  assert.ok(civilians > 0 && civilians < pop, '夹具失效：初始平民人口应为正');

  const martial = clone(sc.initialState);
  martial.units['u_test_all_in'] = {
    id: 'u_test_all_in',
    ownerId: fid,
    regionId: regions[0],
    typeId: 'militia',
    troops: citizensAsTroops(base, sc.world, fid),
    movedThisTurn: false,
  };
  assert.equal(civilianPopulation(martial, sc.world, fid), 0, '兵力吃满人口后平民人口必须为 0');

  const baseGold = deltaSum(run(base), fid, 'gold', '产出+税收');
  const martialGold = deltaSum(run(martial), fid, 'gold', '产出+税收');
  assert.ok(baseGold > martialGold, `兵越多税收越少：base=${baseGold} martial=${martialGold}`);
});

function citizensAsTroops(state: GameState, world: WorldConfig, fid: string): number {
  // totalPopulation 已 floor；补齐现有兵力后正好等于总人口
  const currentTroops = Object.values(state.units)
    .filter((u) => u.ownerId === fid)
    .reduce((s, u) => s + u.troops, 0);
  return Math.max(0, totalPopulation(state, world, fid) - currentTroops);
}

test('★人口自然增长由平民人口驱动：全民皆兵则零增长', () => {
  const { fid, regions } = firstFactionWithRegions(sc.initialState);
  const martial = clone(sc.initialState);
  martial.units['u_test_all_in'] = {
    id: 'u_test_all_in',
    ownerId: fid,
    regionId: regions[0],
    typeId: 'militia',
    troops: citizensAsTroops(martial, sc.world, fid),
    movedThisTurn: false,
  };
  const growth = deltaSum(run(martial), fid, 'manpower', '人口自然增长');
  assert.equal(growth, 0, '总人口 − 兵力 = 0 时不得再有人口增长');

  const civil = clone(sc.initialState);
  civil.units['u_test_all_in'] = {
    id: 'u_test_all_in',
    ownerId: fid,
    regionId: regions[0],
    typeId: 'militia',
    troops: Math.max(1, Math.floor(citizensAsTroops(civil, sc.world, fid) / 2)),
    movedThisTurn: false,
  };
  assert.ok(deltaSum(run(civil), fid, 'manpower', '人口自然增长') > 0, '仍有平民时人口应继续增长');
});

test('★税率不再无脑选 40%：10/20/30/40 的民心代价逐档递增且真实结算', () => {
  const { fid } = firstFactionWithRegions(sc.initialState);
  const expected: ReadonlyArray<readonly [number, number]> = [
    [0.1, 2], [0.2, 0], [0.3, -4], [0.4, -8],
  ];
  for (const [rate, morale] of expected) {
    const start = clone(sc.initialState);
    start.factions[fid]!.gold = 99999;
    const out = run(start, [order(fid, fid, { kind: 'set_tax', rate })]);
    assert.deepEqual(out.rejected, [], JSON.stringify(out.rejected));
    const taxMorale = out.deltas
      .filter(
        (d) =>
          d.scope === `faction:${fid}` &&
          d.field === 'morale' &&
          (d.reason.includes('轻徭薄赋') || d.reason.includes('加税伤民')),
      )
      .reduce((s, d) => s + d.delta, 0);
    assert.equal(taxMorale, morale, `税率 ${rate * 100}% 的民心变化应为 ${morale}`);
  }
  assert.equal(taxMoralePerTurn(sc.world, 0.25), -2, '连续税率也必须按比例生效');
  assert.equal(taxMoralePerTurn(sc.world, 0.2), 0, '20% 是中性税');
  assert.ok(taxMoralePerTurn(sc.world, 0.4) < taxMoralePerTurn(sc.world, 0.3), '40% 必须比 30% 更伤民心');
  assert.ok(taxMoralePerTurn(sc.world, 0.1) > 0, '10% 必须回民心');
});

test('★颁布国策一次性 −5 全国民心；已生效国策不重复扣', () => {
  const { fid } = firstFactionWithRegions(sc.initialState);
  const start = clone(sc.initialState);
  start.factions[fid]!.gold = 99999;
  const lawId = Object.keys(sc.world.laws)
    .sort()
    .find((id) => !start.factions[fid]!.laws.includes(id));
  assert.ok(lawId, '夹具失效：没有未颁布国策');

  const first = run(start, [order(fid, fid, { kind: 'set_law', lawId, enabled: true })]);
  assert.deepEqual(first.rejected, [], JSON.stringify(first.rejected));
  const moraleDelta = first.deltas.find(
    (d) => d.scope === `faction:${fid}` && d.field === 'morale' && d.reason.includes('变法'),
  );
  assert.equal(moraleDelta?.delta, -LAW_ENACT_MORALE_COST, '变法必须当场扣 5 民心');
  assert.equal(LAW_ENACT_MORALE_COST, 5);

  const second = run(first.state, [order(fid, fid, { kind: 'set_law', lawId, enabled: true })]);
  assert.deepEqual(second.rejected, [], JSON.stringify(second.rejected));
  assert.ok(
    !second.deltas.some((d) => d.scope === `faction:${fid}` && d.field === 'morale' && d.reason.includes('变法')),
    '已生效国策重复提交不得再次扣民心',
  );
});

test('★情报成本随地形：山地最贵、城市最便宜，实际扣款与预估一致', () => {
  const regionOfTerrain = (terrain: string): string =>
    Object.keys(sc.world.regions).sort().find((rid) => sc.world.regions[rid]!.terrain === terrain) ??
    (() => { throw new Error(`夹具失效：地图没有 ${terrain}`); })();
  const mountain = regionOfTerrain('mountain');
  const urban = regionOfTerrain('urban');
  assert.equal(spyGoldCost(sc.world, mountain), Math.round(SPY_GOLD_COST * terrainTraits('mountain').intelCost));
  assert.equal(spyGoldCost(sc.world, urban), Math.round(SPY_GOLD_COST * terrainTraits('urban').intelCost));
  assert.ok(spyGoldCost(sc.world, mountain) > spyGoldCost(sc.world, urban), '山地情报应贵于城市');

  const fid = Object.keys(sc.initialState.factions).sort()
    .find((id) => sc.initialState.regions[mountain]?.owner !== id);
  assert.ok(fid, '夹具失效：找不到可侦察山地的势力');
  const start = clone(sc.initialState);
  start.factions[fid!]!.gold = 99999;
  const out = run(start, [order(fid!, fid!, { kind: 'send_spy', regionId: mountain })]);
  assert.deepEqual(out.rejected, [], JSON.stringify(out.rejected));
  const spent = out.deltas.find(
    (d) => d.scope === `faction:${fid}` && d.field === 'gold' && d.reason.includes('遣间谍'),
  );
  assert.equal(spent?.delta, -spyGoldCost(sc.world, mountain), '实际扣款必须等于地形情报费');
});

test('★林地步兵守备 +15%，骑兵不吃；山地守备高于平地', () => {
  const attackerFid = Object.keys(sc.initialState.factions).sort()[0]!;
  const attackerUnit = Object.values(sc.initialState.units)
    .filter((u) => u.ownerId === attackerFid)
    .sort((a, b) => (a.id < b.id ? -1 : 1))[0]!.id;
  const defender = Object.values(sc.initialState.units)
    .filter((u) => u.ownerId !== attackerFid && sc.initialState.regions[u.regionId]?.owner === u.ownerId)
    .find((u) => {
      const inRegion = Object.values(sc.initialState.units).filter((x) => x.regionId === u.regionId);
      return inRegion.length === 1;
    });
  assert.ok(defender, '夹具失效：找不到单支守军的区域');
  const targetRegion = defender.regionId;
  const state = clone(sc.initialState);
  state.units[defender.id].typeId = 'spearman';

  const worldWith = (terrain: 'plains' | 'forest' | 'mountain', flattenTerrainDef: boolean): WorldConfig => {
    const w = clone(sc.world);
    w.regions[targetRegion].terrain = terrain;
    if (flattenTerrainDef) {
      for (const key of Object.keys(w.combat.terrainModifier)) w.combat.terrainModifier[key].def = 1;
    }
    return w;
  };

  const plains = estimateBattle({ state, world: worldWith('plains', true) }, attackerFid, [attackerUnit], targetRegion);
  const forest = estimateBattle({ state, world: worldWith('forest', true) }, attackerFid, [attackerUnit], targetRegion);
  assert.equal(plains.terrainInfantryDefense, 1, '平地不得给步兵地形加成');
  assert.equal(forest.terrainInfantryDefense, 1.15, '林地应给步兵 +15%');
  const ratio = forest.defenderPower / plains.defenderPower;
  assert.ok(Math.abs(ratio - 1.15) < 0.01, `林地步兵守备应 ×1.15，实际 ×${ratio.toFixed(3)}`);

  const cavalry = clone(state);
  cavalry.units[defender.id].typeId = 'cavalry';
  const cavPlains = estimateBattle({ state: cavalry, world: worldWith('plains', true) }, attackerFid, [attackerUnit], targetRegion);
  const cavForest = estimateBattle({ state: cavalry, world: worldWith('forest', true) }, attackerFid, [attackerUnit], targetRegion);
  assert.equal(cavForest.defenderPower, cavPlains.defenderPower, '骑兵不得吃林地步兵加成');

  const mountain = estimateBattle({ state, world: worldWith('mountain', false) }, attackerFid, [attackerUnit], targetRegion);
  const open = estimateBattle({ state, world: worldWith('plains', false) }, attackerFid, [attackerUnit], targetRegion);
  assert.ok(mountain.defenderPower > open.defenderPower, '山地守备应高于平地');
});

test('★UI 动作说明携带新规则：平民税基 / 变法 −5 民心 / 地形情报费', () => {
  const { fid } = firstFactionWithRegions(sc.initialState);
  const rich = clone(sc.initialState);
  rich.factions[fid]!.gold = 99999;
  const actions = enumerateLegalActions(rich, sc.world, fid, { maxActions: 2000, uncapped: true });

  const taxAction = actions.find((a) => a.kind === 'set_tax');
  assert.ok(taxAction, '夹具失效：没有税率动作');
  assert.equal(
    taxAction.estimate?.['taxPopulation'],
    civilianPopulation(rich, sc.world, fid),
    '税率预估必须按平民人口',
  );
  assert.ok(taxAction.description?.includes('平民人口'), '税率说明必须写明平民税基');

  const lawAction = actions.find((a) => a.kind === 'set_law');
  assert.ok(lawAction, '夹具失效：没有可颁布国策');
  assert.equal(lawAction.estimate?.['moraleCost'], LAW_ENACT_MORALE_COST);
  assert.ok(lawAction.description?.includes('民心 −5'), '国策说明必须写明 −5 民心');
  const lawId = String(lawAction.command['lawId']);
  assert.equal(lawAction.estimate?.['goldCost'], lawEnactCost(sc.world, sc.world.laws[lawId]!, totalPopulation(rich, sc.world, fid)));

  const spyAction = actions.find((a) => a.kind === 'send_spy');
  assert.ok(spyAction, '夹具失效：没有可侦察目标');
  const spyTarget = String(spyAction.command['regionId']);
  assert.equal(spyAction.estimate?.['spyCost'], spyGoldCost(sc.world, spyTarget), '谍报预估必须按目标地形');
});

test('★快照给自己的税率附带民心影响，观战端不得拿到 exact', () => {
  const { fid } = firstFactionWithRegions(sc.initialState);
  const digest = sha256(stableStringify(sc.initialState));
  const base = { state: sc.initialState, world: sc.world, digest, alerts: [], tokenUsed: 0, tokenCap: 1000 };
  const selfSnap = buildSnapshot({ ...base, recipient: fid, viewer: fid });
  const self = selfSnap.factions.find((f) => f.isSelf)!;
  assert.equal(
    self.exact?.taxMoralePerTurn,
    taxMoralePerTurn(sc.world, sc.initialState.factions[fid]!.taxRate),
    '快照必须告诉玩家当前税率的民心影响',
  );
  const spectator = buildSnapshot({ ...base, recipient: 'spectator', viewer: null });
  assert.equal(spectator.factions.some((f) => f.exact !== undefined), false, '观战端不得泄露 exact');
});

test('★地形图鉴随 layout 下发，并被网页与酒馆前端消费', () => {
  const layout = MapLayoutSchema.parse(sc.mapLayout);
  assert.ok(Array.isArray(layout.terrain) && layout.terrain.length >= 6, 'layout.terrain 必须包含地形图鉴');
  const mountain = layout.terrain!.find((t) => t.id === 'mountain')!;
  assert.equal(mountain.food, 0.55);
  assert.equal(mountain.intelCost, 1.8);
  assert.equal(mountain.moveCost, 3, '山地行军消耗必须来自战斗配置');
  const forest = layout.terrain!.find((t) => t.id === 'forest')!;
  assert.equal(forest.infantryDefense, 1.15, '林地步兵守备加成必须随 layout 下发');

  const webApp = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
  assert.match(webApp, /terrainHelpOf/, 'web/app.js 未消费 layout.terrain');
  assert.match(webApp, /步兵守备/, 'web/app.js 未显示步兵守备加成');
  const webMap = readFileSync(new URL('../../web/map-view.js', import.meta.url), 'utf8');
  assert.match(webMap, /地形效果/, '地图 tooltip 未显示地形效果');
  const webCss = readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
  assert.match(webCss, /detail-note--terrain/, 'style.css 缺地形说明样式');

  const ext = readFileSync(new URL('../../extensions/sillytavern-guozhan/index.js', import.meta.url), 'utf8');
  assert.match(ext, /gzhTerrainNote/, '酒馆前端未渲染地形效果');
  const extCss = readFileSync(new URL('../../extensions/sillytavern-guozhan/panel.css', import.meta.url), 'utf8');
  assert.match(extCss, /gzh-terrain-note/, '酒馆面板缺地形说明样式');
});
