#!/usr/bin/env node
/**
 * 资源占用实测 —— 用来核对"1-2 核 / 2-4GB 轻量服务器"这个部署目标。
 *
 * 文档里给的是估算值；这个脚本给出本机实测：
 *   · 空载（只起了 HTTP/WS）
 *   · 10 个房间 + 每个房间拉一次快照之后
 *   · 一个回合从"人类锁定"到"状态推进"的墙钟时间（含 6 个 AI 席位的启发式决策）
 *
 * 跑法：npm run build && node scripts/measure-footprint.mjs
 * 只在 Windows 上读 RSS（用 PowerShell 取 WorkingSet64）；其他平台会跳过该行。
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.MEASURE_PORT ?? '8897');
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'measure-admin-token-0123456789';
const ROOMS = 10;
const dataDir = mkdtempSync(join(tmpdir(), 'guozhan-measure-'));

const child = spawn(process.execPath, ['--enable-source-maps', 'dist/main.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    GUOZHAN_TOKEN: ADMIN,
    GUOZHAN_ORIGINS: '',
    GUOZHAN_DATA_DIR: dataDir,
    GUOZHAN_CONFIG_ROOT: 'config',
    LLM_API_KEY: '',
    // AI 席位会在人类锁定后走启发式；靠"人类席位未认领 ⇒ 不开局"这道闸，
    // 建房间阶段不会自动跑回合，测量不会被后台循环污染
    GUOZHAN_AUTO_ADVICE: '1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => {
  stderr += String(d);
  if (stderr.length > 8000) stderr = stderr.slice(-4000);
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
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: resp.status, json, text };
}

function rssMiB() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${child.pid}).WorkingSet64`],
      { encoding: 'utf8' },
    ).trim();
    const bytes = Number(out);
    return Number.isFinite(bytes) ? bytes / (1024 * 1024) : null;
  } catch {
    return null;
  }
}

function dbBytes() {
  let total = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.db') || name.endsWith('.db-wal') || name.endsWith('.db-shm')) total += st.size;
    }
  };
  try {
    walk(dataDir);
  } catch {
    /* 目录还没建好 */
  }
  return total;
}

const results = [];
const fmt = (n) => (n === null ? 'n/a' : `${n.toFixed(1)} MiB`);

try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`服务提前退出：\n${stderr}`);
    try {
      const r = await req('GET', '/health');
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  if (!ready) throw new Error('服务 8 秒内未就绪');

  await sleep(300); // 让 JIT/GC 稳定
  results.push(['空载（仅 HTTP/WS）', fmt(rssMiB()), `${(dbBytes() / 1024).toFixed(0)} KiB`]);

  const roomIds = [];
  for (let i = 0; i < ROOMS; i++) {
    const r = await req('POST', '/api/rooms', {
      token: ADMIN,
      body: { name: `测量-${i}`, scenarioId: 'warring-states', rootSeed: `measure-${i}`, humanFactions: ['qin'] },
    });
    if (r.status !== 201) throw new Error(`建房间失败：${r.status} ${r.text.slice(0, 200)}`);
    roomIds.push(r.json.room.roomId);
  }
  const t0 = performance.now();
  const tokens = [];
  for (const roomId of roomIds) {
    const j = await req('POST', `/api/rooms/${roomId}/join`, { token: ADMIN, body: { seatId: 'seat_qin' } });
    if (j.status !== 200) throw new Error(`认领失败：${j.status} ${j.text.slice(0, 200)}`);
    const s = await req('GET', `/api/rooms/${roomId}/snapshot`, { token: j.json.token });
    if (s.status !== 200) throw new Error(`快照失败：${s.status} ${s.text.slice(0, 200)}`);
    if (!s.json?.snapshot?.stateId) throw new Error('快照响应缺少 snapshot.stateId');
    tokens.push(j.json.token);
  }
  const snapMs = performance.now() - t0;
  await sleep(300);
  results.push([
    `${ROOMS} 房间（含 ${ROOMS} 次认领 + 快照）`,
    fmt(rssMiB()),
    `${(dbBytes() / 1024 / 1024).toFixed(2)} MiB`,
    `${(snapMs / ROOMS).toFixed(1)} ms/房间`,
  ]);

  // 一个回合的端到端：人类下命令 + 锁定 → AI 席位启发式行动 → 结算
  const roomId = roomIds[0];
  const token = tokens[0];
  const snap = await req('GET', `/api/rooms/${roomId}/snapshot`, { token });
  await req('POST', `/api/rooms/${roomId}/commands`, {
    token,
    body: { stateId: snap.json.snapshot.stateId, requestId: 'measure-req', commands: [{ kind: 'set_tax', rate: 0.3 }] },
  });
  const t1 = performance.now();
  await req('POST', `/api/rooms/${roomId}/lock`, { token });
  let turn = 1;
  for (let i = 0; i < 100; i++) {
    const r = await req('GET', `/api/rooms/${roomId}`, { token: ADMIN });
    turn = r.json.room.turn;
    if (turn >= 2) break;
    await sleep(20);
  }
  const resolveMs = performance.now() - t1;
  if (turn < 2) throw new Error('回合未在 2 秒内推进');
  results.push(['1 回合端到端（含 6 席启发式）', fmt(rssMiB()), '', `${resolveMs.toFixed(0)} ms`]);

  process.stdout.write('场景\tRSS\t数据文件\t耗时\n');
  for (const row of results) process.stdout.write(`${row.join('\t')}\n`);
  process.stdout.write(
    `\n注：RSS 含 Node 运行时基线（约 40–60 MiB），不含 LLM 调用开销；数据文件含 WAL。\n` +
      `本机 CPU：${process.env.NUMBER_OF_PROCESSORS ?? '?'} 核（单进程单线程事件循环，见架构文档 §7）。\n`,
  );
  child.kill();
  await sleep(200);
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* Windows 句柄释放延迟 */
  }
  process.exit(0);
} catch (err) {
  console.error(`[measure] 失败：${err instanceof Error ? err.message : String(err)}`);
  child.kill();
  process.exit(1);
}
