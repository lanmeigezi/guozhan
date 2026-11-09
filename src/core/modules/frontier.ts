/**
 * 开荒模块（可选，当前 frontier 剧本）。
 *
 * 规则：空白地块有原住民（neutral garrison）和少量资金。部队进入该地块后，
 * 提交 settle_region 即“完成一次基建 Lv1”并占领：
 *   · 需要本方在该地块有部队，兵力 ≥ 原住民 × nativeTroopRatio；
 *   · 支付 settleGoldCost / settleFoodCost；
 *   · 原住民守军被吸收，按 nativeManpowerRatio 转化为兵源；
 *   · 获得地块的小额资金（baseGold × lootGoldRatio）；
 *   · 区域 owner=fid，基建直接到 settledInfrastructure。
 *
 * ★普通进攻不能占领开荒地块（combat 会拦截夺城）；必须先进入再开荒。
 */
import type { FactionId, RegionId } from '../state.ts';
import { unitsIn } from '../state.ts';
import type { AcceptedOrder, ResolveContext, RuleModule, StateSlice } from '../module.ts';

interface SettleCmd { kind: 'settle_region'; regionId: RegionId }

export const frontierModule: RuleModule = {
  id: 'frontier',
  version: 1,
  reads: [
    'regions.owner',
    'regions.infrastructure',
    'factions.gold',
    'factions.food',
    'factions.manpower',
    'units.regionId',
    'units.troops',
  ] as readonly StateSlice[],
  writes: [
    'regions.owner',
    'regions.infrastructure',
    'factions.gold',
    'factions.food',
    'factions.manpower',
    'units.troops',
  ] as readonly StateSlice[],
  commands: ['settle_region'],

  resolve(ctx: ResolveContext): void {
    const cfg = ctx.world.frontier;
    if (!cfg) return;
    const sorted = [...ctx.orders]
      .filter((o) => o.kind === 'settle_region')
      .sort((a, b) => (a.seatId === b.seatId ? 0 : a.seatId < b.seatId ? -1 : 1));
    for (const order of sorted) handleSettle(ctx, order, order.command as SettleCmd);
  },
};

function handleSettle(ctx: ResolveContext, order: AcceptedOrder, cmd: SettleCmd): void {
  const cfg = ctx.world.frontier!;
  const fid = order.factionId;
  const faction = ctx.state.factions[fid];
  if (!faction || faction.eliminated) {
    ctx.reject(order, 'UNKNOWN_FACTION', '势力不存在或已灭亡');
    return;
  }
  const st = ctx.state.regions[cmd.regionId];
  const def = ctx.world.regions[cmd.regionId];
  if (!st || !def) {
    ctx.reject(order, 'UNKNOWN_REGION', `区域 ${cmd.regionId} 不存在`);
    return;
  }
  if (st.owner !== null) {
    ctx.reject(order, 'REGION_NOT_OWNED', `${cmd.regionId} 已被 ${st.owner} 占领，不能开荒`);
    return;
  }
  if (st.rebellion) {
    ctx.reject(order, 'REBELLION_NOT_ACTIVE', `${cmd.regionId} 是起义区，不能开荒`);
    return;
  }
  const ownUnits = unitsIn(ctx.state, cmd.regionId, fid).filter((u) => u.troops > 0);
  if (ownUnits.length === 0) {
    ctx.reject(order, 'FRONTIER_NO_TROOPS', `开荒需要先派兵进入 ${cmd.regionId}`);
    return;
  }
  if (!ownUnits.some((u) => !u.movedThisTurn)) {
    ctx.reject(order, 'FRONTIER_NEEDS_NEXT_TURN', `${cmd.regionId} 的部队本回合刚移动，派兵与开荒必须分两回合`);
    return;
  }
  const neutralUnits = unitsIn(ctx.state, cmd.regionId, 'neutral').filter((u) => u.troops > 0);
  const natives = neutralUnits.reduce((sum, u) => sum + u.troops, 0);
  const ownTroops = ownUnits.reduce((sum, u) => sum + u.troops, 0);
  const needed = Math.ceil(natives * cfg.nativeTroopRatio);
  if (ownTroops < needed) {
    ctx.reject(
      order,
      'FRONTIER_TROOPS_TOO_LOW',
      `开荒需要至少 ${needed} 兵压制 ${natives} 原住民（当前 ${ownTroops}）`,
    );
    return;
  }
  const others = unitsIn(ctx.state, cmd.regionId).filter((u) => u.ownerId !== fid && u.ownerId !== 'neutral');
  if (others.length > 0) {
    ctx.reject(order, 'FRONTIER_CONTESTED', `${cmd.regionId} 有其他势力的部队，先解决争端再开荒`);
    return;
  }
  if (faction.gold < cfg.settleGoldCost) {
    ctx.reject(order, 'INSUFFICIENT_GOLD', `开荒需 ${cfg.settleGoldCost} 金，现有 ${faction.gold}`);
    return;
  }
  if (faction.food < cfg.settleFoodCost) {
    ctx.reject(order, 'INSUFFICIENT_FOOD', `开荒需 ${cfg.settleFoodCost} 粮，现有 ${faction.food}`);
    return;
  }

  const loot = Math.round(def.baseGold * cfg.lootGoldRatio);
  const manpower = Math.round(natives * cfg.nativeManpowerRatio);
  ctx.mutate({ op: 'add_faction_gold', factionId: fid, delta: -cfg.settleGoldCost, reason: `开荒 ${cmd.regionId}` });
  ctx.mutate({ op: 'add_faction_food', factionId: fid, delta: -cfg.settleFoodCost, reason: `开荒 ${cmd.regionId}` });
  if (loot > 0) {
    ctx.mutate({ op: 'add_faction_gold', factionId: fid, delta: loot, reason: `开荒获得原住民资金（${cmd.regionId}）` });
  }
  if (manpower > 0) {
    ctx.mutate({ op: 'add_faction_manpower', factionId: fid, delta: manpower, reason: `原住民归化（${cmd.regionId}）` });
  }
  for (const u of neutralUnits) {
    ctx.mutate({ op: 'destroy_unit', unitId: u.id, reason: '原住民归化' });
  }
  ctx.mutate({ op: 'set_region_owner', regionId: cmd.regionId, owner: fid });
  ctx.mutate({ op: 'set_region_infrastructure', regionId: cmd.regionId, infrastructure: cfg.settledInfrastructure });
  ctx.emit({
    type: 'frontier_settled',
    turn: ctx.turn,
    regionId: cmd.regionId,
    factionId: fid,
    natives,
    manpower,
    lootGold: loot,
    goldCost: cfg.settleGoldCost,
    foodCost: cfg.settleFoodCost,
    infrastructure: cfg.settledInfrastructure,
  });
}
