#!/usr/bin/env node
// Usage: BASE_URL=... TOKEN=... SOURCE_URL=... [EXPECT_COMMIT=...] [RUN_ID=...] node suite/cli.mjs
// Prints the suite result as JSON on stdout; exit 0 when green, 1 when red, 2 on bad config.
import { createClient, runSuite } from './run.mjs';

const need = (k) => { if (!process.env[k]) { console.error(`missing env ${k}`); process.exit(2); } return process.env[k]; };
const baseUrl = need('BASE_URL');
const token = need('TOKEN');
const sourceUrl = need('SOURCE_URL');
const runId = process.env.RUN_ID ?? new Date().toISOString().replace(/\D/g, '').slice(0, 14);

const result = await runSuite({
  client: createClient({ baseUrl, token }),
  anon: createClient({ baseUrl }),
  config: { runId, sourceUrl, expectCommit: process.env.EXPECT_COMMIT },
});
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === 'green' ? 0 : 1);
