// run-all.mjs — runs every test file in-process.
//
// The default node:test runner spawns one child process per file, which some
// sandboxes block; importing the modules registers their tests into the runner
// already active here, so everything runs in one process.
//
//   node test/run-all.mjs
import './uno.test.js';
import './doudizhu.test.js';
import './exploding.test.js';
import './liarsbar.test.js';
import './protocol.test.js';
import './game.test.js';
import './bluetooth.test.js';
import './ws.test.js';
import './discovery.test.js';
