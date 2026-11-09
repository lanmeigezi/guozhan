/**
 * 确定性随机数：FNV-1a 字符串哈希 → mulberry32。
 * 借鉴 civ-atlas 与 tavern-battle-mcp 的做法：RNG 内部状态可序列化进快照，
 * 恢复后后续时间线完全一致；所有随机按用途派生，绝不调用 Math.random()。
 */

/** @param {string} str @returns {number} */
export function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/** 由种子与用途派生一个独立子流，避免处理顺序影响随机序列 */
export function deriveSeed(seed, purpose) {
    return fnv1a(`${String(seed)}::${String(purpose)}`) >>> 0;
}

/**
 * @param {string|number} seed
 * @param {number} [state] 恢复用：上一次 getState() 的返回值
 */
export function createRng(seed, state) {
    let s = (state === undefined ? deriveSeed(seed, 'main') : (state >>> 0)) || 1;

    function next() {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    return {
        next,
        /** 0..n-1 的整数 */
        int(n) {
            if (n <= 0) return 0;
            return Math.floor(next() * n) % n;
        },
        /** 闭区间 [min,max] 整数 */
        range(min, max) {
            return min + Math.floor(next() * (max - min + 1));
        },
        chance(p) {
            return next() < p;
        },
        pick(arr) {
            return arr.length ? arr[Math.floor(next() * arr.length)] : undefined;
        },
        /** 按 weight 字段加权挑选 */
        weighted(arr) {
            const total = arr.reduce((a, x) => a + (x.weight ?? 1), 0);
            let r = next() * total;
            for (const x of arr) {
                r -= x.weight ?? 1;
                if (r <= 0) return x;
            }
            return arr[arr.length - 1];
        },
        getState() {
            return s >>> 0;
        },
        setState(v) {
            s = (v >>> 0) || 1;
        },
    };
}

/** 稳定排序的 JSON 序列化，用于状态签名与存档（key 顺序无关） */
export function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
