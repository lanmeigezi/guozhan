// leaderboard.mjs — append-only score persistence for the room server.
//
// One JSONL line per human seat per finished match. Appending is cheap and
// cross-process safe enough for a LAN room; aggregation is done on read with
// the pure core helper. Device ids are hashed before they touch disk so the
// leaderboard API never exposes a stable device identifier.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { aggregateScoreEvents, scoreEventsFromResult } from '../core/src/scoreboard.js';

function hashKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
}

export class LeaderboardStore {
  constructor({ dir } = {}) {
    this.dir = dir || path.join(process.cwd(), 'data');
    this.file = path.join(this.dir, 'leaderboard.jsonl');
    this._seen = null;
  }

  _readEvents() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const events = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev && typeof ev === 'object') events.push(ev);
      } catch (_) { /* ignore a torn/corrupt line instead of taking the API down */ }
    }
    return events;
  }

  _ensureSeen() {
    if (this._seen) return;
    this._seen = new Set(this._readEvents().map((ev) => ev.id));
  }

  /** @returns {number} newly appended human events */
  appendResult(result) {
    const events = scoreEventsFromResult(result);
    if (!events.length) return 0;
    this._ensureSeen();
    const lines = [];
    for (const ev of events) {
      if (this._seen.has(ev.id)) continue;
      this._seen.add(ev.id);
      lines.push(JSON.stringify({ ...ev, playerKey: hashKey(ev.playerKey) }));
    }
    if (!lines.length) return 0;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file, lines.join('\n') + '\n');
    return lines.length;
  }

  list({ range = 'all', limit = 50 } = {}) {
    const rows = aggregateScoreEvents(this._readEvents(), { range });
    return rows.slice(0, Math.max(1, Math.min(100, limit)));
  }
}
