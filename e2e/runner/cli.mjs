#!/usr/bin/env node
// One cycle. Env: see wire.mjs and README. Exit 0 only when the commit's result is green (fresh or already
// recorded); anything else exits 1 so a scheduler flags it, including a red result found on a skip. 2 = config.
import { runCycle } from './cycle.mjs';
import { buildDeps, ConfigError } from './wire.mjs';

let deps;
try { deps = await buildDeps(process.env); } catch (e) {
  if (e instanceof ConfigError) { console.error(e.message); process.exit(2); }
  throw e;
}
const out = await runCycle(deps);
console.log(JSON.stringify(out, null, 2));
process.exit(out.status === 'green' ? 0 : 1);
