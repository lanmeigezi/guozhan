/**
 * 确定性地图生成：8×6 网格 = 48 州，东西相连（环形），含少量跨行随机边。
 * 与 civ-atlas 的球面 3.6 万地块不是一回事，这里只保留「地图 + 政区 + 邻接」的玩法骨架，
 * 好处是零依赖、可在 Node / 浏览器 / 存档里逐位复现。
 */

/** @param {object} worldCfg @param {ReturnType<import('./rng.js').createRng>} rng */
export function generateWorld(worldCfg, rng, rules) {
    const { cols, rows } = rules.engine.map;
    const count = Math.min(worldCfg.regionCount, cols * rows);
    const terrains = worldCfg.terrains;
    const styles = worldCfg.nameStyles;
    const parts = worldCfg.nameParts;

    /** @type {Array<object>} */
    const regions = [];
    for (let i = 0; i < count; i += 1) {
        const terrain = rng.weighted(terrains);
        const style = rng.pick(styles);
        const part = rng.pick(parts);
        regions.push({
            id: `r${String(i + 1).padStart(2, '0')}`,
            index: i,
            x: i % cols,
            y: Math.floor(i / cols),
            name: `${style}${part}`,
            terrain: terrain.id,
            terrainName: terrain.name,
            yields: { food: terrain.food, ore: terrain.ore, energy: terrain.energy },
            owner: null,
            development: 1,
            population: worldCfg.start.population,
            unrest: 0,
        });
    }

    // 邻接：上下左右，横向环形相连；再加少量确定性的斜向边
    const adjacency = regions.map(() => new Set());
    const link = (a, b) => {
        if (a === b) return;
        adjacency[a].add(b);
        adjacency[b].add(a);
    };
    for (const r of regions) {
        const right = r.y * cols + ((r.x + 1) % cols);
        const left = r.y * cols + ((r.x - 1 + cols) % cols);
        const down = (r.y + 1) * cols + r.x;
        const up = (r.y - 1) * cols + r.x;
        if (right < count) link(r.index, right);
        if (left < count && r.x > 0) link(r.index, left);
        if (r.y + 1 < rows && down < count) link(r.index, down);
        if (r.y > 0 && up >= 0) link(r.index, up);
    }
    for (let k = 0; k < Math.floor(count / 6); k += 1) {
        const a = rng.int(count);
        const b = rng.int(count);
        if (Math.abs(regions[a].x - regions[b].x) <= 2 && Math.abs(regions[a].y - regions[b].y) <= 2) link(a, b);
    }

    return {
        regions,
        adjacency: adjacency.map((s) => [...s].sort((a, b) => a - b)),
        layout: {
            cols,
            rows,
            regions: regions.map((r) => ({ id: r.id, x: r.x, y: r.y, name: r.name, terrain: r.terrain, terrainName: r.terrainName })),
        },
    };
}

/** 给 12 个文明分配互不重叠的起始州：首都 + 一相邻州，均匀分布 */
export function assignCapitals(world, slots, rng) {
    const used = new Set();
    const total = world.regions.length;
    const per = Math.floor(total / slots.length);
    for (let i = 0; i < slots.length; i += 1) {
        let idx = i * per + rng.int(per);
        let guard = 0;
        while (used.has(idx) && guard < total) {
            idx = (idx + 1) % total;
            guard += 1;
        }
        used.add(idx);
        world.regions[idx].owner = slots[i].id;
        world.regions[idx].development = 1.2;
        slots[i].capital = world.regions[idx].id;

        // ★试玩修正：开局每国两州。原先一国仅一州，一次成功攻城即「尽失疆土」，
        //   人类玩家可能第 1 回合就出局。两州保留了征服与亡国的可能性，但需连续打击。
        let second = (world.adjacency[idx] ?? []).find((n) => n < total && !used.has(n));
        if (second === undefined) {
            for (let k = i * per; k < (i + 1) * per && k < total; k += 1) {
                if (!used.has(k)) { second = k; break; }
            }
        }
        if (second === undefined) second = world.regions.findIndex((r) => !used.has(r.index));
        if (second >= 0 && second < total) {
            used.add(second);
            world.regions[second].owner = slots[i].id;
        }
    }
}
