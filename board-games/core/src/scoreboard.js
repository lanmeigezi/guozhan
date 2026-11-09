// scoreboard.js — cross-game scoring, match results and leaderboard aggregation.
//
// Formula (see SCORE_RULES / SCORE_FORMULA):
//   win points = base × size × duration × human × result
// - base: rules/decision complexity and a typical round length (parMin)
// - size: more seats = harder to win and more social effort
// - duration: longer actual play earns more, capped so idling cannot farm
// - human: AI/LLM seats count toward table size but not as human opponents
// - result: win 1.0 / draw 0.4 / loss 0.1 (participation keeps casual users in)
//
// The module is pure: the Host generates a matchId, the server/browser persists
// the returned events. One event = one human seat = one share of one match.

export const SCORE_VERSION = 1;

export const SCORE_RULES = {
  uno: { name: 'UNO', base: 50, parMin: 12, min: 2, max: 8 },
  liarsbar: { name: '骗子酒馆', base: 55, parMin: 10, min: 3, max: 5 },
  doudizhu: { name: '斗地主', base: 60, parMin: 12, min: 3, max: 3 },
  exploding: { name: '炸弹猫', base: 70, parMin: 15, min: 2, max: 5 },
  werewolf: { name: '狼人杀', base: 90, parMin: 25, min: 6, max: 8 },
  monopoly: { name: '大富翁', base: 110, parMin: 35, min: 2, max: 4 },
  guozhan: { name: '国战 · 六角棋', base: 120, parMin: 40, min: 2, max: 4 },
};

export const SCORE_FORMULA = {
  size: '1 + 0.28 × (人数 - 2)',
  duration: 'clamp(0.6, 1.6, 0.55 + 0.45 × √(实际分钟 / 参考分钟))',
  human: '0.75 + 0.25 × (除自己外真人座位 / (人数 - 1))',
  result: { win: 1, draw: 0.4, loss: 0.1 },
};

export const SCORE_TIERS = [
  { name: '新手', min: 0 },
  { name: '青铜', min: 150 },
  { name: '白银', min: 500 },
  { name: '黄金', min: 1200 },
  { name: '铂金', min: 2500 },
  { name: '钻石', min: 5000 },
  { name: '王者', min: 10000 },
];

const clamp = (lo, hi, v) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;

export function tierFor(points) {
  const total = Math.max(0, Number(points) || 0);
  let idx = 0;
  for (let i = 0; i < SCORE_TIERS.length; i++) if (total >= SCORE_TIERS[i].min) idx = i;
  const cur = SCORE_TIERS[idx];
  const next = SCORE_TIERS[idx + 1] || null;
  const span = next ? next.min - cur.min : 0;
  return {
    name: cur.name,
    min: cur.min,
    next: next ? next.name : null,
    nextMin: next ? next.min : null,
    toNext: next ? Math.max(0, next.min - total) : 0,
    progress: next ? clamp(0, 1, (total - cur.min) / span) : 1,
  };
}

/** Seats that share the win. Team games return the whole winning side. */
export function winnersFor(gameKey, game) {
  if (!game || !Array.isArray(game.players)) return [];
  const seatCount = game.players.length;
  const valid = (seat) => Number.isInteger(seat) && seat >= 0 && seat < seatCount;
  if (gameKey === 'doudizhu') {
    const winner = game.winner;
    if (!valid(winner)) return [];
    const landlord = game.landlord;
    if (landlord == null || winner === landlord) return [winner];
    return game.players.map((p) => p.id).filter((id) => id !== landlord);
  }
  if (gameKey === 'werewolf' && game.winnerTeam) {
    return game.players
      .filter((p) => (game.winnerTeam === 'wolves' ? p.role === 'wolf' : p.role !== 'wolf'))
      .map((p) => p.id);
  }
  if (valid(game.winner)) return [game.winner];
  return [];
}

/**
 * Score one finished match.
 * @param {object} input
 * @param {string} input.gameKey
 * @param {object} input.game       authoritative game instance
 * @param {number} input.startedAt  epoch ms
 * @param {number} input.endedAt    epoch ms
 * @param {string} [input.matchId]
 * @param {Array<{seat:number,name:string,kind:'human'|'bot'|'llm',deviceId?:string}>} [input.players]
 * @param {'online'|'local'} [input.mode]
 */
export function scoreMatch({ gameKey, game, startedAt, endedAt, matchId, players, mode = 'local' } = {}) {
  const rule = SCORE_RULES[gameKey];
  if (!rule || !game || !Array.isArray(game.players) || !game.players.length) return null;
  const end = Number.isFinite(endedAt) ? endedAt : Date.now();
  const start = Number.isFinite(startedAt) && startedAt <= end ? startedAt : end;
  const durationMs = Math.max(0, end - start);
  const durationMin = Math.max(0.1, durationMs / 60000);
  const n = game.players.length;
  const winners = winnersFor(gameKey, game);
  const winnerSet = new Set(winners);
  const sizeFactor = round2(1 + 0.28 * Math.max(0, n - 2));
  const durationFactor = round2(clamp(0.6, 1.6, 0.55 + 0.45 * Math.sqrt(durationMin / rule.parMin)));

  const infoBySeat = new Map();
  for (const p of players || []) {
    if (p && Number.isInteger(p.seat)) infoBySeat.set(p.seat, p);
  }
  const rows = game.players.map((p, seat) => {
    const info = infoBySeat.get(seat) || {};
    return {
      seat,
      name: String(info.name || p.name || `玩家${seat + 1}`).slice(0, 20),
      kind: info.kind === 'bot' || info.kind === 'llm' ? info.kind : 'human',
      deviceId: info.deviceId || null,
    };
  });
  const humanCount = rows.filter((p) => p.kind === 'human').length;
  const humanFactor = round2(0.75 + 0.25 * (Math.max(0, humanCount - 1) / Math.max(1, n - 1)));
  const hasWinners = winners.length > 0;

  const out = rows.map((p) => {
    const outcome = !hasWinners ? 'draw' : (winnerSet.has(p.seat) ? 'win' : 'loss');
    const resultFactor = outcome === 'win' ? SCORE_FORMULA.result.win : outcome === 'draw' ? SCORE_FORMULA.result.draw : SCORE_FORMULA.result.loss;
    const points = Math.max(1, Math.round(rule.base * sizeFactor * durationFactor * humanFactor * resultFactor));
    return {
      ...p,
      outcome,
      points,
      detail: {
        base: rule.base,
        parMin: rule.parMin,
        sizeFactor,
        durationFactor,
        humanFactor,
        resultFactor,
        durationSec: Math.round(durationMs / 1000),
        playerCount: n,
        humanCount,
      },
    };
  });

  return {
    v: SCORE_VERSION,
    matchId: matchId || `m-${end.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    game: gameKey,
    gameName: rule.name,
    mode,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(end).toISOString(),
    durationSec: Math.round(durationMs / 1000),
    playerCount: n,
    humanCount,
    winnerSeats: winners,
    winnerNames: winners.map((s) => rows[s] ? rows[s].name : `座位${s}`),
    players: out,
  };
}

function rangeCutoff(range, now) {
  const d = new Date(now);
  if (range === 'today') {
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (range === 'week') {
    d.setHours(0, 0, 0, 0);
    const day = (d.getDay() + 6) % 7; // Monday = 0
    return d.getTime() - day * 86400000;
  }
  return 0;
}

/**
 * Aggregate persisted score events into leaderboard rows.
 * Events are deduped by id, filtered by range, then totalled per playerKey.
 */
export function aggregateScoreEvents(events, { range = 'all', now = Date.now() } = {}) {
  const cutoff = rangeCutoff(range, now);
  const seen = new Set();
  const map = new Map();
  for (const ev of events || []) {
    if (!ev || ev.v !== SCORE_VERSION || !ev.playerKey || !ev.id) continue;
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    const at = Date.parse(ev.endedAt || '');
    if (!Number.isFinite(at) || at < cutoff) continue;
    let row = map.get(ev.playerKey);
    if (!row) {
      row = { key: ev.playerKey, name: ev.name || '玩家', points: 0, wins: 0, losses: 0, draws: 0, plays: 0, games: {}, lastPlayedAt: null };
      map.set(ev.playerKey, row);
    }
    if (ev.name) row.name = String(ev.name).slice(0, 20);
    const points = Math.max(0, Math.round(Number(ev.points) || 0));
    row.points += points;
    row.plays += 1;
    if (ev.outcome === 'win') row.wins += 1;
    else if (ev.outcome === 'draw') row.draws += 1;
    else row.losses += 1;
    const g = row.games[ev.game] || (row.games[ev.game] = { plays: 0, wins: 0, points: 0 });
    g.plays += 1;
    g.points += points;
    if (ev.outcome === 'win') g.wins += 1;
    if (!row.lastPlayedAt || at > Date.parse(row.lastPlayedAt)) row.lastPlayedAt = ev.endedAt;
  }
  const rows = [...map.values()].map((r) => ({ ...r, winRate: r.plays ? r.wins / r.plays : 0 }));
  rows.sort((a, b) => b.points - a.points || b.wins - a.wins || b.plays - a.plays || a.name.localeCompare(b.name));
  return rows;
}

/** Convert one score result into persisted event rows (human seats only). */
export function scoreEventsFromResult(result) {
  if (!result || !Array.isArray(result.players)) return [];
  const events = [];
  for (const p of result.players) {
    if (p.kind !== 'human') continue;
    const playerKey = p.playerKey || p.deviceId || `name:${p.name}`;
    events.push({
      v: SCORE_VERSION,
      id: `${result.matchId}:${p.seat}`,
      playerKey: String(playerKey),
      name: p.name,
      game: result.game,
      endedAt: result.endedAt,
      durationSec: result.durationSec,
      outcome: p.outcome,
      points: p.points,
      players: result.playerCount,
      humans: result.humanCount,
    });
  }
  return events;
}
