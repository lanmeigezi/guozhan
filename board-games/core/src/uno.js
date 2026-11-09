// uno.js — pure UNO rules engine (authoritative state machine).
// No I/O, no transport. The host wraps this and keeps it as the single source of truth.
// Illegal moves throw an UnoError; the host turns those into friendly messages.

import { buildDeck, shuffle, isWild, KIND, cardLabel } from './cards.js';
import { GameError } from './game-error.js';

export class UnoError extends GameError {
  constructor(code, message) {
    super(code, message);
    this.name = 'UnoError';
  }
}

const DEFAULT_OPTIONS = {
  handSize: 7, // cards dealt to each player
  strictWild4: true, // +4 only when you hold no card of the active color
  unoPenalty: true, // auto +2 if you go down to 1 card without calling UNO
};

export class UnoGame {
  constructor({ playerNames = [], options = {}, random } = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.random = random || Math.random;
    this.players = playerNames.map((name, i) => ({
      id: i,
      name,
      hand: [],
      unoAnnounced: false,
    }));
    this.drawPile = [];
    this.discard = [];
    this.direction = 1;
    this.current = 0;
    this.color = null;
    this.phase = 'lobby'; // 'lobby' | 'playing' | 'roundEnd'
    this.winner = null; // seat index
    this.turnState = 'awaiting'; // 'awaiting' | 'drawn'
    this.drawnCardId = null; // after a draw, only the drawn card may be played
    this.last = null; // description of the last move, for server->client messages
  }

  get n() {
    return this.players.length;
  }

  addPlayer(name) {
    if (this.phase !== 'lobby') throw new UnoError('GAME_STARTED', 'Game already started');
    this.players.push({ id: this.players.length, name, hand: [], unoAnnounced: false });
    return this.players.length - 1;
  }

  // ---- helpers ----
  nextSeat(seat) {
    return (seat + this.direction + this.n) % this.n;
  }
  giveCards(seat, count) {
    const got = [];
    for (let i = 0; i < count; i++) got.push(this.drawFromPile());
    this.players[seat].hand.push(...got);
    return got;
  }
  drawFromPile() {
    if (this.drawPile.length === 0) {
      if (this.discard.length <= 1) throw new UnoError('DECK_EMPTY', 'No cards left');
      const top = this.discard[this.discard.length - 1];
      const rest = this.discard.slice(0, -1);
      this.drawPile = shuffle(rest, this.random);
      this.discard = [top];
    }
    return this.drawPile.pop();
  }
  findCard(seat, cardId) {
    return this.players[seat].hand.find((c) => c.id === cardId);
  }
  canMatch(card, top) {
    if (isWild(card)) return true;
    if (card.color === this.color) return true;
    if (card.kind === KIND.NUMBER) return top.kind === KIND.NUMBER && card.value === top.value;
    if (top.kind === KIND.NUMBER) return false;
    return card.kind === top.kind;
  }
  mayPlayWild4(seat, card) {
    if (!this.opts.strictWild4) return true;
    const hand = this.players[seat].hand;
    // You may only play +4 when you hold no card of the active color.
    return !hand.some((c) => c.color === this.color);
  }

  // ---- game setup ----
  start() {
    if (this.phase !== 'lobby') throw new UnoError('GAME_STARTED', 'Game already started');
    if (this.n < 2) throw new UnoError('NOT_ENOUGH', 'Need at least 2 players');
    const deck = shuffle(buildDeck(this.n), this.random);
    for (let i = 0; i < this.opts.handSize; i++) {
      for (let p = 0; p < this.n; p++) {
        this.players[p].hand.push(deck.pop());
      }
    }
    // Flip top card; return any wild/wild+4 to the deck and redraw.
    let first;
    do {
      if (deck.length === 0) throw new UnoError('DECK_EMPTY', 'No cards to start');
      first = deck.pop();
    } while (isWild(first));
    this.discard = [first];
    this.drawPile = deck;
    this.color = first.color;
    this.phase = 'playing';
    this.applyFirstCard(first);
    this.turnState = 'awaiting';
    this.last = { kind: 'start', top: first.id };
    return this.snapshot();
  }

  applyFirstCard(first) {
    const firstPlayer = 0;
    if (first.kind === KIND.SKIP) {
      this.current = 1; // player 0 skipped
    } else if (first.kind === KIND.DRAW2) {
      this.giveCards(firstPlayer, 2);
      this.current = 1;
    } else if (first.kind === KIND.REVERSE) {
      if (this.n > 2) {
        this.direction = -1;
        this.current = this.n - 1;
      } else {
        this.current = 1; // reverse acts like skip with 2 players
      }
    } else {
      this.current = 0;
    }
  }

  // ---- turn actions ----
  playCard(seat, cardId, chosenColor = null) {
    this.assertTurn(seat);
    const card = this.findCard(seat, cardId);
    if (!card) throw new UnoError('NO_CARD', `You don't have ${cardLabel({ id: cardId, color: null, kind: '?', value: null })}`);
    if (!this.canMatch(card, this.discard[this.discard.length - 1])) {
      throw new UnoError('ILLEGAL', `${cardLabel(card)} can't be played`);
    }
    if (card.kind === KIND.WILD4 && !this.mayPlayWild4(seat, card)) {
      throw new UnoError('ILLEGAL_WILD4', 'You can’t play +4 while holding a matching color');
    }
    if (this.turnState === 'drawn') {
      if (card.id !== this.drawnCardId) {
        throw new UnoError('NOT_DRAWN_CARD', 'After drawing, you may only play the card you drew');
      }
    }
    if (isWild(card)) {
      if (!COLOR_SET.has(chosenColor)) throw new UnoError('NEED_COLOR', 'Choose a color first');
    }

    // remove card from hand
    this.players[seat].hand.splice(this.players[seat].hand.findIndex((c) => c.id === cardId), 1);
    this.discard.push({ ...card });
    const from = seat;
    this.last = { kind: 'play', seat, cardId, card: cardLabel(card), chosenColor };

    // win?
    if (this.players[seat].hand.length === 0) {
      this.color = isWild(card) ? chosenColor : card.color;
      this.phase = 'roundEnd';
      this.winner = seat;
      this.turnState = 'awaiting';
      return this.snapshot();
    }

    // UNO call check (auto catch): you dropped to exactly 1 card without calling
    if (this.opts.unoPenalty && this.players[seat].hand.length === 1 && !this.players[seat].unoAnnounced) {
      this.giveCards(seat, 2);
      this.players[seat].unoAnnounced = true;
      this.last = { kind: 'unoPenalty', seat };
    }

    // apply effects and advance the turn
    const next = this.applyEffect(card, chosenColor);
    this.current = next;
    this.turnState = 'awaiting';
    this.drawnCardId = null;
    return this.snapshot();
  }

  applyEffect(card, chosenColor) {
    const me = this.current;
    if (!isWild(card)) this.color = card.color;
    else this.color = chosenColor;

    if (card.kind === KIND.REVERSE && this.n > 2) {
      this.direction = -this.direction;
      return this.nextSeat(me);
    }
    if (card.kind === KIND.REVERSE) {
      // 2 players: acts like skip
      return this.nextSeat(this.nextSeat(me));
    }
    if (card.kind === KIND.SKIP) {
      return this.nextSeat(this.nextSeat(me));
    }
    if (card.kind === KIND.DRAW2) {
      const target = this.nextSeat(me);
      this.giveCards(target, 2);
      return this.nextSeat(target);
    }
    if (card.kind === KIND.WILD4) {
      const target = this.nextSeat(me);
      this.giveCards(target, 4);
      return this.nextSeat(target);
    }
    return this.nextSeat(me);
  }

  drawCard(seat) {
    this.assertTurn(seat);
    if (this.turnState === 'drawn') throw new UnoError('ALREADY_DRAWN', 'You already drew a card');
    const card = this.drawFromPile();
    this.players[seat].hand.push(card);
    this.drawnCardId = card.id;
    this.turnState = 'drawn';
    this.last = { kind: 'draw', seat };
    return { card: { ...card }, state: this.snapshot() };
  }

  passTurn(seat) {
    this.assertTurn(seat);
    if (this.turnState !== 'drawn') throw new UnoError('NOT_DRAWN', 'You must play or draw first');
    this.last = { kind: 'pass', seat };
    this.current = this.nextSeat(this.current);
    this.turnState = 'awaiting';
    this.drawnCardId = null;
    return this.snapshot();
  }

  callUno(seat) {
    if (this.phase !== 'playing') throw new UnoError('NOT_PLAYING', 'Game is not running');
    this.players[seat].unoAnnounced = true;
    this.last = { kind: 'uno', seat };
    return this.snapshot();
  }

  assertTurn(seat) {
    if (this.phase !== 'playing') throw new UnoError('NOT_PLAYING', 'Game is not running');
    if (seat !== this.current) throw new UnoError('NOT_YOUR_TURN', 'It is not your turn');
  }

  // ---- snapshots ----
  snapshot() {
    return {
      phase: this.phase,
      direction: this.direction,
      current: this.current,
      color: this.color,
      winner: this.winner,
      turnState: this.turnState,
      drawCount: this.drawPile.length,
      discardTop: { ...this.discard[this.discard.length - 1] },
      players: this.players.map((p) => ({ ...p, hand: undefined })),
      counts: this.players.map((p) => p.hand.length),
      unoAnnounced: this.players.map((p) => p.unoAnnounced),
    };
  }

  // Personalized view: public state + your own hand.
  viewFor(seat) {
    const snap = this.snapshot();
    snap.you = seat;
    snap.hand = this.players[seat].hand.map((c) => ({ ...c }));
    return snap;
  }

  // Game-interface dispatcher used by the host. Maps a generic action object
  // ({kind:'start'|'play'|'draw'|'pass'|'uno', ...}) to the engine methods.
  applyAction(seat, action) {
    const act = action || {};
    switch (act.kind) {
      case 'start': return this.start();
      case 'play': return this.playCard(seat, act.cardId, act.color);
      case 'draw': return this.drawCard(seat);
      case 'pass': return this.passTurn(seat);
      case 'uno': return this.callUno(seat);
      default: throw new UnoError('UNKNOWN_ACT', 'Unknown UNO action');
    }
  }
}

const COLOR_SET = new Set(['red', 'yellow', 'green', 'blue']);
