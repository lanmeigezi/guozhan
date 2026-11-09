/**
 * 合法动作空间枚举 —— P10「LLM 建议必须锚定在引擎给出的合法动作上」。
 *
 * CICERO 的做法是：候选命令从**规则引擎的合法动作空间**采样，LLM 只能在这个集合里说话。
 * 我们照此实现：这份清单随快照一起发给 LLM，它只能引用这里的 id；
 * 引用任何不在清单里的东西，闸门①直接剔除该条。
 *
 * ★两个刻意的设计：
 *   1. **数值由代码算，LLM 只消费结果** —— powerRatio / goldCost / movementCost 全是
 *      引擎预算好的。OpenArma 与 OpenRA-RL 都这么做；反例是 Histrategy V1 让 LLM 自己算，
 *      结果孙权人口被推演成 18.3 万（史实约 200 万）。
 *   2. **总数封顶 + 优先级排序** —— OpenRA-RL 暴露 51 个工具，自己都得提供
 *      config-minimal.yaml 并注明"给小上下文模型用的精简工具集"。动作同理：
 *      19 区域 × 25 部队的全组合有上千条，必须裁到几十条，否则 token 爆且 LLM 选不准。
 */
import type {
  FactionId,
  GameState,
  InfrastructureLevelDef,
  LawEffects,
  RegionId,
  UnitId,
  WorldConfig,
} from './state.ts';
import {
  aliveFactions,
  civilianPopulation,
  getGrudge,
  getRelation,
  INTEL_VALID_TURNS,
  isAttackAdjacent,
  isInfantryType,
  rebelTroopsInRegion,
  regionPopulation,
  regionsOf,
  terrainTraits,
  totalPopulation,
  tradePolicyBetween,
  unitsIn,
  waterRoutePath,
  waterRouteReachable,
} from './state.ts';
import { amplifiedUnrest } from './unrest.ts';
import { reachableRegions } from './modules/movement.ts';
import { estimateBattle } from './modules/combat.ts';
import { LAW_ENACT_MORALE_COST, lawEnactCost, taxMoralePerTurn } from './modules/economy.ts';
import { spyGoldCost } from './modules/statecraft.ts';
import { slaveSourceCapacity, slaveTradePrice } from './modules/slavetrade.ts';

export interface LegalAction {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly command: Record<string, unknown>;
  readonly estimate?: Record<string, number | string>;
  /** 给人类 UI 的效果说明（税率/法令）；不影响规则裁决 */
  readonly description?: string;
  /** 排序用，不进 wire */
  readonly priority: number;
  /**
   * 地图 UI 用的结构化起止区域（可选）：让前端按"选源格 → 点目标格"下单，
   * 不必解析 label 文本。★仍由引擎填、不是客户端推的第二份规则真相；
   * 也不进 Snapshot.legalActions（LLM 只拿 id/kind/label/estimate）。
   */
  readonly sourceRegion?: RegionId;
  readonly targetRegion?: RegionId;
  /**
   * 多格移动的实际路径（含起点与终点），只给人类 UI 画箭头/显示格数。
   * ★不进 Snapshot.legalActions：LLM 仍只拿 id/kind/label/estimate。
   */
  readonly path?: readonly RegionId[];
}

export interface EnumerateOptions {
  /** 总条数上限（默认 40）。小模型建议调到 20 */
  readonly maxActions?: number;
  /** 每类动作的条数上限，防止某一类挤占全部名额 */
  readonly perKindCap?: Readonly<Record<string, number>>;
  /** 只枚举这些 kind（军师模式下可以只要 attack/move） */
  readonly kinds?: readonly string[];
  /** 人类 UI：取消每类动作上限（仍受 maxActions 总上限约束） */
  readonly uncapped?: boolean;
  /** 人类 UI：额外枚举“先移动再进攻”的组合攻击；LLM/军师默认不启用 */
  readonly moveAttacks?: boolean;
}

const DEFAULT_PER_KIND_CAP: Record<string, number> = {
  attack: 12,
  move_units: 12,
  split_unit: 8,
  merge_units: 6,
  recruit: 8,
  develop: 6,
  build_infrastructure: 6,
  fortify: 4,
  set_tax: 5,
  set_law: 6,
  diplomacy: 8,
  send_spy: 32,
  trade_slaves: 8,
  claim_rebellion: 8,
  settle_region: 8,
  disband: 3,
};

interface AttackTarget {
  readonly unitId: UnitId;
  readonly regionId: RegionId;
  /** 先移动到该区，再进攻 regionId */
  readonly via?: RegionId;
  /** 移动路径 + 进攻路径（含起点与终点） */
  readonly path?: readonly RegionId[];
  readonly moveCost?: number;
}

/** 移动模块允许把部队停到该区吗？（与 movement.resolve 的落点规则一致） */
function canEnterDestination(state: GameState, world: WorldConfig, fid: FactionId, regionId: RegionId): boolean {
  const owner = state.regions[regionId]?.owner ?? null;
  if (owner === null) {
    if (state.regions[regionId]?.rebellion) return false;
    return world.movement.allowPassThroughNeutralTerritory;
  }
  if (owner === fid) return true;
  if (getRelation(state, fid, owner) === 'war') return false;
  return world.movement.allowPassThroughAllyTerritory;
}

/**
 * 可进攻目标：相邻、非己方、且己方有未行动的部队。
 * includeMoves=true 时，额外生成“先移动、再进攻”的组合动作：移动路径必须在
 * 本回合移动力内，目标必须与移动后的落点相邻（或水路 1-2 格）；同一目标只保留
 * 一条最短移动路径。这样人类 UI 不再出现“部队在边境却打不到隔壁”的断档。
 */
function attackTargets(
  state: GameState,
  world: WorldConfig,
  fid: FactionId,
  opts: { includeMoves?: boolean } = {},
): AttackTarget[] {
  const out: AttackTarget[] = [];
  const ownUnits = Object.values(state.units)
    .filter((u) => u.ownerId === fid && !u.movedThisTurn && u.troops > 0 && !u.garrisonOnly)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const u of ownUnits) {
    const direct = new Set<RegionId>();
    const targets = new Set<RegionId>(world.regions[u.regionId]?.adjacency ?? []);
    // 水师/两栖可以沿水路突击 1-2 格外的港口（与 combat 的 isAttackAdjacent 同一规则）
    const type = world.unitTypes[u.typeId];
    if (type?.domain === 'water' || type?.domain === 'amphibious') {
      for (const n of waterRouteReachable(world, u.regionId, 2)) targets.add(n);
    }
    for (const n of [...targets].sort()) {
      const target = state.regions[n];
      if (!target) continue;
      if (target.owner === fid) continue;
      // 未归附的起义区只能由原属国进攻；其他国家只能宣称
      if (target.owner === null && target.rebellion && target.rebellion.from !== fid) continue;
      // 开荒剧本的无主荒地只能通过派兵进入+开荒占领；不生成普通进攻动作
      if (target.owner === null && world.frontier && !target.rebellion) continue;
      if (!world.regions[n]?.passable) continue;
      direct.add(n);
      // 非中立且非交战 ⇒ 进攻即宣战，仍然合法（Diplomacy 式）
      out.push({ unitId: u.id, regionId: n });
    }
    if (!opts.includeMoves || !type) continue;

    const byTarget = new Map<RegionId, { via: RegionId; path: readonly RegionId[]; cost: number }>();
    for (const r of reachableRegions(state, world, fid, u.regionId, type.movement, type)) {
      if (r.regionId === u.regionId) continue;
      if (!canEnterDestination(state, world, fid, r.regionId)) continue;
      const destDef = world.regions[r.regionId];
      if (!destDef) continue;
      const candidates = new Set<RegionId>(destDef.adjacency ?? []);
      if (type.domain === 'water' || type.domain === 'amphibious') {
        for (const n of waterRouteReachable(world, r.regionId, 2)) candidates.add(n);
      }
      for (const targetId of candidates) {
        if (direct.has(targetId)) continue;
        const target = state.regions[targetId];
        if (!target || target.owner === fid) continue;
        if (target.owner === null && target.rebellion && target.rebellion.from !== fid) continue;
        if (target.owner === null && world.frontier && !target.rebellion) continue;
        if (!world.regions[targetId]?.passable) continue;
        if (!isAttackAdjacent(world, type, r.regionId, targetId)) continue;
        const prev = byTarget.get(targetId);
        if (!prev || r.cost < prev.cost || (r.cost === prev.cost && r.regionId < prev.via)) {
          byTarget.set(targetId, { via: r.regionId, path: [...r.path, targetId], cost: r.cost });
        }
      }
    }
    for (const [targetId, m] of [...byTarget.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      out.push({ unitId: u.id, regionId: targetId, via: m.via, path: m.path, moveCost: m.cost });
    }
  }
  return out;
}

export function enumerateLegalActions(
  state: GameState,
  world: WorldConfig,
  fid: FactionId,
  opts: EnumerateOptions = {},
): LegalAction[] {
  const maxActions = opts.maxActions ?? 40;
  const cap = { ...DEFAULT_PER_KIND_CAP, ...(opts.perKindCap ?? {}) };
  const limitFor = (kind: string): number => opts.uncapped ? Number.POSITIVE_INFINITY : (cap[kind] ?? 6);
  const wanted = (k: string): boolean => opts.kinds === undefined || opts.kinds.includes(k);
  const faction = state.factions[fid];
  const out: LegalAction[] = [];
  if (!faction || faction.eliminated || state.phase === 'ended') return out;

  const push = (a: LegalAction): void => {
    if (!wanted(a.kind)) return;
    const used = out.filter((x) => x.kind === a.kind).length;
    if (used >= limitFor(a.kind)) return;
    out.push(a);
  };

  // ── 进攻（最高优先级：国战的核心动作，也是最容易被 LLM 忽略的 —— OpenRA-RL 的"只种田"教训）──
  const attacks = attackTargets(state, world, fid, { includeMoves: opts.moveAttacks === true });
  const scored = attacks
    .map((a) => {
      const est = estimateBattle({ state, world }, fid, [a.unitId], a.regionId);
      return { ...a, est };
    })
    // ★优势大的排前面，保证被 cap 截断时留下的是最有价值的
    .sort((x, y) => y.est.powerRatio - x.est.powerRatio || (x.regionId < y.regionId ? -1 : 1));
  const low = world.governance?.lowMoraleUnrest;
  const moraleFactor = 0.5 + faction.morale / world.combat.moraleCoefficient;
  for (const a of scored) {
    const target = state.regions[a.regionId]!;
    const ownerName = target.owner ? (state.factions[target.owner]?.name ?? target.owner) : '中立';
    const unit = state.units[a.unitId]!;
    const startedWar = target.owner !== null && getRelation(state, fid, target.owner) !== 'war';
    const battleUnrest = low ? amplifiedUnrest(low.battleBase, faction.morale, low) : null;
    const warUnrest = startedWar && low ? amplifiedUnrest(low.warDeclarationBase, faction.morale, low) : null;
    const originName = world.regions[unit.regionId]?.name ?? unit.regionId;
    const targetName = world.regions[a.regionId]?.name ?? a.regionId;
    const viaName = a.via ? (world.regions[a.via]?.name ?? a.via) : null;
    const effectBits = [
      `全国民心 ${faction.morale}：战力系数×${moraleFactor.toFixed(2)}`,
    ];
    if (battleUnrest) {
      effectBits.push(`交战将使${targetName}动乱 +${battleUnrest.amount}（低民心×${battleUnrest.factor.toFixed(2)}）`);
    }
    if (warUnrest) {
      effectBits.push(`开战动员将使出发地${originName}动乱 +${warUnrest.amount}`);
    }
    if (a.est.attackerCounterBonus > 1) {
      effectBits.push(`我方克制守军 +${Math.round((a.est.attackerCounterBonus - 1) * 100)}%`);
    }
    if (a.est.defenderCounterBonus > 1) {
      effectBits.push(`守军克制我方 +${Math.round((a.est.defenderCounterBonus - 1) * 100)}%`);
    }
    if (a.est.terrainInfantryDefense > 1 && a.est.defenderTypes.some((t) => isInfantryType(t))) {
      effectBits.push(`${targetName}地形使守军步兵战力 +${Math.round((a.est.terrainInfantryDefense - 1) * 100)}%`);
    }
    if (target.rebellion) {
      effectBits.push(
        target.owner === null
          ? `起义区：必须先杀光全部 ${target.rebellion.from} 的起义民兵才能重占`
          : `归附后的起义区：${target.rebellion.claimedBy} 的守城民兵不可调动，必须全歼才能占领`,
      );
    } else if (target.owner === null && world.frontier) {
      effectBits.push('未开垦区：普通进攻只能驱散原住民，不能占领；需派兵进入后开荒（基建 Lv1）');
    }
    const unitType = world.unitTypes[unit.typeId];
    const directWaterPath = !a.via && (unitType?.domain === 'water' || unitType?.domain === 'amphibious')
      ? waterRoutePath(world, unit.regionId, a.regionId, 2)
      : null;
    const actionPath = a.path ?? (directWaterPath && directWaterPath.length > 2 ? directWaterPath : undefined);
    if (a.via) {
      effectBits.unshift(`先移动至${viaName}（消耗 ${a.moveCost ?? '?'} 移动力），再发起进攻`);
    }
    push({
      id: `attack:${a.unitId}:${a.regionId}`,
      kind: 'attack',
      label: a.via
        ? `以 ${world.unitTypes[unit.typeId]?.name ?? unit.typeId}(${unit.troops}) 移动至 ${viaName} 后进攻 ${targetName}（${ownerName}）`
        : `以 ${world.unitTypes[unit.typeId]?.name ?? unit.typeId}(${unit.troops}) 进攻 ${targetName}（${ownerName}）`,
      command: { kind: 'attack', unitId: a.unitId, targetRegion: a.regionId, ...(a.via ? { moveTo: a.via } : {}) },
      sourceRegion: unit.regionId,
      targetRegion: a.regionId,
      ...(actionPath ? { path: actionPath } : {}),
      estimate: {
        powerRatio: a.est.powerRatio,
        defenderTroops: a.est.defenderTroops,
        attackerTroops: unit.troops,
        ...(a.moveCost != null ? { moveCost: a.moveCost } : {}),
        verdict: a.est.powerRatio >= world.combat.capturePowerRatio ? '优势明显' : a.est.powerRatio >= 1 ? '略占上风' : '劣势',
        ...(battleUnrest ? { battleUnrest: battleUnrest.amount } : {}),
        ...(warUnrest ? { warUnrest: warUnrest.amount } : {}),
        ...(a.est.attackerCounterBonus > 1 ? { counterBonus: a.est.attackerCounterBonus } : {}),
        ...(a.est.defenderCounterBonus > 1 ? { defenderCounter: a.est.defenderCounterBonus } : {}),
        ...(a.est.terrainInfantryDefense > 1 ? { terrainInfantryDefense: a.est.terrainInfantryDefense } : {}),
        ...(target.rebellion ? { rebelTroops: rebelTroopsInRegion(state, a.regionId) } : {}),
      },
      description: effectBits.join('；'),
      priority: a.via ? 2 : 1,
    });
  }

  // ── 移动 ──
  const isWaterCapable = (typeId: string): boolean => {
    const t = world.unitTypes[typeId];
    return t?.domain === 'water' || t?.domain === 'amphibious';
  };
  // ★水师的多格水路机动优先枚举，避免被 perKindCap 挤掉。
  //   旧剧本没有 water 单位 ⇒ 排序结果与原来的纯 id 排序完全一致。
  const ownUnits = Object.values(state.units)
    .filter((u) => u.ownerId === fid && !u.movedThisTurn && u.troops > 0 && !u.garrisonOnly)
    .sort((a, b) => {
      const aw = isWaterCapable(a.typeId) ? 0 : 1;
      const bw = isWaterCapable(b.typeId) ? 0 : 1;
      return aw !== bw ? aw - bw : a.id < b.id ? -1 : 1;
    });
  for (const u of ownUnits) {
    const t = world.unitTypes[u.typeId];
    if (!t) continue;
    const waterCapable = isWaterCapable(u.typeId);
    for (const r of reachableRegions(state, world, fid, u.regionId, t.movement, t)) {
      // 只列出"有战略意义"的目的地：己方边境、中立区、友方要地，避免上千条无意义移动。
      // 水师的港口本来就不多，全部列出，才能体现"一回合多格水路机动"。
      const target = state.regions[r.regionId];
      if (!target) continue;
      const isFront = (world.regions[r.regionId]?.adjacency ?? []).some((n) => {
        const o = state.regions[n]?.owner;
        return o !== null && o !== undefined && o !== fid && getRelation(state, fid, o) === 'war';
      });
      const useful = waterCapable || target.owner === fid || target.owner === null || isFront || world.regions[r.regionId]!.strategic;
      if (!useful) continue;
      push({
        id: `move:${u.id}:${r.regionId}`,
        kind: 'move_units',
        label: `${t.name}(${u.troops}) ${world.regions[u.regionId]?.name ?? u.regionId} → ${world.regions[r.regionId]?.name ?? r.regionId}`,
        command: { kind: 'move_units', unitId: u.id, toRegion: r.regionId },
        sourceRegion: u.regionId,
        targetRegion: r.regionId,
        path: r.path,
        estimate: { movementCost: r.cost, movement: t.movement },
        priority: 2,
      });
    }
  }

  // ── 分兵 / 合兵 ──
  for (const u of ownUnits) {
    if (u.troops < 2) continue;
    const half = Math.floor(u.troops / 2);
    const quarter = Math.floor(u.troops / 4);
    const counts = [...new Set([half, quarter])].filter((n) => n >= 1 && n < u.troops).sort((a, b) => b - a);
    for (const count of counts) {
      const typeName = world.unitTypes[u.typeId]?.name ?? u.typeId;
      push({
        id: `split:${u.id}:${count}`,
        kind: 'split_unit',
        label: `分兵：从 ${typeName}(${u.troops}) 分出 ${count}`,
        command: { kind: 'split_unit', unitId: u.id, count },
        sourceRegion: u.regionId,
        targetRegion: u.regionId,
        estimate: { splitCount: count, remaining: u.troops - count },
        description: `拆成两支同区同兵种部队：${u.troops - count} + ${count}；不消耗移动力`,
        priority: 4,
      });
    }
  }
  const mergeGroups = new Map<string, typeof ownUnits>();
  for (const u of ownUnits) {
    const key = `${u.regionId}\u0000${u.typeId}`;
    mergeGroups.set(key, [...(mergeGroups.get(key) ?? []), u]);
  }
  for (const key of [...mergeGroups.keys()].sort()) {
    const group = [...(mergeGroups.get(key) ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (group.length < 2) continue;
    const target = group[0]!;
    for (const source of group.slice(1)) {
      const typeName = world.unitTypes[target.typeId]?.name ?? target.typeId;
      push({
        id: `merge:${source.id}:${target.id}`,
        kind: 'merge_units',
        label: `合兵：${typeName}(${source.troops}) 并入 (${target.troops})`,
        command: { kind: 'merge_units', unitId: source.id, targetUnitId: target.id },
        sourceRegion: target.regionId,
        targetRegion: target.regionId,
        estimate: { mergeCount: source.troops, total: source.troops + target.troops },
        description: `source 部队全部并入 target，合成 ${source.troops + target.troops} 兵；要求同区同兵种`,
        priority: 4,
      });
    }
  }

  // ── 征兵（只列付得起的，且不超过本回合征兵上限）──
  const pop = regionsOf(state, fid).reduce((s, rid) => {
    const def = world.regions[rid];
    const st = state.regions[rid];
    return s + (def && st ? regionPopulation(def.baseManpower, st.development) : 0);
  }, 0);
  const ratio = conscriptRatioOf(world, Math.floor(pop));
  const fatigue = Math.max(world.economy.fatigueFloor, 1 - faction.conscriptStreak * world.economy.fatiguePerStreak);
  const ownRegions = regionsOf(state, fid);
  const typeIds = Object.keys(world.unitTypes).sort();
  const recruitOrder: Array<{ rid: RegionId; typeId: string }> = [];
  // 先列港口的水师，确保 perKindCap 不会把唯一的水路兵种挤掉；
  // 旧剧本没有 water 兵种 ⇒ 第一轮为空，第二轮与原来的双层循环顺序一致。
  for (const typeId of typeIds) {
    const t = world.unitTypes[typeId]!;
    if (t.domain !== 'water' && t.domain !== 'amphibious') continue;
    for (const rid of ownRegions) {
      if (world.regions[rid]?.port === true) recruitOrder.push({ rid, typeId });
    }
  }
  for (const rid of ownRegions) {
    for (const typeId of typeIds) {
      const t = world.unitTypes[typeId]!;
      if (t.domain === 'water' || t.domain === 'amphibious') continue;
      recruitOrder.push({ rid, typeId });
    }
  }
  for (const { rid, typeId } of recruitOrder) {
      const t = world.unitTypes[typeId]!;
      const def = world.regions[rid];
      const st = state.regions[rid];
      const regionPop = def && st ? Math.floor(regionPopulation(def.baseManpower, st.development)) : 0;
      const regionCap = Math.floor(regionPop * ratio * fatigue);
      // 一次给出"本区上限内最多能征多少"，让 LLM 只需决定征不征、征哪几种
      const byManpower = Math.floor(regionCap / Math.max(1, t.recruitManpower)) * 1000;
      const byGold = Math.floor(faction.gold / Math.max(1, t.recruitGold)) * 1000;
      const byFood = Math.floor(faction.food / Math.max(1, t.recruitFood)) * 1000;
      const count = Math.min(byManpower, byGold, byFood, 20000);
      if (count < 1000) continue;
      const recruitUnrest = world.governance
        ? amplifiedUnrest(world.governance.lowMoraleUnrest.recruitBase, faction.morale, world.governance.lowMoraleUnrest)
        : null;
      const rebCfg = world.rebellion;
      const reb = st?.rebellion;
      const laborNote = (world.frontier?.civilianLaborPenalty ?? 0) > 0
        ? '；征兵会减少本区平民，从而降低本区粮/金产出'
        : '';
      const claimedConscriptRisk = Boolean(
        rebCfg &&
        reb?.claimedBy === fid &&
        reb.claimedTurn !== undefined &&
        state.turn > reb.claimedTurn &&
        state.turn - reb.claimedTurn <= rebCfg.claimedConscriptionTurns,
      );
      push({
        id: `recruit:${rid}:${typeId}:${count}`,
        kind: 'recruit',
        label: `在 ${world.regions[rid]?.name ?? rid} 征 ${t.name} ${count}`,
        command: { kind: 'recruit', regionId: rid, unitType: typeId, count },
        targetRegion: rid,
        estimate: {
          goldCost: Math.round((t.recruitGold * count) / 1000),
          foodCost: Math.round((t.recruitFood * count) / 1000),
          count,
          regionPopulation: regionPop,
          regionRecruitCap: regionCap,
          ...(recruitUnrest ? { recruitUnrest: recruitUnrest.amount } : {}),
          ...(claimedConscriptRisk ? { rebellionRisk: 1 } : {}),
        },
        description:
          `本区人口 ${regionPop}，本回合兵源上限 ${regionCap}（每 1000 兵耗 ${t.recruitManpower} 兵源），` +
          `本次可征 ${count} 兵` +
          (recruitUnrest
            ? `；征兵将使本区动乱 +${recruitUnrest.amount}（全国民心 ${faction.morale}，低民心系数×${recruitUnrest.factor.toFixed(2)}）`
            : '') +
          (claimedConscriptRisk ? '；⚠ 该区处于归附后的征兵敏感期，征兵将立即引发再次起义' : '') +
          laborNote,
        priority: 3,
      });
  }

  // ── 开发 / 要塞 ──
  for (const rid of regionsOf(state, fid)) {
    const st = state.regions[rid]!;
    if (st.development < 5) {
      const cost = Math.round(
        world.economy.developmentCostBase * world.economy.developmentCostPerLevel * st.development *
          Math.sqrt(Math.max(1, pop) / world.economy.developmentPopulationDivisor),
      );
      if (faction.gold >= cost) {
        push({
          id: `develop:${rid}`,
          kind: 'develop',
          label: `开发 ${world.regions[rid]?.name ?? rid}（${st.development}→${st.development + 1}）`,
          command: { kind: 'develop', regionId: rid },
          targetRegion: rid,
          estimate: { goldCost: cost },
          priority: 4,
        });
      }
    }
    if (st.fortLevel < 3) {
      const cost = world.economy.fortCostPerLevel * (st.fortLevel + 1);
      if (faction.gold >= cost && (world.regions[rid]?.strategic || isBorder(state, world, fid, rid))) {
        push({
          id: `fortify:${rid}`,
          kind: 'fortify',
          label: `修筑 ${world.regions[rid]?.name ?? rid} 要塞（→Lv${st.fortLevel + 1}）`,
          command: { kind: 'fortify', regionId: rid, toLevel: st.fortLevel + 1 },
          targetRegion: rid,
          estimate: { goldCost: cost, defenseBonus: world.combat.fortBonusPerLevel },
          priority: 5,
        });
      }
    }
    const governance = world.governance;
    if (governance) {
      const next = governance.infrastructure.levels.find((l) => l.level === st.infrastructure + 1);
      if (next && faction.gold >= next.costGold) {
        push({
          id: `infrastructure:${rid}:${next.level}`,
          kind: 'build_infrastructure',
          label: `在 ${world.regions[rid]?.name ?? rid} 修建基建 Lv${next.level}「${next.name}」`,
          command: { kind: 'build_infrastructure', regionId: rid },
          targetRegion: rid,
          estimate: {
            goldCost: next.costGold,
            infrastructureLevel: next.level,
            unrestPerTurn: next.unrestReductionPerTurn,
            populationGrowth: `+${(next.populationGrowthBonus * 100).toFixed(1)}%/回合`,
            moralePoints: next.moralePoints,
          },
          description: infrastructureEffectText(world, next),
          priority: 4,
        });
      }
    }
  }

  // ── 税率（离散档位，避免 LLM 给出 0.317 这种碎数）──
  // ★税率直接改全国民心：10% 轻税回民、20% 中性、30% 起逐档伤民。
  //   这样 40% 不再是"无代价最优"：多拿的金要用每回合民心换。
  const taxPop = civilianPopulation(state, world, fid);
  const taxAt = (rate: number): number => Math.round(taxPop * world.economy.taxPerPop * rate);
  const taxUnrestAt = (rate: number): number =>
    Math.round(Math.max(0, rate - 0.4) * world.economy.unrestFromHighTaxAbove04 * 100);
  const currentTax = taxAt(faction.taxRate);
  const currentTaxUnrest = taxUnrestAt(faction.taxRate);
  const currentTaxMorale = taxMoralePerTurn(world, faction.taxRate);
  for (const rate of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
    if (rate < world.economy.taxMinRate || rate > world.economy.taxMaxRate) continue;
    if (Math.abs(rate - faction.taxRate) < 1e-9) continue;
    const taxRevenue = taxAt(rate);
    const goldDelta = taxRevenue - currentTax;
    const taxUnrest = taxUnrestAt(rate);
    const unrestDelta = taxUnrest - currentTaxUnrest;
    const taxMorale = taxMoralePerTurn(world, rate);
    const moraleDelta = taxMorale - currentTaxMorale;
    const unrestText = unrestDelta === 0
      ? '无额外动乱'
      : `动乱 ${unrestDelta > 0 ? '+' : ''}${unrestDelta}/回合`;
    const moraleText = taxMorale > 0
      ? `民心 +${taxMorale}/回合（轻徭薄赋）`
      : taxMorale < 0
        ? `民心 ${taxMorale}/回合（重税伤民）`
        : '民心 ±0/回合（中性）';
    push({
      id: `tax:${rate.toFixed(1)}`,
      kind: 'set_tax',
      label: `调整税率为 ${(rate * 100).toFixed(0)}%`,
      command: { kind: 'set_tax', rate },
      estimate: {
        taxRevenue,
        goldDeltaPerTurn: goldDelta,
        taxUnrestPerTurn: taxUnrest,
        taxPopulation: taxPop,
        taxMoralePerTurn: taxMorale,
        moraleDeltaPerTurn: moraleDelta,
      },
      description:
        `按平民人口 ${taxPop}（总人口 − 兵力）征税约 ${taxRevenue} 金/回合（较当前 ${goldDelta >= 0 ? '+' : ''}${goldDelta}）；` +
        `${moraleText}；${unrestText}；` +
        `另计每回合休养生息 +${world.economy.moraleRegenPerTurn} 或征兵 -2`,
      priority: 6,
    });
  }

  // ── 法令（成本随治下人口增长；只枚举付得起的）──
  const lawPopulation = totalPopulation(state, world, fid);
  for (const lawId of Object.keys(world.laws).sort()) {
    const law = world.laws[lawId]!;
    const enacted = faction.laws.includes(lawId);
    if (enacted) continue;
    const cost = lawEnactCost(world, law, lawPopulation);
    if (faction.gold < cost) continue;
    push({
      id: `law:${lawId}`,
      kind: 'set_law',
      label: `颁布「${law.name}」（${cost} 金，民心 −${LAW_ENACT_MORALE_COST}）`,
      command: { kind: 'set_law', lawId, enabled: true },
      estimate: { goldCost: cost, lawPopulation, moraleCost: LAW_ENACT_MORALE_COST },
      description:
        `颁布瞬间全国民心 −${LAW_ENACT_MORALE_COST}（变法生乱，一次性）；` +
        `持续生效：${lawEffectText(law.effects)}；成本含 ${Math.round(lawPopulation / 1000)}k 人口附加`,
      priority: 7,
    });
  }

  // ── 外交（只有声明了 diplomacy 模块的剧本才给动作）──
  if (world.capabilities?.diplomacy === true) {
    for (const other of aliveFactions(state)) {
      if (other === fid) continue;
    const rel = getRelation(state, fid, other);
    const name = state.factions[other]?.name ?? other;
    const candidates: Array<{ action: string; label: string; description: string }> =
      rel === 'war'
        ? [
            { action: 'propose_peace', label: `向 ${name} 求和`, description: `单方面停战：与 ${name} 的关系立即变为和平` },
            { action: 'break_alliance', label: `断绝与 ${name} 的一切约定`, description: `单方面毁约：关系回到中立` },
          ]
        : rel === 'alliance'
          ? [{ action: 'break_alliance', label: `背弃与 ${name} 的同盟`, description: `单方面毁约：关系回到中立` }]
          : [
              { action: 'propose_alliance', label: `与 ${name} 结盟`, description: `单方面结盟：关系变为同盟（通行权立即生效）` },
              { action: 'propose_peace', label: `与 ${name} 缔结互不侵犯`, description: `单方面停战：关系变为和平` },
              { action: 'declare_war', label: `向 ${name} 宣战`, description: `单方面宣战：关系立即变为交战` },
            ];
    for (const c of candidates) {
      push({
        id: `dip:${other}:${c.action}`,
        kind: 'diplomacy',
        label: c.label,
        command: { kind: 'diplomacy', to: other, action: c.action },
        estimate: { currentRelation: rel },
        description: `${c.description}；AI 暂不讨价还价`,
        priority: 8,
      });
    }
    }
  }

  // ── 奴隶贸易：已颁布鬻奴令，且相邻地块属于非交战、非禁运的势力 ──
  const slaveCfg = world.slaveTrade;
  if (slaveCfg && faction.laws.includes(slaveCfg.lawId)) {
    const own = new Set(regionsOf(state, fid));
    const seenSource = new Set<RegionId>();
    for (const toRegion of [...own].sort()) {
      const toDef = world.regions[toRegion];
      if (!toDef) continue;
      for (const fromRegion of [...(toDef.adjacency ?? [])].sort()) {
        if (seenSource.has(fromRegion)) continue;
        const source = state.regions[fromRegion];
        const sellerId = source?.owner;
        if (!sellerId || sellerId === fid) continue;
        const seller = state.factions[sellerId];
        if (!seller || seller.eliminated) continue;
        if (tradePolicyBetween(state, fid, sellerId, slaveCfg.grudgeBlock) === 'embargo') continue;
        const capacity = slaveSourceCapacity(state, world, fromRegion, sellerId);
        let count = Math.min(slaveCfg.maxPerTrade, capacity);
        count = Math.floor(count / 500) * 500;
        if (count < slaveCfg.minPerTrade) continue;
        let price = slaveTradePrice(state, world, fid, sellerId, count);
        while (price > faction.gold && count > slaveCfg.minPerTrade) {
          count -= 500;
          price = slaveTradePrice(state, world, fid, sellerId, count);
        }
        if (price > faction.gold) continue;
        seenSource.add(fromRegion);
        const grudge = getGrudge(state, fid, sellerId);
        const policy = tradePolicyBetween(state, fid, sellerId, slaveCfg.grudgeBlock);
        push({
          id: `slave:${sellerId}:${fromRegion}:${toRegion}`,
          kind: 'trade_slaves',
          label: `向 ${seller.name} 买奴 ${count}（${price} 金）`,
          command: { kind: 'trade_slaves', fromFaction: sellerId, fromRegion, toRegion, count },
          sourceRegion: toRegion,
          targetRegion: fromRegion,
          estimate: {
            slaveCount: count,
            goldCost: price,
            grudge,
            tradePolicy: policy,
            buyerMoraleCost: slaveCfg.buyerMoraleCost,
            sellerMoraleCost: slaveCfg.sellerMoraleCost,
            banditUnrestPerTurn: slaveCfg.banditUnrestPerTurn,
          },
          description:
            `仅限相邻地块；奴隶只能编为最低级「${world.unitTypes[slaveCfg.slaveUnitType]?.name ?? slaveCfg.slaveUnitType}」并获「贼配军」头衔；` +
            `每支贼配军每回合 +${slaveCfg.banditUnrestPerTurn} 本区动乱；成交后买方民心 -${slaveCfg.buyerMoraleCost}、卖方民心 -${slaveCfg.sellerMoraleCost}；` +
            `当前贸易政策：${policy}，潜在恨意 ${grudge}`,
          priority: 6,
        });
      }
    }
  }

  // ── 开荒：已派兵进入的空白地块，完成基建 Lv1 并占领 ──
  const frontierCfg = world.frontier;
  if (frontierCfg) {
    for (const rid of Object.keys(world.regions).sort()) {
      const st = state.regions[rid];
      const def = world.regions[rid];
      if (!st || !def || st.owner !== null || st.rebellion) continue;
      const own = unitsIn(state, rid, fid).filter((u) => u.troops > 0);
      if (own.length === 0) continue;
      // 与 frontier.resolve 的“派兵与开荒分两回合”保持一致：全部部队本回合都动过时，
      // 不把必然被拒的开荒动作放进合法空间，避免玩家点了才在结算时吃 REJECT。
      if (!own.some((u) => !u.movedThisTurn)) continue;
      const others = unitsIn(state, rid).filter((u) => u.ownerId !== fid && u.ownerId !== 'neutral');
      if (others.length > 0) continue;
      const neutral = unitsIn(state, rid, 'neutral').filter((u) => u.troops > 0);
      const natives = neutral.reduce((sum, u) => sum + u.troops, 0);
      const ownTroops = own.reduce((sum, u) => sum + u.troops, 0);
      const requiredTroops = Math.ceil(natives * frontierCfg.nativeTroopRatio);
      if (ownTroops < requiredTroops) continue;
      if (faction.gold < frontierCfg.settleGoldCost || faction.food < frontierCfg.settleFoodCost) continue;
      const loot = Math.round(def.baseGold * frontierCfg.lootGoldRatio);
      const manpower = Math.round(natives * frontierCfg.nativeManpowerRatio);
      const regionName = def.name ?? rid;
      push({
        id: `settle:${rid}`,
        kind: 'settle_region',
        label: `开荒 ${regionName}（基建 Lv${frontierCfg.settledInfrastructure}，${frontierCfg.settleGoldCost} 金）`,
        command: { kind: 'settle_region', regionId: rid },
        sourceRegion: rid,
        targetRegion: rid,
        estimate: {
          natives,
          requiredTroops,
          ownTroops,
          goldCost: frontierCfg.settleGoldCost,
          foodCost: frontierCfg.settleFoodCost,
          lootGold: loot,
          nativeManpower: manpower,
          infrastructure: frontierCfg.settledInfrastructure,
        },
        description:
          `要求本区已有本方部队且兵力 ≥ ${requiredTroops}（当前 ${ownTroops}）；` +
          `花费 ${frontierCfg.settleGoldCost} 金 / ${frontierCfg.settleFoodCost} 粮，直接建成基建 Lv${frontierCfg.settledInfrastructure}；` +
          `原住民 ${natives} 归化，获得 ${manpower} 兵源与约 ${loot} 金。普通进攻不能占领未开垦区。`,
        priority: 2,
      });
    }
  }

  // ── 起义区宣称：民心高于原属国、相邻、民兵未灭 ──
  const rebellionCfg = world.rebellion;
  if (rebellionCfg) {
    const ownRegions = regionsOf(state, fid);
    const adjacentToOwn = (rid: RegionId): boolean =>
      (world.regions[rid]?.adjacency ?? []).some((n) => state.regions[n]?.owner === fid);
    for (const rid of Object.keys(state.regions).sort()) {
      const st = state.regions[rid]!;
      const reb = st.rebellion;
      if (!reb || st.owner !== null || reb.claimedBy !== undefined) continue;
      if (reb.from === fid) continue;
      const rebelTroops = rebelTroopsInRegion(state, rid);
      if (rebelTroops <= 0) continue;
      const originalMorale = state.factions[reb.from]?.morale ?? 0;
      if (faction.morale <= originalMorale + rebellionCfg.claimMoraleLead) continue;
      if (rebellionCfg.claimRequiresAdjacency && !adjacentToOwn(rid)) continue;
      if (ownRegions.length === 0) continue;
      const regionName = world.regions[rid]?.name ?? rid;
      const originalName = state.factions[reb.from]?.name ?? reb.from;
      push({
        id: `claim:${rid}`,
        kind: 'claim_rebellion',
        label: `宣称 ${regionName} 起义区（原属 ${originalName}，民心 ${faction.morale}>${originalMorale}）`,
        command: { kind: 'claim_rebellion', regionId: rid },
        targetRegion: rid,
        estimate: {
          claimantMorale: faction.morale,
          originalMorale,
          rebelTroops,
          claimedUnrest: rebellionCfg.claimedUnrest,
          garrisonCap: rebellionCfg.claimedGarrisonCap,
          conscriptionTurns: rebellionCfg.claimedConscriptionTurns,
          normalizeUnrest: rebellionCfg.normalizeUnrest,
        },
        description:
          `宣称成功即自动归附；收归后动乱 ${rebellionCfg.claimedUnrest}，最多保留 ${rebellionCfg.claimedGarrisonCap} 守城民兵（不可调动）；` +
          `${rebellionCfg.claimedConscriptionTurns} 回合内在该区征兵会再次起义；动乱 ≤${rebellionCfg.normalizeUnrest} 时恢复正常。` +
          `原属国 ${originalName} 只能杀光全部起义民兵后重占。`,
        priority: 6,
      });
    }
  }

  // ── 谍报：对非己方区域派间谍，换取 3 回合 exact 视图 ──
  if (world.capabilities?.espionage === true) {
    const ownRegionSet = new Set(regionsOf(state, fid));
    const isBorderTarget = (rid: RegionId): boolean =>
      (world.regions[rid]?.adjacency ?? []).some((n) => ownRegionSet.has(n));
    const suspects = Object.keys(world.regions)
      .filter((rid) => state.regions[rid]?.owner !== fid)
      .sort((a, b) => {
        // 先给边境（最常需要情报），再给战略要地，其余按 id
        const ba = isBorderTarget(a) ? 0 : 1;
        const bb = isBorderTarget(b) ? 0 : 1;
        if (ba !== bb) return ba - bb;
        const sa = world.regions[a]?.strategic ? 0 : 1;
        const sb = world.regions[b]?.strategic ? 0 : 1;
        return sa !== sb ? sa - sb : a < b ? -1 : 1;
      });
    for (const rid of suspects) {
      const cost = spyGoldCost(world, rid);
      if (faction.gold < cost) continue;
      const target = state.regions[rid]!;
      const ownerName = target.owner ? (state.factions[target.owner]?.name ?? target.owner) : '中立';
      const intelMult = terrainTraits(world.regions[rid]?.terrain ?? 'plains').intelCost;
      push({
        id: `spy:${rid}`,
        kind: 'send_spy',
        label: `派间谍侦察 ${world.regions[rid]?.name ?? rid}（${ownerName}）`,
        command: { kind: 'send_spy', regionId: rid },
        targetRegion: rid,
        estimate: { spyCost: cost, intelTurns: INTEL_VALID_TURNS, intelCostMultiplier: intelMult },
        description:
          `花费 ${cost} 金（地形情报难度×${Number(intelMult.toFixed(2))}）；` +
          `${INTEL_VALID_TURNS} 回合内可看该区精确驻军、动乱、要塞与基建`,
        priority: 6,
      });
    }
  }

  // ── 裁军（缺粮出路，也可主动裁减省军费/回兵源）──
  for (const u of [...ownUnits].sort((a, b) => a.troops - b.troops || (a.id < b.id ? -1 : 1))) {
    const type = world.unitTypes[u.typeId];
    const refund = type ? Math.round((type.recruitGold * u.troops) / 1000 * 0.5) : 0;
    push({
      id: `disband:${u.id}`,
      kind: 'disband',
      label: `裁撤 ${type?.name ?? u.typeId}(${u.troops})`,
      command: { kind: 'disband', unitId: u.id, count: u.troops },
      sourceRegion: u.regionId,
      estimate: { troopsReleased: u.troops, goldRefund: refund },
      description: `遣散 ${u.troops} 兵：兵源 +${u.troops}，返还约 ${refund} 金；该部队从地图移除`,
      priority: 9,
    });
  }

  return out
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, maxActions);
}

function conscriptRatioOf(world: WorldConfig, population: number): number {
  for (const tier of world.economy.conscriptTiers) {
    if (tier.popBelow === null || population < tier.popBelow) return tier.ratio;
  }
  return 0.04;
}

function isBorder(state: GameState, world: WorldConfig, fid: FactionId, rid: RegionId): boolean {
  for (const n of world.regions[rid]?.adjacency ?? []) {
    const o = state.regions[n]?.owner;
    if (o !== null && o !== undefined && o !== fid) return true;
  }
  return false;
}

/** 基建效果的人类可读摘要（只给人类 UI；不参与结算） */
function infrastructureEffectText(world: WorldConfig, def: InfrastructureLevelDef): string {
  const g = world.governance;
  if (!g) return '本剧本未启用基建';
  return (
    `本区动乱 -${def.unrestRelief}（立即）、-${def.unrestReductionPerTurn}/回合；` +
    `本区人口 +${(def.populationGrowthBonus * 100).toFixed(1)}%/回合；` +
    `全国民心 +${g.infrastructure.moraleOnBuild}（立即）；` +
    `基建点 ${def.moralePoints}（每 ${g.infrastructure.moralePointsPerTurnPoint} 点 +1 民心/回合）`
  );
}

/** 法令效果的人类可读摘要（与 legalAction.description 共用；不参与结算） */
function lawEffectText(effects: LawEffects): string {
  const e = effects as Record<string, number | undefined>;
  const parts: string[] = [];
  const multiplier = (key: string, label: string): void => {
    const v = e[key];
    if (typeof v !== 'number') return;
    parts.push(`${label} ×${Number(v.toFixed(2))}`);
  };
  const perTurn = (key: string, label: string): void => {
    const v = e[key];
    if (typeof v !== 'number') return;
    parts.push(`${label} ${v > 0 ? '+' : ''}${v}/回合`);
  };
  multiplier('foodMultiplier', '粮产');
  multiplier('goldMultiplier', '金收入');
  multiplier('upkeepMultiplier', '军费');
  multiplier('recruitCostMultiplier', '征兵成本');
  multiplier('combatPowerMultiplier', '战力');
  perTurn('moralePerTurn', '民心');
  perTurn('unrestPerTurn', '动乱');
  return parts.length > 0 ? parts.join('；') : '无额外效果';
}

/** 反查：给定 legalActionId 找回动作。闸门用它校验 LLM 的引用是否真实存在 */
export function findLegalAction(actions: readonly LegalAction[], id: string): LegalAction | undefined {
  return actions.find((a) => a.id === id);
}

/** 相邻可进攻目标数（供告警与 AI 启发式用） */
export function countAttackOptions(state: GameState, world: WorldConfig, fid: FactionId): number {
  return attackTargets(state, world, fid).length;
}
