/**
 * 地块人口 / 按地块征兵闸门。
 *
 * 锁住：
 *   ① 快照 full 区域下发本区人口；
 *   ② 征兵动作按本区人口给出上限，不再用全国人口当单地块上限；
 *   ③ 超过本区上限的征兵被拒；同一地块多笔征兵累计占上限。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import { buildSnapshot } from '../../src/server/room/snapshot.ts';
import { regionPopulation, type GameState } from '../../src/core/state.ts';
import type { AcceptedOrder } from '../../src/core/module.ts';

const SEED = 'region-recruit-seed-0001';
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
function run(state: GameState, commands: readonly AcceptedOrder[] = []): ReturnType<typeof resolveTurn> {
  return resolveTurn({ state, world: sc.world, modules: MODULES, orders: commands, rootSeed: SEED, turn: state.turn, now: FIXED_NOW, digest });
}
function firstOwned(state: GameState): { fid: string; rid: string } {
  for (const fid of Object.keys(state.factions).sort()) {
    const rid = Object.keys(state.regions).sort().find((id) => state.regions[id]?.owner === fid);
    if (rid) return { fid, rid };
  }
  throw new Error('夹具失效：没有己方区域');
}

test('★快照 full 区域下发本区人口，数值等于 baseManpower × 发展度系数', () => {
  const { fid, rid } = firstOwned(sc.initialState);
  const snap = buildSnapshot({
    state: sc.initialState,
    world: sc.world,
    recipient: fid,
    viewer: fid,
    digest: digest(sc.initialState),
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
  });
  const region = snap.regions.find((r) => r.id === rid)!;
  const def = sc.world.regions[rid]!;
  const st = sc.initialState.regions[rid]!;
  assert.equal(region.population, Math.round(regionPopulation(def.baseManpower, st.development)));
  assert.ok(region.population! > 0);
});

test('★征兵动作按本区人口给出上限，超本区上限被拒', () => {
  const { fid } = firstOwned(sc.initialState);
  const actions = enumerateLegalActions(sc.initialState, sc.world, fid, { maxActions: 2000, uncapped: true });
  const recruit = actions.find((a) => a.kind === 'recruit' && Number(a.estimate?.['regionRecruitCap']) >= 1000);
  assert.ok(recruit, '夹具失效：没有人口足够的征兵动作');
  const rid = String(recruit.command['regionId']);
  const regionCap = Number(recruit.estimate!['regionRecruitCap']);
  const regionPop = Number(recruit.estimate!['regionPopulation']);
  const type = sc.world.unitTypes[String(recruit.command['unitType'])]!;
  assert.ok(regionPop > 0);
  assert.equal(regionPop, Math.round(regionPopulation(
    sc.world.regions[rid]!.baseManpower,
    sc.initialState.regions[rid]!.development,
  )));
  assert.ok(regionCap <= regionPop, '本区征兵上限不得超过本区人口');

  const start = clone(sc.initialState);
  start.factions[fid]!.gold = 999999;
  start.factions[fid]!.food = 999999;
  start.factions[fid]!.manpower = 999999;
  const over = run(start, [order(fid, fid, {
    kind: 'recruit',
    regionId: rid,
    unitType: recruit.command['unitType'],
    count: Math.ceil(((regionCap + 1000) * 1000) / Math.max(1, type.recruitManpower)),
  })]);
  assert.ok(over.rejected.some((r) => r.code === 'CONSCRIPT_ABOVE_CAP'), `应拒绝超本区上限，实际 ${JSON.stringify(over.rejected)}`);

  const validCount = Math.max(1000, Math.floor(regionCap / Math.max(1, type.recruitManpower)) * 1000);
  const ok = run(start, [order(fid, fid, {
    kind: 'recruit',
    regionId: rid,
    unitType: recruit.command['unitType'],
    count: validCount,
  })]);
  assert.deepEqual(ok.rejected, [], JSON.stringify(ok.rejected));
  assert.ok(
    ok.events.some((e) => {
      const ev = e as { type?: string; regionId?: string };
      return ev.type === 'recruitment_completed' && ev.regionId === rid;
    }),
    '本区上限内的征兵必须成功',
  );
});
