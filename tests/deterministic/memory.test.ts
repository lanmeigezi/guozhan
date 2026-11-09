import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LlmClient } from '../../src/ai/llm-client.ts';
import type { CommandEnvelope } from '../../src/protocol/commands.ts';
import type { FactionId, SeatId } from '../../src/core/state.ts';
import { RoomManagerImpl } from '../../src/server/room/manager.ts';
import type { Principal, RoomInfo } from '../../src/server/room/types.ts';

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
const FACTIONS: FactionId[] = ['qin', 'zhao', 'chu', 'qi', 'wei', 'han', 'yan'];
const dirs: string[] = [];
const managers: RoomManagerImpl[] = [];

function newManager(): RoomManagerImpl {
  const dataDir = mkdtempSync(join(tmpdir(), 'guozhan-memory-'));
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

async function principalOf(m: RoomManagerImpl, roomId: string, token: string): Promise<Principal> {
  const resumed = await m.resumeSeat(token);
  assert.ok(resumed);
  return {
    roomId,
    seatId: resumed.seat.seatId,
    kind: resumed.seat.kind,
    factionId: resumed.seat.factionId,
    readOnly: resumed.seat.kind === 'spectator',
  };
}

test('★对局记忆：观战拿全知历史，玩家席位只拿自己的命令/叙事（不绕过迷雾）', async () => {
  const m = newManager();
  const room: RoomInfo = await m.createRoom({
    name: '记忆测试局',
    scenarioId: 'warring-states',
    rootSeed: 'memory-seed-1',
    humanFactions: FACTIONS,
  });
  const tokens = new Map<FactionId, string>();
  for (const fid of FACTIONS) {
    const { token } = await m.joinRoom(room.roomId, { seatId: `seat_${fid}` });
    tokens.set(fid, token);
  }

  // 每个真人席位提交一条合法命令，再全部锁定，生成完整第 1 回合历史
  const plans: Array<{ fid: FactionId; principal: Principal; envelope: CommandEnvelope }> = [];
  for (const fid of FACTIONS) {
    const p = await principalOf(m, room.roomId, tokens.get(fid)!);
    const legal = await m.getLegalActions(room.roomId, p.seatId);
    const action = legal.actions[0];
    assert.ok(action, `${fid} 应有合法动作`);
    plans.push({
      fid,
      principal: p,
      envelope: {
        stateId: legal.stateId,
        requestId: `memory-${fid}`,
        commands: [action.command] as CommandEnvelope['commands'],
      },
    });
  }
  for (const plan of plans) await m.submitCommands({ principal: plan.principal, envelope: plan.envelope });
  for (const plan of plans) await m.lockOrders(plan.principal);
  const spectator = await m.joinRoom(room.roomId, { asSpectator: true });

  const seatMemory = await m.getMatchMemory(room.roomId, 'seat_qin' as SeatId);
  const fullMemory = await m.getMatchMemory(room.roomId, 'spectator');

  assert.equal(seatMemory.format, 'guozhan-match-memory');
  assert.equal(seatMemory.viewer.full, false);
  assert.equal(seatMemory.viewer.factionId, 'qin');
  assert.equal(seatMemory.turns.length, 1, '应包含已结算的第 1 回合');
  assert.equal(seatMemory.turns[0]?.orders.length, 1, '玩家只看到自己的命令');
  assert.equal(seatMemory.turns[0]?.orders[0]?.seatId, 'seat_qin');

  assert.equal(fullMemory.viewer.full, true);
  assert.equal(fullMemory.turns.length, 1);
  assert.equal(fullMemory.turns[0]?.orders.length, FACTIONS.length, '观战看到全部 7 个席位的命令');
  assert.ok(fullMemory.events.length >= seatMemory.events.length, '全知事件流不得少于单席位可见事件');
  assert.ok(fullMemory.events.some((e) => e.turn === 1));

  // 管理员/观战拿到的完整历史可以交给酒馆压缩；玩家版本仍保留自己的命令与叙事槽
  assert.equal(spectator.seat.kind, 'spectator');
  assert.equal(seatMemory.room.roomId, room.roomId);
  assert.equal(typeof seatMemory.generatedAt, 'number');
});
