// game-error.js — shared error type for every game rules engine.
// A GameError carries a stable code so the host can turn it into a friendly
// message without knowing the game's internals.

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}
