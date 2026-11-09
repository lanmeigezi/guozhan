/**
 * BrowserHost —— 群星君主离线单机版的服务端替身（内存调用，零 HTTP / SSE / Node 内置模块）
 *
 * 语义对齐 src/server/app.js：
 *   - stateId（CAS）+ requestId（幂等）由本层裁决；
 *   - 写命令先过 validateDecisions / validateDmEdits 闸门，再由 sealDecision 统一润色落库；
 *   - 结算前 ensureDecisions 为所有未下令的存活文明补位 → 十二国每回合皆有举动；
 *   - 席位身份（human / ai / 模型绑定）只存在闭包里的 registry 与 llmCfg，
 *     绝不写入 state，因此快照 / 编年史 / 战报 / 存档天然不含身份。
 *
 * 与 Node 版的区别（都是 HANDOFF §8.1.1 明确要求的单机化取舍）：
 *   - 无房间 / 无令牌 / 无 MCP / 无 SillyTavern 扩展 / 无 SSE；事件换成回调数组；
 *   - LLM 端点由用户在本机设置页填写，Key 只存内存，且必须显式点「让模型推演本回合」才调用；
 *   - 存档只含权威 state（可 JSON 导出导入），不含席位分配与 Key。
 */
import { createGame, snapshotFor, computeStateId, serialize, restore, pushEvent } from '../../src/core/state.js';
import { advanceTurn } from '../../src/core/engine.js';
import {
    legalActions, validateDecisions, validateDmEdits, REJECTION_MESSAGES,
} from '../../src/core/commands.js';
import {
    createSeatRegistry, adminSeatView, sealDecision, ensureDecisions,
    applySeatControls, markClaimed,
} from '../../src/core/seats.js';
import { deterministicDecision } from '../../src/ai/director.js';
import {
    monarchSystem, monarchUser, dmSystem, dmUser, parseStructured, wrapAsGameData,
} from '../../src/ai/prompts.js';
import { RULES, MONARCHS, WORLD_CFG, SEATS_CFG } from './config.generated.js';

export const VERSION = '0.4.0-android';
export { wrapAsGameData };

const WRITE_OPS = ['decisions', 'dm', 'advance', 'auto', 'setSeats'];
const SENSITIVE = ['control', 'claimed', 'modelLabel', 'adapter', 'apiKey', 'model', 'driver'];

function hasFetch() { return typeof fetch === 'function'; }

/**
 * 带超时的一次 OpenAI 兼容调用；任何异常都返回 {ok:false}，绝不抛出、不重试。
 * transport（Android 原生 HTTPS 通道）优先于 fetch：file:// 页面直连 http(s)
 * 端点会被 CORS 拦掉，而原生 HttpURLConnection 没有这个限制。
 */
async function chatComplete(cfg, system, user, budget, transport) {
    if (!cfg.baseUrl || !cfg.model || !cfg.apiKey) {
        return { ok: false, error: '未配置端点 / 模型 / Key' };
    }
    if (transport) {
        try {
            const viaNative = await transport(cfg, system, user, budget);
            return viaNative || { ok: false, error: '原生通道未返回结果' };
        } catch (err) {
            return { ok: false, error: String(err?.message ?? err).slice(0, 120) };
        }
    }
    if (!hasFetch()) {
        return { ok: false, error: '未配置端点 / 模型 / Key' };
    }
    const url = `${String(cfg.baseUrl).replace(/\/+$/, '')}/chat/completions`;
    let controller = null;
    if (typeof AbortController === 'function') controller = new AbortController();
    const request = fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            temperature: 0.8,
            max_tokens: budget.maxTokensPerDecision,
            stream: false,
        }),
        signal: controller ? controller.signal : undefined,
    }).then(async (resp) => {
        if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
        const json = await resp.json();
        const text = json?.choices?.[0]?.message?.content;
        return typeof text === 'string' ? { ok: true, text } : { ok: false, error: '响应缺少 content' };
    }).catch((err) => ({ ok: false, error: String(err?.message ?? err).slice(0, 120) }));

    let timer = null;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
            if (controller) { try { controller.abort(); } catch (_) { /* 旧 WebView 忽略 */ } }
            resolve({ ok: false, error: '超时' });
        }, budget.timeoutMs);
    });
    const result = await Promise.race([request, timeout]);
    clearTimeout(timer);
    return result;
}

/**
 * 创建一个离线单机房间。
 * @param {{seed?:string}} [options]
 */
export function createHost(options = {}) {
    const transport = typeof options.llmTransport === 'function' ? options.llmTransport : null;
    const rules = RULES;
    const monarchs = MONARCHS;
    const worldCfg = WORLD_CFG;
    const seatsCfg = SEATS_CFG;

    let state = createGame({ roomId: 'local-1', rules, monarchs, worldCfg, seed: options.seed });
    let registry = createSeatRegistry(state, seatsCfg, []);
    let llmCfg = { baseUrl: '', model: '', apiKey: '', enabledSeats: [], dm: false };
    let lastDiagnostics = [];
    let requestCache = Object.create(null);
    const listeners = [];

    const stateId = () => computeStateId(state);
    const emit = (type, payload) => {
        const event = { type, turn: state.turn, ...payload };
        for (const fn of listeners) { try { fn(event); } catch (_) { /* 回调异常不影响推演 */ } }
        return event;
    };

    function remember(requestId, reply) {
        if (!requestId) return;
        requestCache[requestId] = reply;
        const keys = Object.keys(requestCache);
        if (keys.length > 64) delete requestCache[keys[0]];
    }

    /** 一席模型意图：失败一律返回 null，由 ensureDecisions 统一补确定性君主 */
    async function oneMonarch(civ) {
        const started = Date.now();
        const legal = legalActions(state, civ.id, rules);
        const diag = { civId: civ.id, name: civ.name, source: 'deterministic', ms: 0, error: null };
        try {
            const snap = snapshotFor(state, civ.id);
            const result = await chatComplete(
                llmCfg,
                monarchSystem(rules),
                wrapAsGameData(monarchUser(snap, civ, legal), '群星编年 · 君主简报'),
                rules.ai, transport,
            );
            if (result.ok) {
                const parsed = parseStructured(result.text);
                const candidate = parsed && typeof parsed === 'object' ? {
                    civId: civ.id,
                    type: parsed.type,
                    target: parsed.target ?? null,
                    magnitude: parsed.magnitude ?? 1,
                    note: typeof parsed.note === 'string' ? parsed.note : '',
                } : null;
                const check = candidate ? validateDecisions(state, [candidate], rules) : { accepted: [], rejections: [] };
                if (check.accepted.length === 1) {
                    diag.source = 'model';
                    diag.ms = Date.now() - started;
                    return { decision: { ...check.accepted[0] }, diag };
                }
                diag.error = check.rejections[0]?.code ?? '模型输出不符合契约';
            } else {
                diag.error = result.error;
            }
        } catch (err) {
            diag.error = String(err?.message ?? err).slice(0, 120);
        }
        diag.ms = Date.now() - started;
        const fallback = deterministicDecision(state, civ, legal, rules);
        return { decision: fallback, diag };
    }

    async function runModels(includeDm, apply) {
        const enabled = new Set(Array.isArray(llmCfg.enabledSeats) ? llmCfg.enabledSeats : []);
        const targets = state.civs.filter((c) => c.alive && enabled.has(c.id) && !state.decisions[c.id]);
        const results = new Array(targets.length);
        let cursor = 0;
        const workers = Math.max(1, Math.min(rules.ai.concurrency, targets.length || 1));
        async function worker() {
            while (cursor < targets.length) {
                const i = cursor; cursor += 1;
                results[i] = await oneMonarch(targets[i]);
            }
        }
        await Promise.all(Array.from({ length: workers }, () => worker()));
        const collected = results.filter((r) => r?.decision).map((r) => r.decision);
        lastDiagnostics = results.map((r) => r?.diag ?? { source: 'deterministic' });
        const checked = validateDecisions(state, collected, rules);
        for (const d of checked.accepted) state.decisions[d.civId] = sealDecision(state, d);

        let dmSummary = { reason: includeDm ? '未配置 DM 模型' : '未请求 DM 模型', edits: 0 };
        if (includeDm && llmCfg.dm && llmCfg.apiKey && llmCfg.model) {
            try {
                const snap = snapshotFor(state, null);
                const resp = await chatComplete(
                    llmCfg, dmSystem(rules), wrapAsGameData(dmUser(snap), '群星编年 · DM 简报'), rules.ai, transport,
                );
                if (resp.ok) {
                    const parsed = parseStructured(resp.text);
                    const edits = Array.isArray(parsed?.edits) ? parsed.edits.slice(0, rules.dm.maxEditsPerTurn) : [];
                    const v = validateDmEdits(state, edits, rules);
                    state.dmEdits.push(...v.accepted);
                    dmSummary = { reason: '已登记', edits: v.accepted.length, rejections: v.rejections };
                } else dmSummary = { reason: '干预来源暂不可用', edits: 0 };
            } catch (_) { dmSummary = { reason: '干预来源暂不可用', edits: 0 }; }
        }

        const filled = ensureDecisions({ state, rules, registry, seatsCfg });
        if (filled.waiting.length) {
            return { code: 'SEATS_WAITING', message: REJECTION_MESSAGES.SEATS_WAITING, diagnostics: lastDiagnostics, dm: dmSummary };
        }
        let advanced = null;
        if (apply !== false) {
            const result = advanceTurn(state, rules);
            advanced = { report: result.report, winner: result.winner, events: result.events.length };
        }
        pushEvent(state, 'auto_turn', { applied: Boolean(advanced) });
        emit('turn_resolved', { turn: state.turn, winner: state.winner });
        return {
            rejections: checked.rejections, dm: dmSummary, advanced,
            diagnostics: lastDiagnostics, stateId: stateId(), turn: state.turn, phase: state.phase,
        };
    }

    function sync(op, body) {
        const b = body || {};
        switch (op) {
            case 'stateId': return { stateId: stateId(), turn: state.turn, phase: state.phase };
            case 'snapshot': {
                const snap = snapshotFor(state, b.viewerCivId ?? null);
                return { snapshot: snap, stateId: snap.stateId, layout: state.layout };
            }
            case 'actions': return { actions: legalActions(state, b.civId, rules) };
            case 'chronicle': return { chronicle: snapshotFor(state, null).chronicle };
            case 'report': return { report: state.lastReport };
            case 'rules': return { rules, epochs: rules.epochs, actions: rules.actions.types, dmTypes: rules.dm.allowed };
            case 'seats': return { seats: adminSeatView(registry, state, monarchs, seatsCfg) };
            case 'setSeats': {
                const validIds = state.civs.map((c) => c.id);
                const res = applySeatControls(registry, b.list, validIds, ['human', 'ai']);
                emit('seats_changed', { count: res.applied.length });
                return { ...res, stateId: stateId() };
            }
            case 'decisions': {
                const list = Array.isArray(b.decisions) ? b.decisions : [];
                const { accepted, rejections } = validateDecisions(state, list, rules);
                for (const d of accepted) {
                    state.decisions[d.civId] = sealDecision(state, d);
                    markClaimed(registry, d.civId);
                }
                // 事件不含席位名单、不含提交数量：不能从「谁先下令」反推控制者
                pushEvent(state, 'decisions_submitted', {});
                emit('decisions_submitted', {});
                return { accepted, rejections, stateId: stateId(), turn: state.turn };
            }
            case 'dm': {
                const { accepted, rejections } = validateDmEdits(state, Array.isArray(b.edits) ? b.edits : [], rules);
                state.dmEdits.push(...accepted);
                pushEvent(state, 'dm_edits', { count: accepted.length, types: accepted.map((e) => e.type) });
                return { accepted, rejections, stateId: stateId(), turn: state.turn };
            }
            case 'advance': {
                const filled = ensureDecisions({ state, rules, registry, seatsCfg });
                if (filled.waiting.length) return { code: 'SEATS_WAITING', message: REJECTION_MESSAGES.SEATS_WAITING, stateId: stateId() };
                const result = advanceTurn(state, rules);
                emit('turn_resolved', { turn: state.turn, winner: state.winner });
                return {
                    report: result.report, winner: result.winner, events: result.events.length,
                    stateId: stateId(), turn: state.turn, phase: state.phase,
                };
            }
            case 'save': return { json: serialize(state), stateId: stateId(), turn: state.turn };
            case 'load': {
                try {
                    const raw = b.json;
                    const next = restore(raw, rules);
                    next.roomId = state.roomId;
                    state = next;
                    // 存档不含席位分配：读档后回到全人机，用户可在本机设置页重新接管
                    registry = createSeatRegistry(state, seatsCfg, []);
                    requestCache = Object.create(null);
                    lastDiagnostics = [];
                    emit('loaded', { turn: state.turn });
                    return { ok: true, stateId: stateId(), turn: state.turn };
                } catch (err) {
                    return { code: 'SAVE_INVALID', message: String(err?.message ?? err) };
                }
            }
            case 'reset': {
                state = createGame({ roomId: state.roomId, rules, monarchs, worldCfg, seed: b.seed });
                registry = createSeatRegistry(state, seatsCfg, []);
                requestCache = Object.create(null);
                lastDiagnostics = [];
                emit('reset', { turn: state.turn });
                return { ok: true, stateId: stateId(), turn: state.turn, snapshot: snapshotFor(state, null) };
            }
            case 'llmConfigure': {
                const next = b.config || b;
                llmCfg = {
                    baseUrl: String(next.baseUrl || '').trim(),
                    model: String(next.model || '').trim(),
                    apiKey: String(next.apiKey || ''),
                    enabledSeats: Array.isArray(next.enabledSeats)
                        ? next.enabledSeats.filter((id) => state.civs.some((c) => c.id === id)) : [],
                    dm: Boolean(next.dm),
                };
                return { ok: true, status: llmStatus() };
            }
            case 'llmClear': llmCfg = { baseUrl: '', model: '', apiKey: '', enabledSeats: [], dm: false }; return { ok: true, status: llmStatus() };
            case 'llmStatus': return { status: llmStatus() };
            case 'diagnostics': return { diagnostics: lastDiagnostics.slice() };
            case 'config': return { defaults: monarchs.defaults, slots: monarchs.slots.map((s) => ({ id: s.id, name: s.name, monarch: s.monarch })) };
            default: return { code: 'MALFORMED_PAYLOAD', message: `未知操作：${op}` };
        }
    }

    function llmStatus() {
        return {
            configured: Boolean(llmCfg.baseUrl && llmCfg.model && llmCfg.apiKey),
            baseUrl: llmCfg.baseUrl,
            model: llmCfg.model,
            enabledSeats: llmCfg.enabledSeats.slice(),
            dm: llmCfg.dm,
            hasKey: Boolean(llmCfg.apiKey),
            budget: { concurrency: rules.ai.concurrency, timeoutMs: rules.ai.timeoutMs, maxTokens: rules.ai.maxTokensPerDecision },
        };
    }

    /**
     * 统一内存入口，返回对象或 Promise（'auto' 为异步）。
     * 写操作带 stateId 时执行 CAS 校验；带 requestId 时执行幂等回执。
     */
    function call(op, body = {}) {
        const b = body || {};
        if (WRITE_OPS.includes(op) && b.requestId && requestCache[b.requestId]) {
            return { ...requestCache[b.requestId], replayed: true };
        }
        if (WRITE_OPS.includes(op) && b.stateId !== undefined && b.stateId !== stateId()) {
            return {
                code: 'STALE_REVISION', error: 'STALE_REVISION',
                message: REJECTION_MESSAGES.STALE_REVISION, stateId: stateId(),
            };
        }
        if (op === 'auto') {
            return runModels(Boolean(b.includeDm), b.apply !== false).then((reply) => {
                if (b.requestId) remember(b.requestId, reply);
                return reply;
            });
        }
        const reply = sync(op, b);
        if (WRITE_OPS.includes(op) && b.requestId && !reply.code) remember(b.requestId, reply);
        return reply;
    }

    return {
        VERSION,
        call,
        onEvent(fn) { if (typeof fn === 'function') listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },
        /** 供回归测试与 UI 用：只返回脱敏后的权威快照，不含 registry */
        snapshot(viewerCivId = null) { return snapshotFor(state, viewerCivId); },
        stateId,
        get turn() { return state.turn; },
        get phase() { return state.phase; },
        get winner() { return state.winner; },
        /** 明确列出单机版不会写进存档的字段，供 UI / 测试断言 */
        get blindFields() { return SENSITIVE.slice(); },
    };
}
