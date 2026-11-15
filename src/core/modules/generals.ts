/**
 * 将领模块（可选，只有声明 knowledge.generalsFile 的剧本才启用）。
 *
 * 职责边界（刻意收得很窄，避免和别的模块抢状态切片）：
 *   · 只认领 `assign_general` 命令，只写 `units.generalId` 这一片新切片；
 *   · 战力/行军加成是**纯查询**（src/core/state.ts 的 generalCombatMultiplier /
 *     generalMovementBudget），由 combat / movement / legal 在读的时候算，不改状态；
 *   · 所以本模块与任何既有模块都没有写重叠，旧剧本行为逐字不变。
 *
 * ★三条史料纪律（docs/research/02-histrategy.md 记下的 Histrategy 数值禁区）：
 *   1. 名册是不可变内容，只收史料可考的真实人物，不凭空创造武将；
 *   2. 将领随建制走：部队被歼 / 被合并即退场，不复活（GENERAL_NOT_IN_SERVICE）；
 *   3. 一名将领只带一军，核心的 set_unit_general 变更会先从其它部队摘掉同一 id。
 */
import type { FactionId, GeneralId, UnitId } from '../state.ts';
import type { AcceptedOrder, ResolveContext, RuleModule, StateSlice } from '../module.ts';

interface AssignGeneralCmd {
  kind: 'assign_general';
  generalId: GeneralId;
  unitId: UnitId;
}

export const generalsModule: RuleModule = {
  id: 'generals',
  version: 1,
  reads: ['units.generalId', 'units.ownerId', 'units.regionId'] as readonly StateSlice[],
  writes: ['units.generalId'] as readonly StateSlice[],
  commands: ['assign_general'],

  resolve(ctx: ResolveContext): void {
    if (!ctx.world.generals) return;
    const orders = [...ctx.orders]
      .filter((o) => o.kind === 'assign_general')
      .sort((a, b) => (a.seatId === b.seatId ? 0 : a.seatId < b.seatId ? -1 : 1));
    for (const order of orders) handleAssign(ctx, order, order.command as AssignGeneralCmd);
  },
};

function handleAssign(ctx: ResolveContext, order: AcceptedOrder, cmd: AssignGeneralCmd): void {
  const fid: FactionId = order.factionId;
  const roster = ctx.world.generals!;
  const g = roster[cmd.generalId];
  if (!g) {
    ctx.reject(order, 'UNKNOWN_GENERAL', `将领名册里没有 ${cmd.generalId}`);
    return;
  }
  if (g.factionId !== fid) {
    ctx.reject(order, 'GENERAL_NOT_OWNED', `${g.name} 属于 ${g.factionId}，不能由 ${fid} 任命`);
    return;
  }

  // 将领必须"还在编"：随原建制被歼 / 被合并后不能复活
  const inService = Object.values(ctx.state.units).find(
    (u) => u.generalId === cmd.generalId && u.ownerId === fid,
  );
  if (!inService) {
    ctx.reject(order, 'GENERAL_NOT_IN_SERVICE', `${g.name} 已随原建制退场，不能再任命`);
    return;
  }

  const target = ctx.state.units[cmd.unitId];
  if (!target) {
    ctx.reject(order, 'UNKNOWN_UNIT', `部队 ${cmd.unitId} 不存在`);
    return;
  }
  if (target.ownerId !== fid) {
    ctx.reject(order, 'UNIT_NOT_OWNED', `部队 ${cmd.unitId} 不属于 ${fid}`);
    return;
  }
  if (target.generalId && target.generalId !== cmd.generalId) {
    const other = roster[target.generalId];
    ctx.reject(
      order,
      'MALFORMED_PAYLOAD',
      `部队 ${cmd.unitId} 已由 ${other?.name ?? target.generalId} 统率；请先把他调到别的部队`,
    );
    return;
  }
  if (inService.id === cmd.unitId) return; // 幂等：本来就带这支军队

  ctx.mutate({ op: 'set_unit_general', unitId: cmd.unitId, generalId: cmd.generalId });
  ctx.emit({
    type: 'general_assigned',
    turn: ctx.turn,
    factionId: fid,
    generalId: cmd.generalId,
    generalName: g.name,
    unitId: cmd.unitId,
    fromUnitId: inService.id,
    regionId: target.regionId,
  });
}
