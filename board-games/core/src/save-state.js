// save-state.js — 引擎无关的「对局存档 / 恢复」核心层。
//
// 为什么不能直接用 snapshot()/viewFor()：
//   这两个是**按座位脱敏的视图**（例如 uno.js 把所有人的 hand 抹掉只留 counts，
//   doudizhu 只公布底牌张数），拿来存档会丢牌堆顺序和所有人手牌，牌局一恢复就废了。
//   存档要的是引擎的**完整内部状态**，所以这里直接序列化引擎实例的自有可枚举字段。
//
// ⚠️ 安全边界（客户端接线时必须原样遵守，不要放宽）：
//   1. 快照 = 上帝视角：包含所有玩家的手牌 / 身份（狼人杀 role）/ 底牌 / 牌堆顺序 /
//      骗子酒馆左轮弹仓位置。它**只能留在本地**（localStorage / 本地文件），
//      绝不上送服务端、绝不写进 chatLog / onLog / 任何日志、埋点或分享链接。
//   2. 凭据类字段名（token / secret / cookie / authorization / password / apikey /
//      sessionid / signature / bearer 等）在 capture 阶段就被剔除，永远不会进快照；
//      restore 阶段只认白名单字段，即使有人在 payload 里塞 token，也不会被写进
//      Host 或引擎 —— restoreRoom 不接受、不写入任何令牌字段。
//   3. restoreRoom 只灌状态：不建立传输、不启动 idle / bot / llm 定时器，
//      调用方需要 UI 刷新的话自己再调 host.broadcastGame()。
//
// 失败约定（一律抛 GameError，且**抛错前不写任何字段**，绝不会半恢复）：
//   SAVE_VERSION     快照版本与 SAVE_VERSION 不一致
//   SAVE_GAME_KEY    快照的游戏与目标 Host 的 gameKey 不一致
//   SAVE_INVALID     payload 结构非法（缺段、座位越界、类型不对、步数对不上……）
//   SAVE_NOT_PLAIN   payload 里出现不可序列化的值（函数 / Symbol / undefined /
//                    NaN / Infinity / Date / Map / Set / 类实例 / 循环引用）
//   SAVE_UNSUPPORTED 当前引擎的内部状态无法用通用快照表达（如国战的 session 类实例）

import { GameError } from './game-error.js';
import { GAMES } from './games.js';

/** 快照格式版本：字段语义一旦变更加 1，客户端可据此判定旧档是否可用。 */
export const SAVE_VERSION = 1;

// 凭据语义的字段名：命中即从快照剔除 / 恢复时忽略。
const SECRET_KEY_RE = /token|secret|cookie|authorization|password|passwd|credential|api[-_]?key|access[-_]?key|session[-_]?id|private[-_]?key|signature|bearer/i;

const CAPTURE_CODE = 'SAVE_UNSUPPORTED';
const RESTORE_CODE = 'SAVE_NOT_PLAIN';

function fail(code, message) {
  throw new GameError(code, message);
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------------------
// 通用「纯数据」深拷贝
// ---------------------------------------------------------------------------
// 规则（capture 与 restore 共用一套结构校验，只是报错码不同）：
//   · 允许：有限数字 / 字符串 / 布尔 / null / 数组 / 普通对象
//   · 对象属性值为函数或 Symbol → 剔除（引擎的 this.random 就靠这条排掉，
//     恢复时由 restoreRoom 用 host.gameRandom 重新注入）
//   · 对象属性值为 undefined → 报错（JSON.stringify 会把它悄悄变成 null/丢键，
//     属于「产出 undefined 垃圾」，这里选择显式失败）
//   · 数组里出现函数 / Symbol / undefined → 报错（剔除会让索引错位）
//   · NaN / Infinity / Date / RegExp / Map / Set / bigint / 类实例 → 报错
//   · 循环引用 → 报错
//   · 属性名命中 SECRET_KEY_RE → 剔除（凭据永不入档）
function toPlain(value, path, capture, seen) {
  const code = capture ? CAPTURE_CODE : RESTORE_CODE;
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (Number.isFinite(value)) return value;
    return fail(code, `${path} 是 ${value}，无法安全存档`);
  }
  if (type === 'undefined') return fail(code, `${path} 是 undefined，无法安全存档`);
  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    return fail(code, `${path} 是 ${type}，无法安全存档`);
  }
  if (type !== 'object') return fail(code, `${path} 类型 ${type} 无法安全存档`);
  if (seen.has(value)) return fail(code, `${path} 存在循环引用，无法存档`);
  if (Array.isArray(value)) {
    seen.add(value);
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      // 数组元素不能「剔除」，只能报错，否则下标会整体错位。
      if (item === undefined) return fail(code, `${path}[${i}] 是 undefined，无法安全存档`);
      if (typeof item === 'function' || typeof item === 'symbol') {
        return fail(code, `${path}[${i}] 是 ${typeof item}，无法安全存档`);
      }
      out.push(toPlain(item, `${path}[${i}]`, capture, seen));
    }
    seen.delete(value);
    return out;
  }
  if (value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set) {
    return fail(code, `${path} 是 ${value.constructor ? value.constructor.name : '特殊对象'}，通用快照只支持数组与普通对象`);
  }
  if (!isPlainObject(value)) {
    const name = value.constructor && value.constructor.name ? value.constructor.name : '未知类';
    return fail(code, `${path} 是类实例（${name}），通用快照不支持，需要该引擎提供专用序列化`);
  }
  seen.add(value);
  const out = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (SECRET_KEY_RE.test(key)) continue; // 凭据字段：永不入档，也不接受回灌
    if (item === undefined) return fail(code, `${path}.${key} 是 undefined，无法安全存档`);
    if (typeof item === 'function' || typeof item === 'symbol') {
      // 存档侧剔除（引擎的 random 就靠这条排掉，恢复时重新注入）；
      // 恢复侧绝不接受 —— 合法快照里不该有函数，出现即说明 payload 被动过手脚。
      if (!capture) return fail(code, `${path}.${key} 含 ${typeof item}，非法快照`);
      continue;
    }
    out[key] = toPlain(item, `${path}.${key}`, capture, seen);
  }
  seen.delete(value);
  return out;
}

/**
 * 把「引擎状态容器」的自有可枚举字段序列化成纯数据。
 * capture=true  → 存档：顶层实例是 class 实例，所以自己遍历（不交给 toPlain 的
 *                 原型校验），并把函数/Symbol 属性剔除（引擎的 this.random 靠这条排掉，
 *                 恢复时由 restoreRoom 用 host.gameRandom 重新注入）。
 * capture=false → 恢复：payload.game 是 JSON 来的普通对象，同样遍历，但函数/Symbol
 *                 一律拒绝 —— 合法快照里不该有它们，出现即说明 payload 被动过手脚。
 * 注意：只取字符串键，Symbol 键按规则剔除；如果哪天引擎改用 Symbol 存关键状态，
 * 通用快照会静默丢数据 —— 届时应给该引擎写专用序列化器（见交付报告的遗留风险）。
 */
function serializeGameFields(obj, capture) {
  const out = {};
  for (const key of Object.keys(obj)) {
    if (SECRET_KEY_RE.test(key)) continue; // 凭据字段：永不入档，也不接受回灌（如国战 botToken）
    const value = obj[key];
    if (typeof value === 'function' || typeof value === 'symbol') {
      if (!capture) fail(RESTORE_CODE, `快照的 game.${key} 含 ${typeof value}，非法快照`);
      continue;
    }
    out[key] = toPlain(value, `game.${key}`, capture, new Set()); // undefined / NaN 等在这里报错
  }
  return out;
}

// ---------------------------------------------------------------------------
// 字段校验小工具（restore 前置校验，保证「要么全改要么全不改」）
// ---------------------------------------------------------------------------
function needInteger(v, name, min) {
  if (!Number.isInteger(v) || v < min) fail('SAVE_INVALID', `${name} 应为不小于 ${min} 的整数，实际 ${JSON.stringify(v)}`);
  return v;
}

function needSeat(v, count, name, { nullable = false } = {}) {
  if (v === null || v === undefined) {
    if (nullable) return null;
    fail('SAVE_INVALID', `${name} 不能为空`);
  }
  if (!Number.isInteger(v) || v < 0 || v >= count) {
    fail('SAVE_INVALID', `${name} 座位号 ${JSON.stringify(v)} 越界（玩家数 ${count}）`);
  }
  return v;
}

function needSeatList(v, count, name) {
  if (!Array.isArray(v)) fail('SAVE_INVALID', `${name} 应为座位号数组`);
  return v.map((s, i) => needSeat(s, count, `${name}[${i}]`));
}

function needPlayerNames(v, count) {
  if (!Array.isArray(v)) fail('SAVE_INVALID', 'playerNames 应为字符串数组');
  if (v.length !== count) fail('SAVE_INVALID', `playerNames 有 ${v.length} 个，但快照里引擎的 players 有 ${count} 个`);
  return v.map((n, i) => {
    if (typeof n !== 'string') fail('SAVE_INVALID', `playerNames[${i}] 不是字符串`);
    return n.slice(0, 20);
  });
}

function needChatLog(v) {
  if (!Array.isArray(v)) fail('SAVE_INVALID', 'chatLog 应为数组');
  const out = [];
  for (const line of v) {
    if (!isPlainObject(line) || typeof line.from !== 'string' || typeof line.text !== 'string') {
      fail('SAVE_INVALID', 'chatLog 的元素必须是 {from, text} 字符串对象');
    }
    out.push({ from: line.from.slice(0, 40), text: line.text.slice(0, 200) });
  }
  return out.slice(-24); // 与 Host.broadcastChat 的滚动窗口保持一致
}

function needChatBudget(v, count) {
  if (!Array.isArray(v)) fail('SAVE_INVALID', 'chatBudget 应为 [座位, 次数] 数组');
  const out = [];
  for (const pair of v) {
    if (!Array.isArray(pair) || pair.length !== 2) fail('SAVE_INVALID', 'chatBudget 的元素必须是 [座位, 次数]');
    out.push([needSeat(pair[0], count, 'chatBudget 座位'), needInteger(pair[1], 'chatBudget 次数', 0)]);
  }
  return out;
}

/** 存档侧的 Map 归一化：座位越界或非整数一律剔除，保证写出的档一定能灌回来。 */
function sanitizeChatBudget(map, count) {
  const out = [];
  if (!map || typeof map.entries !== 'function') return out;
  for (const [seat, n] of map.entries()) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= count) continue;
    if (!Number.isInteger(n) || n < 0) continue;
    out.push([seat, n]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 抓取整个房间的完整存档。
 *
 * 返回（可直接 JSON.stringify 的纯数据；失败抛 GameError）：
 *   {
 *     v: SAVE_VERSION,
 *     gameKey, gameName,                 // gameName 仅用于展示，恢复时忽略
 *     capturedAt: <毫秒时间戳>,
 *     phase: <引擎阶段，仅展示>,
 *     game: { 引擎全部自有可枚举字段（已剔除 random / 凭据字段） },
 *     host: {
 *       playerNames, localSeat, ownerSeat, nextGuestId,
 *       botSeats: number[], llmSeats: number[],
 *       chatLog: {from,text}[], chatBudget: [[seat,count]],
 *       actionSeq, matchId, matchStartedAt, matchResultSent, remote
 *     }
 *   }
 *
 * host.guests（网络传输句柄）不在存档内 —— 传输对象含函数/解码器，
 * 恢复后所有远端连接需要重新 join；离线/蓝牙模式本来就没有 guests。
 */
export function captureRoom(host) {
  if (!host || typeof host !== 'object' || !host.game || typeof host.game !== 'object') {
    fail('SAVE_INVALID', 'captureRoom 需要一个带 game 的 Host 实例');
  }
  const game = serializeGameFields(host.game, true);
  const players = Array.isArray(game.players) ? game.players : [];
  const count = players.length;
  const phase = typeof game.phase === 'string' ? game.phase : null;
  const gameKey = host.gameKey;
  const info = GAMES[gameKey];
  return {
    v: SAVE_VERSION,
    gameKey,
    gameName: info && info.name ? info.name : String(gameKey),
    capturedAt: Date.now(),
    phase,
    game,
    host: {
      // 座位名字：引擎状态里也有一份，这里冗余存一份给「继续上局」卡片展示用，
      // 恢复时只做长度一致性校验，真正生效的仍是 game.players。
      playerNames: players.map((p, i) => String(p && p.name != null ? p.name : `玩家${i}`)),
      localSeat: host.localSeat == null ? null : needSeat(host.localSeat, count, 'localSeat', { nullable: true }),
      ownerSeat: host.ownerSeat == null ? null : needSeat(host.ownerSeat, count, 'ownerSeat', { nullable: true }),
      nextGuestId: Number.isInteger(host.nextGuestId) && host.nextGuestId >= 1 ? host.nextGuestId : 1,
      botSeats: needSeatList(Array.from(host.botSeats || []), count, 'botSeats'),
      llmSeats: needSeatList(Array.from(host.llmSeats || []), count, 'llmSeats'),
      chatLog: Array.isArray(host.chatLog) ? needChatLog(host.chatLog) : [],
      chatBudget: sanitizeChatBudget(host.chatBudget, count),
      actionSeq: Number.isInteger(host._actionSeq) && host._actionSeq >= 0 ? host._actionSeq : 0,
      matchId: typeof host._matchId === 'string' ? host._matchId : null,
      matchStartedAt: Number.isFinite(host._matchStartedAt) ? host._matchStartedAt : 0,
      matchResultSent: host._matchResultSent === true,
      // 仅记录，恢复时不写回：模式由调用方构造 Host 时决定。
      remote: host.remote === true,
    },
  };
}

/**
 * 把存档灌回一个**已存在**的同 gameKey Host。
 *
 * 步骤：先全量校验（版本 → gameKey → 结构 → 座位越界 → 纯数据），全部通过后才落地，
 * 因此任何失败（抛 GameError）都保证 Host 保持原状，不存在半恢复。
 *
 * 落地内容：
 *   · 引擎：Object.assign 把快照字段写回**同一个实例**（原型与方法完整保留，
 *     所以 snapshot/viewFor/applyAction 全都还在），并清掉实例上快照里没有的函数字段
 *     （构造时注入的 random 闭包 / 旧回调），快照里没有的数据字段保留默认值。
 *   · random 重新注入：沿用 host.gameRandom，没有则 Math.random（快照里不该有函数）。
 *   · Host 层：只按白名单写回，Set/Map 字段（botSeats/llmSeats/chatBudget）重建，
 *     并复位 _llmLastKey / _botStall 这类运行时缓存。
 *   · guests / 传输 / 定时器 / 凭据字段：一概不碰。
 *
 * 成功返回 { ok: true, gameKey, phase, seats, playerNames, capturedAt }。
 */
export function restoreRoom(host, payload) {
  if (!host || typeof host !== 'object' || !host.game || typeof host.game !== 'object') {
    fail('SAVE_INVALID', 'restoreRoom 需要一个已存在的 Host 实例');
  }
  if (!isPlainObject(payload)) fail('SAVE_INVALID', '快照必须是普通对象（JSON.parse 的结果）');
  if (payload.v !== SAVE_VERSION) {
    fail('SAVE_VERSION', `快照版本 ${JSON.stringify(payload.v)} 与当前 SAVE_VERSION=${SAVE_VERSION} 不匹配`);
  }
  if (payload.gameKey !== host.gameKey) {
    fail('SAVE_GAME_KEY', `快照是 ${JSON.stringify(payload.gameKey)}，目标房间是 ${JSON.stringify(host.gameKey)}`);
  }
  if (!isPlainObject(payload.game)) fail('SAVE_INVALID', '快照缺少 game 段');
  if (!isPlainObject(payload.host)) fail('SAVE_INVALID', '快照缺少 host 段');

  // —— 纯数据校验 + 干净拷贝（拷贝后 payload 与 Host 彻底脱钩，
  //    调用方之后再改 payload 也不会影响已恢复的对局）——
  const cleanGame = serializeGameFields(payload.game, false);
  const players = cleanGame.players;
  if (!Array.isArray(players) || players.length === 0) fail('SAVE_INVALID', '快照的 game.players 非法');
  const count = players.length;

  const h = payload.host;
  const localSeat = h.localSeat === null || h.localSeat === undefined ? null : needSeat(h.localSeat, count, 'host.localSeat');
  const ownerSeat = h.ownerSeat === null || h.ownerSeat === undefined ? null : needSeat(h.ownerSeat, count, 'host.ownerSeat');
  const nextGuestId = needInteger(h.nextGuestId, 'host.nextGuestId', 1);
  const botSeats = needSeatList(h.botSeats, count, 'host.botSeats');
  const llmSeats = needSeatList(h.llmSeats, count, 'host.llmSeats');
  const playerNames = needPlayerNames(h.playerNames, count);
  const chatLog = needChatLog(h.chatLog);
  const chatBudget = needChatBudget(h.chatBudget, count);
  const actionSeq = needInteger(h.actionSeq, 'host.actionSeq', 0);
  const matchStartedAt = Number.isFinite(h.matchStartedAt) && h.matchStartedAt >= 0 ? h.matchStartedAt : 0;
  if (typeof cleanGame.phase !== 'string') fail('SAVE_INVALID', '快照缺少引擎 phase 字段');
  if (h.matchId != null && typeof h.matchId !== 'string') fail('SAVE_INVALID', 'host.matchId 应为字符串或 null');
  const matchId = h.matchId == null ? null : h.matchId.slice(0, 64);

  // —— 校验全部通过，从这里开始才真正写 Host ——
  const game = host.game;
  // 只清掉目标实例上「快照里没有、且值是函数」的自有字段 —— 典型是构造时注入的
  // random 闭包和旧的回调句柄，留着会变成指向废对象的僵尸引用。
  // 快照里缺的**数据**字段一律保留（沿用目标引擎构造函数给的默认值）：这样引擎将来
  // 加了新字段，旧存档灌进来也不会被删成 undefined 直接把对局打崩。
  for (const key of Object.keys(game)) {
    if (!(key in cleanGame) && typeof game[key] === 'function') delete game[key];
  }
  Object.assign(game, cleanGame); // 保留原型 → 方法一个不少
  game.random = typeof host.gameRandom === 'function' ? host.gameRandom : Math.random;

  host.localSeat = localSeat;
  host.ownerSeat = ownerSeat;
  host.nextGuestId = nextGuestId;
  host.botSeats = new Set(botSeats);
  host.llmSeats = new Set(llmSeats);
  host.chatLog = chatLog;
  host.chatBudget = new Map(chatBudget);
  host._actionSeq = actionSeq;
  host._matchId = matchId;
  host._matchStartedAt = matchStartedAt;
  host._matchResultSent = h.matchResultSent === true;
  // 运行时缓存复位，避免恢复后第一帧被旧 key 卡住（不改动任何既有方法的语义）。
  host._llmLastKey = '';
  host._botStall = { key: '', count: 0 };

  return {
    ok: true,
    gameKey: host.gameKey,
    phase: game.phase,
    seats: count,
    playerNames,
    capturedAt: Number.isFinite(payload.capturedAt) ? payload.capturedAt : null,
  };
}
