/**
 * 六角战略地图渲染器（纯 SVG，无第三方依赖）。
 *
 * 参考《战棋帝国 / Hex Empire》的棋盘语言：六角格、势力色、格内兵力与士气、
 * 点选己方棋子后再点目标格下令。但**不把六角格边当作邻接**：
 * 本作的真相是 config 里的区域邻接图，格与格之间的道路才是可通行关系。
 * 这样"看着相邻却能打/不能打"的误导从结构上被排除了。
 *
 * 本文件只负责画与交互，不裁决任何规则：
 *   · 归属/兵力/视野来自按接收者投影后的 Snapshot；
 *   · 可选目标来自服务端合法动作的 sourceRegion / targetRegion；
 *   · 命令体原样回传，前端不拼规则。
 */

import { displayFactionColor, lightenFactionColor } from './faction-colors.js';

const NS = 'http://www.w3.org/2000/svg';

export const ACTION_KIND_META = Object.freeze({
  attack: { icon: '攻', label: '进攻', color: '#e06c5e' },
  move_units: { icon: '调', label: '调动', color: '#6fb1d8' },
  split_unit: { icon: '分', label: '分兵', color: '#93c9b5' },
  merge_units: { icon: '合', label: '合兵', color: '#93c9b5' },
  recruit: { icon: '征', label: '征兵', color: '#e0b95e' },
  develop: { icon: '筑', label: '开发', color: '#8fc98f' },
  build_infrastructure: { icon: '基', label: '基建', color: '#7fc7a0' },
  fortify: { icon: '堡', label: '筑垒', color: '#9d9be0' },
  set_tax: { icon: '税', label: '税率', color: '#c9c9c9' },
  set_law: { icon: '法', label: '法令', color: '#d8b4e2' },
  diplomacy: { icon: '交', label: '外交', color: '#8fd3c9' },
  send_spy: { icon: '谍', label: '谍报', color: '#b9a7e0' },
  trade_slaves: { icon: '奴', label: '鬻奴', color: '#c98f9a' },
  claim_rebellion: { icon: '称', label: '宣称', color: '#e0a05e' },
  settle_region: { icon: '垦', label: '开荒', color: '#8fbf7a' },
  disband: { icon: '散', label: '裁军', color: '#b0a99a' },
});

export const TERRAIN_META = Object.freeze({
  plains: { glyph: '原', label: '平原', color: '#9aae78' },
  hills: { glyph: '丘', label: '丘陵', color: '#b39c6d' },
  mountain: { glyph: '山', label: '山地', color: '#a8a8a8' },
  forest: { glyph: '林', label: '密林', color: '#7cab7c' },
  river: { glyph: '泽', label: '水乡', color: '#7fa5c6' },
  urban: { glyph: '城', label: '都会', color: '#d8b95e' },
});

export const FALLBACK_FACTION_COLORS = Object.freeze([
  '#c9a227', '#7aa2d6', '#b95f4e', '#6fae82',
  '#9a7bc4', '#c9825e', '#5fa8a2', '#a8a8a8',
]);

const NEUTRAL_COLOR = '#9c8d6e';
const REDUCED_MOTION = (() => {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch {
    return false;
  }
})();

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function textEl(str, attrs = {}) {
  const node = svgEl('text', attrs);
  node.textContent = str;
  return node;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function rgbOf(hex) {
  const v = parseInt(hex.slice(1), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

function toHex({ r, g, b }) {
  const c = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function mix(hex, target, amount) {
  const a = rgbOf(hex);
  const b = rgbOf(target);
  return toHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  });
}

function rgba(hex, alpha) {
  const { r, g, b } = rgbOf(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function compactTroops(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 10000) {
    const wan = n / 10000;
    return `${wan >= 10 ? wan.toFixed(0) : wan.toFixed(1).replace(/\.0$/, '')}万`;
  }
  return n.toLocaleString('en-US');
}

function outcomeLabel(outcome) {
  return {
    attacker_win: '攻方胜',
    defender_win: '守方胜',
    stalemate: '僵持',
    attacker_rout: '攻方溃退',
    defender_rout: '守方溃退',
  }[outcome] ?? '交战';
}

function hexPoints(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 90);
    pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
}

function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function roadPath(a, b, seed, bendScale = 1) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = (((hash(seed) % 200) / 100) - 1) * Math.min(18, len * 0.09) * bendScale;
  const mx = (a.x + b.x) / 2 + (-dy / len) * bend;
  const my = (a.y + b.y) / 2 + (dx / len) * bend;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} Q ${mx.toFixed(2)} ${my.toFixed(2)} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

// ─────────────────────────────────────────────────────────────
// 地图视图
// ─────────────────────────────────────────────────────────────

/**
 * @param {{
 *   svg: SVGSVGElement,
 *   onSelect?: (regionId: string) => void,
 *   onView?: (info: { x:number,y:number,w:number,h:number,zoom:number }) => void,
 * }} opts
 */
export function createMapView(opts) {
  const svg = opts.svg;
  if (!(svg instanceof Element)) throw new Error('地图容器必须是 SVG 元素');

  const defs = svgEl('defs');
  const gTerrain = svgEl('g', { class: 'layer-terrain' });
  const gRoads = svgEl('g', { class: 'layer-roads' });
  const gActiveRoads = svgEl('g', { class: 'layer-active-roads' });
  const gHexes = svgEl('g', { class: 'layer-hexes' });
  const gWater = svgEl('g', { class: 'layer-water' });
  const gOrders = svgEl('g', { class: 'layer-orders' });
  const gFx = svgEl('g', { class: 'layer-fx' });
  svg.replaceChildren(defs, gTerrain, gRoads, gActiveRoads, gHexes, gWater, gOrders, gFx);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  buildDefs(defs);

  let layout = null;
  let snapshot = null;
  let actions = [];
  let queue = [];
  let selectedId = null;
  let pair = null;
  let hoveredOrder = -1;
  let view = { x: 0, y: 0, w: 1200, h: 820 };
  let baseView = { x: 0, y: 0, w: 1200, h: 820 };
  let regionEls = new Map();
  let roadEls = new Map();
  let dragging = null;
  let suppressClick = false;

  const layoutById = new Map();
  const snapById = new Map();
  const factionById = new Map();

  // ── 初始化交互（缩放/平移）──
  svg.addEventListener('wheel', (event) => {
    if (!layout) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0012);
    zoomBy(factor, { clientX: event.clientX, clientY: event.clientY });
  }, { passive: false });

  svg.addEventListener('dragstart', (event) => event.preventDefault());

  svg.addEventListener('pointerdown', (event) => {
    if (!layout || event.button !== 0) return;
    dragging = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...view },
      moved: false,
    };
    try { svg.setPointerCapture(event.pointerId); } catch { /* 某些浏览器对 SVG 捕获失败 */ }
    svg.classList.add('is-dragging');
  });

  // 跟到 window：指针移出 SVG（甚至移出地图容器）时也要继续平移；
  // 只挂在 svg 上时，指针一旦离开 SVG，move/up 就收不到，表现为“拖不动”。
  window.addEventListener('pointermove', (event) => {
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    const dx = event.clientX - dragging.startX;
    const dy = event.clientY - dragging.startY;
    if (!dragging.moved && Math.abs(dx) + Math.abs(dy) > 5) dragging.moved = true;
    if (!dragging.moved) return;
    const rect = svg.getBoundingClientRect();
    view.x = dragging.origin.x - (dx / Math.max(1, rect.width)) * view.w;
    view.y = dragging.origin.y - (dy / Math.max(1, rect.height)) * view.h;
    clampView();
    applyView();
  });

  const endDrag = (event) => {
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    const moved = dragging.moved;
    dragging = null;
    svg.classList.remove('is-dragging');
    try { svg.releasePointerCapture(event.pointerId); } catch { /* noop */ }
    if (moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  // ── 视图控制 ──
  function applyView() {
    svg.setAttribute('viewBox', `${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`);
    const zoom = baseView.w / view.w;
    opts.onView?.({ ...view, zoom });
  }

  function clampView() {
    if (!layout) return;
    const padX = Math.max(24, layout.hexSize * 0.5);
    const padTop = Math.max(130, layout.hexSize * 2.2);
    const padBottom = Math.max(96, layout.hexSize * 1.7);
    // 缩得比整张图还小时，居中显示，避免 clamp 的上下界交叉把地图推到一边
    if (view.w >= layout.canvas.width + padX * 2) {
      view.x = (layout.canvas.width - view.w) / 2;
    } else {
      view.x = clamp(view.x, -padX, layout.canvas.width + padX - view.w);
    }
    if (view.h >= layout.canvas.height + padTop + padBottom) {
      view.y = (layout.canvas.height - view.h) / 2;
    } else {
      view.y = clamp(view.y, -padTop, layout.canvas.height + padBottom - view.h);
    }
  }

  function clientToSvg(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    return {
      x: view.x + ((clientX - rect.left) / Math.max(1, rect.width)) * view.w,
      y: view.y + ((clientY - rect.top) / Math.max(1, rect.height)) * view.h,
    };
  }

  function zoomBy(factor, anchor) {
    if (!layout) return;
    const minW = baseView.w / 2.6;
    const maxW = baseView.w * 1.25;
    const nextW = clamp(view.w / factor, minW, maxW);
    if (nextW === view.w) return;
    const actual = view.w / nextW;
    const a = anchor ? clientToSvg(anchor.clientX, anchor.clientY) : { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    view.x = a.x - (a.x - view.x) / actual;
    view.y = a.y - (a.y - view.y) / actual;
    view.h = nextW * (baseView.h / baseView.w);
    view.w = nextW;
    clampView();
    applyView();
  }

  function resetView() {
    view = { ...baseView };
    applyView();
  }

  // ── 数据入口 ──
  function setLayout(raw) {
    if (!raw || !Array.isArray(raw.regions)) {
      layout = null;
      render();
      return;
    }
    const canvas = {
      width: Number(raw.canvas?.width) > 0 ? Number(raw.canvas.width) : 1200,
      height: Number(raw.canvas?.height) > 0 ? Number(raw.canvas.height) : 820,
    };
    const kind = raw.kind === 'square' ? 'square' : raw.kind === 'hexboard' ? 'hexboard' : 'hex';
    const tile = raw.tile && Number(raw.tile.width) > 0 && Number(raw.tile.height) > 0
      ? {
          width: Number(raw.tile.width),
          height: Number(raw.tile.height),
          gap: Number.isFinite(Number(raw.tile.gap)) ? Number(raw.tile.gap) : 0,
        }
      : null;
    const hexSize = Number(raw.hexSize) > 0
      ? Number(raw.hexSize)
      : tile
        ? Math.min(tile.width, tile.height) / 2
        : 58;
    const regions = [];
    for (const item of raw.regions) {
      const x = Number(item?.x);
      const y = Number(item?.y);
      if (typeof item?.id !== 'string' || !item.id || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      regions.push({
        id: item.id,
        x,
        y,
        ...(Number.isInteger(item.col) ? { col: item.col } : {}),
        ...(Number.isInteger(item.row) ? { row: item.row } : {}),
      });
    }
    const factionColors = {};
    if (raw.factionColors && typeof raw.factionColors === 'object') {
      for (const [fid, color] of Object.entries(raw.factionColors)) {
        if (isHexColor(color)) factionColors[fid] = color.toLowerCase();
      }
    }
    const capitals = {};
    if (raw.capitals && typeof raw.capitals === 'object') {
      for (const [fid, rid] of Object.entries(raw.capitals)) {
        if (typeof rid === 'string') capitals[fid] = rid;
      }
    }
    const waterRoutes = [];
    if (Array.isArray(raw.waterRoutes)) {
      for (const route of raw.waterRoutes) {
        if (typeof route?.a !== 'string' || typeof route?.b !== 'string') continue;
        const cost = Number(route.cost);
        if (!Number.isFinite(cost) || cost <= 0) continue;
        waterRoutes.push({ a: route.a, b: route.b, cost });
      }
    }
    const ports = new Set(Array.isArray(raw.ports) ? raw.ports.filter((id) => typeof id === 'string') : []);
    const waterCells = Array.isArray(raw.waterCells)
      ? raw.waterCells
        .filter((cell) => cell && Number.isFinite(Number(cell.x)) && Number.isFinite(Number(cell.y)))
        .map((cell) => ({
          x: Number(cell.x),
          y: Number(cell.y),
          col: Number(cell.col),
          row: Number(cell.row),
        }))
      : [];
    const bridges = Array.isArray(raw.bridges)
      ? raw.bridges.filter((b) => b && typeof b.a === 'string' && typeof b.b === 'string')
      : [];
    const riverLabel = typeof raw.riverLabel === 'string' ? raw.riverLabel : '大江';
    let river = null;
    if (raw.river && ['top', 'bottom', 'left', 'right'].every((k) => Number.isFinite(Number(raw.river[k])))) {
      river = {
        top: Number(raw.river.top),
        bottom: Number(raw.river.bottom),
        left: Number(raw.river.left),
        right: Number(raw.river.right),
        label: typeof raw.river.label === 'string' ? raw.river.label : '大江',
        bridges: Array.isArray(raw.river.bridges)
          ? raw.river.bridges
            .filter((b) => Number.isFinite(Number(b?.x)) && Number.isFinite(Number(b?.width)))
            .map((b) => ({ col: Number(b.col), x: Number(b.x), width: Number(b.width) }))
          : [],
      };
    }
    layout = {
      kind, canvas, hexSize, tile, river, regions, factionColors, capitals,
      waterRoutes, ports, waterCells, bridges, riverLabel,
    };
    svg.classList.toggle('map--square', kind === 'square');
    svg.classList.toggle('map--hexboard', kind === 'hexboard');
    layoutById.clear();
    for (const r of regions) layoutById.set(r.id, r);

    // 上方留工具栏/提示条的位置，下方留图例的位置：六角格不再钻到浮层底下
    const padX = Math.max(24, hexSize * 0.5);
    const padTop = Math.max(130, hexSize * 2.2);
    const padBottom = Math.max(96, hexSize * 1.7);
    baseView = {
      x: -padX,
      y: -padTop,
      w: canvas.width + padX * 2,
      h: canvas.height + padTop + padBottom,
    };
    view = { ...baseView };
    svg.style.aspectRatio = `${baseView.w} / ${baseView.h}`;
    applyView();
    render();
  }

  function setSnapshot(snap) {
    snapshot = snap && Array.isArray(snap.regions) ? snap : null;
    snapById.clear();
    factionById.clear();
    if (snapshot) {
      for (const r of snapshot.regions) snapById.set(r.id, r);
      for (const f of snapshot.factions ?? []) factionById.set(f.id, f);
    }
    render();
  }

  function setActions(list) {
    actions = Array.isArray(list) ? list : [];
    refreshHighlights();
  }

  function setQueue(list) {
    queue = Array.isArray(list) ? list : [];
    refreshHighlights();
    renderOrderArrows();
  }

  function select(regionId) {
    selectedId = regionId;
    refreshHighlights();
  }

  function setPair(nextPair) {
    pair = nextPair && nextPair.source && nextPair.target ? { ...nextPair } : null;
    refreshHighlights();
  }

  function setHoveredOrder(index) {
    hoveredOrder = Number.isInteger(index) ? index : -1;
    for (const node of gOrders.querySelectorAll('.order-arrow, .order-badge')) {
      node.classList.toggle('is-hot', Number(node.getAttribute('data-order')) === hoveredOrder);
    }
  }

  // ── 渲染 ──
  function render() {
    gTerrain.replaceChildren();
    gRoads.replaceChildren();
    gActiveRoads.replaceChildren();
    gHexes.replaceChildren();
    gWater.replaceChildren();
    gOrders.replaceChildren();
    gFx.replaceChildren();
    regionEls = new Map();
    roadEls = new Map();
    if (!layout || !snapshot) return;

    if (layout.kind === 'square') renderSquareTerrain();
    if (layout.kind === 'hexboard') renderHexboardTerrain();
    if (layout.kind !== 'hexboard') renderRoads();
    renderHexes();
    if (layout.kind === 'square' || layout.kind === 'hexboard') renderWaterRoutes();
    refreshHighlights();
    renderOrderArrows();
  }

  function renderHexboardTerrain() {
    if (!layout) return;
    // 蓝色水格（纯视觉；规则上的跨水通行只发生在桥/水路上）
    for (const cell of layout.waterCells ?? []) {
      const g = svgEl('g', { class: 'water-cell' });
      g.append(svgEl('polygon', {
        points: hexPoints(cell.x, cell.y, layout.hexSize - 1.5),
        class: 'water-hex',
        'vector-effect': 'non-scaling-stroke',
      }));
      g.append(svgEl('path', {
        d: `M ${cell.x - layout.hexSize * 0.5} ${cell.y + 3} q ${layout.hexSize * 0.25} -7 ${layout.hexSize * 0.5} 0 t ${layout.hexSize * 0.5} 0`,
        class: 'water-wave',
      }));
      g.append(textEl('水', {
        x: cell.x,
        y: cell.y - layout.hexSize * 0.02,
        class: 'water-label',
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
      }));
      const title = svgEl('title');
      title.textContent = `${layout.riverLabel ?? '大江'} · 水师航道`;
      g.append(title);
      gTerrain.append(g);
    }
    // 桥：规则里的跨水普通邻接（陆军可过），从两端陆地中心连一条桥面
    for (const bridge of layout.bridges ?? []) {
      const a = layoutById.get(bridge.a);
      const b = layoutById.get(bridge.b);
      if (!a || !b) continue;
      const d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
      gTerrain.append(svgEl('path', {
        d,
        class: 'hex-bridge-shadow',
        'vector-effect': 'non-scaling-stroke',
      }));
      const deck = svgEl('path', {
        d,
        class: 'hex-bridge-deck',
        'vector-effect': 'non-scaling-stroke',
      });
      const title = svgEl('title');
      title.textContent = `石桥：陆军可过 ${regionDisplayName(bridge.a)} ↔ ${regionDisplayName(bridge.b)}`;
      deck.append(title);
      gTerrain.append(deck);
    }
    // 河名放在水域格包围盒中心
    if ((layout.waterCells ?? []).length > 0) {
      const xs = layout.waterCells.map((c) => c.x);
      const ys = layout.waterCells.map((c) => c.y);
      gTerrain.append(textEl(layout.riverLabel ?? '大江', {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: (Math.min(...ys) + Math.max(...ys)) / 2,
        class: 'river-label',
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
      }));
    }
  }

  function renderSquareTerrain() {
    if (!layout?.river) return;
    const r = layout.river;
    gTerrain.append(svgEl('rect', {
      x: r.left,
      y: r.top,
      width: r.right - r.left,
      height: r.bottom - r.top,
      class: 'river-band',
    }));
    // 两道水纹，纯装饰；不参与任何判定
    for (let i = 1; i <= 2; i++) {
      const y = r.top + ((r.bottom - r.top) * i) / 3;
      gTerrain.append(svgEl('path', {
        d: `M ${r.left + 18} ${y} Q ${(r.left + r.right) / 2} ${y - 4} ${r.right - 18} ${y}`,
        class: 'river-wave',
      }));
    }
    gTerrain.append(textEl(r.label, {
      x: (r.left + r.right) / 2,
      y: r.top + (r.bottom - r.top) / 2 + 1,
      class: 'river-label',
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
    }));
    for (const bridge of r.bridges) {
      const bridgeEl = svgEl('g', { class: 'bridge' });
      bridgeEl.append(svgEl('rect', {
        x: bridge.x - bridge.width / 2,
        y: r.top - 5,
        width: bridge.width,
        height: r.bottom - r.top + 10,
        rx: 3,
        class: 'bridge-deck',
      }));
      for (let i = -2; i <= 2; i++) {
        bridgeEl.append(svgEl('line', {
          x1: bridge.x + i * (bridge.width / 6),
          y1: r.top - 3,
          x2: bridge.x + i * (bridge.width / 6),
          y2: r.bottom + 3,
          class: 'bridge-plank',
        }));
      }
      const title = svgEl('title');
      title.textContent = '石桥：陆军可从这里过河';
      bridgeEl.append(title);
      gTerrain.append(bridgeEl);
    }
  }

  function regionDisplayName(regionId) {
    const region = snapById.get(regionId);
    if (!region) return regionId;
    return region.visibility === 'unknown' ? '未探明区域' : (region.name ?? regionId);
  }

  function renderWaterRoutes() {
    const drawnPorts = new Set();
    for (const route of layout?.waterRoutes ?? []) {
      const a = layoutById.get(route.a);
      const b = layoutById.get(route.b);
      if (!a || !b) continue;
      const path = svgEl('path', {
        d: roadPath(a, b, `water:${route.a}:${route.b}`, 0.55),
        class: 'water-route',
        'vector-effect': 'non-scaling-stroke',
      });
      const title = svgEl('title');
      title.textContent = `水路 ${regionDisplayName(route.a)} ↔ ${regionDisplayName(route.b)} · 水师专用 · 消耗 ${route.cost}`;
      path.append(title);
      gWater.append(path);
      for (const end of [route.a, route.b]) {
        if (drawnPorts.has(end)) continue;
        drawnPorts.add(end);
        const p = layoutById.get(end);
        if (!p) continue;
        const dot = svgEl('circle', { cx: p.x, cy: p.y, r: 3.5, class: 'water-port-dot' });
        const t = svgEl('title');
        t.textContent = `${regionDisplayName(end)} · 港口`;
        dot.append(t);
        gWater.append(dot);
      }
    }
  }

  function renderRoads() {
    const seen = new Set();
    for (const region of snapshot.regions) {
      for (const neighbor of region.adjacency ?? []) {
        const key = edgeKey(region.id, neighbor);
        if (seen.has(key)) continue;
        seen.add(key);
        const a = layoutById.get(region.id);
        const b = layoutById.get(neighbor);
        if (!a || !b) continue;
        const d = roadPath(a, b, key);
        const path = svgEl('path', { d, class: 'road', 'vector-effect': 'non-scaling-stroke' });
        const other = snapById.get(neighbor);
        if (region.visibility === 'unknown' || other?.visibility === 'unknown') {
          path.classList.add('road--fog');
        }
        const title = svgEl('title');
        const nameA = region.visibility === 'unknown' ? '未探明区域' : (region.name ?? region.id);
        const nameB = other?.visibility === 'unknown'
          ? '未探明区域'
          : (other?.name ?? neighbor);
        title.textContent = `${nameA} ↔ ${nameB}`;
        path.append(title);
        roadEls.set(key, path);
        gRoads.append(path);
      }
    }
  }

  function factionColor(factionId) {
    const fromLayout = layout.factionColors[factionId];
    const idx = (snapshot?.factions ?? []).findIndex((f) => f.id === factionId);
    const raw = isHexColor(fromLayout)
      ? fromLayout
      : FALLBACK_FACTION_COLORS[(idx >= 0 ? idx : hash(factionId)) % FALLBACK_FACTION_COLORS.length];
    return displayFactionColor(raw, factionId);
  }

  function renderHexes() {
    const selfId = snapshot.factions.find((f) => f.isSelf)?.id ?? null;
    const capitalOf = new Map();
    for (const [fid, rid] of Object.entries(layout.capitals)) capitalOf.set(rid, fid);

    for (const placed of layout.regions) {
      const region = snapById.get(placed.id);
      if (!region) continue;
      const known = region.visibility !== 'unknown';
      const isBoard = layout.kind === 'hexboard';
      const ownerColor = region.owner ? factionColor(region.owner) : NEUTRAL_COLOR;
      const terrainMeta = TERRAIN_META[region.terrain] ?? { glyph: '·', label: '未知', color: '#8b93a1' };
      const ownerFill = region.owner ? mix(ownerColor, '#0b0f14', 0.56) : mix(NEUTRAL_COLOR, '#0b0f14', 0.68);
      // 连续六角棋盘用"地形底色 + 势力色薄涂层"，更接近战棋地图；其余模式保持深色棋子格
      const fill = isBoard && known
        ? mix(terrainMeta.color, '#0b0f14', 0.46)
        : ownerFill;
      const border = region.owner ? mix(ownerColor, '#ffffff', 0.42) : mix(NEUTRAL_COLOR, '#ffffff', 0.3);

      const g = svgEl('g', {
        class: `hex vis-${region.visibility}`,
        'data-region': placed.id,
        tabindex: '0',
        role: 'button',
        'aria-label': ariaOf(region, region.owner ? factionById.get(region.owner)?.name : null),
      });
      g.style.setProperty('--owner', border);
      g.style.setProperty('--owner-fill', fill);
      g.style.setProperty('--owner-soft', rgba(ownerColor, 0.22));
      if (region.owner && region.owner === selfId) g.classList.add('is-self');

      if (layout.kind === 'square' && layout.tile) {
        const tw = layout.tile.width;
        const th = layout.tile.height;
        const x = placed.x - tw / 2;
        const y = placed.y - th / 2;
        g.append(svgEl('rect', {
          x, y, width: tw, height: th, rx: 6,
          class: 'hex-body',
          'vector-effect': 'non-scaling-stroke',
        }));
        g.append(svgEl('rect', {
          x: x - 4, y: y - 4, width: tw + 8, height: th + 8, rx: 8,
          class: 'hex-ring',
          'vector-effect': 'non-scaling-stroke',
        }));
        if (region.visibility === 'unknown') {
          g.append(svgEl('rect', {
            x: x + 3, y: y + 3, width: tw - 6, height: th - 6, rx: 4,
            fill: 'url(#fogHatch)',
            opacity: '0.5',
            'pointer-events': 'none',
          }));
        }
        if (region.owner && region.owner === selfId) {
          g.append(svgEl('rect', {
            x: x + 6, y: y + 6, width: tw - 12, height: th - 12, rx: 4,
            class: 'hex-self-ring',
            'vector-effect': 'non-scaling-stroke',
          }));
        }
      } else {
        g.append(svgEl('polygon', {
          points: hexPoints(placed.x, placed.y, layout.hexSize),
          class: 'hex-body',
          'vector-effect': 'non-scaling-stroke',
        }));
        // 水乡/河流地块给一层水色，否则在深色棋子格里只剩一个很小的“泽”字
        if (known && region.terrain === 'river') {
          g.append(svgEl('polygon', {
            points: hexPoints(placed.x, placed.y, layout.hexSize - 3),
            class: 'hex-water',
            'pointer-events': 'none',
          }));
        }
        if (isBoard && known && region.owner) {
          g.append(svgEl('polygon', {
            points: hexPoints(placed.x, placed.y, layout.hexSize - 1.5),
            fill: ownerColor,
            opacity: '0.34',
            class: 'hex-owner-tint',
            'pointer-events': 'none',
          }));
        }
        g.append(svgEl('polygon', {
          points: hexPoints(placed.x, placed.y, layout.hexSize + 4),
          class: 'hex-ring',
          'vector-effect': 'non-scaling-stroke',
        }));
        if (region.visibility === 'unknown') {
          g.append(svgEl('polygon', {
            points: hexPoints(placed.x, placed.y, layout.hexSize - 1),
            fill: 'url(#fogHatch)',
            opacity: '0.5',
            'pointer-events': 'none',
          }));
        }
        if (region.owner && region.owner === selfId) {
          g.append(svgEl('polygon', {
            points: hexPoints(placed.x, placed.y, layout.hexSize - 6),
            class: 'hex-self-ring',
            'vector-effect': 'non-scaling-stroke',
          }));
        }
      }

      // 地形（未知区不泄露）
      if (known) {
        const glyph = textEl(terrainMeta.glyph, {
          x: placed.x - layout.hexSize * 0.58,
          y: placed.y - layout.hexSize * 0.46,
          class: 'hex-terrain',
          'text-anchor': 'middle',
        });
        glyph.style.fill = terrainMeta.color;
        const t = svgEl('title');
        t.textContent = terrainMeta.label;
        glyph.append(t);
        g.append(glyph);
      }

      // 首都星标（未知区不标）
      const capitalOwner = capitalOf.get(placed.id);
      if (known && capitalOwner !== undefined) {
        const isSelfCapital = capitalOwner === selfId;
        const star = textEl('★', {
          x: placed.x + layout.hexSize * 0.55,
          y: placed.y - layout.hexSize * 0.43,
          class: `hex-star${isSelfCapital ? ' is-self' : ''}`,
          'text-anchor': 'middle',
        });
        const t = svgEl('title');
        t.textContent = isSelfCapital ? '我方首都' : '都城';
        star.append(t);
        g.append(star);
      }

      // 港口标（仅方块棋盘；未知区不标）
      if (known && (layout.kind === 'square' || layout.kind === 'hexboard') && layout.ports.has(placed.id)) {
        const port = textEl('港', {
          x: placed.x + layout.hexSize * 0.62,
          y: placed.y + layout.hexSize * 0.05,
          class: 'hex-port',
          'text-anchor': 'middle',
        });
        const t = svgEl('title');
        t.textContent = '港口：水师可征募/停泊';
        port.append(t);
        g.append(port);
      }

      // 区域名：势力首字 + 区域名，颜色对比不足时也能一眼认出归属
      const name = known ? region.name : '？';
      const nameEl = svgEl('text', {
        x: placed.x,
        y: placed.y - layout.hexSize * 0.16,
        class: `hex-name${known ? '' : ' is-unknown'}`,
        'text-anchor': 'middle',
      });
      if (known && region.owner) {
        const ownerInitial = String(factionById.get(region.owner)?.name ?? '').slice(0, 1);
        if (ownerInitial) {
          const tag = svgEl('tspan', { fill: lightenFactionColor(ownerColor, 0.22), class: 'hex-faction-tag' });
          tag.textContent = `${ownerInitial}·`;
          const main = svgEl('tspan');
          main.textContent = region.name;
          nameEl.append(tag, main);
        } else {
          nameEl.textContent = region.name;
        }
      } else {
        nameEl.textContent = name;
      }
      g.append(nameEl);

      // 兵力棋子
      appendGarrison(g, placed, region, ownerColor, selfId);

      // 要塞 / 发展度
      if (region.visibility === 'full') {
        if (Number.isFinite(region.fortLevel) && region.fortLevel > 0) {
          g.append(textEl(`堡${region.fortLevel}`, {
            x: placed.x - layout.hexSize * 0.55,
            y: placed.y + layout.hexSize * 0.66,
            class: 'hex-mini',
            'text-anchor': 'middle',
          }));
        }
        if (region.developmentLabel) {
          g.append(textEl(`治${region.developmentLabel}`, {
            x: placed.x + layout.hexSize * 0.52,
            y: placed.y + layout.hexSize * 0.68,
            class: 'hex-mini',
            'text-anchor': 'middle',
          }));
        }
        if (Number.isFinite(region.infrastructure) && region.infrastructure > 0) {
          g.append(textEl(`基${region.infrastructure}`, {
            x: placed.x + layout.hexSize * 0.52,
            y: placed.y + layout.hexSize * 0.45,
            class: 'hex-mini hex-mini--infra',
            'text-anchor': 'middle',
          }));
        }
      }

      const title = svgEl('title');
      title.textContent = tooltipOf(region);
      g.append(title);

      g.addEventListener('click', (event) => {
        if (suppressClick) return;
        event.stopPropagation();
        opts.onSelect?.(placed.id);
      });
      g.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        opts.onSelect?.(placed.id);
      });
      g.addEventListener('pointerenter', () => highlightIncidentRoads(placed.id, true));
      g.addEventListener('pointerleave', () => highlightIncidentRoads(placed.id, false));
      g.addEventListener('focus', () => highlightIncidentRoads(placed.id, true));
      g.addEventListener('blur', () => highlightIncidentRoads(placed.id, false));

      regionEls.set(placed.id, g);
      gHexes.append(g);
    }
  }

  function appendGarrison(g, placed, region, ownerColor, selfId) {
    const visibility = region.visibility;
    const cx = placed.x;
    const cy = placed.y + layout.hexSize * 0.32;
    const ownerName = region.owner ? (factionById.get(region.owner)?.name ?? region.ownerName ?? region.owner) : '中立';

    if (visibility === 'unknown') {
      g.append(textEl('？', {
        x: placed.x,
        y: placed.y + layout.hexSize * 0.22,
        class: 'hex-unknown-mark',
        'text-anchor': 'middle',
      }));
      g.append(textEl('未探明', {
        x: placed.x,
        y: placed.y + layout.hexSize * 0.68,
        class: 'hex-sub',
        'text-anchor': 'middle',
      }));
      return;
    }

    if (visibility === 'name_only') {
      const label = textEl(ownerName, {
        x: placed.x,
        y: placed.y + layout.hexSize * 0.32,
        class: 'hex-owner-only',
        'text-anchor': 'middle',
      });
      label.style.fill = ownerColor;
      g.append(label);
      g.append(textEl('仅知归属', {
        x: placed.x,
        y: placed.y + layout.hexSize * 0.66,
        class: 'hex-sub',
        'text-anchor': 'middle',
      }));
      return;
    }

    if (visibility === 'partial') {
      g.append(svgEl('circle', {
        cx, cy, r: layout.hexSize * 0.4,
        class: 'garrison garrison--unknown',
      }));
      g.append(textEl('?', {
        x: cx, y: cy + 1, class: 'garrison-count', 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      }));
      g.append(textEl('邻境情报', {
        x: placed.x,
        y: placed.y + layout.hexSize * 0.9,
        class: 'hex-sub',
        'text-anchor': 'middle',
      }));
      return;
    }

    // full：精确驻军
    const stacks = Array.isArray(region.stacks) ? region.stacks : [];
    if (stacks.length === 0) {
      g.append(textEl('无驻军', {
        x: placed.x,
        y: placed.y + layout.hexSize * 0.35,
        class: 'hex-empty',
        'text-anchor': 'middle',
      }));
      return;
    }
    const total = stacks.reduce((sum, s) => sum + (Number(s.troops) || 0), 0);
    const morale = region.owner ? (factionById.get(region.owner)?.morale ?? null) : null;
    // 只做视觉提示：水师棋子加蓝色描边；兵种名来自快照，不参与规则
    const hasWaterStack = stacks.some((s) => String(s.typeName ?? '').includes('水'));
    g.append(svgEl('circle', {
      cx, cy, r: layout.hexSize * 0.4,
      class: `garrison${hasWaterStack ? ' garrison--water' : ''}`,
    }));
    const countEl = textEl(compactTroops(total), {
      x: cx, y: cy - 2,
      class: `garrison-count${total >= 100000 ? ' is-long' : ''}`,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
    });
    g.append(countEl);
    if (morale !== null) {
      g.append(textEl(`民${morale}`, {
        x: cx, y: cy + layout.hexSize * 0.18,
        class: 'garrison-morale',
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
      }));
    }
    if (stacks.length > 1) {
      g.append(svgEl('circle', {
        cx: cx + layout.hexSize * 0.32, cy: cy - layout.hexSize * 0.25, r: 7.5,
        class: 'stack-badge',
      }));
      g.append(textEl(`×${stacks.length}`, {
        x: cx + layout.hexSize * 0.32,
        y: cy - layout.hexSize * 0.25 + 0.5,
        class: 'stack-badge-text',
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
      }));
    }
    // 己方棋子脚下加一点金光，便于扫视
    if (region.owner && region.owner === selfId) {
      g.append(textEl('我', {
        x: placed.x - layout.hexSize * 0.55,
        y: placed.y - layout.hexSize * 0.12,
        class: 'hex-mine',
        'text-anchor': 'middle',
      }));
    }
  }

  function ariaOf(region, ownerName) {
    if (region.visibility === 'unknown') return '未探明区域，位置已知，归属与驻军不可见';
    const bits = [region.name ?? region.id];
    bits.push(ownerName ? `归属${ownerName}` : '中立');
    const vis = { full: '完全掌握', partial: '邻境情报', name_only: '仅知归属', unknown: '未探明' }[region.visibility] ?? region.visibility;
    bits.push(vis);
    const stacks = Array.isArray(region.stacks) ? region.stacks : [];
    if (stacks.length > 0) bits.push(`驻军${stacks.reduce((s, x) => s + x.troops, 0)}`);
    if (layout?.kind === 'square' && layout.ports.has(region.id)) bits.push('港口');
    return bits.join('，');
  }

  function tooltipOf(region) {
    if (region.visibility === 'unknown') return '未探明区域\n位置已知，归属与驻军均不可见';
    const lines = [region.name ?? region.id];
    lines.push(`归属：${region.ownerName ?? '中立'}`);
    lines.push(`视野：${{ full: '完全掌握', partial: '邻境情报', name_only: '仅知归属', unknown: '未探明' }[region.visibility] ?? region.visibility}`);
    if (region.terrain) {
      lines.push(`地形：${TERRAIN_META[region.terrain]?.label ?? region.terrain}`);
      const trait = (layout?.terrain ?? []).find((t) => t.id === region.terrain);
      if (trait) {
        lines.push(
          `地形效果：粮×${trait.food}、金×${trait.gold}、人口×${trait.popGrowth}、` +
          `情报费×${trait.intelCost}、行军×${trait.moveCost}、守军×${trait.defenderBonus}` +
          (trait.infantryDefense > 1 ? `、步兵守备×${trait.infantryDefense}` : ''),
        );
      }
    }
    if (Number.isFinite(region.population)) lines.push(`人口：${Math.round(region.population).toLocaleString('zh-CN')}`);
    if (Number.isFinite(region.fortLevel)) lines.push(`要塞：Lv${region.fortLevel}`);
    if (region.developmentLabel) lines.push(`发展：${region.developmentLabel}`);
    if (Number.isFinite(region.unrest)) lines.push(`地区动乱：${region.unrest}/100`);
    if (region.rebellion) {
      const reb = region.rebellion;
      lines.push(
        reb.claimedBy
          ? `起义区：原属 ${reb.originalName ?? reb.original}，已归附 ${reb.claimedByName ?? reb.claimedBy}（起义民兵 ${reb.rebelTroops}）`
          : `起义区：原属 ${reb.originalName ?? reb.original}，起义民兵 ${reb.rebelTroops}`,
      );
    }
    if (region.frontier && region.owner === null) {
      lines.push(`荒地：原住民 ${region.frontier.natives} · 开荒 ${region.frontier.goldCost} 金 / ${region.frontier.foodCost} 粮 · 基建 Lv${region.frontier.infrastructure}`);
    }
    const infraLevel = Number(region.infrastructure);
    if (Number.isFinite(infraLevel) && infraLevel > 0) {
      const def = layout?.rules?.infrastructure?.levels?.find((l) => l.level === infraLevel);
      lines.push(
        `基建：Lv${infraLevel}${def?.name ? ` ${def.name}` : ''}` +
        (def ? `（动乱 -${def.unrestReductionPerTurn}/回合，人口 +${(def.populationGrowthBonus * 100).toFixed(1)}%/回合）` : ''),
      );
    }
    if (layout?.kind === 'square' && layout.ports.has(region.id)) {
      const waterNeighbors = (layout.waterRoutes ?? [])
        .filter((route) => route.a === region.id || route.b === region.id)
        .map((route) => regionDisplayName(route.a === region.id ? route.b : route.a));
      lines.push(`港口：水师可征募/停泊${waterNeighbors.length > 0 ? `；水路通往 ${waterNeighbors.join('、')}` : ''}`);
    }
    const stacks = Array.isArray(region.stacks) ? region.stacks : [];
    if (stacks.length > 0) {
      lines.push(`驻军：${stacks.map((s) => {
        const title = s.title === 'bandit_conscript' ? '·贼配军' : s.title === 'rebel_militia' ? '·起义民兵' : s.title === 'rebel_garrison' ? '·守城民兵' : '';
        return `${s.typeName}${title} ${s.troops}`;
      }).join('、')}`);
      lines.push(`合计：${stacks.reduce((sum, s) => sum + s.troops, 0)}`);
    }
    if (region.tacticalNote) lines.push(region.tacticalNote);
    return lines.join('\n');
  }

  function highlightIncidentRoads(regionId, on) {
    for (const [key, path] of roadEls) {
      if (key.split('|').includes(regionId)) path.classList.toggle('is-near', on);
    }
  }

  function pointsOfPath(pathIds) {
    const points = [];
    for (const id of Array.isArray(pathIds) ? pathIds : []) {
      const p = layoutById.get(id);
      if (p) points.push(p);
    }
    return points;
  }

  /** 折线路径；trimStart/trimEnd 只沿首尾段裁剪，避免箭头压住棋子 */
  function polylineD(points, trimStart = 0, trimEnd = 0) {
    if (points.length < 2) return null;
    const pts = points.map((p) => ({ x: p.x, y: p.y }));
    const start = { ...pts[0] };
    if (trimStart > 0) {
      const next = pts[1];
      const len = Math.hypot(next.x - start.x, next.y - start.y) || 1;
      const t = Math.min(0.45, trimStart / len);
      start.x += (next.x - start.x) * t;
      start.y += (next.y - start.y) * t;
    }
    const end = { ...pts[pts.length - 1] };
    if (trimEnd > 0) {
      const prev = pts[pts.length - 2];
      const len = Math.hypot(end.x - prev.x, end.y - prev.y) || 1;
      const t = Math.min(0.45, trimEnd / len);
      end.x += (prev.x - end.x) * t;
      end.y += (prev.y - end.y) * t;
    }
    const parts = [`M ${start.x.toFixed(2)} ${start.y.toFixed(2)}`];
    for (let i = 1; i < pts.length - 1; i++) parts.push(`L ${pts[i].x.toFixed(2)} ${pts[i].y.toFixed(2)}`);
    parts.push(`L ${end.x.toFixed(2)} ${end.y.toFixed(2)}`);
    return parts.join(' ');
  }

  function midpointOfPath(points) {
    if (points.length === 0) return null;
    if (points.length === 1) return { x: points[0].x, y: points[0].y };
    const segs = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const len = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      segs.push(len);
      total += len;
    }
    let remain = total / 2;
    for (let i = 0; i < segs.length; i++) {
      if (remain <= segs[i] || i === segs.length - 1) {
        const t = segs[i] > 0 ? remain / segs[i] : 0;
        return {
          x: points[i].x + (points[i + 1].x - points[i].x) * t,
          y: points[i].y + (points[i + 1].y - points[i].y) * t,
        };
      }
      remain -= segs[i];
    }
    return { x: points[points.length - 1].x, y: points[points.length - 1].y };
  }

  function refreshHighlights() {
    for (const g of regionEls.values()) {
      g.classList.remove('is-selected', 'is-pair-source', 'is-pair-target', 'in-queue', 'has-action',
        'is-target-attack', 'is-target-move', 'is-target-support');
    }
    gActiveRoads.replaceChildren();

    const sources = new Set();
    for (const a of actions) if (typeof a.sourceRegion === 'string') sources.add(a.sourceRegion);
    for (const id of sources) regionEls.get(id)?.classList.add('has-action');

    if (selectedId) regionEls.get(selectedId)?.classList.add('is-selected');

    // 选中己方区域后：高亮所有可下单的目标与实际路径
    if (selectedId) {
      const targetInfo = new Map();
      for (const a of actions) {
        if (a.sourceRegion !== selectedId || typeof a.targetRegion !== 'string') continue;
        if (a.targetRegion === selectedId) continue;
        const kind = a.kind === 'attack' ? 'attack' : a.kind === 'move_units' ? 'move' : 'support';
        const priority = kind === 'attack' ? 3 : kind === 'move' ? 2 : 1;
        const prev = targetInfo.get(a.targetRegion);
        if (prev && prev.priority >= priority) continue;
        targetInfo.set(a.targetRegion, {
          kind,
          priority,
          path: Array.isArray(a.path) && a.path.length >= 2 ? a.path : [selectedId, a.targetRegion],
        });
      }
      for (const [target, info] of targetInfo) {
        const g = regionEls.get(target);
        if (!g) continue;
        g.classList.add(`is-target-${info.kind}`);
        if (info.kind === 'support') continue;
        const d = polylineD(pointsOfPath(info.path));
        if (!d) continue;
        gActiveRoads.append(svgEl('path', {
          d,
          class: `active-road active-road--${info.kind}`,
          'vector-effect': 'non-scaling-stroke',
        }));
      }
    }

    if (pair) {
      regionEls.get(pair.source)?.classList.add('is-pair-source');
      regionEls.get(pair.target)?.classList.add('is-pair-target');
      const path = roadEls.get(edgeKey(pair.source, pair.target));
      if (path) {
        const active = path.cloneNode(false);
        active.setAttribute('class', 'active-road active-road--pair');
        gActiveRoads.append(active);
      }
    }

    for (const order of queue) {
      if (order?.sourceRegion) regionEls.get(order.sourceRegion)?.classList.add('in-queue');
      if (order?.targetRegion) regionEls.get(order.targetRegion)?.classList.add('in-queue');
    }

    renderOrderArrows();
  }

  function renderOrderArrows() {
    gOrders.replaceChildren();
    if (!layout) return;
    queue.forEach((order, index) => {
      const source = order?.sourceRegion ? layoutById.get(order.sourceRegion) : null;
      const target = order?.targetRegion ? layoutById.get(order.targetRegion) : null;
      if (!source || !target || source === target) return;

      const pathIds = Array.isArray(order.path) && order.path.length >= 2
        ? order.path
        : [order.sourceRegion, order.targetRegion];
      const points = pointsOfPath(pathIds);
      if (points.length < 2) return;
      const trim = layout.kind === 'square'
        ? Math.max(24, layout.hexSize * 0.5)
        : layout.hexSize * 0.55;
      const d = polylineD(points, trim, trim);
      if (!d) return;

      const kind = order.kind ?? 'move_units';
      const color = ACTION_KIND_META[kind]?.color ?? '#d8c07a';
      const marker = kind === 'attack' ? 'arrow-attack' : kind === 'move_units' ? 'arrow-move' : 'arrow-default';
      const line = svgEl('path', {
        d,
        class: `order-arrow order-arrow--${kind === 'attack' ? 'attack' : 'move'}`,
        'data-order': index,
        'marker-end': `url(#${marker})`,
        'vector-effect': 'non-scaling-stroke',
      });
      line.style.stroke = color;
      const title = svgEl('title');
      title.textContent = order.label ?? '军令';
      line.append(title);
      gOrders.append(line);

      const mid = midpointOfPath(points);
      if (!mid) return;
      const badge = svgEl('g', { class: 'order-badge', 'data-order': index });
      const circle = svgEl('circle', { cx: mid.x, cy: mid.y, r: 9, class: 'order-badge-bg' });
      circle.style.stroke = color;
      const label = textEl(String(index + 1), {
        x: mid.x, y: mid.y + 0.5, class: 'order-badge-text', 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      });
      const btitle = svgEl('title');
      btitle.textContent = order.label ?? '军令';
      badge.append(circle, label, btitle);
      gOrders.append(badge);
    });
    setHoveredOrder(hoveredOrder);
  }

  // ── 事件动画 ──
  function playEvents(events) {
    if (!layout || !snapshot || REDUCED_MOTION) return;
    for (const event of Array.isArray(events) ? events : []) {
      if (!event || typeof event.type !== 'string') continue;
      switch (event.type) {
        case 'combat_resolved': {
          const region = snapById.get(event.regionId);
          if (!region || region.visibility === 'unknown') break;
          const g = regionEls.get(event.regionId);
          if (!g) break;
          g.classList.remove('fx-battle');
          void g.getBoundingClientRect();
          g.classList.add('fx-battle');
          setTimeout(() => g.classList.remove('fx-battle'), 1000);
          spawnFloat(event.regionId, `战 · ${outcomeLabel(event.evidence?.outcome)}`, 'fx-float--battle');
          break;
        }
        case 'region_captured': {
          const region = snapById.get(event.regionId);
          if (!region || region.visibility === 'unknown') break;
          const g = regionEls.get(event.regionId);
          if (g) {
            g.classList.remove('fx-capture');
            void g.getBoundingClientRect();
            g.classList.add('fx-capture');
            setTimeout(() => g.classList.remove('fx-capture'), 1300);
          }
          const color = event.to ? factionColor(event.to) : '#e0c06a';
          spawnFloat(event.regionId, '旗 · 易主', 'fx-float--capture', color);
          break;
        }
        case 'units_moved': {
          if (!event.path || !Array.isArray(event.path) || event.path.length < 2) break;
          const points = event.path.map((id) => layoutById.get(id)).filter(Boolean);
          if (points.length < 2) break;
          if (event.from && snapById.get(event.from)?.visibility === 'unknown') break;
          const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
          animateAlong(d, '#8fd3c9');
          break;
        }
        case 'units_split':
        case 'units_merged': {
          if (snapById.get(event.regionId)?.visibility === 'unknown') break;
          spawnFloat(
            event.regionId,
            event.type === 'units_split' ? `分 ${event.count}` : `合 ${event.count}`,
            'fx-float--gain',
          );
          break;
        }
        case 'recruitment_completed': {
          if (snapById.get(event.regionId)?.visibility === 'unknown') break;
          spawnFloat(event.regionId, `+${event.count} 兵`, 'fx-float--gain');
          break;
        }
        case 'development_completed': {
          if (snapById.get(event.regionId)?.visibility === 'unknown') break;
          spawnFloat(event.regionId, `治 ${event.fromLevel}→${event.toLevel}`, 'fx-float--gain');
          break;
        }
        case 'infrastructure_completed': {
          if (snapById.get(event.regionId)?.visibility === 'unknown') break;
          spawnFloat(event.regionId, `基 ${event.fromLevel}→${event.toLevel}`, 'fx-float--gain');
          break;
        }
        case 'spy_reported': {
          if (snapById.get(event.regionId)?.visibility === 'unknown') break;
          spawnFloat(event.regionId, '谍 · 情报', 'fx-float--gain');
          break;
        }
        default:
          break;
      }
    }
  }

  function spawnFloat(regionId, text, cls, color) {
    const placed = layoutById.get(regionId);
    if (!placed) return;
    const node = textEl(text, {
      x: placed.x,
      y: placed.y - layout.hexSize * 0.55,
      class: `fx-float ${cls}`,
      'text-anchor': 'middle',
    });
    if (color) node.style.fill = mix(color, '#ffffff', 0.35);
    gFx.append(node);
    setTimeout(() => node.remove(), 1600);
  }

  function animateAlong(d, color) {
    const dot = svgEl('circle', { r: 5.5, class: 'fx-march-dot' });
    dot.style.fill = mix(color, '#ffffff', 0.25);
    dot.style.filter = `drop-shadow(0 0 6px ${rgba(color, 0.9)})`;
    const motion = svgEl('animateMotion', { dur: '0.9s', fill: 'freeze', path: d });
    dot.append(motion);
    gFx.append(dot);
    try { motion.beginElement(); } catch { /* 不支持 SMIL 就只显示起点，不影响功能 */ }
    setTimeout(() => dot.remove(), 1100);
  }

  // ── 战斗可视化：战场标记 / 进攻箭头 / 逐场播放 ──
  const battleMarkerNodes = [];

  function clearBattleMarkers() {
    for (const node of battleMarkerNodes.splice(0)) node.remove();
    for (const g of regionEls.values()) g.classList.remove('is-battle-now', 'is-battle-done');
  }

  /** 把战场挪进视野（不改变缩放）；已经在视野内就什么都不做 */
  function ensureVisible(regionId) {
    const placed = layoutById.get(regionId);
    if (!placed || !layout) return;
    const margin = layout.hexSize * 1.2;
    const inView =
      placed.x > view.x + margin &&
      placed.x < view.x + view.w - margin &&
      placed.y > view.y + margin &&
      placed.y < view.y + view.h - margin;
    if (inView) return;
    view.x = placed.x - view.w / 2;
    view.y = placed.y - view.h / 2;
    clampView();
    applyView();
  }

  /** 定位到某区域（用于「定位战场」按钮）：居中并适度拉近 */
  function focusRegion(regionId) {
    const placed = layoutById.get(regionId);
    if (!placed) return;
    const targetW = clamp(baseView.w / 1.45, baseView.w / 2.6, baseView.w * 1.25);
    view.w = targetW;
    view.h = targetW * (baseView.h / baseView.w);
    view.x = placed.x - view.w / 2;
    view.y = placed.y - view.h / 2;
    clampView();
    applyView();
  }

  /** 在全部交战地画编号钉子，让玩家先看到「这一回合哪里开战」 */
  function showBattleMarkers(battles) {
    clearBattleMarkers();
    if (!layout || REDUCED_MOTION) return;
    (Array.isArray(battles) ? battles : []).forEach((battle, index) => {
      const placed = layoutById.get(battle?.regionId);
      if (!placed) return;
      const g = svgEl('g', { class: 'battle-pin', 'data-battle': String(index) });
      const x = placed.x + layout.hexSize * 0.58;
      const y = placed.y - layout.hexSize * 0.62;
      g.append(svgEl('circle', { cx: x, cy: y, r: 12, class: 'battle-pin-bg' }));
      g.append(textEl(String(index + 1), {
        x, y: y + 0.5, class: 'battle-pin-text', 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      }));
      const title = svgEl('title');
      title.textContent = `${regionDisplayName(battle.regionId)}：${outcomeLabel(battle.outcome)}`;
      g.append(title);
      gFx.append(g);
      battleMarkerNodes.push(g);
    });
  }

  /**
   * 播放一场战斗：从出发地拉红色进攻箭头到交战地，目标格脉冲，浮出战果。
   * 返回 Promise，调用方可以按顺序 await（形成「第 1/3 场 → 第 2/3 场」的时间线）。
   */
  function playBattle(battle, opts = {}) {
    const duration = REDUCED_MOTION ? 180 : Number(opts.duration) || 1400;
    return new Promise((resolve) => {
      const placed = layoutById.get(battle?.regionId);
      if (!placed || !layout) {
        resolve();
        return;
      }
      ensureVisible(battle.regionId);
      const g = regionEls.get(battle.regionId);
      if (g) {
        g.classList.remove('is-battle-done');
        g.classList.add('is-battle-now');
      }

      const layer = svgEl('g', { class: 'battle-fx' });
      const pathIds = Array.isArray(battle.attackPath) && battle.attackPath.length >= 2
        ? battle.attackPath
        : battle.originRegion && battle.originRegion !== battle.regionId
          ? [battle.originRegion, battle.regionId]
          : null;
      const points = pathIds ? pointsOfPath(pathIds) : [];
      if (points.length >= 2) {
        const trim = layout.hexSize * 0.6;
        const d = polylineD(points, trim, trim);
        if (d) {
          const strike = svgEl('path', {
            d,
            class: 'battle-strike',
            'marker-end': 'url(#arrow-attack)',
            'vector-effect': 'non-scaling-stroke',
          });
          layer.append(strike);
          animateAlong(d, '#ff7a66');
        }
      }
      const ring = svgEl('circle', {
        cx: placed.x, cy: placed.y, r: layout.hexSize * 0.72, class: 'battle-ring',
      });
      layer.append(ring);
      gFx.append(layer);

      const label = battle.captured ? '城破 · 易主' : outcomeLabel(battle.outcome);
      spawnFloat(battle.regionId, `战 · ${label}`, 'fx-float--battle');

      setTimeout(() => {
        // ★清理失败也必须 resolve：否则一场战斗的动画异常会把整条战况时间线卡死
        try {
          layer.remove();
          if (g) {
            g.classList.remove('is-battle-now');
            g.classList.add('is-battle-done');
          }
        } finally {
          resolve();
        }
      }, duration);
    });
  }

  // ── 对外 ──
  return {
    setLayout,
    setSnapshot,
    setActions,
    setQueue,
    select,
    setPair,
    setHoveredOrder,
    playEvents,
    playBattle,
    showBattleMarkers,
    clearBattleMarkers,
    ensureVisible,
    focusRegion,
    zoomBy,
    resetView,
    get view() {
      return { ...view };
    },
  };
}

// ─────────────────────────────────────────────────────────────
// defs（箭头 / 迷雾纹理）
// ─────────────────────────────────────────────────────────────

function buildDefs(defs) {
  const hatch = svgEl('pattern', {
    id: 'fogHatch',
    width: 8,
    height: 8,
    patternUnits: 'userSpaceOnUse',
    patternTransform: 'rotate(45)',
  });
  hatch.append(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: '#5b636e', 'stroke-width': 1 }));
  defs.append(hatch);

  const markers = [
    ['arrow-attack', '#e06c5e'],
    ['arrow-move', '#6fb1d8'],
    ['arrow-default', '#d8c07a'],
  ];
  for (const [id, color] of markers) {
    const marker = svgEl('marker', {
      id,
      viewBox: '0 0 10 10',
      refX: 8,
      refY: 5,
      markerWidth: 5,
      markerHeight: 5,
      orient: 'auto-start-reverse',
    });
    marker.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }));
    defs.append(marker);
  }
}

// 供页面兜底布局复用
export { roadPath };
