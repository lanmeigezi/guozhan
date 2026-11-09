/** 端到端 smoke：以真实 npm start 入口启动服务，跑一遍完整回合流程。 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const port = 20000 + Math.floor(Math.random() * 15000);
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server/main.js', import.meta.url)), '--port', String(port), '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
let stdout = '';
child.stderr.on('data', (d) => { stderr += String(d); });
child.stdout.on('data', (d) => { stdout += String(d); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealth() {
    for (let i = 0; i < 50; i += 1) {
        try { const r = await fetch(`${base}/api/health`); if (r.ok) return await r.json(); } catch { /* 尚未监听 */ }
        await sleep(200);
    }
    throw new Error(`服务未就绪：${stderr}`);
}
async function api(method, path, body, extraHeaders = {}) {
    const r = await fetch(`${base}/api${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: r.ok, status: r.status, json };
}

try {
    const health = await waitHealth();
    assert.equal(health.ok, true);
    console.log('  ✓ 服务启动 / health');

    const protocol = await api('GET', '/protocol');
    assert.ok(protocol.json.rejectionCodes.includes('STALE_REVISION'));
    console.log('  ✓ 协议协商');

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /群星君主/);
    console.log('  ✓ 自带网页客户端');

    let snap = await api('GET', '/rooms/room-1/snapshot');
    assert.equal(snap.json.snapshot.civs.length, 12);
    const d = await api('POST', '/rooms/room-1/decisions', {
        stateId: snap.json.snapshot.stateId, requestId: `smoke-${port}-1`,
        decisions: [{ civId: 'civ-01', type: 'research', magnitude: 2 }],
    });
    assert.equal(d.json.accepted.length, 1);
    console.log('  ✓ 快照 + 提交君主意图');

    const dm = await api('POST', '/rooms/room-1/dm', {
        stateId: d.json.stateId, requestId: `smoke-${port}-2`,
        edits: [{ type: 'boost', target: 'civ-01', magnitude: 2, note: '史官试笔' }],
    });
    assert.equal(dm.json.accepted.length, 1);
    console.log('  ✓ DM 修正');

    const adv = await api('POST', '/rooms/room-1/advance', { stateId: dm.json.stateId, requestId: `smoke-${port}-3` });
    assert.match(adv.json.report, /第 1 回合/);
    console.log('  ✓ 回合结算与编年史');

    const auto = await api('POST', '/rooms/room-1/auto', { apply: true, includeDm: false, requestId: `smoke-${port}-4` });
    assert.ok(auto.json.advanced?.report);
    assert.equal(auto.json.diagnostics, undefined, '非房主回执必须脱敏');
    console.log('  ✓ 十二国自动推演（回执脱敏）');

    const adminMatch = stdout.match(/adm_[0-9a-f]{32}/);
    assert.ok(adminMatch, '启动日志应打印房间管理令牌');
    const adminHeaders = { 'X-Admin-Token': adminMatch[0] };
    const denied = await api('GET', '/rooms/room-1/seats');
    assert.equal(denied.status, 403, '非房主不得读取席位分配');
    const seatView = await api('GET', '/rooms/room-1/seats', undefined, adminHeaders);
    assert.equal(seatView.json.seats.length, 12);
    assert.ok(seatView.json.seats.every((s) => s.control === 'ai'), '默认 12 席全人机，无需凑人');
    const setSeat = await api('POST', '/rooms/room-1/seats', { seats: [{ civId: 'civ-01', control: 'human' }] }, adminHeaders);
    assert.equal(setSeat.json.applied.length, 1);
    console.log('  ✓ 席位管理（默认全人机 / 房主可设人类席位 / 非房主不可见）');

    const blindSnap = await api('GET', '/rooms/room-1/snapshot');
    const blindText = JSON.stringify(blindSnap.json);
    assert.ok(!blindText.includes('modelLabel') && !blindText.includes('"control"'), '快照不得含席位身份或模型绑定');
    console.log('  ✓ 快照席位盲化');

    const reset = await api('POST', '/rooms/room-1/reset', { requestId: `smoke-${port}-5` });
    const noSubmit = await api('POST', '/rooms/room-1/advance', { stateId: reset.json.snapshot.stateId, requestId: `smoke-${port}-6` });
    assert.equal(noSubmit.status, 200, '不提交任何意图也应能开局（自动补位）');
    assert.match(noSubmit.json.report, /第 1 回合/);
    console.log('  ✓ 缺人开局：12 席自动补位后直接结算');

    const save = await api('GET', '/rooms/room-1/save');
    const load = await api('POST', '/rooms/room-1/load', { save: save.json });
    assert.equal(load.json.ok, true);
    console.log('  ✓ 存档导出 / 载入');

    console.log('\nSMOKE PASS：真实启动 → 协议 → 网页 → 下令 → DM → 结算 → 自动推演 → 席位管理/盲化 → 缺人开局 → 存档 全链路通过');
} finally {
    child.kill('SIGTERM');
}
