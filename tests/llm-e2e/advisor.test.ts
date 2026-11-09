/**
 * 真实 LLM 端到端（需要 `LLM_API_KEY`，没有就整文件 skip）。
 *
 * ★它验证的是**协议一致性**，不是模型下得好不好：
 *   · 建议里的每个 legalActionId 都必须来自引擎的合法动作空间（P10 锚定）
 *   · AdviceRecord.snapshotDigest 必须等于生成时的局面
 *   · usage 必须真实记账（tokenUsed 增长），失败也必须留 llm_calls 记录
 *   · 提示词必须携带五类纪律（不是"希望模型自觉"，而是发出去就得有）
 *   · 人类席位在 autoCommit=false 下**绝不**自动提交命令
 *
 * 跑法：
 *   LLM_API_KEY=... LLM_MODEL=deepseek-chat npm run test:llm
 * 可选：LLM_API_BASE / LLM_PROVIDER / LLM_TIMEOUT_MS
 *
 * 设计取舍：先做一次极小的连通性探针；探针失败 ⇒ skip（避免没网的机器红），
 * 探针成功但建议流程违约 ⇒ 红（那才是真的协议问题）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LlmClient, clientFromEnv, type ChatRequest, type ChatResponse } from '../../src/ai/llm-client.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import { RoomManagerImpl } from '../../src/server/room/manager.ts';
import type { FactionId } from '../../src/core/state.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG_ROOT = join(repoRoot, 'config');
const ALL_FACTIONS: FactionId[] = ['qin', 'zhao', 'chu', 'qi', 'wei', 'han', 'yan'];
const HAS_KEY = (process.env.LLM_API_KEY ?? '').length > 0;

/** 包一层：记录发出去的提示词，然后原样交给真实客户端 */
class CapturingLlm extends LlmClient {
  readonly requests: ChatRequest[] = [];
  constructor(base: LlmClient) {
    super(base.config);
  }
  override async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    return super.chat(req);
  }
}

const dirs: string[] = [];
const managers: RoomManagerImpl[] = [];

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

test('真实 LLM：建议锚定合法动作 + 记账 + 不自动提交', { skip: !HAS_KEY && '未设置 LLM_API_KEY' }, async (t) => {
  const real = clientFromEnv();
  const llm = new CapturingLlm(real);

  // ① 连通性探针：没网/没额度就跳过，而不是把 e2e 变成噪声源
  const probe = await llm.chat({
    purpose: 'advisor',
    system: '你是一个协议探针。只回一行 JSON。',
    user: '回复 {"ok":true}',
    maxTokens: 16,
    temperature: 0,
    json: true,
  });
  if (probe.record.status !== 'ok') {
    t.skip(`LLM 不可用（${probe.record.status}: ${probe.record.error ?? ''}），跳过真实调用断言`);
    return;
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'guozhan-llm-e2e-'));
  dirs.push(dataDir);
  const manager = new RoomManagerImpl({
    dataDir,
    configRoot: CONFIG_ROOT,
    scenarioIds: ['warring-states'],
    llm,
    autoAdvice: false, // 全部手动驱动，避免后台自动调用混进断言
  });
  managers.push(manager);

  const room = await manager.createRoom({
    name: 'llm-e2e',
    scenarioId: 'warring-states',
    rootSeed: 'llm-e2e-seed',
    humanFactions: ALL_FACTIONS, // 全人类席位：autoCommit=false，观察"建议"本身
  });
  await manager.joinRoom(room.roomId, { seatId: 'seat_qin' });

  const state = await manager.getState(room.roomId);
  assert.ok(state);
  const legalIds = new Set(
    enumerateLegalActions(state!.state, state!.world, 'qin', { maxActions: 40 }).map((a) => a.id),
  );
  assert.ok(legalIds.size > 0, '合法动作空间不能为空，否则这条测试证明不了锚定');

  const digestBefore = (await manager.getRoom(room.roomId))!.stateDigest;
  const out = await manager.requestAdvice(room.roomId, 'seat_qin');

  assert.equal(llm.requests.length >= 2, true, '至少应有一次探针 + 一次顾问调用');
  const advisorReq = llm.requests.find((r) => r.purpose === 'advisor' && r.maxTokens > 16);
  assert.ok(advisorReq, '应发生一次真正的顾问调用');
  for (const needle of ['legalActionId', '不得', 'JSON']) {
    assert.ok(
      `${advisorReq!.system}\n${advisorReq!.user}`.includes(needle),
      `提示词缺少「${needle}」：系统提示词是纪律的载体，不能省`,
    );
  }

  if ('skipped' in out) {
    // 调用发生但没产出建议：允许（容量/超时/解析失败），但必须留痕
    const info = await manager.getRoom(room.roomId);
    assert.ok(info);
    assert.ok(info!.seats.some((s) => s.tokenUsed > 0), '失败调用也必须记账 tokenUsed');
    return;
  }

  const adviceId = (out as { adviceId: string }).adviceId;
  const pending = await manager.getPendingAdvice(room.roomId, 'seat_qin');
  const record = pending.find((a) => a.id === adviceId);
  assert.ok(record, 'autoCommit=false 时建议必须落库为 pending');
  assert.equal(record!.snapshotDigest, digestBefore, '建议必须记住它基于哪个局面');

  // ★P10：建议只能引用引擎给的动作，不能自造
  for (const c of record!.commands) {
    assert.ok(legalIds.has(c.legalActionId), `建议引用了不在合法动作空间里的 id：${c.legalActionId}`);
  }
  // 被剔除的条目必须留痕（逐条剔除而非整包拒绝）
  for (const v of record!.violations) {
    assert.equal(typeof v.rule, 'string');
    assert.ok(['dropped', 'clamped', 'warned'].includes(v.action), `未知的处置动作：${v.action}`);
  }

  // ③ 人类席位不得自动提交：建议产生后仍然没有任何待裁决命令
  const report = await manager.resolveTurn(room.roomId);
  assert.equal(report.orders.length, 0, 'autoCommit=false 时不得替人类下命令');

  // ④ LLM 的软性 delta 只能通过核心裁决（本回合无命令，仍应为纯确定性基线）
  assert.equal(typeof report.llmApplied, 'boolean');
  const info = await manager.getRoom(room.roomId);
  assert.ok(info!.seats.some((s) => s.tokenUsed > 0), 'tokenUsed 必须随真实 usage 增长');
});
