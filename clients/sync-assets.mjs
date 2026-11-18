// Mirror the byte-identical WebView assets into every client project.
// Run once after changing board-games/app/src/main/assets/www:
//   node clients/sync-assets.mjs
// Uses copyFileSync (not cpSync) for stable behaviour on non-ASCII Windows paths.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'board-games', 'app', 'src', 'main', 'assets', 'www');
if (!existsSync(join(src, 'index.html'))) {
  throw new Error(`缺少源资源：${src}/index.html`);
}
const targets = [
  join(root, 'clients', 'android', 'app', 'src', 'main', 'assets', 'www'),
  join(root, 'clients', 'ios', 'BoardGames', 'www'),
  join(root, 'clients', 'harmony', 'entry', 'src', 'main', 'resources', 'rawfile', 'www'),
];

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const s = join(from, name);
    const d = join(to, name);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

for (const target of targets) {
  copyTree(src, target);
  console.log(`synced -> ${target}`);
}
