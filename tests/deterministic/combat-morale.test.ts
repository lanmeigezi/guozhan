// combat-morale.test.ts — 守城成功的士气加成 / 夺回失地的民心加成。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import type { GameState } from '../../src/core/state.ts';
import type { AcceptedOrder } from '../../src/core/module.ts';

const SEED = 'combat-morale-seed-0001';
const sc = loadScenario('random-front-v2', SEED, 'config');
const MODULES = buildModules(sc.meta.moduleOrder);
const digest = (s: GameState): string => sha256(stableStringify(s));

function order(fid: string, command: Record<string, unknown>, index: number): AcceptedOrder {
  return { seatId: fid, factionId: fid, command, kind: String(command['kind']), index } as AcceptedOrder;
}

function run(state: GameState, orders: readonly AcceptedOrder[]): ReturnType<typeof resolveTurn> {
  return resolveTurn({
    state,
    world: sc.world,
    modules: MODULES,
    orders,
    rootSeed: SEED,
    turn: state.turn,
    now: 1_700_000_000_000,
    digest,
  });
}

function clone(): GameState {
  return JSON.parse(JSON.stringify(sc.initialState)) as GameState;
}

function firstAttack(state: GameState, needDefenders = false) {
  const fid = Object.keys(state.factions).sort()[0]!;
  const attacks = enumerateLegalActions(state, sc.world, fid, { maxActions: 200 }).filter((a) => a.kind === 'attack');
  const action = needDefenders
    ? attacks.find((a) => {
        const rid = String(a.command['targetRegion']);
        const owner = state.regions[rid]!.owner;
        return owner != null && owner !== fid &&
          Object.values(state.units).some((u) => u.regionId === rid && u.ownerId === owner);
      })
    : attacks[0];
  assert.ok(action, '夹具失效：找不到合法进攻');
  return { fid, action };
}

test('守城成功：进攻未能破城（僵持/击退），守方获得 +3 士气（民心）', () => {
  const state = clone();
  const { fid, action } = firstAttack(state, true);
  const rid = String(action.command['targetRegion']);
  const defender = state.regions[rid]!.owner;
  assert.ok(defender && defender !== fid, '夹具失效：目标应是敌方区域');
  // 攻方只留 1 兵：破不了城（僵持/被击退）
  const unitId = String(action.command['unitId']);
  (state.units[unitId] as { troops: number }).troops = 1;

  const out = run(state, [order(fid, { ...action.command, commitment: 0.1 }, 0)]);
  assert.equal(out.events.filter((e) => e.type === 'combat_resolved').length, 1);
  assert.equal(out.events.some((e) => e.type === 'region_captured'), false, '不该夺城');
  const bonus = out.deltas.find(
    (d) => d.scope === `faction:${defender}` && d.field === 'morale' && /士气大振/.test(d.reason),
  );
  assert.ok(bonus, '守城成功应给守方士气加成');
  assert.equal(bonus.delta, 3);
});

test('夺回失地：除攻取 +5 外再给 +6 民心，且只在收复时给', () => {
  const state = clone();
  const { fid, action } = firstAttack(state);
  const rid = String(action.command['targetRegion']);
  const enemy = state.regions[rid]!.owner;
  assert.ok(enemy && enemy !== fid);

  // 构造「我们曾经拥有、现在被敌人占着」：清空该区守军 → 必胜
  (state.regions[rid] as { owner: string }).owner = enemy!;
  (state.regions[rid] as { lastOwner?: string }).lastOwner = fid;
  for (const [uid, u] of Object.entries(state.units)) {
    if (u.regionId === rid && u.ownerId !== fid) delete state.units[uid];
  }

  const out = run(state, [order(fid, { ...action.command, commitment: 1 }, 0)]);
  assert.ok(out.events.some((e) => e.type === 'region_captured'), '清空守军后应夺城');
  const capture = out.deltas.find((d) => d.scope === `faction:${fid}` && d.field === 'morale' && /攻取/.test(d.reason));
  const recap = out.deltas.find((d) => d.scope === `faction:${fid}` && d.field === 'morale' && /收复故土/.test(d.reason));
  assert.ok(capture && capture.delta === 5, '基础夺城 +5 仍在');
  assert.ok(recap, '收复失地应额外给民心');
  assert.equal(recap.delta, 6);

  // 反例：同一构造但 lastOwner 不是自己 → 不给收复加成
  const state2 = clone();
  const a2 = firstAttack(state2);
  const rid2 = String(a2.action.command['targetRegion']);
  const enemy2 = state2.regions[rid2]!.owner!;
  (state2.regions[rid2] as { owner: string }).owner = enemy2;
  (state2.regions[rid2] as { lastOwner?: string }).lastOwner = null;
  for (const [uid, u] of Object.entries(state2.units)) {
    if (u.regionId === rid2 && u.ownerId !== a2.fid) delete state2.units[uid];
  }
  const out2 = run(state2, [order(a2.fid, { ...a2.action.command, commitment: 1 }, 0)]);
  assert.ok(out2.events.some((e) => e.type === 'region_captured'));
  assert.equal(
    out2.deltas.some((d) => d.field === 'morale' && /收复故土/.test(d.reason)),
    false,
    '不是自己的旧土不应给收复加成',
  );
});
