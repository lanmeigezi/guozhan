/**
 * 回合编排：把 12 个君主席位变成 12 次（可并发、可降级）的模型调用。
 * 这是「把内置 Agent SDK 替换成外部 Harness」的落地点之一：Harness 可以是
 * 酒馆扩展、MCP 客户端，也可以是本文件里的 OpenAI 兼容直连。
 */
import { createRng } from '../core/rng.js';
import { snapshotFor } from '../core/state.js';
import { legalActions, validateDecisions } from '../core/commands.js';
import { createAdapter } from './adapter.js';
import { monarchSystem, monarchUser, dmSystem, dmUser, parseStructured, wrapAsGameData } from './prompts.js';

const PERSONA_BIAS = [
    [/重农|积累|制度|秩序|发展度/, ['invest', 'stabilize', 'research']],
    [/崇商|贸易|外柔|条约|纵横/, ['diplomacy', 'research', 'invest']],
    [/尚武|扩张|抢地|机动|先手/, ['attack', 'expand', 'fortify']],
    [/技术|科技|官僚|倒推/, ['research', 'invest', 'colonize']],
    [/民生|审慎|稳定|隐忍|储能/, ['stabilize', 'invest', 'research']],
    [/宏大|奇观|戏剧|星际|冒险/, ['research', 'colonize', 'expand']],
    [/海洋|能源|殖民|航行/, ['colonize', 'invest', 'research']],
];

/** 离线确定性君主：由 seed+回合+席位派生，不污染主时间线 RNG */
export function deterministicDecision(state, civ, legal, rules) {
    const rng = createRng(`${state.seed}::ai::${civ.id}::${state.turn}`);
    let preferred = ['research', 'invest', 'expand', 'stabilize'];
    for (const [pattern, list] of PERSONA_BIAS) {
        if (pattern.test(civ.persona ?? '')) { preferred = list; break; }
    }
    const candidates = legal.actions ?? [];
    if (!candidates.length) return null;
    let chosen = null;
    for (const type of preferred) {
        const pool = candidates.filter((a) => a.type === type);
        if (pool.length) { chosen = rng.pick(pool); break; }
    }
    if (!chosen) chosen = rng.pick(candidates);
    return {
        civId: civ.id,
        type: chosen.type,
        target: chosen.command.target ?? null,
        magnitude: chosen.magnitude,
        note: '依国策而行。', // ★中性台词：绝不能出现「离线 / AI / 托管 / 模型」等身份标记
    };
}

/** 模型绑定从 config/monarchs.json 读，不从权威 state 读（state 里没有也不该有身份信息） */
async function oneMonarch(state, civ, rules, monarchs, slot) {
    const started = Date.now();
    const legal = legalActions(state, civ.id, rules);
    const adapter = createAdapter(slot ?? { id: civ.id }, monarchs.defaults, rules);
    const diag = { civId: civ.id, name: civ.name, label: slot?.modelLabel ?? '', mode: adapter.mode, model: adapter.model, ms: 0, source: adapter.mode, error: null };

    if (adapter.mode === 'openai') {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), rules.ai.timeoutMs);
        try {
            const snap = snapshotFor(state, civ.id);
            const result = await adapter.complete(
                monarchSystem(rules),
                monarchUser(snap, civ, legal),
                { signal: controller.signal, maxTokens: rules.ai.maxTokensPerDecision },
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
                    diag.ms = Date.now() - started;
                    diag.source = 'model';
                    return { decision: { ...check.accepted[0] }, diag };
                }
                diag.error = check.rejections[0]?.code ?? '模型输出不符合契约';
            } else {
                diag.error = result.error;
            }
        } finally {
            clearTimeout(timer);
        }
    }

    const fallback = deterministicDecision(state, civ, legal, rules);
    diag.ms = Date.now() - started;
    diag.source = 'deterministic';
    return { decision: fallback, diag };
}

/**
 * 收集 12 个席位本回合的意图。只返回数据，不修改 state（写操作由 server 统一校验后落库）。
 * @returns {Promise<{decisions:Array<object>, diagnostics:Array<object>}>}
 */
export async function collectDecisions(state, rules, monarchs, eligibleIds = null) {
    const slots = new Map(monarchs.slots.map((s) => [s.id, s]));
    // 人类席位已提交的意图绝不覆盖：/auto 只让 ai 席位出招
    const alive = state.civs.filter((c) => c.alive && (eligibleIds === null || eligibleIds.has(c.id)));
    const results = new Array(alive.length);
    let cursor = 0;
    async function worker() {
        while (cursor < alive.length) {
            const i = cursor;
            cursor += 1;
            results[i] = await oneMonarch(state, alive[i], rules, monarchs, slots.get(alive[i].id));
        }
    }
    const n = Math.max(1, Math.min(rules.ai.concurrency, alive.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
    return {
        decisions: results.filter((r) => r?.decision).map((r) => r.decision),
        diagnostics: results.map((r) => r?.diag ?? { civId: '?', source: 'deterministic' }),
    };
}

/**
 * 可选的「DM 模型」：默认关闭。配置 CIV_DM_KEY + CIV_DM_MODEL（+ CIV_DM_BASE_URL）后启用，
 * 让主持人模型主动提交修正 —— 对应视频「提高 DM 模型修改的权重」。
 */
export async function generateDmEdits(state, rules) {
    const key = process.env.CIV_DM_KEY || process.env.CIV_API_KEY || '';
    const model = process.env.CIV_DM_MODEL || '';
    if (!key || !model) return { edits: [], reason: '本回合无额外干预' };
    const baseUrl = (process.env.CIV_DM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), rules.ai.timeoutMs);
    try {
        const snap = snapshotFor(state, null);
        const resp = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: dmSystem(rules) },
                    { role: 'user', content: dmUser(snap) },
                ],
                temperature: 0.6,
                max_tokens: 400,
                stream: false,
            }),
            signal: controller.signal,
        });
        if (!resp.ok) return { edits: [], reason: '干预来源暂不可用' };
        const json = await resp.json();
        const parsed = parseStructured(json?.choices?.[0]?.message?.content ?? '');
        const edits = Array.isArray(parsed?.edits) ? parsed.edits.slice(0, rules.dm.maxEditsPerTurn) : [];
        return { edits, reason: '已登记' };
    } catch (err) {
        return { edits: [], reason: '干预来源暂不可用' };
    } finally {
        clearTimeout(timer);
    }
}

export { wrapAsGameData };
