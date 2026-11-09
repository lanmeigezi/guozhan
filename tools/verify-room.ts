/**
 * 房间体检工具 —— 不改任何状态，只回答"这个存档还能不能信"。
 *
 * 检查三件事：
 *   ① state_json 重新计算的 digest 是否等于 state_digest（写坏了/手改过 ⇒ 立刻发现）
 *   ② behavior_fingerprint / content_hash 是否与当前配置一致（规则变了 ⇒ fail-closed）
 *   ③ 房间头（turn/phase）与权威状态是否一致
 *
 * ★它不是"重放"：真正的重放需要每回合的状态快照，本项目只存结算后的状态 + 逐回合增量。
 *   把工具命名成 replay 会让人以为能复现任意回合，那是过度承诺。
 *
 * 跑法：node --experimental-strip-types tools/verify-room.ts <roomId> [dataDir]
 */
import { join } from 'node:path';
import { digestState } from '../src/server/store/codec.ts';
import { createSqliteStore } from '../src/server/store/sqlite-store.ts';
import { loadScenario } from '../src/server/config-loader.ts';

const roomId = process.argv[2];
const dataDir = process.argv[3] ?? 'data';
const configRoot = process.argv[4] ?? 'config';

if (roomId === undefined || roomId.length === 0) {
  process.stderr.write('用法：node --experimental-strip-types tools/verify-room.ts <roomId> [dataDir] [configRoot]\n');
  process.exit(2);
}

const { store, index } = createSqliteStore({ dataDir });
const row = store.loadRoom(roomId);
if (!row) {
  process.stderr.write(`guozhan: 房间 ${roomId} 不存在于 ${join(dataDir, 'rooms')}\n`);
  process.exit(1);
}

const problems: string[] = [];
const loaded = store.loadState(roomId);
if (!loaded) {
  problems.push('room 行存在但没有 state_json');
} else {
  const recomputed = digestState(loaded.state);
  if (recomputed !== row.stateDigest) {
    problems.push(`state_digest 不一致：库里 ${row.stateDigest}，重算 ${recomputed}`);
  }
  if (loaded.state.turn !== row.turn) {
    problems.push(`房间头 turn=${row.turn} 与权威状态 turn=${loaded.state.turn} 不一致`);
  }
  if (loaded.state.phase !== row.phase) {
    problems.push(`房间头 phase=${row.phase} 与权威状态 phase=${loaded.state.phase} 不一致`);
  }
}

try {
  const scenario = loadScenario(row.scenarioId, row.rootSeed, configRoot);
  if (scenario.meta.behaviorFingerprint !== row.behaviorFingerprint) {
    problems.push(
      `behavior_fingerprint 变了：存档 ${row.behaviorFingerprint}，当前配置 ${scenario.meta.behaviorFingerprint}（旧档不得按新规则继续）`,
    );
  }
  if (scenario.contentHash !== row.contentHash) {
    problems.push(`content_hash 变了：存档 ${row.contentHash.slice(0, 12)}…，当前配置 ${scenario.contentHash.slice(0, 12)}…`);
  }
} catch (err) {
  problems.push(`剧本 ${row.scenarioId} 无法装载：${err instanceof Error ? err.message : String(err)}`);
}

const events = store.readEvents(roomId, 0, 1_000_000);
const turns = index.list().find((r) => r.roomId === roomId);

process.stdout.write(
  [
    `房间   ${row.roomId}（${row.name}）`,
    `剧本   ${row.scenarioId}  种子 ${row.rootSeed}`,
    `回合   ${row.turn}/${row.maxTurns}  阶段 ${row.phase}`,
    `席位   ${store.loadSeats(roomId).length}`,
    `事件   ${events.length} 条（offset ${events[0]?.offset ?? '-'}..${events[events.length - 1]?.offset ?? '-'}）`,
    `注册表 ${turns ? '在' : '缺失（listRooms 会看不到这个房间）'}`,
  ].join('\n') + '\n',
);

if (problems.length > 0) {
  process.stderr.write(`\nguozhan: ${problems.length} 项不一致\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('\nguozhan: 存档自洽\n');
