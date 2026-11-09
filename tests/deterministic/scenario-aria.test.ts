/**
 * 架空剧本「aria」闸门 —— 扩展性承诺的机器证据。
 *
 * ★为什么必须有第二个剧本的专属测试：架构文档 §6.1 声称"加剧本不改任何代码，
 *   剧本发现走目录扫描"。只有一个剧本时这句话无法证伪；有了 aria，
 *   本测试证明：发现 → 装载 → 无 NaN → 5 回合确定性重放，全程零代码改动。
 *   Histrategy 正是在这里翻的车（剧本 id 白名单硬编码，加剧本要改 2-3 处代码）。
 *
 * 零依赖，裸 Node 可跑：
 *   node --experimental-strip-types --test tests/deterministic/scenario-aria.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverScenarios, loadScenario, sha256, stableStringify, findHoles } from '../../src/server/config-loader.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import type { GameState } from '../../src/core/state.ts';
import type { AcceptedOrder } from '../../src/core/module.ts';

const SCENARIO = 'aria';
const SEED = 'aria-test-seed-fixed-001';
const FIXED_NOW = 1_700_000_000_000;

const digest = (s: GameState): string => sha256(stableStringify(s));

function order(seatId: string, factionId: string, command: Record<string, unknown>): AcceptedOrder {
  return { seatId, factionId, command, kind: command['kind'] as string };
}

function simulate(
  seed: string,
  turns: number,
  ordersPerTurn: (turn: number) => readonly AcceptedOrder[] = () => [],
): { final: GameState; digests: string[]; combatEvents: number } {
  const sc = loadScenario(SCENARIO, seed);
  const mods = buildModules(sc.meta.moduleOrder);
  let state = sc.initialState;
  const digests: string[] = [digest(state)];
  let combatEvents = 0;
  for (let t = 1; t <= turns; t++) {
    state = { ...state, turn: t };
    const outcome = resolveTurn({
      state,
      world: sc.world,
      modules: mods,
      orders: ordersPerTurn(t),
      rootSeed: seed,
      turn: t,
      now: FIXED_NOW + t * 1000,
      digest,
    });
    combatEvents += outcome.events.filter((e: any) => e.type === 'combat_resolved').length;
    state = outcome.state;
    digests.push(outcome.newStateDigest);
  }
  return { final: state, digests, combatEvents };
}

// ─────────────────────────────────────────────────────────────
// 发现与装载（扩展性承诺：零代码改动）
// ─────────────────────────────────────────────────────────────

test('★aria 能被 discoverScenarios() 目录扫描发现（不是白名单）', () => {
  const found = discoverScenarios();
  assert.ok(found.includes('aria'), `未发现 aria，实得：${found.join(', ')}`);
  assert.ok(found.includes('warring-states'), '两个剧本应同时被发现');
  assert.ok(found.length >= 2, '至少应有两个剧本，否则扩展性承诺无法证伪');
});

test('aria 能被 loadScenario() 装载：6 势力 / 19 区域 / 复用同一张地图', () => {
  const sc = loadScenario(SCENARIO, SEED);
  assert.equal(sc.meta.id, 'aria');
  assert.equal(sc.meta.name, '艾利亞：星冠崩碎');
  assert.equal(Object.keys(sc.initialState.factions).length, 6, 'aria 应有 6 个架空势力');
  assert.equal(Object.keys(sc.initialState.regions).length, 19, 'aria 必须复用同一张 19 区域地图（地图与剧本解耦）');
  assert.equal(sc.world.scenarioId, 'aria');
  // 与战国剧本共享同一张地图 ⇒ regions 定义逐字段一致
  const ws = loadScenario('warring-states', SEED);
  assert.deepEqual(sc.world.regions, ws.world.regions, '两个剧本的地图定义必须完全一致（复用 regions.json）');
  // 但剧本内容哈希必须不同（否则说明装载器没把剧本算进哈希）
  assert.notEqual(sc.contentHash, ws.contentHash, '不同剧本的 contentHash 必须不同');
  // 席位配置
  assert.deepEqual(sc.meta.seats.majorAi, ['emberfall', 'drakmoor', 'aurelia']);
  assert.deepEqual(sc.meta.seats.minorAi, ['valkyr', 'thornwall', 'verdantholm']);
  const overlap = sc.meta.seats.majorAi.filter((x) => sc.meta.seats.minorAi.includes(x));
  assert.deepEqual(overlap, [], 'majorAi 与 minorAi 不得重叠');
  // 里程碑与预算降级
  assert.ok(sc.meta.milestones.length >= 3, '必须有硬性回合里程碑（防只种田）');
  assert.equal(sc.meta.budget.onExceed, 'degrade_to_deterministic');
});

test('★aria 装载后 findHoles() 无 NaN / undefined / Infinity', () => {
  const sc = loadScenario(SCENARIO, SEED);
  const holesWorld = findHoles(sc.world, 'world');
  assert.deepEqual(holesWorld, [], `WorldConfig(aria) 有空洞：${holesWorld.slice(0, 10).join(', ')}`);
  const holesInit = findHoles(sc.initialState, 'initialState');
  assert.deepEqual(holesInit, [], `aria 初始状态有空洞：${holesInit.slice(0, 10).join(', ')}`);
  // 每个势力开局资源必须是有限正数
  for (const [fid, f] of Object.entries(sc.initialState.factions)) {
    assert.ok(Number.isFinite(f.gold) && f.gold >= 0, `${fid}.gold 非法`);
    assert.ok(Number.isFinite(f.food) && f.food >= 0, `${fid}.food 非法`);
    assert.ok(Number.isFinite(f.manpower) && f.manpower > 0, `${fid}.manpower 非法（兵源池应由领土人口导出）`);
  }
});

// ─────────────────────────────────────────────────────────────
// 开局交战路径（OpenRA-RL '5 局零交锋' 对策）
// ─────────────────────────────────────────────────────────────

test('★aria 开局即有真实交战路径：燼落(emberfall)进攻中立圣所洛陽', () => {
  // 前提自查：guanzhong 与 luoyang 必须相邻（测试前提错了比断言错了更难发现）
  const sc = loadScenario(SCENARIO, SEED);
  assert.ok(
    sc.world.regions['guanzhong']!.adjacency.includes('luoyang'),
    '测试前提：關中必须与洛陽相邻',
  );
  assert.equal(sc.initialState.regions['luoyang']!.owner, null, '洛陽（星冠圣所）开局应为中立');
  assert.ok(sc.initialState.units['garrison_luoyang'], '洛陽应有中立驻军');

  const atk: (t: number) => readonly AcceptedOrder[] = (t) =>
    t === 1 ? [order('emberfall', 'emberfall', { kind: 'attack', unitId: 'u_ember_1', targetRegion: 'luoyang' })] : [];
  const r = simulate(SEED, 1, atk);
  assert.equal(r.combatEvents, 1, '开局第 1 回合就能打起来 —— 剧本不得重演零交锋');
  // 18000 槍兵 vs 5000 中立守军：必须真的攻下（宽松断言会让"打了但没打下"蒙混过关）
  assert.equal(r.final.regions['luoyang']!.owner, 'emberfall', '星冠圣所应被燼落攻取');
});

test('★aria 的 initialRelations 含 war，且交战双方领土接壤（战争不是纸面声明）', () => {
  const sc = loadScenario(SCENARIO, SEED);
  const rel = sc.initialState.relations;
  const warKeys = Object.entries(rel).filter(([, v]: [string, any]) => v.kind === 'war');
  assert.ok(warKeys.length >= 1, 'aria 必须至少有一处初始战争');
  // emberfall 与 drakmoor 接壤：guanzhong↔hedong
  const adjacency = sc.world.regions;
  const emberTerr = ['guanzhong', 'hanzhong', 'longxi'];
  const drakTerr = ['jinyang', 'hedong', 'shangdang'];
  const touching = emberTerr.some((t) => drakTerr.some((d) => adjacency[t]!.adjacency.includes(d)));
  assert.ok(touching, '交战双方领土必须接壤，否则战争无从开打');
});

// ─────────────────────────────────────────────────────────────
// ★确定性重放：跑 5 回合不抛异常且 digest 可复现
// ─────────────────────────────────────────────────────────────

test('★aria 同种子跑 5 回合：不抛异常、digest 逐位可复现', () => {
  const orders = (t: number): readonly AcceptedOrder[] =>
    t === 2
      ? [order('emberfall', 'emberfall', { kind: 'attack', unitId: 'u_ember_1', targetRegion: 'luoyang' })]
      : t === 4
        ? [order('aurelia', 'aurelia', { kind: 'recruit', regionId: 'linzi', unitType: 'swordsman', count: 5000 })]
        : [];
  const a = simulate(SEED, 5, orders);
  const b = simulate(SEED, 5, orders);
  assert.equal(a.digests.length, 6, '5 回合应有 6 个 digest（含初始）');
  assert.deepEqual(a.digests, b.digests, '同种子同命令的 digest 序列必须逐位相同');
  for (const [fid, f] of Object.entries(a.final.factions)) {
    assert.ok(Number.isFinite(f.gold) && Number.isFinite(f.food) && Number.isFinite(f.morale), `${fid} 出现非有限数`);
  }
  const holes = findHoles(a.final, 'finalState');
  assert.deepEqual(holes, [], `跑 5 回合后状态出现空洞：${holes.slice(0, 10).join(', ')}`);
});

test('★aria 换种子必须产生不同 digest（证明种子真的接进了结算）', () => {
  const atk: (t: number) => readonly AcceptedOrder[] = (t) =>
    t === 1 ? [order('emberfall', 'emberfall', { kind: 'attack', unitId: 'u_ember_1', targetRegion: 'luoyang' })] : [];
  const a = simulate(SEED, 3, atk);
  const b = simulate('a-totally-different-aria-seed', 3, atk);
  assert.notDeepEqual(a.digests, b.digests, '不同种子产生完全相同的结果 —— "固定种子"是假的');
});

test('aria 经济不得冻结：国库与粮草 5 回合内必须变化（Histrategy 数值惰性对策）', () => {
  const sc = loadScenario(SCENARIO, SEED);
  const mods = buildModules(sc.meta.moduleOrder);
  let state = sc.initialState;
  const golds: number[] = [];
  const foods: number[] = [];
  for (let t = 1; t <= 5; t++) {
    state = { ...state, turn: t };
    state = resolveTurn({
      state, world: sc.world, modules: mods, orders: [], rootSeed: SEED,
      turn: t, now: FIXED_NOW + t * 1000, digest,
    }).state;
    golds.push(state.factions['thornwall']!.gold);
    foods.push(state.factions['thornwall']!.food);
  }
  assert.ok(new Set(golds).size > 1, `荊墻領国库 5 回合恒为 ${golds[0]} —— 数值惰性`);
  assert.ok(new Set(foods).size > 1, '粮草 5 回合未变化');
});
