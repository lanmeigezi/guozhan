/**
 * AI 原型闸门：疾攻 / 守成 / 无常。
 *
 * 锁住：
 *   ① 原型分配由 rootSeed 确定性决定，3 个 AI 覆盖三种、2 个不重复；
 *   ② 疾攻奖励早期夺地，守成奖励存活/经济/防守，两者策略明显分化；
 *   ③ 无常 AI 只从合法动作里按种子随机抽取，同一局面可复现；
 *   ④ 快照只对 AI 势力暴露原型，本席位不显示 AI 性格。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { readFileSync } from 'node:fs';
import { assignAiArchetypes } from '../../src/ai/archetypes.ts';
import { decideRandom } from '../../src/ai/random.ts';
import { deriveSelfReview } from '../../src/ai/selfplay.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import { buildSnapshot } from '../../src/server/room/snapshot.ts';
import type { AiArchetype } from '../../src/protocol/snapshot.ts';

const sc = loadScenario('random-front-v2', 'archetype-seed-0001', 'config');
const ids = Object.keys(sc.initialState.factions).sort();
const fid = ids[0]!;
const other = ids.find((x) => x !== fid)!;

test('★原型分配：同种子稳定、3 个 AI 覆盖三种、2 个不重复', () => {
  const a = assignAiArchetypes('arch-seed-1', ids);
  const b = assignAiArchetypes('arch-seed-1', [...ids].reverse());
  assert.deepEqual(a, b, '分配不能依赖传入顺序');
  assert.deepEqual(Object.keys(a).sort(), ids);
  const three = new Set(Object.values(assignAiArchetypes('arch-seed-1', ['a', 'b', 'c'])));
  assert.deepEqual([...three].sort(), ['random', 'rush', 'turtle']);
  const two = assignAiArchetypes('arch-seed-1', ['a', 'b']);
  assert.notEqual(two['a'], two['b'], '2 个 AI 不应拿到同一原型');
  assert.deepEqual(assignAiArchetypes('arch-seed-1', []), {});
  const signatures = new Set<string>();
  for (let i = 0; i < 24; i++) signatures.add(JSON.stringify(assignAiArchetypes(`arch-${i}`, ids)));
  assert.ok(signatures.size > 1, '不同种子应产生不同分布');
});

function previousFacts() {
  return {
    turn: 3,
    events: [
      { type: 'region_captured', to: fid, from: other, regionId: 'h01' },
      { type: 'combat_resolved', evidence: { attacker: { factionId: fid }, defender: { factionId: other }, outcome: 'attacker_win' } },
      { type: 'combat_resolved', evidence: { attacker: { factionId: other }, defender: { factionId: fid }, outcome: 'defender_win' } },
    ],
    baseline: [
      { scope: `faction:${fid}`, field: 'gold', delta: 2400 },
      { scope: `faction:${fid}`, field: 'food', delta: 1600 },
      { scope: `faction:${fid}`, field: 'morale', delta: 2 },
    ],
    rejectedForSeat: 0,
  };
}

function reviewFor(archetype: AiArchetype) {
  return deriveSelfReview({
    state: sc.initialState,
    world: sc.world,
    factionId: fid,
    aggression: 0.5,
    archetype,
    previous: previousFacts(),
  });
}

test('★奖励分化：疾攻奖励早期夺地，守成奖励经济/防守/存活', () => {
  const rush = reviewFor('rush');
  const turtle = reviewFor('turtle');
  assert.equal(rush.archetype, 'rush');
  assert.equal(turtle.archetype, 'turtle');
  assert.ok((rush.reward ?? 0) > 0, `疾攻夺地应得正奖励：${rush.reward}`);
  assert.ok((turtle.reward ?? 0) > 0, `守成经济/防守应得正奖励：${turtle.reward}`);
  assert.ok(rush.policy, '疾攻应有策略');
  assert.ok(turtle.policy, '守成应有策略');
  assert.ok(rush.policy!.attackRatio < turtle.policy!.attackRatio, '疾攻进攻门槛应低于守成');
  assert.ok(rush.policy!.defenseBias < turtle.policy!.defenseBias, '疾攻守备权重应低于守成');
  assert.ok(rush.policy!.infraBias < turtle.policy!.infraBias, '疾攻基建权重应低于守成');
  assert.equal(rush.policy!.maxCommands, 5);
  assert.equal(turtle.policy!.maxCommands, 5);
  assert.ok(rush.lessons.some((l) => l.includes('疾攻')));
  assert.ok(turtle.lessons.some((l) => l.includes('守成')));
});

test('★无常 AI：合法动作内随机抽取，同种子可复现且不重复用同一部队', () => {
  const legal = enumerateLegalActions(sc.initialState, sc.world, fid, { maxActions: 200 });
  const a = decideRandom(sc.initialState, sc.world, fid, 'random-seed-1', 5, legal);
  const b = decideRandom(sc.initialState, sc.world, fid, 'random-seed-1', 5, legal);
  assert.deepEqual(a.commands, b.commands, '同一局面/种子必须复现');
  assert.ok(a.commands.length > 0 && a.commands.length <= 5);
  const validIds = new Set(legal.map((x) => x.id));
  const units = new Set<string>();
  for (const c of a.commands) {
    assert.ok(validIds.has(c.legalActionId), `随机命令必须来自合法动作：${c.legalActionId}`);
    const unitId = (c.command as { unitId?: unknown }).unitId;
    if (typeof unitId === 'string') {
      assert.equal(units.has(unitId), false, `随机 AI 不应重复使用部队 ${unitId}`);
      units.add(unitId);
    }
  }
  assert.match(a.rationale, /无常策略/);
});

test('★快照只对 AI 势力暴露原型，本席位与观战端都不带 exact', () => {
  const digest = sha256(stableStringify(sc.initialState));
  const archetypes = { [other]: 'turtle' as const };
  const selfSnap = buildSnapshot({
    state: sc.initialState,
    world: sc.world,
    recipient: fid,
    viewer: fid,
    digest,
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
    aiArchetypes: archetypes,
  });
  assert.equal(selfSnap.factions.find((f) => f.id === fid)?.aiArchetype, undefined, '本席位不显示 AI 原型');
  assert.equal(selfSnap.factions.find((f) => f.id === other)?.aiArchetype, 'turtle', 'AI 势力应显示原型');

  const spectator = buildSnapshot({
    state: sc.initialState,
    world: sc.world,
    recipient: 'spectator',
    viewer: null,
    digest,
    alerts: [],
    tokenUsed: 0,
    tokenCap: 0,
    aiArchetypes: archetypes,
  });
  assert.equal(spectator.factions.some((f) => f.exact !== undefined), false, '观战端不泄露 exact');
  assert.equal(spectator.factions.find((f) => f.id === other)?.aiArchetype, 'turtle');
});


test('★AI 原型在网页与酒馆列国面板有可见标签', () => {
  const web = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
  assert.match(web, /AI_STYLE_LABEL/, 'web/app.js 缺 AI 原型标签');
  const css = readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.style-tag/, 'web/style.css 缺 AI 原型标签样式');
  const ext = readFileSync(new URL('../../extensions/sillytavern-guozhan/index.js', import.meta.url), 'utf8');
  assert.match(ext, /GZH_AI_STYLE/, '酒馆前端缺 AI 原型标签');
  const extCss = readFileSync(new URL('../../extensions/sillytavern-guozhan/panel.css', import.meta.url), 'utf8');
  assert.match(extCss, /\.gzh-ai-style/, '酒馆面板缺 AI 原型标签样式');
});
