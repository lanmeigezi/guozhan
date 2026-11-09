// chat.test.js — 聊天分频道：公共限频、私聊直达且不占公共冷却。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Host } from '../src/host.js';
import { FrameDecoder } from '../src/protocol.js';

function fakeGuest(host, id, name, seat) {
  const got = [];
  const dec = new FrameDecoder();
  const rec = {
    id,
    name,
    seat,
    decoder: dec,
    idleUntil: 0,
    transport: {
      send(bytes) {
        for (const m of dec.push(bytes)) got.push(m);
      },
    },
  };
  host.guests.set(id, rec);
  return got;
}

test('公共频道每人限频，私聊只投递给目标', () => {
  const host = new Host({ game: 'uno', playerName: '甲' });
  host.game.players.push({ id: 1, name: '乙' }, { id: 2, name: '丙' });
  const a = fakeGuest(host, 1, '甲', 0);
  const b = fakeGuest(host, 2, '乙', 1);
  const c = fakeGuest(host, 3, '丙', 2);
  const recA = host.guests.get(1);

  host._handleChat(recA, { text: '公共一' });
  host._handleChat(recA, { text: '公共二' }); // 1.5 秒内第二条应被丢弃
  assert.equal(a.filter((m) => m.t === 'chat').length, 1, '发送者只应看到一条公共消息');
  assert.equal(b.filter((m) => m.t === 'chat').length, 1);
  assert.equal(c.filter((m) => m.t === 'chat').length, 1);

  host._handleChat(recA, { text: '悄悄话', to: 1 });
  const seenB = b.filter((m) => m.t === 'chat').slice(-1)[0];
  assert.equal(seenB.text, '悄悄话');
  assert.equal(seenB.to, 1);
  assert.ok(a.some((m) => m.text === '悄悄话'), '发送者要看到自己的私聊回显');
  assert.equal(c.some((m) => m.text === '悄悄话'), false, '第三者不得收到私聊');
  assert.equal(host.chatLog.some((m) => m.text === '悄悄话'), false, '私聊不得进公共聊天日志');
});

test('私聊发给 LLM 立刻回复，且不受公共频道 20 秒限制', async () => {
  let direct = null;
  const driver = {
    model: 'mock',
    async decide() { return null; },
    async talk(ctx) { direct = ctx.direct === true; return ' 收到，私下说 '; },
  };
  const host = new Host({ game: 'uno', playerName: '甲', llm: driver });
  try {
    host.addLlm('AI');
    host._llmLastSpokeAt = Date.now(); // 公共频道刚刚说过一句
    const a = fakeGuest(host, 1, '甲', 0);
    fakeGuest(host, 2, 'AI', 1);
    host._handleChat(host.guests.get(1), { text: '私下商量一下', to: 1 });
    await host._llmChatTask;
    assert.equal(direct, true, '私聊回复要标记 direct');
    const reply = a.filter((m) => m.t === 'chat' && m.from === 'AI').slice(-1)[0];
    assert.ok(reply, '发送者应收到 LLM 的私聊回复');
    assert.equal(reply.text, '收到，私下说');
    assert.equal(reply.to, 0, '回复只能回到发送者');
  } finally {
    host.stopLlmLoop?.();
  }
});
