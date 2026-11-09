/**
 * 席位控制层（房间层，不进入权威推演状态）
 *
 * ★盲化原则：control / claimed / driver 只存在于本模块与房间对象里。
 *   - 权威 state（civs、decisions、chronicle、events、存档）中没有任何席位身份字段；
 *   - 快照、事件流、编年史、战报、提示词、MCP 工具输出一律不含这些信息；
 *   - 只有持有房间级 adminToken 的人类房主能通过 /seats 端点查看与修改。
 *
 * ★行为层盲化：结算前为所有未下令的存活文明自动补一条意图，
 *   使模型看到的永远是「十二国每回合皆有举动」，无法从空缺反推哪位是人类。
 */
import { legalActions } from './commands.js';
import { deterministicDecision } from '../ai/director.js';
import { courtPhrase } from './voice.js';

export const DECISION_KEYS = ['civId', 'type', 'target', 'magnitude', 'note'];

/** 写进 state.decisions 前做白名单清洗，杜绝 source/mode/model 等身份字段混入 */
export function cleanDecision(d) {
    return {
        civId: d.civId,
        type: d.type,
        target: d.target ?? null,
        magnitude: d.magnitude ?? 1,
        note: typeof d.note === 'string' ? d.note.slice(0, 300) : '',
    };
}

export function createSeatRegistry(state, seatsCfg, humanSeats = []) {
    const human = new Set(Array.isArray(humanSeats) ? humanSeats : []);
    const fallback = seatsCfg.defaultControl === 'human' ? 'human' : 'ai';
    /** @type {Record<string,{control:string,claimed:boolean}>} */
    const seats = {};
    for (const civ of state.civs) {
        seats[civ.id] = { control: human.has(civ.id) ? 'human' : fallback, claimed: false };
    }
    return seats;
}

/** 仅房主管理端可调用；返回变更清单，拒绝项不落库 */
export function applySeatControls(registry, list, validIds, allowedControls) {
    const applied = [];
    const rejections = [];
    if (!Array.isArray(list)) return { applied, rejections: [{ index: 0, code: 'MALFORMED_PAYLOAD' }] };
    list.forEach((item, index) => {
        if (!item || typeof item !== 'object' || !validIds.includes(item.civId)) {
            rejections.push({ index, code: 'UNKNOWN_CIV' }); return;
        }
        if (!allowedControls.includes(item.control)) {
            rejections.push({ index, code: 'MALFORMED_PAYLOAD', message: 'control 只能是 human 或 ai' }); return;
        }
        registry[item.civId].control = item.control;
        applied.push({ civId: item.civId, control: item.control });
    });
    return { applied, rejections };
}

/** 某个 seat token 成功下令后标记「已认领」，仅用于管理视图，不改变 control */
export function markClaimed(registry, civId) {
    if (registry?.[civId]) registry[civId].claimed = true;
}

/** 管理视图：包含控制者分配与模型绑定，仅 adminToken 持有者可见 */
export function adminSeatView(registry, state, monarchs, seatsCfg) {
    const slots = new Map(monarchs.slots.map((s) => [s.id, s]));
    return {
        blindSeats: Boolean(seatsCfg.blindSeats),
        policy: seatsCfg.policy,
        autoFill: Boolean(seatsCfg.autoFill),
        defaultControl: seatsCfg.defaultControl,
        seats: state.civs.map((c) => {
            const s = slots.get(c.id);
            const cfg = { ...monarchs.defaults, ...(s?.model ?? {}) };
            return {
                civId: c.id,
                name: c.name,
                monarch: c.monarch,
                control: registry[c.id]?.control ?? 'ai',
                claimed: Boolean(registry[c.id]?.claimed),
                driver: cfg.adapter === 'openai' && cfg.model ? `model:${cfg.model}` : 'offline',
                pending: !state.decisions[c.id],
            };
        }),
        note: '此视图含席位身份，仅人类房主可见；严禁转发给任何模型或写入对话上下文。',
    };
}

/** 普通席位只看得到自己的席位，且不含任何统计口径 */
export function selfSeatView(registry, civId) {
    return { civId, control: registry?.[civId]?.control ?? 'ai', claimed: Boolean(registry?.[civId]?.claimed) };
}

/**
 * 意图落库前的最后一道闸门：字段白名单 + 史官统一润色。
 * ★任何来源（人类 / 人机补位 / 外部模型）的 note 都在这里被重写，
 *   因此编年史里不存在「某些席位用套语、某些席位写个性化台词」的可见分组。
 */
export function sealDecision(state, d) {
    return cleanDecision({ ...d, note: courtPhrase(state, d) });
}

/** 供 /auto 使用：只让 ai 席位跑模型，人类席位已提交的意图绝不覆盖 */
export function aiEligibleCivIds(state, registry) {
    return new Set(state.civs.filter((c) => c.alive && (registry?.[c.id]?.control ?? 'ai') === 'ai').map((c) => c.id));
}

/**
 * 结算前补位。返回 filled/waiting 供服务端决定能否推进；
 * ★waiting 的具体席位名单只在管理端使用，绝不下发给普通 DM / 模型。
 */
export function ensureDecisions({ state, rules, registry, seatsCfg }) {
    const filled = [];
    const waiting = [];
    if (!seatsCfg.autoFill) return { filled, waiting };
    for (const civ of state.civs) {
        if (!civ.alive || state.decisions[civ.id]) continue;
        const control = registry?.[civ.id]?.control ?? 'ai';
        if (control === 'human') {
            if (seatsCfg.policy === 'wait') { waiting.push(civ.id); continue; }
            if (seatsCfg.policy === 'skip') continue;
        }
        const legal = legalActions(state, civ.id, rules);
        const raw = deterministicDecision(state, civ, legal, rules);
        if (!raw) continue;
        state.decisions[civ.id] = sealDecision(state, raw);
        filled.push(civ.id);
    }
    return { filled, waiting };
}
