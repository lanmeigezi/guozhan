/**
 * 模型适配器：每个君主席位可以绑定不同的 OpenAI 兼容端点与模型（复刻视频的「12 个大模型」）。
 * 缺 Key / 缺模型 ID / 超时 / 返回不合法 JSON 时一律降级为离线确定性君主，绝不阻塞推演。
 */

/** @param {object} slot @param {object} defaults @param {object} rules */
export function createAdapter(slot, defaults, rules) {
    const cfg = { ...defaults, ...(slot.model ?? {}) };
    const apiKey = (cfg.apiKeyEnv && process.env[cfg.apiKeyEnv]) || process.env.CIV_API_KEY || '';
    const wantsModel = cfg.adapter === 'openai';
    const enabled = Boolean(wantsModel && cfg.model && apiKey);
    const reason = !wantsModel ? '未启用外部模型'
        : !cfg.model ? '未填写模型 ID'
            : !apiKey ? `缺少环境变量 ${cfg.apiKeyEnv ?? 'CIV_API_KEY'}` : '';
    // 允许按席位覆盖端点：apiKeyEnv=CIV_MODEL_02_KEY → 读 CIV_MODEL_02_BASE_URL
    const envStem = String(cfg.apiKeyEnv ?? '').replace(/_KEY$/, '');
    const overrideBase = envStem ? process.env[`${envStem}_BASE_URL`] : '';
    const baseUrl = String(overrideBase || cfg.baseUrl || '').replace(/\/+$/, '');

    return {
        slotId: slot.id,
        mode: enabled ? 'openai' : 'deterministic',
        modelLabel: slot.modelLabel,
        model: cfg.model || null,
        reason,
        /** @returns {Promise<{ok:boolean, text?:string, error?:string}>} */
        async complete(system, user, { signal, maxTokens } = {}) {
            if (!enabled) return { ok: false, error: reason };
            try {
                const resp = await fetch(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                        model: cfg.model,
                        messages: [
                            { role: 'system', content: system },
                            { role: 'user', content: user },
                        ],
                        temperature: cfg.temperature ?? 0.8,
                        max_tokens: maxTokens ?? cfg.maxTokens ?? rules.ai.maxTokensPerDecision,
                        stream: false,
                    }),
                    signal,
                });
                if (!resp.ok) return { ok: false, error: `HTTP ${resp.status} ${(await resp.text()).slice(0, 120)}` };
                const json = await resp.json();
                const text = json?.choices?.[0]?.message?.content;
                if (typeof text !== 'string') return { ok: false, error: '响应缺少 choices[0].message.content' };
                return { ok: true, text };
            } catch (err) {
                return { ok: false, error: err?.name === 'AbortError' ? '超时' : String(err?.message ?? err).slice(0, 160) };
            }
        },
    };
}

/** 12 席模型绑定总览（面板 / MCP 用；绝不返回 Key 内容） */
export function adapterReport(slots, defaults, rules) {
    return slots.map((slot) => {
        const a = createAdapter(slot, defaults, rules);
        return {
            civId: slot.id,
            name: slot.name,
            monarch: slot.monarch,
            label: slot.modelLabel,
            mode: a.mode,
            model: a.model,
            reason: a.reason,
        };
    });
}
