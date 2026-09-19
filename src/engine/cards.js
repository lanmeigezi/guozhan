// cards.js — UNO deck and card model.
// Pure data + deterministic helpers. No dependencies.

export const COLORS = ['red', 'yellow', 'green', 'blue'];

// "normal" action cards carry a color; wild cards are colorless.
export const KIND = {
  NUMBER: 'number',
  SKIP: 'skip',
  REVERSE: 'reverse',
  DRAW2: 'draw2',
  WILD: 'wild',
  WILD4: 'wild4',
};

const ACTION_KINDS = new Set([KIND.SKIP, KIND.REVERSE, KIND.DRAW2]);
const WILD_KINDS = new Set([KIND.WILD, KIND.WILD4]);

export function isWild(card) {
  return WILD_KINDS.has(card.kind);
}
export function isAction(card) {
  return card.kind !== KIND.NUMBER && !WILD_KINDS.has(card.kind);
}
export function isColorCard(card) {
  return card.kind === KIND.NUMBER || ACTION_KINDS.has(card.kind);
}

// Build the deck. `playerCount` (default 4) scales the deck size so that games
// with many players — e.g. the host plus a self-chosen number of AI opponents —
// never starve the draw pile. The base (<= 4 players) is the standard 108-card
// deck; each additional pair of players adds one extra copy of every colored
// number 1-9 + every colored action card + one extra wild / wild+4
// (size = 108 + 50 * extra, extra = floor((playerCount - 4) / 2)).
//   4 colors x (1 zero + 9 numbers x2 + 3 actions x2) = 4 x 25 = 100
//   + 4 wild + 4 wild+4 = 108
export function buildDeck(playerCount = 4) {
  const n = Math.max(2, playerCount | 0 || 4);
  const extra = Math.max(0, Math.floor((n - 4) / 2)); // extra copies per card type
  const deck = [];
  let id = 1; // unique suffix so duplicate-valued cards keep distinct ids
  for (const color of COLORS) {
    pushCards(deck, color, KIND.NUMBER, 0, 1, id); id += 1;
    for (let v = 1; v <= 9; v++) {
      pushCards(deck, color, KIND.NUMBER, v, 2 + extra, id); id += 2 + extra;
    }
    for (const k of [KIND.SKIP, KIND.REVERSE, KIND.DRAW2]) {
      pushCards(deck, color, k, null, 2 + extra, id); id += 2 + extra;
    }
  }
  for (let i = 0; i < 4 + extra; i++) { deck.push(mkCard(null, KIND.WILD, null, id)); id += 1; }
  for (let i = 0; i < 4 + extra; i++) { deck.push(mkCard(null, KIND.WILD4, null, id)); id += 1; }
  return deck;
}

function pushCards(deck, color, kind, value, copies, startId) {
  for (let i = 0; i < copies; i++) deck.push(mkCard(color, kind, value, startId + i));
  return true;
}

function mkCard(color, kind, value, unique) {
  return {
    id: `c4-${color ?? 'x'}-${kind}${value ?? ''}-${unique ?? ''}`,
    color, // null for wilds
    kind,
    value, // number 0..9, or null
  };
}

export function cardLabel(card) {
  if (card.kind === KIND.WILD) return 'Wild';
  if (card.kind === KIND.WILD4) return 'Wild +4';
  const names = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue' };
  const v = card.kind === KIND.NUMBER ? String(card.value) : { skip: 'Skip', reverse: 'Reverse', draw2: '+2' }[card.kind];
  return `${names[card.color]} ${v}`;
}

// Fisher–Yates shuffle using a provided RNG (default Math.random) so tests are deterministic.
export function shuffle(array, random = Math.random) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Deterministic seeded RNG (mulberry32) for reproducible games in tests.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
