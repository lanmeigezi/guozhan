// mods-loader.mjs — load player-written board-game mods from the mods/ directory
// and register them into the game registry so the Host / room server can run them
// exactly like the built-in games (UNO, 斗地主, 炸弹猫, 骗子酒馆).
//
// A mod is a single .mjs file in <repo>/mods/ that exports a game definition:
//
//   export const game = {
//     key: 'mygame', name: '我的游戏', card: 'MY', min: 2, max: 6,
//     create: ({ playerNames, options, random }) => new MyGame(...),
//     ai: (game, seat) => ({ kind: '...', ... }) | null,   // optional
//   };
//
// The game class must implement the Game interface documented in MODDING.md.
// See MODDING.md for the module contract.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerGame } from '../core/src/games.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODS_DIR = path.resolve(__dirname, '..', 'mods');

/** Load every *.mjs in the mods/ dir and register it. Returns the loaded keys. */
export async function loadMods(dir = MODS_DIR) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const loaded = [];
  for (const f of files) {
    const fileUrl = pathToFileURL(path.join(dir, f)).href;
    try {
      const mod = await import(fileUrl);
      const def = mod.game || mod.default;
      if (!def || !def.key || typeof def.create !== 'function') {
        console.error(`[mod] ${f}: missing export { game: { key, create, ... } } — skipped`);
        continue;
      }
      if (registerGame(def)) {
        loaded.push(def.key);
        console.log(`[mod] registered '${def.key}' (${def.name || def.key}) from ${f}`);
      }
    } catch (e) {
      console.error(`[mod] failed to load ${f}:`, e && e.message ? e.message : e);
    }
  }
  return loaded;
}
