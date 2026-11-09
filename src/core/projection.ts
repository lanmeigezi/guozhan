/**
 * 战争迷雾：按接收者投影（aonw RecipientDisclosure）。
 *
 * 核心不变量（ADR 0008）：**客户端永不收到规范隐藏状态，也无法从可见数据反推。**
 *
 * 可见性规则（国战语境下的取舍）：
 *   · 领土归属是**公开信息**（Diplomacy 亦然）—— 谁占哪块地人人都知道，
 *     迷雾的价值不在藏归属，而在藏兵力与动向。
 *   · 己方区域 = full（全部细节）
 *   · 己方部队所在区域 = full
 *   · 与己方区域相邻 = partial（看得到驻军规模档位，看不到精确兵力）
 *   · 其余 = name_only（只有名字、归属、地形）
 *   · 观战端 = 显式的全知分支，不是"漏了裁剪"
 *
 * ★给 LLM 的数值一律分层标签/档位，不给精确值。
 *   Histrategy 的 state-complexity 复盘：CK3/Total War/Civ VI 三条规律 ——
 *   独立维度越少越好、离散优于连续、LLM 调参数代码算结果。
 */
import type { FactionId, GameState, RegionId, WorldConfig } from './state.ts';
import { getRelation, INTEL_VALID_TURNS, regionsOf } from './state.ts';
import {
  ARMY_TIER_THRESHOLDS,
  DEVELOPMENT_LABELS,
  FOOD_TIER_TURNS,
  GOLD_TIER_THRESHOLDS,
  type ArmyTier,
  type FoodTier,
  type GoldTier,
} from './labels.ts';

export type Visibility = 'full' | 'partial' | 'name_only' | 'unknown';
export type Recipient = FactionId | 'spectator';

export function armyTier(troops: number): ArmyTier {
  const [token, garrison, field] = ARMY_TIER_THRESHOLDS as readonly [number, number, number];
  if (troops <= 0) return 'none';
  if (troops < token) return 'token';
  if (troops < garrison) return 'garrison';
  if (troops < field) return 'field_army';
  return 'grand_army';
}

export function goldTier(gold: number): GoldTier {
  const [zero, poor, moderate, rich] = GOLD_TIER_THRESHOLDS as readonly [number, number, number, number];
  if (gold < zero) return 'bankrupt';
  if (gold < poor) return 'poor';
  if (gold < moderate) return 'moderate';
  if (gold < rich) return 'rich';
  return 'overflowing';
}

/** 粮草档位要考虑军需 —— 存粮 5000 对 10 万大军是"饥荒"，对小国是"充裕" */
export function foodTier(food: number, upkeepPerTurn: number): FoodTier {
  const [, low, adequate, surplus] = FOOD_TIER_TURNS as readonly [number, number, number, number];
  if (upkeepPerTurn <= 0) return food <= 0 ? 'starving' : 'abundant';
  const turns = food / upkeepPerTurn;
  if (turns < low) return 'starving';
  if (turns < adequate) return 'low';
  if (turns < surplus) return 'adequate';
  if (turns < surplus * 2) return 'surplus';
  return 'abundant';
}

export function developmentLabel(development: number): string {
  const idx = Math.max(0, Math.min(DEVELOPMENT_LABELS.length - 1, development - 1));
  return DEVELOPMENT_LABELS[idx] as string;
}

/** 己方可见的区域集合 */
export function visibleRegions(state: GameState, world: WorldConfig, viewer: Recipient): Map<RegionId, Visibility> {
  const out = new Map<RegionId, Visibility>();
  const allIds = Object.keys(world.regions).sort();

  if (viewer === 'spectator') {
    for (const id of allIds) out.set(id, 'full');
    return out;
  }

  const owned = new Set(regionsOf(state, viewer));
  const ownUnitRegions = new Set<RegionId>();
  for (const u of Object.values(state.units)) {
    if (u.ownerId === viewer) ownUnitRegions.add(u.regionId);
  }
  const adjacent = new Set<RegionId>();
  for (const id of [...owned, ...ownUnitRegions]) {
    for (const n of world.regions[id]?.adjacency ?? []) adjacent.add(n);
  }
  const intel = state.factions[viewer]?.intel ?? {};
  const freshIntel = (id: RegionId): boolean =>
    (intel[id] ?? Number.NEGATIVE_INFINITY) >= state.turn - INTEL_VALID_TURNS;

  for (const id of allIds) {
    // ★间谍情报：有效期内直接给 exact 视图（驻军/动乱/基建），与己方领土同级
    if (owned.has(id) || ownUnitRegions.has(id) || freshIntel(id)) out.set(id, 'full');
    else if (adjacent.has(id)) out.set(id, 'partial');
    else out.set(id, 'name_only');
  }
  return out;
}

/** 某区域的驻军对 viewer 是否可见（含精确兵力） */
export function canSeeStacks(state: GameState, world: WorldConfig, viewer: Recipient, regionId: RegionId): boolean {
  if (viewer === 'spectator') return true;
  const vis = visibleRegions(state, world, viewer).get(regionId);
  return vis === 'full';
}

/**
 * 拓扑式地图文本。每行：`归属字母 区域名 [地形] (发展度标签) → 邻居列表`
 * 归属字母取势力 name 的首字，中立用 `·`，未知用 `?`。
 */
export function buildMapText(
  state: GameState,
  world: WorldConfig,
  viewer: Recipient,
  visibility: ReadonlyMap<RegionId, Visibility>,
): string {
  const letter = (fid: FactionId | null): string => {
    if (fid === null) return '·';
    const f = state.factions[fid];
    return f ? f.name.slice(0, 1) : '?';
  };
  const lines: string[] = [];
  for (const id of Object.keys(world.regions).sort()) {
    const def = world.regions[id]!;
    const st = state.regions[id];
    const vis = visibility.get(id) ?? 'name_only';
    const owner = st?.owner ?? null;
    const mark = id === state.factions[viewer as FactionId]?.capital ? '*' : ' ';
    if (vis === 'name_only') {
      lines.push(`${letter(owner)}${mark}${def.name} [${def.terrain}] — 情报不足`);
      continue;
    }
    const dev = st ? developmentLabel(st.development) : '?';
    const fort = st && st.fortLevel > 0 ? ` 要塞${st.fortLevel}` : '';
    const infra = vis === 'full' && st && (st.infrastructure ?? 0) > 0 ? ` 基建${st.infrastructure}` : '';
    const unrest = vis === 'full' && st && st.unrest >= 50 ? ` 动乱${st.unrest}` : '';
    const rebellion = st?.rebellion ? ` 起义${st.rebellion.claimedBy ? '·归附' : ''}` : '';
    const neighbors = def.adjacency.map((n) => `${letter(state.regions[n]?.owner ?? null)}${world.regions[n]?.name ?? n}`).join(' ');
    lines.push(`${letter(owner)}${mark}${def.name} [${def.terrain}] (${dev})${fort}${infra}${unrest}${rebellion} → ${neighbors}`);
  }
  // ★静态水路/港口给 LLM 一个战略层提示（只在有水路的剧本出现；旧剧本零 token 增量）。
  //   坐标与航道几何不进文本，这里只列"谁能走、成本多少、从哪上船"。
  if (world.waterRoutes.length > 0) {
    const nameOf = (id: RegionId): string => {
      const vis = visibility.get(id) ?? 'name_only';
      return vis === 'unknown' ? id : (world.regions[id]?.name ?? id);
    };
    lines.push(
      `水路（仅水师，cost）：${world.waterRoutes
        .map((r) => `${nameOf(r.a)}↔${nameOf(r.b)}(${r.cost})`)
        .join('、')}`,
    );
    const ports = Object.keys(world.regions).filter((id) => world.regions[id]?.port === true).sort();
    lines.push(`港口：${ports.map(nameOf).join('、')}`);
  }
  return lines.join('\n');
}

/** 势力关系从 viewer 视角看 */
export function relationFromViewer(state: GameState, viewer: Recipient, other: FactionId): string {
  if (viewer === 'spectator') return 'neutral';
  if (viewer === other) return 'self';
  return getRelation(state, viewer, other);
}

/** 该势力每回合军需（粮），用于 foodTier */
export function foodUpkeepPerTurn(state: GameState, world: WorldConfig, factionId: FactionId): number {
  let total = 0;
  for (const u of Object.values(state.units)) {
    if (u.ownerId !== factionId) continue;
    const t = world.unitTypes[u.typeId];
    if (!t) continue;
    total += (t.upkeepFood * u.troops) / 1000;
  }
  return Math.round(total);
}
