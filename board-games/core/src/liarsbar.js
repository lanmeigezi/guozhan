// liarsbar.js — 骗子酒馆 (Liar's Bar, simplified) rules engine.
// A bluffing game: each round has a "target rank". On your turn you either place
// a card claiming it is that rank (you may lie), or call the previous player a
// liar. A call reveals the card: if the claim was true the caller loses a life,
// if it was a lie the claimer loses a life. Lose all lives -> out; the last
// player standing wins. 3-5 players. Implements the Game interface.
//
// Card kinds: cards carry a rank ('3'..'2'). Lives = 3 per player.
//
// To guarantee termination each round caps the number of consecutive claims; when
// the cap is reached it auto-resolves as a challenge.

import { GameError } from './game-error.js';
import { shuffle, mulberry32 } from './cards.js';

const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const VALUE = {}; RANKS.forEach((r, i) => { VALUE[r] = i + 3; });
const SUITS = ['spade', 'heart', 'club', 'diamond'];

export function buildLiarDeck() {
  const deck = [];
  let id = 0;
  for (const r of RANKS) for (const s of SUITS) deck.push({ id: 'lb' + (id++), rank: r, suit: s, value: VALUE[r] });
  // Wild cards (Jokers): always "true" and can stand in for any rank.
  for (let i = 0; i < 4; i++) deck.push({ id: 'lb' + (id++), rank: 'JOKER', suit: null, value: 0, wild: true });
  // Yellow cards: on reveal they trigger a roulette volley at every other alive player.
  for (let i = 0; i < 4; i++) deck.push({ id: 'lb' + (id++), rank: 'YELLOW', suit: null, value: 0, yellow: true });
  return deck;
}

const DEFAULT_OPTIONS = { handSize: 5 };

export class LiarsBarGame {
  constructor({ playerNames = [], options = {}, random } = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.random = random || Math.random;
    // Russian roulette: a revolver with 6 chambers + 1 bullet at a random chamber.
    this.players = playerNames.map((name, i) => ({ id: i, name, hand: [], alive: true, shots: 0, bulletAt: Math.floor(this.random() * 6) }));
    this.phase = 'lobby';
    this.current = 0;
    this.winner = null;
    this.targetRank = null;
    this.lastClaim = null; // {seat, cards, claimedRank}
    this.claimsThisRound = 0;
    this.pendingRoulette = null; // {seat, count, designate?} the loser must pull the trigger
    this.pendingShots = null; // [{seat, count}] volley (yellow card): each alive player fires in order
    this.pendingDesignate = null; // seat of a player owed a designate turn (emptied their hand)
    this.emptyHandSeats = []; // seats who emptied their hand this round (FIFO, awaiting designate)
    this.last = null;
  }

  get n() { return this.players.length; }
  get aliveCount() { return this.players.filter((p) => p.alive).length; }
  get claimCap() { return Math.max(2, this.aliveCount * 2); }

  // Draw `handSize` cards from `deck` (mutated in place via splice), with a *mild*
  // bias toward good cards (rank === targetRank, or a wild joker). ~35% of the time
  // we prefer a good card; the rest is fully random. This raises the odds of useful
  // hands slightly without breaking the randomness of the game.
  drawHand(deck, handSize, targetRank) {
    const hand = [];
    let guard = 0; // dead-loop guard
    while (hand.length < handSize && guard < 500) {
      guard += 1;
      const preferGood = this.random() < 0.35;
      let idx = -1;
      if (preferGood) {
        const goodIdx = deck.findIndex((c) => c.rank === targetRank || c.wild);
        if (goodIdx >= 0) idx = goodIdx;
      }
      if (idx < 0) idx = Math.floor(this.random() * deck.length);
      hand.push(deck.splice(idx, 1)[0]);
    }
    return hand;
  }

  addPlayer(name) {
    if (this.phase !== 'lobby') throw new GameError('GAME_STARTED', 'Game already started');
    this.players.push({ id: this.players.length, name, hand: [], alive: true, shots: 0, bulletAt: Math.floor(this.random() * 6) });
    return this.players.length - 1;
  }

  start() {
    if (this.phase !== 'lobby') throw new GameError('GAME_STARTED', 'Game already started');
    if (this.n < 3) throw new GameError('NOT_ENOUGH', '骗子酒馆至少需要 3 人');
    this.targetRank = RANKS[Math.floor(this.random() * RANKS.length)];
    const deck = shuffle(buildLiarDeck(), this.random);
    for (let p = 0; p < this.n; p++) {
      this.players[p].hand = this.drawHand(deck, this.opts.handSize, this.targetRank);
    }
    this.phase = 'playing';
    this.current = 0;
    this.lastClaim = null;
    this.claimsThisRound = 0;
    this.pendingDesignate = null;
    this.emptyHandSeats = [];
    this.pendingRoulette = null;
    this.pendingShots = null;
    this.last = { kind: 'start', targetRank: this.targetRank };
    return this.snapshot();
  }

  applyAction(seat, action) {
    const act = action || {};
    switch (act.kind) {
      case 'start': return this.start();
      case 'claim': return this.claim(seat, act.cardIds || act.cardId);
      case 'call': return this.call(seat);
      case 'designate': return this.designate(seat, act.targetSeat);
      case 'fire': return this.fire(seat);
      default: throw new GameError('UNKNOWN_ACT', '未知操作');
    }
  }

  assertPlaying(seat) {
    if (this.phase !== 'playing') throw new GameError('NOT_PLAYING', '游戏尚未开始');
    if (!this.players[seat].alive) throw new GameError('ELIMINATED', '你已出局');
    if (seat !== this.current) throw new GameError('NOT_YOUR_TURN', '还没轮到你');
  }

  claim(seat, cardIds) {
    this.assertPlaying(seat);
    if (this.claimsThisRound >= this.claimCap) throw new GameError('CLAIM_CAP', '本轮已无法继续加注，请叫牌');
    const ids = Array.isArray(cardIds) ? cardIds.slice() : [cardIds];
    if (ids.length === 0) throw new GameError('NO_CARD', '你没有出牌');
    const hand = this.players[seat].hand;
    const cards = ids.map((id) => hand.find((c) => c.id === id));
    if (cards.some((c) => !c)) throw new GameError('NO_CARD', '你手里没有这张牌');
    // Remove the played cards.
    for (const card of cards) {
      const idx = hand.indexOf(card);
      if (idx >= 0) hand.splice(idx, 1);
    }
    this.lastClaim = { seat, cards: cards.map((c) => ({ ...c })), claimedRank: this.targetRank };
    this.claimsThisRound += 1;
    this.last = { kind: 'claim', seat, cardIds: ids, claimedRank: this.targetRank, count: cards.length };
    // Emptied hand: record the seat (dedup), but do NOT pause here. The claim still
    // faces the reveal window (next player may call, or claimCap auto-resolves). The
    // reward — a forced shot — is granted only after a reveal settles and the player
    // is still alive and empty-handed.
    if (hand.length === 0 && this.emptyHandSeats.indexOf(seat) < 0) this.emptyHandSeats.push(seat);
    this.current = this.nextAlive(seat);
    if (this.claimsThisRound >= this.claimCap) {
      return this.resolve(seat, this.lastClaim, true);
    }
    return this.snapshot();
  }

  call(seat) {
    this.assertPlaying(seat);
    if (!this.lastClaim) throw new GameError('ILLEGAL', '本轮还没有人出牌，不能叫牌');
    return this.resolve(seat, this.lastClaim, false);
  }

  // Resolve a challenge against lastClaim. `challenger` is the player calling (or
  // the auto-challenger when auto=true). Count the fake cards (non-wild, non-yellow
  // cards whose rank differs from the claim): all-true -> challenger shoots once;
  // k fakes -> the claimer shoots k times (k >= 1). If any card is a YELLOW card,
  // a volley fires instead: every alive player EXCEPT the claimer shoots once, one
  // after another (and the claimer also shoots for any fake cards they played).
  resolve(challengerSeat, lastClaim, auto) {
    const cards = lastClaim.cards || [lastClaim.card];
    const hasYellow = cards.some((c) => c.yellow);
    // Yellow cards are handled separately (volley), never counted as fakes.
    const fakeCount = cards.filter((c) => !c.wild && !c.yellow && c.rank !== lastClaim.claimedRank).length;
    this.lastClaim = null;
    // A reveal ends the current claim chain (a "trick"); reset the per-trick counter
    // so the next trick starts fresh. The round (deal) continues until someone's
    // designate shot completes.
    this.claimsThisRound = 0;

    if (hasYellow) {
      // Yellow card revealed: every alive player other than the claimer fires once,
      // in order. Fakes still stack onto the claimer's own head.
      const others = this.players
        .filter((p) => p.alive && p.id !== lastClaim.seat)
        .map((p) => ({ seat: p.id, count: 1 }));
      this.pendingShots = others;
      if (fakeCount > 0) this.pendingShots.push({ seat: lastClaim.seat, count: fakeCount });
      this.pendingRoulette = null;
      this.current = this.pendingShots[0].seat;
      this.last = {
        kind: 'yellow',
        claimedRank: lastClaim.claimedRank,
        loser: lastClaim.seat,
        count: fakeCount,
        volley: others.map((o) => o.seat),
      };
      return this.snapshot();
    }

    if (fakeCount === 0) {
      this.pendingRoulette = { seat: challengerSeat, count: 1 };
      this.current = challengerSeat;
      this.last = { kind: 'truth', claimedRank: lastClaim.claimedRank, loser: challengerSeat, count: 1 };
    } else {
      this.pendingRoulette = { seat: lastClaim.seat, count: fakeCount };
      this.current = lastClaim.seat;
      this.last = { kind: 'lie', claimedRank: lastClaim.claimedRank, loser: lastClaim.seat, count: fakeCount };
    }
    return this.snapshot();
  }

  // A player who emptied their hand orders a forced shot at another alive player.
  designate(seat, targetSeat) {
    if (this.phase !== 'playing') throw new GameError('NOT_PLAYING', '游戏未开始');
    if (this.pendingDesignate !== seat) throw new GameError('NOT_YOUR_TURN', '现在不能指定开枪');
    if (targetSeat == null || targetSeat === seat || !this.players[targetSeat] || !this.players[targetSeat].alive) {
      throw new GameError('BAD_TARGET', '无效目标');
    }
    this.pendingDesignate = null;
    // Defensive: consume this player from the empty-hand queue even though the normal
    // path already shifts it in grantNextDesignate(). Prevents a stale entry from
    // ever re-granting designate / skipping the newRound trigger.
    this.emptyHandSeats = (this.emptyHandSeats || []).filter((s) => s !== seat);
    // Tag this shot as a designate shot: when it settles, it is the round-reset point.
    this.pendingRoulette = { seat: targetSeat, count: 1, designate: true };
    this.current = targetSeat;
    this.last = { kind: 'designate', seat, targetSeat };
    return this.snapshot();
  }

  // The loser pulls the trigger after losing a challenge, a designation, or as part
  // of a yellow-card volley. After a shot settles, decide what happens next:
  //   - challenge penalty (truth/lie/yellow): never starts a new round; it either
  //     grants an empty-hand player their designate, or lets the round continue.
  //   - designate shot: this is the ONLY event that starts a new round (re-deal).
  fire(seat) {
    if (this.phase !== 'playing') throw new GameError('NOT_PLAYING', '游戏未开始');

    // Yellow-card volley: process the current shooter one at a time.
    if (this.pendingShots && this.pendingShots.length) {
      const shot = this.pendingShots[0];
      if (shot.seat !== seat) throw new GameError('NOT_YOUR_TURN', '现在还没轮到你开枪');
      let died = false;
      let n = shot.count || 1;
      while (n > 0 && !died) { died = this.shoot(seat); n -= 1; }
      this.pendingShots.shift();
      this.last = { ...this.last, kind: 'volley', seat, died };
      if (this.aliveCount <= 1) {
        this.phase = 'roundEnd';
        this.winner = this.players.findIndex((p) => p.alive);
        this.pendingShots = null;
        return this.snapshot();
      }
      if (this.pendingShots.length) {
        this.current = this.pendingShots[0].seat;
        return this.snapshot();
      }
      // Volley complete — this is a challenge penalty, so it does NOT reset the round.
      this.pendingShots = null;
      return this.settleAfterShot(seat, false);
    }

    if (!this.pendingRoulette || this.pendingRoulette.seat !== seat) {
      throw new GameError('NOT_ROULETTE', '现在无需开枪');
    }
    const wasDesignateShot = !!this.pendingRoulette.designate;
    let died = false;
    let shotsLeft = this.pendingRoulette.count || 1;
    while (shotsLeft > 0 && !died) {
      died = this.shoot(seat);
      shotsLeft -= 1;
    }
    this.pendingRoulette = null;
    this.last = { ...this.last, died, loser: seat };
    if (this.aliveCount <= 1) {
      this.phase = 'roundEnd';
      this.winner = this.players.findIndex((p) => p.alive);
      return this.snapshot();
    }
    return this.settleAfterShot(seat, wasDesignateShot);
  }

  // Decide what follows a settled shot (round already known to continue, i.e.
  // aliveCount > 1). `fromSeat` is the player who just fired. `wasDesignateShot`
  // distinguishes a designate shot (round-reset point) from a challenge penalty
  // (round continues).
  settleAfterShot(fromSeat, wasDesignateShot) {
    // Reward the next eligible empty-hand player with a designate, if any.
    if (this.grantNextDesignate()) {
      // Setup the designate state and hand control to that player.
      return this.snapshot();
    }
    // No designate owed. Only a completed designate shot resets the round; a
    // challenge penalty just continues the current round (same hands, same target).
    if (wasDesignateShot) {
      this.newRound(fromSeat); // re-deal everyone who survives; current set inside
    } else {
      this.current = this.seatAfter(fromSeat);
    }
    return this.snapshot();
  }

  // Pop the next empty-hand seat that is still alive and still empty-handed, and set
  // it up as the pending designate. Skips (drops) any front entry that is dead or no
  // longer empty. Returns true when a designate was granted.
  grantNextDesignate() {
    while (this.emptyHandSeats.length) {
      const seat = this.emptyHandSeats[0];
      const p = this.players[seat];
      if (p && p.alive && p.hand.length === 0) {
        this.emptyHandSeats.shift(); // consume this entry
        this.pendingDesignate = seat;
        this.current = seat;
        this.last = { ...this.last, kind: 'designate-pending', seat };
        return true;
      }
      this.emptyHandSeats.shift(); // dead or re-dealt: drop this entry
    }
    return false;
  }

  // Start a fresh round after `from`: survivors redraw (biased), a new target rank
  // is chosen, and per-round state is reset. The next player is the one after `from`.
  newRound(from) {
    this.targetRank = RANKS[Math.floor(this.random() * RANKS.length)];
    const deck = shuffle(buildLiarDeck(), this.random);
    for (const p of this.players) if (p.alive) p.hand = this.drawHand(deck, this.opts.handSize, this.targetRank);
    this.lastClaim = null;
    this.claimsThisRound = 0;
    this.pendingDesignate = null;
    this.emptyHandSeats = [];
    this.pendingRoulette = null;
    this.pendingShots = null;
    this.current = from == null ? this.nextAlive(0) : this.nextAlive(from);
  }

  // The player after `seat` (wrapping), skipping dead players.
  seatAfter(seat) {
    return this.nextAlive(seat);
  }

  // Russian roulette: pull the trigger. Survive -> advance the chamber; hit the
  // bullet -> out. The bullet sits at a random chamber among 6, so max 6 shots.
  shoot(seat) {
    const p = this.players[seat];
    if (p.shots === p.bulletAt) { p.alive = false; return true; }
    p.shots += 1;
    return false;
  }

  nextAlive(from) {
    let s = from;
    for (let i = 0; i < this.n; i++) { s = (s + 1) % this.n; if (this.players[s].alive) return s; }
    return from;
  }

  snapshot() {
    const lastClaim = this.lastClaim
      ? {
          seat: this.lastClaim.seat,
          claimedRank: this.lastClaim.claimedRank,
          count: this.lastClaim.cards.length,
          cards: this.lastClaim.cards.map((c) => ({ rank: c.rank, wild: !!c.wild, yellow: !!c.yellow })),
        }
      : null;
    return {
      phase: this.phase,
      current: this.current,
      winner: this.winner,
      targetRank: this.targetRank,
      lastClaim,
      designate: this.pendingDesignate,
      players: this.players.map((p) => ({ id: p.id, name: p.name, handCount: p.hand.length, shots: p.shots, alive: p.alive })),
      counts: this.players.map((p) => p.hand.length),
      alive: this.players.map((p) => p.alive),
      shots: this.players.map((p) => p.shots),
      last: this.last,
      pendingRoulette: this.pendingRoulette ? { seat: this.pendingRoulette.seat, count: this.pendingRoulette.count || 1 } : null,
      pendingShots: this.pendingShots && this.pendingShots.length ? { seat: this.pendingShots[0].seat, remaining: this.pendingShots.length } : null,
    };
  }

  viewFor(seat) {
    const snap = this.snapshot();
    snap.you = seat;
    snap.hand = this.players[seat].hand.map((c) => ({ ...c }));
    return snap;
  }
}

// ---- AI ----
export function aiLiarBar(game, seat) {
  if (game.phase !== 'playing') return null;
  // Yellow-card volley in progress: only the current shooter fires.
  if (game.pendingShots && game.pendingShots.length) {
    return game.pendingShots[0].seat === seat ? { kind: 'fire' } : null;
  }
  // A challenge was resolved: the loser must pull the trigger.
  if (game.pendingRoulette) {
    return game.pendingRoulette.seat === seat ? { kind: 'fire' } : null;
  }
  // We emptied our hand: order a forced shot at the most dangerous other player.
  if (game.pendingDesignate != null && game.pendingDesignate === seat) {
    const others = game.players.filter((p) => p.alive && p.id !== seat);
    if (others.length === 0) return null;
    // Prefer fewer cards (closer to emptying) then more shots fired already.
    const target = others.sort((a, b) => (a.hand.length - b.hand.length) || (b.shots - a.shots))[0];
    return { kind: 'designate', targetSeat: target.id };
  }
  if (game.current !== seat) return null;
  const hand = game.players[seat].hand;
  const target = game.targetRank;
  if (hand.length === 0) return { kind: 'call' }; // no card: must call

  const truth = hand.filter((c) => c.wild || c.rank === target);
  const yellows = hand.filter((c) => c.yellow);
  const claims = game.claimsThisRound || 0;
  const shots = game.players[seat].shots; // 0 = fresh; the closer to the bullet, the more careful
  const lastClaim = game.lastClaim;

  // 1) We hold truth (target or wild): claim it. If we hold several truth cards,
  //    dump them all to empty the hand and trigger a designation.
  if (truth.length) {
    const ids = truth.map((c) => c.id);
    return { kind: 'claim', cardIds: ids };
  }

  // 2) No truth card, a claim is on the table: decide accuse vs bluff. *After* an
  //    accusation has already failed we fall back to bluffing; a yellow card is an
  //    attractive bluff because being exposed triggers a volley against everyone
  //    else (the claimer — us — is spared from the volley itself).
  if (lastClaim) {
    const callProb = Math.min(0.85, Math.max(0.2, 0.35 + claims * 0.2 - Math.min(0.3, shots * 0.08)));
    if (game.random() < callProb) return { kind: 'call' };
    // Otherwise bluff: prefer a yellow card (volley if exposed), else lowest non-wild.
    if (yellows.length) return { kind: 'claim', cardId: yellows[0].id };
    const nonWild = hand.filter((c) => !c.wild);
    const pick = nonWild.length ? nonWild.sort((a, b) => a.value - b.value)[0] : hand[0];
    return { kind: 'claim', cardId: pick.id };
  }

  // 3) Leading with no truth card: we must claim. Prefer a yellow card — if we are
  //    exposed, every other alive player fires one shot (we don't), which is good.
  if (yellows.length) return { kind: 'claim', cardId: yellows[0].id };
  const nonWild = hand.filter((c) => !c.wild);
  const low = nonWild.length ? nonWild.sort((a, b) => a.value - b.value)[0] : hand[0];
  return { kind: 'claim', cardId: low.id };
}
