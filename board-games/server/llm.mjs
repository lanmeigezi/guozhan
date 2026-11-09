// llm.mjs — optional server-side LLM player seat.
//
// Configuration is environment-only so the API key never reaches a phone or a
// browser:
//   LLM_API_KEY   (or OPENAI_API_KEY)  required; if absent the LLM seat is hidden
//   LLM_BASE_URL  OpenAI-compatible base, default https://api.deepseek.com/v1
//   LLM_MODEL     model id, default deepseek-chat
//   LLM_TIMEOUT_MS default 30000
//   LLM_TEMPERATURE default 0.35
//   LLM_MAX_TOKENS default 450
//
// If the model is slow, unreachable, or returns an illegal action, Host falls
// back to the deterministic game AI so the room cannot dead-lock.

import { buildAgentPrompt, parseAgentReply } from '../core/src/agent.js';

function firstEnv(env, names, fallback = '') {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return fallback;
}

function completionsUrl(base) {
  const trimmed = String(base || '').replace(/\/+$/, '');
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

export function createLlmFromEnv(env = process.env) {
  const apiKey = firstEnv(env, ['LLM_API_KEY', 'OPENAI_API_KEY']);
  if (!apiKey) return null;
  const baseUrl = firstEnv(env, ['LLM_BASE_URL'], 'https://api.deepseek.com/v1');
  const model = firstEnv(env, ['LLM_MODEL'], baseUrl.includes('deepseek') ? 'deepseek-chat' : 'gpt-4o-mini');
  const timeoutMs = Math.max(1000, Number(env.LLM_TIMEOUT_MS) || 30000);
  const temperature = Number.isFinite(Number(env.LLM_TEMPERATURE)) ? Number(env.LLM_TEMPERATURE) : 0.35;
  const maxTokens = Math.max(80, Number(env.LLM_MAX_TOKENS) || 450);
  const url = completionsUrl(baseUrl);

  async function chat(messages) {
    // 网络抖动（直连 DeepSeek 有时要十几秒、连接被打断）时重试一次；
    // HTTP 4xx/5xx 不重试，避免把鉴权/额度错误放大成等待。
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
            stream: false,
          }),
          signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        let data;
        try { data = JSON.parse(text); } catch (_) { throw new Error('LLM 返回的不是 JSON'); }
        const message = data && data.choices && data.choices[0] && data.choices[0].message;
        const content = message && message.content;
        if (typeof content === 'string' && content.trim()) return content;
        if (Array.isArray(content)) {
          const joined = content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
          if (joined.trim()) return joined;
        }
        throw new Error('LLM 返回空内容');
      } catch (err) {
        lastErr = err;
        const code = String((err && err.cause && err.cause.code) || '');
        const msg = `${err && err.message ? err.message : err} ${code}`;
        const retriable = /fetch failed|abort|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(msg);
        if (!retriable || attempt === 1) throw err;
        await new Promise((r) => setTimeout(r, 400));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error('LLM 调用失败');
  }

  return {
    model,
    baseUrl,
    available: true,
    async decide(ctx) {
      const prompt = buildAgentPrompt(ctx);
      const text = await chat(prompt.messages);
      return parseAgentReply(ctx.gameKey, text, ctx);
    },
    /**
     * 聊天接话：不等轮到自己，根据最近几条聊天回一句人话。
     * 只产出纯文本，任何动作都仍然走 decide/parseAgentReply 那条受控路径。
     */
    async talk(ctx) {
      const chatLines = (ctx.chat || [])
        .slice(-6)
        .map((m) => `${m.from || '?'}: ${String(m.text || '').slice(0, 120)}`)
        .join('\n');
      const messages = [
        {
          role: 'system',
          content:
            '你是桌游房间里的玩家，正在和真人玩家一起玩。只输出一句中文口语（10-40 字），'
            + '不要输出 JSON、动作、解释或引号；可以接话、评论局势或适度放狠话，'
            + '但不要泄露手牌/身份，也不要编造规则或承诺游戏里做不到的事。',
        },
        {
          role: 'user',
          content: `游戏：${ctx.gameName || ctx.gameKey}\n你的昵称：${ctx.seatName || 'LLM'}\n最近聊天：\n${chatLines || '（暂无）'}\n\n用一句话接话。`,
        },
      ];
      const text = await chat(messages);
      return String(text || '').replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    },
  };
}

export function describeLlm(llm) {
  if (!llm) return { available: false, model: null };
  return { available: true, model: llm.model || 'llm' };
}
