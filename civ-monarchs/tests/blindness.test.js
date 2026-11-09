/**
 * 席位盲化回归测试
 * 目标：任何会被模型看到的通道（状态、快照、事件流、编年史、战报、存档、MCP 工具、自动推演回执）
 * 都不含「哪个国家由人类 / 人机控制」的信息，也不含模型绑定痕迹。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/server/loader.js';
import { createApp } from '../src/server/app.js';
import { createGame, snapshotFor, serialize } from '../src/core/state.js';
import { legalActions } from '../src/core/commands.js';
import { monarchSystem, monarchUser, dmSystem, dmUser } from '../src/ai/prompts.js';

const IDENTITY_KEYS = /\b(control|claimed|driver|modelLabel|adapter|apiKey|apiKeyEnv|diagnostics|modelCount|pendingSeats|seatTokens|adminToken|submitted)\b/i;
const VENDOR = /DeepSeek|Qwen|GLM|Kimi|Hunyuan|Doubao|MiniMax|Claude|GPT|Gemini|Grok|openai|deterministic/i;
const IDENTITY_TEXT = /离线君主|由人机|由人类|AI\s*托管|程序托管|模型席位|人类席位|人机席位|离线降级/;

const config = loadConfig();
let app, server, base, room;

async function call(method, path, body, headers = {}) {
    const r = await fetch(`${base}/api${path}`, {
        method,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
    return { ok: r.ok, status: r.status, json, text };
}
const R = () => `/rooms/${room.id}`;
const adminHeaders = () => ({ 'X-Admin-Token': room.adminToken });

before(async () => {
    app = createApp(config, {});
    room = app.makeRoom('room-blind', 'blind-seed', true, []);
    server = createServer((req, res) => { app.handler(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { app?.close(); server?.close(); });

test('权威 state 与存档里根本没有席位身份或模型绑定字段', () => {
    const s = createGame({ rules: config.rules, monarchs: config.monarchs, worldCfg: config.world, seed: 'audit' });
    for (const c of s.civs) {
        assert.doesNotMatch(JSON.stringify(c), IDENTITY_KEYS);
        assert.doesNotMatch(JSON.stringify(c), VENDOR);
    }
    const saved = serialize(s);
    assert.doesNotMatch(saved, IDENTITY_KEYS);
    assert.doesNotMatch(saved, VENDOR);
    assert.ok(!saved.includes('requestCache'), '存档不得夹带幂等回执缓存');
});

test('快照：DM 全知与席位视角都不含身份 / 提交状态 / 模型痕迹', () => {
    const dm = snapshotFor(room.state, null);
    const seat = snapshotFor(room.state, 'civ-01');
    for (const snap of [dm, seat]) {
        const text = JSON.stringify(snap);
        assert.doesNotMatch(text, IDENTITY_KEYS);
        assert.doesNotMatch(text, VENDOR);
    }
    assert.equal(typeof dm.civs.find((c) => c.id === 'civ-01').tech, 'number');
    assert.ok(!Object.prototype.hasOwnProperty.call(dm.civs[0], 'submitted'));
    assert.deepEqual(dm.decisions, {}, 'DM 视角不得看到谁已提交意图');
});

test('管理端点：非房主一律 403，响应不含任何分配信息', async () => {
    for (const path of ['/models', '/seats']) {
        const r = await call('GET', `${R()}${path}`);
        assert.equal(r.status, 403);
        assert.equal(r.json.code, 'ADMIN_REQUIRED');
        assert.doesNotMatch(r.text, IDENTITY_KEYS);
    }
    // 房主可读，但这是唯一可见通道
    const admin = await call('GET', `${R()}/seats`, undefined, adminHeaders());
    assert.equal(admin.status, 200);
    assert.equal(admin.json.seats.length, 12);
    assert.equal(admin.json.seats[0].control, 'ai');
    assert.match(JSON.stringify(admin.json), /control/);
});

test('默认 12 席全人机：不提交任何意图也能直接结算一回合', async () => {
    const snap = await call('GET', `${R()}/snapshot`);
    const r = await call('POST', `${R()}/advance`, { stateId: snap.json.snapshot.stateId, requestId: 'blind-adv-1' });
    assert.equal(r.status, 200);
    assert.match(r.json.report, /第 1 回合/);
    assert.doesNotMatch(r.text, IDENTITY_KEYS);
    assert.doesNotMatch(r.text, VENDOR);
    assert.doesNotMatch(r.json.report, IDENTITY_TEXT);
});

test('自动补位后，编年史与战报里 12 国都有举动且无身份标记', async () => {
    const s = createGame({ rules: config.rules, monarchs: config.monarchs, worldCfg: config.world, seed: 'note-audit' });
    const { ensureDecisions, createSeatRegistry, sealDecision } = await import('../src/core/seats.js');
    const registry = createSeatRegistry(s, config.seats, []);
    const filled = ensureDecisions({ state: s, rules: config.rules, registry, seatsCfg: config.seats });
    assert.equal(filled.filled.length, 12, '所有席位都应被补齐，行为一致');
    for (const d of Object.values(s.decisions)) {
        assert.deepEqual(Object.keys(d).sort(), ['civId', 'magnitude', 'note', 'target', 'type'], '意图字段白名单');
        assert.doesNotMatch(d.note, IDENTITY_TEXT);
    }
    // ★试玩回归：人类 / 模型写的个性化台词必须被史官统一润色，且 12 席共用同一生成器，
    //   不能出现「固定短句池轮换」那种可聚类的重复模式。
    const personalized = { civId: 'civ-03', type: 'research', target: null, magnitude: 1, note: '我是真人玩家，这是我的专属长台词，绝无雷同。' };
    const sealed = sealDecision(s, personalized);
    assert.notEqual(sealed.note, personalized.note, '任何来源的 note 都必须被重写');
    assert.doesNotMatch(sealed.note, IDENTITY_TEXT);
    const phrases = s.civs.map((c) => sealDecision(s, { ...personalized, civId: c.id }).note);
    assert.ok(new Set(phrases).size >= 9, `12 席台词应基本不重复，实际唯一 ${new Set(phrases).size}`);
});

test('人类席位不下令时由人机临时托管：非房主拿不到等待名单', async () => {
    const set = await call('POST', `${R()}/seats`, { seats: [{ civId: 'civ-01', control: 'human' }] }, adminHeaders());
    assert.equal(set.status, 200);
    const snap = await call('GET', `${R()}/snapshot`);
    const adv = await call('POST', `${R()}/advance`, { stateId: snap.json.snapshot.stateId, requestId: 'blind-adv-2' });
    assert.equal(adv.status, 200, 'policy=auto 不应阻塞开局');
    assert.doesNotMatch(adv.text, IDENTITY_KEYS);
});

test('wait 策略：409 只给中性提示，名单仅房主可见', async () => {
    const waitCfg = { ...config, seats: { ...config.seats, policy: 'wait' } };
    const waitApp = createApp(waitCfg, {});
    const wr = waitApp.makeRoom('room-wait', 'wait-seed', true, ['civ-01']);
    const ws = createServer((req, res) => { waitApp.handler(req, res).catch(() => { res.writeHead(500); res.end(); }); });
    await new Promise((resolve) => ws.listen(0, '127.0.0.1', resolve));
    const b = `http://127.0.0.1:${ws.address().port}`;
    try {
        const snap = await fetch(`${b}/api/rooms/room-wait/snapshot`).then((r) => r.json());
        const plain = await fetch(`${b}/api/rooms/room-wait/advance`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stateId: snap.snapshot.stateId, requestId: 'wait-1' }),
        }).then((r) => r.json());
        assert.equal(plain.code, 'SEATS_WAITING');
        assert.equal(plain.pending, undefined, '非房主连数量都不应看到');
        assert.equal(plain.pendingSeats, undefined);
        const asAdmin = await fetch(`${b}/api/rooms/room-wait/advance`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Token': wr.adminToken },
            body: JSON.stringify({ stateId: plain.stateId, requestId: 'wait-2' }),
        }).then((r) => r.json());
        assert.ok(Array.isArray(asAdmin.pendingSeats), '房主可见等待名单');
    } finally {
        waitApp.close(); ws.close();
    }
});

test('/auto 回执：非房主不含诊断，房主才可见', async () => {
    const plain = await call('POST', `${R()}/auto`, { apply: true, includeDm: false, requestId: 'blind-auto-1' });
    assert.equal(plain.status, 200);
    assert.equal(plain.json.diagnostics, undefined);
    assert.equal(plain.json.admin, undefined);
    assert.doesNotMatch(plain.text, VENDOR);
    assert.doesNotMatch(plain.text, IDENTITY_KEYS);
    const asAdmin = await call('POST', `${R()}/auto`, { apply: false, includeDm: false, requestId: 'blind-auto-2' }, adminHeaders());
    assert.equal(asAdmin.status, 200);
    assert.ok(Array.isArray(asAdmin.json.admin?.diagnostics), '房主可查看诊断');
});

test('SSE 事件流不含席位名单 / 补位数量 / 模型数量', async () => {
    const ctrl = new AbortController();
    const resp = await fetch(`${base}/api${R()}/events?from=0`, { signal: ctrl.signal });
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    ctrl.abort();
    const text = new TextDecoder().decode(value ?? new Uint8Array());
    for (const key of ['civIds', 'modelCount', 'acted', 'filled', 'count', 'diagnostics', 'control']) {
        assert.ok(!text.includes(`"${key}"`), `事件流不应出现 ${key}`);
    }
    assert.doesNotMatch(text, VENDOR);
});

test('提示词：带席位盲化纪律，且不含任何具体分配或模型名', () => {
    const s = room.state;
    const civ = s.civs[0];
    const snap = snapshotFor(s, 'civ-01');
    const legal = legalActions(s, 'civ-01', config.rules);
    const prompts = [
        monarchSystem(config.rules), monarchUser(snap, civ, legal),
        dmSystem(config.rules), dmUser(snapshotFor(s, null)),
    ].join('\n');
    assert.match(prompts, /席位盲化|不可知/);
    assert.doesNotMatch(prompts, VENDOR);
    assert.doesNotMatch(prompts, /civ-\d+.*(human|ai)|(human|ai).*civ-\d+/i);
});

test('MCP：不提供任何可读取席位分配的工具，且创建房间不回传凭证', () => {
    const src = readFileSync(new URL('../src/mcp/server.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /name:\s*'civ_models'/);
    assert.match(src, /name:\s*'civ_set_seats'/);
    assert.match(src, /凭证只写 stderr|不通过工具结果返回/);
    assert.match(src, /席位盲化（不可协商）/);
});

test('存档导出：不含身份字段、不含模型绑定、不含幂等回执', async () => {
    const save = await call('GET', `${R()}/save`);
    assert.equal(save.status, 200);
    assert.doesNotMatch(save.text, IDENTITY_KEYS);
    assert.doesNotMatch(save.text, VENDOR);
    assert.equal(save.json.requestCache, undefined);
});

test('my-seat 只回答自己，不返回全局分布', async () => {
    const r = await call('GET', `${R()}/my-seat`);
    assert.equal(r.status, 200);
    assert.equal(r.json.seats, undefined);
    assert.equal(r.json.civId, null, 'DM 视角没有个人席位');
});

test('★试玩回归：个性化台词不进编年史，十二国文体一致', async () => {
    app.makeRoom('room-voice', 'voice-seed', true, []);
    const P = '/rooms/room-voice';
    const unique = 'ZQX-PLAYTEST-UNIQUE-MARKER-绝无雷同';
    const snap = await call('GET', `${P}/snapshot`);
    const submit = await call('POST', `${P}/decisions`, {
        stateId: snap.json.snapshot.stateId,
        requestId: 'blind-voice-1',
        decisions: [{ civId: 'civ-02', type: 'research', magnitude: 1, note: unique }],
    });
    assert.equal(submit.status, 200);
    assert.equal(submit.json.accepted.length, 1);
    assert.equal(submit.json.accepted[0].note, unique, '回执把原文还给提交者本人');
    // 同一回合内另一席位并发提交，不应因 stateId 变化而 409
    const parallel = await call('POST', `${P}/decisions`, {
        stateId: snap.json.snapshot.stateId,
        requestId: 'blind-voice-1b',
        decisions: [{ civId: 'civ-03', type: 'research', magnitude: 1, note: '另一席位同时下令' }],
    });
    assert.equal(parallel.status, 200, '同回合多席位并发下令不应互相撞 CAS');

    const adv = await call('POST', `${P}/advance`, { stateId: submit.json.stateId, requestId: 'blind-voice-2' });
    assert.equal(adv.status, 200);
    assert.ok(!adv.json.report.includes(unique));
    const chron = await call('GET', `${P}/chronicle?from=0`);
    assert.ok(!JSON.stringify(chron.json).includes(unique), '编年史不得出现任何席位的个性化原文');
    const decisions = chron.json.entries.filter((e) => e.kind === 'decision');
    assert.equal(decisions.length, 12, '一个回合应有十二国决策');
    const notes = decisions.map((e) => e.text.split('·').pop().trim());
    assert.ok(new Set(notes).size >= 9, `十二国台词不应成组复用，实际唯一 ${new Set(notes).size}`);
    const aliveCivs = (await call('GET', `${P}/snapshot`)).json.snapshot.civs.filter((c) => c.alive).length;
    assert.equal(aliveCivs, 12, '开局两州：首回合不应出现一击亡国');
});
