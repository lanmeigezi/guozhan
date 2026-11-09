/**
 * 配置层闸门 —— 数据驱动配置的自洽性。
 *
 * 这里编码的是**任务书与调研结论的硬性要求**，不是可协商的偏好：
 *   · 地图 16-20 个区域（任务书原文要求）
 *   · 邻接表必须对称（否则寻路与"相邻才能打"会出静默 bug）
 *   · adjacency 必须字典序排序（否则 JSON 键序变化会破坏确定性）
 *   · 每个非中立区域恰好属于一个势力（防"一块地两国同时拥有"的静默错账）
 *   · 剧本发现走目录扫描（Histrategy 硬编码白名单是它的坑，我们不学）
 *
 * 零依赖（只用 node:fs/path/assert）：
 *   node --experimental-strip-types --test tests/deterministic/config.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LAW_EFFECT_KEYS } from '../../src/core/state.ts';
import { ALERT_KINDS } from '../../src/ai/alert-kinds.ts';

const ROOT = 'config';

function readJson(rel: string): any {
  const p = join(ROOT, rel);
  assert.ok(existsSync(p), `配置文件缺失：${p}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** 剧本发现 = 目录扫描，不是白名单 */
function discoverScenarios(): string[] {
  const dir = join(ROOT, 'scenarios');
  assert.ok(existsSync(dir), `剧本根目录缺失：${dir}`);
  return readdirSync(dir)
    .filter((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() && existsSync(join(full, 'scenario.json'));
    })
    .sort();
}

const regionsDoc = readJson('map/regions.json');
const unitsDoc = readJson('rules/units.json');
const combat = readJson('rules/combat.json');
const economy = readJson('rules/economy.json');
const laws = readJson('rules/laws.json');
const alerts = readJson('rules/alerts.json');
const movement = readJson('rules/movement.json');

const REGIONS: any[] = regionsDoc.regions;
const UNITS: any[] = unitsDoc.unitTypes;
const LAW_LIST: any[] = laws.laws;
const ALERT_LIST: any[] = alerts.alerts;
const regionIds = new Set<string>(REGIONS.map((r) => r.id));
const unitIds = new Set<string>(UNITS.map((u) => u.id));
const lawIds = new Set<string>(LAW_LIST.map((l) => l.id));
const terrainIds = new Set<string>(Object.keys(combat.terrainModifier));

// ─────────────────────────────────────────────────────────────
// 地图
// ─────────────────────────────────────────────────────────────

test('★任务书要求：地图 16-20 个区域', () => {
  assert.ok(
    REGIONS.length >= 16 && REGIONS.length <= 20,
    `区域数 ${REGIONS.length} 不在任务书要求的 16-20 区间内`,
  );
});

test('区域 id 唯一且命名合法（会进 SQLite 与文件名）', () => {
  assert.equal(regionIds.size, REGIONS.length, '存在重复区域 id');
  for (const r of REGIONS) {
    assert.match(r.id, /^[a-z0-9][a-z0-9_-]*$/, `区域 id 非法：${r.id}`);
    assert.ok(typeof r.name === 'string' && r.name.length > 0, `${r.id} 缺 name`);
  }
});

test('邻接表：目标存在、无自环、无重复', () => {
  for (const r of REGIONS) {
    assert.ok(Array.isArray(r.adjacency), `${r.id} 缺 adjacency`);
    for (const n of r.adjacency) {
      assert.ok(regionIds.has(n), `${r.id} 的邻居 ${n} 不存在`);
      assert.notEqual(n, r.id, `${r.id} 不能与自己相邻`);
    }
    assert.equal(
      new Set(r.adjacency).size,
      r.adjacency.length,
      `${r.id} 的 adjacency 有重复项`,
    );
  }
});

test('★邻接表必须对称（a→b 则 b→a），否则寻路单向可走、反向不可走', () => {
  const bad: string[] = [];
  for (const r of REGIONS) {
    for (const n of r.adjacency) {
      const other = REGIONS.find((x) => x.id === n);
      if (!other || !other.adjacency.includes(r.id)) bad.push(`${r.id} -> ${n}`);
    }
  }
  assert.deepEqual(bad, [], `邻接不对称：${bad.join(', ')}`);
});

test('★adjacency 必须字典序排序（JSON 顺序变化不得影响结算结果）', () => {
  for (const r of REGIONS) {
    const sorted = [...r.adjacency].sort();
    assert.deepEqual(
      r.adjacency,
      sorted,
      `${r.id}.adjacency 未排序：${JSON.stringify(r.adjacency)} 应为 ${JSON.stringify(sorted)}`,
    );
  }
});

test('地图必须连通（不能有打不到的孤岛）', () => {
  const adj = new Map<string, string[]>(REGIONS.map((r) => [r.id as string, r.adjacency as string[]]));
  const start = REGIONS[0]!.id as string;
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const n of adj.get(cur) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  const missing = [...regionIds].filter((id) => !seen.has(id)).sort();
  assert.deepEqual(missing, [], `以下区域与主图不连通：${missing.join(', ')}`);
});

test('地形 id 必须在 combat.terrainModifier 里有定义', () => {
  for (const r of REGIONS) {
    assert.ok(terrainIds.has(r.terrain), `${r.id} 的地形 ${r.terrain} 未在 combat.json 定义`);
  }
});

test('区域基础产出必须为正数、passable/strategic 必须是布尔', () => {
  for (const r of REGIONS) {
    for (const k of ['baseFood', 'baseGold', 'baseManpower']) {
      assert.ok(
        typeof r[k] === 'number' && Number.isFinite(r[k]) && r[k] > 0,
        `${r.id}.${k} 必须为正数，实得 ${r[k]}`,
      );
    }
    assert.equal(typeof r.passable, 'boolean', `${r.id}.passable 必须是布尔`);
    assert.equal(typeof r.strategic, 'boolean', `${r.id}.strategic 必须是布尔`);
  }
});

// ─────────────────────────────────────────────────────────────
// 兵种 / 战斗 / 经济参数
// ─────────────────────────────────────────────────────────────

test('兵种：id 唯一、数值合法、克制表指向真实兵种', () => {
  assert.equal(unitIds.size, UNITS.length, '兵种 id 重复');
  for (const u of UNITS) {
    for (const k of ['attack', 'defense', 'movement']) {
      assert.ok(
        Number.isInteger(u[k]) && u[k] >= 1,
        `${u.id}.${k} 必须为 ≥1 的整数，实得 ${u[k]}`,
      );
    }
    for (const k of ['recruitGold', 'recruitFood', 'recruitManpower', 'upkeepGold', 'upkeepFood']) {
      assert.ok(
        typeof u[k] === 'number' && u[k] >= 0,
        `${u.id}.${k} 必须 ≥0，实得 ${u[k]}`,
      );
    }
    if (u.counters) {
      for (const target of Object.keys(u.counters)) {
        assert.ok(unitIds.has(target), `${u.id} 克制了不存在的兵种 ${target}`);
        assert.notEqual(target, u.id, `${u.id} 不能克制自己`);
        const bonus = u.counters[target];
        assert.ok(
          typeof bonus === 'number' && bonus > -1 && bonus <= 3,
          `${u.id} 对 ${target} 的克制系数 ${bonus} 超出 (-1, 3]`,
        );
      }
    }
  }
});

test('战斗参数：钳制区间合法、阈值在 (0,1)、maxRounds ≥1', () => {
  const [lo, hi] = combat.casualtyClamp;
  assert.ok(lo > 0 && lo <= 1, `casualtyClamp 下界 ${lo} 应在 (0,1]`);
  assert.ok(hi >= 1, `casualtyClamp 上界 ${hi} 应 ≥1（否则 LLM 提示永远被压小）`);
  assert.ok(lo < hi, 'casualtyClamp 下界必须小于上界');
  assert.ok(combat.routThresholdRatio > 0 && combat.routThresholdRatio < 1, 'routThresholdRatio 应在 (0,1)');
  assert.ok(combat.capturePowerRatio >= 1, 'capturePowerRatio 应 ≥1，否则守方永远守不住');
  assert.ok(Number.isInteger(combat.maxRounds) && combat.maxRounds >= 1, 'maxRounds 必须为 ≥1 整数');
  assert.equal(typeof combat.requireAdjacency, 'boolean');
  for (const [t, m] of Object.entries(combat.terrainModifier as Record<string, any>)) {
    assert.ok(m.def > 0, `地形 ${t} 的 def 必须 >0`);
    assert.ok(Number.isInteger(m.mov) && m.mov >= 1, `地形 ${t} 的 mov 必须为 ≥1 整数`);
  }
});

test('经济参数：税率区间、征兵比例递减、钳制比例合法', () => {
  assert.ok(economy.taxMinRate < economy.taxMaxRate, '税率区间颠倒');
  assert.ok(economy.taxMinRate >= 0 && economy.taxMaxRate <= 1, '税率必须在 [0,1]');
  const tiers: any[] = economy.conscriptTiers;
  assert.ok(tiers.length >= 2, '动态征兵比例至少两档，否则不构成"按规模递减"');
  assert.equal(tiers[tiers.length - 1]!.popBelow, null, '最后一档必须是 popBelow:null（无上限兜底）');
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(
      tiers[i - 1]!.ratio >= tiers[i]!.ratio,
      `征兵比例必须随人口递减：第 ${i - 1} 档 ${tiers[i - 1]!.ratio} 应 ≥ 第 ${i} 档 ${tiers[i]!.ratio}`,
    );
  }
  assert.ok(economy.fatigueFloor > 0 && economy.fatigueFloor <= 1, 'fatigueFloor 应在 (0,1]');
  const c = economy.extremeClamp;
  for (const k of ['troopLoss', 'foodLoss', 'goldLoss']) {
    assert.ok(c[k] > 0 && c[k] <= 1, `extremeClamp.${k}=${c[k]} 应为损失上限比例 (0,1]`);
  }
  for (const k of ['troopGain', 'foodGain', 'goldGain']) {
    assert.ok(c[k] > 0, `extremeClamp.${k}=${c[k]} 必须 >0`);
  }
});

test('移动参数：每回合移动次数 ≥1、路径搜索有上限（防 DoS）', () => {
  assert.ok(movement.maxMovesPerUnitPerTurn >= 1);
  assert.ok(movement.pathSearchMaxNodes >= 1 && movement.pathSearchMaxNodes <= 100000);
});

// ─────────────────────────────────────────────────────────────
// 法令 / 告警
// ─────────────────────────────────────────────────────────────

test('★法令 effects 的键必须与 LAW_EFFECT_KEYS 单一真源一致', () => {
  assert.equal(lawIds.size, LAW_LIST.length, '法令 id 重复');
  const seen = new Set<string>();
  for (const l of LAW_LIST) {
    assert.ok(typeof l.enactGold === 'number' && l.enactGold >= 0, `${l.id}.enactGold 非法`);
    const keys = Object.keys(l.effects ?? {});
    assert.ok(keys.length > 0, `${l.id} 没有任何效果，是死配置`);
    for (const k of keys) {
      assert.ok(
        LAW_EFFECT_KEYS.includes(k),
        `法令 ${l.id} 的效果键 '${k}' 不在 LawEffects 白名单内（${LAW_EFFECT_KEYS.join(', ')}）—— 引擎不会读它，属于静默失效配置`,
      );
      seen.add(k);
    }
  }
  // 反向：白名单里的键至少被一条法令用到，否则说明白名单有死键
  const unused = LAW_EFFECT_KEYS.filter((k) => !seen.has(k));
  assert.deepEqual(unused, [], `LAW_EFFECT_KEYS 里这些键没有任何法令使用（死键）：${unused.join(', ')}`);
});

test('告警：kind 在白名单内、priority 为正整数、message 非空', () => {
  const ids = new Set<string>();
  for (const a of ALERT_LIST) {
    assert.ok(!ids.has(a.id), `告警 id 重复：${a.id}`);
    ids.add(a.id);
    assert.ok(
      (ALERT_KINDS as readonly string[]).includes(a.kind),
      `告警 ${a.id} 的 kind '${a.kind}' 不在 ALERT_KINDS 白名单内`,
    );
    assert.ok(Number.isInteger(a.priority) && a.priority >= 1, `${a.id}.priority 必须为 ≥1 整数`);
    assert.ok(typeof a.message === 'string' && a.message.length > 0, `${a.id}.message 不能为空`);
    assert.equal(typeof a.params, 'object', `${a.id}.params 必须是对象`);
  }
  // ★"该做没做"型告警必须存在 —— OpenRA-RL 只种田事故的直接对策
  const kinds = new Set(ALERT_LIST.map((a) => a.kind));
  assert.ok(
    kinds.has('turns_since_recruit_at_least') && kinds.has('turns_since_attack_at_least'),
    '缺少"该做而没做"型告警：OpenRA-RL 的 IDLE ARMY 只统计已存在的部队，' +
      'AI 根本没造兵时告警无从触发，导致 5 局零交锋。必须保留这两条。',
  );
});

// ─────────────────────────────────────────────────────────────
// 剧本（目录扫描，支持多剧本）
// ─────────────────────────────────────────────────────────────

const scenarios = discoverScenarios();

test('★剧本发现走目录扫描（不是硬编码白名单）', () => {
  assert.ok(scenarios.length >= 1, '未发现任何剧本');
  assert.ok(scenarios.includes('warring-states'), `应发现 warring-states，实得 ${scenarios.join(', ')}`);
});

for (const sid of scenarios) {
  test(`剧本 ${sid}：结构自洽`, () => {
    const sc = readJson(`scenarios/${sid}/scenario.json`);
    const fac = readJson(`scenarios/${sid}/factions.json`);
    const knowledge = (sc.knowledge ?? {}) as Record<string, string>;
    assert.equal(sc.meta.id, sid, `scenario.json 的 meta.id 必须等于目录名（${sid}）`);
    assert.ok(Number.isInteger(sc.meta.maxTurns) && sc.meta.maxTurns >= 2, 'maxTurns 必须 ≥2');
    assert.ok(sc.engine.moduleOrder.length >= 1, 'moduleOrder 不能为空');
    assert.ok(Number.isInteger(sc.engine.behaviorFingerprint), 'behaviorFingerprint 必须是整数');

    const factions: any[] = fac.factions;
    const fids = new Set<string>(factions.map((f) => f.id));
    assert.equal(fids.size, factions.length, '势力 id 重复');

    // 席位配置必须指向真实势力
    for (const key of ['humanCapable', 'majorAi', 'minorAi']) {
      for (const f of sc.seats[key] ?? []) {
        assert.ok(fids.has(f), `seats.${key} 里的 ${f} 不是真实势力`);
      }
    }
    // majorAi 与 minorAi 不得重叠（否则同一势力既走 LLM 又走启发式）
    const overlap = (sc.seats.majorAi ?? []).filter((x: string) => (sc.seats.minorAi ?? []).includes(x));
    assert.deepEqual(overlap, [], `majorAi 与 minorAi 重叠：${overlap.join(', ')}`);

    // 里程碑必须在终局之前
    for (const m of sc.milestones ?? []) {
      assert.ok(m.turn > 0 && m.turn < sc.meta.maxTurns, `里程碑 turn=${m.turn} 必须在 (0, maxTurns) 内`);
      assert.ok(Object.keys(m.require).length > 0, '里程碑必须有可校验的 require');
    }

    // ★生成型剧本没有静态 territories/mapFile；完整的地图/领地铁律由 random-map.test.ts 多种子验证。
    if (sc.generator !== undefined) {
      assert.equal(sc.generator.type, 'hexboard');
      assert.ok(Number.isInteger(sc.generator.version) && sc.generator.version >= 1);
      for (const [key, rel] of Object.entries(knowledge)) {
        assert.ok(
          existsSync(join(ROOT, 'scenarios', sid, rel)),
          `scenario.knowledge.${key} 指向不存在的文件：${rel}`,
        );
      }
      assert.ok(sc.budget.perSeatTokenCap > 0);
      assert.equal(sc.budget.onExceed, 'degrade_to_deterministic');
      return;
    }

    // ★第二/三模式可以有自己的地图/兵种/法令：用剧本自己的 knowledge 解析，
    //   不能拿共享 regions.json 的 id 集合去校验其他剧本的 a1/b2。
    const localRegions: Array<{ id: string }> = readJson(
      `scenarios/${sid}/${knowledge['mapFile'] ?? '../../map/regions.json'}`,
    ).regions;
    const localRegionIds = new Set<string>(localRegions.map((r) => r.id));
    const localUnits: Array<{ id: string }> = readJson(
      `scenarios/${sid}/${knowledge['unitsFile'] ?? '../../rules/units.json'}`,
    ).unitTypes;
    const localUnitIds = new Set<string>(localUnits.map((u) => u.id));
    const localLaws: Array<{ id: string }> = readJson(
      `scenarios/${sid}/${knowledge['lawsFile'] ?? '../../rules/laws.json'}`,
    ).laws;
    const localLawIds = new Set<string>(localLaws.map((l) => l.id));

    // ★领土归属：每个非中立区域恰好属于一个势力
    const ownedBy = new Map<string, string[]>();
    for (const f of factions) {
      for (const t of f.territories) {
        assert.ok(localRegionIds.has(t), `势力 ${f.id} 声称拥有不存在的区域 ${t}`);
        ownedBy.set(t, [...(ownedBy.get(t) ?? []), f.id]);
      }
    }
    const neutral = new Set<string>((fac.neutralTerritories ?? []).map((n: any) => n.id));
    const doubleOwned = [...ownedBy.entries()].filter(([, owners]) => owners.length > 1);
    assert.deepEqual(
      doubleOwned.map(([r, o]) => `${r}: ${o.join('+')}`),
      [],
      '存在被多个势力同时声称的区域（静默错账）',
    );
    const unowned = [...localRegionIds].filter((r) => !ownedBy.has(r) && !neutral.has(r)).sort();
    assert.deepEqual(unowned, [], `以下区域既非中立也无人拥有：${unowned.join(', ')}`);
    for (const n of neutral) {
      assert.ok(localRegionIds.has(n), `中立区域 ${n} 不存在`);
      // ★消息必须惰性构造：assert.ok 的第二个参数会**先求值**，
      //   若直接写 ownedBy.get(n)!.join() 则在断言本该通过时（n 正确地无人拥有）就崩了。
      const claimants = ownedBy.get(n);
      assert.ok(
        claimants === undefined,
        `中立区域 ${n} 同时被势力 ${(claimants ?? []).join('+')} 声称`,
      );
    }

    // 首都必须在自己的领土内
    for (const f of factions) {
      assert.ok(
        f.territories.includes(f.capital),
        `势力 ${f.id} 的首都 ${f.capital} 不在自己的领土 ${JSON.stringify(f.territories)} 内`,
      );
      assert.ok(fids.size >= 2, '至少需要两个势力');
      assert.ok(f.gold >= 0 && f.food >= 0, `${f.id} 初始资源不能为负`);
      assert.ok(f.morale >= 0 && f.morale <= 100, `${f.id}.morale=${f.morale} 应在 [0,100]`);
      assert.ok(
        f.taxRate >= economy.taxMinRate && f.taxRate <= economy.taxMaxRate,
        `${f.id}.taxRate=${f.taxRate} 超出经济参数允许的 [${economy.taxMinRate}, ${economy.taxMaxRate}]`,
      );
      for (const l of f.laws ?? []) {
        assert.ok(localLawIds.has(l), `${f.id} 启用了不存在的法令 ${l}`);
      }
    }

    // 部队：id 唯一、在自己的领土内、兵种存在、兵力为正
    const allUnitIds = new Set<string>();
    for (const f of factions) {
      for (const u of f.units ?? []) {
        assert.ok(!allUnitIds.has(u.id), `部队 id 重复：${u.id}`);
        allUnitIds.add(u.id);
        assert.ok(localUnitIds.has(u.type), `部队 ${u.id} 的兵种 ${u.type} 不存在`);
        assert.ok(f.territories.includes(u.region), `部队 ${u.id} 驻扎在 ${u.region}，但该区域不属于 ${f.id}`);
        assert.ok(Number.isInteger(u.troops) && u.troops > 0, `${u.id}.troops 必须为正整数`);
      }
    }
    for (const n of fac.neutralTerritories ?? []) {
      assert.ok(localUnitIds.has(n.garrison.type), `中立区 ${n.id} 的驻军兵种 ${n.garrison.type} 不存在`);
      assert.ok(n.garrison.troops > 0, `中立区 ${n.id} 的驻军兵力必须 >0`);
    }

    // 初始关系必须指向真实势力，且不得自指
    for (const r of fac.initialRelations ?? []) {
      assert.ok(fids.has(r.a) && fids.has(r.b), `关系 ${r.a}-${r.b} 含不存在的势力`);
      assert.notEqual(r.a, r.b, '不能与自己建立关系');
      assert.ok(
        ['war', 'alliance', 'truce', 'peace', 'neutral'].includes(r.kind),
        `关系类型 ${r.kind} 非法`,
      );
    }

    // knowledge 引用的文件必须存在（相对剧本目录解析）
    for (const [key, rel] of Object.entries(sc.knowledge as Record<string, string>)) {
      const resolved = join(ROOT, 'scenarios', sid, rel);
      assert.ok(existsSync(resolved), `scenario.knowledge.${key} 指向不存在的文件：${resolved}`);
    }

    // 预算配置
    assert.ok(sc.budget.perSeatTokenCap > 0, 'perSeatTokenCap 必须 >0（否则 LLM 一次都调不了）');
    assert.ok(sc.budget.perTurnCallCap >= 1, 'perTurnCallCap 必须 ≥1');
    assert.equal(sc.budget.onExceed, 'degrade_to_deterministic', '预算耗尽必须降级为纯确定性，不能中断游戏');
  });
}

test('★开局必须至少有一处战争或可开战路径（否则重演 OpenRA-RL 的零交锋）', () => {
  for (const sid of scenarios) {
    const sc = readJson(`scenarios/${sid}/scenario.json`);
    // 生成型剧本的分区/战争关系随种子变化，由 random-map.test.ts 逐种子验证
    if (sc.generator !== undefined) continue;
    const fac = readJson(`scenarios/${sid}/factions.json`);
    const mapRel = (sc.knowledge?.mapFile as string | undefined) ?? '../../map/regions.json';
    const scenarioRegions: any[] = readJson(`scenarios/${sid}/${mapRel}`).regions;
    const wars = (fac.initialRelations ?? []).filter((r: any) => r.kind === 'war');
    const adjacentEnemyPairs: string[] = [];
    const ownerOf = new Map<string, string>();
    for (const f of fac.factions) for (const t of f.territories) ownerOf.set(t, f.id);
    for (const r of scenarioRegions) {
      for (const n of r.adjacency) {
        const a = ownerOf.get(r.id);
        const b = ownerOf.get(n);
        if (a && b && a !== b) adjacentEnemyPairs.push(`${a}@${r.id}-${b}@${n}`);
      }
    }
    assert.ok(
      wars.length >= 1 || adjacentEnemyPairs.length >= 1,
      `剧本 ${sid} 既无初始战争、也无接壤的敌对势力，开局不可能发生战斗`,
    );
  }
});
