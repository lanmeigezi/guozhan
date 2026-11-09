/**
 * 种子驱动的随机六角地图。
 *
 * ★确定性：只用 core 的 DeterministicRng（xorshift32，由 rootSeed 派生），
 *   绝不调用 Math.random / Date.now。同种子 ⇒ 同地图/同开局/同 contentHash；
 *   换种子 ⇒ 新地形、水域带、港口网络、势力领地与开局部队。
 *
 * 生成步骤：
 *   六角棋盘 → 一条横贯的水域带 → 跨水桥 → 港口/水路 → 四势力领地 BFS →
 *   地形/资源 → 首都/部队 → 战争关系 → 布局 DTO。
 *
 * 生成失败（例如极小领地/无港口）时用 attempt 子种子重试；重试序列本身也是确定性的。
 */
import { DeterministicRng } from '../core/rng.ts';
import type { WaterRoute } from '../core/state.ts';
import { MapLayoutSchema, type MapLayout } from '../protocol/map-layout.ts';

const HEX_SIZE = 60;
const AXIAL_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
];

const NAME_POOL = [
  '朔风', '云岭', '雁回', '幽谷', '白泉', '玄关', '河阳', '渡川',
  '中津', '中洲', '临江', '东莱', '江左', '南渡', '湖口', '浔阳',
  '石桥', '海盐', '武陵', '长沙', '豫章', '吴会', '建安', '南海',
  '赤壁', '夷陵', '襄阳', '樊城', '寿春', '合肥', '陈仓', '街亭',
  '祁山', '五丈原', '虎牢', '汜水', '漳水', '易水', '滹沱', '太行',
];

/** 超大地图专用名称池；旧 4 人小图仍只用上面的 40 个，保证旧地图逐字不变。 */
const NAME_POOL_LARGE: readonly string[] = Object.freeze([...new Set([
  ...NAME_POOL,
  '安定', '安邑', '白帝', '白鹿', '白水', '北海', '北平', '北原', '博望', '苍梧',
  '长平', '长社', '朝阳', '陈留', '城父', '城阳', '池阳', '赤城', '滏口', '高平',
  '高阳', '广陵', '广武', '桂阳', '邯郸', '汉阳', '河内', '河东', '河间', '河阴',
  '弘农', '壶关', '华阴', '槐里', '淮南', '黄池', '会稽', '即墨', '济北', '济南',
  '济阳', '江陵', '晋阳', '京兆', '钜鹿', '鄄城', '蓝田', '琅琊', '临菑', '临邛',
  '临淄', '灵寿', '陇西', '鲁阳', '洛阳', '马邑', '麦城', '汨罗', '南阳', '邺城',
  '番禺', '彭城', '平阳', '平阴', '蒲坂', '谯郡', '清河', '汝南', '三川', '桑干',
  '山阳', '商丘', '上党', '上谷', '上郡', '上庸', '邵陵', '酸枣', '睢阳', '太原',
  '檀溪', '唐邑', '洮阳', '下邳', '咸阳', '襄城', '新郑', '信都', '荥阳', '阳翟',
  '阳平', '野王', '宜阳', '义阳', '颍川', '雍丘', '渔阳', '郁林', '冤句', '云中',
  '章武', '长广', '真定', '涿郡', '秣陵', '柴桑', '建业', '江夏', '零陵', '庐江',
  '九江', '丹阳', '新野', '宛城', '博陵', '常山', '中山', '安平', '渤海', '平原',
  '东郡', '济阴', '泰山', '琅邪', '东海', '下相', '棠邑', '六安', '皖城', '寻阳',
  '夏口', '武昌', '巴丘', '江州', '垫江', '阆中', '汉中', '阳平关', '潼关', '延津',
  '官渡', '乌巢', '黎阳', '井陉', '雁门', '代郡', '五原', '朔方', '九原', '朝歌',
  '牧野', '孟津', '洛邑', '伊阙', '轘辕', '阳城', '许昌', '永安', '巴郡', '涪陵',
])]);

const TERRAIN_TABLE: ReadonlyArray<readonly [string, number]> = [
  ['plains', 30], ['hills', 20], ['forest', 20],
  ['mountain', 12], ['river', 8], ['urban', 10],
];

const TERRAIN_BASE: Readonly<Record<string, readonly [number, number, number]>> = {
  plains: [700, 600, 60000],
  hills: [500, 350, 40000],
  forest: [550, 400, 45000],
  mountain: [300, 200, 25000],
  river: [650, 550, 50000],
  urban: [900, 900, 70000],
};

interface Cell {
  readonly q: number;
  readonly r: number;
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

interface LandCell extends Cell {
  name: string;
  terrain: string;
  baseFood: number;
  baseGold: number;
  baseManpower: number;
  strategic: boolean;
  port: boolean;
}

export interface RandomMapInput {
  readonly scenarioId: string;
  readonly rootSeed: string;
  readonly scenario: any;
  /** 基础势力花名册（只读 id/名称/颜色/性格/法令倾向） */
  readonly roster: { factions: any[] };
  readonly unitsDoc: { unitTypes: any[] };
}

export interface RandomMapOutput {
  readonly regionsDoc: { regions: any[]; waterRoutes: WaterRoute[] };
  readonly factionsDoc: any;
  readonly mapLayout: MapLayout;
}

export function generateRandomMap(input: RandomMapInput): RandomMapOutput {
  const generator = input.scenario.generator;
  if (!generator || generator.type !== 'hexboard') {
    throw new Error(`随机地图剧本 ${input.scenarioId} 必须声明 generator.type=hexboard`);
  }
  const version = Number(generator.version ?? 1);
  const radius = Math.min(8, Math.max(2, Number(generator.radius ?? 3)));
  /**
   * ★蓝图命名空间：同一套地图规则的不同剧本（例如旧 random-front 与启用治理规则的
   *   random-front-v2）可以共用同一个 namespace，从而「同种子 ⇒ 同一张地图」。
   *   未声明时沿用 scenarioId，旧剧本的生成结果逐位不变。
   */
  const namespace = String(generator.namespace ?? input.scenarioId);
  const roster: any[] = Array.isArray(input.roster.factions) ? input.roster.factions : [];
  if (roster.length < 2) throw new Error('随机地图至少需要两个势力');

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 16; attempt++) {
    const rng = DeterministicRng.derive(
      input.rootSeed, 'random-map', version, namespace, radius, attempt,
    );
    try {
      return build(rng, radius, roster, input.unitsDoc);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`随机地图生成失败（seed=${input.rootSeed}）：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function build(
  rng: DeterministicRng,
  radius: number,
  roster: any[],
  unitsDoc: { unitTypes: any[] },
): RandomMapOutput {
  const cells = buildCells(radius);
  const cellById = new Map(cells.map((c) => [c.id, c]));
  const cellAt = new Map(cells.map((c) => [`${c.q},${c.r}`, c]));

  const bandR = rng.nextInt(-1, 1);
  const water = cells.filter((c) => c.r === bandR);
  const waterIds = new Set(water.map((c) => c.id));
  const landCells = cells.filter((c) => !waterIds.has(c.id));
  const isLargeMap = roster.length > 4 || radius > 3;
  const minLandPerFaction = isLargeMap ? 5 : 4;
  if (landCells.length < roster.length * minLandPerFaction) {
    throw new Error(`陆地太少（${landCells.length} 格），无法分给 ${roster.length} 家`);
  }

  const neighborsOf = (cell: Cell): Cell[] => {
    const out: Cell[] = [];
    for (const [dq, dr] of AXIAL_DIRECTIONS) {
      const n = cellAt.get(`${cell.q + dq},${cell.r + dr}`);
      if (n) out.push(n);
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  };

  const landAdj = new Map<string, Set<string>>(landCells.map((c) => [c.id, new Set<string>()]));
  for (const c of landCells) {
    for (const n of neighborsOf(c)) {
      if (waterIds.has(n.id)) continue;
      landAdj.get(c.id)!.add(n.id);
    }
  }

  // ── 跨水桥：选 2-3 个水域格，各连一对南北陆格 ──
  const bridgeCandidates = water
    .map((w) => {
      const ns = neighborsOf(w).filter((n) => !waterIds.has(n.id));
      const north = ns.filter((n) => n.r < w.r);
      const south = ns.filter((n) => n.r > w.r);
      return { w, north, south };
    })
    .filter((x) => x.north.length > 0 && x.south.length > 0)
    .sort((a, b) => a.w.id < b.w.id ? -1 : 1);
  if (bridgeCandidates.length === 0) throw new Error('水域带两侧没有可连桥的陆地');

  const bridgeCount = rng.nextInt(2, Math.min(3, bridgeCandidates.length));
  const shuffledBridges = shuffle(rng, bridgeCandidates);
  const bridges: Array<{ a: string; b: string }> = [];
  const bridgeEndpoints = new Set<string>();
  const addBridge = (a: string, b: string): boolean => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (bridges.some((x) => (x.a < x.b ? `${x.a}|${x.b}` : `${x.b}|${x.a}`) === key)) return false;
    landAdj.get(a)!.add(b);
    landAdj.get(b)!.add(a);
    bridges.push(a < b ? { a, b } : { a: b, b: a });
    bridgeEndpoints.add(a);
    bridgeEndpoints.add(b);
    return true;
  };
  for (const candidate of shuffledBridges.slice(0, bridgeCount)) {
    const north = rng.pick(candidate.north).id;
    const south = rng.pick(candidate.south).id;
    addBridge(north, south);
  }

  // 确保陆地连通：若仍分裂，继续找能连接两个分量的水域格
  while (true) {
    const components = landComponents(landCells.map((c) => c.id), landAdj);
    if (components.length <= 1) break;
    let connected = false;
    for (const w of water) {
      const ns = neighborsOf(w).filter((n) => !waterIds.has(n.id));
      for (let i = 0; i < ns.length && !connected; i++) {
        for (let j = i + 1; j < ns.length && !connected; j++) {
          const ci = componentOf(components, ns[i]!.id);
          const cj = componentOf(components, ns[j]!.id);
          if (ci !== cj) {
            addBridge(ns[i]!.id, ns[j]!.id);
            connected = true;
          }
        }
      }
      if (connected) break;
    }
    if (!connected) throw new Error('水域无法通过桥梁连通全部陆地');
  }
  if (bridges.length === 0) throw new Error('随机地图至少需要一座桥');

  // ── 港口：水域旁的陆地 ──
  const portCandidates = landCells
    .filter((c) => neighborsOf(c).some((n) => waterIds.has(n.id)))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (portCandidates.length < roster.length) throw new Error('港口太少，无法保证每家都有水师');

  const used = new Set<string>();
  let seeds: Cell[] = [];
  if (!isLargeMap) {
    // ★旧 4 人小图保持原有四象限选点：任何 RNG 调用顺序变化都会改旧 contentHash。
    const centerX = 0;
    const quadrants: string[] = ['NW', 'NE', 'SW', 'SE'];
    const byQuadrant = new Map<string, Cell[]>();
    for (const c of portCandidates) {
      const key = `${c.r < bandR ? 'N' : 'S'}${c.x < centerX ? 'W' : 'E'}`;
      byQuadrant.set(key, [...(byQuadrant.get(key) ?? []), c]);
    }
    for (const q of quadrants) {
      const pool = (byQuadrant.get(q) ?? []).filter((c) => !used.has(c.id));
      if (pool.length > 0) {
        const picked = rng.pick(pool);
        seeds.push(picked);
        used.add(picked.id);
      }
    }
    for (const c of portCandidates) {
      if (seeds.length >= roster.length) break;
      if (used.has(c.id)) continue;
      seeds.push(c);
      used.add(c.id);
    }
  } else {
    // 大地图：用最远点采样把 12 个种子均匀撒在港口外圈，避免像四象限那样挤在一角。
    seeds = pickSpreadSeeds(rng, portCandidates, roster.length);
    for (const c of seeds) used.add(c.id);
  }
  if (seeds.length < roster.length) throw new Error('无法为每个势力分配港口种子');

  const ports = new Set<string>(seeds.map((c) => c.id));
  const remainingPorts = portCandidates.filter((c) => !used.has(c.id));
  let extraPortCount = 0;
  if (isLargeMap) {
    const maxExtra = Math.min(8, remainingPorts.length);
    const minExtra = Math.min(4, maxExtra);
    extraPortCount = maxExtra > 0 ? rng.nextInt(minExtra, maxExtra) : 0;
  } else {
    extraPortCount = Math.min(remainingPorts.length, rng.nextInt(2, 4));
  }
  for (const c of shuffle(rng, remainingPorts).slice(0, extraPortCount)) ports.add(c.id);

  // ── 四势力领地：从港口种子做平衡 BFS ──
  const owner = new Map<string, string>();
  const queues = new Map<string, { items: string[]; head: number }>();
  for (let i = 0; i < roster.length; i++) {
    const fid = String(roster[i]!.id);
    const seed = seeds[i]!;
    owner.set(seed.id, fid);
    queues.set(fid, { items: [seed.id], head: 0 });
  }
  let progress = true;
  while (progress) {
    progress = false;
    for (const f of roster) {
      const fid = String(f.id);
      const queue = queues.get(fid)!;
      let expanded = false;
      while (queue.head < queue.items.length && !expanded) {
        const cur = queue.items[queue.head++]!;
        for (const nb of [...(landAdj.get(cur) ?? [])].sort()) {
          if (owner.has(nb)) continue;
          owner.set(nb, fid);
          queue.items.push(nb);
          expanded = true;
          progress = true;
        }
      }
    }
  }
  if (owner.size !== landCells.length) throw new Error('有陆地无法分配给任何势力');
  const territoryOf = new Map<string, string[]>();
  for (const f of roster) territoryOf.set(String(f.id), []);
  for (const [rid, fid] of owner) territoryOf.get(fid)!.push(rid);
  const minTerritory = isLargeMap ? 4 : 3;
  for (const [fid, list] of territoryOf) {
    list.sort();
    if (list.length < minTerritory) throw new Error(`势力 ${fid} 领地过小（${list.length} 区）`);
  }

  // ── 地形 / 名称 / 资源 ──
  const namePool = isLargeMap ? NAME_POOL_LARGE : NAME_POOL;
  const names = shuffle(rng, namePool).slice(0, landCells.length);
  while (names.length < landCells.length) names.push(`边城${names.length + 1}`);
  const landById = new Map<string, LandCell>();
  for (let i = 0; i < landCells.length; i++) {
    const cell = landCells[i]!;
    const fid = owner.get(cell.id)!;
    const capitalOfFaction = seeds[roster.findIndex((f) => String(f.id) === fid)]!;
    const isCapital = cell.id === capitalOfFaction.id;
    const isPort = ports.has(cell.id);
    const isBridge = bridgeEndpoints.has(cell.id);
    const terrain = isCapital
      ? 'urban'
      : isBridge
        ? 'plains'
        : isPort
          ? (rng.chance(0.45) ? 'river' : 'plains')
          : rng.weighted(TERRAIN_TABLE, (t) => t[1])[0];
    const base = TERRAIN_BASE[terrain] ?? TERRAIN_BASE['plains']!;
    const variance = 0.82 + rng.nextFloat() * 0.36;
    const portBonus = isPort ? 1.2 : 1;
    const capitalBonus = isCapital ? 1.15 : 1;
    landById.set(cell.id, {
      ...cell,
      name: names[i]!,
      terrain,
      baseFood: Math.round(base[0] * variance * capitalBonus),
      baseGold: Math.round(base[1] * variance * portBonus * capitalBonus),
      baseManpower: Math.round(base[2] * variance),
      strategic: isPort || isCapital || isBridge || rng.chance(0.12),
      port: isPort,
    });
  }

  // ── 水师水路：港口 MST + 少量环路 ──
  const portIds = [...ports].sort();
  const waterRoutes = buildWaterRoutes(rng, portIds, cellById);
  if (waterRoutes.length < portIds.length - 1) throw new Error('水路网络未连通');

  // ── 势力数据 / 首都 / 部队 ──
  const factions: any[] = [];
  for (const f of roster) {
    const fid = String(f.id);
    const seed = seeds[roster.findIndex((x) => String(x.id) === fid)]!;
    const territories = [...(territoryOf.get(fid) ?? [])].sort();
    const landTypes = unitsDoc.unitTypes.filter((u) => u.domain !== 'water');
    const waterTypes = unitsDoc.unitTypes.filter((u) => u.domain === 'water');
    if (landTypes.length === 0) throw new Error('随机地图缺少陆军兵种');
    const secondRegion = territories.find((r) => r !== seed.id) ?? seed.id;
    const units: any[] = [
      {
        id: `u_${fid}_1`,
        region: seed.id,
        type: String(rng.pick(landTypes).id),
        troops: rng.nextInt(9000, 20000),
      },
      {
        id: `u_${fid}_2`,
        region: secondRegion,
        type: String(rng.pick(landTypes).id),
        troops: rng.nextInt(8000, 18000),
      },
    ];
    if (waterTypes.length > 0) {
      const fleetPort = territories.find((r) => ports.has(r)) ?? seed.id;
      units.push({
        id: `u_${fid}_3`,
        region: fleetPort,
        type: String(rng.pick(waterTypes).id),
        troops: rng.nextInt(4000, 9000),
      });
    }
    factions.push({
      id: fid,
      name: String(f.name ?? fid),
      ruler: f.ruler,
      color: f.color,
      capital: seed.id,
      territories,
      gold: rng.nextInt(2200, 3400),
      food: rng.nextInt(5000, 7000),
      morale: rng.nextInt(64, 80),
      taxRate: Number(f.taxRate ?? 0.3),
      laws: Array.isArray(f.laws) ? f.laws : [],
      personality: f.personality,
      units,
    });
  }

  // ── 关系：至少一场战争，优先选接壤势力 ──
  const borders = new Set<string>();
  for (const [a, set] of landAdj) {
    const fa = owner.get(a);
    if (!fa) continue;
    for (const b of set) {
      const fb = owner.get(b);
      if (fb && fb !== fa) borders.add(fa < fb ? `${fa}|${fb}` : `${fb}|${fa}`);
    }
  }
  const borderPairs = [...borders].sort().map((key) => {
    const [a, b] = key.split('|') as [string, string];
    return { a, b };
  });
  const warPairs: Array<{ a: string; b: string }> = [];
  const warCount = isLargeMap
    ? Math.min(borderPairs.length, rng.nextInt(2, Math.min(4, Math.max(2, borderPairs.length))))
    : Math.min(borderPairs.length, rng.nextInt(1, 2));
  for (const pair of shuffle(rng, borderPairs).slice(0, warCount)) warPairs.push(pair);
  if (warPairs.length === 0) {
    const a = String(roster[0]!.id);
    const b = String(roster[1]!.id);
    warPairs.push({ a, b });
  }
  const initialRelations = warPairs.map((p) => ({ ...p, kind: 'war' as const }));

  // ── 布局（所有像素坐标在这里归一化；客户端只画） ──
  const halfW = HEX_SIZE * Math.sqrt(3) / 2;
  const halfH = HEX_SIZE;
  const minX = Math.min(...cells.map((c) => c.x - halfW));
  const maxX = Math.max(...cells.map((c) => c.x + halfW));
  const minY = Math.min(...cells.map((c) => c.y - halfH));
  const maxY = Math.max(...cells.map((c) => c.y + halfH));
  const margin = 70;
  const shiftX = margin - minX;
  const shiftY = margin - minY;
  const canvas = {
    width: Math.ceil(maxX - minX + margin * 2),
    height: Math.ceil(maxY - minY + margin * 2),
  };

  const layoutRegions = [...landById.values()]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((c) => ({
      id: c.id,
      x: c.x + shiftX,
      y: c.y + shiftY,
      col: c.q + radius,
      row: c.r + radius,
    }));
  const waterCells = [...water]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((c) => ({
      x: c.x + shiftX,
      y: c.y + shiftY,
      col: c.q + radius,
      row: c.r + radius,
    }));
  const factionColors: Record<string, string> = {};
  const capitals: Record<string, string> = {};
  for (const f of factions) {
    factionColors[String(f.id)] = String(f.color).toLowerCase();
    capitals[String(f.id)] = String(f.capital);
  }

  const mapLayout = MapLayoutSchema.parse({
    kind: 'hexboard',
    canvas,
    hexSize: HEX_SIZE,
    regions: layoutRegions,
    waterCells,
    bridges: bridges.slice().sort((a, b) => (a.a + '|' + a.b < b.a + '|' + b.b ? -1 : 1)),
    riverLabel: '大江',
    factionColors,
    capitals,
    waterRoutes,
    ports: portIds,
  });

  const regions = [...landById.values()]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((c) => ({
      id: c.id,
      name: c.name,
      terrain: c.terrain,
      adjacency: [...(landAdj.get(c.id) ?? [])].sort(),
      baseFood: c.baseFood,
      baseGold: c.baseGold,
      baseManpower: c.baseManpower,
      strategic: c.strategic,
      passable: true,
      ...(c.port ? { port: true } : {}),
    }));

  return {
    regionsDoc: { regions, waterRoutes },
    factionsDoc: { factions, initialRelations },
    mapLayout,
  };
}

// ─────────────────────────────────────────────────────────────
// 几何 / 图算法
// ─────────────────────────────────────────────────────────────

/** 最远点采样：先随机取一个港口，再每次取离已选种子最远的港口。 */
function pickSpreadSeeds(rng: DeterministicRng, candidates: readonly Cell[], count: number): Cell[] {
  if (candidates.length < count) return [];
  const pool = [...candidates].sort((a, b) => (a.id < b.id ? -1 : 1));
  const chosen: Cell[] = [rng.pick(pool)];
  const used = new Set<string>([chosen[0]!.id]);
  while (chosen.length < count) {
    let best: Cell | null = null;
    let bestDistance = -1;
    for (const cell of pool) {
      if (used.has(cell.id)) continue;
      let nearest = Number.POSITIVE_INFINITY;
      for (const seed of chosen) {
        nearest = Math.min(nearest, hexDistance(cell.q, cell.r, seed.q, seed.r));
      }
      if (nearest > bestDistance || (nearest === bestDistance && (best === null || cell.id < best.id))) {
        best = cell;
        bestDistance = nearest;
      }
    }
    if (!best) break;
    chosen.push(best);
    used.add(best.id);
  }
  return chosen;
}

function buildCells(radius: number): Cell[] {
  const raw: Array<{ q: number; r: number; x: number; y: number }> = [];
  for (let r = -radius; r <= radius; r++) {
    for (let q = -radius; q <= radius; q++) {
      if (Math.abs(q) > radius || Math.abs(r) > radius || Math.abs(q + r) > radius) continue;
      raw.push({
        q,
        r,
        x: HEX_SIZE * Math.sqrt(3) * (q + r / 2),
        y: HEX_SIZE * 1.5 * r,
      });
    }
  }
  raw.sort((a, b) => (a.r === b.r ? a.q - b.q : a.r - b.r));
  return raw.map((c, i) => ({
    ...c,
    id: `h${String(i + 1).padStart(2, '0')}`,
  }));
}

function shuffle<T>(rng: DeterministicRng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.nextInt(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function landComponents(ids: readonly string[], adj: ReadonlyMap<string, Set<string>>): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const id of [...ids].sort()) {
    if (seen.has(id)) continue;
    const comp: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const n of [...(adj.get(cur) ?? [])].sort()) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    out.push(comp.sort());
  }
  return out;
}

function componentOf(components: string[][], id: string): number {
  return components.findIndex((c) => c.includes(id));
}

function buildWaterRoutes(rng: DeterministicRng, ports: readonly string[], cellById: ReadonlyMap<string, Cell>): WaterRoute[] {
  if (ports.length < 2) return [];
  const pairs: Array<{ a: string; b: string; distance: number; cost: number }> = [];
  for (let i = 0; i < ports.length; i++) {
    for (let j = i + 1; j < ports.length; j++) {
      const a = ports[i]!;
      const b = ports[j]!;
      const ca = cellById.get(a);
      const cb = cellById.get(b);
      if (!ca || !cb) continue;
      const distance = hexDistance(ca.q, ca.r, cb.q, cb.r);
      pairs.push({
        a: a < b ? a : b,
        b: a < b ? b : a,
        distance,
        cost: distance <= 3 ? 1 : 2,
      });
    }
  }
  pairs.sort((x, y) => {
    if (x.distance !== y.distance) return x.distance - y.distance;
    const kx = `${x.a}|${x.b}`;
    const ky = `${y.a}|${y.b}`;
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });

  const parent = new Map<string, string>(ports.map((p) => [p, p]));
  const find = (x: string): string => {
    let cur = x;
    while (parent.get(cur) !== cur) cur = parent.get(cur)!;
    return cur;
  };
  const union = (a: string, b: string): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent.set(ra, rb);
    return true;
  };

  const chosen: Array<{ a: string; b: string; cost: number }> = [];
  const chosenKeys = new Set<string>();
  for (const pair of pairs) {
    if (!union(pair.a, pair.b)) continue;
    chosen.push({ a: pair.a, b: pair.b, cost: pair.cost });
    chosenKeys.add(`${pair.a}|${pair.b}`);
    if (chosen.length === ports.length - 1) break;
  }
  // 添加 1-2 条备选环路，让水师有绕行选择
  const extras = pairs.filter((p) => !chosenKeys.has(`${p.a}|${p.b}`));
  for (const extra of shuffle(rng, extras).slice(0, Math.min(2, extras.length))) {
    chosen.push({ a: extra.a, b: extra.b, cost: extra.cost });
  }
  return chosen.sort((x, y) => {
    const kx = `${x.a}|${x.b}`;
    const ky = `${y.a}|${y.b}`;
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
}

function hexDistance(aq: number, ar: number, bq: number, br: number): number {
  const dq = aq - bq;
  const dr = ar - br;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

