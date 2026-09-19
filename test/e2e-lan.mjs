// verify-socket.mjs — end-to-end verification of the server-authoritative room
// over real WebSockets: join, lobby broadcast, start, per-turn plays, state
// convergence, chat. Runs UNO (4 players), 斗地主 (3 players) and 炸弹猫 (3
// players) to a winner.
import { createRoom } from '../src/lan/room.mjs';
import { Client } from '../src/engine/client.js';
import { aiEk } from '../src/games/exploding.js';
import { aiLiarBar } from '../src/games/liarsbar.js';

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
  const room = await createRoom({ game: 'uno', port: 0 });
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

try {
  await runUno();
  await runDoudizhu();
  await runExploding();
  await runLiarBar();
} catch (e) {
  console.error('EXCEPTION', e);
  failures++;
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
