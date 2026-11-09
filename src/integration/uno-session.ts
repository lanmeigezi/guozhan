/**
 * 桌游合集（uno-bt）内嵌国战会话 —— 纯确定性规则，不接任何外部 LLM。
 *
 * 设计取舍：
 *   · 一个 uno-bt 座位 = 一个势力；未分配的势力由本文件用启发式 AI 自动补位。
 *   · 同一回合所有势力先下单、再统一结算（与 guozhan 原版一致）。
 *   · 人类只能提交 `enumerateLegalActions` 里的 actionId，前端不拼规则；
 *     机器人同样只消费这份合法动作空间（没有 AI 后门）。
 *   · 视图复用 `buildSnapshot` 的按接收者投影，战争迷雾不因"桌游化"而消失。
 *   · selfReview / AiPolicy 保留：它只由代码计算，用来让 AI 越打越准。
 */
import type {
  FactionId,
  GameState,
  RegionDef,
  UnitTypeDef,
  WorldConfig,
} from '../core/state.ts';
import { relationKey, regionsOf, terrainTraits } from '../core/state.ts';import { resolveTurn } from '../core/apply.ts';
import { buildModules } from '../core/modules/index.ts';
import { enumerateLegalActions, type LegalAction } from '../core/legal.ts';
import { DomainCommandSchema } from '../protocol/commands.ts';
import type { MapLayout } from '../protocol/map-layout.ts';
import type { AiPolicy, SelfReview } from '../protocol/snapshot.ts';
import { buildSnapshot } from '../server/room/snapshot.ts';
import { decideHeuristic, profileForArchetype } from '../ai/heuristic.ts';
import { deriveSelfReview } from '../ai/selfplay.ts';
import { assignAiArchetypes } from '../ai/archetypes.ts';
import { decideRandom } from '../ai/random.ts';
import type { AiArchetype } from '../protocol/snapshot.ts';
import { generateRandomMap } from '../server/random-map.ts';
import { audienceIncludes, audienceOfEvent, unionAudience } from '../server/store/event-audience.ts';
import { DATA } from './uno-data.generated.ts';

export interface GzScenarioInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly maxTurns: number;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly factions: ReadonlyArray<{ id: string; name: string; color: string }>;
}

export interface GzSeatBinding {
  readonly seat: number;
  readonly name: string;
  /** 该座位是宿主 AI（而不是真人/LLM）；用于识别 AI 原型 */
  readonly isAi?: boolean;
}

export interface GzOrder {
  readonly actionId: string;
  readonly label: string;
  readonly command: Record<string, unknown>;
}

export interface GzReport {
  readonly turn: number;
  readonly events: ReadonlyArray<Record<string, unknown>>;
  readonly rejected: ReadonlyArray<{ seatId: string; code: string; message: string }>;
  readonly baseline: ReadonlyArray<Record<string, unknown>>;
  readonly clamps: ReadonlyArray<Record<string, unknown>>;
}

export class GzError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GzError';
    this.code = code;
  }
}

const MAX_PLAYERS = 12;
const MAX_COMMANDS = 8;

interface ScenarioBundle {
  readonly meta: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly maxTurns: number;
    readonly moduleOrder: readonly string[];
    readonly milestones: ReadonlyArray<{ turn: number; require: Record<string, number>; message: string }>;
  };
  readonly world: WorldConfig;
  readonly initialState: GameState;
  readonly mapLayout: MapLayout;
  readonly colors: Record<string, string>;
  readonly aggression: Record<string, number>;
}

interface FixedData {
  readonly meta: ScenarioBundle['meta'];
  readonly world: WorldConfig;
  readonly initialState: GameState;
  readonly mapLayout: MapLayout;
  readonly colors: Record<string, string>;
  readonly aggression: Record<string, number>;
}

interface RandomData {
  readonly meta: ScenarioBundle['meta'];
  readonly scenario: Record<string, unknown>;
  readonly roster: { factions: Array<Record<string, unknown>> };
  readonly unitsDoc: { unitTypes: Array<Record<string, unknown>> };
  readonly worldBase: WorldConfig;
  readonly layoutHelp: Pick<MapLayout, 'laws' | 'units' | 'rules'>;
}

const RAW = DATA as unknown as {
  fixed: Record<string, FixedData>;
  random: RandomData;
  large: RandomData;
};

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function digestState(state: GameState): string {
  return hash32(JSON.stringify(state)).toString(16).padStart(8, '0');
}

function clampSeed(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text.slice(0, 64) : fallback;
}

function toRegionDefs(doc: { regions: Array<Record<string, any>> }): Record<string, RegionDef> {
  const regions: Record<string, RegionDef> = {};
  for (const r of doc.regions) {
    regions[String(r.id)] = {
      id: String(r.id),
      name: String(r.name),
      terrain: String(r.terrain),
      adjacency: [...(r.adjacency as string[])].sort(),
      baseFood: Number(r.baseFood),
      baseGold: Number(r.baseGold),
      baseManpower: Number(r.baseManpower),
      strategic: r.strategic === true,
      passable: r.passable !== false,
      ...(r.port === true ? { port: true } : {}),
    };
  }
  return regions;
}

function toUnitTypes(doc: { unitTypes: Array<Record<string, any>> }): Record<string, UnitTypeDef> {
  const out: Record<string, UnitTypeDef> = {};
  for (const u of doc.unitTypes) {
    out[String(u.id)] = {
      id: String(u.id),
      name: String(u.name),
      attack: Number(u.attack),
      defense: Number(u.defense),
      movement: Number(u.movement),
      recruitGold: Number(u.recruitGold),
      recruitFood: Number(u.recruitFood),
      recruitManpower: Number(u.recruitManpower),
      upkeepGold: Number(u.upkeepGold),
      upkeepFood: Number(u.upkeepFood),
      ...(u.domain ? { domain: u.domain } : {}),
      ...(u.counters ? { counters: u.counters as Record<string, number> } : {}),
    };
  }
  return out;
}

/** 与 config-loader 的初始状态装配保持一致（随机地图运行时复用）。 */
function buildInitialState(doc: {
  factions: Array<Record<string, any>>;
  initialRelations?: Array<{ a: string; b: string; kind: string }>;
  neutralTerritories?: Array<Record<string, any>>;
}, regions: Record<string, RegionDef>, startTurn: number, grudgeEnabled = false): GameState {
  const regionState: Record<string, any> = {};
  for (const id of Object.keys(regions).sort()) {
    regionState[id] = {
      id,
      owner: null,
      development: 3,
      fortLevel: 0,
      infrastructure: 0,
      foodStock: 0,
      unrest: 10,
      lastBattleTurn: null,
    };
  }
  const factionState: Record<string, any> = {};
  const unitState: Record<string, any> = {};
  for (const f of doc.factions) {
    const fid = String(f.id);
    factionState[fid] = {
      id: fid,
      name: String(f.name),
      gold: Number(f.gold ?? 0),
      food: Number(f.food ?? 0),
      morale: Number(f.morale ?? 70),
      manpower: Number(f.manpower ?? 0),
      capital: String(f.capital),
      taxRate: Number(f.taxRate ?? 0.3),
      laws: [...(f.laws ?? [])].sort(),
      conscriptStreak: 0,
      intel: {},
      eliminated: false,
    };
    for (const t of f.territories as string[]) {
      const r = regionState[t];
      if (r) {
        r.owner = fid;
        const isCapital = t === f.capital;
        r.fortLevel = isCapital ? 2 : regions[t]?.strategic ? 1 : 0;
      }
    }
    for (const u of f.units ?? []) {
      unitState[String(u.id)] = {
        id: String(u.id),
        ownerId: fid,
        regionId: String(u.region),
        typeId: String(u.type),
        troops: Number(u.troops),
        movedThisTurn: false,
      };
    }
  }
  for (const n of doc.neutralTerritories ?? []) {
    unitState[`garrison_${String(n.id)}`] = {
      id: `garrison_${String(n.id)}`,
      ownerId: 'neutral',
      regionId: String(n.id),
      typeId: String(n.garrison?.type),
      troops: Number(n.garrison?.troops ?? 0),
      movedThisTurn: false,
    };
  }
  const relations: Record<string, any> = {};
  for (const r of doc.initialRelations ?? []) {
    relations[relationKey(r.a, r.b)] = {
      kind: r.kind,
      sinceTurn: 0,
      ...(grudgeEnabled && r.kind === 'war' ? { grudge: 25, wars: 1, lastWarTurn: 0 } : {}),
    };
  }
  // 初始兵源池 = 所辖人口
  for (const f of doc.factions) {
    const fid = String(f.id);
    let pop = 0;
    for (const t of f.territories as string[]) {
      const def = regions[t];
      const st = regionState[t];
      if (def && st) pop += def.baseManpower * (1 + (st.development - 1) * 0.25);
    }
    factionState[fid].manpower = f.manpower ?? Math.floor(pop * 0.1);
  }
  return {
    turn: startTurn,
    phase: 'submitting',
    regions: regionState,
    factions: factionState,
    units: unitState,
    relations,
    rngState: {},
    submitted: [],
    winner: null,
    endReason: null,
  };
}

function randomBundle(rootSeed: string, data: RandomData = RAW.random): ScenarioBundle {
  const generated = generateRandomMap({
    scenarioId: String(data.meta.id),
    rootSeed,
    scenario: data.scenario,
    roster: data.roster,
    unitsDoc: data.unitsDoc,
  });
  const regions = toRegionDefs(generated.regionsDoc as { regions: Array<Record<string, any>> });
  const unitTypes = toUnitTypes(data.unitsDoc);
  const world: WorldConfig = {
    ...data.worldBase,
    regions,
    unitTypes,
    waterRoutes: generated.regionsDoc.waterRoutes ?? [],
    contentHash: `runtime-${digestState({
      turn: 0,
      phase: 'submitting',
      regions: regions as any,
      factions: {},
      units: {},
      relations: {},
      rngState: {},
      submitted: [],
      winner: null,
      endReason: null,
    })}`,
  };
  const mapLayout: MapLayout = {
    ...generated.mapLayout,
    laws: data.layoutHelp.laws,
    units: data.layoutHelp.units,
    terrain: terrainHelp(world),
    rules: data.layoutHelp.rules,
  };
  const colors: Record<string, string> = {};
  const aggression: Record<string, number> = {};
  for (const f of data.roster.factions) {
    const fid = String(f.id);
    colors[fid] = String(f.color ?? '#9c8d6e').toLowerCase();
    aggression[fid] = Number((f.personality as { aggression?: number } | undefined)?.aggression ?? 0.5);
  }
  return {
    meta: data.meta,
    world,
    initialState: buildInitialState(
      generated.factionsDoc as { factions: Array<Record<string, any>>; initialRelations?: Array<{ a: string; b: string; kind: string }> },
      regions,
      Number((data.meta as { startTurn?: number }).startTurn ?? 1),
      Array.isArray(data.meta.moduleOrder) && data.meta.moduleOrder.includes('grudge'),
    ),
    mapLayout,
    colors,
    aggression,
  };
}

function terrainHelp(world: WorldConfig): MapLayout['terrain'] {
  return Object.keys(world.combat.terrainModifier).sort().map((id) => {
    const traits = terrainTraits(id);
    const combat = world.combat.terrainModifier[id]!;
    return {
      id,
      food: traits.food,
      gold: traits.gold,
      popGrowth: traits.popGrowth,
      intelCost: traits.intelCost,
      infantryDefense: traits.infantryDefense,
      moveCost: combat.mov,
      defenderBonus: combat.def,
    };
  });
}

function fixedBundle(id: string): ScenarioBundle {
  const data = RAW.fixed[id];
  if (!data) throw new GzError('UNKNOWN_SCENARIO', `未知剧本：${id}`);
  // 深拷贝，保证多局/多房间之间不共享初始状态对象
  return {
    meta: data.meta,
    world: data.world,
    initialState: JSON.parse(JSON.stringify(data.initialState)) as GameState,
    mapLayout: { ...data.mapLayout, terrain: terrainHelp(data.world) },
    colors: { ...data.colors },
    aggression: { ...data.aggression },
  };
}

function scenarioInfo(id: string): GzScenarioInfo | null {
  const randomData = id === 'random-front-v2' ? RAW.random : id === 'grand-front' ? RAW.large : null;
  if (randomData) {
    const factions = randomData.roster.factions.map((f) => ({
      id: String(f.id),
      name: String(f.name),
      color: String(f.color ?? '#9c8d6e'),
    }));
    return {
      id,
      name: String(randomData.meta.name),
      description: String(randomData.meta.description),
      maxTurns: Number(randomData.meta.maxTurns),
      minPlayers: 2,
      maxPlayers: Math.min(MAX_PLAYERS, factions.length),
      factions,
    };
  }
  const fixed = RAW.fixed[id];
  if (!fixed) return null;
  const factions = Object.keys(fixed.initialState.factions).sort().map((fid) => ({
    id: fid,
    name: String(fixed.initialState.factions[fid]?.name ?? fid),
    color: String(fixed.colors[fid] ?? '#9c8d6e'),
  }));
  return {
    id,
    name: String(fixed.meta.name),
    description: String(fixed.meta.description),
    maxTurns: Number(fixed.meta.maxTurns),
    minPlayers: 2,
    maxPlayers: Math.min(MAX_PLAYERS, factions.length),
    factions,
  };
}

const SCENARIO_ORDER = ['random-front-v2', 'grand-front', 'iron-front', 'warring-states', 'warring-states-full', 'frontier'];

export const SCENARIOS: ReadonlyArray<GzScenarioInfo> = Object.freeze(
  SCENARIO_ORDER.map((id) => scenarioInfo(id)).filter((s): s is GzScenarioInfo => s !== null),
);

export function scenarioById(id: string): GzScenarioInfo | null {
  return SCENARIOS.find((s) => s.id === id) ?? null;
}

interface RawOutcome {
  state: GameState;
  events: unknown[];
  deltas: Array<Record<string, unknown>>;
  clamps: Array<Record<string, unknown>>;
  rejected: Array<{ seatId: string; index: number; code: string; message: string }>;
}

export class GuozhanSession {
  readonly scenarioId: string;
  readonly rootSeed: string;
  readonly meta: ScenarioBundle['meta'];
  readonly world: WorldConfig;
  readonly mapLayout: MapLayout;
  readonly factionIds: readonly FactionId[];
  readonly scenario: GzScenarioInfo;

  private state: GameState;
  private readonly bindings = new Map<number, GzSeatBinding>();
  private readonly factionOfSeat = new Map<number, FactionId>();
  private readonly orders = new Map<FactionId, GzOrder[]>();
  private readonly locked = new Set<FactionId>();
  private readonly legalCache = new Map<string, readonly LegalAction[]>();
  private readonly reviews = new Map<FactionId, SelfReview>();
  private readonly policies = new Map<FactionId, AiPolicy>();
  private aiArchetypes: Readonly<Record<FactionId, AiArchetype>>;
  private readonly aggression: Record<string, number>;
  private report: GzReport | null = null;
  private reportBefore: GameState | null = null;
  private reportAfter: GameState | null = null;
  private started = false;
  private ended = false;

  constructor(opts: { scenarioId?: string; rootSeed?: string; maxTurns?: number } = {}) {
    const requested = typeof opts.scenarioId === 'string' ? opts.scenarioId : 'random-front-v2';
    const id = scenarioById(requested) ? requested : 'random-front-v2';
    this.scenarioId = id;
    this.rootSeed = clampSeed(opts.rootSeed, 'guozhan-default');
    const bundle = id === 'random-front-v2'
      ? randomBundle(this.rootSeed)
      : id === 'grand-front'
        ? randomBundle(this.rootSeed, RAW.large)
        : fixedBundle(id);
    const unlimited = opts.maxTurns === 0;
    this.meta = bundle.meta;
    this.world = unlimited ? { ...bundle.world, maxTurns: 0 } : bundle.world;
    this.mapLayout = bundle.mapLayout;
    this.state = bundle.initialState;
    this.aggression = bundle.aggression;
    this.factionIds = Object.keys(this.state.factions).sort();
    this.aiArchetypes = assignAiArchetypes(this.rootSeed, this.factionIds);
    const info = scenarioInfo(id);
    if (!info) throw new GzError('UNKNOWN_SCENARIO', `未知剧本：${id}`);
    this.scenario = unlimited ? { ...info, maxTurns: 0 } : info;
  }

  get phase(): 'lobby' | 'playing' | 'ended' {
    if (!this.started) return 'lobby';
    return this.ended ? 'ended' : 'playing';
  }

  get turn(): number {
    return this.state.turn;
  }

  get maxTurns(): number {
    return this.world.maxTurns;
  }

  get winnerFaction(): FactionId | null {
    return this.state.winner;
  }

  get winnerSeat(): number | null {
    const fid = this.state.winner;
    if (!fid) return null;
    for (const [seat, f] of this.factionOfSeat) if (f === fid) return seat;
    return null;
  }

  get endedAt(): boolean {
    return this.ended;
  }

  get reportData(): GzReport | null {
    return this.report;
  }

  /** 只给未认领或宿主 AI 控制的势力下发原型；真人席位不显示 AI 性格。 */
  private aiArchetypeMap(): Readonly<Record<FactionId, AiArchetype>> {
    const humanBound = new Set<FactionId>();
    for (const [seat, fid] of this.factionOfSeat) {
      if (!this.bindings.get(seat)?.isAi) humanBound.add(fid);
    }
    const out: Record<FactionId, AiArchetype> = {};
    for (const fid of this.factionIds) {
      if (humanBound.has(fid)) continue;
      const archetype = this.aiArchetypes[fid];
      if (archetype) out[fid] = archetype;
    }
    return out;
  }

  private archetypeFor(fid: FactionId): AiArchetype | undefined {
    for (const [seat, boundFid] of this.factionOfSeat) {
      if (boundFid === fid && !this.bindings.get(seat)?.isAi) return undefined;
    }
    return this.aiArchetypes[fid];
  }

  bindingsList(): ReadonlyArray<GzSeatBinding & { factionId: FactionId; factionName: string; color: string }> {
    return [...this.bindings.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((b) => {
        const fid = this.factionOfSeat.get(b.seat) ?? this.factionIds[b.seat] ?? '';
        return {
          ...b,
          factionId: fid,
          factionName: String(this.state.factions[fid]?.name ?? fid),
          color: this.scenario.factions.find((f) => f.id === fid)?.color ?? '#9c8d6e',
        };
      });
  }

  start(bindings: ReadonlyArray<GzSeatBinding>): void {
    if (this.started) throw new GzError('GAME_STARTED', '对局已经开始');
    const seats = [...bindings].sort((a, b) => a.seat - b.seat);
    if (seats.length < this.scenario.minPlayers) {
      throw new GzError('NOT_ENOUGH', `国战至少需要 ${this.scenario.minPlayers} 名玩家`);
    }
    if (seats.length > this.scenario.maxPlayers) {
      throw new GzError('ROOM_FULL', `国战最多 ${this.scenario.maxPlayers} 名玩家（其余势力由 AI 接管）`);
    }
    for (let i = 0; i < seats.length; i++) {
      const b = seats[i]!;
      const fid = this.factionIds[i]!;
      this.bindings.set(b.seat, { seat: b.seat, name: b.name, ...(b.isAi === true ? { isAi: true } : {}) });
      this.factionOfSeat.set(b.seat, fid);
    }
    // 开局才知道哪些座位是真人：只对 AI 势力重新分配，保证 3 个 AI 覆盖三种原型。
    const humanFactions = new Set<FactionId>();
    for (const [seat, fid] of this.factionOfSeat) {
      if (!this.bindings.get(seat)?.isAi) humanFactions.add(fid);
    }
    this.aiArchetypes = assignAiArchetypes(
      this.rootSeed,
      this.factionIds.filter((fid) => !humanFactions.has(fid)),
    );
    this.started = true;
    this.ended = false;
    this.autoOrderUnseated();
  }

  nextSeat(): number | null {
    if (!this.started || this.ended) return null;
    for (const seat of [...this.factionOfSeat.keys()].sort((a, b) => a - b)) {
      const fid = this.factionOfSeat.get(seat)!;
      if (this.state.factions[fid]?.eliminated) continue;
      if (!this.locked.has(fid)) return seat;
    }
    return null;
  }

  waitingSeats(): number[] {
    const out: number[] = [];
    for (const [seat, fid] of this.factionOfSeat) {
      if (this.state.factions[fid]?.eliminated) continue;
      if (!this.locked.has(fid)) out.push(seat);
    }
    return out.sort((a, b) => a - b);
  }

  legalActionsFor(fid: FactionId, maxActions = 2000, uncapped = true, moveAttacks = uncapped): readonly LegalAction[] {
    const key = `${this.state.turn}:${fid}:${maxActions}:${uncapped ? 'full' : 'cap'}:${moveAttacks ? 'move' : 'nomove'}`;
    const cached = this.legalCache.get(key);
    if (cached) return cached;
    const list = enumerateLegalActions(this.state, this.world, fid, { maxActions, ...(uncapped ? { uncapped: true } : {}), ...(moveAttacks ? { moveAttacks: true } : {}) });
    this.legalCache.set(key, list);
    return list;
  }

  ordersFor(fid: FactionId): readonly GzOrder[] {
    return this.orders.get(fid) ?? [];
  }

  isLocked(fid: FactionId): boolean {
    return this.locked.has(fid);
  }

  submitAction(fid: FactionId, actionId: string): GzOrder {
    this.assertCanAct(fid);
    const list = this.legalActionsFor(fid);
    const action = list.find((a) => a.id === actionId);
    if (!action) throw new GzError('ILLEGAL_ACTION', '该动作不在当前合法动作列表中（局面可能已更新）');
    const current = this.orders.get(fid) ?? [];
    if (current.some((o) => o.actionId === actionId)) throw new GzError('DUPLICATE_ACTION', '该动作已加入本回合指令');
    if (current.length >= MAX_COMMANDS) throw new GzError('TOO_MANY_COMMANDS', `每回合最多 ${MAX_COMMANDS} 条命令`);
    const unitId = (action.command as { unitId?: unknown }).unitId;
    if (typeof unitId === 'string') {
      if (current.some((o) => (o.command as { unitId?: unknown }).unitId === unitId)) {
        throw new GzError('UNIT_ALREADY_ORDERED', '该部队本回合已有指令（移动后进攻请选带“移动至”的组合动作）');
      }
    }
    const order: GzOrder = {
      actionId,
      label: action.label,
      command: action.command,
    };
    this.orders.set(fid, [...current, order]);
    return order;
  }

  clearOrders(fid: FactionId): void {
    if (!this.started) throw new GzError('NOT_PLAYING', '对局尚未开始');
    if (this.ended) throw new GzError('MATCH_FINISHED', '对局已结束');
    if (this.locked.has(fid)) throw new GzError('ORDERS_ALREADY_LOCKED', '本回合已锁定，不能更改指令');
    this.orders.delete(fid);
  }

  lock(fid: FactionId): { resolved: boolean } {
    if (!this.started) throw new GzError('NOT_PLAYING', '对局尚未开始');
    if (this.ended) throw new GzError('MATCH_FINISHED', '对局已结束');
    if (!this.state.factions[fid]) throw new GzError('NO_FACTION', '席位没有对应势力');
    if (this.locked.has(fid)) return { resolved: false };
    this.locked.add(fid);
    if (this.allLocked()) {
      this.resolve();
      return { resolved: true };
    }
    return { resolved: false };
  }

  /** 让启发式 AI 为一个座位生成指令；宿主机器人循环调用。 */
  aiAction(fid: FactionId): { kind: 'gz_bot'; commands: GzOrder[]; lock: true } | null {
    if (!this.started || this.ended) return null;
    if (this.locked.has(fid)) return null;
    if (this.state.factions[fid]?.eliminated) return { kind: 'gz_bot', commands: [], lock: true };
    return { kind: 'gz_bot', commands: [...this.aiCommands(fid)], lock: true };
  }

  applyBotCommands(fid: FactionId, commands: ReadonlyArray<unknown>): { resolved: boolean } {
    if (!this.started) throw new GzError('NOT_PLAYING', '对局尚未开始');
    if (this.ended) throw new GzError('MATCH_FINISHED', '对局已结束');
    if (this.locked.has(fid)) throw new GzError('ORDERS_ALREADY_LOCKED', '本回合已锁定');
    if (commands.length > MAX_COMMANDS) throw new GzError('TOO_MANY_COMMANDS', `每回合最多 ${MAX_COMMANDS} 条命令`);
    const parsed: GzOrder[] = [];
    for (let i = 0; i < commands.length; i++) {
      const raw = commands[i] as { command?: unknown } | null;
      const candidate = raw && typeof raw === 'object' && raw.command !== undefined ? raw.command : raw;
      const result = DomainCommandSchema.safeParse(candidate);
      if (!result.success) {
        throw new GzError('MALFORMED_COMMAND', `机器人命令 ${i} 不合法：${result.error.issues.map((x) => x.message).join('; ')}`);
      }
      const command = result.data as unknown as Record<string, unknown>;
      parsed.push({ actionId: `bot:${String(command['kind'])}:${i}`, label: `AI ${String(command['kind'])}`, command });
    }
    this.orders.set(fid, parsed);
    return this.lock(fid);
  }

  viewFor(seat: number, fid: FactionId): Record<string, unknown> {
    if (!this.started) throw new GzError('NOT_PLAYING', '对局尚未开始');
    const digest = digestState(this.state);
    const snap = buildSnapshot({
      state: this.state,
      world: this.world,
      recipient: `seat_${seat}`,
      viewer: fid,
      digest,
      alerts: [],
      tokenUsed: 0,
      tokenCap: 0,
      maxLegalActions: 120,
      ...(Object.keys(this.aiArchetypeMap()).length > 0 ? { aiArchetypes: this.aiArchetypeMap() } : {}),
    });
    const actions = this.ended || this.locked.has(fid) || this.state.factions[fid]?.eliminated
      ? []
      : this.legalActionsFor(fid).map((a) => ({
          id: a.id,
          kind: a.kind,
          label: a.label,
          command: a.command,
          estimate: a.estimate ?? {},
          description: a.description ?? '',
          sourceRegion: a.sourceRegion ?? null,
          targetRegion: a.targetRegion ?? null,
          path: a.path ?? null,
          priority: a.priority,
        }));
    const players = [...this.bindings.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((b) => ({ id: b.seat, name: b.name }));
    const winners = this.state.winner ? this.state.factions[this.state.winner] : null;
    const endEvent = this.report?.events.find((e) => e['type'] === 'match_ended');
    return {
      ...snap,
      mapText: undefined,
      phase: this.ended ? 'roundEnd' : 'playing',
      you: seat,
      factionId: fid,
      current: this.nextSeat(),
      players,
      counts: players.map((p) => {
        const f = this.factionOfSeat.get(p.id);
        return f ? (this.orders.get(f)?.length ?? 0) : 0;
      }),
      locked: this.locked.has(fid),
      waitingSeats: this.waitingSeats(),
      seatFactions: this.bindingsList(),
      pendingOrders: [...(this.orders.get(fid) ?? [])],
      actions,
      map: this.mapLayout,
      scenario: {
        id: this.scenario.id,
        name: this.scenario.name,
        description: this.scenario.description,
        maxTurns: this.scenario.maxTurns,
        rootSeed: this.rootSeed,
      },
      report: this.reportFor(fid),
      ...(this.reviews.has(fid) ? { selfReview: this.reviews.get(fid) } : {}),
      ...(this.ended
        ? {
            winnerSeat: this.winnerSeat,
            winnerFaction: this.state.winner,
            winnerName: winners?.name ?? null,
            endReason: this.state.endReason,
            endScores: (endEvent?.['scores'] as Record<string, Record<string, number>> | undefined) &&
              Object.keys((endEvent?.['scores'] as Record<string, unknown>) ?? {}).length > 0
              ? (endEvent!['scores'] as Record<string, Record<string, number>>)
              : this.finalScores(),
          }
        : {}),
    };
  }

  private finalScores(): Record<string, Record<string, number>> {
    const total = Object.keys(this.state.regions).length;
    const out: Record<string, Record<string, number>> = {};
    for (const fid of this.factionIds) {
      const f = this.state.factions[fid];
      if (!f) continue;
      let troops = 0;
      for (const u of Object.values(this.state.units)) if (u.ownerId === fid) troops += u.troops;
      const regions = regionsOf(this.state, fid).length;
      out[fid] = {
        regions,
        territoryRatio: total > 0 ? Number((regions / total).toFixed(4)) : 0,
        troops,
        gold: f.gold,
        food: f.food,
        morale: f.morale,
      };
    }
    return out;
  }

  private reportFor(fid: FactionId): Record<string, unknown> | null {
    if (!this.report) return null;
    // 事件也有迷雾：units_moved / recruitment / spy / unrest 只给当事势力。
    // 战斗与易手是公开事件（与 guozhan 的 EVENT_VISIBILITY 一致）。
    const events = this.report.events.filter((event) => {
      if (event['type'] === 'turn_resolved') return false; // 内含全势力精确增量，UI 不用
      const before = this.reportBefore ? audienceOfEvent(event, this.reportBefore) : 'all';
      const after = this.reportAfter ? audienceOfEvent(event, this.reportAfter) : 'all';
      return audienceIncludes(unionAudience(before, after), fid);
    });
    return {
      turn: this.report.turn,
      events,
      rejected: this.report.rejected.filter((r) => r.seatId === fid),
      baseline: this.report.baseline.filter((d) => d['scope'] === `faction:${fid}`),
      clamps: this.report.clamps.filter((c) => c['scope'] === `faction:${fid}`),
    };
  }

  private assertCanAct(fid: FactionId): void {
    if (!this.started) throw new GzError('NOT_PLAYING', '对局尚未开始');
    if (this.ended) throw new GzError('MATCH_FINISHED', '对局已结束');
    if (!this.state.factions[fid]) throw new GzError('NO_FACTION', '席位没有对应势力');
    if (this.state.factions[fid]?.eliminated) throw new GzError('FACTION_ELIMINATED', '你的势力已灭亡');
    if (this.locked.has(fid)) throw new GzError('ORDERS_ALREADY_LOCKED', '本回合已锁定，不能再追加命令');
  }

  private allLocked(): boolean {
    for (const fid of this.factionIds) {
      if (this.state.factions[fid]?.eliminated) continue;
      if (!this.locked.has(fid)) return false;
    }
    return true;
  }

  private autoOrderUnseated(): void {
    const seated = new Set(this.factionOfSeat.values());
    for (const fid of this.factionIds) {
      if (seated.has(fid)) continue;
      if (this.state.factions[fid]?.eliminated) {
        this.locked.add(fid);
        continue;
      }
      this.orders.set(fid, [...this.aiCommands(fid)]);
      this.locked.add(fid);
    }
  }

  private aiCommands(fid: FactionId): GzOrder[] {
    // 启发式 AI 仍用带 per-kind cap 的短列表，避免一次评估数百条动作；
    // 人类 UI / 提交校验则用全量列表（见 legalActionsFor）。
    const legal = this.legalActionsFor(fid, 120, false, false);
    const regions = regionsOf(this.state, fid).length;
    const aggression = this.aggression[fid] ?? 0.5;
    const archetype = this.aiArchetypes[fid];
    const decision = archetype === 'random'
      ? decideRandom(this.state, this.world, fid, this.rootSeed, MAX_COMMANDS, legal)
      : decideHeuristic(
          this.state,
          this.world,
          fid,
          profileForArchetype(archetype, aggression, regions),
          [],
          legal,
          this.policies.get(fid) ?? null,
        );
    const out: GzOrder[] = [];
    for (let i = 0; i < decision.commands.length && out.length < MAX_COMMANDS; i++) {
      const c = decision.commands[i]!;
      const action = legal.find((a) => a.id === c.legalActionId);
      if (!action) continue;
      out.push({ actionId: action.id, label: action.label, command: c.command as Record<string, unknown> });
    }
    return out;
  }

  private resolve(): void {
    const turn = this.state.turn;
    const before = this.state;
    const accepted: Array<{ seatId: string; factionId: FactionId; command: unknown; kind: string }> = [];
    for (const fid of this.factionIds) {
      const list = this.orders.get(fid) ?? [];
      for (let i = 0; i < list.length; i++) {
        const o = list[i]!;
        accepted.push({
          seatId: fid,
          factionId: fid,
          command: o.command,
          kind: String(o.command['kind'] ?? ''),
        });
      }
    }
    accepted.sort((a, b) => (a.seatId === b.seatId ? 0 : a.seatId < b.seatId ? -1 : 1));
    const outcome = resolveTurn({
      state: this.state,
      world: this.world,
      modules: buildModules(this.meta.moduleOrder),
      orders: accepted as never,
      rootSeed: this.rootSeed,
      turn,
      now: 0,
      digest: digestState,
      llmDelta: null,
    }) as unknown as RawOutcome;
    const report: GzReport = {
      turn,
      events: outcome.events as Array<Record<string, unknown>>,
      rejected: outcome.rejected.map((r) => ({ seatId: r.seatId, code: r.code, message: r.message })),
      baseline: outcome.deltas,
      clamps: outcome.clamps,
    };
    this.report = report;
    this.reportBefore = before;
    this.reportAfter = outcome.state;
    const ended = outcome.state.phase === 'ended';
    this.state = ended
      ? outcome.state
      : { ...outcome.state, turn: turn + 1, phase: 'submitting', submitted: [] };
    this.ended = ended;
    this.locked.clear();
    this.orders.clear();
    this.legalCache.clear();
    if (!ended) {
      this.afterResolution(report);
      this.autoOrderUnseated();
      // If every surviving faction is AI-controlled (all human factions were
      // eliminated), nobody is left to press "lock". Keep resolving so the
      // match cannot stall on a spectator-only room.
      if (this.allLocked()) this.resolve();
    } else {
      this.afterResolution(report);
    }
  }

  private afterResolution(report: GzReport): void {
    for (const fid of this.factionIds) {
      const archetype = this.archetypeFor(fid);
      const review = deriveSelfReview({
        state: this.state,
        world: this.world,
        factionId: fid,
        aggression: this.aggression[fid] ?? 0.5,
        ...(archetype ? { archetype } : {}),
        previous: {
          turn: report.turn,
          events: report.events,
          baseline: report.baseline as never,
          rejectedForSeat: report.rejected.filter((r) => r.seatId === fid).length,
        },
      });
      this.reviews.set(fid, review);
      if (review.policy) this.policies.set(fid, review.policy);
    }
  }
}

export function createSession(opts: { scenarioId?: string; rootSeed?: string } = {}): GuozhanSession {
  return new GuozhanSession(opts);
}
