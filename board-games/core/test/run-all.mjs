// run-all.mjs — runs every test file in-process (the default node:test runner
// spawns one child per file, which is blocked in some sandboxes). Importing the
// test modules registers their top-level tests into the active runner.
// ★新增测试文件必须在此登记，否则 npm test 不会跑到（发现机制是静态的）。
import './uno.test.js';
import './doudizhu.test.js';
import './exploding.test.js';
import './exploding-nope.test.js';
import './liarsbar.test.js';
import './protocol.test.js';
import './game.test.js';
import './ws.test.js';
import './guozhan.test.js';
import './monopoly.test.js';
import './monopoly-expansion.test.js';
import './scoreboard.test.js';
import './werewolf.test.js';
import './llm-seat.test.js';
import './bot-driver.test.js';
import './chat.test.js';
import './save-state.test.js';
