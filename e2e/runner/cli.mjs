#!/usr/bin/env node
// One cycle. Env: see wire.mjs and README.
// Exit 0 whenever the cycle ran to a recorded outcome or a skip, whatever the verdict: green, red, stale and infra-error
// are all RESULTS and live in the results store (results/by-commit/<sha>.json). The OSC job platform re-runs a job
// that exits non-zero (observed 2026-10-08, despite its documentation saying "no retry"), so a red or stale verdict
// that exited 1 would be repeated on the same commit, restarting the instance each time. A non-zero exit therefore
// means only that the runner itself broke: 2 = configuration, 1 = an unexpected error (e.g. the registry lookup).
import { runCycle } from './cycle.mjs';
import { buildDeps, ConfigError } from './wire.mjs';

let deps;
try { deps = await buildDeps(process.env); } catch (e) {
  if (e instanceof ConfigError) { console.error(e.message); process.exit(2); }
  throw e;
}
const out = await runCycle(deps);
console.log(JSON.stringify(out, null, 2));
process.exit(0);
