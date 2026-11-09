/**
 * 命令闸门：LLM / DM 只输出意图，能不能做、花多少、造成什么全部在这里和 engine.js 裁决。
 * 对应上一个包的四道闸门：严格字段白名单、目标合法性、资源与前置条件、CAS / 幂等（幂等在 server 层）。
 */

export const REJECTION_CODES = [
    'STALE_REVISION', 'PHASE_NOT_SUBMITTING', 'MATCH_FINISHED', 'MALFORMED_PAYLOAD',
    'UNKNOWN_CIV', 'CIV_ELIMINATED', 'UNKNOWN_ACTION', 'UNKNOWN_REGION', 'UNKNOWN_TARGET_CIV',
    'INSUFFICIENT_RESOURCE', 'REGION_NOT_ADJACENT', 'REGION_NOT_OWNED', 'REGION_ALREADY_OWNED',
    'EPOCH_TOO_LOW', 'TOO_MANY_DECISIONS', 'ACTION_MAGNITUDE_OUT_OF_RANGE',
    'DM_EDIT_NOT_ALLOWED', 'DM_BUDGET_EXCEEDED', 'DM_MAGNITUDE_OUT_OF_RANGE',
    'SEAT_NOT_AUTHORIZED', 'SAVE_INVALID', 'SEATS_WAITING', 'ADMIN_REQUIRED',
];

export const REJECTION_MESSAGES = {
    STALE_REVISION: '局面已变化：手上的快照过期了，请重新拉取再下令',
    PHASE_NOT_SUBMITTING: '当前阶段不接受提交（只有「提交中」可以下令）',
    MATCH_FINISHED: '对局已结束',
    MALFORMED_PAYLOAD: '命令格式不合法（多余字段也会被拒绝）',
    UNKNOWN_CIV: '该文明席位不存在',
    CIV_ELIMINATED: '该文明已灭亡，无法下令',
    UNKNOWN_ACTION: '未知的行动类型',
    UNKNOWN_REGION: '目标州不存在',
    UNKNOWN_TARGET_CIV: '目标文明不存在',
    INSUFFICIENT_RESOURCE: '资源不足',
    REGION_NOT_ADJACENT: '目标州与你的领土不接壤',
    REGION_NOT_OWNED: '目标州不属于你',
    REGION_ALREADY_OWNED: '目标州已有归属',
    EPOCH_TOO_LOW: '时代尚未达到该行动的前置条件',
    TOO_MANY_DECISIONS: '单回合提交数量超出预算',
    ACTION_MAGNITUDE_OUT_OF_RANGE: '行动强度超出允许区间',
    DM_EDIT_NOT_ALLOWED: '该 DM 修正类型未在当前规则集中开放',
    DM_BUDGET_EXCEEDED: '本回合 DM 修正条数超出预算',
    DM_MAGNITUDE_OUT_OF_RANGE: 'DM 修正强度超出允许区间',
    SEAT_NOT_AUTHORIZED: '席位令牌无权操作该文明',
    SAVE_INVALID: '存档格式或校验和不合法',
    SEATS_WAITING: '仍有席位未下令，按 wait 策略本回合不推进（不公开具体席位）',
    ADMIN_REQUIRED: '该信息仅人类房主（房间管理令牌）可见',
};

const DECISION_KEYS = new Set(['civId', 'type', 'target', 'magnitude', 'note']);
const EDIT_KEYS = new Set(['type', 'target', 'region', 'magnitude', 'note']);

export function epochIndexOf(epochs, id) {
    return Math.max(0, epochs.findIndex((e) => e.id === id));
}

export function civById(state, id) {
    return state.civs.find((c) => c.id === id) ?? null;
}

export function regionById(state, id) {
    return state.regions.find((r) => r.id === id) ?? null;
}

export function ownedRegions(state, civId) {
    return state.regions.filter((r) => r.owner === civId);
}

export function isAdjacentToCiv(state, regionId, civId) {
    const r = regionById(state, regionId);
    if (!r) return false;
    return (state.adjacency[r.index] ?? []).some((i) => state.regions[i]?.owner === civId);
}

function reject(index, code, detail) {
    return { index, code, message: detail ? `${REJECTION_MESSAGES[code]}：${detail}` : REJECTION_MESSAGES[code] };
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @returns {{accepted:Array<object>, rejections:Array<object>}}
 */
export function validateDecisions(state, decisions, rules) {
    const rejections = [];
    const accepted = [];
    if (state.phase !== 'submitting') return { accepted, rejections: [reject(0, state.winner ? 'MATCH_FINISHED' : 'PHASE_NOT_SUBMITTING')] };
    if (!Array.isArray(decisions)) return { accepted, rejections: [reject(0, 'MALFORMED_PAYLOAD')] };
    if (decisions.length > state.civs.length * rules.actions.maxPerCivPerTurn) {
        return { accepted, rejections: [reject(0, 'TOO_MANY_DECISIONS')] };
    }

    decisions.forEach((d, index) => {
        if (!isPlainObject(d) || Object.keys(d).some((k) => !DECISION_KEYS.has(k))) {
            rejections.push(reject(index, 'MALFORMED_PAYLOAD'));
            return;
        }
        const civ = civById(state, d.civId);
        if (!civ) { rejections.push(reject(index, 'UNKNOWN_CIV')); return; }
        if (!civ.alive) { rejections.push(reject(index, 'CIV_ELIMINATED')); return; }
        const spec = rules.actions.types[d.type];
        if (!spec) { rejections.push(reject(index, 'UNKNOWN_ACTION')); return; }
        const magnitude = d.magnitude ?? 1;
        if (!Number.isInteger(magnitude) || magnitude < 1 || magnitude > rules.actions.maxMagnitude) {
            rejections.push(reject(index, 'ACTION_MAGNITUDE_OUT_OF_RANGE')); return;
        }
        if (spec.requiresEpoch && epochIndexOf(rules.epochs, civ.epoch) < epochIndexOf(rules.epochs, spec.requiresEpoch)) {
            rejections.push(reject(index, 'EPOCH_TOO_LOW', `${rules.epochs.find((e) => e.id === spec.requiresEpoch)?.name ?? spec.requiresEpoch}时代起可用`)); return;
        }
        for (const [res, amount] of Object.entries(spec.cost ?? {})) {
            if ((civ.resources[res] ?? 0) < amount * magnitude) {
                rejections.push(reject(index, 'INSUFFICIENT_RESOURCE', `${res} 需 ${amount * magnitude}，现有 ${civ.resources[res] ?? 0}`)); return;
            }
        }
        if (spec.target === 'region') {
            const region = regionById(state, d.target);
            if (!region) { rejections.push(reject(index, 'UNKNOWN_REGION')); return; }
            if (d.type === 'invest' && region.owner !== civ.id) { rejections.push(reject(index, 'REGION_NOT_OWNED')); return; }
            if (d.type === 'expand' && region.owner !== null) { rejections.push(reject(index, 'REGION_ALREADY_OWNED')); return; }
            if (d.type === 'attack' && (region.owner === null || region.owner === civ.id)) {
                rejections.push(reject(index, 'REGION_ALREADY_OWNED', '该州无主或已归你所有')); return;
            }
            if (!isAdjacentToCiv(state, region.id, civ.id)) { rejections.push(reject(index, 'REGION_NOT_ADJACENT')); return; }
        } else if (spec.target === 'civ') {
            if (!civById(state, d.target) || d.target === civ.id) { rejections.push(reject(index, 'UNKNOWN_TARGET_CIV')); return; }
        } else if (d.target !== undefined && d.target !== null && d.target !== '') {
            rejections.push(reject(index, 'MALFORMED_PAYLOAD', '该行动不接受 target')); return;
        }
        accepted.push({
            civId: civ.id, type: d.type, target: d.target ?? null,
            magnitude, note: typeof d.note === 'string' ? d.note.slice(0, 300) : '',
        });
    });
    return { accepted, rejections };
}

/** @returns {{accepted:Array<object>, rejections:Array<object>}} */
export function validateDmEdits(state, edits, rules) {
    const rejections = [];
    const accepted = [];
    if (state.phase !== 'submitting') return { accepted, rejections: [reject(0, state.winner ? 'MATCH_FINISHED' : 'PHASE_NOT_SUBMITTING')] };
    if (!Array.isArray(edits)) return { accepted, rejections: [reject(0, 'MALFORMED_PAYLOAD')] };
    if (state.dmEdits.length + edits.length > rules.dm.maxEditsPerTurn) {
        return { accepted, rejections: [reject(0, 'DM_BUDGET_EXCEEDED')] };
    }
    edits.forEach((e, index) => {
        if (!isPlainObject(e) || Object.keys(e).some((k) => !EDIT_KEYS.has(k))) {
            rejections.push(reject(index, 'MALFORMED_PAYLOAD')); return;
        }
        if (!rules.dm.allowed.includes(e.type) || !rules.dm.effects[e.type]) {
            rejections.push(reject(index, 'DM_EDIT_NOT_ALLOWED')); return;
        }
        const magnitude = e.magnitude ?? 1;
        if (!Number.isInteger(magnitude) || magnitude < 1 || magnitude > rules.dm.maxMagnitude) {
            rejections.push(reject(index, 'DM_MAGNITUDE_OUT_OF_RANGE')); return;
        }
        if (e.target !== undefined && e.target !== null && !civById(state, e.target)) {
            rejections.push(reject(index, 'UNKNOWN_CIV')); return;
        }
        if (e.region !== undefined && e.region !== null && !regionById(state, e.region)) {
            rejections.push(reject(index, 'UNKNOWN_REGION')); return;
        }
        accepted.push({
            type: e.type, target: e.target ?? null, region: e.region ?? null,
            magnitude, note: typeof e.note === 'string' ? e.note.slice(0, 300) : '',
        });
    });
    return { accepted, rejections };
}

/** 合法动作清单：前端直接取 action.command 提交，不自己拼命令体（单一规则真相） */
export function legalActions(state, civId, rules) {
    const civ = civById(state, civId);
    if (!civ || !civ.alive) return { civId, actions: [], reason: civ ? 'CIV_ELIMINATED' : 'UNKNOWN_CIV' };
    const actions = [];
    for (const [type, spec] of Object.entries(rules.actions.types)) {
        if (spec.requiresEpoch && epochIndexOf(rules.epochs, civ.epoch) < epochIndexOf(rules.epochs, spec.requiresEpoch)) continue;
        const affordable = Object.entries(spec.cost ?? {}).every(([res, amount]) => (civ.resources[res] ?? 0) >= amount);
        let targets = [];
        if (spec.target === 'region') targets = state.regions.filter((r) => {
            if (!isAdjacentToCiv(state, r.id, civId)) return false;
            if (type === 'invest') return r.owner === civId;
            if (type === 'expand') return r.owner === null;
            if (type === 'attack') return r.owner !== null && r.owner !== civId;
            return true;
        }).map((r) => ({ id: r.id, name: r.name }));
        if (spec.target === 'civ') targets = state.civs.filter((c) => c.id !== civId && c.alive).map((c) => ({ id: c.id, name: c.name }));
        if (!affordable) continue;
        for (const magnitude of [1, 2, 3].filter((m) => m <= rules.actions.maxMagnitude)) {
            if (Object.entries(spec.cost ?? {}).some(([res, amount]) => (civ.resources[res] ?? 0) < amount * magnitude)) continue;
            if (spec.target === 'none') {
                actions.push({ type, label: spec.label, magnitude, command: { civId, type, magnitude } });
            } else {
                for (const t of targets) actions.push({ type, label: spec.label, magnitude, targetName: t.name, command: { civId, type, target: t.id, magnitude } });
            }
        }
    }
    return { civId, actions };
}
