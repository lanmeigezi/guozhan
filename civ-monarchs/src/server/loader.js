/** 规则与席位配置只在启动时读一次；改 config/*.json 后重启即生效，无需构建。 */
import { readFileSync } from 'node:fs';

function load(name) {
    const url = new URL(`../../config/${name}.json`, import.meta.url);
    return JSON.parse(readFileSync(url, 'utf8'));
}

export function loadConfig() {
    const rules = load('rules');
    const monarchs = load('monarchs');
    const world = load('world');
    const seats = load('seats');
    if (monarchs.slots.length !== rules.engine.civCount) {
        throw new Error(`席位数量 ${monarchs.slots.length} 与规则 engine.civCount ${rules.engine.civCount} 不一致`);
    }
    if (world.regionCount !== rules.engine.regionCount) {
        throw new Error(`地图区域数 ${world.regionCount} 与规则 engine.regionCount ${rules.engine.regionCount} 不一致`);
    }
    if (!seats.controlValues.includes(seats.defaultControl)) throw new Error('seats.defaultControl 不合法');
    if (!seats.policyValues.includes(seats.policy)) throw new Error('seats.policy 不合法');
    return { rules, monarchs, world, seats };
}
