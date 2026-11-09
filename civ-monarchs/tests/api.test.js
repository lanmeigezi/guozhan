import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/server/loader.js';
import { createApp } from '../src/server/app.js';

const config = loadConfig();
let app, server, base, mcp, room1;

async function call(method, path, body, token = '') {
    const headers = { Accept: 'application/json' };
    if (token && typeof token === 'object') Object.assign(headers, token);
    else if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${base}/api${path}`, {
        method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
    return { ok: r.ok, status: r.status, json, text };
}

function startMcp(env) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/server.js', import.meta.url))], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = readline.createInterface({ input: child.stdout });
    const waiters = [];
    rl.on('line', (line) => {
        let msg; try { msg = JSON.parse(line); } catch { return; }
        const i = waiters.findIndex((w) => w.id === msg.id);
        if (i >= 0) { waiters.splice(i, 1)[0].resolve(msg); }
    });
    child.stderr.on('data', () => { /* 日志不进 stdout */ });
    return {
        request(msg) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`MCP 响应超时：${msg.method}`)), 6000);
                waiters.push({ id: msg.id, resolve: (m) => { clearTimeout(timer); resolve(m); } });
                child.stdin.write(`${JSON.stringify(msg)}\n`);
            });
        },
        close() { child.stdin.end(); child.kill(); rl.close(); },
    };
}

before(async () => {
    app = createApp(config, {});
    room1 = app.makeRoom('room-1', config.world.seed, false, []);
    server = createServer((req, res) => { app.handler(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    mcp = startMcp({ CIV_API_BASE: base, CIV_ROOM_ID: 'room-1' });
});

after(() => {
    mcp?.close();
    app?.close();
    server?.close();
});

test('健康检查与协议协商', async () => {
    const h = await call('GET', '/health');
    assert.equal(h.json.ok, true);
    assert.equal(h.json.rulesId, config.rules.id);
    const p = await call('GET', '/protocol');
    assert.ok(p.json.rejectionCodes.includes('STALE_REVISION'));
    assert.ok(p.json.actions.research);
    assert.ok(p.json.dmEdits.includes('boost'));
    assert.equal(p.json.knobs.dmWeight, config.rules.dm.weight);
});

test('快照 / 布局 / 合法动作形状符合扩展契约', async () => {
    const snap = await call('GET', '/rooms/room-1/snapshot');
    assert.equal(snap.status, 200);
    assert.equal(typeof snap.json.snapshot.stateId, 'string');
    assert.equal(snap.json.snapshot.civs.length, 12);
    const layout = await call('GET', '/rooms/room-1/layout');
    assert.equal(layout.json.layout.regions.length, config.rules.engine.regionCount);
    const acts = await call('GET', '/rooms/room-1/actions?seat=civ-01');
    assert.ok(acts.json.actions.length > 0);
    assert.ok(acts.json.actions.every((a) => a.command?.civId === 'civ-01'));
});

test('CAS：过期 stateId 返回 409 STALE_REVISION', async () => {
    const r = await call('POST', '/rooms/room-1/decisions', { stateId: 'outdated', decisions: [{ civId: 'civ-01', type: 'research', magnitude: 1 }] });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'STALE_REVISION');
});

test('提交意图 → 结算回合 → 幂等重放', async () => {
    const snap = await call('GET', '/rooms/room-1/snapshot');
    const stateId = snap.json.snapshot.stateId;
    const reqId = 'contract-test-1';
    const d = await call('POST', '/rooms/room-1/decisions', { stateId, requestId: reqId, decisions: [{ civId: 'civ-01', type: 'research', magnitude: 1 }] });
    assert.equal(d.status, 200);
    assert.equal(d.json.accepted.length, 1);
    const replay = await call('POST', '/rooms/room-1/decisions', { stateId, requestId: reqId, decisions: [{ civId: 'civ-01', type: 'research', magnitude: 1 }] });
    assert.equal(replay.json.replayed, true);
    const adv = await call('POST', '/rooms/room-1/advance', { stateId: d.json.stateId, requestId: 'contract-test-2' });
    assert.equal(adv.status, 200);
    assert.match(adv.json.report, /第 1 回合/);
    assert.ok(adv.json.stateId);
});

test('DM 修正与拒绝码由服务端给出', async () => {
    const snap = await call('GET', '/rooms/room-1/snapshot');
    const r = await call('POST', '/rooms/room-1/dm', {
        stateId: snap.json.snapshot.stateId,
        requestId: 'contract-test-3',
        edits: [{ type: 'boost', target: 'civ-02', magnitude: 2, note: '史官试笔' }, { type: 'nuke', magnitude: 1 }],
    });
    assert.equal(r.json.accepted.length, 1);
    assert.equal(r.json.rejections[0].code, 'DM_EDIT_NOT_ALLOWED');
});

test('自动推演：非房主回执脱敏；房主才看得到 12 席诊断', async () => {
    const keys = ['CIV_API_KEY', ...Array.from({ length: 12 }, (_, i) => `CIV_MODEL_${String(i + 1).padStart(2, '0')}_KEY`)];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    try {
        const r = await call('POST', '/rooms/room-1/auto', { apply: true, includeDm: false, requestId: 'contract-test-4' });
        assert.equal(r.status, 200);
        assert.equal(r.json.diagnostics, undefined, '诊断不得下发给普通调用者');
        assert.ok(r.json.advanced?.report);
        const asAdmin = await call('POST', '/rooms/room-1/auto', { apply: false, includeDm: false, requestId: 'contract-test-4b' }, { 'X-Admin-Token': room1.adminToken });
        assert.equal(asAdmin.json.admin.diagnostics.length, 12);
        assert.ok(asAdmin.json.admin.diagnostics.every((d) => d.source === 'deterministic'));
    } finally {
        for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
});

test('存档导出与载入校验一致', async () => {
    const save = await call('GET', '/rooms/room-1/save');
    assert.equal(save.status, 200);
    assert.ok(save.json.stateId);
    const load = await call('POST', '/rooms/room-1/load', { save: save.json });
    assert.equal(load.json.ok, true);
});

test('MCP：initialize / tools/list / tools/call 全链路', async () => {
    const init = await mcp.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(init.result.serverInfo.name, 'civ-monarchs');
    assert.match(init.result.instructions, /STALE_REVISION/);

    const list = await mcp.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(list.result.tools.length >= 12);
    assert.ok(list.result.tools.some((t) => t.name === 'civ_advance'));
    assert.ok(!list.result.tools.some((t) => t.name === 'civ_models'), '不得提供可读取席位分配的工具');
    assert.ok(list.result.tools.some((t) => t.name === 'civ_set_seats'), '房主可通过只写工具调整席位');

    const state = await mcp.request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'civ_state', arguments: {} } });
    assert.equal(state.result.isError, undefined);
    const payload = JSON.parse(state.result.content[0].text);
    assert.ok(payload.snapshot.stateId);

    const advance = await mcp.request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'civ_advance', arguments: { stateId: payload.snapshot.stateId, requestId: 'mcp-test-1' } } });
    const result = JSON.parse(advance.result.content[0].text);
    assert.match(result.report, /回合/);
});
