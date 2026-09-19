// mods.mjs — load player-written board-game mods from <repo>/mods/*.mjs and
// register them into the game registry, so the LAN room can host them exactly
// like the built-in games. Missing directory simply means "no mods".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerGame } from '../engine/games.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MODS_DIR = path.resolve(__dirname, '..', '..', 'mods');

/** Load every *.mjs in the mods dir and register it. Returns the loaded keys. */
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
