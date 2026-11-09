/**
 * 国库支出必须真的从国库扣除，且不能在“高收入 + 极值钳制”回合里被 cap 擦掉。
 * 回归现场：基建 400 金、国策 500 金，但非操作局和操作局国库一样（甚至操作局更高），
 * 因为旧 clamp 只看最终值；现在先钳毛收益，再扣真实支出。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import type { GameState } from '../../src/core/state.ts';
import type { AcceptedOrder } from '../../src/core/module.ts';

const SEED = 'economy-costs-0001';
const sc = loadScenario('iron-front', SEED, 'config');
const fid = 'east';
const MODULES = buildModules(sc.meta.moduleOrder);
const digest = (s: GameState): string => sha256(stableStringify(s));

function run(orders: readonly AcceptedOrder[]) {
  return resolveTurn({
    state: sc.initialState,
    world: sc.world,
    modules: MODULES,
    orders,
    rootSeed: SEED,
    turn: sc.initialState.turn,
    now: 0,
    digest,
  });
}
function order(command: Record<string, unknown>, index: number): AcceptedOrder {
  return { seatId: fid, factionId: fid, command, kind: String(command['kind']), index } as AcceptedOrder;
}

test('基建与国策支出在高收入钳制回合仍然真实扣金', () => {
  const actions = enumerateLegalActions(sc.initialState, sc.world, fid, { maxActions: 2000, uncapped: true });
  const build = actions.find((a) => a.kind === 'build_infrastructure');
  const law = actions.find((a) => a.kind === 'set_law' && a.command['lawId'] === 'juntian');
  assert.ok(build, '夹具失效：没有基建动作');
  assert.ok(law, '夹具失效：没有屯田制动作');

  const control = run([]);
  const spent = run([order(build.command, 0), order(law.command, 1)]);
  assert.deepEqual(spent.rejected, []);

  const buildCost = Number(build.estimate?.['goldCost'] ?? 0);
  const lawCost = Number(law.estimate?.['goldCost'] ?? 0);
  assert.ok(buildCost > 0 && lawCost > 0);
  const controlGold = control.state.factions[fid]!.gold;
  const spentGold = spent.state.factions[fid]!.gold;
  assert.equal(controlGold - spentGold, buildCost + lawCost, '操作局国库必须比不操作局少“基建+国策”的成本');
  assert.ok(spentGold < controlGold, '花钱后国库必须低于不操作局（旧版会被 cap 擦成反向）');

  // 成本事件与基建等级都必须落库；不是只在 UI 上显示。
  const ev = spent.events.find((e: any) => e.type === 'infrastructure_completed') as any;
  assert.equal(ev?.goldSpent, buildCost);
  assert.equal(spent.state.regions[build.targetRegion!]?.infrastructure, 1);
  assert.ok(spent.state.factions[fid]!.laws.includes('juntian'));
});

test('国策成本随治下人口增长，且与实际扣款同源', () => {
  const sc2 = loadScenario('warring-states', 'law-cost-by-pop', 'config');
  const costFor = (fid: string): { cost: number; pop: number } => {
    const act = enumerateLegalActions(sc2.initialState, sc2.world, fid, { maxActions: 2000, uncapped: true })
      .find((a) => a.kind === 'set_law' && a.command['lawId'] === 'juntian');
    assert.ok(act, `${fid} 应有屯田制动作`);
    return { cost: Number(act.estimate?.['goldCost']), pop: Number(act.estimate?.['lawPopulation']) };
  };
  const small = costFor('han');
  const large = costFor('qi');
  assert.ok(large.pop > small.pop, '夹具失效：齐国人口应大于韩国');
  assert.ok(large.cost > small.cost, '人口越多的国家颁布同一国策应越贵');
  const expected = (pop: number) => Math.round(500 + (pop / 100000) * 600);
  assert.equal(small.cost, expected(small.pop));
  assert.equal(large.cost, expected(large.pop));
});

test('国库收益不再被极值钳制：屯田的收益必须能兑现', () => {
  const sc2 = loadScenario('iron-front', 'gold-no-clamp', 'config');
  const st: GameState = JSON.parse(JSON.stringify(sc2.initialState)) as GameState;
  (st.factions[fid] as { gold: number }).gold = 1200;
  const out = resolveTurn({
    state: st,
    world: sc2.world,
    modules: buildModules(sc2.meta.moduleOrder),
    orders: [],
    rootSeed: 'gold-no-clamp',
    turn: st.turn,
    now: 0,
    digest,
  });
  assert.equal(
    (out.clamps as any[]).filter((c) => c.field === 'gold').length,
    0,
    '金不能出现在极值钳制记录里',
  );
  const gained = out.state.factions[fid]!.gold - 1200;
  assert.ok(gained > 0, `正常经营应净赚，实得 ${gained}`);
});
