/**
 * 军师模式端到端 —— LLM 建议 → 四道闸门 → 落库 → 人类采纳 → 走命令通道。
 *
 * 为什么必须单独测：`ai-layer.test.ts` 只证明 Advisor 类本身的行为，
 * `room.test.ts` 在无 LLM 时只会走启发式降级。也就是说"真建议"这条路
 * （AdviceRecord 落库 → 人类 adopt → 进 pending_orders）此前**没有任何集成覆盖**。
 *
 * 用 ScriptedLlm 而不是真 key：这条链要验的是编排与闸门，不是模型质量。
 * 真模型那一层属于 llm-e2e（需要 key，单独跑）。
 *
 * 变异说明（做完任一条，本文件必须红）：
 *   · 把 adoptAdvice 的 snapshotDigest 校验删掉 ⇒ "旧局面建议"用例变绿（错）
 *   · 让 AdviceRecord.commands 直接用 LLM 原文而非引擎的 legalAction ⇒ 锚定断言红
 *   · 把 onSaveAdvice 去掉 ⇒ getPendingAdvice 为空
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LlmClient, type ChatRequest, type ChatResponse } from '../../src/ai/llm-client.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import type { FactionId } from '../../src/core/state.ts';
import { RejectionCode } from '../../src/protocol/rejections.ts';
import { RoomManagerImpl } from '../../src/server/room/manager.ts';
import type { Principal } from '../../src/server/room/types.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG_ROOT = join(repoRoot, 'config');
const ALL_FACTIONS: FactionId[] = ['qin', 'zhao', 'chu', 'qi', 'wei', 'han', 'yan'];

/** 按用途返回固定文本的假模型：advisor 给 JSON，narrative 给散文 */
class ScriptedLlm extends LlmClient {
  readonly calls: ChatRequest[] = [];
  private adviceJson = '{}';

  constructor() {
    super({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'scripted-key', // enabled=true，但从不发网络请求
      model: 'scripted',
      provider: 'scripted',
      timeoutMs: 50,
      maxRetries: 0,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
    });
  }

  setAdvice(json: string): void {
    this.adviceJson = json;
  }

  override async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const text = req.purpose === 'narrative' ? '是岁，秦募新卒，关中父老输粮不绝。' : this.adviceJson;
    return {
      text,
      streamed: false,
      record: {
        purpose: req.purpose,
        model: 'scripted',
        provider: 'scripted',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, estimated: false },
        latencyMs: 1,
        status: 'ok',
        error: null,
        attempts: 1,
        requestedAt: Date.now(),
      },
    };
  }
}

const managers: RoomManagerImpl[] = [];
const dirs: string[] = [];

function newManager(llm: LlmClient): RoomManagerImpl {
  const dataDir = mkdtempSync(join(tmpdir(), 'guozhan-advisor-'));
  dirs.push(dataDir);
  const m = new RoomManagerImpl({
    dataDir,
    configRoot: CONFIG_ROOT,
    scenarioIds: ['warring-states', 'aria'],
    llm,
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

async function setup(llm: ScriptedLlm): Promise<{
  m: RoomManagerImpl;
  roomId: string;
  principal: Principal;
}> {
  const m = newManager(llm);
  const room = await m.createRoom({
    name: '军师局',
    scenarioId: 'warring-states',
    rootSeed: 'advisor-seed',
    humanFactions: ALL_FACTIONS, // 全员真人席位：不会自动提交，便于观察"建议"本身
  });
  const joined = await m.joinRoom(room.roomId, { seatId: 'seat_qin' });
  const principal: Principal = {
    roomId: room.roomId,
    seatId: joined.seat.seatId,
    kind: joined.seat.kind,
    factionId: joined.seat.factionId,
    readOnly: false,
  };
  return { m, roomId: room.roomId, principal };
}

function adviceFor(legalActionId: string): string {
  return JSON.stringify({
    assessment: '秦宜先固本，再图东出。',
    chat: '秦地春耕已毕，诸君可安心。',
    recommended: [{ legalActionId, priority: 1, rationale: '关中人口充裕，先征新卒', risk: 'low' }],
    diplomacy: [{ to: 'qi', publicity: 'public', body: '愿与齐互市，各安其民。', intent: 'peace' }],
  });
}

// ─────────────────────────────────────────────────────────────

test('★军师模式：真建议落库 → 人类采纳 → 命令进入同一提交通道', async () => {
  const llm = new ScriptedLlm();
  const { m, roomId, principal } = await setup(llm);

  const st = await m.getState(roomId);
  assert.ok(st);
  const recruit = enumerateLegalActions(st!.state, st!.world, 'qin', { maxActions: 40 }).find((a) => a.kind === 'recruit');
  assert.ok(recruit !== undefined, '开局秦应有可征兵动作');
  llm.setAdvice(adviceFor(recruit!.id));

  const res = await m.requestAdvice(roomId, 'seat_qin');
  assert.ok('adviceId' in res, `应产出建议，实际：${JSON.stringify(res)}`);
  const adviceId = (res as { adviceId: string }).adviceId;

  const pending = await m.getPendingAdvice(roomId, 'seat_qin');
  assert.equal(pending.length, 1, '建议必须落库为 pending（军师模式等人类确认）');
  const rec = pending[0]!;
  assert.equal(rec.id, adviceId);
  assert.equal(rec.snapshotDigest, (await m.getRoom(roomId))!.stateDigest, '建议要记下它基于哪个局面');
  assert.equal(rec.commands.length, 1);
  assert.equal(rec.output.chat, '秦地春耕已毕，诸君可安心。', 'AI 的短发言必须随建议保留');

  // ★P10 锚定：落库的命令必须是**引擎**的合法动作，不是 LLM 写的对象
  assert.deepEqual(rec.commands[0]!.command, recruit!.command, '采纳时提交的必须是引擎给出的那条命令');
  assert.equal(rec.commands[0]!.legalActionId, recruit!.id);
  assert.equal(llm.calls.length, 1, 'autoCommit=false 时只应有一次顾问调用，不得自动再调');

  // 人类采纳 → 走同一条 submitCommands
  const adopted = await m.adoptAdvice({ principal, adviceId });
  assert.equal(adopted.status, 'completed');
  assert.equal(adopted.completedSteps, 1);
  assert.equal((await m.getPendingAdvice(roomId, 'seat_qin')).length, 0, '采纳后不应再是 pending');

  // ★重复采纳不得重复入队（网络重试/双击）：第二次直接失败，且命令数不变
  const again = await m.adoptAdvice({ principal, adviceId });
  assert.equal(again.status, 'failed');
  assert.equal(again.steps[0]?.code, RejectionCode.UNKNOWN_ADVICE);

  const report = await m.resolveTurn(roomId);
  const qinOrder = report.orders.find((o) => o.seatId === 'seat_qin');
  assert.ok(qinOrder, '采纳的命令必须进入结算');
  assert.equal(qinOrder!.commands.length, 1, '重复采纳不得产生第二条命令');
  assert.equal((qinOrder!.commands[0] as { kind: string }).kind, 'recruit');
  assert.ok(
    report.events.some((e) => e.type === 'recruitment_completed' && e.factionId === 'qin'),
    '结算后必须有征兵事件——建议真的影响了游戏',
  );
});

test('★旧局面的建议被拒：解析前先比 snapshotDigest，并标记 expired', async () => {
  const llm = new ScriptedLlm();
  const { m, roomId, principal } = await setup(llm);

  const st = await m.getState(roomId);
  assert.ok(st);
  const action = enumerateLegalActions(st!.state, st!.world, 'qin', { maxActions: 40 })[0];
  assert.ok(action !== undefined);
  llm.setAdvice(adviceFor(action!.id));

  const res = await m.requestAdvice(roomId, 'seat_qin');
  assert.ok('adviceId' in res);
  const adviceId = (res as { adviceId: string }).adviceId;
  const adviceDigest = (await m.getPendingAdvice(roomId, 'seat_qin'))[0]!.snapshotDigest;

  // 局面推进：建议所依据的 digest 作废
  await m.resolveTurn(roomId);
  const nowDigest = (await m.getRoom(roomId))!.stateDigest;
  assert.notEqual(nowDigest, adviceDigest, '前置：结算必须改变 digest');

  const adopted = await m.adoptAdvice({ principal, adviceId });
  assert.equal(adopted.status, 'failed');
  assert.equal(adopted.steps[0]?.code, RejectionCode.STALE_REVISION);
  assert.equal((await m.getPendingAdvice(roomId, 'seat_qin')).length, 0, '过期建议应被标记 expired，不再可采纳');
});

test('★叙事后到：状态与战报先落库，叙事异步补写进 turn_record', async () => {
  const llm = new ScriptedLlm();
  const { m, roomId, principal } = await setup(llm);

  const st = await m.getState(roomId);
  assert.ok(st);
  const recruit = enumerateLegalActions(st!.state, st!.world, 'qin', { maxActions: 40 }).find((a) => a.kind === 'recruit');
  assert.ok(recruit !== undefined);
  llm.setAdvice(adviceFor(recruit!.id));
  const res = await m.requestAdvice(roomId, 'seat_qin');
  await m.adoptAdvice({ principal, adviceId: (res as { adviceId: string }).adviceId });

  // 先有状态与战报（P11：结算不等叙事）
  const report = await m.resolveTurn(roomId);
  assert.equal(report.narratives.seat_qin, undefined, '结算产物里不该同步包含叙事');
  assert.ok(report.baseline.length > 0);

  // 叙事单独生成后再读战报
  await m.generateNarratives(roomId, 1);
  const withNarrative = await m.getTurnReport(roomId, 1);
  assert.ok(withNarrative);
  assert.match(withNarrative!.narratives.seat_qin ?? '', /秦募新卒/, '叙事必须写回 turn_record');

  const narrativeCall = llm.calls.find((c) => c.purpose === 'narrative');
  assert.ok(narrativeCall, '应发生一次 narrative 调用');
  assert.match(narrativeCall!.system, /不得改变任何数值/, '叙事提示词必须带"不得改数值"铁律');
  assert.match(narrativeCall!.user, /征募|招募|征兵|recruit/i, '叙事事实清单应含本回合真实事件');
});
