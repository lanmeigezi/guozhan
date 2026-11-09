/**
 * 编成模块 —— 分兵 / 合兵。
 *
 * 规则边界：
 *   · 分兵只能在同一区域、同一兵种内拆出 count 兵；不能把部队拆到 0；
 *   · 合兵要求同区、同兵种；把 source 全部并入 target，source 从地图移除；
 *   · 新 unit id 由引擎按「原 id + _sN / 短 id」确定性派生，禁止计数器或随机后缀，
 *     否则同输入重放会生成不同 id。
 */
import type { FactionId, UnitId } from '../state.ts';
import type { AcceptedOrder, ResolveContext, RuleModule, StateSlice } from '../module.ts';

interface SplitCmd { kind: 'split_unit'; unitId: UnitId; count: number }
interface MergeCmd { kind: 'merge_units'; unitId: UnitId; targetUnitId: UnitId }

export const formationModule: RuleModule = {
  id: 'formation',
  version: 1,
  reads: ['units.troops', 'units.regionId', 'units.typeId'] as readonly StateSlice[],
  writes: ['units.troops'] as readonly StateSlice[],
  commands: ['split_unit', 'merge_units'],

  resolve(ctx: ResolveContext): void {
    const sorted = [...ctx.orders]
      .filter((o) => formationModule.commands.includes(o.kind))
      .sort((a, b) => (a.seatId === b.seatId ? 0 : a.seatId < b.seatId ? -1 : 1));
    for (const order of sorted) {
      if (order.kind === 'split_unit') handleSplit(ctx, order, order.command as SplitCmd);
      else if (order.kind === 'merge_units') handleMerge(ctx, order, order.command as MergeCmd);
    }
  },
};

function handleSplit(ctx: ResolveContext, order: AcceptedOrder, cmd: SplitCmd): void {
  const fid: FactionId = order.factionId;
  const unit = ctx.state.units[cmd.unitId];
  if (!unit || unit.ownerId !== fid) {
    ctx.reject(order, 'UNIT_NOT_OWNED', `部队 ${cmd.unitId} 不属于 ${fid}`);
    return;
  }
  if (!Number.isInteger(cmd.count) || cmd.count < 1 || cmd.count >= unit.troops) {
    ctx.reject(order, 'MALFORMED_PAYLOAD', `分兵数量必须是 1..${unit.troops - 1}，实得 ${cmd.count}`);
    return;
  }
  if (unit.garrisonOnly) {
    ctx.reject(order, 'GARRISON_LOCKED', '守城民兵不可分兵');
    return;
  }
  const newUnitId = deriveSplitId(ctx, unit.ownerId, ctx.turn, cmd.unitId);
  if (newUnitId === null) {
    ctx.reject(order, 'MALFORMED_PAYLOAD', '无法为新部队分配唯一 id（同一部队拆分次数过多）');
    return;
  }
  ctx.mutate({ op: 'add_unit_troops', unitId: cmd.unitId, delta: -cmd.count, reason: `分兵 ${newUnitId}` });
  ctx.mutate({
    op: 'spawn_unit',
    unitId: newUnitId,
    ownerId: unit.ownerId,
    regionId: unit.regionId,
    typeId: unit.typeId,
    troops: cmd.count,
    movedThisTurn: unit.movedThisTurn,
    ...(unit.title !== undefined ? { title: unit.title } : {}),
  });
  ctx.emit({
    type: 'units_split',
    turn: ctx.turn,
    factionId: unit.ownerId,
    unitId: cmd.unitId,
    newUnitId,
    regionId: unit.regionId,
    count: cmd.count,
    remaining: unit.troops - cmd.count,
  });
}

function handleMerge(ctx: ResolveContext, order: AcceptedOrder, cmd: MergeCmd): void {
  const fid: FactionId = order.factionId;
  const source = ctx.state.units[cmd.unitId];
  const target = ctx.state.units[cmd.targetUnitId];
  if (!source || source.ownerId !== fid) {
    ctx.reject(order, 'UNIT_NOT_OWNED', `部队 ${cmd.unitId} 不属于 ${fid}`);
    return;
  }
  if (!target || target.ownerId !== fid) {
    ctx.reject(order, 'UNIT_NOT_OWNED', `目标部队 ${cmd.targetUnitId} 不属于 ${fid}`);
    return;
  }
  if (source.id === target.id) {
    ctx.reject(order, 'SELF_TARGET_NOT_ALLOWED', '不能把部队并入自己');
    return;
  }
  if (source.regionId !== target.regionId) {
    ctx.reject(order, 'MALFORMED_PAYLOAD', '只能在同区域合兵');
    return;
  }
  if (source.garrisonOnly || target.garrisonOnly) {
    ctx.reject(order, 'GARRISON_LOCKED', '守城民兵不可合兵');
    return;
  }
  if (source.typeId !== target.typeId) {
    ctx.reject(order, 'MALFORMED_PAYLOAD', '只能合并同兵种部队');
    return;
  }
  if ((source.title ?? null) !== (target.title ?? null)) {
    ctx.reject(order, 'MALFORMED_PAYLOAD', '「贼配军」不能与普通部队合兵（头衔不同）');
    return;
  }
  const total = target.troops + source.troops;
  ctx.mutate({ op: 'add_unit_troops', unitId: target.id, delta: source.troops, reason: `合兵 ${source.id}` });
  ctx.mutate({ op: 'destroy_unit', unitId: source.id, reason: `并入 ${target.id}` });
  ctx.emit({
    type: 'units_merged',
    turn: ctx.turn,
    factionId: source.ownerId,
    fromUnitId: source.id,
    intoUnitId: target.id,
    regionId: target.regionId,
    count: source.troops,
    total,
  });
}

/** 新部队 id 必须确定性：优先在原 id 后加 _sN，过长则退回落短 id；找不到则 null */
export function deriveSplitId(ctx: ResolveContext, ownerId: FactionId, turn: number, baseId: UnitId): UnitId | null {
  // 两轮都设硬上限：否则当所有候选 id 都被占用/超过 64 字符时，
  // 第二轮的循环条件永远不会改变，会无限空转。
  const MAX_ATTEMPTS = 1000;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const candidate = `${baseId}_s${n}`;
    if (candidate.length > 64) break;
    if (!ctx.state.units[candidate]) return candidate;
  }
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const candidate = `u_${ownerId}_${turn}_s${n}`;
    if (candidate.length > 64) break;
    if (!ctx.state.units[candidate]) return candidate;
  }
  return null;
}

