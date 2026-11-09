#!/usr/bin/env node
/**
 * 端到端冒烟：启动**编译后的** dist/main.js，用纯 HTTP 走完一整个回合。
 *
 * 它验证的是"打包产物能跑"，不只是"源码能跑"：
 *   建房间 → 认领席位 → 读快照 → 提交命令 → 锁定 → AI 席位启发式自动行动
 *   → 回合推进 → 战报落库 → 事件可回放（HTTP）→ WebSocket 补发也拿到同一份事件
 *
 * 跑法：npm run build && node scripts/smoke.mjs
 * 退出码 0 = 全通；任何一步不符即非 0（可直接进 CI / 部署前检查）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const PORT = Number(process.env.SMOKE_PORT ?? '8899');
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'smoke-admin-token-0123456789';
const dataDir = mkdtempSync(join(tmpdir(), 'guozhan-smoke-'));

const fail = (msg) => {
  console.error(`\n[smoke] 失败：${msg}`);
  child?.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
  process.exit(1);
};

const child = spawn(process.execPath, ['--enable-source-maps', 'dist/main.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    GUOZHAN_TOKEN: ADMIN,
    GUOZHAN_ORIGINS: 'http://127.0.0.1:8000',
    GUOZHAN_DATA_DIR: dataDir,
    GUOZHAN_CONFIG_ROOT: 'config',
    LLM_API_KEY: '', // 无 LLM：AI 席位必须走启发式，且不能因此卡住回合
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, { token, body } = {}) {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: resp.status, json, text };
}

let roomId;

try {
  // ① 等服务起来
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) fail(`服务提前退出（code=${child.exitCode}）`);
    try {
      const r = await req('GET', '/health');
      if (r.status === 200 && r.json?.status === 'ok') {
        healthy = true;
        break;
      }
    } catch {}
    await sleep(100);
  }
  if (!healthy) fail('10 秒内 /health 未就绪');
  console.log('[smoke] ① 服务就绪');

  // ② 建房间：只有 qin 是人类，其余是 AI（majorAi 走启发式，因为没配 LLM）
  const created = await req('POST', '/api/rooms', {
    token: ADMIN,
    body: { name: '冒烟局', scenarioId: 'warring-states', rootSeed: 'smoke-seed', humanFactions: ['qin'] },
  });
  if (created.status !== 201) fail(`建房间失败 HTTP ${created.status} ${created.text.slice(0, 200)}`);
  roomId = created.json.room.roomId;
  const turn1Digest = created.json.room.stateDigest;
  if (created.json.room.seats.length !== 7) fail(`席位应为 7，实际 ${created.json.room.seats.length}`);
  console.log(`[smoke] ② 房间 ${roomId} 已建，7 席位`);

  // ③ 认领席位
  const joined = await req('POST', `/api/rooms/${roomId}/join`, { token: ADMIN, body: { seatId: 'seat_qin' } });
  if (joined.status !== 200) fail(`认领失败 HTTP ${joined.status} ${joined.text.slice(0, 200)}`);
  const seatToken = joined.json.token;
  if (typeof seatToken !== 'string' || seatToken.length < 16) fail('席位令牌缺失');
  console.log('[smoke] ③ 席位已认领');

  // ④ 快照：己方精确值 + 合法动作空间 + 拓扑地图
  const snap = await req('GET', `/api/rooms/${roomId}/snapshot`, { token: seatToken });
  if (snap.status !== 200) fail(`快照失败 HTTP ${snap.status}`);
  const view = snap.json.snapshot;
  const qin = view.factions.find((f) => f.id === 'qin');
  const qi = view.factions.find((f) => f.id === 'qi');
  if (!qin?.exact) fail('己方快照缺 exact');
  if (qi?.exact !== undefined) fail('别国快照泄漏了精确数值');
  if (!Array.isArray(view.legalActions) || view.legalActions.length === 0) {
    fail(`快照缺合法动作空间（turn=${view.turn} phase=${view.phase} qin.eliminated=${qin?.eliminated}）`);
  }
  if (view.regions.length !== 19) fail(`区域应为 19，实际 ${view.regions.length}`);
  console.log(`[smoke] ④ 快照 OK（${view.legalActions.length} 个合法动作，${view.mapText.split('\n').length} 行地图）`);

  // ⑤ 提交一条确定性命令（CAS 用快照里的 stateId）
  const submitted = await req('POST', `/api/rooms/${roomId}/commands`, {
    token: seatToken,
    body: {
      stateId: view.stateId,
      requestId: 'smoke-req-1',
      // set_tax 不带 factionId —— 势力由席位令牌决定，绝不从载荷里取
      commands: [{ kind: 'set_tax', rate: 0.35 }],
    },
  });
  if (submitted.status !== 200 || submitted.json.status !== 'completed') {
    fail(`提交失败 HTTP ${submitted.status} ${submitted.text.slice(0, 300)}`);
  }
  console.log('[smoke] ⑤ 命令已接受');

  // ⑥ 锁定 → 其余 AI 席位在无 LLM 时走启发式并自动锁定 → 全员到齐即结算
  const locked = await req('POST', `/api/rooms/${roomId}/lock`, { token: seatToken });
  if (locked.status !== 200 || locked.json.locked !== true) fail(`锁定失败 HTTP ${locked.status}`);
  console.log('[smoke] ⑥ 已锁定，等待回合结算…');

  // ⑦ 轮询回合推进（AI 席位是异步行动的，不阻塞主循环）
  let room = null;
  for (let i = 0; i < 60; i++) {
    const r = await req('GET', `/api/rooms/${roomId}`, { token: ADMIN });
    room = r.json?.room ?? null;
    if (room && room.turn >= 2) break;
    await sleep(100);
  }
  if (!room || room.turn < 2) fail(`6 秒内回合未推进（turn=${room?.turn}）`);
  if (room.stateDigest === turn1Digest) fail('回合推进了但 state_digest 没变');
  console.log(`[smoke] ⑦ 回合推进到 ${room.turn}，digest 已更新`);

  // ⑧ 战报落库：必须包含 AI 席位的命令（证明 AI 与人类同一条通道）
  const report = await req('GET', `/api/rooms/${roomId}/turns/1`, { token: ADMIN });
  if (report.status !== 200) fail(`战报读取失败 HTTP ${report.status}`);
  const orders = report.json.report.orders;
  const aiSeats = orders.filter((o) => o.seatId !== 'seat_qin');
  if (aiSeats.length === 0) fail('战报里没有 AI 席位的命令 —— 启发式没有提交？');
  if (!report.json.report.events.some((e) => e.type === 'turn_resolved')) fail('战报缺 turn_resolved 事件');
  console.log(`[smoke] ⑧ 战报 OK（${orders.length} 席命令，其中 AI ${aiSeats.length} 席）`);

  // ⑨ 事件可回放
  const events = await req('GET', `/api/rooms/${roomId}/events?from=0`, { token: seatToken });
  if (events.status !== 200) fail(`事件流读取失败 HTTP ${events.status}`);
  const list = events.json.events ?? [];
  if (!list.some((e) => e.event?.type === 'turn_resolved')) fail('事件流里没有 turn_resolved');
  console.log(`[smoke] ⑨ 事件流 OK（${list.length} 条）`);

  // ⑩ WebSocket：带 from=1 重连补发，必须拿到同一份 turn_resolved
  const wsBatch = await new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${PORT}/ws?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(seatToken)}&from=1`,
    );
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WS 3 秒内未收到补发批次'));
    }, 3000);
    ws.on('message', (raw) => {
      let batch = null;
      try {
        batch = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (Array.isArray(batch?.events) && batch.events.some((e) => e.event?.type === 'turn_resolved')) {
        clearTimeout(timer);
        ws.close();
        resolve(batch);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  if (wsBatch.stateDigest !== room.stateDigest) fail('WS 批次的 stateDigest 与房间当前状态不一致');
  console.log(`[smoke] ⑩ WebSocket OK（补发 ${wsBatch.events.length} 条，stateDigest 对齐）`);

  console.log('\n[smoke] PASS —— 建房间/快照/提交/锁定/AI 行动/结算/战报/事件(HTTP+WS) 全通');
  child.kill();
  await sleep(200);
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {}
  process.exit(0);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
