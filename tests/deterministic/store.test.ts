/**
 * 存储层闸门 —— 直接验任务书里点名的两句话：
 *   「SQLite 嵌入式数据库（**WAL 模式**），**每个游戏房间独立状态**」
 *
 * 之前只有房间层重启测试间接覆盖（它证明"数据还在"，但证明不了"是 WAL"、
 * 也证明不了"两个房间是两个文件"）。这里补上直接读数：
 *   · 文件库的 journal_mode 必须是 wal（不是默认的 delete），且写后出现 -wal 边车文件
 *   · 两个房间落在 rooms/ 下两个不同文件
 *   · close → 新实例 reopen，digest 与事件逐条一致（durability）
 *   · roomId 路径穿越被拒（防写到 data/ 外面）
 *   · exportRoom 可重复执行：第二份导出会把旧档轮转成 .bak
 *
 * 变异说明（任一条都应让本文件红）：
 *   · 把 PRAGMA journal_mode=WAL 删掉 ⇒ WAL 用例红
 *   · rooms 目录改成单文件 ⇒ 独立库用例红
 *   · exportRoom 不轮转 .bak ⇒ 备份用例红
 *   · assertSafeRoomId 放行 ../ ⇒ 穿越用例红
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSqliteStore, digestState, type SqliteRoomStore } from '../../src/server/store/sqlite-store.ts';
import { loadScenario } from '../../src/server/config-loader.ts';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG_ROOT = join(repoRoot, 'config');

const dirs: string[] = [];
function newStore(): { store: SqliteRoomStore; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'guozhan-store-'));
  dirs.push(dataDir);
  const { store } = createSqliteStore({ dataDir });
  return { store, dataDir };
}

function seedRoom(store: SqliteRoomStore, roomId: string): { digest: string; turn: number } {
  const loaded = loadScenario('warring-states', `store-${roomId}`, CONFIG_ROOT);
  const state = { ...loaded.initialState, turn: 1 };
  const digest = digestState(state);
  store.open(roomId);
  store.saveRoom(roomId, {
    roomId,
    name: `房间 ${roomId}`,
    scenarioId: 'warring-states',
    phase: state.phase,
    turn: state.turn,
    maxTurns: loaded.meta.maxTurns,
    rootSeed: loaded.rootSeed,
    stateJson: JSON.stringify(state),
    stateDigest: digest,
    behaviorFingerprint: loaded.meta.behaviorFingerprint,
    contentHash: loaded.contentHash,
    moduleOrderJson: JSON.stringify(loaded.meta.moduleOrder),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
  store.appendEvents(roomId, [
    { offset: 1, turn: 1, type: 'turn_started', payload: { type: 'turn_started', turn: 1, deadline: {} } },
  ]);
  return { digest, turn: state.turn };
}

process.on('exit', () => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* Windows 句柄释放延迟 */
    }
  }
});

test('★WAL 模式真的生效（不是默认的 delete）', () => {
  const { store } = newStore();
  seedRoom(store, 'room_wal');
  assert.equal(store.journalModeOf('room_wal'), 'wal', 'room 库必须运行在 WAL 模式');

  // 写入之后应出现 -wal 边车文件；没有它说明其实没走 WAL
  const dbPath = join(store.roomsDir, 'room_wal.db');
  assert.ok(existsSync(dbPath), '房间库文件必须存在');
  assert.ok(existsSync(`${dbPath}-wal`), 'WAL 模式下写入后必须出现 -wal 文件');
  store.close('room_wal');
});

test('★每个房间一个独立库文件（不是一个共享大库）', () => {
  const { store } = newStore();
  seedRoom(store, 'room_a');
  seedRoom(store, 'room_b');

  const a = join(store.roomsDir, 'room_a.db');
  const b = join(store.roomsDir, 'room_b.db');
  assert.ok(existsSync(a) && existsSync(b), '两个房间应各有一个库文件');
  assert.notEqual(statSync(a).size, 0);
  assert.deepEqual([...store.openRoomIds()].sort(), ['room_a', 'room_b']);

  // 两个库互不干扰：给 A 加的事件不会出现在 B
  store.appendEvents('room_a', [
    { offset: 2, turn: 1, type: 'turn_resolved', payload: { type: 'turn_resolved', turn: 1 } },
  ]);
  assert.equal(store.readEvents('room_a', 0, 100).length, 2);
  assert.equal(store.readEvents('room_b', 0, 100).length, 1, 'B 库不应看到 A 的事件');
});

test('★重启后数据仍在：close → 新实例 reopen，digest 与事件一致', () => {
  const { store, dataDir } = newStore();
  const seeded = seedRoom(store, 'room_durable');
  store.close('room_durable');

  const { store: reopened } = createSqliteStore({ dataDir });
  const row = reopened.loadRoom('room_durable');
  assert.ok(row, '重启后房间必须还在');
  assert.equal(row!.stateDigest, seeded.digest);
  const state = reopened.loadState('room_durable');
  assert.ok(state);
  assert.equal(digestState(state!.state), seeded.digest, '读回的状态重新算 digest 必须一致');

  const events = reopened.readEvents('room_durable', 0, 100);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'turn_started');
  reopened.close('room_durable');
});

test('roomId 路径穿越被拒（不允许写出 data/ 之外）', () => {
  const { store } = newStore();
  for (const bad of ['../evil', 'a/b', '..', '', 'room\\x']) {
    assert.throws(() => store.open(bad), /roomId|非法|invalid/i, `应拒绝非法 roomId：${JSON.stringify(bad)}`);
  }
  // 好样本：正常 id 能开
  store.open('room-ok_1');
  assert.ok(existsSync(join(store.roomsDir, 'room-ok_1.db')));
});

test('★导出可重复：第二份导出把旧档轮转为 .bak', () => {
  const { store, dataDir } = newStore();
  seedRoom(store, 'room_export');
  const dest = join(dataDir, 'export', 'room_export.json');

  store.exportRoom('room_export', dest);
  const first = JSON.parse(readFileSync(dest, 'utf8')) as { format: string; version: number; room: unknown[] };
  assert.equal(first.format, 'guozhan-room-export');
  assert.equal(first.version, 1);
  assert.ok(Array.isArray(first.room) && first.room.length === 1);

  const before = readFileSync(dest, 'utf8');
  store.exportRoom('room_export', dest);
  assert.ok(existsSync(`${dest}.bak`), '第二次导出应把旧档轮转为 .bak（单份导出没有历史，坏档就无从回滚）');
  assert.equal(readFileSync(`${dest}.bak`, 'utf8'), before, '.bak 必须是**上一份**导出，不是新的');
});
