// game.test.js — end-to-end host/client synchronization over loopback.
// Verifies the host is authoritative and that every guest converges on the same
// public game state, including error handling for illegal moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../src/host.js';
import { Client } from '../src/client.js';
import { createLoopbackPair } from '../src/loopback.js';
import { mulberry32, isWild, KIND } from '../src/cards.js';

// Wires a fresh loopback pair: host end -> Host, guest end -> a Client.
function makeGuest(host) {
  const [hostEnd, guestEnd] = createLoopbackPair();
  const client = new Client({ transport: guestEnd });
  const inbox = [];
  let latest = null;
  client.onMessage = (msg) => {
    inbox.push(msg);
    if (msg.t === 'state') latest = msg.view;
  };
  host.addTransport(hostEnd);
  return { client, inbox, latest: () => latest };
}

function pub(view) {
  return view
    ? {
        phase: view.phase,
        current: view.current,
        direction: view.direction,
        color: view.color,
        winner: view.winner,
        turnState: view.turnState,
        counts: view.counts,
      }
    : null;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Poll until every guest's latest public state matches the host (with a cap).
// Returns false if they never converge within the cap, which would mean a real
// desync — exactly what this test must catch.
async function converge(host, guests, timeout = 900) {
  const start = Date.now();
  let ok = false;
  while (Date.now() - start < timeout) {
    const hp = pub(host.getLocalView());
    ok = guests.every((g) => eq(pub(g.latest()), hp));
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return ok;
}

async function waitFor(fn, timeout = 900) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}

function lastLobby(guest) {
  const lobbies = guest.inbox.filter((m) => m.t === 'lobby');
  return lobbies[lobbies.length - 1];
}

test('guests join the lobby and see the seat list', async () => {
  const host = new Host({ playerName: 'Host', random: mulberry32(1) });
  const guestA = makeGuest(host);
  const guestB = makeGuest(host);

  guestA.client.join('Alice');
  guestB.client.join('Bob');
  await waitFor(() => lastLobby(guestA) && lastLobby(guestA).seats.length === 3);

  const lobbyA = lastLobby(guestA);
  assert.equal(lobbyA.you, 1);
  assert.deepEqual(lobbyA.seats.map((s) => s.name), ['Host', 'Alice', 'Bob']);
  const lobbyB = lastLobby(guestB);
  assert.equal(lobbyB.you, 2);
});

test('starting deals cards and every client converges on the same public state', async () => {
  const host = new Host({ playerName: 'Host', random: mulberry32(3) });
  const guestA = makeGuest(host);
  const guestB = makeGuest(host);
  guestA.client.join('Alice');
  guestB.client.join('Bob');
  await waitFor(() => lastLobby(guestA) && lastLobby(guestA).seats.length === 3);

  host.startGame();
  assert.ok(await converge(host, [guestA, guestB]));

  assert.equal(guestA.latest().phase, 'playing');
  assert.equal(guestA.latest().counts.length, 3);
  assert.equal(guestA.latest().counts.reduce((a, b) => a + b, 0), 21); // 3 * 7
  assert.equal(guestA.latest().hand.length, 7); // personalized: only your own hand
});

test('an illegal guest move is rejected with an error and no state change', async () => {
  const host = new Host({ playerName: 'Host', random: mulberry32(5) });
  const guestA = makeGuest(host);
  guestA.client.join('Alice');
  await waitFor(() => lastLobby(guestA));
  host.startGame();
  await converge(host, [guestA]);
  const before = guestA.latest();

  // A card id that exists in nobody's hand always fails validation, whether or
  // not it is this guest's turn.
  guestA.client.play('nope-not-a-card', 'blue');
  await waitFor(() => guestA.inbox.some((m) => m.t === 'error'));

  const err = guestA.inbox.find((m) => m.t === 'error');
  assert.ok(err, 'guest received an illegal-move error');
  assert.strictEqual(guestA.latest(), before); // no state change from the illegal move
});

test('the host and guests stay in sync across many legal turns', async () => {
  const host = new Host({ playerName: 'Host', random: mulberry32(9) });
  const guestA = makeGuest(host);
  const guestB = makeGuest(host);
  guestA.client.join('Alice');
  guestB.client.join('Bob');
  await waitFor(() => lastLobby(guestA) && lastLobby(guestA).seats.length === 3);
  host.startGame();
  await converge(host, [guestA, guestB]);

  let guard = 0;
  while (host.game.phase === 'playing' && guard++ < 60) {
    const seat = host.game.current;
    const move = nextMove(host, seat);
    if (!move) break;
    sendMove(host, seat, move, guestA, guestB);
    assert.ok(await converge(host, [guestA, guestB]), 'guests converged after turn ' + guard);
  }
  assert.ok(guard > 0, 'the game advanced through at least one turn');
});

// White-box bot: asks the authoritative engine what the current player may
// legally do, then routes that action over the network through the right client.
function nextMove(host, seat) {
  const g = host.game;
  const top = g.discard[g.discard.length - 1];
  const legal = g.players[seat].hand.filter(
    (cd) => g.canMatch(cd, top) && (cd.kind !== KIND.WILD4 || g.mayPlayWild4(seat, cd))
  );
  if (g.turnState === 'drawn') {
    if (legal.some((cd) => cd.id === g.drawnCardId)) {
      const cd = g.players[seat].hand.find((x) => x.id === g.drawnCardId);
      return { kind: 'play', cardId: cd.id, color: isWild(cd) ? 'blue' : undefined };
    }
    return { kind: 'pass' };
  }
  if (legal.length) {
    const cd = legal[0];
    return { kind: 'play', cardId: cd.id, color: isWild(cd) ? 'blue' : undefined };
  }
  return { kind: 'draw' };
}

function sendMove(host, seat, move, guestA, guestB) {
  const client = seat === 1 ? guestA.client : seat === 2 ? guestB.client : null;
  if (client) {
    if (move.kind === 'play') client.play(move.cardId, move.color);
    else if (move.kind === 'draw') client.draw();
    else client.pass();
  } else {
    if (move.kind === 'play') host.play(move.cardId, move.color);
    else if (move.kind === 'draw') host.draw();
    else host.pass();
  }
}

test('host can add/remove AI bots and a bot-assisted game runs to a winner', async () => {
  const host = new Host({ playerName: 'Host', random: mulberry32(11), options: { unoPenalty: true } });

  // add two AI opponents
  host.addBot('机器人A');
  host.addBot('机器人B');
  assert.deepEqual([...host.botSeats].sort(), [1, 2]);
  assert.equal(host.game.players.length, 3);

  // add a third then remove the last: seats stay contiguous and renumbered
  host.addBot('机器人C');
  assert.deepEqual([...host.botSeats].sort(), [1, 2, 3]);
  host.removeBot(3);
  assert.deepEqual([...host.botSeats].sort(), [1, 2]);
  assert.equal(host.game.players.length, 3);

  host.startGame();
  assert.equal(host.game.phase, 'playing');
  // deck scaled for 3 players is the standard 108
  assert.equal(host.game.drawPile.length + host.game.discard.length + 3 * 7, 108);

  let guard = 0;
  while (host.game.phase === 'playing' && guard++ < 4000) {
    const seat = host.game.current;
    const move = nextMove(host, seat);
    if (!move) break;
    if (host.isBotSeat(seat)) {
      if (move.kind === 'play') host.execute(seat, { t: 'act', kind: 'play', cardId: move.cardId, color: move.color });
      else if (move.kind === 'draw') host.execute(seat, { t: 'act', kind: 'draw' });
      else host.execute(seat, { t: 'act', kind: 'pass' });
    } else {
      if (move.kind === 'play') host.play(move.cardId, move.color);
      else if (move.kind === 'draw') host.draw();
      else host.pass();
    }
  }
  assert.equal(host.game.phase, 'roundEnd');
  assert.ok(host.game.winner != null);
});
