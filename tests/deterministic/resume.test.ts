/**
 * 断线回来（继续对局）的席位契约：
 *   · 同一账号重领同一席位 → 旧令牌立刻失效，新令牌生效
 *   · AI 席位不能凭账号"变回真人"（必须走 joinRoom 认领空席位）
 *
 * 跑法：node --experimental-strip-types --test tests/deterministic/resume.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LlmClient } from '../../src/ai/llm-client.ts';
import type { SeatId } from '../../src/core/state.ts';
import { RoomManagerImpl } from '../../src/server/room/manager.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const OFF_LLM = new LlmClient({
  baseUrl: 'http://127.0.0.1:1',
  apiKey: '',
  model: 'none',
  provider: 'none',
  timeoutMs: 50,
  maxRetries: 0,
  backoffBaseMs: 1,
  backoffMaxMs: 1,
});

const dirs: string[] = [];
const managers: RoomManagerImpl[] = [];

function newManager(): RoomManagerImpl {
  const dataDir = mkdtempSync(join(tmpdir(), 'guozhan-resume-'));
  dirs.push(dataDir);
  const m = new RoomManagerImpl({
    dataDir,
    configRoot: join(repoRoot, 'config'),
    scenarioIds: ['warring-states'],
    llm: OFF_LLM,
    autoAdvice: false,
  });
  managers.push(m);
  return m;
}

after(() => {
  for (const m of managers) void m.shutdown();
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* Windows 句柄释放延迟 */
    }
  }
});

test('R1 断线回来：重领同一席位，旧令牌立刻失效', async () => {
  const manager = newManager();
  const room = await manager.createRoom({ name: '断线回来', scenarioId: 'warring-states' });
  const first = await manager.joinRoom(room.roomId, { seatId: 'seat_qin' as SeatId });
  assert.equal(first.seat.seatId, 'seat_qin');
  assert.equal((await manager.resumeSeat(first.token))?.seat.seatId, 'seat_qin');

  const again = await manager.reclaimSeat(room.roomId, first.seat.seatId);
  assert.ok(again, 'reclaimSeat 必须给已存在的人类席位发新令牌');
  assert.equal(again.seat.seatId, first.seat.seatId, '重领必须回到同一席位');
  assert.notEqual(again.token, first.token, '重领必须旋转令牌');

  assert.equal(await manager.resumeSeat(first.token), null, '旧令牌必须立刻失效');
  assert.equal((await manager.resumeSeat(again.token))?.seat.seatId, first.seat.seatId);
  assert.equal((await manager.resumeSeat(again.token))?.room.roomId, room.roomId);
});

test('R2 AI 席位不能凭账号变回真人，必须走 joinRoom 认领', async () => {
  const manager = newManager();
  const room = await manager.createRoom({ name: 'AI 席位', scenarioId: 'warring-states' });
  const seatId = 'seat_zhao' as SeatId;
  const human = await manager.joinRoom(room.roomId, { seatId });
  assert.equal((await manager.resumeSeat(human.token))?.seat.seatId, seatId);

  // 房主把席位收归 AI（踢人）：账号再"回来"不能直接拿回这个席位
  await manager.revokeSeat(room.roomId, seatId, { asAi: true });
  assert.equal(await manager.reclaimSeat(room.roomId, seatId), null);
  assert.equal(await manager.resumeSeat(human.token), null, '被收回后旧令牌同样失效');

  // 另一个空席位仍可正常加入（回来不等于永远锁死这局）
  const other = await manager.joinRoom(room.roomId, {});
  assert.ok(other.token.startsWith('gz_'));
  assert.notEqual(other.seat.seatId, seatId);
});
