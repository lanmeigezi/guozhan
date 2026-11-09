import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/server/loader.js';
import { createGame, computeStateId, serialize, restore, snapshotFor } from '../src/core/state.js';
import { validateDecisions, validateDmEdits, legalActions } from '../src/core/commands.js';
import { advanceTurn } from '../src/core/engine.js';
import { canonical } from '../src/core/rng.js';

const config = loadConfig();
const { rules, monarchs, world } = config;
const game = (seed = 'unit-seed') => createGame({ rules, monarchs, worldCfg: world, seed });
const cloned = (overrides = {}) => JSON.parse(JSON.stringify({ ...rules, ...overrides }));

function decision(civId, type, extra = {}) {
    return { civId, type, target: null, magnitude: 1, note: '', ...extra };
}
function digest(state) {
    return canonical({
        turn: state.turn, year: state.year, rngState: state.rngState,
        regions: state.regions, civs: state.civs, chronicle: state.chronicle,
        decisions: state.decisions, dmEdits: state.dmEdits, winner: state.winner,
    });
}
function play(state, rulesToUse = rules) {
    const legal = legalActions(state, 'civ-01', rulesToUse);
    const research = legal.actions.find((a) => a.type === 'research');
    if (research) state.decisions['civ-01'] = { ...research.command, note: '' };
    state.dmEdits = [{ type: 'boost', target: 'civ-01', region: null, magnitude: 1, note: '' }];
    return advanceTurn(state, rulesToUse);
}

test('同一种子 + 同一命令序列逐位一致（RNG 状态可序列化）', () => {
    const a = game('repeat-me');
    const b = game('repeat-me');
    play(a); play(a);
    play(b); play(b);
    assert.equal(digest(a), digest(b));
    assert.equal(a.rngState, b.rngState);
});

test('不同种子产生不同世界', () => {
    const a = game('seed-A');
    const b = game('seed-B');
    assert.notEqual(a.regions[3].name, b.regions[3].name);
    assert.notEqual(digest(a), digest(b));
});

test('命令闸门：严格字段 / 未知行动 / 强度越界 / 时代前置', () => {
    const s = game();
    assert.equal(validateDecisions(s, [decision('civ-01', 'nope')], rules).rejections[0].code, 'UNKNOWN_ACTION');
    assert.equal(validateDecisions(s, [{ ...decision('civ-01', 'research'), hack: 1 }], rules).rejections[0].code, 'MALFORMED_PAYLOAD');
    assert.equal(validateDecisions(s, [decision('civ-01', 'research', { magnitude: 9 })], rules).rejections[0].code, 'ACTION_MAGNITUDE_OUT_OF_RANGE');
    assert.equal(validateDecisions(s, [decision('civ-01', 'colonize')], rules).rejections[0].code, 'EPOCH_TOO_LOW');
    assert.equal(validateDecisions(s, [decision('civ-404', 'research')], rules).rejections[0].code, 'UNKNOWN_CIV');
});

test('命令闸门：资源不足与邻接约束由引擎裁决', () => {
    const s = game();
    s.civs[0].resources.ore = 0;
    const r = validateDecisions(s, [decision('civ-01', 'fortify')], rules);
    assert.equal(r.rejections[0]?.code, 'INSUFFICIENT_RESOURCE');
    const far = s.regions.find((x) => x.owner === null && !(s.adjacency[x.index] ?? []).some((i) => s.regions[i]?.owner === 'civ-01'));
    if (far) {
        const r2 = validateDecisions(s, [decision('civ-01', 'expand', { target: far.id })], rules);
        assert.ok(['REGION_NOT_ADJACENT', 'MALFORMED_PAYLOAD'].includes(r2.rejections[0]?.code));
    }
});

test('DM 闸门：类型白名单与单回合预算', () => {
    const s = game();
    assert.equal(validateDmEdits(s, [{ type: 'nuke', magnitude: 1 }], rules).rejections[0].code, 'DM_EDIT_NOT_ALLOWED');
    const many = Array.from({ length: rules.dm.maxEditsPerTurn + 1 }, () => ({ type: 'boost', target: 'civ-01', magnitude: 1 }));
    assert.equal(validateDmEdits(s, many, rules).rejections[0].code, 'DM_BUDGET_EXCEEDED');
    assert.equal(validateDmEdits(s, [{ type: 'boost', magnitude: 9 }], rules).rejections[0].code, 'DM_MAGNITUDE_OUT_OF_RANGE');
});

test('旋钮 1：dm.weight 直接放大 DM 修正效果', () => {
    const low = game('knob');
    const high = game('knob');
    const rLow = cloned({ dm: { ...rules.dm, weight: 0 } });
    const rHigh = cloned({ dm: { ...rules.dm, weight: 1 } });
    for (const s of [low, high]) {
        s.dmEdits = [{ type: 'boost', target: 'civ-01', region: null, magnitude: 3, note: '' }];
        advanceTurn(s, s === low ? rLow : rHigh);
    }
    assert.ok(high.civs[0].tech > low.civs[0].tech, 'DM 权重高时科技应显著更高');
});

test('旋钮 2：simulation.strength 控制自然演化速度', () => {
    const still = game('knob2');
    const wild = game('knob2');
    const rStill = cloned({ simulation: { ...rules.simulation, strength: 0 } });
    const rWild = cloned({ simulation: { ...rules.simulation, strength: 1 } });
    advanceTurn(still, rStill);
    advanceTurn(wild, rWild);
    assert.ok(wild.civs[0].resources.food > still.civs[0].resources.food, '推演强度高时自然产出更多');
});

test('胜利判定：星际时代 + 两处殖民地', () => {
    const s = game('winner');
    s.civs[0].tech = rules.victory.requiredTech + 50;
    s.civs[0].colonies = rules.victory.requiredColonies;
    const result = advanceTurn(s, rules);
    assert.equal(result.winner, 'civ-01');
    assert.equal(s.phase, 'ended');
    assert.match(result.report, /星际文明/);
    assert.equal(validateDecisions(s, [decision('civ-02', 'research')], rules).rejections[0].code, 'MATCH_FINISHED');
});

test('快照视角隔离：君主看不到他国精确数值', () => {
    const s = game('view');
    const dm = snapshotFor(s, null);
    const seat = snapshotFor(s, 'civ-01');
    assert.equal(dm.perspective, 'dm');
    assert.equal(seat.perspective, 'civ-01');
    assert.equal(typeof seat.civs.find((c) => c.id === 'civ-01').tech, 'number');
    const other = seat.civs.find((c) => c.id === 'civ-02');
    assert.equal(other.visibility, 'masked');
    assert.equal(other.tech, undefined);
    assert.equal(typeof other.techTier, 'number');
});

test('stateId 是 CAS 锚点：局面变化才换版本，同回合并发下令互不冲突', () => {
    const s = game('cas');
    const before = computeStateId(s);
    s.decisions['civ-01'] = decision('civ-01', 'research');
    s.decisions['civ-02'] = decision('civ-02', 'research');
    assert.equal(computeStateId(s), before, '同一回合内不同席位提交意图不应改变 stateId');
    s.regions[0].development += 1;
    assert.notEqual(computeStateId(s), before, '局面变化必须换 stateId');
});

test('存档恢复后可继续推演且结果一致', () => {
    const a = game('save');
    play(a);
    const saved = serialize(a);
    const b = restore(saved, rules);
    assert.equal(digest(a), digest(b));
    play(a);
    play(b);
    assert.equal(digest(a), digest(b));
    assert.equal(a.chronicle.length, b.chronicle.length);
});
