/**
 * 零依赖 HTTP + SSE 服务。单一权威状态在服务端，酒馆扩展 / 网页 / MCP 都是同一套 API 的消费者。
 * 沿用上一个包的契约：stateId 做 CAS、requestId 做幂等、拒绝码由服务端给出、表现层不裁决规则。
 *
 * ★席位盲化：control / claimed / driver 只存在于 room 对象，绝不写入 state 或任何对外输出。
 *   只有持有房间级 adminToken（X-Admin-Token 头）的人类房主能看到 /seats 与 /models。
 *   DM（可能是 AI）、君主模型、MCP Harness、SSE 客户端一律拿到脱敏视图。
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createGame, computeStateId, snapshotFor, serialize, restore, pushEvent, eventsSince } from '../core/state.js';
import { REJECTION_CODES, REJECTION_MESSAGES, validateDecisions, validateDmEdits, legalActions } from '../core/commands.js';
import { advanceTurn } from '../core/engine.js';
import { adapterReport } from '../ai/adapter.js';
import { collectDecisions, generateDmEdits } from '../ai/director.js';
import {
    createSeatRegistry, applySeatControls, adminSeatView, selfSeatView,
    ensureDecisions, aiEligibleCivIds, markClaimed, sealDecision,
} from '../core/seats.js';

const MAX_BODY = 1024 * 1024;

function sendJson(res, status, body, extra = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
        ...extra,
    });
    res.end(text);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) { resolve({}); return; }
            try { resolve(JSON.parse(raw)); } catch { reject(new Error('请求体不是合法 JSON')); }
        });
        req.on('error', reject);
    });
}

function remember(room, requestId, reply) {
    if (!requestId || typeof requestId !== 'string') return;
    room.state.requestCache[requestId] = reply;
    const keys = Object.keys(room.state.requestCache);
    if (keys.length > 100) delete room.state.requestCache[keys[0]];
}

export function createApp(config, opts = {}) {
    const { rules, monarchs, world, seats: seatsCfg } = config;
    const rooms = new Map();
    const sseClients = new Set();
    const adminToken = opts.token ?? '';
    const origins = opts.origins ?? [];

    const broadcast = () => {
        for (const client of sseClients) {
            const room = rooms.get(client.roomId);
            if (!room) continue;
            const fresh = eventsSince(room.state, client.lastSent);
            for (const e of fresh) {
                try { client.res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* 断开时由 close 清理 */ }
            }
            if (fresh.length) client.lastSent = fresh[fresh.length - 1].offset + 1;
        }
    };
    const heartbeat = setInterval(() => {
        for (const client of sseClients) {
            try { client.res.write(': ping\n\n'); } catch { /* noop */ }
            broadcast();
        }
    }, 1500);
    heartbeat.unref?.();

    /** @param {{roomId:string, seed?:string, withSeats?:boolean, humanSeats?:string[]}} input */
    function makeRoom(roomId, seed, withSeats = true, humanSeats = []) {
        const state = createGame({ roomId, rules, monarchs, worldCfg: world, seed: seed ?? world.seed });
        const seatTokens = new Map();
        if (withSeats) {
            for (const c of state.civs) seatTokens.set(`st_${randomBytes(12).toString('hex')}`, c.id);
        }
        const room = {
            id: roomId,
            state,
            seatTokens,
            seats: createSeatRegistry(state, seatsCfg, humanSeats?.length ? humanSeats : seatsCfg.humanSeats),
            adminToken: `adm_${randomBytes(16).toString('hex')}`,
            createdAt: Date.now(),
        };
        rooms.set(roomId, room);
        return room;
    }

    function auth(req, url, room) {
        const header = String(req.headers.authorization ?? '');
        const token = header.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('token') ?? '');
        if (adminToken && token === adminToken) return { role: 'dm' };
        if (room?.seatTokens?.has(token)) return { role: 'seat', civId: room.seatTokens.get(token) };
        if (!adminToken) return { role: 'dm' };
        return null;
    }

    /** 房间级管理权限：独立的 X-Admin-Token 头，不与 Bearer 争用 */
    function isAdmin(req, url, room) {
        const given = String(req.headers['x-admin-token'] ?? url.searchParams.get('admin') ?? '');
        return Boolean(room?.adminToken && given && given === room.adminToken);
    }

    function cors(req, res) {
        const origin = String(req.headers.origin ?? '');
        if (origin && origins.length && !origins.includes(origin)) return false;
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '600');
        return true;
    }

    /** wait 策略下有席位未下令：非房主连「有几个」都不给，避免反推席位分布 */
    function waitingReply(res, room, waiting, isAdminCaller, extra = {}) {
        const body = {
            code: 'SEATS_WAITING',
            message: REJECTION_MESSAGES.SEATS_WAITING,
            stateId: computeStateId(room.state),
            ...extra,
        };
        if (isAdminCaller) { body.pending = waiting.length; body.pendingSeats = [...waiting]; }
        sendJson(res, 409, body);
    }

    async function handler(req, res) {
        const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
        const path = url.pathname.replace(/\/+$/, '') || '/';
        if (!cors(req, res)) { sendJson(res, 403, { error: 'ORIGIN_NOT_ALLOWED' }); return; }
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
            const html = readFileSync(new URL('../../web/index.html', import.meta.url));
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(html);
            return;
        }
        if (req.method === 'GET' && path === '/favicon.ico') { res.writeHead(204); res.end(); return; }

        if (path === '/api/health') {
            sendJson(res, 200, {
                ok: true, service: 'civ-monarchs', version: '0.3.0', rooms: rooms.size,
                rulesId: rules.id, auth: adminToken ? 'enabled' : 'open',
                seatBlindness: Boolean(seatsCfg.blindSeats), seatPolicy: seatsCfg.policy,
            });
            return;
        }
        if (path === '/api/protocol') {
            sendJson(res, 200, {
                version: 2,
                rejectionCodes: REJECTION_CODES,
                rejectionMessages: REJECTION_MESSAGES,
                actions: Object.fromEntries(Object.entries(rules.actions.types).map(([k, v]) => [k, { label: v.label, target: v.target, cost: v.cost, requiresEpoch: v.requiresEpoch ?? null }])),
                dmEdits: rules.dm.allowed,
                epochs: rules.epochs,
                knobs: { simulationStrength: rules.simulation.strength, dmWeight: rules.dm.weight },
                seats: {
                    blind: Boolean(seatsCfg.blindSeats),
                    policy: seatsCfg.policy,
                    autoFill: Boolean(seatsCfg.autoFill),
                    note: '每回合十二国皆有举动；任何模型都不可得知、不可推测各国的决策者身份。禁止在输出中讨论或暗示席位由人操作或由程序托管。',
                },
            });
            return;
        }

        const actor = auth(req, url, null);
        if (!actor) { sendJson(res, 401, { error: 'UNAUTHORIZED' }); return; }

        if (path === '/api/rooms' && req.method === 'GET') {
            sendJson(res, 200, { rooms: [...rooms.values()].map((r) => ({ roomId: r.id, turn: r.state.turn, year: r.state.year, phase: r.state.phase, winner: r.state.winner, civCount: r.state.civs.length })) });
            return;
        }
        if (path === '/api/rooms' && req.method === 'POST') {
            const body = await readBody(req).catch(() => ({}));
            const roomId = typeof body.roomId === 'string' && body.roomId ? body.roomId : `room-${randomBytes(3).toString('hex')}`;
            if (rooms.has(roomId)) { sendJson(res, 409, { error: 'ROOM_EXISTS' }); return; }
            const room = makeRoom(roomId, body.seed, body.withSeats !== false, body.humanSeats);
            sendJson(res, 200, {
                roomId,
                snapshot: snapshotFor(room.state, null),
                seatTokens: Object.fromEntries([...room.seatTokens.entries()].map(([t, c]) => [c, t])),
                adminToken: room.adminToken,
                note: 'seatTokens 发给人类玩家（每人一个，只发一次）；adminToken 只给房主，用于 /seats 管理端点，通过 X-Admin-Token 头传递。两者都不落盘、不回显，且不得转发给任何模型。',
            });
            return;
        }

        const match = path.match(/^\/api\/rooms\/([^/]+)(?:\/(.+))?$/);
        if (!match) { sendJson(res, 404, { error: 'NOT_FOUND' }); return; }
        const roomId = decodeURIComponent(match[1]);
        const sub = match[2] ?? '';
        const room = rooms.get(roomId);
        if (!room) { sendJson(res, 404, { error: 'ROOM_NOT_FOUND' }); return; }
        const who = auth(req, url, room);
        if (!who) { sendJson(res, 401, { error: 'UNAUTHORIZED' }); return; }
        const state = room.state;
        const seat = who.role === 'seat' ? who.civId : (url.searchParams.get('seat') || null);
        const admin = isAdmin(req, url, room);

        if (sub === 'events' && req.method === 'GET') {
            const fromParam = url.searchParams.get('from') ?? '0';
            const from = fromParam === 'latest' ? state.eventOffset : (Number(fromParam) || 0);
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            const client = { roomId, res, lastSent: from };
            sseClients.add(client);
            const initial = eventsSince(state, from);
            for (const e of initial) res.write(`data: ${JSON.stringify(e)}\n\n`);
            if (initial.length) client.lastSent = initial[initial.length - 1].offset + 1;
            res.write(': connected\n\n');
            req.on('close', () => sseClients.delete(client));
            return;
        }

        // ── 管理端：席位分配与模型绑定，仅房主可见 ──
        if (sub === 'seats' && req.method === 'GET') {
            if (!admin) { sendJson(res, 403, { code: 'ADMIN_REQUIRED', message: REJECTION_MESSAGES.ADMIN_REQUIRED }); return; }
            sendJson(res, 200, adminSeatView(room.seats, state, monarchs, seatsCfg));
            return;
        }
        if (sub === 'seats' && req.method === 'POST') {
            if (!admin) { sendJson(res, 403, { code: 'ADMIN_REQUIRED', message: REJECTION_MESSAGES.ADMIN_REQUIRED }); return; }
            const body = await readBody(req).catch(() => ({}));
            const result = applySeatControls(room.seats, body.seats, state.civs.map((c) => c.id), seatsCfg.controlValues);
            // ★管理操作不写事件流：席位变更的任何迹象都不该广播给模型客户端
            broadcast();
            sendJson(res, 200, { ...result, seatView: adminSeatView(room.seats, state, monarchs, seatsCfg) });
            return;
        }
        if (sub === 'my-seat' && req.method === 'GET') {
            // 只回答「你自己」，绝不返回全局分布
            sendJson(res, 200, seat ? selfSeatView(room.seats, seat) : { civId: null, note: '当前为 DM 叙事视角，无个人席位' });
            return;
        }
        if (sub === 'models' && req.method === 'GET') {
            if (!admin) { sendJson(res, 403, { code: 'ADMIN_REQUIRED', message: REJECTION_MESSAGES.ADMIN_REQUIRED }); return; }
            sendJson(res, 200, { seats: adapterReport(monarchs.slots, monarchs.defaults, rules), dmConfigured: Boolean(process.env.CIV_DM_MODEL || process.env.CIV_DM_KEY) });
            return;
        }

        if (sub === 'snapshot' && req.method === 'GET') { sendJson(res, 200, { snapshot: snapshotFor(state, seat) }); return; }
        if (sub === 'layout' && req.method === 'GET') { sendJson(res, 200, { layout: state.layout }); return; }
        if (sub === 'actions' && req.method === 'GET') {
            sendJson(res, 200, legalActions(state, seat ?? state.civs[0]?.id, rules));
            return;
        }
        if (sub === 'chronicle' && req.method === 'GET') {
            const from = Number(url.searchParams.get('from') ?? 0) || 0;
            sendJson(res, 200, { entries: state.chronicle.slice(from).map((e) => ({ turn: e.turn, year: e.year, kind: e.kind, text: e.text })) });
            return;
        }
        if (sub === 'report' && req.method === 'GET') { sendJson(res, 200, { report: state.lastReport }); return; }
        if (sub === 'save' && req.method === 'GET') {
            const text = serialize(state); // 已排除 requestCache 与身份字段
            sendJson(res, 200, JSON.parse(text), { 'Content-Disposition': `attachment; filename="${roomId}-save.json"` });
            return;
        }

        // ── 写操作：统一 CAS + 幂等 ──
        if (['decisions', 'dm', 'advance', 'auto', 'load', 'reset'].includes(sub) && req.method === 'POST') {
            let body;
            try { body = await readBody(req); } catch (err) { sendJson(res, 400, { error: 'MALFORMED_PAYLOAD', message: String(err.message) }); return; }
            const requestId = body.requestId;
            if (requestId && state.requestCache[requestId]) {
                sendJson(res, 200, { ...state.requestCache[requestId], replayed: true });
                return;
            }
            if (sub !== 'load' && sub !== 'reset' && sub !== 'auto' && body.stateId !== computeStateId(state)) {
                sendJson(res, 409, { code: 'STALE_REVISION', message: REJECTION_MESSAGES.STALE_REVISION, stateId: computeStateId(state) });
                return;
            }

            if (sub === 'decisions') {
                const decisions = Array.isArray(body.decisions) ? body.decisions : [];
                if (who.role === 'seat' && decisions.some((d) => d?.civId !== who.civId)) {
                    sendJson(res, 403, { code: 'SEAT_NOT_AUTHORIZED', message: REJECTION_MESSAGES.SEAT_NOT_AUTHORIZED }); return;
                }
                const { accepted, rejections } = validateDecisions(state, decisions, rules);
                for (const d of accepted) {
                    state.decisions[d.civId] = sealDecision(state, d);
                    if (who.role === 'seat') markClaimed(room.seats, d.civId);
                }
                // ★事件不带席位名单、不带提交数量：不能从「谁先下令」反推控制者
                pushEvent(state, 'decisions_submitted', {});
                const reply = { accepted, rejections, stateId: computeStateId(state), turn: state.turn };
                remember(room, requestId, reply);
                broadcast();
                sendJson(res, 200, reply);
                return;
            }

            if (sub === 'dm') {
                if (who.role !== 'dm') { sendJson(res, 403, { code: 'SEAT_NOT_AUTHORIZED', message: '只有 DM 席位可以提交修正' }); return; }
                const { accepted, rejections } = validateDmEdits(state, Array.isArray(body.edits) ? body.edits : [], rules);
                state.dmEdits.push(...accepted);
                pushEvent(state, 'dm_edits', { count: accepted.length, types: accepted.map((e) => e.type) });
                const reply = { accepted, rejections, stateId: computeStateId(state), turn: state.turn };
                remember(room, requestId, reply);
                broadcast();
                sendJson(res, 200, reply);
                return;
            }

            if (sub === 'advance') {
                const filled = ensureDecisions({ state, rules, registry: room.seats, seatsCfg });
                if (filled.waiting.length) {
                    // 补位已改动 state.decisions，必须把新 stateId 交还调用方
                    waitingReply(res, room, filled.waiting, admin);
                    return;
                }
                const result = advanceTurn(state, rules);
                const reply = {
                    report: result.report, winner: result.winner, events: result.events.length,
                    stateId: computeStateId(state), turn: state.turn, phase: state.phase,
                };
                remember(room, requestId, reply);
                broadcast();
                sendJson(res, 200, reply);
                return;
            }

            if (sub === 'auto') {
                // 人类席位已提交的意图先摘出来，绝不交给模型覆盖
                const humanDecisions = Object.fromEntries(
                    Object.entries(state.decisions).filter(([id]) => (room.seats[id]?.control ?? 'ai') === 'human'),
                );
                const collected = await collectDecisions(state, rules, monarchs, aiEligibleCivIds(state, room.seats));
                const checked = validateDecisions(state, collected.decisions, rules);
                state.decisions = {};
                for (const d of checked.accepted) state.decisions[d.civId] = sealDecision(state, d);
                for (const [id, d] of Object.entries(humanDecisions)) state.decisions[id] = sealDecision(state, d);

                let dmResult = { edits: [], reason: '未请求 DM 模型' };
                if (body.includeDm) {
                    dmResult = await generateDmEdits(state, rules);
                    const dmChecked = validateDmEdits(state, dmResult.edits, rules);
                    state.dmEdits.push(...dmChecked.accepted);
                    dmResult.rejections = dmChecked.rejections;
                }
                const filled = ensureDecisions({ state, rules, registry: room.seats, seatsCfg });
                if (filled.waiting.length) {
                    waitingReply(res, room, filled.waiting, admin, { advanced: null });
                    return;
                }
                let advanced = null;
                if (body.apply !== false) {
                    const result = advanceTurn(state, rules);
                    advanced = { report: result.report, winner: result.winner, events: result.events.length };
                }
                // ★事件与回执都不带「多少席由模型驱动 / 多少席被补位」等运营指标
                pushEvent(state, 'auto_turn', { applied: Boolean(advanced) });
                const reply = {
                    rejections: checked.rejections,
                    dm: { reason: dmResult.reason, edits: dmResult.edits.length, rejections: dmResult.rejections ?? [] },
                    advanced,
                    stateId: computeStateId(state),
                    turn: state.turn,
                };
                // 幂等缓存只存脱敏主体；管理端诊断不进缓存、不进存档
                remember(room, requestId, reply);
                broadcast();
                sendJson(res, 200, admin ? { ...reply, admin: { diagnostics: collected.diagnostics, seatView: adminSeatView(room.seats, state, monarchs, seatsCfg) } } : reply);
                return;
            }

            if (sub === 'load') {
                try {
                    const next = restore(body.save ?? body, rules);
                    next.roomId = roomId;
                    room.state = next; // seats / tokens / adminToken 属于房间层，载入存档不变
                    broadcast();
                    sendJson(res, 200, { ok: true, stateId: computeStateId(room.state), turn: room.state.turn });
                } catch (err) {
                    sendJson(res, 400, { code: 'SAVE_INVALID', message: String(err.message) });
                }
                return;
            }

            if (sub === 'reset') {
                const seed = typeof body.seed === 'string' ? body.seed : state.seed;
                const newState = createGame({ roomId, rules, monarchs, worldCfg: world, seed });
                room.state = newState;
                broadcast();
                sendJson(res, 200, { ok: true, stateId: computeStateId(room.state), snapshot: snapshotFor(room.state, null) });
                return;
            }
        }

        sendJson(res, 404, { error: 'NOT_FOUND', path });
    }

    return {
        handler,
        rooms,
        makeRoom,
        broadcast,
        close() { clearInterval(heartbeat); for (const c of sseClients) { try { c.res.end(); } catch { /* noop */ } } sseClients.clear(); },
    };
}
