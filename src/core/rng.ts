/**
 * 确定性随机数 —— 内容寻址派生（P7）。
 *
 * 两个独立项目收敛到同一方案（aonw 用 xorshift32+FNV 混合，Histrategy 用 sha256），
 * 说明这是正解。本文件采用 aonw 的形态，因为：
 *   1. 种子 = f(回合, 参与者 id)，跨平台逐位精确（按 UTF-16 码元混合，JS 字符串天然 UTF-16）
 *   2. xorshift32 无需 crypto 依赖 —— src/core/ 必须零 IO，import node:crypto 会被架构测试打红
 *   3. 状态可序列化 ⇒ 能存进快照、能重放（tavern-battle-mcp SeededRng 的教训）
 *
 * ★铁律：本文件与整个 src/core/ 不得调用 Math.random() / Date.now() / 任何系统随机源。
 *   tests/deterministic/architecture.test.ts 会静态扫描并强制。
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1aByte(h: number, byte: number): number {
  return Math.imul(h ^ (byte & 0xff), FNV_PRIME) >>> 0;
}

/** 按小端逐字节混入一个 32 位整数 */
function mixInt(h: number, value: number): number {
  const v = value >>> 0;
  let out = fnv1aByte(h, v & 0xff);
  out = fnv1aByte(out, (v >>> 8) & 0xff);
  out = fnv1aByte(out, (v >>> 16) & 0xff);
  out = fnv1aByte(out, (v >>> 24) & 0xff);
  return out;
}

/** 按 UTF-16 码元逐字节混入字符串（与 aonw mix_string 等价，跨语言可复算） */
function mixString(h: number, text: string): number {
  let out = h >>> 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out = fnv1aByte(out, code & 0xff);
    out = fnv1aByte(out, (code >>> 8) & 0xff);
  }
  return out;
}

/** 混入任意"盐"：字符串走 mixString，数字走 mixInt */
function mixPart(h: number, part: string | number): number {
  return typeof part === 'number' ? mixInt(h, part) : mixString(h, part);
}

function xorshift32(state: number): number {
  let x = state >>> 0;
  // 状态 0 是 xorshift 的不动点，必须避开
  if (x === 0) x = FNV_OFFSET_BASIS;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  return x;
}

/** 由一串盐派生出 32 位种子。相同输入永远得到相同种子。 */
export function deriveSeed(parts: ReadonlyArray<string | number>): number {
  let h = FNV_OFFSET_BASIS;
  for (const part of parts) h = mixPart(h, part);
  const seed = h >>> 0;
  return seed === 0 ? FNV_OFFSET_BASIS : seed;
}

export interface RngSnapshot {
  readonly seed: number;
  readonly state: number;
}

/**
 * 一次性、可序列化的确定性随机源。
 *
 * 用法纪律：
 *   · 每个子系统用 `derive` 带独立 salt 派生自己的流，互不干扰
 *     （否则"多抽一次气候"会改变战斗骰值 —— 这是隐蔽的耦合 bug）
 *   · 抽完把 `snapshot()` 存进 GameState.rngState，重放时 `restore()`
 */
export class DeterministicRng {
  /**
   * 刻意不用 TS 参数属性（`constructor(private x)`）：
   * Node 的 strip-only 类型剥离不支持它（ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX），
   * 而避开它意味着本文件能被裸 `node --experimental-strip-types` 直接执行 ——
   * 确定性测试因此不依赖任何构建链，闸门更难被工具链问题掩盖。
   */
  readonly seed: number;
  private state: number;

  private constructor(seed: number, state: number) {
    this.seed = seed >>> 0;
    this.state = state >>> 0;
  }

  static fromSeed(seed: number): DeterministicRng {
    const s = seed >>> 0;
    return new DeterministicRng(s, s === 0 ? FNV_OFFSET_BASIS : s);
  }

  /** 从房间根种子 + 任意盐派生一条独立随机流 */
  static derive(rootSeed: string, ...parts: ReadonlyArray<string | number>): DeterministicRng {
    return DeterministicRng.fromSeed(deriveSeed([rootSeed, ...parts]));
  }

  // ── 各子系统的专用派生（salt 前缀集中在此，避免散落在模块里）──

  static forCombat(rootSeed: string, turn: number, attackerId: string, defenderId: string, regionId: string) {
    return DeterministicRng.derive(rootSeed, 'combat', turn, attackerId, defenderId, regionId);
  }

  static forEvent(rootSeed: string, turn: number, eventName: string, regionId: string) {
    return DeterministicRng.derive(rootSeed, 'event', turn, eventName, regionId);
  }

  static forUnrest(rootSeed: string, turn: number, regionId: string) {
    return DeterministicRng.derive(rootSeed, 'unrest', turn, regionId);
  }

  /** AI 用独立流（aonw 的 AiRng），且可留痕审计 */
  static forAi(rootSeed: string, turn: number, seatId: string) {
    return DeterministicRng.derive(rootSeed, 'ai', turn, seatId);
  }

  // ── 抽取原语 ──

  /** 下一个 uint32 */
  nextUint32(): number {
    this.state = xorshift32(this.state);
    return this.state;
  }

  /** [0,1) 区间的浮点。用高 32 位除以 2^32，保证确定性且分布均匀 */
  nextFloat(): number {
    return this.nextUint32() / 0x100000000;
  }

  /** 闭区间整数 [min,max]。min>max 时抛错（调用方逻辑错误，不静默交换） */
  nextInt(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new TypeError(`nextInt 需要整数边界，收到 min=${min} max=${max}`);
    }
    if (min > max) throw new RangeError(`nextInt 边界颠倒：min=${min} > max=${max}`);
    const span = max - min + 1;
    return min + Math.floor(this.nextFloat() * span);
  }

  /** 以 probability 概率返回 true */
  chance(probability: number): boolean {
    if (!(probability >= 0 && probability <= 1)) {
      throw new RangeError(`chance 需要 [0,1]，收到 ${probability}`);
    }
    return this.nextFloat() < probability;
  }

  /** 等概率取一个。空数组抛错 —— 静默返回 undefined 会污染下游数值 */
  pick<T>(items: ReadonlyArray<T>): T {
    if (items.length === 0) throw new RangeError('pick 收到空数组');
    const item = items[this.nextInt(0, items.length - 1)];
    if (item === undefined) throw new RangeError('pick 越界（不应发生）');
    return item;
  }

  /**
   * 加权抽取。权重必须非负且总和 > 0。
   * ★按传入顺序累积，因此调用方必须保证顺序稳定
   *   （例如对 Object.keys 的结果先排序），否则 map 迭代顺序变化会改变结果。
   */
  weighted<T>(items: ReadonlyArray<T>, weightOf: (item: T) => number): T {
    if (items.length === 0) throw new RangeError('weighted 收到空数组');
    const weights = items.map(weightOf);
    for (const w of weights) {
      if (!Number.isFinite(w) || w < 0) throw new RangeError(`weighted 权重非法：${w}`);
    }
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) throw new RangeError('weighted 权重总和必须 > 0');
    let target = this.nextFloat() * total;
    for (let i = 0; i < items.length; i++) {
      target -= weights[i] as number;
      if (target < 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }

  // ── 序列化（重放的关键）──

  snapshot(): RngSnapshot {
    return { seed: this.seed, state: this.state };
  }

  /** 从快照恢复后，后续时间线完全一致 */
  static restore(snap: RngSnapshot): DeterministicRng {
    const rng = DeterministicRng.fromSeed(snap.seed);
    rng.state = snap.state >>> 0;
    return rng;
  }
}

/**
 * 掷一次 NdM 骰并返回**全明细**（tavern-battle-mcp dice.ts 的做法）。
 * 明细必须随 ExecutionEvidence 落库，否则战报无法复核。
 */
export interface DiceRoll {
  readonly expr: string;
  readonly rolls: readonly number[];
  readonly kept: readonly number[];
  readonly total: number;
}

export function rollDice(rng: DeterministicRng, count: number, sides: number, modifier = 0): DiceRoll {
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new RangeError(`骰数非法：${count}`);
  }
  if (!Number.isInteger(sides) || sides < 2 || sides > 1000) {
    throw new RangeError(`骰面非法：${sides}`);
  }
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) rolls.push(rng.nextInt(1, sides));
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return {
    expr: modifier === 0 ? `${count}d${sides}` : `${count}d${sides}${modifier > 0 ? '+' : ''}${modifier}`,
    rolls,
    kept: rolls,
    total,
  };
}
