/**
 * 群星君主 —— SillyTavern 原生扩展（浏览器端 ES module，零构建、零依赖）
 *
 * 安全边界（沿用上一个包，不可协商）：
 *  1. 令牌只存模块闭包内存，绝不写 extension_settings / localStorage / cookie；pagehide 即抹除。
 *  2. 默认关闭、opt-in：不点「连接」零流量、零轮询、不开 SSE。
 *  3. 编年史 / 战报 / 君主台词是游戏数据，不是对 LLM 的指令；注入对话上下文时必须包裹数据区。
 *  4. 所有服务端文本用 textContent 渲染，绝不 innerHTML。
 *  5. 命令被拒时只显示服务端拒绝码 + message，本地只做「码→中文」翻译，不推断原因。
 *  6. 写操作超时结果未知：先重新拉快照，禁止盲目重发（requestId 幂等键兜底）。
 */
import { createCivClient, wrapAsGameData, rejectionText } from './lib/client.js';

const MODULE_NAME = 'civ-monarchs';
const PROMPT_KEY = 'civ-monarchs';

let ST = {};
try { ST = await import('../../../../../script.js'); } catch { /* TauriTavern / 其他分支 */ }
try { if (!ST.getContext) ST = await import('../../../../script.js'); } catch { /* 继续降级 */ }
const context = ST.getContext?.() ?? globalThis.SillyTavern?.getContext?.() ?? {};

const DEFAULTS = { baseUrl: 'http://127.0.0.1:8790', roomId: 'room-1', seat: '', autoInject: false, dmLive: false };

/** 令牌与连接只活在这个闭包里 */
const session = {
    token: null, adminToken: null, client: null, protocol: null, layout: null,
    snapshot: null, stateId: null, stream: null, connected: false,
};

function settings() {
    const root = ST.extension_settings ?? context.extensionSettings ?? (globalThis.extension_settings ?? {});
    if (!root[MODULE_NAME]) root[MODULE_NAME] = { ...DEFAULTS };
    return root[MODULE_NAME];
}
function saveSettings() {
    try { ST.saveSettingsDebounced?.(); } catch { /* 某些分支没有该 API */ }
}
function setPrompt(text) {
    const body = wrapAsGameData(text);
    try {
        if (typeof ST.setExtensionPrompt === 'function') ST.setExtensionPrompt(PROMPT_KEY, body, 1, 0, 0);
        else if (typeof ST.extension_prompt === 'function') ST.extension_prompt(PROMPT_KEY, body);
        else if (typeof context.setExtensionPrompt === 'function') context.setExtensionPrompt(PROMPT_KEY, body, 1, 0, 0);
        else console.warn('[civ-monarchs] 当前酒馆版本缺少扩展提示词 API，战报未注入');
    } catch (err) { console.warn('[civ-monarchs] 注入失败', err); }
}
function clearPrompt() {
    try { ST.setExtensionPrompt?.(PROMPT_KEY, '', 1, 0, 0); } catch { /* noop */ }
}

const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'text') node.textContent = String(v ?? '');
        else if (k === 'class') node.className = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null) node.setAttribute(k, String(v));
    }
    for (const c of children) node.append(c);
    return node;
};
const $ = (id) => document.getElementById(id);
const log = (text) => {
    const box = $('civm-log');
    if (!box) return;
    box.append(el('div', { class: 'civm-log-line', text: `[${new Date().toLocaleTimeString()}] ${text}` }));
    box.scrollTop = box.scrollHeight;
    while (box.childElementCount > 120) box.firstChild.remove();
};
const rid = () => `civm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

function showRejections(rejections, code, message) {
    const list = rejections?.length ? rejections : (code ? [{ code, message }] : []);
    for (const r of list) log(`拒绝 ${r.code ?? ''}：${rejectionText(r.code, r.message, session.protocol)}`);
    if (!list.length) log('提交成功');
}

function renderMap(snap) {
    const holder = $('civm-map');
    if (!holder || !session.layout) return;
    holder.replaceChildren();
    const byId = new Map(snap.regions.map((r) => [r.id, r]));
    const civById = new Map(snap.civs.map((c) => [c.id, c]));
    const grid = el('div', { class: 'civm-grid' });
    grid.style.gridTemplateColumns = `repeat(${session.layout.cols}, 1fr)`;
    for (const cell of session.layout.regions) {
        const r = byId.get(cell.id);
        const owner = r?.owner ? civById.get(r.owner) : null;
        const box = el('div', {
            class: 'civm-cell',
            title: `${cell.name}｜${cell.terrainName ?? ''}｜${owner?.name ?? '无主'}｜发展 ${r?.development ?? 0}`,
            text: `${cell.name.slice(0, 2)}${owner ? '·' + owner.name.slice(0, 1) : ''}`,
        });
        box.style.background = owner?.color ?? (snap.perspective === 'dm' ? '#26303b' : '#2a3038');
        grid.append(box);
    }
    holder.append(grid);
}

function renderRanks(snap) {
    const holder = $('civm-ranks');
    if (!holder) return;
    holder.replaceChildren();
    const sorted = [...snap.civs].sort((a, b) => (b.score ?? b.scoreTier ?? 0) - (a.score ?? a.scoreTier ?? 0));
    for (const c of sorted) {
        const right = c.visibility === 'full'
            ? `科技 ${Math.round(c.tech)}｜${c.epoch}｜殖民 ${c.colonies}｜分 ${c.score}`
            : `时代 ${c.epoch}｜科技档 ${c.techTier}｜实力档 ${c.powerTier}`;
        const row = el('div', { class: 'civm-rank' }, [
            el('span', { class: 'civm-dot' }),
            el('span', { class: 'civm-rank-name', text: `${c.name} · ${c.monarch ?? ''}${c.alive ? '' : '（已亡）'}` }),
            el('span', { class: 'civm-rank-val', text: right }),
        ]);
        row.firstChild.style.background = c.color ?? '#667';
        holder.append(row);
    }
}

function renderChronicle(snap) {
    const holder = $('civm-chronicle');
    if (!holder) return;
    holder.replaceChildren();
    for (const e of snap.chronicle.slice(-24)) holder.append(el('div', { class: 'civm-chron-line', text: `${e.year} 年｜${e.text}` }));
    holder.scrollTop = holder.scrollHeight;
}

function renderAll(snap) {
    session.snapshot = snap;
    session.stateId = snap.stateId;
    $('civm-status').textContent = `第 ${snap.turn} 回合 · ${snap.year} 年 · ${snap.phase === 'ended' ? '已结束' : '提交中'}｜视角 ${snap.perspective === 'dm' ? 'DM 全知' : snap.perspective}｜${snap.winner ? `胜者 ${snap.winner}` : ''}`;
    renderMap(snap);
    renderRanks(snap);
    renderChronicle(snap);
    session._fillSeats?.(snap);
}

async function refresh(quiet = false) {
    if (!session.client) return;
    try {
        const snap = await session.client.snapshot(settings().seat || undefined);
        renderAll(snap);
        if (!quiet) log('快照已刷新');
    } catch (err) { log(`刷新失败：${err.message}`); }
}

async function refreshActions() {
    const seat = $('civm-seat-select')?.value || settings().seat;
    if (!seat || !session.client) return;
    try {
        const data = await session.client.actions(seat);
        const select = $('civm-action-select');
        select.replaceChildren();
        if (!data.actions?.length) select.append(el('option', { value: '', text: '（本回合无可执行动作）' }));
        for (const a of data.actions) {
            select.append(el('option', { value: String(JSON.stringify(a.command)), text: `${a.label} ${a.targetName ?? ''} ×${a.magnitude}` }));
        }
        log(`已载入 ${data.actions?.length ?? 0} 条合法动作（服务端生成，扩展不自己拼命令）`);
    } catch (err) { log(`动作载入失败：${err.message}`); }
}

async function connect() {
    const s = settings();
    const baseUrl = $('civm-base').value.trim();
    const roomId = $('civm-room').value.trim();
    const token = $('civm-token').value.trim();
    const admin = $('civm-admin')?.value.trim() ?? '';
    const seat = $('civm-seat').value.trim();
    if (!baseUrl || !roomId) { log('请填写服务器地址与房间 ID'); return; }
    s.baseUrl = baseUrl; s.roomId = roomId; s.seat = seat;
    saveSettings();
    session.token = token || null;
    session.adminToken = admin || null;
    $('civm-token').value = '';
    $('civm-token').placeholder = token ? '令牌已载入内存（不会保存）' : 'Bearer 令牌（可选，本机可不填）';
    if ($('civm-admin')) {
        $('civm-admin').value = '';
        $('civm-admin').placeholder = admin ? '管理令牌已载入内存（不会保存）' : '房主管理令牌（可选，仅人类可见）';
    }
    session.client = createCivClient({ baseUrl, roomId, token: session.token, adminToken: session.adminToken });
    try {
        session.protocol = await session.client.protocol();
        session.layout = await session.client.layout();
        await refresh(true);
        await refreshActions();
        session.stream = session.client.events({
            from: 'latest',
            onEvent(ev) {
                if (ev.type === 'turn_resolved') {
                    log(`第 ${ev.turn} 回合结算完成${ev.winner ? `，胜者 ${ev.winner}` : ''}`);
                    void refresh(true);
                    if (settings().autoInject && ev.report) setPrompt(ev.report);
                } else if (ev.type === 'chronicle') log(ev.text ?? ev.type);
                else log(`事件：${ev.type}`);
            },
            onError() { log('事件流断开（浏览器会在可用时自动重连）'); },
        });
        session.connected = true;
        $('civm-connect-btn').textContent = '断开';
        log('已连接；协议与地图布局由服务端运行时提供');
    } catch (err) {
        log(`连接失败：${err.message}`);
        disconnect();
    }
}

function disconnect() {
    try { session.stream?.close(); } catch { /* noop */ }
    session.stream = null; session.client = null; session.connected = false;
    session.token = null; session.adminToken = null; session.snapshot = null; session.stateId = null;
    const btn = $('civm-connect-btn');
    if (btn) btn.textContent = '连接';
    clearPrompt();
    log('已断开，内存令牌已抹除');
}

async function onWrite(fn, label) {
    if (!session.client || !session.stateId) { log('尚未连接或没有 stateId，请先连接/刷新'); return; }
    try {
        const resp = await fn(session.stateId, rid());
        if (resp.status === 409 && resp.json?.code === 'STALE_REVISION') {
            log('局面已变化：按纪律重新拉快照，不盲目重发');
            await refresh(true);
            return;
        }
        showRejections(resp.json?.rejections, resp.json?.code, resp.json?.message);
        await refresh(true);
        await refreshActions();
        if (label === 'advance' && resp.json?.report) log(resp.json.report.split('\n').slice(0, 6).join(' / '));
        if (label === 'auto' && resp.json?.advanced?.report) {
            log('自动推演完成：十二国本回合意图已结算（席位身份不下发）');
            log(resp.json.advanced.report.split('\n').slice(0, 6).join(' / '));
        }
    } catch (err) { log(`${label} 失败：${err.message}`); }
}

/** 房主专用：席位分配视图只在这个 DOM 里出现，绝不注入酒馆上下文 */
async function loadSeats() {
    if (!session.client) { log('尚未连接'); return; }
    if (!session.adminToken) { log('需要房主管理令牌才能读取席位分配'); return; }
    try {
        const view = await session.client.seats();
        const holder = $('civm-seat-admin');
        holder.replaceChildren();
        for (const s of view.seats) {
            const sel = el('select', { 'data-civ': s.civId }, [
                el('option', { value: 'ai', text: '人机' }),
                el('option', { value: 'human', text: '人类' }),
            ]);
            sel.value = s.control;
            holder.append(el('div', { class: 'civm-row' }, [
                el('span', { class: 'civm-rank-name', text: `${s.name} · ${s.monarch}` }),
                sel,
                el('span', { text: s.claimed ? '已认领' : '未认领' }),
            ]));
        }
        log(`已读取 ${view.seats.length} 席（仅房主可见，勿粘贴给模型）｜未下令策略 ${view.policy}`);
    } catch (err) { log(`读取席位失败：${err.message}`); }
}

async function applySeats() {
    const holder = $('civm-seat-admin');
    if (!holder || !session.client) return;
    const seats = [...holder.querySelectorAll('select[data-civ]')].map((s) => ({ civId: s.getAttribute('data-civ'), control: s.value }));
    if (!seats.length) { log('请先点「读取席位」'); return; }
    try {
        const r = await session.client.setSeats(seats);
        if (!r.ok) { log(`应用失败 HTTP ${r.status}`); return; }
        log(`已应用 ${r.json?.applied?.length ?? 0} 项设置；分配信息不会进入任何模型上下文`);
    } catch (err) { log(`应用失败：${err.message}`); }
}

async function showMySeat() {
    if (!session.client) return;
    try {
        const r = await session.client.mySeat();
        log(`本席位：${r.civId ?? 'DM 叙事视角'}｜${r.control ?? '—'}${r.claimed ? '（已认领）' : ''}`);
    } catch (err) { log(`读取本席位失败：${err.message}`); }
}

function buildUI() {
    const s = settings();
    const anchor = $('extensions_settings2') ?? document.body;

    const settingsBox = el('div', { class: 'civm-settings', id: 'civm-settings' }, [
        el('h4', { text: '群星君主 · 文明推演' }),
        el('label', { text: '服务器地址' }),
        el('input', { id: 'civm-base', type: 'text', value: s.baseUrl, placeholder: 'http://127.0.0.1:8790' }),
        el('label', { text: '房间 ID' }),
        el('input', { id: 'civm-room', type: 'text', value: s.roomId }),
        el('label', { text: 'Bearer 令牌（只存内存）' }),
        el('input', { id: 'civm-token', type: 'password', placeholder: '本机可不填；服务端设了 CIV_TOKEN 时必填' }),
        el('label', { text: '房主管理令牌（可选，只存内存）' }),
        el('input', { id: 'civm-admin', type: 'password', placeholder: '用于席位管理；切勿写入角色卡、世界书或提示词' }),
        el('label', { text: '扮演席位（留空 = DM 全知；填 seat token 即人类席位）' }),
        el('input', { id: 'civm-seat', type: 'text', value: s.seat, placeholder: 'civ-01' }),
        el('div', { class: 'civm-row' }, [
            el('button', { id: 'civm-connect-btn', class: 'menu_button', text: '连接', onclick: () => (session.connected ? disconnect() : connect()) }),
            el('label', { class: 'civm-check' }, [
                Object.assign(el('input', { id: 'civm-autoinject', type: 'checkbox' }), { checked: s.autoInject }),
                document.createTextNode(' 结算后自动把战报注入对话上下文'),
            ]),
        ]),
        el('small', { text: '安全：默认关闭、opt-in；令牌不落盘；注入内容带「游戏数据」包裹，防提示注入。' }),
    ]);
    anchor.append(settingsBox);
    $('civm-autoinject')?.addEventListener('change', (e) => { settings().autoInject = e.target.checked; saveSettings(); });

    const toggle = el('button', { id: 'civm-toggle', class: 'civm-toggle', text: '群星君主', onclick: () => $('civm-panel')?.classList.toggle('civm-hidden') });
    document.body.append(toggle);

    const panel = el('div', { id: 'civm-panel', class: 'civm-panel civm-hidden' }, [
        el('div', { class: 'civm-head' }, [
            el('strong', { text: '群星君主 · 12 君主星际推演' }),
            el('span', { id: 'civm-status', class: 'civm-status', text: '未连接' }),
        ]),
        el('div', { class: 'civm-section-title', text: '星球政区' }),
        el('div', { id: 'civm-map', class: 'civm-map' }),
        el('div', { class: 'civm-section-title', text: '列强榜' }),
        el('div', { id: 'civm-ranks', class: 'civm-ranks' }),
        el('div', { class: 'civm-section-title', text: '君主下令' }),
        el('div', { class: 'civm-row' }, [
            el('select', { id: 'civm-seat-select' }),
            el('select', { id: 'civm-action-select' }),
        ]),
        el('div', { class: 'civm-row' }, [
            el('button', { class: 'menu_button', text: '提交意图', onclick: () => {
                const raw = $('civm-action-select')?.value;
                if (!raw) { log('没有可提交的动作'); return; }
                void onWrite((stateId, requestId) => session.client.submitDecisions([JSON.parse(raw)], stateId, requestId), 'decisions');
            } }),
            el('button', { class: 'menu_button', text: '刷新动作', onclick: () => void refreshActions() }),
        ]),
        el('div', { class: 'civm-section-title', text: 'DM 修正（权重由 rules.json 控制）' }),
        el('div', { class: 'civm-row' }, [
            el('select', { id: 'civm-dm-type' }),
            el('select', { id: 'civm-dm-target' }),
            el('select', { id: 'civm-dm-mag' }, [1, 2, 3].map((n) => el('option', { value: String(n), text: `×${n}` }))),
        ]),
        el('div', { class: 'civm-row' }, [
            el('button', { class: 'menu_button', text: '提交修正', onclick: () => {
                const edit = { type: $('civm-dm-type').value, target: $('civm-dm-target').value || null, magnitude: Number($('civm-dm-mag').value), note: '' };
                void onWrite((stateId, requestId) => session.client.submitDmEdits([edit], stateId, requestId), 'dm');
            } }),
            el('button', { class: 'menu_button', text: '结算一回合', onclick: () => void onWrite((stateId, requestId) => session.client.advance(stateId, requestId), 'advance') }),
            el('button', { class: 'menu_button', text: '十二国自动推演', onclick: () => void onWrite((_stateId, requestId) => session.client.autoTurn({ apply: true, includeDm: false }), 'auto') }),
        ]),
        el('div', { class: 'civm-row' }, [
            el('button', { class: 'menu_button', text: '注入战报到上下文', onclick: async () => {
                if (!session.client) { log('尚未连接'); return; }
                setPrompt((await session.client.report()) || session.snapshot?.chronicle?.slice(-8).map((e) => e.text).join('\n') || '');
                log('已注入（带游戏数据包裹）');
            } }),
            el('button', { class: 'menu_button', text: '刷新快照', onclick: () => void refresh() }),
            el('button', { class: 'menu_button', text: '导出存档', onclick: async () => {
                if (!session.client) return;
                const save = await session.client.save();
                const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
                const a = el('a', { href: URL.createObjectURL(blob), download: `${SESSION_ROOM()}-save.json` });
                a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
                log('存档已导出');
            } }),
        ]),
        el('div', { class: 'civm-section-title', text: '房主 · 席位管理（仅人类可见）' }),
        el('div', { class: 'civm-row' }, [
            el('button', { class: 'menu_button', text: '读取席位', onclick: () => void loadSeats() }),
            el('button', { class: 'menu_button', text: '应用设置', onclick: () => void applySeats() }),
            el('button', { class: 'menu_button', text: '本席位', onclick: () => void showMySeat() }),
        ]),
        el('div', { id: 'civm-seat-admin' }),
        el('small', { text: '★席位分配对任何模型不可见。缺人时保持「人机」即可开局；人类玩家用 seat token 连接。切勿把此视图内容粘贴到角色卡、世界书、提示词或对话上下文。' }),
        el('div', { class: 'civm-section-title', text: '编年史' }),
        el('div', { id: 'civm-chronicle', class: 'civm-chronicle' }),
        el('div', { class: 'civm-section-title', text: '运行日志' }),
        el('div', { id: 'civm-log', class: 'civm-log' }),
    ]);
    document.body.append(panel);

    const seatSelect = $('civm-seat-select');
    const dmType = $('civm-dm-type');
    const dmTarget = $('civm-dm-target');
    // 选项在连接后由服务端协议/快照填充
    session._fillSeats = (snap) => {
        seatSelect.replaceChildren();
        for (const c of snap.civs) seatSelect.append(el('option', { value: c.id, text: `${c.name} · ${c.monarch ?? c.id}` }));
        if (settings().seat) seatSelect.value = settings().seat;
        dmTarget.replaceChildren(el('option', { value: '', text: '（全体 / 无目标）' }));
        for (const c of snap.civs) dmTarget.append(el('option', { value: c.id, text: c.name }));
        dmType.replaceChildren();
        for (const t of session.protocol?.dmEdits ?? []) dmType.append(el('option', { value: t, text: t }));
    };
    seatSelect.addEventListener('change', () => void refreshActions());
}

function SESSION_ROOM() { return settings().roomId || 'civ-save'; }

function boot() {
    buildUI();
    window.addEventListener('pagehide', () => { disconnect(); });
    log('扩展已载入。填好连接信息后点「连接」；未连接时零流量。');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
