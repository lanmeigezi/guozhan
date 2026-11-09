/**
 * 移动模块 —— 邻接图上的 Dijkstra 最短路径 + 通行权规则。
 *
 * 地形移动成本取自 world.combat.terrainModifier[t].mov（单一数据源，避免两处配置漂移）。
 * ★路径搜索有节点上限（movement.pathSearchMaxNodes），防止恶意/错误命令导致 CPU 打满。
 * ★遍历邻居时一律用已排序的 adjacency，保证同输入同路径（平局时的选择也确定）。
 */
import type { FactionId, GameState, RegionId, UnitDomain, UnitTypeDef, WorldConfig } from '../state.ts';
import { getRelation, isAttackAdjacent, unitsIn } from '../state.ts';
import type { AcceptedOrder, ResolveContext, RuleModule, StateSlice } from '../module.ts';

interface MoveCmd {
  kind: 'move_units' | 'attack';
  unitId: string;
  toRegion?: RegionId;
  /** attack + moveTo：先机动到该区再进攻 targetRegion */
  moveTo?: RegionId;
  targetRegion?: RegionId;
}

export interface PathResult {
  readonly path: readonly RegionId[];
  readonly cost: number;
}

function terrainCost(world: WorldConfig, regionId: RegionId): number {
  const def = world.regions[regionId];
  if (!def) return Number.POSITIVE_INFINITY;
  const mod = world.combat.terrainModifier[def.terrain];
  return mod?.mov ?? 1;
}

/**
 * 某区域出发的一步移动选项。
 *   · 陆军：普通邻接 + 地形成本（与旧版完全一致，邻接已排序）
 *   · 水师：**只有**水路，成本取 route.cost（跨多条水路即一回合多格）
 *   · 两栖：两者取更便宜的一条；同价按目标 id 排序，保证确定性
 */
function stepOptions(
  world: WorldConfig,
  regionId: RegionId,
  domain: UnitDomain,
): Array<{ to: RegionId; cost: number }> {
  const best = new Map<RegionId, number>();
  if (domain !== 'water') {
    for (const next of world.regions[regionId]?.adjacency ?? []) {
      const cost = terrainCost(world, next);
      if (Number.isFinite(cost)) best.set(next, cost);
    }
  }
  if (domain === 'water' || domain === 'amphibious') {
    for (const route of world.waterRoutes) {
      const next = route.a === regionId ? route.b : route.b === regionId ? route.a : null;
      if (next === null) continue;
      const known = best.get(next);
      if (known === undefined || route.cost < known) best.set(next, route.cost);
    }
  }
  return [...best.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([to, cost]) => ({ to, cost }));
}

export interface FindPathOptions {
  /** 缺省按陆军处理（旧调用方行为不变） */
  readonly unitType?: UnitTypeDef;
  /** 终点单独判定（进攻时终点是敌区，穿越规则不适用） */
  readonly isTargetPassable?: (r: RegionId) => boolean;
}

/** 该势力能否**穿越**（不含终点）某区域 */
export function canPassThrough(
  state: GameState,
  world: WorldConfig,
  mover: FactionId,
  regionId: RegionId,
): boolean {
  const def = world.regions[regionId];
  if (!def || !def.passable) return false;
  const owner = state.regions[regionId]?.owner ?? null;
  if (owner === null) {
    // 起义区不是中立通途：只能由原属国进攻，不能行军穿过
    if (state.regions[regionId]?.rebellion) return false;
    // 开荒地块被其他势力先占时，不能穿过/共占
    if (world.frontier && unitsIn(state, regionId).some((u) => u.ownerId !== mover && u.ownerId !== 'neutral')) return false;
    return world.movement.allowPassThroughNeutralTerritory;
  }
  if (owner === mover) return true;
  const rel = getRelation(state, mover, owner);
  if (rel === 'war') return !world.movement.blockPassThroughEnemyTerritory;
  // alliance / truce / peace / neutral 都算友方通行
  return world.movement.allowPassThroughAllyTerritory;
}

/**
 * Dijkstra 找最短路径。
 * ★接受 state 而非 ResolveContext，以便 legal.ts 在结算之外也能预估行军成本。
 * @param isTargetPassable 终点单独判定（进攻时终点是敌区，穿越规则不适用）
 */
export function findPath(
  state: GameState,
  world: WorldConfig,
  mover: FactionId,
  from: RegionId,
  to: RegionId,
  opts: FindPathOptions = {},
): PathResult | null {
  if (from === to) return { path: [from], cost: 0 };
  if (!world.regions[from] || !world.regions[to]) return null;
  const domain: UnitDomain = opts.unitType?.domain ?? 'land';
  // 水师只能停靠港口；起点被陆军夺走等异常局面下直接判定不可达（不会把水师拖上岸）
  if (domain === 'water' && (world.regions[from]?.port !== true || world.regions[to]?.port !== true)) {
    return null;
  }
  const isTargetPassable = opts.isTargetPassable ?? ((r: RegionId) => canPassThrough(state, world, mover, r));
  if (!isTargetPassable(to)) return null;

  const dist = new Map<RegionId, number>([[from, 0]]);
  const bestCost = new Map<RegionId, number>([[from, 0]]);
  const prev = new Map<RegionId, RegionId>();
  const visited = new Set<RegionId>();
  let expanded = 0;

  while (dist.size > 0) {
    if (++expanded > world.movement.pathSearchMaxNodes) return null; // 搜索预算耗尽
    // 取当前最近未访问节点。区域数少，线性扫描比堆更快且**顺序确定**
    let cur: RegionId | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const [node, d] of [...dist.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      if (visited.has(node)) continue;
      if (d < best) { best = d; cur = node; }
    }
    if (cur === null) break;
    if (cur === to) break;
    visited.add(cur);
    dist.delete(cur);

    for (const step of stepOptions(world, cur, domain)) {
      const next = step.to;
      if (visited.has(next)) continue;
      if (next !== to && !canPassThrough(state, world, mover, next)) continue;
      const nd = best + step.cost;
      const known = dist.get(next);
      if (known === undefined || nd < known) {
        dist.set(next, nd);
        bestCost.set(next, nd);
        prev.set(next, cur);
      }
    }
  }

  if (!visited.has(to) && to !== from && !prev.has(to)) return null;
  const path: RegionId[] = [to];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur);
    if (p === undefined) return null;
    path.unshift(p);
    cur = p;
  }
  return { path, cost: bestCost.get(to) ?? 0 };
}

/** 从 from 出发、移动力 budget 内可达的全部区域（含成本）。供 legal.ts 枚举用 */
export function reachableRegions(
  state: GameState,
  world: WorldConfig,
  mover: FactionId,
  from: RegionId,
  budget: number,
  unitType?: UnitTypeDef,
): Array<{ regionId: RegionId; cost: number; path: readonly RegionId[] }> {
  const out: Array<{ regionId: RegionId; cost: number; path: readonly RegionId[] }> = [];
  for (const to of Object.keys(world.regions).sort()) {
    if (to === from) continue;
    const def = world.regions[to]!;
    if (!def.passable) continue;
    if (unitType?.domain === 'water' && def.port !== true) continue;
    const r = findPath(state, world, mover, from, to, unitType ? { unitType } : {});
    if (r && r.cost <= budget) out.push({ regionId: to, cost: r.cost, path: r.path });
  }
  return out.sort((a, b) => (a.cost === b.cost ? (a.regionId < b.regionId ? -1 : 1) : a.cost - b.cost));
}

export const movementModule: RuleModule = {
  id: 'movement',
  version: 1,
  reads: ['units.regionId', 'regions.owner', 'relations'] as readonly StateSlice[],
  writes: ['units.regionId'] as readonly StateSlice[],
  commands: ['move_units', 'attack'],

  resolve(ctx: ResolveContext): void {
    const { world } = ctx;
    const sorted = [...ctx.orders]
      // attack + moveTo 是同一条“先机动再进攻”的复合指令；普通 attack 留给 combat。
      .filter((o) => o.kind === 'move_units' || (o.kind === 'attack' && typeof (o.command as MoveCmd).moveTo === 'string'))
      .sort((a, b) => (a.seatId === b.seatId ? 0 : a.seatId < b.seatId ? -1 : 1));

    for (const order of sorted) {
      const cmd = order.command as MoveCmd;
      const toRegion = cmd.kind === 'attack' ? cmd.moveTo : cmd.toRegion;
      const unit = ctx.state.units[cmd.unitId];
      if (!unit || unit.ownerId !== order.factionId) {
        ctx.reject(order, 'UNIT_NOT_OWNED', `部队 ${cmd.unitId} 不属于 ${order.factionId}`);
        continue;
      }
      const typeDef = world.unitTypes[unit.typeId];
      if (!typeDef) {
        ctx.reject(order, 'UNKNOWN_UNIT_TYPE', `部队 ${cmd.unitId} 的兵种 ${unit.typeId} 未定义`);
        continue;
      }
      if (unit.movedThisTurn) {
        ctx.reject(order, 'ORDERS_ALREADY_LOCKED', `部队 ${cmd.unitId} 本回合已行动`);
        continue;
      }
      if (unit.garrisonOnly) {
        ctx.reject(order, 'GARRISON_LOCKED', `部队 ${cmd.unitId} 是守城民兵，不能离开本区`);
        continue;
      }
      if (!toRegion) {
        ctx.reject(order, 'MALFORMED_PAYLOAD', `部队 ${cmd.unitId} 的机动指令缺少目标区域`);
        continue;
      }
      const target = ctx.state.regions[toRegion];
      const targetDef = world.regions[toRegion];
      if (!target || !targetDef) {
        ctx.reject(order, 'UNKNOWN_REGION', `区域 ${toRegion} 不存在`);
        continue;
      }
      if (!targetDef.passable) {
        ctx.reject(order, 'REGION_IMPASSABLE', `${toRegion} 不可通行`);
        continue;
      }
      if (target.owner === null && target.rebellion) {
        ctx.reject(order, 'REGION_NOT_OWNED', `${toRegion} 是起义区，只能由原属国进攻，不能行军进入`);
        continue;
      }
      if (world.frontier && target.owner === null && unitsIn(ctx.state, toRegion).some((u) => u.ownerId !== order.factionId && u.ownerId !== 'neutral')) {
        ctx.reject(order, 'REGION_CONTESTED', `${toRegion} 已有其他势力的部队，不能共占开拓`);
        continue;
      }
      // move_units 不得进入敌区 —— 那是 attack 命令的职责
      if (target.owner !== null && target.owner !== order.factionId) {
        if (getRelation(ctx.state, order.factionId, target.owner) === 'war') {
          ctx.reject(order, 'REGION_NOT_ADJACENT', `${toRegion} 处于交战状态，请用 attack 命令进攻`);
          continue;
        }
        if (!world.movement.allowPassThroughAllyTerritory) {
          ctx.reject(order, 'REGION_NOT_OWNED', `不允许进入 ${target.owner} 的领土`);
          continue;
        }
      }
      if (unit.regionId === toRegion) {
        ctx.reject(order, 'MALFORMED_PAYLOAD', `部队 ${cmd.unitId} 已在 ${toRegion}`);
        continue;
      }

      if (typeDef.domain === 'water' && world.regions[unit.regionId]?.port !== true) {
        ctx.reject(order, 'UNIT_DOMAIN_MISMATCH', `水师只能停泊在港口，当前 ${unit.regionId} 不是港口`);
        continue;
      }
      if (typeDef.domain === 'water' && targetDef.port !== true) {
        ctx.reject(order, 'UNIT_DOMAIN_MISMATCH', `水师只能沿水路移动，目标 ${toRegion} 不是港口`);
        continue;
      }
      const result = findPath(ctx.state, world, order.factionId, unit.regionId, toRegion, { unitType: typeDef });
      if (!result) {
        ctx.reject(order, 'NO_LEGAL_PATH', `从 ${unit.regionId} 到 ${toRegion} 无合法路径（可能被敌国领土阻断或水师不在港口）`);
        continue;
      }
      if (result.cost > typeDef.movement) {
        ctx.reject(order, 'NO_LEGAL_PATH', `${typeDef.name} 移动力 ${typeDef.movement} 不足以抵达 ${toRegion}（需 ${result.cost}）`);
        continue;
      }
      if (cmd.kind === 'attack') {
        const attackTargetId = cmd.targetRegion;
        const attackTarget = attackTargetId ? ctx.state.regions[attackTargetId] : undefined;
        const attackDef = attackTargetId ? world.regions[attackTargetId] : undefined;
        if (!attackTargetId || !attackTarget || !attackDef || !attackDef.passable) {
          ctx.reject(order, 'UNKNOWN_REGION', `进攻目标 ${attackTargetId ?? '?'} 不存在或不可通行`);
          continue;
        }
        if (attackTarget.owner === order.factionId) {
          ctx.reject(order, 'SELF_TARGET_NOT_ALLOWED', '不能进攻自己的领土');
          continue;
        }
        if (!isAttackAdjacent(world, typeDef, toRegion, attackTargetId)) {
          ctx.reject(order, 'REGION_NOT_ADJACENT', `移动落点 ${toRegion} 与 ${attackTargetId} 不相邻，无法进攻`);
          continue;
        }
      }
      ctx.mutate({ op: 'move_unit', unitId: cmd.unitId, toRegion, path: result.path, movementSpent: result.cost });
    }
  },
};
