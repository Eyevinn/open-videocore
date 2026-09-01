// Spec/route parity check CLI (issue #480).
//
// Fails (non-zero exit) when the set of routes the Fastify app registers does
// not match the set of operations in the generated openapi.json — and reports
// WHICH method+path pairs are missing, not just a count. This guards against an
// entire router silently dropping out of the spec (as the asset-upload router
// did, see #478/#479).
//
// It boots the real app exactly as scripts/generate-openapi.sh does (child
// process, ephemeral port, placeholder OSC env in CI) but with
// OPENAPI_ROUTE_DUMP set, so main.ts writes its captured onRoute inventory to a
// temp file and exits before starting background loops. That inventory — the
// ground truth of what the app serves — is then compared against openapi.json.
//
// Usage:
//   tsx scripts/check-spec-route-parity.ts [path/to/openapi.json]
//
// Env:
//   OPENAPI_ROUTE_DUMP is set internally; do not set it yourself.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  routesToOperations,
  specToOperations,
  compareOperations,
  formatParityReport,
  type RegisteredRoute,
} from '../src/services/spec-route-parity.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);

const specPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : join(repoRoot, 'openapi.json');

// Boot the app with OPENAPI_ROUTE_DUMP so main.ts dumps its registered routes
// and exits. A fixed, non-3000 port avoids colliding with a dev server.
async function dumpRegisteredRoutes(): Promise<RegisteredRoute[]> {
  const tmp = mkdtempSync(join(tmpdir(), 'route-parity-'));
  const dumpPath = join(tmp, 'routes.json');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx/esm', join(repoRoot, 'src/main.ts')],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            PORT: '3998',
            OPENAPI_ROUTE_DUMP: dumpPath,
            // The upload router (src/routes/asset-upload.ts, the 7 routes that
            // dropped out of the spec in #478) is registered only when
            // `storageAvailable` is true — i.e. MINIO_URL set or a param store
            // present (src/main.ts:422). openapi.json is generated with that
            // same gate, so the parity check MUST boot with the same full
            // surface, otherwise a conditionally-registered router missing from
            // the spec would be invisible on BOTH sides and the check would
            // falsely pass. A placeholder URL is enough: registration is plugin
            // wiring only and never connects to MinIO here. Respect an already
            // set MINIO_URL so a real local stack is not overridden.
            MINIO_URL: process.env['MINIO_URL'] ?? 'http://localhost:9000',
          },
          stdio: ['ignore', 'inherit', 'inherit'],
        }
      );
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('app did not dump routes within 60s'));
      }, 60_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`app exited with code ${code} before dumping routes`));
      });
    });
    return JSON.parse(readFileSync(dumpPath, 'utf8')) as RegisteredRoute[];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [routes, specRaw] = await Promise.all([
    dumpRegisteredRoutes(),
    Promise.resolve(readFileSync(specPath, 'utf8')),
  ]);

  const registeredOps = routesToOperations(routes);
  const specOps = specToOperations(JSON.parse(specRaw));
  const result = compareOperations(registeredOps, specOps);

  console.log(
    `Registered documented routes: ${registeredOps.size} | spec operations: ${specOps.size}`
  );
  console.log(formatParityReport(result));

  if (!result.ok) {
    console.error('\nspec/route parity check FAILED');
    process.exit(1);
  }
  console.log('\nspec/route parity check passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
