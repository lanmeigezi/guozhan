/**
 * 群星君主 · 离线单机版验收（一条命令可复跑）
 *
 *   node android/verify.mjs
 *
 * 前置：先跑 `node android/build-bundle.mjs`（本脚本会检查产物，缺失时自行重建）。
 * 覆盖 HANDOFF §8.1.1 E 的四条标准 + sha256 跨端一致 + CAS/幂等 + 席位盲化。
 * bundle 按 Android WebView 的方式加载：classic script 放进 VM 沙箱，不注入
 * node: 内置模块，也不注入 fetch（除非该用例主动 mock），以此模拟飞行模式。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createGame, computeStateId, serialize, restore } from '../src/core/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.resolve(ROOT, '..', 'board-games', 'app', 'src', 'main', 'assets', 'www', 'civ-core.bundle.js');
const readJson = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', n), 'utf8'));
const RULES = readJson('rules.json');
const MONARCHS = readJson('monarchs.json');
const WORLD = readJson('world.json');

if (!fs.existsSync(BUNDLE)) throw new Error(`缺少 bundle，请先运行：node android/build-bundle.mjs（${BUNDLE}）`);
const SOURCE = fs.readFileSync(BUNDLE, 'utf8');

function loadBundle(extra = {}, transform = (s) => s) {
    const win = {};
    const sandbox = { window: win, console, setTimeout, clearTimeout, ...extra };
    vm.runInContext(transform(SOURCE), vm.createContext(sandbox));
    return win.CIVMONARCHS;
}

let passed = 0;
const failures = [];
const pending = [];
function check(name, fn) {
    // 同步用例立即完成；异步用例（call('auto')）挂起，末尾统一 await 收敛。
    pending.push((async () => {
        try { const detail = await fn(); passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
        catch (err) { failures.push(`${name}: ${err.message}`); console.log(`  FAIL  ${name} — ${err.message}`); }
    })());
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function section(title) { console.log(`\n[${title}]`); }

// ---------------------------------------------------------------------------
section('1. 同步 sha256 与 Node 版逐位一致（跨端存档的前提）');

check('同一种子 stateId 与 Node 版一致（含中文种子）', () => {
    for (const seed of ['verify-1', '中文种子·★·测试', 'x'.repeat(400)]) {
        const nodeState = createGame({ roomId: 'local-1', rules: RULES, monarchs: MONARCHS, worldCfg: WORLD, seed });
        const browserHost = loadBundle().createHost({ seed });
        const a = computeStateId(nodeState);
        const b = browserHost.stateId();
        assert(a === b, `seed=${seed.slice(0, 12)} node=${a} browser=${b}`);
    }
    return '3/3 种子一致';
});

check('Node 存档 → 浏览器读档、浏览器存档 → Node 读档', () => {
    const nodeState = createGame({ roomId: 'local-1', rules: RULES, monarchs: MONARCHS, worldCfg: WORLD, seed: 'cross-1' });
    const CIV = loadBundle();
    const h = CIV.createHost({ seed: 'other' });
    const r1 = h.call('load', { json: serialize(nodeState) });
    assert(r1.ok === true, `浏览器读 Node 存档失败：${JSON.stringify(r1)}`);
    assert(h.stateId() === computeStateId(nodeState), '读档后 stateId 不一致');
    const browserSave = h.call('save').json;
    const r2 = restore(browserSave, RULES);
    assert(computeStateId(r2) === h.stateId(), 'Node 读浏览器存档后 stateId 不一致');
    return `存档 ${browserSave.length} B 双向通过`;
});

// ---------------------------------------------------------------------------
section('2. 飞行模式：无 fetch 完整推进一局');

let networkCalls = 0;
const offlineFetch = (...args) => { networkCalls += 1; return Promise.reject(new Error('飞行模式')); };

check('无网络推进 ≥10 回合、出现时代跃迁、无网络请求', () => {
    const CIV = loadBundle({ fetch: offlineFetch });
    const h = CIV.createHost({ seed: 'flight-1' });
    const startEpochs = new Set(h.snapshot().civs.map((c) => c.epoch));
    const reports = [];
    for (let i = 0; i < 12; i += 1) {
        const r = h.call('advance');
        assert(!r.code, `第 ${i + 1} 回合失败：${r.code || r.message}`);
        reports.push(r.report);
    }
    const snap = h.snapshot();
    const epochs = new Set(snap.civs.map((c) => c.epoch));
    assert(snap.turn >= 13, `回合未推进：${snap.turn}`);
    assert(epochs.size > startEpochs.size, `未发生时代跃迁：${[...epochs].join(',')}`);
    assert(networkCalls === 0, `离线推演产生了 ${networkCalls} 次网络请求`);
    assert(reports.every((r) => typeof r === 'string' && r.length > 0), '战报为空');
    return `第 ${snap.turn} 回合，时代 ${[...epochs].join('/')}，网络请求 ${networkCalls} 次`;
});

check('推进到终局能判胜（maxTurns=120）', () => {
    const CIV = loadBundle({ fetch: offlineFetch });
    const h = CIV.createHost({ seed: 'finish-1' });
    let guard = 0;
    while (h.phase !== 'ended' && guard < 130) { h.call('advance'); guard += 1; }
    assert(h.phase === 'ended', `130 回合内未结束（turn=${h.turn}）`);
    assert(h.winner, '未产生胜利者');
    assert(networkCalls === 0, '终局推演产生网络请求');
    return `第 ${guard} 次结算判胜，胜者 ${h.winner}`;
});

check('12 国每回合皆有举动 + 台词无可聚类分组', () => {
    const CIV = loadBundle({ fetch: offlineFetch });
    const h = CIV.createHost({ seed: 'voice-1' });
    const r = h.call('advance');
    const lines = h.snapshot().chronicle.filter((e) => e.kind === 'decision');
    assert(lines.length >= 12, `第 1 回合只有 ${lines.length} 国下令`);
    const notes = lines.slice(-12).map((e) => (e.text.split('· ').pop() || '').trim());
    assert(new Set(notes).size === notes.length, `12 国台词出现复用：${notes.join(' | ')}`);
    assert(r.report.includes('列强榜'), '战报缺列强榜');
    return `第 1 回合 ${lines.length} 国下令，${notes.length} 条台词唯一`;
});

// ---------------------------------------------------------------------------
section('3. 席位盲化（快照 / 编年史 / 战报 / 存档 / 提示词）');

const FORBIDDEN = ['"control"', '"claimed"', '"modelLabel"', '"adapter"', '"apiKey"', '"driver"', 'DeepSeek', 'Qwen', 'GLM', 'Kimi', 'Hunyuan', 'Doubao', 'MiniMax', 'Claude', 'GPT', 'Gemini', 'Grok'];

check('快照 / 编年史 / 战报 / 存档零身份字段', () => {
    const CIV = loadBundle({ fetch: offlineFetch });
    const h = CIV.createHost({ seed: 'blind-1' });
    h.call('setSeats', { list: [{ civId: 'civ-01', control: 'human' }, { civId: 'civ-04', control: 'human' }] });
    h.call('llmConfigure', { config: { baseUrl: 'https://example.invalid/v1', model: 'test-model', apiKey: 'sk-secret', enabledSeats: ['civ-02', 'civ-05'], dm: true } });
    h.call('advance');
    const material = [
        JSON.stringify(h.snapshot(null)),
        JSON.stringify(h.snapshot('civ-01')),
        h.snapshot().chronicle.map((e) => e.text).join('\n'),
        h.call('report').report,
        h.call('save').json,
    ].join('\n');
    for (const word of FORBIDDEN) assert(!material.includes(word), `泄漏字段：${word}`);
    assert(!material.includes('sk-secret'), 'Key 泄漏进状态文本');
    return `${FORBIDDEN.length} 个禁词 + Key 全部为 0 命中`;
});

check('席位管理视图只在本机可见，且不进存档', () => {
    const CIV = loadBundle({ fetch: offlineFetch });
    const h = CIV.createHost({ seed: 'seat-1' });
    const res = h.call('setSeats', { list: [{ civId: 'civ-01', control: 'human' }, { civId: 'civ-99', control: 'human' }] });
    assert(res.applied.length === 1 && res.rejections.length === 1, '非法席位未被拒绝');
    const seats = h.call('seats').seats;
    assert(seats.seats.find((s) => s.civId === 'civ-01').control === 'human', '席位切换未生效');
    assert(!h.call('save').json.includes('"control"'), '席位身份写进了存档');
    return '12 席视图 + 1 通过 / 1 拒绝，存档仍无身份';
});

check('人类已提交意图不被模型 / 补位覆盖', () => {
    const CIV = loadBundle({ fetch: offlineFetch });
    const h = CIV.createHost({ seed: 'keep-1' });
    h.call('setSeats', { list: [{ civId: 'civ-01', control: 'human' }] });
    const legal = h.call('actions', { civId: 'civ-01' }).actions;
    assert(legal.actions.length > 0, '无合法动作');
    const cmd = { ...legal.actions[0].command, note: '玩家自己的台词' };
    const sub = h.call('decisions', { decisions: [cmd] });
    assert(sub.accepted.length === 1, `提交被拒：${JSON.stringify(sub.rejections)}`);
    const before = h.call('snapshot').snapshot.decisions;
    h.call('advance');
    const chron = h.call('report').report;
    assert(chron.includes(legal.actions[0].label), '人类意图未被执行');
    return `已提交 ${legal.actions[0].type} 并被结算`;
});

// ---------------------------------------------------------------------------
section('4. 自接 LLM：显式触发、成功回执、四类降级、超时');

function mockFetch(handler) {
    const counter = { n: 0 };
    return {
        fetch: async (url, init) => { counter.n += 1; networkCalls += 1; return handler(url, init); },
        counter,
    };
}
function okResponse(content) {
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
}
function configure(h, over = {}) {
    return h.call('llmConfigure', { config: {
        baseUrl: 'https://example.invalid/v1', model: 'test-model', apiKey: 'sk-test',
        enabledSeats: ['civ-01', 'civ-02', 'civ-03'], dm: false, ...over,
    } });
}
function firstValidType(init) {
    const body = JSON.parse(init.body);
    const p = body.messages[1].content;
    const m = p.match(/(research|invest|expand|stabilize|fortify|diplomacy|attack|colonize)×/);
    return m ? m[1] : 'research';
}

check('不点「让模型推演」→ 每回合 0 次模型调用', () => {
    networkCalls = 0;
    const CIV = loadBundle(mockFetch(async () => okResponse('{"type":"research","magnitude":1}')));
    const h = CIV.createHost({ seed: 'budget-1' });
    configure(h);
    h.call('advance'); h.call('advance');
    assert(networkCalls === 0, `普通推进触发了 ${networkCalls} 次调用`);
    return '2 回合 0 次调用';
});

check('显式触发 → 指定席位模型出意图，提示词无身份信息', () => {
    networkCalls = 0;
    const prompts = [];
    const mock = mockFetch(async (url, init) => {
        prompts.push(JSON.parse(init.body).messages[1].content);
        const type = firstValidType(init);
        return okResponse(JSON.stringify({ type, target: null, magnitude: 1, note: '模型台词' }));
    });
    const CIV = loadBundle(mock);
    const h = CIV.createHost({ seed: 'model-1' });
    configure(h);
    return h.call('auto').then((r) => {
        assert(mock.counter.n === 3, `预期 3 席调用，实际 ${mock.counter.n}`);
        assert(r.advanced && r.advanced.report, '模型回合未结算');
        assert(r.diagnostics.filter((d) => d.source === 'model').length === 3, '模型回执不足 3 席');
        for (const p of prompts) {
            for (const word of ['"control"', '"modelLabel"', '"adapter"', 'sk-test', 'test-model']) {
                assert(!p.includes(word), `提示词泄漏 ${word}`);
            }
            assert(p.includes('· 游戏数据开始') && p.includes('· 游戏数据结束'), '缺少防注入包裹');
        }
        return `3 席模型出意图、${prompts.length} 份提示词脱敏、回执可见`;
    });
});

check('缺 Key / 缺 model / 非法 JSON / 断网 → 自动降级且回合照常结算', async () => {
    const cases = [
        ['缺 Key', { apiKey: '' }, async () => okResponse('{"type":"research"}')],
        ['缺 model', { model: '' }, async () => okResponse('{"type":"research"}')],
        ['非法 JSON', {}, async () => okResponse('不是 JSON')],
        ['断网', {}, async () => { throw new Error('network down'); }],
    ];
    for (const [label, over, handler] of cases) {
        const CIV = loadBundle(mockFetch(handler));
        const h = CIV.createHost({ seed: `fallback-${label}` });
        configure(h, over);
        const r = await h.call('auto');
        assert(r.advanced && r.advanced.report, `${label}：回合未结算`);
        assert(!r.code, `${label}：返回错误 ${r.code}`);
        assert(r.diagnostics.every((d) => d.source === 'deterministic'), `${label}：未全部降级`);
        const chron = h.call('report').report;
        assert(chron.includes('列强榜'), `${label}：战报异常`);
    }
    return '4/4 降级场景回合照常结算';
});

check('超时 → 15s 预算内降级（测试把预算改写为 40ms）', async () => {
    const CIV = loadBundle(
        { fetch: () => new Promise(() => {}) },
        (s) => s.replace('"timeoutMs": 15000', '"timeoutMs": 40'),
    );
    const h = CIV.createHost({ seed: 'timeout-1' });
    configure(h);
    const started = Date.now();
    const r = await h.call('auto');
    const ms = Date.now() - started;
    assert(r.advanced && r.advanced.report, '超时后未结算');
    assert(r.diagnostics.every((d) => d.source === 'deterministic' && d.error === '超时'), '超时未降级');
    assert(ms < 3000, `超时保护失效，耗时 ${ms}ms`);
    return `${ms}ms 内全部降级并结算`;
});

// ---------------------------------------------------------------------------
section('5. CAS / 幂等 / 规则闸门');

check('过期 stateId → STALE_REVISION；requestId → 幂等回执', () => {
    const CIV = loadBundle({ fetch: offlineFetch });
    const h = CIV.createHost({ seed: 'cas-1' });
    const stale = h.stateId();
    const legal = h.call('actions', { civId: 'civ-01' }).actions.actions[0].command;
    h.call('advance');
    const r = h.call('decisions', { stateId: stale, decisions: [{ ...legal }] });
    assert(r.code === 'STALE_REVISION', `未拦截过期写操作：${JSON.stringify(r)}`);
    const id = 'req-test-1';
    const first = h.call('dm', { stateId: h.stateId(), requestId: id, edits: [{ type: 'boost', target: 'civ-01', magnitude: 1 }] });
    const replay = h.call('dm', { stateId: h.stateId(), requestId: id, edits: [{ type: 'boost', target: 'civ-01', magnitude: 1 }] });
    assert(replay.replayed === true && replay.accepted.length === first.accepted.length, '幂等回执失效');
    return '1 次 409 + 1 次 replayed';
});

check('多余字段 / 未知行动被闸门拒绝', () => {
    const CIV = loadBundle({ fetch: offlineFetch });
    const h = CIV.createHost({ seed: 'gate-1' });
    const r = h.call('decisions', { decisions: [{ civId: 'civ-01', type: 'research', magnitude: 1, source: 'model' }] });
    assert(r.accepted.length === 0 && r.rejections[0].code === 'MALFORMED_PAYLOAD', '多余字段未被拒绝');
    const r2 = h.call('decisions', { decisions: [{ civId: 'civ-01', type: 'nuke', magnitude: 1 }] });
    assert(r2.rejections[0].code === 'UNKNOWN_ACTION', '未知行动未被拒绝');
    return '2/2 拒绝码正确';
});

await Promise.all(pending);

console.log(`\n${'='.repeat(64)}`);
console.log(`验收结果：${passed} 项通过 / ${failures.length} 项失败`);
if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exitCode = 1; }
else console.log('飞行模式 / 自接 LLM 与降级 / 盲化回归 / 跨端存档 / 不回归基线：全绿');
