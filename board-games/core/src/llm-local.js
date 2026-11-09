// llm-local.js — on-device LLM player driver.
//
// The transport is injected (`chat(messages) -> Promise<string>`): Android uses
// a native HTTPS bridge (no browser CORS, key held in native memory), while a
// desktop web host can inject a fetch-based chat. The driver itself is pure and
// shares the exact prompt/parser used by the room server.

import { buildAgentPrompt, parseAgentActions } from './agent.js';

export function createLlmDriver(chat) {
  if (typeof chat !== 'function') throw new Error('createLlmDriver 需要 chat(messages) 函数');
  const state = { available: false, model: '', baseUrl: '' };
  return {
    get available() { return state.available; },
    get model() { return state.model; },
    get baseUrl() { return state.baseUrl; },
    /** Called after native/browser configuration changes. */
    configure(cfg = {}) {
      state.available = cfg.available === true;
      state.model = typeof cfg.model === 'string' ? cfg.model : '';
      state.baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '';
    },
    async decide(ctx) {
      if (!state.available) throw new Error('LLM 未配置');
      const prompt = buildAgentPrompt(ctx);
      const text = await chat(prompt.messages);
      return parseAgentActions(ctx.gameKey, text, ctx);
    },
    /** 聊天接话：只产出一句纯文本，不经过动作解析。 */
    async talk(ctx) {
      if (!state.available) throw new Error('LLM 未配置');
      const lines = (ctx.chat || [])
        .slice(-6)
        .map((m) => `${m.from || '?'}: ${String(m.text || '').slice(0, 120)}`)
        .join('\n');
      const messages = [
        {
          role: 'system',
          content:
            '你是桌游房间里的玩家，正在和真人玩家一起玩。只输出一句中文口语（10-40 字），'
            + '不要输出 JSON、动作、解释或引号；可以接话、评论局势或适度放狠话，'
            + '但不要泄露手牌/身份，也不要编造规则。',
        },
        {
          role: 'user',
          content: `游戏：${ctx.gameName || ctx.gameKey}\n你的昵称：${ctx.seatName || 'LLM'}\n最近聊天：\n${lines || '（暂无）'}\n\n用一句话接话。`,
        },
      ];
      const text = await chat(messages);
      return String(text || '').replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    },
  };
}
