/**
 * 唯一权威状态：房间、快照、stateId（CAS 锚点）、事件流、编年史、存档。
 * 设计沿用上一个包：服务端权威、LLM 不持有状态、快照是唯一持久化格式。
 */
import { createHash } from 'node:crypto';
import { canonical, createRng } from './rng.js';
import { generateWorld, assignCapitals } from './world.js';

export const STATE_VERSION = 1;

/** @param {{roomId?:string, rules:object, monarchs:object, worldCfg:object, seed?:string}} input */
export function createGame(input) {
    const { rules, monarchs, worldCfg } = input;
    const seed = input.seed ?? worldCfg.seed;
    const rng = createRng(seed);
    const world = generateWorld(worldCfg, rng, rules);

    // ★只把中性字段写入权威状态。模型绑定（adapter / model / apiKeyEnv / modelLabel）
    //   与席位控制者一律留在房间层，快照、编年史、事件流与存档因此天然无法泄漏身份。
    const slots = monarchs.slots.map((s) => ({
        id: s.id, name: s.name, monarch: s.monarch, color: s.color, persona: s.persona,
    }));
    assignCapitals(world, slots, rng);

    const start = worldCfg.start;
    const civs = slots.map((s) => ({
        id: s.id,
        name: s.name,
        monarch: s.monarch,
        color: s.color,
        persona: s.persona,
        capital: s.capital,
        alive: true,
        tech: start.tech,
        resources: {
            food: start.food,
            ore: start.ore,
            energy: start.energy,
            knowledge: start.knowledge,
        },
        population: start.population,
        stability: start.stability,
        military: start.military,
        colonies: start.colonies,
        epoch: rules.epochs[0].id,
        policy: 'balanced',
        shield: 0,
        expansionLock: 0,
        relations: {},
        score: 0,
    }));

    const state = {
        version: STATE_VERSION,
        roomId: input.roomId ?? 'room-1',
        seed,
        rngState: rng.getState(),
        rulesId: rules.id,
        turn: 1,
        year: rules.engine.startYear,
        phase: 'submitting',
        winner: null,
        regions: world.regions,
        adjacency: world.adjacency,
        layout: world.layout,
        civs,
        decisions: {},
        dmEdits: [],
        chronicle: [],
        events: [],
        eventOffset: 0,
        requestCache: {},
        lastReport: '',
    };
    logChronicle(state, 'genesis', `元年开局，${civs.length} 位君主各据一州，共赴星海。`);
    pushEvent(state, 'game_created', { roomId: state.roomId, seed, civCount: civs.length });
    return state;
}

/** 状态签名：写操作必须带上一次读到的 stateId，否则 409 STALE_REVISION */
export function computeStateId(state) {
    const material = canonical({
        v: state.version,
        turn: state.turn,
        year: state.year,
        phase: state.phase,
        winner: state.winner,
        rngState: state.rngState,
        regions: state.regions,
        civs: state.civs,
        // ★试玩修正：decisions 是「本回合待结算的输入队列」，不是局面版本。
        //   不同席位在同一回合内写不同 key，互不覆盖；把它放进签名会让并发下令互相撞 409。
        //   局面变化（turn / regions / civs / 回合推进）仍会换 stateId，CAS 语义不变。
        dmEdits: state.dmEdits,
        chronicleLength: state.chronicle.length,
    });
    return createHash('sha256').update(material).digest('hex').slice(0, 20);
}

/** 分层标签：不向外泄露其他文明的精确数值（信息隔离） */
function tier(value, bounds) {
    let i = 0;
    for (const b of bounds) if (value >= b) i += 1;
    return i;
}

/** 快照字段白名单：即使将来 state 里新增了字段，也不会被顺手泄出去 */
const FULL_CIV_FIELDS = [
    'id', 'name', 'monarch', 'color', 'persona', 'capital', 'alive', 'tech', 'resources',
    'population', 'stability', 'military', 'colonies', 'epoch', 'policy', 'shield',
    'expansionLock', 'relations', 'score',
];
// ★submitted 字段已被彻底移除：谁已提交属于席位身份线索，既不进状态也不进快照/存档
const RESTORE_CIV_FIELDS = [...FULL_CIV_FIELDS];
function pick(obj, keys) {
    return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}
/** 意图字段白名单：任何 source / mode / control 之类的身份标记都不得进入快照 */
const DECISION_FIELDS = ['civId', 'type', 'target', 'magnitude', 'note'];
function safeDecision(d) {
    return d && typeof d === 'object' ? pick(d, DECISION_FIELDS) : null;
}

/**
 * @param {object} state
 * @param {string|null} viewerCivId null = DM / 观战（全知数值，但席位身份对所有人不可见），否则只给该席位可见信息
 */
export function snapshotFor(state, viewerCivId = null) {
    const omniscient = viewerCivId === null;
    const civs = state.civs.map((c) => {
        if (omniscient || c.id === viewerCivId) {
            return { ...pick(c, FULL_CIV_FIELDS), visibility: 'full' };
        }
        return {
            id: c.id, name: c.name, monarch: c.monarch,
            color: c.color, alive: c.alive, capital: c.capital,
            epoch: c.epoch, colonies: c.colonies,
            techTier: tier(c.tech, [60, 160, 300, 480, 660, 820, 1000]),
            powerTier: tier(c.military, [15, 30, 50, 75]),
            scoreTier: tier(c.score, [100, 250, 450, 700]),
            visibility: 'masked',
        };
    });
    return {
        stateId: computeStateId(state),
        roomId: state.roomId,
        seed: state.seed,
        rulesId: state.rulesId,
        turn: state.turn,
        year: state.year,
        phase: state.phase,
        winner: state.winner,
        perspective: omniscient ? 'dm' : viewerCivId,
        regions: state.regions.map((r) => ({ ...r })),
        civs,
        // DM 全知视角只看到「有没有意图在队列」之外的中立信息：提交状态一律不下发
        decisions: omniscient ? {} : { [viewerCivId]: safeDecision(state.decisions[viewerCivId]) },
        dmEdits: omniscient ? state.dmEdits.map((e) => pick(e, ['type', 'target', 'region', 'magnitude', 'note'])) : [],
        chronicle: state.chronicle.slice(-40).map((e) => pick(e, ['turn', 'year', 'kind', 'text'])),
    };
}

export function logChronicle(state, kind, text, extra = {}) {
    const entry = {
        turn: state.turn,
        year: state.year,
        kind,
        text,
        ...extra,
    };
    state.chronicle.push(entry);
    if (state.chronicle.length > 600) state.chronicle.splice(0, state.chronicle.length - 600);
    return entry;
}

/** 事件流从 offset 递增；SSE 断线可用 ?from= 补发 */
export function pushEvent(state, type, payload) {
    const event = { offset: state.eventOffset, type, turn: state.turn, year: state.year, ...payload };
    state.eventOffset += 1;
    state.events.push(event);
    if (state.events.length > 500) state.events.splice(0, state.events.length - 500);
    return event;
}

export function eventsSince(state, from = 0) {
    return state.events.filter((e) => e.offset >= from);
}

export function serialize(state) {
    // 幂等回执缓存属于传输层，不进存档（否则会把 /auto 的诊断信息一起带走）
    const { requestCache, ...rest } = state;
    return JSON.stringify({ ...rest, stateId: computeStateId(state) }, null, 2);
}

export function restore(json, rules) {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    if (parsed.version !== STATE_VERSION) throw new Error(`存档版本不兼容：${parsed.version}`);
    const expected = canonical({
        v: parsed.version, turn: parsed.turn, year: parsed.year, phase: parsed.phase,
        winner: parsed.winner, rngState: parsed.rngState, regions: parsed.regions,
        civs: parsed.civs,
        dmEdits: parsed.dmEdits,
        chronicleLength: parsed.chronicle.length,
    });
    const id = createHash('sha256').update(expected).digest('hex').slice(0, 20);
    if (parsed.stateId && parsed.stateId !== id) throw new Error('存档校验失败：stateId 与内容不一致');
    const { stateId: _ignored, ...raw } = parsed;
    // 载入时再清洗一遍：旧存档或外部存档里即便夹带身份字段，也不会污染权威状态
    const state = {
        ...raw,
        civs: raw.civs.map((c) => pick(c, RESTORE_CIV_FIELDS)),
        decisions: Object.fromEntries(Object.entries(raw.decisions ?? {}).map(([k, v]) => [k, safeDecision(v)])),
        dmEdits: (raw.dmEdits ?? []).map((e) => pick(e, ['type', 'target', 'region', 'magnitude', 'note'])),
        requestCache: {},
    };
    createRng(state.seed, state.rngState); // 确认 RNG 状态可恢复
    if (rules && state.rulesId !== rules.id) console.warn('[civ] 存档规则集与当前规则不同，数值解释可能不同');
    return state;
}
