/**
 * 奴隶贸易模块（可选）—— 鬻奴令的执行面。
 *
 * 规则边界（与 config/scenarios/grand-front/slave-trade.json 对齐）：
 *   · 买方必须已颁布 lawId 指定的国策；
 *   · 只能从**相邻**的卖方地块买入；
 *   · 卖方无需同法，但必须非交战、且未被恨意禁运；
 *   · 买入的人口只能编为最低级兵种（militia），并带 bandit_conscript 头衔；
 *   · 每支贼配军每回合在所在区制造 banditUnrestPerTurn 动乱；
 *   · 买方/卖方都立刻掉全国民心；卖方损失兵源，买方付金。
 *
 * ★旧剧本不注册本模块、也没有 world.slaveTrade ⇒ 不会出现本命令。
 */
import type { FactionId, GameState, RegionId, UnitId, UnitTitle, WorldConfig } from '../state.ts';
import {
  getGrudge,
  getRelation,
  regionPopulation,
  tradePolicyBetween,
  unitsIn,
} from '../state.ts';
import type { AcceptedOrder, ResolveContext, RuleModule, StateSlice } from '../module.ts';

interface TradeSlavesCmd {
  kind: 'trade_slaves';
  fromFaction: FactionId;
  fromRegion: RegionId;
  toRegion: RegionId;
  count: number;
}

export const BANDIT_TITLE: UnitTitle = 'bandit_conscript';

/** 奴隶单价（含关系乘数 + 恨意附加）；legal 预估与模块扣款共用同一函数 */
export function slaveTradePrice(
  state: GameState,
  world: WorldConfig,
  buyer: FactionId,
  seller: FactionId,
  count: number,
): number {
  const cfg = world.slaveTrade;
  if (!cfg || count <= 0) return 0;
  const relation = getRelation(state, buyer, seller);
  const relationMult = cfg.relationPriceMultiplier[relation] ?? 1;
  const grudgeMult = 1 + (getGrudge(state, buyer, seller) / 100) * cfg.grudgePriceSurcharge;
  return Math.max(1, Math.round((count / 1000) * cfg.priceGoldPerThousand * relationMult * grudgeMult));
}

/** 源地块最多可卖多少平民（不含驻军；受单次比例、卖方兵源池限制） */
export function slaveSourceCapacity(
  state: GameState,
  world: WorldConfig,
  fromRegion: RegionId,
  seller: FactionId,
): number {
  const cfg = world.slaveTrade;
  const def = world.regions[fromRegion];
  const st = state.regions[fromRegion];
  if (!cfg || !def || !st) return 0;
  const pop = Math.floor(regionPopulation(def.baseManpower, st.development));
  const garrison = unitsIn(state, fromRegion).reduce((sum, u) => sum + u.troops, 0);
  const civilians = Math.max(0, pop - garrison);
  const perTrade = Math.floor(pop * cfg.maxShareOfRegionPopulation);
  const manpower = state.factions[seller]?.manpower ?? 0;
  return Math.max(0, Math.min(civilians, perTrade, manpower));
}

export const slaveTradeModule: RuleModule = {
  id: 'slavetrade',
  version: 1,
  reads: [
    'regions.owner',
    'regions.unrest',
    'factions.gold',
    'factions.morale',
    'factions.manpower',
    'factions.laws',
    'factions.eliminated',
    'units.regionId',
    'units.troops',
    'relations',
  ] as readonly StateSlice[],
  writes: [
    'regions.unrest',
    'factions.gold',
    'factions.morale',
    'factions.manpower',
    'units.troops',
  ] as readonly StateSlice[],
  commands: ['trade_slaves'],

  resolve(ctx: ResolveContext): void {
    const cfg = ctx.world.slaveTrade;
    if (!cfg) return;
    const sorted = [...ctx.orders]
      .filter((o) => o.kind === 'trade_slaves')
      .sort((a, b) => (a.seatId === b.seatId ? 0 : a.seatId < b.seatId ? -1 : 1));
    for (const order of sorted) {
      handleTrade(ctx, order, order.command as TradeSlavesCmd);
    }
    applyBanditUnrest(ctx);
  },
};

function handleTrade(ctx: ResolveContext, order: AcceptedOrder, cmd: TradeSlavesCmd): void {
  const cfg = ctx.world.slaveTrade!;
  const buyerId = order.factionId;
  const buyer = ctx.state.factions[buyerId];
  const seller = ctx.state.factions[cmd.fromFaction];
  if (!buyer || buyer.eliminated) {
    ctx.reject(order, 'UNKNOWN_FACTION', '买方势力不存在或已灭亡');
    return;
  }
  if (!seller || seller.eliminated) {
    ctx.reject(order, 'UNKNOWN_FACTION', `卖方势力 ${cmd.fromFaction} 不存在或已灭亡`);
    return;
  }
  if (cmd.fromFaction === buyerId) {
    ctx.reject(order, 'SELF_TARGET_NOT_ALLOWED', '不能向自己买奴');
    return;
  }
  if (!buyer.laws.includes(cfg.lawId)) {
    ctx.reject(order, 'LAW_NOT_ENABLED', `未颁布「${cfg.lawId}」，不能参与奴隶贸易`);
    return;
  }
  const own = ctx.state.regions[cmd.toRegion];
  if (!own) {
    ctx.reject(order, 'UNKNOWN_REGION', `买方区域 ${cmd.toRegion} 不存在`);
    return;
  }
  if (own.owner !== buyerId) {
    ctx.reject(order, 'REGION_NOT_OWNED', `买方区域 ${cmd.toRegion} 不属于买方`);
    return;
  }
  const source = ctx.state.regions[cmd.fromRegion];
  if (!source) {
    ctx.reject(order, 'UNKNOWN_REGION', `卖方区域 ${cmd.fromRegion} 不存在`);
    return;
  }
  if (source.owner !== cmd.fromFaction) {
    ctx.reject(order, 'REGION_NOT_OWNED', `卖方区域 ${cmd.fromRegion} 不属于 ${cmd.fromFaction}`);
    return;
  }
  const adjacent =
    (ctx.world.regions[cmd.toRegion]?.adjacency ?? []).includes(cmd.fromRegion) ||
    (ctx.world.regions[cmd.fromRegion]?.adjacency ?? []).includes(cmd.toRegion);
  if (!adjacent) {
    ctx.reject(order, 'REGION_NOT_ADJACENT', `奴隶贸易只限相邻地块：${cmd.toRegion} 与 ${cmd.fromRegion} 不相邻`);
    return;
  }
  const policy = tradePolicyBetween(ctx.state, buyerId, cmd.fromFaction, cfg.grudgeBlock);
  if (policy === 'embargo') {
    ctx.reject(
      order,
      'SLAVE_TRADE_EMBARGO',
      `与 ${seller.name} 的贸易政策为禁运（关系 ${getRelation(ctx.state, buyerId, cmd.fromFaction)}，潜在恨意 ${getGrudge(ctx.state, buyerId, cmd.fromFaction)}）`,
    );
    return;
  }
  if (!Number.isInteger(cmd.count) || cmd.count < cfg.minPerTrade || cmd.count > cfg.maxPerTrade) {
    ctx.reject(
      order,
      'MALFORMED_PAYLOAD',
      `买奴数量必须是 ${cfg.minPerTrade}–${cfg.maxPerTrade} 的整数，实得 ${cmd.count}`,
    );
    return;
  }
  const capacity = slaveSourceCapacity(ctx.state, ctx.world, cmd.fromRegion, cmd.fromFaction);
  if (cmd.count > capacity) {
    ctx.reject(
      order,
      'SLAVE_POPULATION_INSUFFICIENT',
      `卖方地块可卖人口不足：需要 ${cmd.count}，最多 ${capacity}（不含驻军，且不超过本区人口 ${Math.round(cfg.maxShareOfRegionPopulation * 100)}% 与卖方兵源）`,
    );
    return;
  }
  const price = slaveTradePrice(ctx.state, ctx.world, buyerId, cmd.fromFaction, cmd.count);
  if (buyer.gold < price) {
    ctx.reject(order, 'INSUFFICIENT_GOLD', `买奴需 ${price} 金，现有 ${buyer.gold}`);
    return;
  }

  ctx.mutate({ op: 'add_faction_gold', factionId: buyerId, delta: -price, reason: `买奴 ${cmd.count}（向 ${seller.name}）` });
  ctx.mutate({ op: 'add_faction_gold', factionId: cmd.fromFaction, delta: price, reason: `鬻奴 ${cmd.count}（售予 ${buyer.name}）` });
  ctx.mutate({ op: 'add_faction_manpower', factionId: cmd.fromFaction, delta: -cmd.count, reason: `鬻奴出口 ${cmd.count}` });
  if (cfg.buyerMoraleCost > 0) {
    ctx.mutate({ op: 'add_faction_morale', factionId: buyerId, delta: -cfg.buyerMoraleCost, reason: '鬻奴失德（买方）' });
  }
  if (cfg.sellerMoraleCost > 0) {
    ctx.mutate({ op: 'add_faction_morale', factionId: cmd.fromFaction, delta: -cfg.sellerMoraleCost, reason: '鬻奴失德（卖方）' });
  }
  const unitId = slaveUnitId(buyerId, ctx.turn, cmd.toRegion);
  const existing = ctx.state.units[unitId];
  if (existing) {
    ctx.mutate({ op: 'add_unit_troops', unitId, delta: cmd.count, reason: '补充贼配军' });
  } else {
    ctx.mutate({
      op: 'spawn_unit',
      unitId,
      ownerId: buyerId,
      regionId: cmd.toRegion,
      typeId: cfg.slaveUnitType,
      troops: cmd.count,
      title: BANDIT_TITLE,
    });
  }
  ctx.emit({
    type: 'slaves_traded',
    turn: ctx.turn,
    buyer: buyerId,
    seller: cmd.fromFaction,
    fromRegion: cmd.fromRegion,
    toRegion: cmd.toRegion,
    count: cmd.count,
    gold: price,
    buyerMoraleCost: cfg.buyerMoraleCost,
    sellerMoraleCost: cfg.sellerMoraleCost,
    title: BANDIT_TITLE,
    banditUnrestPerTurn: cfg.banditUnrestPerTurn,
  });
}

/** 同回合多笔买奴会合并到同一支贼配军，ID 必须确定性派生 */
export function slaveUnitId(buyer: FactionId, turn: number, toRegion: RegionId): UnitId {
  return `u_${buyer}_${turn}_${toRegion}_slave`;
}

function applyBanditUnrest(ctx: ResolveContext): void {
  const cfg = ctx.world.slaveTrade;
  if (!cfg || cfg.banditUnrestPerTurn <= 0) return;
  const perRegion = new Map<RegionId, number>();
  for (const u of Object.values(ctx.state.units)) {
    if (u.title !== BANDIT_TITLE || u.troops <= 0) continue;
    perRegion.set(u.regionId, (perRegion.get(u.regionId) ?? 0) + cfg.banditUnrestPerTurn);
  }
  for (const [regionId, amount] of [...perRegion.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!ctx.state.regions[regionId] || amount <= 0) continue;
    ctx.mutate({ op: 'add_region_unrest', regionId, delta: amount, reason: '贼配军扰民' });
  }
}

/** 供 UI/合法动作显示：某区域的贼配军每回合额外动乱 */
export function banditUnrestInRegion(state: GameState, world: WorldConfig, regionId: RegionId): number {
  const cfg = world.slaveTrade;
  if (!cfg) return 0;
  let units = 0;
  for (const u of Object.values(state.units)) {
    if (u.regionId === regionId && u.title === BANDIT_TITLE && u.troops > 0) units += 1;
  }
  return units * cfg.banditUnrestPerTurn;
}
