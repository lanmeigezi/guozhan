/**
 * 提示词体积测量 —— 成本调参用，不是游戏逻辑。
 *
 * 它用真实剧本建一个（不推进的）房间，渲染一次顾问调用的 system + user，
 * 分别报字符数与按 chars/2 估算的 token（中文按 2 字符/token，见 llm-client.ts）。
 *
 * 跑法：node --experimental-strip-types tools/measure-prompt.ts [scenarioId]
 * 依赖：无需 LLM key（只渲染，不发请求）
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LlmClient, estimateTokens } from '../src/ai/llm-client.ts';
import { renderSituation, renderSystemPrompt, type PromptContext } from '../src/ai/prompt-render.ts';
import { EMPTY_FACTS, evaluateAlerts, evaluateMilestones } from '../src/ai/alerts.ts';
import { RoomManagerImpl } from '../src/server/room/manager.ts';
import type { AlertConfigEntry } from '../src/ai/alerts.ts';

const scenarioId = process.argv[2] ?? 'warring-states';
const configRoot = 'config';

const llm = new LlmClient({
  baseUrl: 'http://127.0.0.1:1',
  apiKey: '',
  model: 'none',
  provider: 'none',
  timeoutMs: 50,
  maxRetries: 0,
  backoffBaseMs: 1,
  backoffMaxMs: 1,
});

const manager = new RoomManagerImpl({
  dataDir: mkdtempSync(join(tmpdir(), 'guozhan-measure-')),
  configRoot,
  scenarioIds: [scenarioId],
  llm,
  autoAdvice: false,
});

const room = await manager.createRoom({
  name: 'measure',
  scenarioId,
  rootSeed: 'measure-seed',
  humanFactions: ['qin', 'zhao', 'chu', 'qi', 'wei', 'han', 'yan'],
});
const state = await manager.getState(room.roomId);
if (!state) throw new Error('房间状态缺失');
const snapshot = await manager.getSnapshot(room.roomId, 'seat_qin');

const alertDoc = JSON.parse(readFileSync(join(configRoot, 'rules', 'alerts.json'), 'utf8')) as { alerts: AlertConfigEntry[] };
const milestones = evaluateMilestones(state.state, state.world, 'qin', state.scenario.milestones, EMPTY_FACTS);
const alerts = evaluateAlerts(state.state, state.world, 'qin', alertDoc.alerts, EMPTY_FACTS, milestones, 8);
const withAlerts = { ...snapshot, alerts };

const ctx: PromptContext = {
  scenarioName: state.scenario.name,
  scenarioDescription: state.scenario.description,
  factionName: state.state.factions['qin']?.name ?? 'qin',
  factionPersonality: { aggression: 0.85, diplomacy: 'calculating', description: '虎狼之秦，耕戰立國，志在一統' },
  language: state.scenario.llm.language === 'en' ? 'en' : 'zh',
  turn: snapshot.turn,
  maxTurns: state.scenario.maxTurns,
  role: 'advisor',
  milestones: milestones.map((m) => ({ turn: m.deadline, require: { ...m.require }, message: m.message })),
  milestoneStatus: milestones.map((m) => ({ message: m.message, met: m.met, deadline: m.deadline })),
  budgetRemaining: state.scenario.budget.perSeatTokenCap,
  pastLessons: [],
};

const system = renderSystemPrompt(ctx);
const user = renderSituation(withAlerts);
const jsonSize = JSON.stringify(withAlerts).length;

const rows: Array<[string, number, number]> = [
  ['system', system.length, estimateTokens(system)],
  ['user（含地图+合法动作）', user.length, estimateTokens(user)],
  ['合计（单次顾问调用输入）', system.length + user.length, estimateTokens(system) + estimateTokens(user)],
  ['mapText（拓扑地图）', snapshot.mapText.length, estimateTokens(snapshot.mapText)],
  ['等价的 JSON 快照（对照）', jsonSize, estimateTokens('x'.repeat(0)) + Math.round(jsonSize / 2)],
];

process.stdout.write(`剧本 ${scenarioId}｜回合 ${snapshot.turn}｜合法动作 ${snapshot.legalActions.length} 条｜告警 ${alerts.length} 条\n`);
process.stdout.write('项目\t字符数\t估算 token\n');
for (const [name, chars, tokens] of rows) process.stdout.write(`${name}\t${chars}\t${tokens}\n`);
process.stdout.write(
  `\n文本渲染 vs JSON：省 ${(100 - ((system.length + user.length) / jsonSize) * 100).toFixed(0)}%（JSON 里塞的是同一份态势）\n`,
);

await manager.shutdown();
