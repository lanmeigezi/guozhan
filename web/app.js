/**
 * 国战沙盘 · 网页参考客户端
 *
 * 交互主线（Hex Empire 式）：点己方六角格 → 地图高亮引擎给出的合法目标 →
 * 点目标格把 action.command 原样加入军令。前端不解析规则、不自己拼命令，
 * 所有可执行动作都来自 GET /rooms/:id/actions。
 *
 * 数据分工：
 *   · 布局（坐标/阵营色/首都）连上后拉一次 GET /layout；
 *   · 归属/兵力/视野每回合来自按接收者投影的 /snapshot；
 *   · 事件流只负责"播报与动画"，不当作状态真相。
 */
import { createGuozhanClient } from '../extensions/sillytavern-guozhan/lib/client.js';
import {
  createMapView,
  ACTION_KIND_META,
  TERRAIN_META,
  FALLBACK_FACTION_COLORS,
} from './map-view.js';
import { displayFactionColor } from './faction-colors.js';

const $ = (id) => document.getElementById(id);

const QUICKSTART_SCENARIOS = Object.freeze([
  {
    id: 'random-front-v2',
    name: '隨機六角 · 4 人（民心篇）',
    factions: [
      { id: 'north', name: '北庭' }, { id: 'east', name: '東海' },
      { id: 'west', name: '西川' }, { id: 'south', name: '南越' },
    ],
  },
  {
    id: 'grand-front',
    name: '超大陸 · 12 雄（最多 12 人）',
    factions: [
      { id: 'north', name: '北庭' }, { id: 'east', name: '東海' },
      { id: 'west', name: '西川' }, { id: 'south', name: '南越' },
      { id: 'qin', name: '秦' }, { id: 'chu', name: '楚' },
      { id: 'qi', name: '齊' }, { id: 'yan', name: '燕' },
      { id: 'zhao', name: '趙' }, { id: 'wei', name: '魏' },
      { id: 'han', name: '韓' }, { id: 'wu', name: '吳' },
    ],
  },
  {
    id: 'frontier',
    name: '開荒 · 自訂地圖（4 人）',
    factions: [
      { id: 'red', name: '赤原裔' }, { id: 'blue', name: '蒼河裔' },
      { id: 'green', name: '青林裔' }, { id: 'gold', name: '金丘裔' },
    ],
  },
  {
    id: 'iron-front',
    name: '鐵河棋局（4 人）',
    factions: [
      { id: 'north', name: '北庭' }, { id: 'east', name: '東海' },
      { id: 'west', name: '西川' }, { id: 'south', name: '南越' },
    ],
  },
  {
    id: 'warring-states',
    name: '戰國七雄（7 人）',
    factions: [
      { id: 'qin', name: '秦' }, { id: 'zhao', name: '趙' },
      { id: 'wei', name: '魏' }, { id: 'han', name: '韓' },
      { id: 'qi', name: '齊' }, { id: 'chu', name: '楚' },
      { id: 'yan', name: '燕' },
    ],
  },
  {
    id: 'aria',
    name: '艾利亞 · 星冠崩碎（6 人）',
    factions: [
      { id: 'emberfall', name: '燼落王朝' }, { id: 'drakmoor', name: '龍崖公國' },
      { id: 'valkyr', name: '荒嘯部族' }, { id: 'aurelia', name: '金穗商盟' },
      { id: 'thornwall', name: '荊墻領' }, { id: 'verdantholm', name: '翠谷議庭' },
    ],
  },
  {
    id: 'random-front',
    name: '隨機六角 · 4 人（經典）',
    factions: [
      { id: 'north', name: '北庭' }, { id: 'east', name: '東海' },
      { id: 'west', name: '西川' }, { id: 'south', name: '南越' },
    ],
  },
]);

const S = {
  client: null,
  stream: null,
  connected: false,
  roomId: '',
  seatId: '',
  snapshot: null,
  layout: null,
  actions: [],
  queue: [],
  selected: null,
  pair: null,
  filterMode: 'all',
  lockedTurn: null,
  pendingEffects: [],
  refreshTimer: null,
  refreshing: false,
  seenOffsets: new Set(),
  selfId: null,
  lastReport: null,
  lastReportBattles: [],
  pendingBattleTurn: null,
  playedBattleTurns: new Set(),
  playingBattles: false,
  currentBattleList: [],
  hudBattle: null,
  hudHideTimer: null,
  skipBattlePlayback: false,
  refreshAfterBattle: false,
};

const map = createMapView({
  svg: $('mapSvg'),
  onSelect: (regionId) => handleMapSelect(regionId),
  onView: ({ zoom }) => {
    $('zoomLabel').textContent = `${Math.round(zoom * 100)}%`;
  },
});

// ─────────────────────────────────────────────────────────────
// DOM 小工具
// ─────────────────────────────────────────────────────────────

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function compactTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function formatTroops(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}

function phaseLabel(phase) {
  return { submitting: '下令', resolving: '结算', ended: '终局' }[phase] ?? phase;
}

function endReasonLabel(reason) {
  return {
    conquest: '征服胜利',
    turn_limit: '回合上限',
    resignation: '认输',
    draw: '平局',
  }[reason] ?? (reason || '终局');
}

function winnerName(snap) {
  if (!snap?.winner) return null;
  return snap.factions?.find((f) => f.id === snap.winner)?.name ?? snap.winner;
}

/** 终局结果文案：区分“平局”和“旧服务端没下发 winner 字段” */
function endResultText(snap) {
  const winner = winnerName(snap);
  if (winner) return `${winner} 胜`;
  if (snap && Object.prototype.hasOwnProperty.call(snap, 'winner')) return '平局';
  return '对局结束';
}

const AI_STYLE_LABEL = Object.freeze({ rush: '疾攻', turtle: '守成', random: '无常' });
const TRADE_POLICY_LABEL = Object.freeze({ free: '通商', restricted: '受限', embargo: '禁运' });
const UNIT_TITLE_LABEL = Object.freeze({
  bandit_conscript: '贼配军',
  rebel_militia: '起义民兵',
  rebel_garrison: '守城民兵',
});

function relationLabel(rel) {
  return {
    self: '我方', war: '交战', alliance: '同盟',
    truce: '休战', peace: '和平', neutral: '中立',
  }[rel] ?? rel;
}

function visibilityLabel(vis) {
  return {
    full: '完全掌握', partial: '邻境情报', name_only: '仅知归属', unknown: '未探明',
  }[vis] ?? vis;
}

function armyTierLabel(tier) {
  return {
    none: '无兵', token: '偏师', garrison: '守备', field_army: '野战军', grand_army: '大军',
  }[tier] ?? tier;
}

function goldTierLabel(tier) {
  return { bankrupt: '枯竭', poor: '拮据', moderate: '尚可', rich: '富庶', overflowing: '巨富' }[tier] ?? tier;
}

function foodTierLabel(tier) {
  return { starving: '饥荒', low: '紧张', adequate: '足食', surplus: '有余', abundant: '丰饶' }[tier] ?? tier;
}

function regionName(id) {
  if (!id) return '中立';
  const region = S.snapshot?.regions.find((r) => r.id === id);
  if (!region) return id;
  return region.visibility === 'unknown' ? '未探明区域' : region.name;
}

function factionName(id) {
  if (!id) return '中立';
  return S.snapshot?.factions.find((f) => f.id === id)?.name ?? id;
}

function factionColor(id) {
  if (!id) return '#7d7561';
  const fromLayout = S.layout?.factionColors?.[id];
  const idx = S.snapshot?.factions.findIndex((f) => f.id === id) ?? -1;
  const raw = typeof fromLayout === 'string' && /^#[0-9a-fA-F]{6}$/.test(fromLayout)
    ? fromLayout
    : FALLBACK_FACTION_COLORS[(idx >= 0 ? idx : 0) % FALLBACK_FACTION_COLORS.length];
  return displayFactionColor(raw, id);
}

function canOrder() {
  return Boolean(
    S.connected &&
    S.snapshot &&
    S.selfId &&
    S.snapshot.phase === 'submitting' &&
    S.lockedTurn !== S.snapshot.turn,
  );
}

// ─────────────────────────────────────────────────────────────
// 民心 / 动乱 / 基建：展示层计算
// ─────────────────────────────────────────────────────────────

function moraleHelp() {
  return S.layout?.rules?.morale ?? null;
}

function lowMoraleHelp() {
  return S.layout?.rules?.lowMorale ?? null;
}

function infraHelp() {
  return S.layout?.rules?.infrastructure ?? null;
}

function infraLevelHelp(level) {
  return (infraHelp()?.levels ?? []).find((l) => l.level === level) ?? null;
}

function nextInfraHelp(level) {
  return (infraHelp()?.levels ?? []).find((l) => l.level === level + 1) ?? null;
}

function unrestEffectsHelp() {
  return S.layout?.rules?.unrestEffects ?? null;
}

function terrainHelpOf(terrainId) {
  return (S.layout?.terrain ?? []).find((t) => t.id === terrainId) ?? null;
}

/** 乘数 → 人类可读（0.55 → ×0.55，1.8 → ×1.8） */
function mult(value) {
  return `×${Number(value.toFixed(2))}`;
}

function moraleFactorOf(morale) {
  const help = moraleHelp();
  if (!help || !Number.isFinite(help.coefficient)) return null;
  return 0.5 + morale / help.coefficient;
}

function lowMoraleFactorOf(morale) {
  const help = lowMoraleHelp();
  if (!help || !Number.isFinite(help.threshold) || help.threshold <= 0) return null;
  return 1 + (Math.max(0, help.threshold - morale) / help.threshold) * help.maxUnrestBonus;
}

function pct(ratio, digits = 0) {
  return `${(ratio * 100).toFixed(digits)}%`;
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

function unrestStateLabel(unrest) {
  if (!Number.isFinite(unrest)) return '未知';
  if (unrest >= 60) return '动荡';
  if (unrest >= 30) return '不稳';
  return '安定';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 turn report 里把战斗事件整理成 UI 可直接播放/列表显示的形状 */
function collectBattles(report) {
  return (report?.events ?? [])
    .filter((e) => e?.type === 'combat_resolved' && e.evidence)
    .map((e) => {
      const ev = e.evidence;
      return {
        turn: e.turn,
        regionId: e.regionId,
        originRegion: ev.originRegion ?? null,
        attackPath: Array.isArray(ev.attackPath) ? ev.attackPath : null,
        attacker: ev.attacker?.factionId ?? null,
        defender: ev.defender?.factionId ?? null,
        atkBefore: ev.attacker?.troopsBefore ?? 0,
        atkAfter: ev.attacker?.troopsAfter ?? 0,
        defBefore: ev.defender?.troopsBefore ?? 0,
        defAfter: ev.defender?.troopsAfter ?? 0,
        atkPower: ev.attacker?.effectivePower ?? 0,
        defPower: ev.defender?.effectivePower ?? 0,
        attackerMorale: ev.attackerMorale ?? null,
        defenderMorale: ev.defenderMorale ?? null,
        moraleFactorAttacker: ev.moraleFactorAttacker ?? null,
        moraleFactorDefender: ev.moraleFactorDefender ?? null,
        attackerType: ev.attackerType ?? null,
        defenderTypes: Array.isArray(ev.defenderTypes) ? ev.defenderTypes : [],
        counters: ev.counters ?? null,
        unrest: ev.unrest ?? null,
        rounds: Array.isArray(ev.rounds) ? ev.rounds.length : 0,
        outcome: ev.outcome,
        captured: ev.captured === true,
        captureReason: ev.captureReason ?? null,
        powerRatio: Number.isFinite(Number(ev.powerRatio)) ? Number(ev.powerRatio) : null,
      };
    });
}

// ─────────────────────────────────────────────────────────────
// 地图交互
// ─────────────────────────────────────────────────────────────

function handleMapSelect(regionId) {
  if (!S.snapshot) return;
  // ★单击任何地块 = 查看该地块：区域详情列出“本区能做什么/谁在进攻本区/能否派间谍”。
  //   不再把“已选源格 + 点目标”偷偷变成下单，避免查看情报时误发军令。
  selectRegion(regionId);
}

function selectRegion(regionId) {
  S.selected = regionId;
  S.pair = null;
  S.filterMode = 'region';
  map.select(regionId);
  map.setPair(null);
  renderDetail();
  renderActions();
}

function deselectRegion() {
  S.selected = null;
  S.pair = null;
  S.filterMode = 'all';
  map.select(null);
  map.setPair(null);
  renderDetail();
  renderActions();
}

// ─────────────────────────────────────────────────────────────
// 连接
// ─────────────────────────────────────────────────────────────

async function connect() {
  const baseUrl = $('server').value.trim();
  const roomId = $('room').value.trim();
  const seatId = $('seat').value.trim();
  const token = $('token').value.trim();
  if (!baseUrl || !roomId || !seatId || !token) {
    setStatus('服务器 / 房间 / 席位 / 令牌均为必填', 'err');
    return;
  }

  closeStream();
  S.connected = false;
  setConnectionBadge('busy', '连接中');
  setStatus('连接中…', 'busy');
  $('connect').disabled = true;

  try {
    const client = createGuozhanClient({ baseUrl, token, roomId, seatId });
    const layoutPromise = client.layout().catch((err) => {
      appendLog('warn', `地图布局读取失败，改用自动排布：${err.message}`, 'is-muted');
      return null;
    });
    const [snapshot, actions, layout] = await Promise.all([
      client.snapshot(),
      client.legalActions(),
      layoutPromise,
    ]);

    S.client = client;
    S.connected = true;
    S.roomId = roomId;
    S.seatId = seatId;
    S.seenOffsets.clear();
    S.pendingEffects = [];
    S.queue = [];
    S.selected = null;
    S.pair = null;
    S.filterMode = 'all';
    S.lockedTurn = null;
    S.lastReport = null;
    S.lastReportBattles = [];
    S.pendingBattleTurn = null;
    S.playedBattleTurns.clear();
    S.playingBattles = false;
    S.currentBattleList = [];
    map.clearBattleMarkers();
    hideBattleHud(true);

    S.layout = normalizeLayout(layout) ?? synthesizeLayout(snapshot);
    map.setLayout(S.layout);
    applyLayoutUi();
    applySnapshot(snapshot);
    applyActions(actions);
    renderQueue();
    renderDetail();

    $('mapEmpty').classList.add('is-hidden');
    $('disconnect').disabled = false;
    $('connectForm').classList.add('is-collapsed');
    $('connectToggle').textContent = '连接设置';
    setConnectionBadge('online', `已连接 · ${roomId}`);
    hideHall();
    setStatus(`已连接：${snapshot.turn} 回合 · ${phaseLabel(snapshot.phase)}`, 'ok');
    showBanner(`第 ${snapshot.turn} 回合`, '点击己方六角格，再点高亮目标下令');
    appendLog('info', `已进入房间 ${roomId}，席位 ${seatId}。`, 'is-important');

    // 重连/新进房间：先把上一回合的战况读到面板（不自动播放，避免旧战报刷屏）
    if (snapshot.turn > 1) void loadBattleHistory(snapshot.turn - 1);

    startStream(0);
  } catch (err) {
    S.client = null;
    S.connected = false;
    setConnectionBadge('error', '连接失败');
    setStatus(String(err?.message ?? err), 'err');
    appendLog('error', `连接失败：${err?.message ?? err}`, 'is-danger');
  } finally {
    $('connect').disabled = false;
  }
}

function disconnect() {
  closeStream();
  S.client = null;
  S.connected = false;
  S.snapshot = null;
  S.actions = [];
  S.queue = [];
  S.selected = null;
  S.pair = null;
  S.selfId = null;
  S.lastReport = null;
  S.lastReportBattles = [];
  S.pendingBattleTurn = null;
  S.playingBattles = false;
  S.currentBattleList = [];
  map.clearBattleMarkers();
  hideBattleHud(true);
  map.setQueue([]);
  map.setActions([]);
  map.setSnapshot(null);
  map.select(null);
  map.setPair(null);
  $('mapEmpty').classList.remove('is-hidden');
  $('disconnect').disabled = true;
  $('connectForm').classList.remove('is-collapsed');
  $('connectToggle').textContent = '收起设置';
  setConnectionBadge('off', '离线');
  setStatus('已断开。', '');
  $('turn').textContent = '—';
  $('phase').textContent = '—';
  $('budget').textContent = '—';
  clearNode($('selfPanel'));
  $('selfPanel').append(h('div', { class: 'detail-empty', text: '未连接。地图只读，不会自动下命令。' }));
  clearNode($('factions'));
  clearNode($('unitCodex'));
  $('unitCodex').append(h('div', { class: 'detail-empty', text: '未连接。' }));
  clearNode($('diplomacyPanel'));
  $('diplomacyPanel').append(h('div', { class: 'detail-empty', text: '未连接。' }));
  clearNode($('alerts'));
  $('alerts').append(h('li', { text: '无' }));
  $('mapText').textContent = '';
  renderQueue();
  renderDetail();
  renderActions();
}

function randomSeedString() {
  const bytes = new Uint8Array(6);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return `seed-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  return `seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function setQuickstartStatus(text, kind = '') {
  const el = $('quickstartStatus');
  el.textContent = text;
  el.className = `connect-status ${kind}`;
}

function quickstartScenario() {
  const id = $('scenario')?.value || 'random-front-v2';
  return QUICKSTART_SCENARIOS.find((x) => x.id === id) ?? QUICKSTART_SCENARIOS[0];
}

function fillQuickstartFactions() {
  const scenario = quickstartScenario();
  for (const selectId of ['faction', 'llmFaction']) {
    const select = $(selectId);
    if (!select) continue;
    const previous = select.value;
    clearNode(select);
    for (const f of scenario.factions) {
      const option = document.createElement('option');
      option.value = f.id;
      option.textContent = f.name;
      select.append(option);
    }
    const preferred = scenario.factions.some((f) => f.id === previous)
      ? previous
      : selectId === 'llmFaction'
        ? (scenario.factions.find((f) => f.id !== $('faction')?.value)?.id ?? scenario.factions[0].id)
        : scenario.factions[0].id;
    select.value = preferred;
  }
}

function initQuickstartScenarios() {
  const select = $('scenario');
  if (!select) return;
  if (select.options.length === 0) {
    for (const scenario of QUICKSTART_SCENARIOS) {
      const option = document.createElement('option');
      option.value = scenario.id;
      option.textContent = scenario.name;
      select.append(option);
    }
    select.value = 'random-front-v2';
  }
  select.addEventListener('change', fillQuickstartFactions);
  fillQuickstartFactions();
}

async function quickstart() {
  const baseUrl = $('server').value.trim().replace(/\/+$/, '');
  const admin = $('adminToken').value.trim();
  const scenario = quickstartScenario();
  const faction = $('faction').value;
  const llmMode = $('llmMode').value;
  const llmFaction = $('llmFaction').value;
  let seed = $('seed').value.trim();
  if (!baseUrl) {
    setQuickstartStatus('先填服务器地址', 'err');
    return;
  }
  if (!admin) {
    setQuickstartStatus('快速开局需要管理令牌（建房/发席位用）', 'err');
    return;
  }
  if (!seed) {
    seed = randomSeedString();
    $('seed').value = seed;
  }
  if (seed.length > 128) {
    setQuickstartStatus('地图种子过长（服务端上限 128 字符）', 'err');
    return;
  }

  if (!scenario.factions.some((f) => f.id === faction)) {
    setQuickstartStatus('所选势力不在该剧本中，请重新选择', 'err');
    return;
  }
  if (llmMode === 'country' && llmFaction === faction) {
    setQuickstartStatus('LLM 国家不能和你自己同一个势力，请换一个', 'err');
    return;
  }
  const aiOverrides = {};
  for (const f of scenario.factions) {
    if (f.id === faction) continue;
    aiOverrides[f.id] = { autoCommit: true, llmDriven: llmMode === 'country' && f.id === llmFaction };
  }

  const root = baseUrl.endsWith('/api') ? baseUrl.slice(0, -4) : baseUrl;
  const api = `${root}/api`;
  const headers = { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' };
  setQuickstartStatus('正在生成随机地图并创建房间…', 'busy');
  $('quickstartGo').disabled = true;
  try {
    const createResp = await fetch(`${api}/rooms`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `${scenario.name} ${seed}`.slice(0, 128),
        scenarioId: scenario.id,
        rootSeed: seed,
        unlimitedTurns: $('unlimitedTurns').checked,
        humanFactions: [faction],
        aiOverrides,
      }),
    });
    const createText = await createResp.text();
    let created = null;
    try { created = createText.length > 0 ? JSON.parse(createText) : null; } catch { created = null; }
    if (!createResp.ok) {
      const reason = created?.error?.message ?? createText.slice(0, 160) ?? `HTTP ${createResp.status}`;
      throw new Error(`建房失败 HTTP ${createResp.status}：${reason}`);
    }
    const roomId = created?.room?.roomId;
    if (typeof roomId !== 'string' || roomId.length === 0) throw new Error('建房响应缺少 roomId');

    const joinResp = await fetch(`${api}/rooms/${encodeURIComponent(roomId)}/join`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ seatId: `seat_${faction}` }),
    });
    const joinText = await joinResp.text();
    let joined = null;
    try { joined = joinText.length > 0 ? JSON.parse(joinText) : null; } catch { joined = null; }
    if (!joinResp.ok || typeof joined?.token !== 'string') {
      const reason = joined?.error?.message ?? joinText.slice(0, 160) ?? `HTTP ${joinResp.status}`;
      throw new Error(`加入席位失败 HTTP ${joinResp.status}：${reason}`);
    }

    $('room').value = roomId;
    $('seat').value = `seat_${faction}`;
    $('token').value = joined.token;
    appendLog('info', `${scenario.name} 已创建：种子 ${seed} · 房间 ${roomId}（势力 ${faction}）`, 'is-important');
    setQuickstartStatus(`已创建 ${roomId}（${scenario.name}），地图种子 ${seed}。正在进入…`, 'ok');
    await connect();
    if (S.connected) setQuickstartStatus(`已进入 ${roomId} · 地图种子 ${seed}`, 'ok');
  } catch (err) {
    setQuickstartStatus(String(err?.message ?? err), 'err');
  } finally {
    $('quickstartGo').disabled = false;
  }
}

function startStream(from) {
  if (!S.client) return;
  closeStream();
  S.stream = S.client.events({
    from,
    onBatch(event, offset) {
      if (S.seenOffsets.has(offset)) return;
      S.seenOffsets.add(offset);
      if (S.seenOffsets.size > 2000) {
        const first = S.seenOffsets.values().next().value;
        S.seenOffsets.delete(first);
      }
      handleEvent(event);
    },
    onOpen() {
      if (S.connected) setConnectionBadge('online', `已连接 · ${S.roomId}`);
    },
    onClose(nextFrom) {
      if (!S.connected) return;
      setConnectionBadge('busy', '重连中');
      setStatus(`事件流断开，2 秒后从 offset=${nextFrom} 重连`, 'err');
      setTimeout(() => {
        if (!S.connected) return;
        startStream(nextFrom);
      }, 2000);
    },
    onError() {
      if (!S.connected) return;
      appendLog('warn', '事件流错误（检查 Origin 白名单）。', 'is-danger');
    },
  });
}

function closeStream() {
  if (S.stream) {
    S.stream.close();
    S.stream = null;
  }
}

// ─────────────────────────────────────────────────────────────
// 快照 / 动作
// ─────────────────────────────────────────────────────────────

function applySnapshot(snap) {
  const previousTurn = S.snapshot?.turn ?? null;
  S.snapshot = snap;
  S.selfId = snap.factions.find((f) => f.isSelf)?.id ?? null;

  if (previousTurn !== null && previousTurn !== snap.turn) {
    if (S.queue.length > 0) {
      appendLog('warn', '回合已推进，未提交的旧军令已清空。', 'is-muted');
    }
    S.queue = [];
    S.pair = null;
    S.lockedTurn = null;
    map.setPair(null);
    map.setQueue([]);
    if (S.filterMode === 'region' && !S.selected) S.filterMode = 'all';
    // 战斗时间线播放期间让"战斗结束"横幅留在最后，不被新回合横幅盖掉
    if (!S.playingBattles && S.pendingBattleTurn === null) {
      showBanner(`第 ${snap.turn} 回合`, '请下令');
    }
    appendLog('hourglass', `T${snap.turn} 回合开始。`, 'is-muted');
  }

  $('turn').textContent = String(snap.turn);
  $('phase').textContent = phaseLabel(snap.phase);
  $('budget').textContent = S.selfId ? `${compactTokens(snap.budget.tokenUsed)}/${compactTokens(snap.budget.tokenCap)}` : '观战';
  $('mapEmpty').classList.add('is-hidden');

  if (S.selected && !snap.regions.some((r) => r.id === S.selected)) {
    S.selected = null;
    S.pair = null;
    if (S.filterMode === 'region') S.filterMode = 'all';
    map.select(null);
    map.setPair(null);
  }

  map.setSnapshot(snap);
  map.select(S.selected);
  renderSelfPanel();
  renderFactions();
  renderDiplomacy();
  renderAlerts();
  renderLawCodex();
  renderUnitCodex();
  renderBattleReport();
  renderDetail();
  renderQueue();
  renderActions();
  renderTextMap();

  if (snap.phase === 'ended') {
    showBanner('天下已定', `${endResultText(snap)} · ${endReasonLabel(snap.endReason)}`);
  }
}

function applyActions(payload) {
  S.actions = Array.isArray(payload?.actions) ? payload.actions : [];
  map.setActions(S.actions);
  renderActions();
  renderRegionActions();
  renderDiplomacy();
}

function normalizeLayout(raw) {
  if (!raw || !Array.isArray(raw.regions) || raw.regions.length === 0) return null;
  const regions = raw.regions
    .filter((r) => r && typeof r.id === 'string' && Number.isFinite(Number(r.x)) && Number.isFinite(Number(r.y)))
    .map((r) => ({
      id: r.id,
      x: Number(r.x),
      y: Number(r.y),
      ...(Number.isInteger(r.col) ? { col: r.col } : {}),
      ...(Number.isInteger(r.row) ? { row: r.row } : {}),
    }));
  if (regions.length === 0) return null;
  const tile = raw.tile && Number(raw.tile.width) > 0 && Number(raw.tile.height) > 0
    ? { width: Number(raw.tile.width), height: Number(raw.tile.height), gap: Number(raw.tile.gap) || 0 }
    : null;
  return {
    kind: raw.kind === 'square' ? 'square' : raw.kind === 'hexboard' ? 'hexboard' : 'hex',
    canvas: {
      width: Number(raw.canvas?.width) > 0 ? Number(raw.canvas.width) : 1200,
      height: Number(raw.canvas?.height) > 0 ? Number(raw.canvas.height) : 820,
    },
    hexSize: Number(raw.hexSize) > 0 ? Number(raw.hexSize) : tile ? Math.min(tile.width, tile.height) / 2 : 58,
    tile,
    regions,
    factionColors: raw.factionColors && typeof raw.factionColors === 'object' ? raw.factionColors : {},
    capitals: raw.capitals && typeof raw.capitals === 'object' ? raw.capitals : {},
    waterRoutes: Array.isArray(raw.waterRoutes) ? raw.waterRoutes : [],
    ports: Array.isArray(raw.ports) ? raw.ports : [],
    waterCells: Array.isArray(raw.waterCells) ? raw.waterCells : [],
    bridges: Array.isArray(raw.bridges) ? raw.bridges : [],
    riverLabel: typeof raw.riverLabel === 'string' ? raw.riverLabel : '大江',
    river: raw.river && typeof raw.river === 'object' ? raw.river : null,
    laws: Array.isArray(raw.laws) ? raw.laws : [],
    units: Array.isArray(raw.units) ? raw.units : [],
    rules: raw.rules && typeof raw.rules === 'object' ? raw.rules : null,
  };
}

function lawHelp(lawId) {
  return (S.layout?.laws ?? []).find((law) => law.id === lawId) ?? null;
}

function lawEffectText(law) {
  const effects = law?.effects ?? {};
  const parts = [];
  const mul = (key, label) => {
    if (typeof effects[key] === 'number') parts.push(`${label} ×${Number(effects[key].toFixed(2))}`);
  };
  const turn = (key, label) => {
    if (typeof effects[key] === 'number') parts.push(`${label} ${effects[key] > 0 ? '+' : ''}${effects[key]}/回合`);
  };
  mul('foodMultiplier', '粮产');
  mul('goldMultiplier', '金收入');
  mul('upkeepMultiplier', '军费');
  mul('recruitCostMultiplier', '征兵成本');
  mul('combatPowerMultiplier', '战力');
  turn('moralePerTurn', '民心');
  turn('unrestPerTurn', '动乱');
  return parts.join('；') || '无额外效果';
}

/** 老服务端没有 /layout 时的兜底：按 id 均匀排布，至少能玩 */
function synthesizeLayout(snap) {
  const ids = snap.regions.map((r) => r.id).sort();
  const hexSize = 58;
  const cols = Math.max(3, Math.ceil(Math.sqrt(ids.length * 1.35)));
  const dx = hexSize * 2.05;
  const dy = hexSize * 1.82;
  const regions = ids.map((id, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    return {
      id,
      x: 90 + col * dx + (row % 2 === 1 ? dx * 0.5 : 0),
      y: 90 + row * dy,
    };
  });
  const maxX = Math.max(...regions.map((r) => r.x)) + 90;
  const maxY = Math.max(...regions.map((r) => r.y)) + 90;
  const factionColors = {};
  snap.factions.forEach((f, i) => {
    factionColors[f.id] = FALLBACK_FACTION_COLORS[i % FALLBACK_FACTION_COLORS.length];
  });
  const capitals = {};
  const self = snap.factions.find((f) => f.isSelf);
  if (self?.capital) capitals[self.id] = self.capital;
  return {
    kind: 'hex',
    canvas: { width: maxX, height: maxY },
    hexSize,
    regions,
    factionColors,
    capitals,
    waterRoutes: [],
    ports: [],
    river: null,
    laws: [],
    units: [],
    rules: null,
  };
}

// ─────────────────────────────────────────────────────────────
// 刷新（事件去抖 + 单飞）
// ─────────────────────────────────────────────────────────────

function scheduleRefresh() {
  if (S.refreshTimer !== null) return;
  S.refreshTimer = setTimeout(() => {
    S.refreshTimer = null;
    void refreshNow();
  }, 120);
}

async function refreshNow() {
  if (!S.client || !S.connected) return;
  // 战斗时间线播放期间不改地图/快照，避免动画被 render() 清掉；
  // ★不要每 120ms 自旋定时器（6 场战斗会白跑几十次），只记一个“播完再刷新”标记。
  if (S.playingBattles) {
    S.refreshAfterBattle = true;
    return;
  }
  if (S.refreshing) {
    scheduleRefresh();
    return;
  }
  S.refreshing = true;
  const effects = S.pendingEffects.splice(0);
  try {
    const [snapshot, actions] = await Promise.all([
      S.client.snapshot(),
      S.client.legalActions(),
    ]);
    applySnapshot(snapshot);
    applyActions(actions);
    // 战斗与夺城由「战报时间线」统一播放，避免同一次结算闪两遍
    const ambient = effects.filter((e) => e.type !== 'combat_resolved' && e.type !== 'region_captured');
    if (ambient.length > 0) map.playEvents(ambient);
    void maybePlayPendingBattles();
  } catch (err) {
    appendLog('error', `刷新失败：${err?.message ?? err}`, 'is-danger');
  } finally {
    S.refreshing = false;
    if (S.pendingEffects.length > 0) scheduleRefresh();
  }
}

// ─────────────────────────────────────────────────────────────
// 事件
// ─────────────────────────────────────────────────────────────

const STATE_EVENTS = new Set([
  'turn_started', 'turn_resolved', 'combat_resolved', 'region_captured',
  'units_moved', 'units_split', 'units_merged', 'recruitment_completed', 'development_completed', 'infrastructure_completed',
  'spy_reported', 'morale_changed', 'unrest_event', 'faction_eliminated', 'slaves_traded', 'rebellion_started', 'rebellion_claimed', 'rebellion_ended', 'frontier_settled', 'match_ended',
]);

function handleEvent(event) {
  if (!event || typeof event.type !== 'string') return;
  const currentTurn = S.snapshot?.turn ?? 0;
  // 只对"当前回合正在发生/刚发生"的事件播动画；重连补发的旧回合历史只进战报
  const isRecent = (event.turn ?? 0) >= currentTurn;

  logEvent(event);

  if (event.type === 'turn_started') {
    // 战斗时间线优先：新回合开始横幅不能盖住「战斗结束」提示
    if (isRecent && !S.playingBattles && S.pendingBattleTurn === null) {
      showBanner(`第 ${event.turn} 回合`, '请下令');
    }
    S.lockedTurn = null;
  }
  if (event.type === 'turn_resolved') {
    if (isRecent) {
      S.pendingBattleTurn = event.turn;
      showBanner(`第 ${event.turn} 回合 · 结算完成`, '正在整理战况与损失');
    }
  }
  if (event.type === 'advice_generated') {
    if (isRecent) toast('军师建议已就绪');
  }
  if (event.type === 'match_ended') {
    showBanner('天下已定', event.winner ? `${factionName(event.winner)} 胜` : '平局');
  }

  if (STATE_EVENTS.has(event.type)) {
    if (isRecent) {
      S.pendingEffects.push(event);
      if (S.pendingEffects.length > 80) S.pendingEffects.shift();
    }
    scheduleRefresh();
  }
}

function logEvent(event) {
  const turnPrefix = event.turn ? `T${event.turn} ` : '';
  switch (event.type) {
    case 'turn_started':
      appendLog('hourglass', `${turnPrefix}回合开始。`, 'is-muted');
      break;
    case 'turn_resolved':
      appendLog('scroll', `${turnPrefix}结算完成${event.llmApplied ? '（含 LLM 战略修正）' : '（纯确定性基线）'}。`, 'is-important');
      break;
    case 'combat_resolved': {
      const ev = event.evidence ?? {};
      const outcome = outcomeLabel(ev.outcome);
      const ratio = Number(ev.powerRatio);
      const atkM = Number(ev.moraleFactorAttacker);
      const defM = Number(ev.moraleFactorDefender);
      const moraleText = Number.isFinite(atkM) && Number.isFinite(defM)
        ? `，民心系数 攻${atkM.toFixed(2)}/守${defM.toFixed(2)}`
        : '';
      const originText = ev.originRegion ? `${regionName(ev.originRegion)} → ` : '';
      appendLog(
        'swords',
        `${turnPrefix}${originText}${regionName(event.regionId)} 交战：${outcome}` +
        `${Number.isFinite(ratio) ? `（战力比 ${ratio.toFixed(2)}）` : ''}${moraleText}。`,
        'is-danger',
      );
      break;
    }
    case 'region_captured':
      appendLog('flag', `${turnPrefix}${regionName(event.regionId)} 易主：${factionName(event.from)} → ${factionName(event.to)}。`, 'is-important');
      break;
    case 'units_moved': {
      const tiles = Array.isArray(event.path) ? Math.max(0, event.path.length - 1) : 0;
      const extra = [];
      if (tiles > 1) extra.push(`${tiles} 格`);
      if (pathUsesWater(event.path)) extra.push('水路');
      appendLog(
        'move',
        `${turnPrefix}部队调动：${regionName(event.from)} → ${regionName(event.to)}${extra.length ? `（${extra.join(' · ')}）` : ''}。`,
        '',
      );
      break;
    }
    case 'units_split':
      appendLog('order', `${turnPrefix}${regionName(event.regionId)} 分兵：分出 ${event.count}，留守 ${event.remaining}。`, 'is-muted');
      break;
    case 'units_merged':
      appendLog('order', `${turnPrefix}${regionName(event.regionId)} 合兵：${event.count} 兵并入，合计 ${event.total}。`, 'is-muted');
      break;
    case 'recruitment_completed':
      appendLog('coin', `${turnPrefix}${regionName(event.regionId)} 征兵 ${event.count}（${event.unitType}）。`, '');
      break;
    case 'development_completed':
      appendLog('build', `${turnPrefix}${regionName(event.regionId)} 发展 ${event.fromLevel}→${event.toLevel}。`, '');
      break;
    case 'infrastructure_completed': {
      const def = infraLevelHelp(event.toLevel);
      appendLog(
        'build',
        `${turnPrefix}${regionName(event.regionId)} 基建 Lv${event.fromLevel}→${event.toLevel}` +
        `${def ? `「${def.name}」` : ''}：本区动乱 -${event.unrestRelief}，全国民心 +${event.moraleGained}。`,
        'is-important',
      );
      break;
    }
    case 'spy_reported':
      appendLog(
        'advisor',
        `${turnPrefix}间谍回报：${regionName(event.regionId)}（${factionName(event.targetOwner)}）情报有效至 T${event.expiresTurn}。`,
        'is-important',
      );
      break;
    case 'morale_changed':
      appendLog('heart', `${turnPrefix}${factionName(event.factionId)} 民心 ${event.from}→${event.to}（${event.reason}）。`, '');
      break;
    case 'unrest_event':
      appendLog('warn', `${turnPrefix}${regionName(event.regionId)} 动乱（${event.severity}）：${event.description}`, 'is-danger');
      break;
    case 'message_delivered':
      appendLog('letter', `${turnPrefix}${factionName(event.from)} → ${event.to ? factionName(event.to) : '天下'}：${String(event.body).slice(0, 80)}`, 'is-muted');
      break;
    case 'diplomacy_changed':
      appendLog('handshake', `${turnPrefix}${factionName(event.a)} 与 ${factionName(event.b)}：${relationLabel(event.from)}→${relationLabel(event.to)}${event.publicity === 'public' ? '' : '（密约）'}。`, '');
      break;
    case 'slaves_traded':
      appendLog(
        'warn',
        `${turnPrefix}鬻奴：${factionName(event.seller)} 从 ${regionName(event.fromRegion)} 卖 ${event.count} 人给 ${factionName(event.buyer)}（${regionName(event.toRegion)}，${event.gold} 金）。`,
        'is-danger',
      );
      break;
    case 'rebellion_started':
      appendLog(
        'warn',
        `${turnPrefix}起义：${regionName(event.regionId)} 反抗 ${factionName(event.original)}，${formatTroops(event.rebelTroops)} 起义民兵据城（${event.cause === 'claimed_conscription' ? '征兵激起' : '动乱爆发'}）。`,
        'is-danger',
      );
      break;
    case 'rebellion_claimed':
      appendLog(
        'handshake',
        `${turnPrefix}${factionName(event.claimant)} 宣称 ${regionName(event.regionId)} 起义区（原属 ${factionName(event.original)}），守城民兵 ${formatTroops(event.garrison)}，动乱 ${event.unrest}。`,
        'is-important',
      );
      break;
    case 'rebellion_ended':
      appendLog('flag', `${turnPrefix}${regionName(event.regionId)} 的起义结束（${event.reason === 'reoccupied' ? '被重占' : '动乱回落'}）。`, '');
      break;
    case 'turn_recap': {
      const parts = (event.factions ?? [])
        .filter((f) => f.regionsDelta !== 0 || f.goldDelta !== 0 || f.foodDelta !== 0 || f.moraleDelta !== 0 || f.troopsAfter !== f.troopsBefore)
        .slice(0, 8)
        .map((f) => `${f.name} 地${f.regionsDelta >= 0 ? '+' : ''}${f.regionsDelta}/金${f.goldDelta >= 0 ? '+' : ''}${f.goldDelta}/兵${f.troopsAfter - f.troopsBefore >= 0 ? '+' : ''}${f.troopsAfter - f.troopsBefore}`);
      appendLog('scroll', `${turnPrefix}复盘：${parts.join('；') || '无显著变化'}`, 'is-muted');
      break;
    }
    case 'frontier_settled':
      appendLog('build', `${turnPrefix}${factionName(event.factionId)} 开荒 ${regionName(event.regionId)}：原住民 ${event.natives} 归化，建成基建 Lv${event.infrastructure}，获 ${event.lootGold} 金。`, 'is-important');
      break;
    case 'faction_eliminated':
      appendLog('skull', `${turnPrefix}${factionName(event.factionId)} 灭亡（${event.reason}）。`, 'is-danger');
      break;
    case 'advice_generated':
      appendLog('advisor', `${turnPrefix}军师建议就绪${event.autoCommit ? '（AI 将自动执行）' : '（等待采纳）'}：${String(event.summary ?? '').slice(0, 90)}`, 'is-important');
      break;
    case 'advice_resolved':
      appendLog('advisor', `${turnPrefix}建议已处理：${event.status}，闸门剔除 ${event.droppedCount} 条。`, 'is-muted');
      break;
    case 'alerts_raised': {
      const messages = (event.alerts ?? []).map((a) => a.message).join('；');
      appendLog('warn', `${turnPrefix}告警：${messages}`, 'is-danger');
      break;
    }
    case 'narrative_chunk':
      if (event.done && event.text) {
        appendLog('book', `${turnPrefix}战报 narr：${String(event.text).slice(0, 160)}`, 'is-muted');
      }
      break;
    case 'match_ended':
      appendLog('flag', `${turnPrefix}对局结束：${event.winner ? factionName(event.winner) + ' 胜' : '平局'}（${event.reason}）。`, 'is-important');
      break;
    default:
      appendLog('info', `${turnPrefix}${event.type}`, 'is-muted');
  }
}

// ─────────────────────────────────────────────────────────────
// 战况：战报读取 / 逐场时间线 / 战场 HUD
// ─────────────────────────────────────────────────────────────

async function loadBattleHistory(turn) {
  if (!S.client || !Number.isFinite(turn) || turn < 1) return;
  try {
    const report = await S.client.report(turn);
    if (!report) {
      renderBattleReport();
      return;
    }
    if (S.lastReport && S.lastReport.turn > report.turn) return;
    S.lastReport = report;
    S.lastReportBattles = collectBattles(report);
    renderBattleReport();
    renderSelfPanel();
  } catch (err) {
    appendLog('warn', `读取 T${turn} 战报失败：${err?.message ?? err}`, 'is-muted');
  }
}

async function maybePlayPendingBattles() {
  const turn = S.pendingBattleTurn;
  if (turn === null || turn === undefined || S.playingBattles || !S.client) return;
  S.pendingBattleTurn = null;
  if (S.playedBattleTurns.has(turn)) return;
  S.playedBattleTurns.add(turn);
  if (S.playedBattleTurns.size > 40) {
    const first = S.playedBattleTurns.values().next().value;
    S.playedBattleTurns.delete(first);
  }
  try {
    const report = await S.client.report(turn);
    if (!report) {
      showBanner(`第 ${turn} 回合`, '结算完成');
      return;
    }
    if (!S.lastReport || report.turn >= S.lastReport.turn) {
      S.lastReport = report;
      S.lastReportBattles = collectBattles(report);
      renderBattleReport();
      renderSelfPanel();
    }
    const battles = collectBattles(report);
    if (battles.length === 0) {
      showBanner(`第 ${turn} 回合 · 无战事`, '结算完成');
      appendLog('scroll', `T${turn} 结算完成：本回合没有战斗。`, 'is-muted');
      return;
    }
    await playBattleSequence(battles, turn);
  } catch (err) {
    appendLog('warn', `读取 T${turn} 战报失败：${err?.message ?? err}`, 'is-danger');
    showBanner(`第 ${turn} 回合`, '结算完成（战报读取失败）');
  }
}

async function playBattleSequence(battles, turn) {
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  // 场数多时压缩单场时长，避免 6 场战斗把页面锁住十几秒
  const perBattle = reduced ? 200 : battles.length > 4 ? 700 : 1200;
  const gap = reduced ? 120 : battles.length > 4 ? 180 : 450;
  S.playingBattles = true;
  S.skipBattlePlayback = false;
  S.currentBattleList = battles;
  map.showBattleMarkers(battles);
  appendLog('scroll', `T${turn} 战斗开始：共 ${battles.length} 场，正在逐场播放战况。`, 'is-important');
  try {
    for (let i = 0; i < battles.length; i++) {
      if (S.skipBattlePlayback) break;
      const battle = battles[i];
      updateBattleHud(battle, i, battles.length, 'fighting');
      // 播放器自身有 duration；这里再设一道上限，任何单场异常都不得卡住整条时间线
      const played = map.playBattle(battle, { duration: perBattle }).catch(() => {});
      await Promise.race([played, wait(perBattle + 1000)]);
      if (S.skipBattlePlayback) break;
      updateBattleHud(battle, i, battles.length, 'done');
      if (i < battles.length - 1) await wait(gap);
    }
    if (S.skipBattlePlayback) {
      hideBattleHud();
      map.clearBattleMarkers();
      showBanner(`第 ${turn} 回合 · 战斗结束`, `已跳过动画 · 共 ${battles.length} 场`);
      appendLog('scroll', `T${turn} 战斗动画已跳过；${battles.length} 场战况仍保留在左侧。`, 'is-muted');
    } else {
      const finalBattle = battles[battles.length - 1];
      updateBattleHud(finalBattle, battles.length - 1, battles.length, 'finished', `本回合 ${battles.length} 场战斗全部结束`);
      showBanner(`第 ${turn} 回合 · 战斗结束`, `共 ${battles.length} 场 · 战况已记入左侧`);
      appendLog('scroll', `T${turn} 战斗结束：共 ${battles.length} 场，战报已定。`, 'is-important');
      if (S.hudHideTimer !== null) clearTimeout(S.hudHideTimer);
      S.hudHideTimer = setTimeout(() => {
        map.clearBattleMarkers();
        hideBattleHud();
      }, 2800);
    }
  } finally {
    S.playingBattles = false;
    S.currentBattleList = [];
    S.skipBattlePlayback = false;
    if (S.refreshAfterBattle) {
      S.refreshAfterBattle = false;
      scheduleRefresh();
    }
  }
}

function updateBattleHud(battle, index, total, phase, finalText = '') {
  const hud = $('battleHud');
  if (!hud || !battle) return;
  if (S.hudHideTimer !== null) {
    clearTimeout(S.hudHideTimer);
    S.hudHideTimer = null;
  }
  S.hudBattle = battle;
  hud.hidden = false;
  hud.classList.toggle('is-fighting', phase === 'fighting');
  hud.classList.toggle('is-done', phase !== 'fighting');
  $('battleHudTitle').textContent = `T${battle.turn ?? '?'} · ${regionName(battle.regionId)}`;
  $('battleHudStep').textContent = phase === 'finished'
    ? '全部结束'
    : `第 ${index + 1} / ${total} 场`;

  const sides = $('battleHudSides');
  clearNode(sides);
  const sideRow = (label, factionId, before, after) => {
    const dot = h('i', { class: 'faction-dot' });
    dot.style.background = factionColor(factionId);
    dot.style.color = factionColor(factionId);
    const loss = Math.max(0, (Number(before) || 0) - (Number(after) || 0));
    return h('div', { class: 'battle-side' },
      h('span', { class: 'battle-side-name' }, dot, h('span', { text: `${label} ${factionName(factionId)}` })),
      h('span', { class: 'battle-side-troops mono', text: `${formatTroops(before)} → ${formatTroops(after)}` }),
      h('span', { class: 'battle-side-loss', text: `损 ${formatTroops(loss)}` }),
    );
  };
  sides.append(
    sideRow('攻', battle.attacker, battle.atkBefore, battle.atkAfter),
    sideRow('守', battle.defender, battle.defBefore, battle.defAfter),
  );

  const metaBits = [];
  if (Number.isFinite(battle.powerRatio)) metaBits.push(`战力比 ${battle.powerRatio.toFixed(2)}`);
  if (battle.rounds > 0) metaBits.push(`${battle.rounds} 回合`);
  if (Number.isFinite(battle.attackerMorale) && Number.isFinite(battle.moraleFactorAttacker)) {
    metaBits.push(`攻方民心 ${battle.attackerMorale} ×${battle.moraleFactorAttacker.toFixed(2)}`);
  }
  if (Number.isFinite(battle.defenderMorale) && Number.isFinite(battle.moraleFactorDefender)) {
    metaBits.push(`守方民心 ${battle.defenderMorale} ×${battle.moraleFactorDefender.toFixed(2)}`);
  }
  if (battle.attackerType || (battle.defenderTypes?.length ?? 0) > 0) {
    const atk = battle.attackerType ? unitName(battle.attackerType) : '?';
    const def = battle.defenderTypes?.length ? battle.defenderTypes.map((id) => unitName(id)).join('/') : '无守军';
    metaBits.push(`兵种 ${atk} vs ${def}`);
  }
  if (battle.counters) {
    if (battle.counters.attackerBonus > 1) metaBits.push(`攻方克制 +${Math.round((battle.counters.attackerBonus - 1) * 100)}%`);
    if (battle.counters.defenderBonus > 1) metaBits.push(`守方克制 +${Math.round((battle.counters.defenderBonus - 1) * 100)}%`);
  }
  if (battle.unrest) {
    const u = battle.unrest;
    metaBits.push(`动乱 战火+${u.battle}${u.capture > 0 ? ` / 夺城+${u.capture}` : ''}${u.warDeclaration > 0 ? ` / 开战+${u.warDeclaration}` : ''}`);
    if (Number.isFinite(u.lowMoraleFactor) && u.lowMoraleFactor > 1) {
      metaBits.push(`低民心放大 ×${u.lowMoraleFactor.toFixed(2)}`);
    }
    if (Number.isFinite(u.defenderUnrestFactor) && u.defenderUnrestFactor < 1) {
      metaBits.push(`守军受动乱影响 ×${u.defenderUnrestFactor.toFixed(2)}`);
    }
  }
  if (Array.isArray(battle.attackPath) && battle.attackPath.length > 2) {
    metaBits.push(`航线 ${battle.attackPath.map((id) => regionName(id)).join(' → ')}`);
  }
  $('battleHudMeta').textContent = metaBits.join(' · ');

  const status = phase === 'fighting'
    ? `战斗进行中…（第 ${index + 1}/${total} 场）`
    : phase === 'finished'
      ? finalText
      : `战斗结束 · ${outcomeLabel(battle.outcome)}${battle.captured ? ' · 夺城' : ''}`;
  $('battleHudStatus').textContent = status;
}

function skipBattlePlayback() {
  S.skipBattlePlayback = true;
  map.clearBattleMarkers();
  hideBattleHud();
  toast('已跳过战斗动画，战况保留在左侧');
}

function hideBattleHud(immediate = false) {
  const hud = $('battleHud');
  if (!hud) return;
  if (S.hudHideTimer !== null) {
    clearTimeout(S.hudHideTimer);
    S.hudHideTimer = null;
  }
  if (immediate) {
    hud.hidden = true;
    hud.classList.remove('is-fighting', 'is-done');
    S.hudBattle = null;
    return;
  }
  hud.hidden = true;
  hud.classList.remove('is-fighting', 'is-done');
  S.hudBattle = null;
}

function renderTurnRecap() {
  const box = $('turnRecap');
  if (!box) return;
  clearNode(box);
  const report = S.lastReport;
  const recap = (report?.events ?? []).find((e) => e.type === 'turn_recap');
  if (recap) {
    $('recapTurn').textContent = `T${recap.turn}`;
    const signed = (v) => `${v > 0 ? '+' : ''}${formatTroops(v)}`;
    for (const f of recap.factions ?? []) {
      const row = h('div', { class: 'recap-row' });
      const dot = h('i', { class: 'faction-dot' });
      dot.style.background = factionColor(f.id);
      dot.style.color = factionColor(f.id);
      row.append(
        h('div', { class: 'recap-head' },
          dot,
          h('b', { text: f.name }),
          f.eliminated ? h('span', { class: 'tag red', text: '灭亡' }) : null,
          h('span', { class: 'tag', text: `领 ${f.regionsBefore}→${f.regionsAfter}` }),
        ),
        h('div', { class: 'recap-deltas' },
          h('span', { class: `tag ${f.goldDelta >= 0 ? 'gold' : 'red'}`, text: `金 ${signed(f.goldDelta)}` }),
          h('span', { class: `tag ${f.foodDelta >= 0 ? 'gold' : 'red'}`, text: `粮 ${signed(f.foodDelta)}` }),
          h('span', { class: `tag ${f.moraleDelta >= 0 ? 'gold' : 'red'}`, text: `民心 ${signed(f.moraleDelta)}` }),
          h('span', { class: `tag ${f.troopsAfter >= f.troopsBefore ? 'gold' : 'red'}`, text: `兵 ${signed(f.troopsAfter - f.troopsBefore)}` }),
          f.regionsDelta !== 0 ? h('span', { class: `tag ${f.regionsDelta > 0 ? 'gold' : 'red'}`, text: `地 ${signed(f.regionsDelta)}` }) : null,
        ),
      );
      box.append(row);
    }
  } else {
    $('recapTurn').textContent = '—';
    box.append(h('div', { class: 'detail-empty', text: '结算后显示本回合各势力的领地、金粮、民心与兵力变化。' }));
  }
  const rejected = (report?.rejected ?? []).filter((r) => r.seatId === S.seatId);
  if (rejected.length > 0) {
    const list = h('div', { class: 'recap-deltas' });
    for (const r of rejected.slice(0, 8)) {
      list.append(h('span', { class: 'tag red', text: `${r.code}: ${r.message}`, title: `T${report.turn} 第 ${r.index + 1} 条命令` }));
    }
    box.append(h('div', { class: 'detail-note detail-note--danger', text: '本回合被拒命令：' }), list);
  }
}

function renderBattleReport() {
  renderTurnRecap();
  const box = $('battleReport');
  if (!box) return;
  clearNode(box);
  const report = S.lastReport;
  if (!report) {
    $('battleTurn').textContent = S.snapshot ? `T${Math.max(1, S.snapshot.turn - 1)}` : '—';
    box.append(h('div', { class: 'detail-empty', text: '结算后显示本回合每场战斗的地点、双方损失与民心系数。' }));
    return;
  }
  const battles = S.lastReportBattles ?? [];
  $('battleTurn').textContent = `T${report.turn} · ${battles.length} 场`;
  if (battles.length === 0) {
    box.append(h('div', { class: 'detail-empty', text: `T${report.turn} 结算完成：本回合没有战斗。` }));
    return;
  }
  for (const battle of battles) {
    const isCurrent = S.playingBattles && S.hudBattle?.regionId === battle.regionId && S.hudBattle?.turn === battle.turn;
    const row = h('button', {
      class: `battle-row${isCurrent ? ' is-current' : ''}`,
      type: 'button',
      title: '点击定位战场',
      onclick: () => {
        selectRegion(battle.regionId);
        map.focusRegion(battle.regionId);
      },
    });
    const atkDot = h('i', { class: 'faction-dot' });
    atkDot.style.background = factionColor(battle.attacker);
    atkDot.style.color = factionColor(battle.attacker);
    const defDot = h('i', { class: 'faction-dot' });
    defDot.style.background = factionColor(battle.defender);
    defDot.style.color = factionColor(battle.defender);
    const head = h('div', { class: 'battle-row-head' },
      h('b', { text: regionName(battle.regionId) }),
      h('span', { class: `battle-outcome ${battle.captured ? 'is-capture' : ''}`, text: `${outcomeLabel(battle.outcome)}${battle.captured ? ' · 夺城' : ''}` }),
    );
    const sides = h('div', { class: 'battle-row-sides' },
      h('span', {}, atkDot, h('span', { text: `${factionName(battle.attacker)} ${formatTroops(battle.atkBefore)}→${formatTroops(battle.atkAfter)}` })),
      h('span', {}, defDot, h('span', { text: `${factionName(battle.defender)} ${formatTroops(battle.defBefore)}→${formatTroops(battle.defAfter)}` })),
    );
    const metaBits = [];
    if (Number.isFinite(battle.powerRatio)) metaBits.push(`战力比 ${battle.powerRatio.toFixed(2)}`);
    if (Number.isFinite(battle.moraleFactorAttacker) && Number.isFinite(battle.moraleFactorDefender)) {
      metaBits.push(`民心系数 攻${battle.moraleFactorAttacker.toFixed(2)}/守${battle.moraleFactorDefender.toFixed(2)}`);
    }
    if (battle.counters) {
      if (battle.counters.attackerBonus > 1) metaBits.push(`攻克制 +${Math.round((battle.counters.attackerBonus - 1) * 100)}%`);
      if (battle.counters.defenderBonus > 1) metaBits.push(`守克制 +${Math.round((battle.counters.defenderBonus - 1) * 100)}%`);
    }
    if (battle.attackerType) {
      const def = battle.defenderTypes?.length ? battle.defenderTypes.map((id) => unitName(id)).join('/') : '无守军';
      metaBits.push(`${unitName(battle.attackerType)} vs ${def}`);
    }
    if (battle.unrest) {
      const totalUnrest = (battle.unrest.battle ?? 0) + (battle.unrest.capture ?? 0) + (battle.unrest.warDeclaration ?? 0);
      if (totalUnrest > 0) metaBits.push(`本场动乱 +${totalUnrest}`);
      if (Number.isFinite(battle.unrest.lowMoraleFactor) && battle.unrest.lowMoraleFactor > 1) {
        metaBits.push(`低民心×${battle.unrest.lowMoraleFactor.toFixed(2)}`);
      }
    }
    row.append(head, sides, h('div', { class: 'battle-row-meta', text: metaBits.join(' · ') }));
    box.append(row);
  }
}

// ─────────────────────────────────────────────────────────────
// 渲染：顶栏 / 我方 / 列强 / 告警
// ─────────────────────────────────────────────────────────────

function renderSelfPanel() {
  const box = $('selfPanel');
  clearNode(box);
  const snap = S.snapshot;
  $('selfTurn').textContent = snap ? `第 ${snap.turn} 回合 · ${phaseLabel(snap.phase)}` : '—';
  if (!snap) {
    box.append(h('div', { class: 'detail-empty', text: '未连接。地图只读，不会自动下命令。' }));
    return;
  }
  const self = snap.factions.find((f) => f.isSelf);

  if (!self) {
    box.append(
      h('p', { class: 'self-name', text: '观战视角' }),
      h('div', { class: 'self-sub', text: `全知视野 · ${snap.factions.filter((f) => !f.eliminated).length} 个势力在场` }),
      h('div', { class: 'detail-empty', text: '观战席位只读：能看到全图与战报，但不能提交军令。' }),
    );
    return;
  }

  const capitalRegion = self.capital ? S.snapshot?.regions.find((r) => r.id === self.capital) : null;
  const capital = self.capital ? regionName(self.capital) : '—';
  const capitalHeld = !capitalRegion || capitalRegion.visibility === 'unknown'
    ? ''
    : capitalRegion.owner === self.id
      ? ''
      : capitalRegion.owner
        ? `（已失守，现属 ${factionName(capitalRegion.owner)}）`
        : '（已失守，现为中立的无主之地）';
  const selfDot = h('i', { class: 'faction-dot', style: 'margin-right:8px;vertical-align:middle' });
  selfDot.style.background = factionColor(self.id);
  selfDot.style.color = factionColor(self.id);
  box.append(
    h('p', { class: 'self-name' }, selfDot, self.name, h('span', { class: 'tag gold', text: '我方', style: 'margin-left:8px' })),
    h('div', { class: 'self-sub', text: `都城 ${capital}${capitalHeld} · 第 ${snap.turn} 回合 · ${phaseLabel(snap.phase)}` }),
  );
  if (snap.phase === 'ended') {
    const won = snap.winner === self.id;
    box.append(h('div', {
      class: `game-over${won ? ' is-win' : ''}`,
      text: `终局：${endResultText(snap)}（${endReasonLabel(snap.endReason)}）${won ? ' · 你是胜者' : ''}`,
    }));
  }

  if (self.exact) {
    const taxMorale = self.exact.taxMoralePerTurn;
    const taxText = `${Math.round(self.exact.taxRate * 100)}%` +
      (typeof taxMorale === 'number' ? `（民心 ${taxMorale > 0 ? '+' : ''}${taxMorale}/回合）` : '');
    const stats = [
      ['国库', formatTroops(self.exact.gold)],
      ['粮草', formatTroops(self.exact.food)],
      ['兵源', formatTroops(self.exact.manpower)],
      ['总兵力', formatTroops(self.exact.troops)],
      ['全国民心', String(self.morale)],
      ['税率', taxText],
    ];
    const grid = h('div', { class: 'res-grid' });
    for (const [label, value] of stats) {
      grid.append(h('div', { class: 'res' }, h('span', { text: label }), h('b', { text: value })));
    }
    box.append(grid);
    box.append(renderMoraleCard(self));
    if (self.exact.laws.length > 0) {
      const laws = h('div', { class: 'adj-list', style: 'margin-top:9px' });
      for (const lawId of self.exact.laws) {
        const help = lawHelp(lawId);
        laws.append(h('span', {
          class: 'tag gold',
          text: help?.name ?? lawId,
          title: help ? `${help.description}；${lawEffectText(help)}（已颁布）` : lawId,
        }));
      }
      box.append(laws);
    }
  }

  const pct = snap.budget.tokenCap > 0 ? Math.min(100, (snap.budget.tokenUsed / snap.budget.tokenCap) * 100) : 0;
  const bar = h('i');
  bar.style.width = `${pct}%`;
  box.append(
    h('div', { class: 'budget-line' },
      h('div', { class: 'label' },
        h('span', { text: 'LLM 战略预算' }),
        h('span', { text: `${compactTokens(snap.budget.tokenUsed)} / ${compactTokens(snap.budget.tokenCap)}` }),
      ),
      h('div', { class: 'bar' }, bar),
    ),
  );
}

function renderFinanceCard(self) {
  const deltas = (S.lastReport?.baseline ?? []).filter(
    (d) => d.scope === `faction:${self.id}` && (d.field === 'gold' || d.field === 'food') && d.delta !== 0,
  );
  if (deltas.length === 0) return null;
  const card = h('div', { class: 'morale-card finance-card' });
  card.append(h('div', { class: 'morale-head' },
    h('span', { class: 'morale-title', text: '国库变化' }),
    h('b', { class: 'morale-value', text: `T${S.lastReport.turn}` }),
  ));
  const list = h('div', { class: 'morale-deltas' });
  for (const d of deltas.slice(0, 10)) {
    list.append(h('span', {
      class: `tag ${d.delta >= 0 ? 'gold' : 'red'}`,
      text: `${d.field === 'gold' ? '金' : '粮'} ${d.delta > 0 ? '+' : ''}${d.delta} · ${d.reason}`,
      title: `${d.oldValue} → ${d.newValue}`,
    }));
  }
  card.append(list);
  return card;
}

function renderMoraleCard(self) {
  const card = h('div', { class: 'morale-card' });
  const help = moraleHelp();
  const factor = moraleFactorOf(self.morale);
  const lowFactor = lowMoraleFactorOf(self.morale);
  const head = h('div', { class: 'morale-head' },
    h('span', { class: 'morale-title', text: '全国民心' }),
    h('b', { class: 'morale-value', text: String(self.morale) }),
    h('span', { class: 'morale-scale', text: `/ ${help?.max ?? 100}` }),
    factor !== null ? h('span', { class: 'tag gold', text: `战力 ×${factor.toFixed(2)}` }) : null,
    lowFactor !== null && lowFactor > 1 ? h('span', { class: 'tag red', text: `动乱 ×${lowFactor.toFixed(2)}` }) : null,
  );
  card.append(head);

  const meter = h('div', { class: 'morale-meter' });
  const fill = h('i');
  fill.style.width = `${Math.max(0, Math.min(100, self.morale))}%`;
  meter.append(fill);
  if (help) {
    const collapse = h('span', { class: 'morale-mark morale-mark--collapse' });
    collapse.style.left = `${Math.max(0, Math.min(100, help.collapseThreshold))}%`;
    collapse.title = `民心低于 ${help.collapseThreshold}：守军可能不战而降`;
    meter.append(collapse);
  }
  const lowHelp = lowMoraleHelp();
  if (lowHelp) {
    const warn = h('span', { class: 'morale-mark morale-mark--warn' });
    warn.style.left = `${Math.max(0, Math.min(100, lowHelp.threshold))}%`;
    warn.title = `民心低于 ${lowHelp.threshold}：征兵/战火造成的地区动乱开始放大`;
    meter.append(warn);
  }
  card.append(meter);

  if (help) {
    card.append(
      h('div', { class: 'morale-line', text: `战力系数 = 0.5 + ${self.morale}/${help.coefficient} = ×${factor.toFixed(2)}（全军通用）` }),
      h('div', { class: 'morale-line', text: `民心 < ${help.collapseThreshold}：守军可能不战而降` }),
    );
  }
  if (lowHelp) {
    const battleUnrest = Math.round(lowHelp.battleBase * (lowFactor ?? 1));
    const recruitUnrest = Math.round(lowHelp.recruitBase * (lowFactor ?? 1));
    card.append(h('div', {
      class: `morale-line${lowFactor > 1 ? ' is-warn' : ''}`,
      text: `全国民心 < ${lowHelp.threshold} 时放大地区动乱：` +
        `当前征兵 +${recruitUnrest}/次、战火 +${battleUnrest}/场` +
        `${lowFactor > 1 ? `（×${lowFactor.toFixed(2)}）` : '（未触发）'}`,
    }));
  }

  const deltas = (S.lastReport?.baseline ?? [])
    .filter((d) => d.scope === `faction:${self.id}` && d.field === 'morale');
  if (deltas.length > 0) {
    const list = h('div', { class: 'morale-deltas' });
    for (const d of deltas) {
      list.append(h('span', {
        class: `tag ${d.delta >= 0 ? 'gold' : 'red'}`,
        text: `${d.reason} ${d.delta > 0 ? '+' : ''}${d.delta}`,
        title: `T${S.lastReport.turn}：${d.oldValue} → ${d.newValue}`,
      }));
    }
    card.append(h('div', { class: 'morale-sub', text: `T${S.lastReport.turn} 全国民心变化` }), list);
  } else if (S.lastReport) {
    card.append(h('div', { class: 'morale-line is-muted', text: `T${S.lastReport.turn} 全国民心无变化。` }));
  }

  card.append(h('div', {
    class: 'morale-line is-muted',
    text: '地区动乱是每个地区自己的状态：只惩罚本区产出/守备，请看区域详情。',
  }));
  return card;
}

function unitCatalog() {
  return Array.isArray(S.layout?.units) ? S.layout.units : [];
}

function unitName(id) {
  return unitCatalog().find((u) => u.id === id)?.name ?? id;
}

function unitCodexCounterText(unit) {
  const parts = [];
  const counters = unit.counters ?? {};
  for (const [targetId, bonus] of Object.entries(counters).sort()) {
    if (typeof bonus === 'number' && bonus > 0) {
      parts.push(`克制 ${unitName(targetId)} +${Math.round(bonus * 100)}%`);
    }
  }
  for (const other of unitCatalog()) {
    if (other.id === unit.id) continue;
    const bonus = other.counters?.[unit.id];
    if (typeof bonus === 'number' && bonus > 0) {
      parts.push(`被 ${other.name} 克制 +${Math.round(bonus * 100)}%`);
    }
  }
  return parts;
}

function renderUnitCodex() {
  const box = $('unitCodex');
  if (!box) return;
  clearNode(box);
  const units = unitCatalog();
  if (units.length === 0) {
    box.append(h('div', { class: 'detail-empty', text: '连接房间后显示本剧本的兵种与克制关系。' }));
    return;
  }
  const maxAtk = Math.max(1, ...units.map((u) => Number(u.attack) || 0));
  const maxDef = Math.max(1, ...units.map((u) => Number(u.defense) || 0));
  const maxMov = Math.max(1, ...units.map((u) => Number(u.movement) || 0));
  const bar = (label, value, max, cls) => {
    const meter = h('div', { class: 'unit-meter' });
    const fill = h('i');
    fill.style.width = `${Math.round((Number(value) / max) * 100)}%`;
    meter.append(fill);
    return h('div', { class: 'unit-stat' },
      h('span', { text: label }),
      meter,
      h('b', { text: String(value) }),
    );
  };
  for (const unit of units) {
    const domain = unit.domain === 'water' ? '水师' : unit.domain === 'amphibious' ? '两栖' : '陆师';
    const counters = unitCodexCounterText(unit);
    const row = h('div', { class: 'unit-row' },
      h('div', { class: 'unit-row-head' },
        h('b', { text: unit.name }),
        h('span', { class: `tag ${unit.domain === 'water' ? 'blue' : ''}`, text: domain }),
      ),
      h('div', { class: 'unit-bars' },
        bar('攻', unit.attack, maxAtk, 'atk'),
        bar('防', unit.defense, maxDef, 'def'),
        bar('动', unit.movement, maxMov, 'mov'),
      ),
      h('div', {
        class: 'unit-cost',
        text: `每千兵：金 ${unit.recruitGold} · 粮 ${unit.recruitFood} · 兵源 ${unit.recruitManpower}；维护 金 ${unit.upkeepGold} / 粮 ${unit.upkeepFood}`,
      }),
      h('div', { class: 'unit-counters' },
        ...(counters.length > 0
          ? counters.map((text) => h('span', {
              class: `tag ${text.startsWith('克制') ? 'gold' : 'red'}`,
              text,
            }))
          : [h('span', { class: 'tag', text: '无克制关系' })]),
      ),
    );
    box.append(row);
  }
  box.append(h('div', {
    class: 'detail-note',
    text: '克制加成本身已经计入战斗战力；实际战斗会在战况 HUD 显示所用兵种与克制加成。',
  }));
}

function renderLawCodex() {
  const box = $('lawCodex');
  if (!box) return;
  clearNode(box);
  const laws = S.layout?.laws ?? [];
  if (laws.length === 0) {
    box.append(h('div', { class: 'detail-empty', text: '连接房间后显示本剧本的法令效果。' }));
    return;
  }
  const self = S.snapshot?.factions.find((f) => f.isSelf);
  const enacted = new Set(self?.exact?.laws ?? []);
  for (const law of laws) {
    const isOn = enacted.has(law.id);
    box.append(h('div', { class: `law-row${isOn ? ' is-enacted' : ''}` },
      h('div', { class: 'law-row-head' },
        h('b', { text: law.name }),
        h('span', { class: `tag ${isOn ? 'gold' : ''}`, text: isOn ? '已颁布' : `基础 ${law.enactGold} 金 + 人口附加` }),
      ),
      h('div', { class: 'law-row-desc', text: law.description || '（无描述）' }),
      h('div', { class: 'law-row-effects' },
        ...lawEffectText(law).split('；').filter(Boolean).map((part) => h('span', { class: 'tag blue', text: part })),
      ),
    ));
  }
}

function diplomacyShortLabel(action) {
  return {
    declare_war: '宣战',
    propose_peace: '求和',
    propose_alliance: '结盟',
    break_alliance: '毁约',
  }[action.command?.action] ?? action.label;
}

function renderDiplomacy() {
  const box = $('diplomacyPanel');
  if (!box) return;
  clearNode(box);
  const snap = S.snapshot;
  if (!snap) {
    box.append(h('div', { class: 'detail-empty', text: '连接后显示各势力关系。迷雾下只有档位；派间谍可看精确驻军。' }));
    return;
  }
  const self = snap.factions.find((f) => f.isSelf);
  if (!self) {
    box.append(h('div', { class: 'detail-empty', text: '观战视角：全知视野，不能外交或派间谍。' }));
    return;
  }
  const others = snap.factions.filter((f) => !f.isSelf && !f.eliminated);
  if (others.length === 0) {
    box.append(h('div', { class: 'detail-empty', text: '已无其他势力。' }));
    return;
  }
  for (const f of others) {
    const dot = h('i', { class: 'faction-dot' });
    dot.style.background = factionColor(f.id);
    dot.style.color = factionColor(f.id);
    const actions = S.actions
      .filter((a) => a.kind === 'diplomacy' && a.command?.to === f.id)
      .slice(0, 3);
    const row = h('div', { class: 'diplomacy-row' },
      h('div', { class: 'diplomacy-head' },
        h('span', { class: 'diplomacy-name' }, dot, h('span', { text: f.name })),
        h('span', { class: `relation-tag ${f.relation}`, text: relationLabel(f.relation) }),
      ),
      h('div', {
        class: 'diplomacy-meta',
        text: `领地 ${f.regionCount} · ${armyTierLabel(f.armyTier)} · 全国民心 ${f.morale}`,
        title: `财：${goldTierLabel(f.goldTier)} · 粮：${foodTierLabel(f.foodTier)}（迷雾只给档位）`,
      }),
      h('div', { class: 'diplomacy-tiers' },
        h('span', { class: 'tag', text: `财 ${goldTierLabel(f.goldTier)}` }),
        h('span', { class: 'tag', text: `粮 ${foodTierLabel(f.foodTier)}` }),
        h('span', { class: 'tag', text: `兵 ${armyTierLabel(f.armyTier)}` }),
      ),
    );
    if (actions.length > 0) {
      const buttons = h('div', { class: 'diplomacy-actions' });
      for (const action of actions) {
        const reason = actionDisabledReason(action);
        buttons.append(h('button', {
          class: 'btn small ghost',
          type: 'button',
          text: diplomacyShortLabel(action),
          disabled: reason !== null,
          title: reason ?? action.description ?? action.label,
          onclick: () => addAction(action),
        }));
      }
      row.append(buttons);
    }
    box.append(row);
  }
  box.append(h('div', {
    class: 'detail-note',
    text: '迷雾下敌国只给领地/兵势/民心档位。点击其边境地块可派间谍：150 金换 3 回合精确驻军、动乱与基建。',
  }));
  if (snap.phase === 'ended') {
    box.append(h('div', { class: 'detail-note detail-note--danger', text: '对局已结束，外交按钮只读。' }));
  } else if (S.lockedTurn === snap.turn) {
    box.append(h('div', { class: 'detail-note', text: '本回合已锁定：外交/间谍动作要等下回合。' }));
  }
}

function renderFactions() {
  const tbody = $('factions');
  clearNode(tbody);
  if (!S.snapshot) return;
  const hasGrudge = S.snapshot.factions.some((f) => !f.isSelf && typeof f.grudge === 'number');
  document.querySelector('table.factions')?.classList.toggle('hide-grudge', !hasGrudge);

  for (const f of S.snapshot.factions) {
    const color = factionColor(f.id);
    const dot = h('i', { class: 'faction-dot' });
    dot.style.background = color;
    dot.style.color = color;
    const relation = h('span', { class: `relation-tag ${f.relation}`, text: relationLabel(f.relation) });
    const tr = h('tr', { class: f.isSelf ? 'is-self' : (f.eliminated ? 'is-dead' : '') },
      h('td', {},
        h('div', { class: 'faction-cell' },
          dot,
          h('span', { text: f.isSelf ? `${f.name}（我）` : f.name }),
          f.aiArchetype
            ? h('span', { class: 'style-tag', text: AI_STYLE_LABEL[f.aiArchetype] ?? f.aiArchetype })
            : null,
        ),
      ),
      h('td', {}, relation),
      h('td', {
        class: 'mono',
        text: typeof f.grudge === 'number'
          ? `${f.grudge} · ${TRADE_POLICY_LABEL[f.tradePolicy] ?? '—'}${f.wars ? ` · ${f.wars}战` : ''}`
          : '—',
        title: typeof f.grudge === 'number'
          ? `潜在恨意 ${f.grudge}/100；贸易政策 ${TRADE_POLICY_LABEL[f.tradePolicy] ?? '—'}；历史宣战 ${f.wars ?? 0} 次。恨意 ≥70 或交战 ⇒ 禁运。`
          : '本剧本未启用潜在恨意',
      }),
      h('td', { class: 'mono', text: String(f.regionCount) }),
      h('td', { class: 'mono', text: armyTierLabel(f.armyTier), title: `财：${goldTierLabel(f.goldTier)} · 粮：${foodTierLabel(f.foodTier)}` }),
      h('td', {
        class: `mono morale-cell${f.morale < (lowMoraleHelp()?.threshold ?? -1) ? ' is-low' : ''}`,
        text: String(f.morale),
        title: `全国民心 ${f.morale}${Number.isFinite(f.moraleFactor) ? ` · 战力×${f.moraleFactor.toFixed(2)}` : ''}`,
      }),
    );
    tbody.append(tr);
  }
}

function renderAlerts() {
  const ul = $('alerts');
  clearNode(ul);
  const alerts = S.snapshot?.alerts ?? [];
  if (alerts.length === 0) {
    ul.append(h('li', { text: '无' }));
    return;
  }
  for (const alert of alerts) {
    ul.append(h('li', {},
      h('span', { class: 'p', text: `P${alert.priority}` }),
      h('span', { text: alert.message }),
    ));
  }
}

// ─────────────────────────────────────────────────────────────
// 渲染：区域详情
// ─────────────────────────────────────────────────────────────

function renderDetail() {
  const box = $('regionDetail');
  const vis = $('regionVis');
  clearNode(box);
  vis.textContent = '';

  if (!S.snapshot) {
    box.append(h('div', { class: 'detail-empty', text: '点击地图上的六角格查看归属、驻军与地形。' }));
    return;
  }
  if (!S.selected) {
    box.append(h('div', { class: 'detail-empty', text: '点击地图上的六角格查看归属、驻军与地形。选中己方格后，可执行目标会在地图上高亮。' }));
    return;
  }
  const region = S.snapshot.regions.find((r) => r.id === S.selected);
  if (!region) {
    box.append(h('div', { class: 'detail-empty', text: '该区域已不在当前视野中。' }));
    return;
  }

  vis.textContent = visibilityLabel(region.visibility);
  const owner = S.snapshot.factions.find((f) => f.id === region.owner);
  const color = region.owner ? factionColor(region.owner) : '#7d7561';
  const dot = h('i', { class: 'faction-dot' });
  dot.style.background = color;
  dot.style.color = color;
  const terrain = TERRAIN_META[region.terrain] ?? { label: region.terrain ?? '未知' };

  const tags = h('div', { class: 'detail-tags' },
    h('span', { class: `tag ${region.visibility === 'unknown' ? 'red' : 'gold'}`, text: visibilityLabel(region.visibility) }),
    owner ? h('span', { class: 'tag', text: relationLabel(owner.relation) }) : h('span', { class: 'tag', text: '中立' }),
  );

  box.append(
    h('div', { class: 'detail-head' },
      h('div', {},
        h('h3', { class: 'detail-name', text: region.visibility === 'unknown' ? '？？？' : region.name }),
        h('div', { class: 'detail-owner' },
          dot,
          h('span', { text: owner ? owner.name : (region.visibility === 'unknown' ? '归属不明' : '中立区域') }),
        ),
      ),
      tags,
    ),
  );

  if (region.visibility === 'unknown') {
    box.append(h('div', { class: 'detail-empty', text: '此区域尚未探明。地图上只显示它的位置，归属与驻军均不可见。' }));
    box.append(h('div', { id: 'regionActions', class: 'region-actions' }));
    renderRegionActions();
    appendAdjacency(box, region);
    appendDetailButtons(box);
    return;
  }

  const infraDef = infraLevelHelp(region.infrastructure ?? 0);
  const unrestValue = Number.isFinite(region.unrest) ? region.unrest : null;
  const grid = h('div', { class: 'detail-grid' },
    cell('地形', terrain.label),
    cell('人口', Number.isFinite(region.population) ? formatTroops(region.population) : '—'),
    cell('平民', Number.isFinite(region.civilianPopulation)
      ? `${formatTroops(region.civilianPopulation)}${Number.isFinite(region.population) && region.population > 0 ? `（${Math.round(region.civilianPopulation / region.population * 100)}%）` : ''}`
      : '—'),
    cell('发展', region.developmentLabel ?? '—'),
    cell('要塞', Number.isFinite(region.fortLevel) ? `Lv${region.fortLevel}` : '—'),
    cell('地区基建', infraDef ? `Lv${infraDef.level} ${infraDef.name}` : '未建'),
    cell('地区动乱', unrestValue === null ? '—' : `${unrestValue} · ${unrestStateLabel(unrestValue)}`),
    cell('全国民心', owner ? `${owner.morale}（${factionName(owner.id)}）` : '—'),
  );
  box.append(grid);
  if (Number.isFinite(region.civilianPopulation)) {
    const laborText = Number.isFinite(region.civilianOutputFactor)
      ? `本区粮/金产出 ×${region.civilianOutputFactor.toFixed(2)}（平民占比越低，产出越少）；`
      : '';
    box.append(h('div', {
      class: 'detail-note',
      text: `${laborText}平民 = 本区人口 − 驻军；征兵会减少平民，影响税收与兵源增长。`,
    }));
  }

  // 地形效果：产出/人口/情报/行军/守备一次说清，避免只看到"山地"两个字
  const terrainTrait = terrainHelpOf(region.terrain);
  if (terrainTrait) {
    const bits = [
      `粮产 ${mult(terrainTrait.food)}`,
      `金产 ${mult(terrainTrait.gold)}`,
      `人口增长 ${mult(terrainTrait.popGrowth)}`,
      `情报费 ${mult(terrainTrait.intelCost)}`,
      `行军消耗 ${mult(terrainTrait.moveCost)}`,
      `守军战力 ${mult(terrainTrait.defenderBonus)}`,
    ];
    if (terrainTrait.infantryDefense > 1) bits.push(`步兵守备 ${mult(terrainTrait.infantryDefense)}`);
    box.append(h('div', { class: 'detail-note detail-note--terrain', text: `${terrain.label}地形：${bits.join('、')}` }));
  }

  // 基建效果：把「降动乱 / 促人口 / 全国民心」逐项写清，避免只看到等级数字
  if (infraDef) {
    box.append(h('div', {
      class: 'detail-note detail-note--infra',
      text: `基建 Lv${infraDef.level}「${infraDef.name}」：本区动乱 -${infraDef.unrestRelief}（落成时）、` +
        `-${infraDef.unrestReductionPerTurn}/回合；本区人口 +${pct(infraDef.populationGrowthBonus, 1)}/回合；` +
        `基建点 ${infraDef.moralePoints}` +
        (infraHelp() ? `（每 ${infraHelp().moralePointsPerTurnPoint} 点 +1 全国民心/回合）` : ''),
    }));
  }
  const nextInfra = nextInfraHelp(region.infrastructure ?? 0);
  if (nextInfra && region.owner === S.selfId) {
    box.append(h('div', {
      class: 'detail-note',
      text: `可升 Lv${nextInfra.level}「${nextInfra.name}」：${nextInfra.costGold} 金；` +
        `动乱 -${nextInfra.unrestRelief}（立即）、-${nextInfra.unrestReductionPerTurn}/回合；` +
        `人口 +${pct(nextInfra.populationGrowthBonus, 1)}/回合；全国民心 +${infraHelp()?.moraleOnBuild ?? 0}。`,
    }));
  }
  if (unrestValue !== null && unrestEffectsHelp()) {
    const fx = unrestEffectsHelp();
    const outputLoss = Math.min(1, unrestValue * fx.outputPenaltyPerPoint);
    const defenseLoss = Math.min(1, unrestValue * fx.defensePenaltyPerPoint);
    box.append(h('div', {
      class: `detail-note${unrestValue >= 60 ? ' detail-note--danger' : ''}`,
      text: `地区动乱影响本区：金粮产出 -${pct(outputLoss)}，守备战力 -${pct(defenseLoss)}。` +
        `${unrestValue >= 60 ? '动乱已进入动荡区，尽快用基建/减税/休战压低。' : ''}`,
    }));
  }
  if (region.rebellion) {
    const reb = region.rebellion;
    const bits = [`原属 ${reb.originalName ?? reb.original}`];
    if (reb.claimedBy) {
      bits.push(`已归附 ${reb.claimedByName ?? reb.claimedBy}`);
      if (reb.claimedTurn != null) bits.push(`宣称于 T${reb.claimedTurn}`);
      if (reb.conscriptionTurns != null) bits.push(`${reb.conscriptionTurns} 回合内征兵会再次起义`);
    } else {
      bits.push('起义军据城；只有原属国杀光全部民兵才能重占');
    }
    bits.push(`起义民兵 ${formatTroops(reb.rebelTroops ?? 0)}`);
    box.append(h('div', { class: 'detail-note detail-note--danger', text: bits.join('；') }));
  }
  if (region.frontier && region.owner === null) {
    box.append(h('div', {
      class: 'detail-note',
      text: `未开垦荒地：原住民 ${formatTroops(region.frontier.natives)}（需本区兵力 ≥ ${formatTroops(region.frontier.requiredTroops ?? 0)}）；需派兵进入后开荒（基建 Lv${region.frontier.infrastructure}），` +
        `花费 ${region.frontier.goldCost} 金 / ${region.frontier.foodCost} 粮，可获得约 ${region.frontier.lootGold} 金与归化兵源。派兵与开荒分两回合；普通进攻不能占领。`,
    }));
  }

  if (Array.isArray(S.layout?.ports) && S.layout.ports.includes(region.id)) {
    const waterNeighbors = (S.layout.waterRoutes ?? [])
      .filter((route) => route.a === region.id || route.b === region.id)
      .map((route) => regionName(route.a === region.id ? route.b : route.a));
    box.append(h('div', {
      class: 'detail-note',
      text: `港口：可征募/停泊水师${waterNeighbors.length > 0 ? `；水路通往 ${waterNeighbors.join('、')}（水师专用）` : ''}`,
    }));
  }

  if (region.visibility === 'full') {
    const stacks = Array.isArray(region.stacks) ? region.stacks : [];
    if (stacks.length === 0) {
      box.append(h('div', { class: 'detail-note', text: '无驻军。' }));
    } else {
      const list = h('ul', { class: 'stack-list' });
      for (const st of stacks) {
        const stDot = h('i', { class: 'faction-dot' });
        stDot.style.background = factionColor(st.ownerId);
        stDot.style.color = factionColor(st.ownerId);
        list.append(h('li', {},
          h('span', { class: 'st-left' },
            stDot,
            h('span', { text: st.typeName }),
            st.title ? h('span', { class: `tag ${st.title === 'bandit_conscript' ? 'red' : 'gold'}`, text: UNIT_TITLE_LABEL[st.title] ?? st.title }) : null,
          ),
          h('span', { class: 'st-troops', text: formatTroops(st.troops), title: `${armyTierLabel(st.tier)} · ${factionName(st.ownerId)}${st.title ? ` · ${UNIT_TITLE_LABEL[st.title] ?? st.title}` : ''}` }),
        ));
      }
      box.append(list);
      if (stacks.some((s) => s.title === 'bandit_conscript')) {
        box.append(h('div', {
          class: 'detail-note detail-note--danger',
          text: '贼配军：每支每回合 +4 本区动乱；地区动乱每回合自然 -3，所以一支贼配军净 +1、两支净 +5。裁军不返还兵源。',
        }));
      }
      if (stacks.some((s) => s.title === 'rebel_garrison' || s.title === 'rebel_militia')) {
        box.append(h('div', {
          class: 'detail-note detail-note--danger',
          text: '起义/守城民兵战力只有正规军的一小部分；守城民兵不可调动、分兵或合兵。',
        }));
      }
    }
  } else if (region.visibility === 'partial') {
    box.append(h('div', { class: 'detail-note', text: '邻境情报：知道归属与地形，但驻军规模未知。' }));
  } else {
    box.append(h('div', { class: 'detail-note', text: '仅知归属与地形，尚无驻军情报。' }));
  }

  if (region.tacticalNote) {
    box.append(h('div', { class: 'detail-note', text: region.tacticalNote }));
  }

  box.append(h('div', { id: 'regionActions', class: 'region-actions' }));
  renderRegionActions();
  appendAdjacency(box, region);
  appendDetailButtons(box);
}

function cell(label, value) {
  return h('div', { class: 'cell' }, h('span', { text: label }), h('b', { text: value }));
}

function appendAdjacency(box, region) {
  const neighbors = Array.isArray(region.adjacency) ? region.adjacency : [];
  if (neighbors.length === 0) return;
  box.append(h('div', { class: 'self-sub', style: 'margin:10px 0 0', text: `邻接道路（${neighbors.length}）` }));
  const list = h('div', { class: 'adj-list' });
  for (const id of neighbors) {
    const nb = S.snapshot.regions.find((r) => r.id === id);
    const known = nb && nb.visibility !== 'unknown';
    const dot = h('i', { class: 'adj-dot' });
    if (known && nb.owner) {
      dot.style.background = factionColor(nb.owner);
      dot.style.boxShadow = `0 0 5px ${factionColor(nb.owner)}`;
    }
    const label = known ? nb.name : '？';
    list.append(h('button', {
      class: 'adj-chip',
      type: 'button',
      title: known ? `${label}${nb.owner ? ` · ${factionName(nb.owner)}` : ' · 中立'}` : '未探明区域',
      onclick: () => selectRegion(id),
    }, dot, h('span', { text: label })));
  }
  box.append(list);
}

function appendDetailButtons(box) {
  box.append(h('div', { class: 'queue-actions', style: 'margin-top:10px' },
    h('button', {
      class: 'btn small',
      type: 'button',
      text: '筛选本区动作',
      onclick: () => {
        S.filterMode = 'region';
        S.pair = null;
        map.setPair(null);
        renderActions();
      },
    }),
    h('button', {
      class: 'btn small ghost',
      type: 'button',
      text: '取消选择',
      onclick: () => deselectRegion(),
    }),
  ));
  box.append(h('div', { class: 'self-sub mono', style: 'margin-top:7px; opacity:.55', text: S.selected }));
}

// ─────────────────────────────────────────────────────────────
// 渲染：动作列表
// ─────────────────────────────────────────────────────────────

function renderFilters() {
  const box = $('actionFilters');
  clearNode(box);
  if (!S.snapshot) return;

  const kinds = new Map();
  for (const action of S.actions) kinds.set(action.kind, (kinds.get(action.kind) ?? 0) + 1);

  const chip = (id, label, count) => h('button', {
    class: `filter-chip${S.pair === null && S.filterMode === id ? ' is-active' : ''}`,
    type: 'button',
    text: count === undefined ? label : `${label} ${count}`,
    onclick: () => {
      S.filterMode = id;
      S.pair = null;
      map.setPair(null);
      renderActions();
    },
  });

  box.append(chip('all', '全部', S.actions.length));
  if (S.selected) box.append(chip('region', '本区'));
  const order = ['attack', 'move_units', 'split_unit', 'merge_units', 'recruit', 'develop', 'build_infrastructure', 'fortify', 'set_tax', 'set_law', 'diplomacy', 'send_spy', 'claim_rebellion', 'trade_slaves', 'settle_region', 'disband'];
  for (const kind of order) {
    const count = kinds.get(kind);
    if (!count) continue;
    const meta = ACTION_KIND_META[kind];
    box.append(chip(kind, `${meta?.icon ?? '·'} ${meta?.label ?? kind}`, count));
  }
  for (const [kind, count] of kinds) {
    if (order.includes(kind)) continue;
    box.append(chip(kind, kind, count));
  }
}

function renderActions() {
  const box = $('actions');
  const countEl = $('actionsCount');
  const pairBox = $('actionPairBanner');
  const keepScroll = box.scrollTop;
  clearNode(box);
  clearNode(pairBox);
  renderFilters();

  if (!S.snapshot) {
    countEl.textContent = '0';
    box.append(h('div', { class: 'actions-empty', text: '连接后显示服务端枚举的合法动作。' }));
    return;
  }
  if (S.snapshot.phase === 'ended') {
    countEl.textContent = '0';
    box.append(h('div', { class: 'actions-empty' }, h('div', { text: emptyActionMessage() })));
    return;
  }

  if (S.pair) {
    const count = S.actions.filter((a) => a.sourceRegion === S.pair.source && a.targetRegion === S.pair.target).length;
    pairBox.append(h('div', { class: 'pair-banner' },
      h('span', { text: `${regionName(S.pair.source)} → ${regionName(S.pair.target)} · ${count} 个可选动作` }),
      h('button', {
        type: 'button',
        text: '×',
        title: '取消该路线的筛选',
        onclick: () => {
          S.pair = null;
          map.setPair(null);
          renderActions();
        },
      }),
    ));
  }

  let list = S.actions;
  if (S.pair) {
    list = list.filter((a) => a.sourceRegion === S.pair.source && a.targetRegion === S.pair.target);
  } else if (S.filterMode === 'region') {
    list = S.selected
      ? list.filter((a) => a.sourceRegion === S.selected || a.targetRegion === S.selected)
      : S.actions;
  } else if (S.filterMode !== 'all') {
    list = list.filter((a) => a.kind === S.filterMode);
  }

  countEl.textContent = `${list.length} / ${S.actions.length}`;

  if (list.length === 0) {
    box.append(h('div', { class: 'actions-empty' },
      h('div', { text: emptyActionMessage() }),
      S.filterMode !== 'all' || S.pair
        ? h('button', {
          class: 'btn small ghost',
          type: 'button',
          text: '显示全部动作',
          onclick: () => {
            S.filterMode = 'all';
            S.pair = null;
            map.setPair(null);
            renderActions();
          },
        })
        : null,
    ));
    return;
  }

  const order = ['attack', 'move_units', 'split_unit', 'merge_units', 'recruit', 'develop', 'build_infrastructure', 'fortify', 'set_tax', 'set_law', 'diplomacy', 'send_spy', 'claim_rebellion', 'trade_slaves', 'settle_region', 'disband'];
  const groups = new Map();
  for (const action of list) {
    const key = order.includes(action.kind) ? action.kind : 'other';
    const arr = groups.get(key) ?? [];
    arr.push(action);
    groups.set(key, arr);
  }
  const keys = [...order.filter((k) => groups.has(k)), ...(groups.has('other') ? ['other'] : [])];

  for (const kind of keys) {
    const meta = ACTION_KIND_META[kind] ?? { icon: '·', label: kind === 'other' ? '其他' : kind };
    box.append(h('div', { class: 'action-group-title' }, h('span', { text: `${meta.icon} ${meta.label}` }), h('span', { text: String(groups.get(kind).length) })));
    if (kind === 'set_tax') {
      box.append(h('div', {
        class: 'action-note',
        text: '税率 20% 为中性；10% 轻税 +2 民心/回合；30% -4、40% -8、50% -12、60% -16，50% 起另加地区动乱。',
      }));
    }
    if (kind === 'build_infrastructure') {
      box.append(h('div', {
        class: 'action-note',
        text: '基建只影响本区：降低本区动乱、提高本区人口增长；基建点全国汇总，每 6 点 +1 全国民心/回合。',
      }));
    }
    for (const action of groups.get(kind)) box.append(actionRow(action));
  }
  box.scrollTop = keepScroll;
}

/** 选中地块后，在“区域详情”里直接列出该地块能做什么（比翻右侧长列表更快） */
function renderRegionActions() {
  const box = $('regionActions');
  if (!box) return;
  clearNode(box);
  if (!S.selected || !S.snapshot) return;
  if (S.snapshot.phase === 'ended') {
    box.append(h('div', { class: 'detail-empty', text: '对局已结束，不能再下令。' }));
    return;
  }
  const related = S.actions.filter(
    (a) => a.sourceRegion === S.selected || a.targetRegion === S.selected,
  );
  const seen = new Set();
  const groups = [
    {
      label: '选定路线',
      filter: (a) => S.pair && a.sourceRegion === S.pair.source && a.targetRegion === S.pair.target,
    },
    {
      label: '本区内政 / 征兵',
      filter: (a) => a.targetRegion === S.selected && ['recruit', 'develop', 'build_infrastructure', 'fortify'].includes(a.kind),
    },
    {
      label: '本区出兵',
      filter: (a) => a.sourceRegion === S.selected && ['attack', 'move_units'].includes(a.kind),
    },
    {
      label: '分兵 / 合兵',
      filter: (a) => ['split_unit', 'merge_units'].includes(a.kind) &&
        (a.sourceRegion === S.selected || a.targetRegion === S.selected),
    },
    {
      label: '裁军',
      filter: (a) => a.sourceRegion === S.selected && a.kind === 'disband',
    },
    {
      label: '进攻本区',
      filter: (a) => a.targetRegion === S.selected && a.kind === 'attack' && a.sourceRegion !== S.selected,
    },
    {
      label: '谍报',
      filter: (a) => a.targetRegion === S.selected && a.kind === 'send_spy',
    },
  ];
  let shown = 0;
  for (const group of groups) {
    const list = related.filter((a) => !seen.has(a.id) && group.filter(a)).slice(0, 6);
    if (list.length === 0) continue;
    for (const a of list) seen.add(a.id);
    box.append(h('div', { class: 'region-actions-title', text: group.label }));
    for (const action of list) box.append(regionActionChip(action));
    shown += list.length;
  }
  if (shown === 0) {
    box.append(h('div', {
      class: 'detail-empty',
      text: '本区当前没有可执行动作（可能资源不足、没有未行动部队或本回合已锁定）。相邻敌区需要己方未行动部队；若部队刚移动，可用「移动后进攻」组合动作。',
    }));
  }
}

function regionActionChip(action) {
  const meta = ACTION_KIND_META[action.kind] ?? { icon: '·', label: action.kind, color: '#c9c9c9' };
  const reason = actionDisabledReason(action);
  const est = Object.entries(action.estimate ?? {})
    .map(([key, value]) => {
      const label = estimateLabel(key);
      return label ? `${label} ${value}` : null;
    })
    .filter(Boolean)
    .slice(0, 3)
    .join(' · ');
  const btn = h('button', {
    class: 'region-action',
    type: 'button',
    disabled: reason !== null,
    title: reason ?? action.description ?? action.label,
    onclick: () => addAction(action),
  },
    h('span', { class: 'ra-icon', style: `color:${meta.color}`, text: meta.icon }),
    h('span', { class: 'ra-label', text: action.label }),
    est ? h('span', { class: 'ra-est', text: est }) : null,
  );
  return btn;
}

function emptyActionMessage() {
  if (!S.connected) return '连接后显示服务端枚举的合法动作。';
  if (S.snapshot?.phase === 'ended') {
    return `对局已结束：${endResultText(S.snapshot)}（${endReasonLabel(S.snapshot.endReason)}），不可再下令。`;
  }
  if (!S.selfId) return '观战席位没有可执行动作。';
  if (S.snapshot.phase !== 'submitting') return `当前阶段为「${phaseLabel(S.snapshot.phase)}」，不可下令。`;
  if (S.lockedTurn === S.snapshot.turn) return '本回合军令已锁定，等待其他席位。';
  return '当前没有合法动作（可能资源不足、没有未行动部队或对局结束）。';
}

function actionDisabledReason(action) {
  if (!canOrder()) return emptyActionMessage();
  if (S.queue.some((q) => q.actionId === action.id)) return '该命令已在军令队列中';
  if (S.queue.length >= 8) return '一回合最多提交 8 条命令';
  const commandUnit = typeof action.command?.unitId === 'string' ? action.command.unitId : null;
  if (commandUnit !== null && S.queue.some((q) => q.command?.unitId === commandUnit)) {
    return '同一支部队本回合只能下一条军令（移动后进攻请选组合动作）';
  }
  return null;
}

function actionRow(action) {
  const meta = ACTION_KIND_META[action.kind] ?? { icon: '·', label: action.kind, color: '#c9c9c9' };
  const already = S.queue.some((q) => q.actionId === action.id);
  const commandUnit = typeof action.command?.unitId === 'string' ? action.command.unitId : null;
  const unitBusy = commandUnit !== null && S.queue.some((q) => q.command?.unitId === commandUnit);
  const disabled = actionDisabledReason(action) !== null;
  const btnLabel = already ? '已入队' : unitBusy ? '该部队已入队' : S.queue.length >= 8 ? '已满 8 条' : '＋ 军令';

  const metaBits = [];
  if (action.sourceRegion && action.targetRegion) {
    metaBits.push(h('span', { class: 'route', text: `${regionName(action.sourceRegion)} → ${regionName(action.targetRegion)}` }));
  } else if (action.targetRegion) {
    metaBits.push(h('span', { class: 'route', text: regionName(action.targetRegion) }));
  }
  if (Array.isArray(action.path) && action.path.length >= 2) {
    metaBits.push(h('span', { class: 'est', text: `${action.path.length - 1} 格` }));
    if (pathUsesWater(action.path)) metaBits.push(h('span', { class: 'tag blue', text: '水路' }));
  }
  for (const [key, value] of Object.entries(action.estimate ?? {})) {
    const label = estimateLabel(key);
    if (!label) continue;
    metaBits.push(h('span', { class: 'est', text: `${label} ${value}` }));
    if (metaBits.length >= 5) break;
  }

  let effectLine = typeof action.description === 'string' ? action.description : '';
  if (action.kind === 'set_law') {
    const help = lawHelp(action.command?.lawId);
    if (help) effectLine = [help.description, action.description].filter(Boolean).join(' · ');
  }

  return h('div', { class: 'action' },
    h('div', { class: 'action-main' },
      h('div', { class: 'action-label' }, h('span', { style: `color:${meta.color};margin-right:4px`, text: meta.icon }), action.label),
      metaBits.length > 0 ? h('div', { class: 'action-meta' }, ...metaBits) : null,
      effectLine ? h('div', { class: 'action-effect', text: `效果：${effectLine}` }) : null,
    ),
    h('button', {
      class: 'btn small primary action-btn',
      type: 'button',
      text: btnLabel,
      disabled,
      title: already ? '该命令已在军令队列中' : action.label,
      onclick: () => addAction(action),
    }),
  );
}

function estimateLabel(key) {
  return {
    powerRatio: '战力比',
    defenderTroops: '守军',
    attackerTroops: '我兵',
    goldCost: '金',
    lawPopulation: '人口',
    foodCost: '粮',
    movementCost: '行程',
    moveCost: '行军',
    count: '兵数',
    taxRevenue: '税金/回合',
    goldDeltaPerTurn: '税金变化',
    taxUnrestPerTurn: '税率动乱',
    defenseBonus: '防',
    troopsReleased: '遣散',
    splitCount: '分出',
    remaining: '留守',
    mergeCount: '并入',
    total: '合后',
    goldRefund: '返还金',
    spyCost: '间谍金',
    intelTurns: '情报回合',
    currentRelation: '现关系',
    movement: '机动',
    battleUnrest: '战火动乱',
    warUnrest: '开战动乱',
    counterBonus: '克制',
    defenderCounter: '被克',
    attackerType: '兵种',
    recruitUnrest: '征兵动乱',
    infrastructureLevel: '基建',
    unrestPerTurn: '动乱/回合',
    populationGrowth: '人口增长',
    moralePoints: '基建点',
    moraleFactor: '士气系数',
    slaveCount: '奴',
    grudge: '恨意',
    tradePolicy: '商路',
    buyerMoraleCost: '买方民心',
    sellerMoraleCost: '卖方民心',
    banditUnrestPerTurn: '贼配军动乱',
    rebelTroops: '起义民兵',
    claimantMorale: '我方民心',
    originalMorale: '原主民心',
    claimedUnrest: '归附动乱',
    garrisonCap: '守城上限',
    conscriptionTurns: '征兵窗口',
    normalizeUnrest: '恢复线',
    rebellionRisk: '再叛风险',
    natives: '原住民',
    requiredTroops: '所需兵力',
    ownTroops: '在场兵力',
    lootGold: '开荒资金',
    nativeManpower: '归化兵源',
    infrastructure: '基建',
  }[key] ?? null;
}

function addAction(action) {
  if (!canOrder()) {
    toast(emptyActionMessage(), 'error');
    return;
  }
  if (S.queue.length >= 8) {
    toast('一回合最多提交 8 条命令', 'error');
    return;
  }
  if (S.queue.some((q) => q.actionId === action.id)) {
    toast('这条命令已经在军令中');
    return;
  }
  const commandUnit = typeof action.command?.unitId === 'string' ? action.command.unitId : null;
  if (commandUnit !== null && S.queue.some((q) => q.command?.unitId === commandUnit)) {
    toast('同一支部队本回合只能下一条军令（移动后进攻请选组合动作）；请先移除它的旧军令', 'error');
    return;
  }

  S.queue.push({
    actionId: action.id,
    label: action.label,
    command: action.command,
    kind: action.kind,
    sourceRegion: action.sourceRegion ?? null,
    targetRegion: action.targetRegion ?? null,
    path: Array.isArray(action.path) ? action.path : null,
  });
  S.pair = null;
  map.setPair(null);
  renderQueue();
  renderActions();
  map.setQueue(S.queue);
  toast(`已加入军令：${action.label}`);
  appendLog('order', `加入军令：${action.label}`, 'is-muted');
}

function removeOrder(index) {
  S.queue.splice(index, 1);
  renderQueue();
  renderActions();
  map.setQueue(S.queue);
}

// ─────────────────────────────────────────────────────────────
// 渲染：军令队列
// ─────────────────────────────────────────────────────────────

function renderQueue() {
  const ul = $('queueList');
  clearNode(ul);
  $('queueCount').textContent = `${S.queue.length} / 8`;

  if (S.queue.length === 0) {
    ul.append(h('li', { class: 'queue-empty', text: '点击地图上的己方六角格，再点高亮目标，即可把引擎给的合法动作加入军令。' }));
  } else {
    S.queue.forEach((order, index) => {
      const meta = ACTION_KIND_META[order.kind] ?? { icon: '·' };
      const li = h('li', {},
        h('span', { class: 'q-index', text: String(index + 1) }),
        h('div', { class: 'q-main' },
          h('div', { class: 'q-label', text: `${meta.icon} ${order.label}` }),
          order.sourceRegion || order.targetRegion
            ? h('div', { class: 'q-route', text: routeText(order) })
            : null,
        ),
        h('button', {
          class: 'q-remove', type: 'button', text: '×', title: '移出军令',
          onclick: (event) => { event.stopPropagation(); removeOrder(index); },
        }),
      );
      li.addEventListener('mouseenter', () => map.setHoveredOrder(index));
      li.addEventListener('mouseleave', () => map.setHoveredOrder(-1));
      ul.append(li);
    });
  }

  const orderable = canOrder();
  const hasUnsent = S.queue.length > 0;
  $('submit').disabled = !orderable || !hasUnsent;
  // ★锁定不是"提交"：队列未清空时禁用锁定，避免玩家直接锁掉一回合却没发出军令
  $('lock').disabled =
    !S.connected ||
    !S.snapshot ||
    !S.selfId ||
    S.snapshot.phase !== 'submitting' ||
    S.lockedTurn === S.snapshot.turn ||
    hasUnsent;
  $('lock').title = hasUnsent ? '先提交军令，再锁定回合' : '';
  $('advice').disabled = !S.connected || !S.snapshot || !S.selfId || S.snapshot.phase === 'ended';
  $('clear').disabled = !hasUnsent;
  $('lockedNote').textContent = S.snapshot?.phase === 'ended'
    ? `对局已结束：${endResultText(S.snapshot)}（${endReasonLabel(S.snapshot.endReason)}）。只能查看地图与战报。`
    : S.lockedTurn !== null && S.lockedTurn === S.snapshot?.turn
      ? '本回合已锁定，等待其他席位提交。'
      : hasUnsent
        ? '队列里还有未提交的军令：先点「提交军令」，再锁定回合。'
        : '';
  renderRegionActions();
  renderDiplomacy();
}

function routeText(order) {
  const bits = [];
  if (order.sourceRegion) bits.push(regionName(order.sourceRegion));
  if (order.targetRegion) bits.push(regionName(order.targetRegion));
  let text = bits.join(' → ');
  if (Array.isArray(order.path) && order.path.length >= 2) {
    text += ` · ${order.path.length - 1} 格`;
    if (pathUsesWater(order.path)) text += ' · 水路';
  }
  return text;
}

async function submitOrders() {
  if (!S.client || !canOrder() || S.queue.length === 0) return;
  const commands = S.queue.map((q) => q.command);
  const requestId = `web-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  $('submit').disabled = true;
  try {
    const r = await S.client.submit(commands, requestId);
    if (r.status === 409) {
      appendLog('warn', '局面已变化（STALE_REVISION），已重新拉取快照。', 'is-danger');
      toast('局面已变化，请重新选择动作', 'error');
      S.queue = [];
      map.setQueue([]);
      renderQueue();
      await refreshNow();
      return;
    }
    if (!r.ok) {
      const code = r.json?.error?.code ?? r.json?.rejections?.[0]?.code ?? `HTTP ${r.status}`;
      appendLog('error', `提交被拒：${code}。${r.json?.error?.message ?? ''}`, 'is-danger');
      toast(`提交被拒：${code}`, 'error');
      return;
    }
    const rejections = Array.isArray(r.json?.rejections) ? r.json.rejections : [];
    for (const rejection of rejections) {
      appendLog('error', `第 ${rejection.index + 1} 条被拒：${rejection.code} ${rejection.message ?? ''}`, 'is-danger');
    }
    appendLog('order', `提交完成：${r.json?.completedSteps ?? commands.length} 步${rejections.length ? `，${rejections.length} 条被拒` : ''}。`, 'is-important');
    toast(rejections.length > 0 ? '已提交，部分命令被拒' : '军令已提交', rejections.length ? 'error' : '');
    S.queue = [];
    map.setQueue([]);
    renderQueue();
    await refreshNow();
  } catch (err) {
    appendLog('error', `提交失败：${err?.message ?? err}`, 'is-danger');
    toast('提交失败，见战报', 'error');
  } finally {
    renderQueue();
  }
}

async function lockTurn() {
  if (!S.client || !S.snapshot) return;
  try {
    const r = await S.client.lock();
    if (!r.locked) {
      appendLog('warn', '锁定被拒（只读席位或对局已结束）。', 'is-danger');
      return;
    }
    S.lockedTurn = S.snapshot.turn;
    const waiting = Array.isArray(r.waiting) ? r.waiting.length : 0;
    appendLog('lock', waiting === 0 ? '已锁定，等待结算…' : `已锁定；还差 ${waiting} 席。`, 'is-important');
    toast(waiting === 0 ? '全员已锁定，结算中…' : `已锁定，还差 ${waiting} 席`);
    renderQueue();
    renderActions();
  } catch (err) {
    appendLog('error', `锁定失败：${err?.message ?? err}`, 'is-danger');
  }
}

async function requestAdvice() {
  if (!S.client) return;
  $('advice').disabled = true;
  try {
    const r = await S.client.requestAdvice();
    if (r?.adviceId) {
      appendLog('advisor', `军师建议已生成：${r.adviceId}`, 'is-important');
      toast('军师建议已就绪');
    } else {
      appendLog('advisor', `军师未生成建议：${r?.skipped ?? 'unknown'}`, 'is-muted');
      toast(`军师降级：${r?.skipped ?? 'unknown'}`);
    }
  } catch (err) {
    appendLog('error', `请求建议失败：${err?.message ?? err}`, 'is-danger');
  } finally {
    $('advice').disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
// 战报 / 提示
// ─────────────────────────────────────────────────────────────

function appendLog(kind, text, cls = '') {
  const ul = $('logList');
  const empty = ul.querySelector('.log-empty');
  if (empty) empty.remove();
  const nearBottom = ul.scrollHeight - ul.scrollTop - ul.clientHeight < 60;
  const icons = {
    hourglass: '时', scroll: '报', swords: '战', flag: '旗', move: '→',
    coin: '征', build: '筑', heart: '心', warn: '!', letter: '书',
    handshake: '交', skull: '亡', advisor: '军', book: '叙', order: '令',
    info: '·', error: '!',
  };
  const li = h('li', { class: cls },
    h('time', { text: new Date().toLocaleTimeString('zh-CN', { hour12: false }) }),
    h('span', { class: 'ico', text: icons[kind] ?? '·' }),
    h('span', { class: 'msg', text }),
  );
  ul.append(li);
  while (ul.children.length > 250) ul.firstElementChild?.remove();
  if (nearBottom) ul.scrollTop = ul.scrollHeight;
}

let toastTimer = null;
function toast(text, kind = '') {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast is-visible${kind === 'error' ? ' is-error' : ''}`;
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-visible');
  }, 2600);
}

let bannerTimer = null;
function showBanner(main, sub = '') {
  const el = $('turnBanner');
  el.querySelector('b').textContent = main;
  el.querySelector('small').textContent = sub;
  el.classList.add('is-visible');
  if (bannerTimer !== null) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('is-visible'), 1900);
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `connect-status ${kind}`;
}

function setConnectionBadge(kind, text) {
  const el = $('connBadge');
  el.textContent = text;
  el.className = `conn-badge${kind === 'online' ? ' is-online' : kind === 'busy' ? ' is-busy' : kind === 'error' ? ' is-error' : ''}`;
  $('hallResume').hidden = kind !== 'online';
}

// ─────────────────────────────────────────────────────────────
// 文字拓扑 / 缩放 / 视图切换
// ─────────────────────────────────────────────────────────────

function renderTextMap() {
  $('mapText').textContent = S.snapshot?.mapText ?? '';
}

/** 六角 / 方块两种棋盘的界面文案与图例 */
function applyLayoutUi() {
  const kind = S.layout?.kind;
  const board = kind === 'hexboard';
  const square = kind === 'square';
  $('viewMap').textContent = board ? '六角棋盘' : square ? '方块棋盘' : '六角地图';
  $('mapHint').textContent = board
    ? '点击地块 → 右侧/详情列出该地可执行操作；蓝色水域只有水师可走，可一回合连走多格 · 滚轮缩放 · 拖拽平移'
    : square
      ? '点击地块 → 右侧/详情列出该地可执行操作；蓝色水路只有水师可走，可一回合连走多格 · 滚轮缩放 · 拖拽平移'
      : '点击地块 → 右侧/详情列出该地可执行操作 · 滚轮缩放 · 拖拽平移';
  const extra = $('mapLegendExtra');
  if (extra) extra.textContent = board ? '六角相邻 = 陆军可走' : square ? '道路 = 陆军邻接' : '道路 = 合法邻接';
  for (const el of document.querySelectorAll('.water-legend')) {
    if (el instanceof HTMLElement) el.hidden = !(board || square);
  }
}

/** 这条路径是否至少含一段静态水路（用于动作/军令上的"水路"标记） */
function pathUsesWater(path) {
  if (!Array.isArray(path) || path.length < 2) return false;
  const routes = Array.isArray(S.layout?.waterRoutes) ? S.layout.waterRoutes : [];
  const keys = new Set(routes.map((r) => (r.a < r.b ? `${r.a}|${r.b}` : `${r.b}|${r.a}`)));
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (keys.has(key)) return true;
  }
  return false;
}

function setView(mode) {
  const isMap = mode === 'map';
  $('mapShell').classList.toggle('is-text', !isMap);
  $('mapText').classList.toggle('is-visible', !isMap);
  $('viewMap').classList.toggle('is-active', isMap);
  $('viewText').classList.toggle('is-active', !isMap);
  $('mapSvg').style.display = isMap ? '' : 'none';
  $('mapHint').style.display = isMap ? '' : 'none';
}

// ─────────────────────────────────────────────────────────────
// 账号 / 房间大厅（多用户管理）
// ─────────────────────────────────────────────────────────────

const ACCOUNT_TOKEN_KEY = 'guozhan_account_token';
const ACCOUNT = { token: '', user: null, rooms: [], lobby: [] };

function accountRoot() {
  const raw = String($('server')?.value ?? '').trim().replace(/\/+$/, '');
  return raw.endsWith('/api') ? raw.slice(0, -4) : raw;
}

async function accountApi(path, opts = {}) {
  const root = accountRoot();
  if (!root) throw new Error('先填写服务器地址');
  const headers = { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
  if (ACCOUNT.token) headers.Authorization = `Bearer ${ACCOUNT.token}`;
  const resp = await fetch(root + path, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!resp.ok) {
    const err = new Error(json?.error?.message ?? (text.slice(0, 160) || `HTTP ${resp.status}`));
    err.status = resp.status;
    throw err;
  }
  return json;
}

function setAccountStatus(text, level = '') {
  const el = $('accountStatus');
  el.textContent = text;
  el.className = `connect-status${level ? ` ${level}` : ''}`;
}

function saveAccountToken(token) {
  ACCOUNT.token = token || '';
  try {
    if (ACCOUNT.token) localStorage.setItem(ACCOUNT_TOKEN_KEY, ACCOUNT.token);
    else localStorage.removeItem(ACCOUNT_TOKEN_KEY);
  } catch { /* 隐私模式 */ }
}

function scenarioLabel(id) {
  return QUICKSTART_SCENARIOS.find((s) => s.id === id)?.name ?? id;
}

function renderAccount() {
  const logged = Boolean(ACCOUNT.user);
  $('accountLoggedOut').hidden = logged;
  $('accountLoggedIn').hidden = !logged;
  $('accountWho').textContent = logged
    ? `${ACCOUNT.user.displayName}（@${ACCOUNT.user.username}）${ACCOUNT.user.role === 'admin' ? ' · 管理员' : ''}`
    : '—';
  $('hallAccount').classList.toggle('is-logged', logged);
  $('hallResume').hidden = !S.connected;
  $('lobbyCreate').disabled = !logged;
  $('lobbyRefresh').disabled = !logged;
  $('hallServiceOpen').disabled = !logged;
  if (!logged && HALL.game !== 'guozhan') selectHallGame('guozhan');
  renderGameGrid();
  renderResume();
  renderMyRooms();
}

const LAST_ROOM_KEY = 'guozhan_last_room';

function lastRoom() {
  try { return localStorage.getItem(LAST_ROOM_KEY) || ''; } catch { return ''; }
}

function rememberRoom(roomId) {
  try { localStorage.setItem(LAST_ROOM_KEY, roomId); } catch { /* 隐私模式 */ }
}

function ongoingRooms() {
  return ACCOUNT.rooms
    .filter((room) => room.phase !== 'ended')
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function renderResume() {
  const card = $('resumeCard');
  const list = $('resumeList');
  if (!card || !list) return;
  const rooms = ACCOUNT.user ? ongoingRooms() : [];
  card.hidden = rooms.length === 0;
  clearNode(list);
  if (rooms.length === 0) return;
  const last = lastRoom();
  for (const room of rooms.slice(0, 4)) {
    list.append(h('div', { class: 'resume-item' },
      h('div', { class: 'resume-main' },
        h('b', { text: room.name || room.roomId }),
        h('span', { class: 'resume-tag', text: room.roomId === last ? '上次在对局中' : phaseLabel(room.phase) })),
      h('div', { class: 'resume-meta', text: `${scenarioLabel(room.scenarioId)} · T${room.turn} · 席位 ${room.seatId}` }),
      h('button', { class: 'btn primary', type: 'button', onclick: () => void joinLobbyRoom(room.roomId, false) }, '继续对局')));
  }
}

function renderMyRooms() {
  const box = $('myRooms');
  clearNode(box);
  if (!ACCOUNT.user) return box.append(h('div', { class: 'detail-empty', text: '登录后显示我的房间。' }));
  if (ACCOUNT.rooms.length === 0) return box.append(h('div', { class: 'detail-empty', text: '还没有加入任何房间。' }));
  for (const room of ACCOUNT.rooms) {
    box.append(h('div', { class: 'account-room' },
      h('div', { class: 'account-room-head' },
        h('b', { text: room.name || room.roomId }),
        h('span', { text: `${phaseLabel(room.phase)} · T${room.turn}` })),
      h('div', { class: 'account-room-meta', text: `${scenarioLabel(room.scenarioId)} · 席位 ${room.seatId}` }),
      h('div', { class: 'account-room-actions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => void joinLobbyRoom(room.roomId, false) }, '重新进入'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => void leaveLobbyRoom(room.roomId) }, '离开'))));
  }
}

function renderLobby() {
  const box = $('lobbyList');
  clearNode(box);
  if (!ACCOUNT.user) return box.append(h('div', { class: 'detail-empty', text: '登录后显示房间列表。' }));
  if (ACCOUNT.lobby.length === 0) return box.append(h('div', { class: 'detail-empty', text: '暂无房间；可以在右侧新建。' }));
  for (const room of ACCOUNT.lobby) {
    const isHost = room.host?.userId != null && room.host.userId === ACCOUNT.user.id;
    const members = Array.isArray(room.members) ? room.members : [];
    const memberNodes = members.slice(0, 12).map((m) => {
      const canKick = isHost && m.userId !== ACCOUNT.user.id;
      return h('span', { class: 'account-member' },
        `${m.displayName || m.username}（${m.seatId}）`,
        canKick ? h('button', { class: 'btn ghost', type: 'button', onclick: () => void kickLobbyMember(room.roomId, m.userId, false) }, '踢') : null,
        canKick ? h('button', { class: 'btn ghost', type: 'button', onclick: () => void kickLobbyMember(room.roomId, m.userId, true) }, '封') : null);
    });
    box.append(h('div', { class: 'account-room' },
      h('div', { class: 'account-room-head' },
        h('b', { text: room.name || room.roomId }),
        h('span', { text: `${phaseLabel(room.phase)} · T${room.turn}` })),
      h('div', { class: 'account-room-meta', text: `${scenarioLabel(room.scenarioId)} · 房主 ${room.host?.displayName || room.host?.username || '无主'} · ${members.length} 人` }),
      h('div', { class: 'account-room-meta' }, memberNodes),
      h('div', { class: 'account-room-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => void joinLobbyRoom(room.roomId, false) }, '加入席位'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => void joinLobbyRoom(room.roomId, true) }, '观战'),
        isHost ? h('button', { class: 'btn ghost', type: 'button', onclick: () => void deleteLobbyRoom(room.roomId) }, '删除房间') : null)));
  }
}

function populateLobbyScenarios() {
  const scenario = $('lobbyScenario');
  const faction = $('lobbyFaction');
  clearNode(scenario);
  clearNode(faction);
  for (const s of QUICKSTART_SCENARIOS) scenario.append(h('option', { value: s.id, text: s.name }));
  const fillFactions = () => {
    const current = QUICKSTART_SCENARIOS.find((s) => s.id === scenario.value) ?? QUICKSTART_SCENARIOS[0];
    clearNode(faction);
    for (const f of current.factions) faction.append(h('option', { value: f.id, text: f.name }));
  };
  scenario.addEventListener('change', fillFactions);
  fillFactions();
}

async function refreshMyRooms() {
  if (!ACCOUNT.user) return;
  try {
    const me = await accountApi('/api/me');
    ACCOUNT.user = me.user;
    ACCOUNT.rooms = Array.isArray(me.rooms) ? me.rooms : [];
    renderAccount();
  } catch (err) { setAccountStatus(String(err?.message ?? err), 'err'); }
}

async function loadLobby() {
  if (!ACCOUNT.user) return renderLobby();
  setAccountStatus('正在刷新大厅…', 'busy');
  try {
    const result = await accountApi('/api/rooms');
    ACCOUNT.lobby = Array.isArray(result.rooms) ? result.rooms : [];
    renderLobby();
    setAccountStatus(`大厅已刷新：${ACCOUNT.lobby.length} 个房间`, 'ok');
  } catch (err) { setAccountStatus(String(err?.message ?? err), 'err'); }
}

async function restoreAccountSession() {
  let saved = '';
  try { saved = localStorage.getItem(ACCOUNT_TOKEN_KEY) ?? ''; } catch { saved = ''; }
  if (!saved) return;
  ACCOUNT.token = saved;
  try {
    const me = await accountApi('/api/me');
    ACCOUNT.user = me.user;
    ACCOUNT.rooms = Array.isArray(me.rooms) ? me.rooms : [];
    renderAccount();
    await loadLobby();
  } catch (err) {
    // 只有令牌真失效才清；连不上服务器时保留令牌，改好地址刷新即可恢复
    if (err?.status === 401) {
      saveAccountToken('');
      ACCOUNT.user = null;
      renderAccount();
      return;
    }
    setAccountStatus(`连不上服务器（${err?.message ?? err}），账号令牌已保留`, 'err');
  }
}

async function submitAccount(mode) {
  const username = $('accountUser').value.trim();
  const password = $('accountPass').value;
  if (!username || !password) return setAccountStatus('用户名和密码都要填', 'err');
  setAccountStatus(mode === 'register' ? '正在注册…' : '正在登录…', 'busy');
  try {
    const result = await accountApi(`/api/auth/${mode}`, {
      method: 'POST',
      body: mode === 'register'
        ? { username, password, ...(($('accountDisplay').value.trim()) ? { displayName: $('accountDisplay').value.trim() } : {}) }
        : { username, password },
    });
    saveAccountToken(result.token);
    ACCOUNT.user = result.user;
    ACCOUNT.rooms = [];
    $('accountPass').value = '';
    renderAccount();
    setAccountStatus(mode === 'register' ? '注册成功' : '登录成功', 'ok');
    await loadLobby();
    await refreshMyRooms();
  } catch (err) { setAccountStatus(String(err?.message ?? err), 'err'); }
}

async function logoutAccount() {
  try { await accountApi('/api/auth/logout', { method: 'POST' }); } catch { /* 已失效也清本地 */ }
  saveAccountToken('');
  ACCOUNT.user = null;
  ACCOUNT.rooms = [];
  ACCOUNT.lobby = [];
  renderAccount();
  renderLobby();
  setAccountStatus('已退出账号', 'ok');
}

async function joinLobbyRoom(roomId, asSpectator) {
  try {
    setAccountStatus(asSpectator ? '正在加入观战…' : '正在加入席位…', 'busy');
    const result = await accountApi(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
      method: 'POST',
      body: asSpectator ? { asSpectator: true } : {},
    });
    $('room').value = roomId;
    $('seat').value = result.seat.seatId;
    $('token').value = result.token;
    rememberRoom(roomId);
    hideHall();
    setAccountStatus(`已加入 ${roomId}（${result.seat.seatId}）`, 'ok');
    await connect();
    await refreshMyRooms();
  } catch (err) { setAccountStatus(String(err?.message ?? err), 'err'); }
}

async function createLobbyRoom() {
  const scenarioId = $('lobbyScenario').value;
  const factionId = $('lobbyFaction').value;
  const scenario = QUICKSTART_SCENARIOS.find((s) => s.id === scenarioId) ?? QUICKSTART_SCENARIOS[0];
  if (!factionId) return setAccountStatus('先选择我方势力', 'err');
  try {
    setAccountStatus('正在建房…', 'busy');
    const created = await accountApi('/api/rooms', {
      method: 'POST',
      body: {
        name: ($('lobbyName').value.trim() || `${scenario.name} · ${ACCOUNT.user.displayName}`).slice(0, 128),
        scenarioId,
        unlimitedTurns: $('lobbyUnlimited').checked,
        humanFactions: [factionId],
      },
    });
    const roomId = created.room.roomId;
    const joined = await accountApi(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
      method: 'POST',
      body: { seatId: `seat_${factionId}` },
    });
    $('room').value = roomId;
    $('seat').value = joined.seat.seatId;
    $('token').value = joined.token;
    rememberRoom(roomId);
    hideHall();
    setAccountStatus(`房间已创建并加入：${roomId}`, 'ok');
    await connect();
    await loadLobby();
    await refreshMyRooms();
  } catch (err) { setAccountStatus(String(err?.message ?? err), 'err'); }
}

async function kickLobbyMember(roomId, userId, ban) {
  if (!window.confirm(ban ? '封禁并踢出该玩家？' : '踢出该玩家？')) return;
  try {
    await accountApi(`/api/rooms/${encodeURIComponent(roomId)}/kick`, {
      method: 'POST',
      body: { userId, ban, ...(ban ? { reason: '房主操作' } : {}) },
    });
    setAccountStatus(ban ? '已踢出并封禁' : '已踢出', 'ok');
    await loadLobby();
  } catch (err) { setAccountStatus(String(err?.message ?? err), 'err'); }
}

async function deleteLobbyRoom(roomId) {
  if (!window.confirm(`删除房间 ${roomId}？这是不可撤销操作。`)) return;
  try {
    await accountApi(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' });
    setAccountStatus('房间已删除', 'ok');
    await loadLobby();
    await refreshMyRooms();
  } catch (err) { setAccountStatus(String(err?.message ?? err), 'err'); }
}

async function leaveLobbyRoom(roomId) {
  try {
    await accountApi(`/api/rooms/${encodeURIComponent(roomId)}/leave`, { method: 'POST' });
    setAccountStatus('已离开房间', 'ok');
    await refreshMyRooms();
    await loadLobby();
  } catch (err) { setAccountStatus(String(err?.message ?? err), 'err'); }
}

function initAccount() {
  populateLobbyScenarios();
  renderAccount();
  renderLobby();
  void restoreAccountSession();
}

// ─────────────────────────────────────────────────────────────
// 桌游大厅（先选桌游，再进国战组局）
// ─────────────────────────────────────────────────────────────

const HALL_GAMES = Object.freeze([
  { key: 'guozhan', name: '国战 · 六角棋', seat: '2–12 人', desc: '六角沙盘回合制国战，本页组局', local: true },
  { key: 'uno', name: 'UNO', seat: '2–8 人', desc: '先出完手牌获胜' },
  { key: 'doudizhu', name: '斗地主', seat: '3 人', desc: '叫地主、炸弹王炸' },
  { key: 'exploding', name: '炸弹猫', seat: '2–5 人', desc: '摸到炸弹就出局' },
  { key: 'liarsbar', name: '骗子酒馆', seat: '3–5 人', desc: '吹牛 + 俄罗斯轮盘' },
  { key: 'monopoly', name: '大富翁', seat: '2–4 人', desc: '买地收租、破产出局' },
  { key: 'werewolf', name: '狼人杀', seat: '6–8 人', desc: '夜晚猎杀、白天放逐' },
]);

const HALL_SERVICE_KEY = 'guozhan_board_service_url';
const SERVER_KEY = 'guozhan_server_url';
const HALL = { game: 'guozhan', mode: QUICKSTART_SCENARIOS[0].id };

function initServerField() {
  const el = $('server');
  try {
    const saved = localStorage.getItem(SERVER_KEY);
    if (saved) el.value = saved;
    // 走隧道/域名反代时页面与 API 同源，默认就用当前 origin（本地开发是 http，保持 8788 默认值）
    else if (location.protocol === 'https:') el.value = location.origin;
  } catch { /* 隐私模式 */ }
  const persist = () => {
    try { localStorage.setItem(SERVER_KEY, el.value.trim()); } catch { /* 隐私模式 */ }
    if (ACCOUNT.token && !ACCOUNT.user) void restoreAccountSession();
  };
  el.addEventListener('change', persist);
  el.addEventListener('blur', persist);
}

function boardServiceUrl() {
  try {
    const saved = localStorage.getItem(HALL_SERVICE_KEY);
    if (saved) return saved;
  } catch { /* 隐私模式 */ }
  return `http://${location.hostname || '127.0.0.1'}:8766/`;
}

function renderGameGrid() {
  const grid = $('gameGrid');
  clearNode(grid);
  for (const game of HALL_GAMES) {
    const locked = !game.local && !ACCOUNT.user;
    grid.append(h('button', {
      class: `game-card${game.key === HALL.game ? ' is-selected' : ''}${locked ? ' is-locked' : ''}`,
      type: 'button',
      'aria-disabled': locked ? 'true' : 'false',
      onclick: () => selectHallGame(game.key),
    },
      h('span', { class: 'game-card-top' },
        h('b', { class: 'game-card-name', text: game.name }),
        h('span', { class: 'game-card-tag', text: locked ? '先登录' : game.local ? '本页组局' : '桌游服务' })),
      h('span', { class: 'game-card-desc', text: game.desc }),
      h('span', { class: 'game-card-seat', text: game.seat })));
  }
}

function selectHallGame(key) {
  const game = HALL_GAMES.find((g) => g.key === key);
  if (!game) return;
  if (key !== 'guozhan' && !ACCOUNT.user) {
    setAccountStatus('先登录，才能进入其余桌游服务。', 'err');
    $('accountUser').focus();
    return;
  }
  HALL.game = key;
  $('hallGuozhan').hidden = key !== 'guozhan';
  $('hallOther').hidden = key === 'guozhan';
  if (key !== 'guozhan') {
    $('hallOtherName').textContent = game.name;
    $('hallOtherNote').textContent = `${game.desc}。服务没起来时先运行 npm run start:board（scripts/start-board-games.mjs），再带回本页地址。`;
    $('hallServiceUrl').value = boardServiceUrl();
  }
  renderGameGrid();
}

function renderModeCards() {
  const box = $('lobbyModes');
  clearNode(box);
  for (const scenario of QUICKSTART_SCENARIOS) {
    box.append(h('button', {
      class: `mode-card${scenario.id === HALL.mode ? ' is-selected' : ''}`,
      type: 'button',
      onclick: () => selectLobbyMode(scenario.id),
    },
      h('b', { text: scenario.name }),
      h('span', { class: 'mode-card-seat', text: `${scenario.factions.length} 势力` })));
  }
}

function selectLobbyMode(id) {
  HALL.mode = id;
  const sel = $('lobbyScenario');
  sel.value = id;
  sel.dispatchEvent(new Event('change'));
  renderModeCards();
}

function showHall() {
  $('hall').classList.remove('is-hidden');
  renderGameGrid();
  renderModeCards();
  $('hallResume').hidden = !S.connected;
  if (ACCOUNT.user) void loadLobby();
}

function hideHall() {
  $('hall').classList.add('is-hidden');
}

function initHall() {
  renderGameGrid();
  renderModeCards();
  selectHallGame(HALL.game);
  $('hallServiceUrl').value = boardServiceUrl();
}

$('accountToggle').addEventListener('click', () => showHall());
$('hallResume').addEventListener('click', () => hideHall());
$('hallServiceOpen').addEventListener('click', () => {
  let url = $('hallServiceUrl').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  window.open(url, '_blank', 'noopener');
});
$('hallServiceUrl').addEventListener('change', () => {
  try { localStorage.setItem(HALL_SERVICE_KEY, $('hallServiceUrl').value.trim()); } catch { /* 隐私模式 */ }
});
$('accountLogin').addEventListener('click', () => void submitAccount('login'));
$('accountRegister').addEventListener('click', () => void submitAccount('register'));
$('accountLogout').addEventListener('click', () => void logoutAccount());
$('lobbyRefresh').addEventListener('click', () => void loadLobby());
$('lobbyCreate').addEventListener('click', () => void createLobbyRoom());
// ─────────────────────────────────────────────────────────────
// 绑定
// ─────────────────────────────────────────────────────────────

$('connectForm').addEventListener('submit', (event) => {
  event.preventDefault();
  void connect();
});
$('disconnect').addEventListener('click', () => disconnect());
$('randomSeed').addEventListener('click', () => {
  $('seed').value = randomSeedString();
  setQuickstartStatus('已生成新种子；复制它可重开同一张地图', '');
});
$('quickstartGo').addEventListener('click', () => void quickstart());
initQuickstartScenarios();
$('connectToggle').addEventListener('click', () => {
  const drawer = $('connectForm');
  const collapsed = drawer.classList.toggle('is-collapsed');
  $('connectToggle').textContent = collapsed ? '连接设置' : '收起设置';
});
$('submit').addEventListener('click', () => void submitOrders());
$('lock').addEventListener('click', () => void lockTurn());
$('advice').addEventListener('click', () => void requestAdvice());
$('battleHudClose').addEventListener('click', () => skipBattlePlayback());
$('battleHudSkip').addEventListener('click', () => skipBattlePlayback());
$('battleHudLocate').addEventListener('click', () => {
  if (S.hudBattle?.regionId) {
    selectRegion(S.hudBattle.regionId);
    map.focusRegion(S.hudBattle.regionId);
  }
});
$('clear').addEventListener('click', () => {
  S.queue = [];
  map.setQueue([]);
  renderQueue();
  renderActions();
});
$('zoomIn').addEventListener('click', () => map.zoomBy(1.25));
$('zoomOut').addEventListener('click', () => map.zoomBy(0.8));
$('zoomReset').addEventListener('click', () => map.resetView());
$('viewMap').addEventListener('click', () => setView('map'));
$('viewText').addEventListener('click', () => setView('text'));
$('fullscreen').addEventListener('click', async () => {
  const shell = $('mapShell');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await shell.requestFullscreen?.();
  } catch {
    toast('浏览器拒绝进入全屏', 'error');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (S.pair) {
    S.pair = null;
    map.setPair(null);
    renderActions();
  } else if (S.selected) {
    deselectRegion();
  }
});

window.addEventListener('pagehide', () => {
  S.connected = false;
  closeStream();
});

// 初始态
initServerField();
initAccount();
initHall();
setView('map');
renderQueue();
renderDetail();
renderActions();
renderBattleReport();
$('mapEmpty').classList.remove('is-hidden');
