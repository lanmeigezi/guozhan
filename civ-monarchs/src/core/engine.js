/**
 * 确定性推演引擎：所有数值、战斗、时代与胜利判定都在这里，LLM 零裁决权。
 * 顺序固定：君主意图 → DM 修正 → 自然演化（受 simulation.strength 缩放）→ 时代 → 胜负 → 编年史。
 */
import { createRng } from './rng.js';
import { civById, regionById, ownedRegions, epochIndexOf, isAdjacentToCiv } from './commands.js';
import { logChronicle, pushEvent, eventsSince } from './state.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = (v) => Math.round(v * 100) / 100;

function epochOf(rules, tech) {
    let current = rules.epochs[0];
    for (const e of rules.epochs) if (tech >= e.tech) current = e;
    return current;
}

function spend(civ, cost, magnitude) {
    for (const [res, amount] of Object.entries(cost ?? {})) civ.resources[res] -= amount * magnitude;
}

function record(state, kind, text, extra) {
    const entry = logChronicle(state, kind, text, extra);
    pushEvent(state, 'chronicle', { kind, text: entry.text, year: entry.year, turn: entry.turn });
}

/** 君主意图落地：只按规则表换算，绝不采纳模型给出的数字 */
function applyDecisions(state, rules) {
    for (const civId of Object.keys(state.decisions).sort()) {
        const d = state.decisions[civId];
        const civ = civById(state, civId);
        if (!d || !civ || !civ.alive) continue;
        const spec = rules.actions.types[d.type];
        if (!spec) continue;
        spend(civ, spec.cost, d.magnitude);
        const eff = spec.effect ?? {};
        let detail = '';
        if (eff.development) {
            const region = regionById(state, d.target) ?? ownedRegions(state, civId)[0];
            if (region) {
                region.development = round2(clamp(region.development + eff.development * d.magnitude, 0, rules.costs.developmentMax));
                detail = `${region.name}发展度至 ${region.development}`;
            }
        }
        if (eff.tech) { civ.tech = round2(civ.tech + eff.tech * d.magnitude); detail = `科技 +${eff.tech * d.magnitude}`; }
        if (eff.stability) { civ.stability = round2(clamp(civ.stability + eff.stability * d.magnitude, rules.costs.stabilityMin, rules.costs.stabilityMax)); detail = `民心 ${civ.stability}`; }
        if (eff.military) { civ.military = round2(clamp(civ.military + eff.military * d.magnitude, 0, rules.costs.militaryMax)); detail = `军备 ${civ.military}`; }
        if (eff.colonies) { civ.colonies += eff.colonies * d.magnitude; detail = `外星殖民地 ${civ.colonies}`; }
        if (eff.claim) {
            const region = regionById(state, d.target);
            if (region && region.owner === null) { region.owner = civ.id; detail = `取${region.name}`; }
        }
        if (eff.power) {
            const region = regionById(state, d.target);
            const defender = region?.owner ? civById(state, region.owner) : null;
            if (region && defender && defender.id !== civ.id) {
                const rng = createRng(state.seed, state.rngState);
                const attack = civ.military * d.magnitude * (0.85 + rng.next() * 0.3) + civ.tech / 60;
                const defend = defender.military * 0.6 + region.development * 5 + (defender.shield ? 40 : 0);
                state.rngState = rng.getState();
                if (attack > defend) {
                    region.owner = civ.id;
                    civ.military = round2(Math.max(0, civ.military - 4));
                    defender.military = round2(Math.max(0, defender.military - 6));
                    defender.stability = round2(clamp(defender.stability - 8, 0, 100));
                    detail = `克${region.name}（${defender.name}）`;
                } else {
                    civ.military = round2(Math.max(0, civ.military - 7));
                    detail = `攻${region.name}不克，折兵`;
                }
            }
        }
        const note = d.note ? `· ${String(d.note).replace(/[\r\n]/g, ' ').slice(0, 80)}` : '';
        record(state, 'decision', `【${civ.name}】${civ.monarch} ${spec.label}${detail ? `：${detail}` : ''}${note}`, { civId: civ.id, action: d.type });
    }
}

/** DM / Harness 修正：幅度统一乘 rules.dm.weight，这是视频第 2 条改造的核心旋钮 */
function applyDmEdits(state, rules) {
    const rng = createRng(`${state.seed}::dm`, state.rngState);
    for (const e of state.dmEdits) {
        const eff = rules.dm.effects[e.type] ?? {};
        const w = rules.dm.weight * e.magnitude;
        const civ = e.target ? civById(state, e.target) : null;
        const region = e.region ? regionById(state, e.region) : null;
        let detail = '';

        if (eff.tech) { if (civ) civ.tech = round2(civ.tech + eff.tech * w); detail = `科技 +${round2(eff.tech * w)}`; }
        if (eff.knowledge) { if (civ) civ.resources.knowledge = round2(civ.resources.knowledge + eff.knowledge * w); }
        if (eff.development) {
            const list = region ? [region] : (civ ? ownedRegions(state, civ.id) : []);
            for (const r of list) r.development = round2(clamp(r.development + eff.development * w, 0, rules.costs.developmentMax));
            detail = detail || `发展度调整 ×${round2(w)}`;
        }
        if (eff.population) {
            const list = region ? [region] : (civ ? ownedRegions(state, civ.id) : []);
            for (const r of list) r.population = round2(Math.max(rules.costs.populationMin, r.population * (1 + eff.population * w)));
            if (civ) civ.population = round2(Math.max(1, civ.population * (1 + eff.population * w)));
            detail = detail || `人口变动 ${Math.round(eff.population * w * 100)}%`;
        }
        if (eff.stability && civ) civ.stability = round2(clamp(civ.stability + eff.stability * w, 0, 100));
        if (eff.military && civ) civ.military = round2(clamp(civ.military + eff.military * w, 0, rules.costs.militaryMax));
        if (eff.shield && civ) { civ.shield = 1; detail = detail || `护国（本回合免于灭亡）`; }
        if (eff.expansionLock && civ) { civ.expansionLock = 1; detail = detail || `禁止扩张一回合`; }
        if (eff.relation && civ) {
            for (const other of state.civs) if (other.id !== civ.id && other.alive) {
                const prev = civ.relations[other.id] ?? 0;
                civ.relations[other.id] = clamp(prev + eff.relation * w, -5, 5);
            }
            detail = detail || `邦交调整 ×${round2(w)}`;
        }
        if (eff.transfer && region && civ) {
            region.owner = civ.id;
            detail = `${region.name}划归${civ.name}`;
        }
        if (eff.grant && civ) {
            const free = state.regions.find((r) => r.owner === null && isAdjacentToCiv(state, r.id, civ.id)) ?? state.regions.find((r) => r.owner === null);
            if (free) { free.owner = civ.id; detail = `扶立${civ.name}于${free.name}`; }
        }
        if (eff.collapse && civ) {
            if (e.magnitude >= rules.dm.maxMagnitude && !civ.shield) {
                civ.alive = false;
                for (const r of state.regions) if (r.owner === civ.id) r.owner = null;
                detail = `${civ.name}宗庙倾覆`;
            } else {
                civ.stability = round2(clamp(civ.stability - 20 * w, 0, 100));
                detail = `${civ.name}剧震（未至灭国）`;
            }
        }
        if (e.type === 'policy' && civ) {
            civ.policy = ['balanced', 'aggressive', 'scholarly', 'commerce'][rng.int(4)];
            detail = `定方针「${civ.policy}」`;
        }
        const note = e.note ? ` · ${String(e.note).replace(/[\r\n]/g, ' ').slice(0, 80)}` : '';
        record(state, 'intervene', `【DM 干预 · ${e.type}】${civ ? civ.name : '天下'}${detail ? `：${detail}` : ''}${note}`, { edit: e.type, civId: civ?.id ?? null });
    }
    state.rngState = rng.getState();
}

/** 自然演化：整体受 simulation.strength 缩放，调低即「世界慢下来，让模型说话」 */
function simulate(state, rules) {
    const s = rules.simulation;
    const k = clamp(s.strength, 0, 1);
    const rng = createRng(`${state.seed}::sim`, state.rngState);
    for (const civ of state.civs) {
        if (!civ.alive) continue;
        const owns = ownedRegions(state, civ.id);
        if (owns.length === 0 && !civ.shield) {
            civ.alive = false;
            record(state, 'fall', `${civ.name}尽失疆土，国祚断绝。`);
            continue;
        }
        let food = 0, ore = 0, energy = 0;
        for (const r of owns) {
            food += r.yields.food * (1 + r.development * 0.2);
            ore += r.yields.ore * (1 + r.development * 0.2);
            energy += r.yields.energy * (1 + r.development * 0.2);
        }
        civ.resources.food = round2(civ.resources.food + food * s.foodYield * k);
        civ.resources.ore = round2(civ.resources.ore + ore * s.oreYield * k);
        civ.resources.energy = round2(civ.resources.energy + energy * s.energyYield * k);
        civ.resources.knowledge = round2(civ.resources.knowledge + s.knowledgeYield * k * (1 + civ.tech / 800));
        civ.tech = round2(civ.tech + s.techTrickle * k * (1 + owns.length / 20));
        civ.population = round2(civ.population * (1 + s.populationGrowth * k));
        civ.stability = round2(clamp(civ.stability + s.stabilityDrift * k - (civ.population > 60 ? 0.4 : 0), 0, 100));

        if (civ.expansionLock) continue;
        if (rng.chance(s.spreadChance * k)) {
            const free = state.regions.find((r) => r.owner === null && isAdjacentToCiv(state, r.id, civ.id));
            if (free) {
                free.owner = civ.id;
                record(state, 'expand', `${civ.name}移民实边，取无主之${free.name}。`);
            }
        }
        if (rng.chance(s.warChance * k)) {
            const target = state.regions.find((r) => r.owner && r.owner !== civ.id && isAdjacentToCiv(state, r.id, civ.id) && !civById(state, r.owner)?.shield);
            if (target) {
                const defender = civById(state, target.owner);
                const atk = civ.military * (0.85 + rng.next() * 0.3) + civ.tech / 80;
                const def = defender.military * 0.6 + target.development * 5;
                if (atk > def) {
                    target.owner = civ.id;
                    defender.military = round2(Math.max(0, defender.military - 5));
                    civ.military = round2(Math.max(0, civ.military - 3));
                    record(state, 'war', `${civ.name}与${defender.name}交兵，克${target.name}。`);
                } else {
                    civ.military = round2(Math.max(0, civ.military - 4));
                    record(state, 'war', `${civ.name}攻${target.name}不克，罢兵。`);
                }
            }
        }
        if (rng.chance(s.disasterChance * k)) {
            const hit = owns[rng.int(owns.length)];
            if (hit) {
                hit.population = round2(Math.max(1, hit.population * 0.88));
                civ.stability = round2(clamp(civ.stability - 6 * k, 0, 100));
                record(state, 'disaster', `${civ.name}·${hit.name}遭灾，户口凋零。`);
            }
        }
    }
    state.rngState = rng.getState();
}

function updateEpochs(state, rules) {
    for (const civ of state.civs) {
        if (!civ.alive) continue;
        const e = epochOf(rules, civ.tech);
        if (e.id !== civ.epoch) {
            record(state, 'epoch', `${civ.name}迈入「${e.name}」时代（科技 ${Math.round(civ.tech)}）。`, { civId: civ.id, epoch: e.id });
            civ.epoch = e.id;
            pushEvent(state, 'epoch_advanced', { civId: civ.id, epoch: e.id, epochName: e.name });
        }
    }
}

export function computeScores(state, rules) {
    for (const civ of state.civs) {
        const owns = ownedRegions(state, civ.id).length;
        const avgDev = owns ? state.regions.filter((r) => r.owner === civ.id).reduce((a, r) => a + r.development, 0) / owns : 0;
        civ.score = round2(civ.tech * 0.5 + owns * 8 + civ.colonies * 60 + avgDev * 10 + civ.stability * 0.2 + civ.military * 0.3);
    }
}

function checkVictory(state, rules) {
    const v = rules.victory;
    const qualifiers = state.civs.filter((c) => c.alive && c.epoch === v.type && c.colonies >= v.requiredColonies && c.tech >= v.requiredTech);
    if (qualifiers.length) {
        qualifiers.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        return { winner: qualifiers[0].id, reason: 'interstellar' };
    }
    if (state.turn >= rules.engine.maxTurns) {
        const ranked = [...state.civs].filter((c) => c.alive).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        return ranked.length ? { winner: ranked[0].id, reason: 'score' } : null;
    }
    return null;
}

function buildReport(state, rules, verdict) {
    const entries = state.chronicle.filter((c) => c.turn === state.turn);
    const lines = [];
    lines.push(`═══ 第 ${state.turn} 回合 · 纪元 ${state.year} 年 ═══`);
    for (const e of entries) lines.push(`· ${e.text}`);
    const ranked = [...state.civs].filter((c) => c.alive).sort((a, b) => b.score - a.score).slice(0, 5);
    lines.push('── 列强榜（综合分）──');
    ranked.forEach((c, i) => lines.push(`${i + 1}. ${c.name}｜${rules.epochs.find((x) => x.id === c.epoch)?.name ?? c.epoch}｜科技 ${Math.round(c.tech)}｜殖民 ${c.colonies}｜${c.score}`));
    lines.push(`规则：推演强度 ${rules.simulation.strength} / DM 权重 ${rules.dm.weight}`);
    if (verdict) {
        const w = civById(state, verdict.winner);
        lines.push(`★ ${w?.name ?? verdict.winner} 达成${verdict.reason === 'interstellar' ? '星际文明' : '终局最高分'}，推演结束。`);
    }
    return lines.join('\n');
}

/**
 * 结算一整个回合。调用前 state.decisions / state.dmEdits 必须已通过 validate* 校验。
 * @returns {{report:string, events:Array<object>, winner:string|null}}
 */
export function advanceTurn(state, rules) {
    if (state.phase !== 'submitting') throw new Error('PHASE_NOT_SUBMITTING');
    const from = state.eventOffset;
    applyDecisions(state, rules);
    applyDmEdits(state, rules);
    simulate(state, rules);
    updateEpochs(state, rules);
    computeScores(state, rules);
    const verdict = checkVictory(state, rules);

    const events = eventsSince(state, from);
    const report = buildReport(state, rules, verdict);
    state.lastReport = report;

    state.turn += 1;
    state.year += rules.engine.yearsPerTurn;
    state.decisions = {};
    state.dmEdits = [];
    for (const civ of state.civs) { civ.shield = 0; civ.expansionLock = 0; }
    if (verdict) {
        state.winner = verdict.winner;
        state.phase = 'ended';
        record(state, 'victory', `${civById(state, verdict.winner)?.name ?? ''} 带领人类走向星际文明。`);
    } else {
        state.phase = 'submitting';
    }
    pushEvent(state, 'turn_resolved', {
        turn: state.turn - 1, year: state.year - rules.engine.yearsPerTurn,
        report, winner: state.winner, epochLeaders: state.civs.filter((c) => c.alive).sort((a, b) => b.tech - a.tech).slice(0, 3).map((c) => ({ id: c.id, name: c.name, tech: c.tech, epoch: c.epoch })),
    });
    return { report, events: eventsSince(state, from), winner: state.winner };
}
