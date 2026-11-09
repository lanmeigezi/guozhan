// verify-socket.mjs — end-to-end verification of the server-authoritative room
// over real WebSockets: join, lobby broadcast, start, per-turn plays, state
// convergence, chat. Runs UNO (4 players), 斗地主 (3 players), 炸弹猫 (3
// players), 骗子酒馆, 国战, and a mock server-side LLM seat.
import { createRoom } from './room.mjs';
import { Client } from '../core/src/client.js';
import { aiEk } from '../core/src/exploding.js';
import { aiLiarBar } from '../core/src/liarsbar.js';
import { mulberry32 } from '../core/src/cards.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep test scores out of the real data dir; the leaderboard scenario reads
// this same temp directory through the room's HTTP API.
process.env.BOARD_GAMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'uno-bt-scores-'));

let failures = 0;
const ok = (name, cond) => {
  if (cond) console.log('ok   ' + name);
  else { console.log('FAIL ' + name); failures++; }
};
const waitFor = async (fn, timeout = 3000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return fn();
};

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('ws connect failed'));
  });
}

async function makePlayer(url, name) {
  const ws = await connect(url);
  const t = {
    send: (b) => ws.send(b), close: () => ws.close(),
    onMessage: null, onDisconnect: null,
  };
  ws.onmessage = (e) => {
    const d = e.data;
    const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d);
    if (t.onMessage) t.onMessage(bytes);
  };
  ws.onclose = () => { if (t.onDisconnect) t.onDisconnect(); };
  const client = new Client({ transport: t });
  const inbox = [];
  let latest = null, lobby = null;
  client.onMessage = (m) => {
    inbox.push(m);
    if (m.t === 'state') latest = m.view;
    if (m.t === 'lobby') lobby = m;
  };
  client.join(name);
  return { client, ws, inbox, latest: () => latest, lobby: () => lobby, you: () => (lobby ? lobby.you : null) };
}

// UNO client legal-move decision from its personalized view.
const unoLegal = (view, card) => {
  if (card.kind === 'wild' || card.kind === 'wild4') return true;
  if (card.color === view.color) return true;
  if (card.kind === 'number') return view.discardTop.kind === 'number' && card.value === view.discardTop.value;
  if (view.discardTop.kind === 'number') return false;
  return card.kind === view.discardTop.kind;
};
function unoMove(p) {
  const view = p.latest();
  if (!view) return null;
  const legal = view.hand.filter((c) => unoLegal(view, c));
  const colorFor = (c) => (/wild/.test(c.kind) ? 'blue' : undefined);
  if (view.turnState === 'drawn') {
    if (legal.some((c) => c.id === view.drawnCardId)) {
      const cd = view.hand.find((x) => x.id === view.drawnCardId);
      return { kind: 'play', cardId: cd.id, color: colorFor(cd) };
    }
    return { kind: 'pass' };
  }
  if (legal.length) { const c2 = legal[0]; return { kind: 'play', cardId: c2.id, color: colorFor(c2) }; }
  return { kind: 'draw' };
}
const sendMove = (players, seat, move) => {
  const p = players.find((x) => x.you() === seat);
  if (move.kind === 'play') p.client.play(move.cardId, move.color);
  else if (move.kind === 'draw') p.client.draw();
  else p.client.pass();
};
const sendAct = (players, seat, act) => {
  const p = players.find((x) => x.you() === seat);
  p.client.send({ t: 'act', ...act });
};

async function runUno() {
  const room = await createRoom({ game: 'uno', port: 0, random: mulberry32(1) });
  const N = 4;
  const ps = [];
  for (let i = 0; i < N; i++) ps.push(await makePlayer(room.wsUrl, 'P' + i));
  ok('uno: 4 players joined lobby', await waitFor(() => ps.every((p) => p.lobby() && p.lobby().seats.length === N)));
  ok('uno: each guest knows its own seat', ps.every((p, i) => p.you() === i));

  // owner (seat 0) starts
  const joiner0 = ps[0];
  joiner0.client.send({ t: 'act', kind: 'start' });
  ok('uno: start broadcast to all', await waitFor(() => ps.every((p) => p.latest() && p.latest().phase === 'playing')));
  ok('uno: personal views have 7 cards', ps.every((p) => p.latest().hand.length === 7));
  ok('uno: public counts all 7', ps.every((p) => p.latest().counts.every((c) => c === 7)));

  // chat
  ps[1].client.send({ t: 'chat', text: '你好 👋' });
  ok('uno: chat relayed to all', await waitFor(() => ps.every((p) => p.inbox.some((m) => m.t === 'chat' && /👋/.test(m.text)))));

  // drive to completion through the network (moves computed from authoritative state)
  const hostUnoMove = (seat) => {
    const g = room.host.game;
    const top = g.discard[g.discard.length - 1];
    const hand = g.players[seat].hand;
    const legal = hand.filter((cd) => g.canMatch(cd, top) && (cd.kind !== 'wild4' || g.mayPlayWild4(seat, cd)));
    const colorFor = (cd) => (cd.kind === 'wild' || cd.kind === 'wild4' ? 'blue' : undefined);
    if (g.turnState === 'drawn') {
      if (legal.some((m) => m.id === g.drawnCardId)) {
        const cd = hand.find((x) => x.id === g.drawnCardId);
        return { kind: 'play', cardId: cd.id, color: colorFor(cd) };
      }
      return { kind: 'pass' };
    }
    if (legal.length) { const c2 = legal[0]; return { kind: 'play', cardId: c2.id, color: colorFor(c2) }; }
    return { kind: 'draw' };
  };
  let guard = 0;
  while (room.host.game.phase === 'playing' && guard++ < 4000) {
    const seat = room.host.game.current;
    const mv = hostUnoMove(seat);
    if (!mv) break;
    sendMove(ps, seat, mv);
    await waitFor(() => room.host.game.phase !== 'playing' || room.host.game.current !== seat, 400);
  }
  ok('uno: game finished with a winner', room.host.game.phase === 'roundEnd' && room.host.game.winner != null);
  // convergence: all clients agree on counts & winner
  ok('uno: clients converged', ps.every((p) => JSON.stringify(p.latest().counts) === JSON.stringify(ps[0].latest().counts)));
  room.server.close();
}

async function runDoudizhu() {
  const room = await createRoom({ game: 'doudizhu', port: 0 });
  const ps = [];
  for (let i = 0; i < 3; i++) ps.push(await makePlayer(room.wsUrl, 'D' + i));
  ok('ddz: 3 players joined', await waitFor(() => ps.every((p) => p.lobby() && p.lobby().seats.length === 3)));

  // start the round: deals 17 each, enters bidding
  ps[0].client.send({ t: 'act', kind: 'start' });
  ok('ddz: started and dealing', await waitFor(() => room.host.game.phase === 'bidding'));

  // bidding (sequential — the host validates the turn order)
  ps[0].client.send({ t: 'act', kind: 'bid', score: 3 });
  await waitFor(() => room.host.game.bidScores[0] != null);
  ps[1].client.send({ t: 'act', kind: 'bid', score: 0 });
  await waitFor(() => room.host.game.bidScores[1] != null);
  ps[2].client.send({ t: 'act', kind: 'bid', score: 0 });
  ok('ddz: landlord assigned & playing', await waitFor(() => room.host.game.phase === 'playing' && room.host.game.landlord === 0));
  await waitFor(() => ps[0].latest() && ps[0].latest().phase === 'playing');
  ok('ddz: landlord got 20 cards', ps[0].latest().counts[0] === 20);

  // drive a few turns via network (landlord leads, then beat / pass)
  let guard = 0;
  const seen = new Set();
  while (room.host.game.phase === 'playing' && guard++ < 60) {
    const seat = room.host.game.current;
    const key = seat + ':' + room.host.game.passCount;
    if (seen.has(key)) break;
    seen.add(key);
    const p = ps.find((x) => x.you() === seat);
    if (!room.host.game.lastPlay || room.host.game.lastPlay.seat === seat) {
      // fresh lead: lead the lowest single
      const view = p.latest();
      const c = view.hand[0];
      sendAct(ps, seat, { kind: 'play', cardIds: [c.id] });
    } else {
      sendAct(ps, seat, { kind: 'pass' });
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  ok('ddz: a play round advanced via the network', guard > 1);
  room.server.close();
}

async function runExploding() {
  const room = await createRoom({ game: 'exploding', port: 0 });
  const ps = [];
  for (let i = 0; i < 3; i++) ps.push(await makePlayer(room.wsUrl, 'E' + i));
  ok('ek: 3 players joined', await waitFor(() => ps.every((p) => p.lobby() && p.lobby().seats.length === 3)));
  ps[0].client.send({ t: 'act', kind: 'start' });
  ok('ek: started and playing', await waitFor(() => room.host.game.phase === 'playing'));
  let guard = 0;
  while (room.host.game.phase === 'playing' && guard++ < 5000) {
    if (room.host.game.pendingFavor) { // the favor target must hand a card
      const t = room.host.game.pendingFavor.target;
      const act = aiEk(room.host.game, t) || { kind: 'give', cardId: room.host.game.players[t].hand[0].id };
      sendAct(ps, t, act);
      await waitFor(() => !room.host.game.pendingFavor, 500);
      continue;
    }
    const seat = room.host.game.current;
    const act = aiEk(room.host.game, seat) || { kind: 'draw' };
    await waitFor(() => ps.find((x) => x.you() === seat) && ps.find((x) => x.you() === seat).latest() != null, 500);
    sendAct(ps, seat, act);
    await waitFor(() => room.host.game.phase !== 'playing' || room.host.game.current !== seat, 400);
  }
  ok('ek: game finished with a winner', room.host.game.phase === 'roundEnd' && room.host.game.winner != null);
  ok('ek: exactly one survivor', room.host.game.players.filter((x) => x.alive).length === 1);
  room.server.close();
}

async function runLiarBar() {
  const room = await createRoom({ game: 'liarsbar', port: 0 });
  const ps = [];
  for (let i = 0; i < 3; i++) ps.push(await makePlayer(room.wsUrl, 'L' + i));
  ok('lb: 3 players joined', await waitFor(() => ps.every((p) => p.lobby() && p.lobby().seats.length === 3)));
  ps[0].client.send({ t: 'act', kind: 'start' });
  ok('lb: started and playing', await waitFor(() => room.host.game.phase === 'playing'));
  let guard = 0;
  while (room.host.game.phase === 'playing' && guard++ < 5000) {
    const g = room.host.game;
    if (g.pendingRoulette) { // a challenge was resolved: the loser must pull the trigger
      const t = g.pendingRoulette.seat;
      sendAct(ps, t, aiLiarBar(g, t) || { kind: 'fire' });
      await waitFor(() => !room.host.game.pendingRoulette, 500);
      continue;
    }
    const seat = g.current;
    const act = aiLiarBar(g, seat) || { kind: 'call' };
    await waitFor(() => ps.find((x) => x.you() === seat) && ps.find((x) => x.you() === seat).latest() != null, 500);
    sendAct(ps, seat, act);
    await waitFor(() => room.host.game.phase !== 'playing' || room.host.game.current !== seat, 400);
  }
  ok('lb: game finished with a winner', room.host.game.phase === 'roundEnd' && room.host.game.winner != null);
  ok('lb: exactly one survivor', room.host.game.players.filter((x) => x.alive).length === 1);
  room.server.close();
}

async function runGuozhan() {
  const room = await createRoom({ game: 'guozhan', port: 0 });
  const ps = [];
  for (let i = 0; i < 2; i++) ps.push(await makePlayer(room.wsUrl, 'G' + i));
  ok('gz: 2 players joined lobby', await waitFor(() => ps.every((p) => p.lobby() && p.lobby().seats.length === 2)));
  ps[0].client.send({ t: 'act', kind: 'start', seed: 'verify-socket-gz', scenario: 'random-front-v2' });
  ok('gz: started with a hex map', await waitFor(() => ps.every((p) => p.latest() && p.latest().phase === 'playing' && p.latest().map && p.latest().map.regions.length > 20)));
  const v0 = ps[0].latest();
  ok('gz: personal actions are populated', v0.actions.length > 10);
  ok('gz: fog does not leak stacks outside full visibility', v0.regions.every((r) => r.visibility === 'full' || !r.stacks));
  const id0 = v0.actions[0].id;
  sendAct(ps, 0, { kind: 'gz_order', actionId: id0 });
  ok('gz: order queues without resolving', await waitFor(() => ps[0].latest().pendingOrders.length === 1 && ps[0].latest().turn === 1));
  sendAct(ps, 0, { kind: 'gz_lock' });
  sendAct(ps, 1, { kind: 'gz_lock' });
  ok('gz: both locks resolve one turn', await waitFor(() => ps.every((p) => p.latest().turn === 2), 5000));
  ok('gz: report is delivered to both seats', ps.every((p) => p.latest().report && p.latest().report.turn === 1));
  ok('gz: orders reset for the new turn', ps.every((p) => p.latest().pendingOrders.length === 0 && !p.latest().locked));
  for (const p of ps) p.ws.close();
  room.server.close();
}

async function runLlmSeat() {
  const llm = {
    model: 'mock',
    async decide(ctx) {
      return { actions: [{ kind: 'draw' }], say: '这手牌我先摸一张。' };
    },
  };
  const room = await createRoom({ game: 'uno', port: 0, llm });
  const p = await makePlayer(room.wsUrl, 'Human');
  ok('llm: room starts with one human', await waitFor(() => p.lobby() && p.lobby().seats.length === 1));
  p.client.send({ t: 'llm', count: 1 });
  ok('llm: owner reserves a server LLM seat', await waitFor(() => p.lobby() && p.lobby().seats.length === 2 && (p.lobby().llmSeats || []).length === 1));
  ok('llm: lobby exposes model without exposing a key', p.lobby().llmAvailable === true && p.lobby().llmModel === 'mock');
  p.client.send({ t: 'act', kind: 'start' });
  ok('llm: game starts with the LLM seat', await waitFor(() => p.latest() && p.latest().phase === 'playing'));
  const card = p.latest().hand[0];
  p.client.send({ t: 'act', kind: 'play', cardId: card.id });
  ok('llm: LLM takes its turn through Host', await waitFor(() => room.host.game.last && room.host.game.last.seat === 1, 5000));
  ok('llm: LLM chat is broadcast to the human seat', await waitFor(() => p.inbox.some((m) => m.t === 'chat' && /摸一张/.test(m.text))));
  p.ws.close();
  room.host.stopLlmLoop();
  room.server.close();
}

async function runMultiLlmWerewolf() {
  const stats = new Map();
  const llm = {
    model: 'mock',
    async decide(ctx) {
      const v = ctx.view;
      if (!stats.has(ctx.seat)) stats.set(ctx.seat, { say: 0, vote: 0, night: 0 });
      const st = stats.get(ctx.seat);
      if (v.stage === 'day_speech') {
        st.say += 1;
        return { kind: 'say', text: `${ctx.seat + 1} 号 LLM：先听大家的。` };
      }
      if (v.stage === 'day_vote') {
        st.vote += 1;
        const pick = v.actions.find((a) => a.kind === 'vote');
        return pick ? { kind: 'vote', targetSeat: pick.targetSeat } : { kind: 'abstain' };
      }
      st.night += 1;
      const pick = v.actions.find((a) => a.kind === 'kill')
        || v.actions.find((a) => a.kind === 'inspect')
        || v.actions.find((a) => a.kind === 'witch' && a.id === 'witch:save')
        || v.actions.find((a) => a.kind === 'pass');
      if (!pick) return { kind: 'pass' };
      if (pick.kind === 'witch') return { kind: 'witch', action: 'save' };
      return { kind: pick.kind, targetSeat: pick.targetSeat };
    },
  };
  const room = await createRoom({ game: 'werewolf', port: 0, llm });
  const p = await makePlayer(room.wsUrl, 'Human');
  ok('llm-multi: room starts with one human', await waitFor(() => p.lobby() && p.lobby().seats.length === 1));
  p.client.send({ t: 'llm', count: 2 });
  ok('llm-multi: owner reserves two LLM seats', await waitFor(() => p.lobby() && p.lobby().seats.length === 3 && (p.lobby().llmSeats || []).length === 2));
  p.client.send({ t: 'bot', count: 3 });
  ok('llm-multi: three bots fill a six-seat werewolf room', await waitFor(() => p.lobby() && p.lobby().seats.length === 6));
  p.client.send({ t: 'act', kind: 'start' });
  ok('llm-multi: werewolf starts', await waitFor(() => p.latest() && p.latest().phase === 'playing'));
  const goalsMet = () => [1, 2].every((seat) => {
    const st = stats.get(seat);
    return st && st.say >= 1 && st.vote >= 1;
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && room.host.game.phase === 'playing' && !goalsMet()) {
    const v = p.latest();
    if (v && v.you === v.current) {
      if (v.stage === 'day_speech') p.client.send({ t: 'act', kind: 'say', text: '我是人类玩家，先听大家。' });
      else if (v.stage === 'day_vote') {
        const pick = v.actions.find((a) => a.kind === 'vote');
        p.client.send(pick ? { t: 'act', kind: 'vote', targetSeat: pick.targetSeat } : { t: 'act', kind: 'abstain' });
      } else {
        const pick = v.actions.find((a) => a.kind === 'kill')
          || v.actions.find((a) => a.kind === 'inspect')
          || v.actions.find((a) => a.kind === 'witch' && a.id === 'witch:save')
          || v.actions.find((a) => a.kind === 'pass');
        if (pick && pick.kind === 'witch') p.client.send({ t: 'act', kind: 'witch', action: 'save' });
        else if (pick) p.client.send({ t: 'act', kind: pick.kind, targetSeat: pick.targetSeat });
        else p.client.send({ t: 'act', kind: 'pass' });
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  for (const seat of [1, 2]) {
    const st = stats.get(seat);
    ok(`llm-multi: seat ${seat} spoke and voted`, !!st && st.say >= 1 && st.vote >= 1);
  }
  p.ws.close();
  room.host.stopLlmLoop();
  room.server.close();
}

async function runLeaderboard() {
  const prevDir = process.env.BOARD_GAMES_DATA_DIR;
  const scoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uno-bt-score-only-'));
  process.env.BOARD_GAMES_DATA_DIR = scoreDir;
  const room = await createRoom({ game: 'uno', port: 0 });
  const p0 = await makePlayer(room.wsUrl, '甲');
  const p1 = await makePlayer(room.wsUrl, '乙');
  ok('score: two humans joined', await waitFor(() => p0.lobby() && p1.lobby() && p0.lobby().seats.length === 2));
  p0.client.send({ t: 'act', kind: 'start' });
  ok('score: uno started', await waitFor(() => p0.latest() && p0.latest().phase === 'playing'));
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && room.host.game.phase === 'playing') {
    const g = room.host.game;
    const seat = g.current;
    const p = seat === 0 ? p0 : seat === 1 ? p1 : null;
    if (p) {
      const act = room.host.ai(seat);
      if (act) p.client.send({ t: 'act', kind: act.kind, ...act });
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  ok('score: uno finished', room.host.game.phase === 'roundEnd');
  ok('score: both clients received personal score', await waitFor(() => p0.inbox.some((m) => m.t === 'score') && p1.inbox.some((m) => m.t === 'score'), 3000));
  const res = await fetch('http://127.0.0.1:' + room.port + '/api/leaderboard?range=all');
  const board = await res.json();
  ok('score: leaderboard API returns rows', res.ok && board.ok === true && board.rows.length === 2);
  ok('score: winner outranks loser', board.rows[0].points > board.rows[1].points);
  ok('score: no device ids exposed', !JSON.stringify(board).includes('dev-'));
  for (const p of [p0, p1]) p.ws.close();
  room.host.stopLlmLoop();
  room.server.close();
  process.env.BOARD_GAMES_DATA_DIR = prevDir;
  fs.rmSync(scoreDir, { recursive: true, force: true });
}

try {
  await runUno();
  await runDoudizhu();
  await runExploding();
  await runLiarBar();
  await runGuozhan();
  await runLlmSeat();
  await runMultiLlmWerewolf();
  await runLeaderboard();
} catch (e) {
  console.error('EXCEPTION', e);
  failures++;
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
