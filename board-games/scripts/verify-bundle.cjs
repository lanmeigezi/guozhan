// verify-bundle.cjs — sanity-check the generated UNOKU bundle (CommonJS).
// The bundle is a classic script that assigns `window.UNOKU`. The package is
// `"type": "module"`, so requiring the .js file would be treated as ESM and
// yield an empty namespace; evaluate it with an explicit window instead.
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www', 'uno-core.bundle.js'), 'utf8');
const U = new Function('window', source + '\nreturn window.UNOKU;')({});

let failures = 0;
function check(name, cond) {
  if (cond) console.log('ok  ' + name);
  else { console.log('FAIL ' + name); failures++; }
}

check('exposes UNOKU', !!U);
check('buildDeck() has 108', U.buildDeck().length === 108);
check('UnoError is a class', typeof U.UnoError === 'function');
check('UnoGame is a class', typeof U.UnoGame === 'function');
check('createLoopbackPair is a fn', typeof U.createLoopbackPair === 'function');
check('encodeMessage is a fn', typeof U.encodeMessage === 'function');
check('Client/Host are classes', typeof U.Client === 'function' && typeof U.Host === 'function');
check('mulberry32 is a fn', typeof U.mulberry32 === 'function');

// quick rules check using the bundle
const g = new U.UnoGame({ playerNames: ['A', 'B'], random: U.mulberry32(2) });
g.start();
check('dealt 7 cards each', g.players.every((p) => p.hand.length === 7));
check('phase playing', g.phase === 'playing');

process.exit(failures ? 1 : 0);
