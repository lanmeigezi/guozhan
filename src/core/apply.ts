/**
 * 回合结算编排器 —— 确定性核心的唯一入口。
 *
 * 契约（aonw ADR 0013 的无状态主机函数）：
 *   resolveTurn(state, world, modules, orders, rootSeed, turn, now, digest) → TurnOutcome
 * **全部输入显式传入，不保留进程内会话状态，all-or-nothing。**
 *
 * ★三条铁律：
 *   1. 拒绝不改状态 —— 校验失败的命令绝不产生任何副作用
 *   2. 无一处系统随机 / 时钟 / IO —— rng 与 now 由调用方注入，digest 也是
 *   3. LLM delta 只是"提示"，最终数值由本文件裁决并钳制（P2 "LLM narrates, code decides"）
 */
import type {
  FactionId,
  GameState,
  InfrastructureLevel,
  RegionId,
  RegionState,
  FactionState,
  UnitState,
  UnitId,
  UnitTitle,
  RebellionState,
  RelationEntry,
  RngState,
  WorldConfig,
} from './state.ts';
import { GRUDGE_MAX, relationKey } from './state.ts';
import type {
  AcceptedOrder,
  ClampRecord,
  DeltaRecord,
  Mutation,
  ResolveContext,
  RuleModule,
  TurnOutcome,
} from './module.ts';
import { DeterministicRng } from './rng.ts';

/** 经四道闸门清洗后的 LLM delta。核心只接受这个形状，不接受 LLM 原始输出。 */
export interface SanitizedLlmDelta {
  /** 士气调整：已被 Guardrail 钳到允许范围 */
  readonly moraleAdjustments?: ReadonlyArray<{
    readonly factionId: FactionId;
    readonly delta: number;
    readonly reason: string;
  }>;
  /** 动乱事件 */
  readonly unrestEvents?: ReadonlyArray<{
    readonly regionId: RegionId;
    readonly delta: number;
    readonly severity: 'minor' | 'major' | 'revolt';
    readonly reason: string;
  }>;
  /** 战斗伤亡"提示"——最终值由 core 裁决并钳在 casualtyClamp 内 */
  readonly casualtyHints?: ReadonlyArray<{
    readonly regionId: RegionId;
    readonly attackerHint: number;
    readonly defenderHint: number;
    readonly reason: string;
  }>;
}

export interface ApplyInput {
  readonly state: GameState;
  readonly world: WorldConfig;
  readonly modules: readonly RuleModule[];
  /** 已通过结构校验的命令。★必须按 seatId 排序后传入，保证结算顺序确定 */
  readonly orders: readonly AcceptedOrder[];
  readonly rootSeed: string;
  readonly turn: number;
  /** 时钟由调用方注入 */
  readonly now: number;
  /** 摘要函数由调用方注入（core 不得 import node:crypto） */
  readonly digest: (state: GameState) => string;
  /** 已经过四道闸门的 LLM delta；null/undefined = 本回合纯确定性 */
  readonly llmDelta?: SanitizedLlmDelta | null;
}

// ─────────────────────────────────────────────────────────────
// 可变草稿：核心不改传入的 state，而是改草稿，最后一次性产出新 state
// ─────────────────────────────────────────────────────────────

interface MRegion {
  id: RegionId;
  owner: FactionId | null;
  development: 1 | 2 | 3 | 4 | 5;
  fortLevel: 0 | 1 | 2 | 3;
  infrastructure: InfrastructureLevel;
  foodStock: number;
  unrest: number;
  lastBattleTurn: number | null;
  lastOwner?: FactionId | null;
  rebellion?: RebellionState;
}
interface MFaction {
  id: FactionId;
  name: string;
  gold: number;
  food: number;
  morale: number;
  manpower: number;
  capital: RegionId;
  taxRate: number;
  laws: string[];
  conscriptStreak: number;
  intel: Record<string, number>;
  eliminated: boolean;
}
interface MUnit {
  id: UnitId;
  ownerId: FactionId;
  regionId: RegionId;
  typeId: string;
  troops: number;
  movedThisTurn: boolean;
  title?: UnitTitle;
  garrisonOnly?: boolean;
}

class Draft {
  readonly regions = new Map<RegionId, MRegion>();
  readonly factions = new Map<FactionId, MFaction>();
  readonly units = new Map<UnitId, MUnit>();
  readonly relations = new Map<string, RelationEntry>();

  constructor(state: GameState) {
    for (const [id, r] of Object.entries(state.regions)) {
      // 旧存档没有 infrastructure 字段；默认 0，等价于从未修建
      this.regions.set(id, { ...r, infrastructure: r.infrastructure ?? 0 });
    }
    for (const [id, f] of Object.entries(state.factions)) {
      this.factions.set(id, { ...f, laws: [...f.laws], intel: { ...(f.intel ?? {}) } });
    }
    for (const [id, u] of Object.entries(state.units)) {
      this.units.set(id, { ...u });
    }
    for (const [k, v] of Object.entries(state.relations)) {
      this.relations.set(k, { ...v });
    }
  }

  /** ★键必须排序后重建，否则 JSON.stringify 的顺序随插入序变化 → digest 漂移 → 重放失效 */
  toState(base: GameState, rngState: Record<string, RngState>): GameState {
    const regions: Record<RegionId, RegionState> = {};
    for (const id of [...this.regions.keys()].sort()) {
      const r = this.regions.get(id)!;
      regions[id] = {
        id: r.id,
        owner: r.owner,
        development: r.development,
        fortLevel: r.fortLevel,
        infrastructure: r.infrastructure,
        foodStock: r.foodStock,
        unrest: r.unrest,
        lastBattleTurn: r.lastBattleTurn,
        ...(r.lastOwner !== undefined ? { lastOwner: r.lastOwner } : {}),
        ...(r.rebellion !== undefined ? { rebellion: { ...r.rebellion } } : {}),
      };
    }
    const factions: Record<FactionId, FactionState> = {};
    for (const id of [...this.factions.keys()].sort()) {
      const f = this.factions.get(id)!;
      factions[id] = {
        id: f.id,
        name: f.name,
        gold: f.gold,
        food: f.food,
        morale: f.morale,
        manpower: f.manpower,
        capital: f.capital,
        taxRate: f.taxRate,
        laws: [...f.laws].sort(),
        conscriptStreak: f.conscriptStreak,
        intel: Object.fromEntries(Object.entries(f.intel).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        eliminated: f.eliminated,
      };
    }
    const units: Record<UnitId, UnitState> = {};
    for (const id of [...this.units.keys()].sort()) {
      const u = this.units.get(id)!;
      units[id] = {
        id: u.id,
        ownerId: u.ownerId,
        regionId: u.regionId,
        typeId: u.typeId,
        troops: u.troops,
        movedThisTurn: u.movedThisTurn,
        ...(u.title !== undefined ? { title: u.title } : {}),
        ...(u.garrisonOnly === true ? { garrisonOnly: true } : {}),
      };
    }
    const relations: Record<string, RelationEntry> = {};
    for (const k of [...this.relations.keys()].sort()) {
      relations[k] = this.relations.get(k)!;
    }
    const rngSorted: Record<string, RngState> = {};
    for (const k of Object.keys(rngState).sort()) rngSorted[k] = rngState[k]!;

    return {
      turn: base.turn,
      phase: base.phase,
      regions,
      factions,
      units,
      relations,
      rngState: rngSorted,
      submitted: [...base.submitted].sort(),
      winner: base.winner,
      endReason: base.endReason,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// 结算
// ─────────────────────────────────────────────────────────────

export function resolveTurn(input: ApplyInput): TurnOutcome {
  const { state, world, modules, orders, rootSeed, turn, now, digest } = input;
  const draft = new Draft(state);
  const events: unknown[] = [];
  const deltas: DeltaRecord[] = [];
  const clamps: ClampRecord[] = [];
  const rejected: Array<{ seatId: string; index: number; code: string; message: string }> = [];
  const rngStreams = new Map<string, DeterministicRng>();
  const rngSnapshots: Record<string, RngState> = { ...state.rngState };

  /** ctx.state 的缓存；任何 mutate 都必须置空它，否则模块读到过期视图 */
  let stateCache: GameState | null = null;
  const currentRngSnapshots = (): Record<string, RngState> => {
    const out: Record<string, RngState> = { ...state.rngState };
    for (const [k, s] of rngStreams) out[k] = s.snapshot();
    return out;
  };

  // 回合开始前的兵力基准，用于 per-faction 极值钳制
  const troopsBefore = new Map<FactionId, number>();
    const foodBefore = new Map<FactionId, number>();
  for (const [fid, f] of draft.factions) {
    foodBefore.set(fid, f.food);
    let t = 0;
    for (const u of draft.units.values()) if (u.ownerId === fid) t += u.troops;
    troopsBefore.set(fid, t);
  }

  const rng = (name: 'combat' | 'event' | 'unrest' | 'ai', ...parts: ReadonlyArray<string | number>): DeterministicRng => {
    const key = [name, ...parts].join('\u0000');
    let stream = rngStreams.get(key);
    if (!stream) {
      stream =
        name === 'combat'
          ? DeterministicRng.forCombat(rootSeed, turn, String(parts[0] ?? ''), String(parts[1] ?? ''), String(parts[2] ?? ''))
          : name === 'event'
            ? DeterministicRng.forEvent(rootSeed, turn, String(parts[0] ?? ''), String(parts[1] ?? ''))
            : name === 'unrest'
              ? DeterministicRng.forUnrest(rootSeed, turn, String(parts[0] ?? ''))
              : DeterministicRng.forAi(rootSeed, turn, String(parts[0] ?? ''));
      rngStreams.set(key, stream);
    }
    return stream;
  };

  /** 把 mutation 施加到草稿，并顺手记录逐字段增量归因 */
  const apply = (m: Mutation, source: DeltaRecord['source']): void => {
    switch (m.op) {
      case 'set_region_owner': {
        const r = draft.regions.get(m.regionId);
        if (!r) return;
        if (r.owner !== m.owner) {
          // 易主时记住上一任领主：攻方拿回自己刚丢的地即为「收复故土」
          r.lastOwner = r.owner;
          r.owner = m.owner;
        }
        return;
      }
      case 'set_region_development': {
        const r = draft.regions.get(m.regionId);
        if (!r || r.development === m.development) return;
        record(deltas, `region:${m.regionId}`, 'development', r.development, m.development, '开发完成', source);
        r.development = m.development;
        return;
      }
      case 'set_region_fort': {
        const r = draft.regions.get(m.regionId);
        if (!r || r.fortLevel === m.fortLevel) return;
        record(deltas, `region:${m.regionId}`, 'fortLevel', r.fortLevel, m.fortLevel, '修建要塞', source);
        r.fortLevel = m.fortLevel;
        return;
      }
      case 'set_region_infrastructure': {
        const r = draft.regions.get(m.regionId);
        if (!r || r.infrastructure === m.infrastructure) return;
        record(deltas, `region:${m.regionId}`, 'infrastructure', r.infrastructure, m.infrastructure, '修建基建', source);
        r.infrastructure = m.infrastructure;
        return;
      }
      case 'set_region_rebellion': {
        const r = draft.regions.get(m.regionId);
        if (!r) return;
        if (m.rebellion === null) delete r.rebellion;
        else r.rebellion = { ...m.rebellion };
        return;
      }
      case 'add_region_food': {
        const r = draft.regions.get(m.regionId);
        if (!r) return;
        const before = r.foodStock;
        r.foodStock = Math.max(0, Math.round(r.foodStock + m.delta));
        record(deltas, `region:${m.regionId}`, 'foodStock', before, r.foodStock, '区域粮产', source);
        return;
      }
      case 'add_region_unrest': {
        const r = draft.regions.get(m.regionId);
        if (!r) return;
        const before = r.unrest;
        r.unrest = clamp(r.unrest + m.delta, 0, 100);
        record(deltas, `region:${m.regionId}`, 'unrest', before, r.unrest, m.reason ?? '动乱变化', source);
        return;
      }
      case 'add_faction_gold': {
        const f = draft.factions.get(m.factionId);
        if (!f) return;
        const before = f.gold;
        f.gold = Math.round(f.gold + m.delta);
        record(deltas, `faction:${m.factionId}`, 'gold', before, f.gold, m.reason, source);
        return;
      }
      case 'add_faction_food': {
        const f = draft.factions.get(m.factionId);
        if (!f) return;
        const before = f.food;
        f.food = Math.round(f.food + m.delta);
        record(deltas, `faction:${m.factionId}`, 'food', before, f.food, m.reason, source);
        return;
      }
      case 'add_faction_morale': {
        const f = draft.factions.get(m.factionId);
        if (!f) return;
        const before = f.morale;
        f.morale = clamp(Math.round(f.morale + m.delta), world.economy.moraleMin, world.economy.moraleMax);
        record(deltas, `faction:${m.factionId}`, 'morale', before, f.morale, m.reason, source);
        return;
      }
      case 'add_faction_manpower': {
        const f = draft.factions.get(m.factionId);
        if (!f) return;
        const before = f.manpower;
        f.manpower = Math.max(0, Math.round(f.manpower + m.delta));
        record(deltas, `faction:${m.factionId}`, 'manpower', before, f.manpower, m.reason, source);
        return;
      }
      case 'set_faction_tax_rate': {
        const f = draft.factions.get(m.factionId);
        if (!f) return;
        f.taxRate = m.rate;
        return;
      }
      case 'set_faction_laws': {
        const f = draft.factions.get(m.factionId);
        if (!f) return;
        f.laws = [...m.laws];
        return;
      }
      case 'set_conscript_streak': {
        const f = draft.factions.get(m.factionId);
        if (!f) return;
        f.conscriptStreak = m.streak;
        return;
      }
      case 'set_faction_intel': {
        const f = draft.factions.get(m.factionId);
        if (!f) return;
        f.intel[m.regionId] = m.turn;
        return;
      }
      case 'eliminate_faction': {
        const f = draft.factions.get(m.factionId);
        if (!f || f.eliminated) return;
        f.eliminated = true;
        events.push({ type: 'faction_eliminated', turn, factionId: m.factionId, reason: m.reason });
        return;
      }
      case 'move_unit': {
        const u = draft.units.get(m.unitId);
        if (!u) return;
        const from = u.regionId;
        u.regionId = m.toRegion;
        u.movedThisTurn = true;
        events.push({
          type: 'units_moved',
          turn,
          unitId: m.unitId,
          from,
          to: m.toRegion,
          path: m.path,
          movementSpent: m.movementSpent,
        });
        return;
      }
      case 'add_unit_troops': {
        const u = draft.units.get(m.unitId);
        if (!u) return;
        const before = u.troops;
        u.troops = Math.max(0, Math.round(u.troops + m.delta));
        record(deltas, `unit:${m.unitId}`, 'troops', before, u.troops, m.reason, source);
        if (u.troops === 0) draft.units.delete(m.unitId);
        return;
      }
      case 'spawn_unit': {
        if (draft.units.has(m.unitId)) return;
        draft.units.set(m.unitId, {
          id: m.unitId,
          ownerId: m.ownerId,
          regionId: m.regionId,
          typeId: m.typeId,
          troops: m.troops,
          movedThisTurn: m.movedThisTurn ?? true,
          ...(m.title !== undefined ? { title: m.title as UnitTitle } : {}),
          ...(m.garrisonOnly === true ? { garrisonOnly: true } : {}),
        });
        return;
      }
      case 'set_unit_garrison': {
        const u = draft.units.get(m.unitId);
        if (!u) return;
        u.garrisonOnly = m.garrisonOnly;
        if (m.title === null) delete u.title;
        else if (m.title !== undefined) u.title = m.title as UnitTitle;
        return;
      }
      case 'destroy_unit': {
        if (!draft.units.has(m.unitId)) return;
        draft.units.delete(m.unitId);
        return;
      }
      case 'set_relation': {
        const key = relationKey(m.a, m.b);
        const prev = draft.relations.get(key);
        if (prev?.kind === m.kind) return;
        const enteringWar = m.kind === 'war' && prev?.kind !== 'war';
        draft.relations.set(key, {
          kind: m.kind as RelationEntry['kind'],
          sinceTurn: turn,
          ...(prev?.grudge !== undefined ? { grudge: prev.grudge } : {}),
          ...(enteringWar || prev?.wars !== undefined ? { wars: (prev?.wars ?? 0) + (enteringWar ? 1 : 0) } : {}),
          ...(enteringWar || prev?.lastWarTurn !== undefined
            ? { lastWarTurn: enteringWar ? turn : prev!.lastWarTurn! }
            : {}),
        });
        events.push({
          type: 'diplomacy_changed',
          turn,
          a: m.a,
          b: m.b,
          from: prev?.kind ?? 'neutral',
          to: m.kind,
          publicity: m.kind === 'war' ? 'public' : 'non-public',
        });
        return;
      }
      case 'add_relation_grudge': {
        const key = relationKey(m.a, m.b);
        const prev = draft.relations.get(key);
        const before = prev?.grudge ?? 0;
        const after = Math.max(0, Math.min(GRUDGE_MAX, Math.round(before + m.delta)));
        if (after === before) return;
        draft.relations.set(key, {
          kind: prev?.kind ?? 'neutral',
          sinceTurn: prev?.sinceTurn ?? 0,
          grudge: after,
          ...(prev?.wars !== undefined ? { wars: prev.wars } : {}),
          ...(prev?.lastWarTurn !== undefined ? { lastWarTurn: prev.lastWarTurn } : {}),
        });
        record(deltas, `relation:${key}`, 'grudge', before, after, m.reason, source);
        return;
      }
    }
  };

  const ctx: ResolveContext = {
    /**
     * ★实时视图，不是回合开始的冻结快照。
     *
     * 为什么必须是实时的：moduleOrder = economy → movement → combat，
     * 战斗模块必须看得见移动模块刚挪过去的部队。若给的是回合初快照，
     * "先移动再攻击"这个最基本的操作会静默失效。
     * 用缓存 + mutate 失效来避免每次访问都重建（19 区域规模下重建也只需微秒级）。
     */
    get state(): GameState {
      if (!stateCache) stateCache = draft.toState({ ...state, turn, phase: 'resolving' }, currentRngSnapshots());
      return stateCache;
    },
    world,
    orders,
    turn,
    now,
    rootSeed,
    rng,
    mutate: (m) => {
      stateCache = null;
      apply(m, 'deterministic');
    },
    emit: (e) => events.push(e),
    reject: (order, code, message) => {
      const index = orders.indexOf(order);
      rejected.push({ seatId: order.seatId, index: index < 0 ? -1 : index, code, message });
    },
    recordDelta: (d) => deltas.push(d),
    get deltas() {
      return deltas;
    },
  };

  // ── 1. 按注册顺序跑各玩法模块（顺序由 scenario.json 的 moduleOrder 决定）──
  for (const mod of modules) {
    mod.resolve(ctx);
  }

  // ── 2. 应用 LLM delta（已过四道闸门；核心仍做最终裁决与钳制）──
  const llmDelta = input.llmDelta ?? null;
  if (llmDelta) {
    for (const adj of llmDelta.moraleAdjustments ?? []) {
      const f = draft.factions.get(adj.factionId);
      if (!f || f.eliminated) continue;
      const before = f.morale;
      f.morale = clamp(Math.round(f.morale + adj.delta), world.economy.moraleMin, world.economy.moraleMax);
      record(deltas, `faction:${adj.factionId}`, 'morale', before, f.morale, adj.reason, 'llm');
    }
    for (const ev of llmDelta.unrestEvents ?? []) {
      const r = draft.regions.get(ev.regionId);
      if (!r) continue;
      const before = r.unrest;
      r.unrest = clamp(r.unrest + ev.delta, 0, 100);
      record(deltas, `region:${ev.regionId}`, 'unrest', before, r.unrest, ev.reason, 'llm');
      events.push({ type: 'unrest_event', turn, regionId: ev.regionId, severity: ev.severity, description: ev.reason });
    }
    // 伤亡提示：不直接施加，而是留给战斗模块在**下一回合**参考；
    // 本回合的战斗已由确定性代码结算完毕（P2：LLM 的提示不是门）
  }

  // ── 3. per-faction 独立极值钳制（★必须在叙事生成之前，Histrategy H39b 事故）──
  for (const [fid, f] of draft.factions) {
    clampFaction(draft, fid, f, troopsBefore.get(fid) ?? 0, foodBefore.get(fid) ?? 0, world, clamps, deltas, turn);
  }

  // ── 4. 记录各随机流的最终状态（重放的地基）──
  for (const [key, stream] of rngStreams) {
    rngSnapshots[key] = stream.snapshot();
  }

  // ── 5. 清空本回合行动标记，再推进回合 ──
  // ★这是"每回合可行动一次"的复位点。旧实现只置 true 从不复位，
  //   单位一旦移动过就永久停摆（水师尤其明显：走一次就再也动不了）。
  //   在结算末尾复位，下一回合的 submitting 状态即可再次下达移动/进攻。
  for (const u of draft.units.values()) u.movedThisTurn = false;
  let nextState = draft.toState(
    { ...state, turn, phase: 'narrating' },
    rngSnapshots,
  );
  const verdict = judgeVictory(nextState, world);
  if (verdict) {
    nextState = { ...nextState, phase: 'ended', winner: verdict.winner, endReason: verdict.reason };
    events.push({
      type: 'match_ended',
      turn,
      winner: verdict.winner,
      reason: verdict.reason,
      scores: verdict.scores,
    });
  } else if (world.maxTurns > 0 && turn >= world.maxTurns) {
    nextState = { ...nextState, phase: 'ended', winner: null, endReason: 'turn_limit' };
    events.push({ type: 'match_ended', turn, winner: null, reason: 'turn_limit', scores: {} });
  }

  events.push({
    type: 'turn_recap',
    turn,
    factions: buildTurnRecap(state, nextState),
  });

  events.push({
    type: 'turn_resolved',
    turn,
    deltas,
    clamps,
    llmApplied: llmDelta !== null,
    stateId: digest(nextState),
  });

  return {
    state: nextState,
    events,
    deltas,
    clamps,
    rngState: rngSnapshots,
    llmApplied: llmDelta !== null,
    newStateDigest: digest(nextState),
    rejected,
  };
}

// ─────────────────────────────────────────────────────────────
// 辅助
// ─────────────────────────────────────────────────────────────

function buildTurnRecap(
  before: GameState,
  after: GameState,
): Array<{
  id: FactionId;
  name: string;
  regionsBefore: number;
  regionsAfter: number;
  regionsDelta: number;
  goldDelta: number;
  foodDelta: number;
  moraleDelta: number;
  troopsBefore: number;
  troopsAfter: number;
  eliminated: boolean;
}> {
  const regions = (state: GameState): Map<FactionId, number> => {
    const out = new Map<FactionId, number>();
    for (const r of Object.values(state.regions)) {
      if (r.owner) out.set(r.owner, (out.get(r.owner) ?? 0) + 1);
    }
    return out;
  };
  const troops = (state: GameState): Map<FactionId, number> => {
    const out = new Map<FactionId, number>();
    for (const u of Object.values(state.units)) {
      out.set(u.ownerId, (out.get(u.ownerId) ?? 0) + u.troops);
    }
    return out;
  };
  const rb = regions(before);
  const ra = regions(after);
  const tb = troops(before);
  const ta = troops(after);
  return Object.keys(after.factions)
    .sort()
    .map((id) => {
      const b = before.factions[id];
      const a = after.factions[id]!;
      return {
        id,
        name: a.name,
        regionsBefore: rb.get(id) ?? 0,
        regionsAfter: ra.get(id) ?? 0,
        regionsDelta: (ra.get(id) ?? 0) - (rb.get(id) ?? 0),
        goldDelta: a.gold - (b?.gold ?? a.gold),
        foodDelta: a.food - (b?.food ?? a.food),
        moraleDelta: a.morale - (b?.morale ?? a.morale),
        troopsBefore: Math.round(tb.get(id) ?? 0),
        troopsAfter: Math.round(ta.get(id) ?? 0),
        eliminated: a.eliminated,
      };
    });
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function record(
  out: DeltaRecord[],
  scope: string,
  field: string,
  oldValue: number,
  newValue: number,
  reason: string,
  source: DeltaRecord['source'],
): void {
  out.push({ scope, field, oldValue, newValue, delta: newValue - oldValue, reason, source });
}

/**
 * per-faction 独立极值钳制。
 * ★不按"最大涨幅者全体缩放" —— Histrategy 2026-10-04 前的算法就是这样，
 *   结果一个 1500 人的小势力涨兵，导致元老院和埃及被砍掉一半兵力。
 *   谁超限就压谁，互不牵连。
 */
function clampFaction(
  draft: Draft,
  fid: FactionId,
  f: MFaction,
  troops0: number,
  food0: number,
  world: WorldConfig,
  clamps: ClampRecord[],
  deltas: DeltaRecord[],
  turn: number,
): void {
  void turn;
  const ec = world.economy.extremeClamp;

  // 兵力：对该势力所有部队统一按比例回压
  let troopsNow = 0;
  const owned: MUnit[] = [];
  for (const u of draft.units.values()) {
    if (u.ownerId === fid) {
      troopsNow += u.troops;
      owned.push(u);
    }
  }
  if (troops0 > 0) {
    const maxGain = Math.floor(troops0 * (1 + ec.troopGain));
    const maxLoss = Math.ceil(troops0 * (1 - ec.troopLoss));
    let target = troopsNow;
    let limit = '';
    if (troopsNow > maxGain) { target = maxGain; limit = `troopGain:${ec.troopGain}`; }
    else if (troopsNow < maxLoss) { target = maxLoss; limit = `troopLoss:${ec.troopLoss}`; }
    // troopsNow=0 时 ratio 会是 Infinity，0 × Infinity = NaN；全军打光就保持打光
    if (limit && troopsNow !== target && owned.length > 0 && troopsNow > 0) {
      const ratio = target / troopsNow;
      let acc = 0;
      // ★按 id 排序后分配，保证取整误差的落点确定
      owned.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (let i = 0; i < owned.length; i++) {
        const u = owned[i]!;
        const before = u.troops;
        const isLast = i === owned.length - 1;
        const after = isLast ? Math.max(0, target - acc) : Math.max(0, Math.round(before * ratio));
        acc += after;
        u.troops = after;
        record(deltas, `unit:${u.id}`, 'troops', before, after, `极值钳制 ${limit}`, 'deterministic');
      }
      clamps.push({ scope: `faction:${fid}`, field: 'troops', beforeClamp: troopsNow, afterClamp: target, limit });
    }
  }

  // 金 / 粮：回压“毛收益”，但**保留本回合真实支出**。
  // 金 / 粮：回压“毛收益”，但**保留本回合真实支出**。
  // ★金不再钳制：屯田/低税/基建的收益必须能兑现，否则会出现“越经营越穷、挂机反而富”。
  // 粮食仍保留增幅上限，避免单回合爆仓。
  const spent = (field: 'gold' | 'food'): number =>
    deltas
      .filter((d) => d.scope === `faction:${fid}` && d.field === field && d.delta < 0)
      .reduce((sum, d) => sum + d.delta, 0);
  for (const [field, before, limitKey] of [['food', food0, 'foodGain'] as const]) {
    const now = f[field];
    if (before <= 0) continue;
    const cap = Math.floor(before * (1 + ec[limitKey]));
    const spentNow = spent(field);
    // 先只看“毛收益”是否超过上限，再统一扣回真实支出。
    // 不能只在 now > cap 时才扣，否则“花钱”反而会绕过 cap，出现
    // 不操作国库 6400、建造+国策后反而 6251 的逆向激励。
    const gross = now - spentNow;
    if (gross > cap) {
      const adjusted = cap + spentNow;
      f[field] = adjusted;
      clamps.push({ scope: `faction:${fid}`, field, beforeClamp: now, afterClamp: adjusted, limit: `${limitKey}:${ec[limitKey]}` });
      record(deltas, `faction:${fid}`, field, now, adjusted, `极值钳制 ${limitKey}（保留支出）`, 'deterministic');
    }
  }
  // ★金不再做损失回填：花出去的钱就是花出去了，不能因为“这回合支出多”倒补回来。
  for (const [field, before, limitKey] of [['food', food0, 'foodLoss'] as const]) {
    const now = f[field];
    if (before <= 0) continue;
    const floor = Math.ceil(before * (1 - ec[limitKey]));
    if (now < floor && now < before) {
      f[field] = floor;
      clamps.push({ scope: `faction:${fid}`, field, beforeClamp: now, afterClamp: floor, limit: `${limitKey}:${ec[limitKey]}` });
      record(deltas, `faction:${fid}`, field, now, floor, `极值钳制 ${limitKey}`, 'deterministic');
    }
  }
}

/**
 * 终局判定 + 多维评分。
 * ★评分是**多维**的（经济/领土/军力/士气），不是单一胜负 ——
 *   OpenRA-RL 的教训：单一胜负定位不了失败模式，8 维向量才能看出"经济满分、战斗零分"。
 */
export function judgeVictory(
  state: GameState,
  world: WorldConfig,
): { winner: FactionId | null; reason: 'conquest' | 'turn_limit' | 'draw'; scores: Record<string, Record<string, number>> } | null {
  const totalRegions = Object.keys(state.regions).length;
  const alive: FactionId[] = [];
  const counts = new Map<FactionId, number>();
  for (const [rid, r] of Object.entries(state.regions)) {
    if (r.owner) counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
  }
  for (const [fid, f] of Object.entries(state.factions)) {
    if (!f.eliminated) alive.push(fid);
  }
  alive.sort();

  const scores: Record<string, Record<string, number>> = {};
  for (const fid of alive) {
    const f = state.factions[fid]!;
    let troops = 0;
    for (const u of Object.values(state.units)) if (u.ownerId === fid) troops += u.troops;
    const regions = counts.get(fid) ?? 0;
    scores[fid] = {
      regions,
      territoryRatio: totalRegions > 0 ? Number((regions / totalRegions).toFixed(4)) : 0,
      troops,
      gold: f.gold,
      food: f.food,
      morale: f.morale,
    };
  }

  // 只剩一个势力 → 征服胜利
  if (alive.length === 1) {
    return { winner: alive[0]!, reason: 'conquest', scores };
  }
  // 单一势力达到征服比例
  for (const fid of alive) {
    if ((scores[fid]!.territoryRatio as number) >= world.victoryTerritoryRatio) {
      return { winner: fid, reason: 'conquest', scores };
    }
  }
  return null;
}
