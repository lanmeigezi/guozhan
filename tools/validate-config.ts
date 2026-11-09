/**
 * 配置校验工具 —— 部署前/CI 的第一道闸。
 *
 * 逐剧本装载（目录扫描发现，不写白名单），任何一处
 * 缺文件 / JSON 语法错 / 字段为 undefined/NaN/Infinity 都会让它退出码非 0。
 *
 * 跑法：node --experimental-strip-types tools/validate-config.ts [configRoot]
 */
import { discoverScenarios, findHoles, loadScenario } from '../src/server/config-loader.ts';

const configRoot = process.argv[2] ?? 'config';
const ids = discoverScenarios(configRoot);

if (ids.length === 0) {
  process.stderr.write(`guozhan: ${configRoot}/scenarios/ 下没有发现任何剧本目录\n`);
  process.exit(1);
}

let failed = 0;
const rows: string[][] = [];
for (const id of ids) {
  try {
    const loaded = loadScenario(id, undefined, configRoot);
    const holes = findHoles({ world: loaded.world, state: loaded.initialState });
    if (holes.length > 0) {
      failed++;
      process.stderr.write(`guozhan: 剧本 ${id} 有 ${holes.length} 处未定义值：\n  ${holes.slice(0, 10).join('\n  ')}\n`);
      continue;
    }
    rows.push([
      id,
      loaded.meta.name,
      String(loaded.meta.maxTurns),
      String(Object.keys(loaded.initialState.regions).length),
      String(Object.keys(loaded.initialState.factions).length),
      String(loaded.meta.moduleOrder.join(',')),
      String(loaded.meta.behaviorFingerprint),
      loaded.contentHash.slice(0, 12),
    ]);
  } catch (err) {
    failed++;
    process.stderr.write(`guozhan: 剧本 ${id} 装载失败 —— ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

const head = ['id', 'name', 'maxTurns', 'regions', 'factions', 'modules', 'fingerprint', 'contentHash'];
process.stdout.write(`${head.join('\t')}\n`);
for (const r of rows) process.stdout.write(`${r.join('\t')}\n`);

if (failed > 0) {
  process.stderr.write(`guozhan: ${failed} 个剧本校验失败\n`);
  process.exit(1);
}
process.stdout.write(`guozhan: ${rows.length} 个剧本校验通过\n`);
