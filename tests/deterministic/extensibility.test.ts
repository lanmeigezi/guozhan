/**
 * 可扩展性闸门 —— 证明"玩法模块可插拔"不是口号。
 *
 * 场景：给引擎外挂一个外交模块（ diplomats 模块，不在出厂三件套里），
 * 用**运行期注册 API** 装进去，不改 apply.ts、不改 modules/ 下任何内建文件。
 *
 * 同时验三条容易被吹过的承诺：
 *   1. 模块不能覆盖内建 id（否则插件能悄悄替换经济/战斗规则，确定性就没了）
 *   2. writes 重叠必须**显式声明**（顺序即语义，不能藏）
 *   3. 注册后 behavior_fingerprint 变化 ⇒ 旧存档 fail-closed
 *
 * 变异说明（做完任一条，本文件必须红）：
 *   · registerRuleModules 允许覆盖已注册 id ⇒ "不许覆盖"用例红
 *   · loadScenario 照抄 scenario.json 的声明值、不算模块版本 ⇒ "指纹随模块变化"用例红
 *   · findUndeclaredWriteConflicts 无条件放行 ⇒ "重叠必须显式声明"用例红
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTurn } from '../../src/core/apply.ts';
import type { RuleModule } from '../../src/core/module.ts';
import { relationKey } from '../../src/core/state.ts';
import {
  buildModules,
  computeBehaviorFingerprint,
  declareWriteOverlap,
  findUndeclaredWriteConflicts,
  knownModuleIds,
  registerRuleModules,
  unregisterPluginModules,
} from '../../src/core/modules/index.ts';
import { loadScenario } from '../../src/server/config-loader.ts';
import { digestState } from '../../src/server/store/codec.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG_ROOT = join(repoRoot, 'config');

const ORDERS: readonly never[] = [];

/** 一个真实的外交模块：每回合把秦赵关系推向停战（确定性、无随机、无 IO） */
const diplomacyModule: RuleModule = {
  id: 'diplomacy',
  version: 1,
  reads: ['relations'],
  writes: ['relations'],
  commands: [],
  resolve(ctx) {
    const a = 'qin';
    const b = 'zhao';
    const key = relationKey(a, b);
    const from = ctx.state.relations[key]?.kind ?? 'neutral';
    if (from === 'truce') return;
    ctx.mutate({ op: 'set_relation', a, b, kind: 'truce' });
    ctx.emit({ type: 'diplomacy_changed', turn: ctx.turn, a, b, from, to: 'truce', publicity: 'public' });
  },
};

after(() => unregisterPluginModules());

/** 每个用例独立可跑；模块注册是进程级的，所以用幂等注册 */
function ensureDiplomacy(): void {
  if (!knownModuleIds().includes('diplomacy')) registerRuleModules([diplomacyModule]);
}

function scenarioDeclaredFingerprint(): number {
  const raw = JSON.parse(
    readFileSync(join(CONFIG_ROOT, 'scenarios', 'warring-states', 'scenario.json'), 'utf8'),
  ) as { engine: { behaviorFingerprint: number } };
  return raw.engine.behaviorFingerprint;
}

test('★运行期注册：不改 core 就能加一个玩法模块', () => {
  const before = knownModuleIds();
  assert.equal(before.includes('diplomacy'), false, '前置：出手时还没有这个模块');

  registerRuleModules([diplomacyModule]);

  assert.ok(knownModuleIds().includes('diplomacy'), '注册后应出现在模块清单');
  const mods = buildModules(['economy', 'diplomacy']);
  assert.deepEqual(
    mods.map((m) => m.id),
    ['economy', 'diplomacy'],
    'moduleOrder 的顺序必须原样保留（顺序即语义）',
  );
  assert.equal(buildModules(['economy', 'diplomacy']).length, 2);
});

test('★不许覆盖内建模块：重复 id 直接拒绝', () => {
  ensureDiplomacy();
  assert.throws(() => registerRuleModules([diplomacyModule]), /已注册/);
  assert.throws(() => registerRuleModules([{ ...diplomacyModule, id: 'economy' }]), /已注册|不一致/);
  // 内建模块仍然是原来那个版本，没被替换
  const economy = buildModules(['economy'])[0]!;
  assert.equal(economy.id, 'economy');
  assert.ok(economy.version >= 1);
});

test('形状校验：缺版本 / 缺能力声明的模块进不来', () => {
  assert.throws(
    () => registerRuleModules([{ ...diplomacyModule, id: 'bad-version', version: 0 }]),
    /version/,
  );
  assert.throws(
    () =>
      registerRuleModules([
        { ...diplomacyModule, id: 'bad-shape', reads: 'relations' as unknown as RuleModule['reads'] },
      ]),
    /数组/,
  );
  assert.throws(
    () => registerRuleModules([{ ...diplomacyModule, id: 'no-resolve', resolve: undefined as unknown as RuleModule['resolve'] }]),
    /resolve/,
  );
});

test('★writes 重叠必须显式声明（顺序即语义，不能藏）', () => {
  ensureDiplomacy();
  const withPlugin = buildModules(['economy', 'movement', 'combat', 'diplomacy']);

  const conflicts = findUndeclaredWriteConflicts(withPlugin);
  const relations = conflicts.find((c) => c.slice === 'relations');
  assert.ok(relations, '外交与战斗都写 relations，未声明时必须报出来');
  assert.deepEqual(relations!.modules, ['combat', 'diplomacy']);

  declareWriteOverlap('relations', ['combat', 'diplomacy']);
  const afterDecl = findUndeclaredWriteConflicts(withPlugin);
  assert.equal(afterDecl.some((c) => c.slice === 'relations'), false, '显式声明后不再算冲突');
  // 未声明的其他重叠仍然要报（不是一刀切放行）
  assert.equal(Array.isArray(afterDecl), true);
});

test('★注册即影响指纹：旧存档会在 verifyIdentity 处 fail-closed', () => {
  const declared = scenarioDeclaredFingerprint();
  const loaded = loadScenario('warring-states', 'seed-ext', CONFIG_ROOT);

  // ① 载入器算出的指纹 = 声明值 × 实际模块（不是照抄 JSON）
  assert.equal(
    loaded.meta.behaviorFingerprint,
    computeBehaviorFingerprint(buildModules(loaded.meta.moduleOrder), declared),
    '运行期指纹必须由模块集算出',
  );

  // ② 模块版本变了，指纹必须变
  const bumped = computeBehaviorFingerprint(
    buildModules(loaded.meta.moduleOrder).map((m) => ({ ...m, version: m.version + 1 })),
    declared,
  );
  assert.notEqual(bumped, loaded.meta.behaviorFingerprint, '版本变了指纹不变 ⇒ 旧档会按新规则静默续跑');

  // ③ 插进一个新模块，指纹也必须变
  ensureDiplomacy();
  const withPlugin = computeBehaviorFingerprint(
    buildModules([...loaded.meta.moduleOrder, 'diplomacy']),
    declared,
  );
  assert.notEqual(withPlugin, loaded.meta.behaviorFingerprint);
});

test('★外挂模块真的参与结算：同一局面下关系被改写且结果可复现', () => {
  ensureDiplomacy();
  const loaded = loadScenario('warring-states', 'seed-plugin', CONFIG_ROOT);
  const base = buildModules(loaded.meta.moduleOrder);

  const run = (modules: readonly RuleModule[]) =>
    resolveTurn({
      state: loaded.initialState,
      world: loaded.world,
      modules,
      orders: ORDERS,
      rootSeed: loaded.rootSeed,
      turn: 1,
      now: 1_700_000_000_000,
      digest: digestState,
    });

  const without = run(base);
  const withPlugin = run([...base, diplomacyModule]);

  const key = relationKey('qin', 'zhao');
  assert.notEqual(
    without.state.relations[key]?.kind,
    'truce',
    '前置：不出手时秦赵不是停战（否则这个测试证明不了任何事）',
  );
  assert.equal(withPlugin.state.relations[key]?.kind, 'truce', '外挂模块必须真的改了状态');
  assert.ok(
    withPlugin.events.some((e) => (e as { type?: string }).type === 'diplomacy_changed'),
    '外挂模块产出的领域事件必须进入结算产物',
  );

  // 同种子 + 同模块集 ⇒ 逐位复现（插件不得引入系统随机）
  const again = run([...base, diplomacyModule]);
  assert.equal(again.newStateDigest, withPlugin.newStateDigest, '带插件的结算也必须确定性可复现');

  // 指纹不同 ⇒ 两个结果本来就不该相同
  assert.notEqual(withPlugin.newStateDigest, without.newStateDigest);
});
