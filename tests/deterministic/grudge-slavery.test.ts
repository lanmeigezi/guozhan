/**
 * 潜在恨意 + 鬻奴令 闸门。
 *
 * 锁住：
 *   ① 宣战/毁约/战斗让双方记恨，关系归和平后恨意也不会立刻清零；
 *   ② 贸易政策（free/restricted/embargo）由关系 + 恨意共同决定；
 *   ③ 鬻奴令只能从相邻地块买奴；生成最低级「贼配军」，双方掉民心，卖方掉兵源；
 *   ④ 贼配军每回合制造动乱，且裁军不回兵源、分兵保留头衔、不能与普通部队合兵；
 *   ⑤ 快照把恨意/贸易政策/头衔投影给正确的接收者；
 *   ⑥ 未接入 grudge/slavetrade 的旧剧本不受影响。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import { buildSnapshot } from '../../src/server/room/snapshot.ts';
import {
  getGrudge,
  getRelation,
  GRUDGE_MAX,
  relationKey,
  tradePolicyBetween,
  type GameState,
} from '../../src/core/state.ts';
import { slaveSourceCapacity } from '../../src/core/modules/slavetrade.ts';
import { deriveSelfReview } from '../../src/ai/selfplay.ts';
import type { AcceptedOrder } from '../../src/core/module.ts';
import type { DomainEvent } from '../../src/protocol/events.ts';

const SEED = 'grudge-slavery-seed-0001';
const FIXED_NOW = 1_700_000_000_000;
const CONFIG = 'config';
const sc = loadScenario('grand-front', SEED, CONFIG);
const legacy = loadScenario('warring-states', SEED, CONFIG);
const randomLegacy = loadScenario('random-front-v2', SEED, CONFIG);
const MODULES = buildModules(sc.meta.moduleOrder);
const digest = (state: GameState): string => sha256(stableStringify(state));

function clone<T>(value: T): any {
  return JSON.parse(JSON.stringify(value)) as any;
}

function order(seatId: string, factionId: string, command: Record<string, unknown>): AcceptedOrder {
  return { seatId, factionId, command, kind: command['kind'] as string };
}

function run(state: GameState, commands: readonly AcceptedOrder[] = [], turn = state.turn): ReturnType<typeof resolveTurn> {
  return resolveTurn({
    state,
    world: sc.world,
    modules: MODULES,
    orders: commands,
    rootSeed: SEED,
    turn,
    now: FIXED_NOW,
    digest,
  });
}

function setRelation(state: any, a: string, b: string, kind: string): void {
  const key = relationKey(a, b);
  state.relations[key] = { ...(state.relations[key] ?? {}), kind, sinceTurn: 0 };
}

/** 找一对相邻、能卖出至少 minPerTrade 人的买卖双方 */
function findTradePair(state: GameState): {
  buyer: string;
  seller: string;
  fromRegion: string;
  toRegion: string;
  capacity: number;
} {
  for (const fromRegion of Object.keys(state.regions).sort()) {
    const seller = state.regions[fromRegion]!.owner;
    if (!seller) continue;
    for (const toRegion of [...(sc.world.regions[fromRegion]?.adjacency ?? [])].sort()) {
      const buyer = state.regions[toRegion]?.owner;
      if (!buyer || buyer === seller) continue;
      const capacity = slaveSourceCapacity(state, sc.world, fromRegion, seller);
      if (capacity >= sc.world.slaveTrade!.minPerTrade) {
        return { buyer, seller, fromRegion, toRegion, capacity };
      }
    }
  }
  throw new Error('夹具失效：grand-front 没有相邻且可卖人的势力对');
}

function setupTradeState(): {
  state: GameState;
  pair: ReturnType<typeof findTradePair>;
  action: ReturnType<typeof enumerateLegalActions>[number];
} {
  const state = clone(sc.initialState);
  const pair = findTradePair(state);
  const buyer = state.factions[pair.buyer]!;
  const seller = state.factions[pair.seller]!;
  buyer.gold = 500_000;
  buyer.morale = 70;
  buyer.laws = [sc.world.slaveTrade!.lawId];
  seller.morale = 70;
  seller.manpower = Math.max(seller.manpower, pair.capacity + 50_000);
  setRelation(state, pair.buyer, pair.seller, 'peace');
  const actions = enumerateLegalActions(state, sc.world, pair.buyer, { maxActions: 2000, uncapped: true });
  const action = actions.find(
    (a) => a.kind === 'trade_slaves' &&
      a.command['fromRegion'] === pair.fromRegion &&
      a.command['toRegion'] === pair.toRegion,
  );
  assert.ok(action, '设置国策 + 和平关系后必须出现鬻奴动作');
  return { state, pair, action };
}

test('★grand-front 接入恨意与鬻奴令；旧剧本不出现这些规则', () => {
  assert.equal(sc.world.capabilities?.grudge, true);
  assert.equal(sc.world.capabilities?.slaveTrade, true);
  assert.ok(sc.world.laws['xunu'], 'grand-front 必须有鬻奴令');
  assert.ok(sc.meta.moduleOrder.includes('grudge'));
  assert.ok(sc.meta.moduleOrder.includes('slavetrade'));

  assert.equal(legacy.world.slaveTrade, undefined);
  assert.equal(legacy.world.capabilities?.slaveTrade, undefined);
  assert.equal(legacy.world.laws['xunu'], undefined);
  assert.equal(randomLegacy.world.capabilities?.grudge, undefined, '旧随机图不因新规则改变');
  const oldActs = enumerateLegalActions(legacy.initialState, legacy.world, 'qin', { maxActions: 200 });
  assert.equal(oldActs.some((a) => a.kind === 'trade_slaves'), false);
});

test('★宣战让双方记恨；关系归和平后恨意缓慢冷却而不是清零', () => {
  const state = clone(sc.initialState);
  const ids = Object.keys(state.factions).sort();
  let a = '';
  let b = '';
  for (const x of ids) {
    const y = ids.find((v) => v !== x && getRelation(state, x, v) !== 'war');
    if (y) { a = x; b = y; break; }
  }
  assert.ok(a && b, '夹具失效：找不到可宣战势力');
  const before = getGrudge(state, a, b);
  const declared = run(state, [order('s1', a, { kind: 'diplomacy', to: b, action: 'declare_war' })], 1);
  assert.deepEqual(declared.rejected, []);
  assert.equal(getRelation(declared.state, a, b), 'war');
  assert.ok(getGrudge(declared.state, a, b) > before, '宣战后双方恨意必须上升');
  assert.equal(tradePolicyBetween(declared.state, a, b), 'embargo');
  const entry = declared.state.relations[relationKey(a, b)]!;
  assert.equal(entry.wars, 1, '第一次宣战必须记一次战争');
  const warSnap = buildSnapshot({
    state: declared.state,
    world: sc.world,
    recipient: 's1',
    viewer: a,
    digest: digest(declared.state),
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
  });
  const foe = warSnap.factions.find((f) => f.id === b)!;
  assert.equal(foe.wars, 1, '快照必须暴露历史宣战次数');
  assert.equal(foe.tradePolicy, 'embargo');

  const peaceful = clone(declared.state);
  setRelation(peaceful, a, b, 'peace');
  const cooled = run(peaceful, [], 2);
  const afterPeace = getGrudge(cooled.state, a, b);
  assert.ok(afterPeace < getGrudge(declared.state, a, b), '和平期恨意应缓慢下降');
  assert.ok(afterPeace > 0, '一纸和约不应让恨意归零');
});

test('★鬻奴：生成最低级贼配军，买卖双方掉民心，卖方掉兵源，本区动乱上升', () => {
  const { state, pair, action } = setupTradeState();
  const count = Number(action.command['count']);
  const buyerBefore = state.factions[pair.buyer]!;
  const sellerBefore = state.factions[pair.seller]!;
  const sellerGold = sellerBefore.gold;
  const buyerMorale = buyerBefore.morale;
  const sellerMorale = sellerBefore.morale;
  const unrestBefore = state.regions[pair.toRegion]!.unrest;

  const out = run(state, [order('s1', pair.buyer, action.command)], 1);
  assert.deepEqual(out.rejected, []);
  const unit = Object.values(out.state.units).find((u) => u.title === 'bandit_conscript');
  assert.ok(unit, '必须生成贼配军');
  assert.equal(unit!.typeId, sc.world.slaveTrade!.slaveUnitType, '奴隶只能编为最低级兵种');
  assert.equal(unit!.troops, count);
  assert.equal(unit!.regionId, pair.toRegion);
  const buyDelta = out.deltas.find(
    (d) => d.scope === `faction:${pair.buyer}` && d.field === 'gold' && d.reason.startsWith('买奴'),
  );
  assert.equal(buyDelta?.delta, -Number(action.estimate?.['goldCost']), '买方必须按报价扣金');
  assert.ok(out.state.factions[pair.seller]!.gold > sellerGold, '卖方必须收到金');
  const sellerManpowerDelta = out.deltas.find(
    (d) => d.scope === `faction:${pair.seller}` && d.field === 'manpower' && d.reason.startsWith('鬻奴出口'),
  );
  assert.equal(sellerManpowerDelta?.delta, -count, '卖方必须按奴隶数扣兵源');
  assert.ok(out.state.factions[pair.buyer]!.morale < buyerMorale);
  assert.ok(out.state.factions[pair.seller]!.morale < sellerMorale);
  assert.ok(out.state.regions[pair.toRegion]!.unrest > unrestBefore, '贼配军驻扎必须让本区动乱上升（净增）');
  assert.ok((out.events as DomainEvent[]).some((e) => e.type === 'slaves_traded'));
});

test('鬻奴拒绝面：未立法、非相邻、禁运、人口不足', () => {
  const { state, pair, action } = setupTradeState();
  const base = action.command as Record<string, unknown>;

  const noLaw = clone(state);
  noLaw.factions[pair.buyer]!.laws = [];
  const noLawOut = run(noLaw, [order('s1', pair.buyer, base)], 1);
  assert.equal(noLawOut.rejected[0]?.code, 'LAW_NOT_ENABLED');

  const embargo = clone(state);
  setRelation(embargo, pair.buyer, pair.seller, 'war');
  const embargoOut = run(embargo, [order('s1', pair.buyer, base)], 1);
  assert.equal(embargoOut.rejected[0]?.code, 'SLAVE_TRADE_EMBARGO');

  // 找一块卖方拥有、但与买方目标区不相邻的地
  const buyerRegions = new Set(Object.keys(embargo.regions).filter((rid) => embargo.regions[rid]!.owner === pair.buyer));
  const ownAdj = new Set(sc.world.regions[pair.toRegion]?.adjacency ?? []);
  const far = Object.keys(state.regions)
    .sort()
    .find((rid) => state.regions[rid]!.owner === pair.seller && !ownAdj.has(rid));
  if (far) {
    const notAdjacent = clone(state);
    setRelation(notAdjacent, pair.buyer, pair.seller, 'peace');
    const out = run(notAdjacent, [order('s1', pair.buyer, { ...base, fromRegion: far })], 1);
    assert.equal(out.rejected[0]?.code, 'REGION_NOT_ADJACENT');
  }
  assert.ok(buyerRegions.size > 0);

  const greedy = clone(state);
  greedy.factions[pair.seller]!.manpower = 0;
  const greedyOut = run(greedy, [order('s1', pair.buyer, base)], 1);
  assert.equal(greedyOut.rejected[0]?.code, 'SLAVE_POPULATION_INSUFFICIENT');
});

test('★贼配军：裁军不回兵源、分兵保留头衔、不能和普通部队合兵', () => {
  const { state, pair, action } = setupTradeState();
  const traded = run(state, [order('s1', pair.buyer, action.command)], 1);
  assert.deepEqual(traded.rejected, []);
  const bandit = Object.values(traded.state.units).find((u) => u.title === 'bandit_conscript')!;

  // 裁军：不应出现「裁军归农」的兵源正增量
  const disbanded = run(traded.state, [order('s1', pair.buyer, { kind: 'disband', unitId: bandit.id, count: 1000 })], 2);
  assert.deepEqual(disbanded.rejected, []);
  const manpowerRefund = disbanded.deltas.find(
    (d) => d.scope === `faction:${pair.buyer}` && d.field === 'manpower' && d.reason === '裁军归农',
  );
  assert.equal(manpowerRefund, undefined, '贼配军不是本国平民，裁军不得回兵源');

  // 分兵：新部队必须保留贼配军头衔
  const split = run(traded.state, [order('s1', pair.buyer, { kind: 'split_unit', unitId: bandit.id, count: 1000 })], 2);
  assert.deepEqual(split.rejected, []);
  const spawned = Object.values(split.state.units).find((u) => u.id !== bandit.id && u.title === 'bandit_conscript');
  assert.ok(spawned, '分出的部队必须保留贼配军头衔');

  // 普通民兵与贼配军同区、同兵种，但头衔不同，合兵必须被拒
  const withRegular = clone(traded.state);
  withRegular.units['u_regular_militia'] = {
    id: 'u_regular_militia',
    ownerId: pair.buyer,
    regionId: bandit.regionId,
    typeId: 'militia',
    troops: 500,
    movedThisTurn: false,
  };
  const mergeOut = run(withRegular, [order('s1', pair.buyer, {
    kind: 'merge_units', unitId: bandit.id, targetUnitId: 'u_regular_militia',
  })], 2);
  assert.equal(mergeOut.rejected[0]?.code, 'MALFORMED_PAYLOAD');
});

test('★快照投影：恨意/贸易政策只给对方看，贼配军头衔随驻军下发', () => {
  const { state, pair, action } = setupTradeState();
  setRelation(state, pair.buyer, pair.seller, 'peace');
  (state.relations[relationKey(pair.buyer, pair.seller)] as any).grudge = 42;
  const out = run(state, [order('s1', pair.buyer, action.command)], 1);
  assert.deepEqual(out.rejected, []);
  const snap = buildSnapshot({
    state: out.state,
    world: sc.world,
    recipient: 'seat_buyer',
    viewer: pair.buyer,
    digest: digest(out.state),
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
    maxLegalActions: 200,
  });
  const seller = snap.factions.find((f) => f.id === pair.seller)!;
  assert.ok(typeof seller.grudge === 'number' && seller.grudge > 0);
  assert.ok(['free', 'restricted', 'embargo'].includes(String(seller.tradePolicy)));
  const region = snap.regions.find((r) => r.id === pair.toRegion)!;
  assert.equal(region.stacks?.some((s) => s.title === 'bandit_conscript'), true);
  assert.equal(snap.factions.find((f) => f.id === pair.buyer)!.grudge, undefined, '自己不应带自我恨意');
});

test('恨意上限被钳制在 0-100，关系变更不会丢历史恨意', () => {
  const state = clone(sc.initialState);
  const [a, b] = Object.keys(state.factions).sort() as [string, string];
  state.relations[relationKey(a, b)] = { kind: 'peace', sinceTurn: 0, grudge: GRUDGE_MAX };
  const out = run(state, [order('s1', a, { kind: 'diplomacy', to: b, action: 'declare_war' })], 1);
  assert.equal(getGrudge(out.state, a, b), GRUDGE_MAX);
  assert.equal(out.state.relations[relationKey(a, b)]!.grudge, GRUDGE_MAX);
});

test('★AI 复盘消费恨意：高恨意会生成外交收缩教训', () => {
  const state = clone(sc.initialState);
  const fid = Object.keys(state.factions).sort()[0]!;
  const other = Object.keys(state.factions).sort().find((x) => x !== fid)!;
  state.relations[relationKey(fid, other)] = { kind: 'peace', sinceTurn: 0, grudge: 60 };
  const review = deriveSelfReview({ state, world: sc.world, factionId: fid, aggression: 0.5 });
  assert.ok(
    review.lessons.some((l) => l.includes('潜在恨意')),
    `AI 复盘应把高恨意写进 lessons，实得：${review.lessons.join(' / ')}`,
  );
});
