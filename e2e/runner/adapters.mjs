// Real adapters. Contract sources (verified 2026-10-08):
//  - Local source identity: `git rev-parse HEAD` and `node scripts/source-digest.mjs <root>` of the checkout the job
//    runs from (the job pod clones the repo; scripts/source-digest.mjs is the product's own digest, also reported by
//    GET /health as build.sourceDigest).
//  - OSC, @osaas/client-core 0.24.0 (lib/core.d.ts, lib/context.d.ts, lib/index.d.ts):
//      new Context({personalAccessToken, environment}); ctx.getServiceAccessToken(serviceId);
//      getInstance / restartInstance / removeInstance(ctx, serviceId, name, sat); waitForInstanceReady(serviceId, name, ctx);
//      createFetch(url, init). createInstance() cannot add query parameters, so a BETA instance is created the way the
//      platform's own MCP tool does it (osaas-ai src/mcp/tools/services.ts, create-service-instance with useLatest):
//      POST <service.apiUrl>?beta=true with headers {x-jwt: Bearer <sat>, Content-Type: application/json}, body = config.
//      service.apiUrl comes from GET https://catalog.svc.<env>.osaas.io/mysubscriptions (header x-pat-jwt: Bearer <PAT>),
//      the same call client-core's internal getService makes.
//    The running channel is read from GET https://<apiHost>/health/<name> (header x-jwt) -> { images: [...] }; an image
//    ending in ":stable" means the stable channel (describe-service-instance does the same).
//    Calls to the instance itself use `x-jwt: Bearer <sat>` (platform call-service-endpoint); anonymous calls get nginx's 401.
//  - Service config from get-service-schema eyevinn-open-videocore: name, OscAccessToken, ParameterStoreApiKey,
//    ParameterStore, MinioRootPassword, CouchdbAdminPassword (required). Instance names: ^[a-z0-9]+$, max 20.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const SERVICE_ID = 'eyevinn-open-videocore';

/** @param {{ repoRoot: string, exec?: typeof execFileSync }} opts */
export function localSource({ repoRoot, exec = execFileSync }) {
  const run = (cmd, args) => String(exec(cmd, args, { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 })).trim();
  return {
    async expected() {
      const commit = run('git', ['rev-parse', 'HEAD']);
      const sourceDigest = run('node', [path.join('scripts', 'source-digest.mjs'), repoRoot]);
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('git rev-parse HEAD did not return a commit sha');
      if (!sourceDigest) throw new Error('source-digest.mjs printed nothing');
      return { commit, sourceDigest };
    },
  };
}

/** @param {{ name: string, env: Record<string,string|undefined>, importCore?: () => Promise<any>, waitGoneMs?: number, sleep?: (ms:number)=>Promise<void> }} opts */
export function oscInstanceAdapter({ name, env, importCore = () => import('@osaas/client-core'), waitGoneMs = 4 * 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const config = () => ({
    name,
    OscAccessToken: env.E2E_INSTANCE_OSC_ACCESS_TOKEN,
    ParameterStoreApiKey: env.E2E_PARAMETER_STORE_API_KEY,
    ParameterStore: env.E2E_PARAMETER_STORE,
    MinioRootPassword: env.E2E_MINIO_ROOT_PASSWORD,
    CouchdbAdminPassword: env.E2E_COUCHDB_ADMIN_PASSWORD,
  });
  return {
    async ensureFresh() {
      const core = await importCore();
      const ctx = new core.Context({ personalAccessToken: env.OSC_ACCESS_TOKEN, environment: env.OSC_ENV ?? 'prod' });
      const sat = await ctx.getServiceAccessToken(SERVICE_ID);
      const subs = await core.createFetch(new URL(`https://catalog.svc.${ctx.getEnvironment()}.osaas.io/mysubscriptions`), {
        method: 'GET', headers: { 'x-pat-jwt': `Bearer ${ctx.getPersonalAccessToken()}`, 'Content-Type': 'application/json' },
      });
      const service = subs.find((s) => s.serviceId === SERVICE_ID);
      if (!service?.apiUrl) throw new Error(`service ${SERVICE_ID} not found in the subscriptions`);

      let existing;
      try { existing = await core.getInstance(ctx, SERVICE_ID, name, sat); } catch { existing = undefined; }
      if (existing && existing.name === name) {
        // A stable-channel instance can never test the beta image, and restarting it keeps it on stable. It is the
        // runner's own test instance (fixed name, test data only), so remove it and create it on the beta channel.
        const apiHost = new URL(service.apiUrl).host;
        const healthPath = existing._links?.health?.href ?? `/health/${name}`;
        let images = [];
        try {
          const h = await core.createFetch(new URL(`https://${apiHost}${healthPath}`), { method: 'GET', headers: { 'x-jwt': `Bearer ${sat}` } });
          images = h?.images ?? [];
        } catch { /* unknown channel: treat as not stable, restart */ }
        if (images.some((i) => String(i).includes(':stable') || String(i).endsWith('-stable'))) {
          await core.removeInstance(ctx, SERVICE_ID, name, sat);
          const deadline = Date.now() + waitGoneMs;
          for (;;) {
            let gone = false;
            try { const g = await core.getInstance(ctx, SERVICE_ID, name, sat); gone = !g || g.name !== name; } catch { gone = true; }
            if (gone) break;
            if (Date.now() > deadline) throw new Error(`removed ${name} (stable channel) is still present after ${waitGoneMs} ms`);
            await sleep(10_000);
          }
          existing = undefined;
        } else {
          await core.restartInstance(ctx, SERVICE_ID, name, sat); // beta instance: picks up the latest image
        }
      }
      if (!existing) {
        const url = new URL(service.apiUrl);
        url.searchParams.set('beta', 'true');
        await core.createFetch(url, {
          method: 'POST', body: JSON.stringify(config()), headers: { 'x-jwt': `Bearer ${sat}`, 'Content-Type': 'application/json' },
        });
      }
      await core.waitForInstanceReady(SERVICE_ID, name, ctx);
      const inst = await core.getInstance(ctx, SERVICE_ID, name, sat);
      if (!inst?.url) throw new Error('instance has no url');
      return { baseUrl: inst.url, token: sat };
    },
  };
}

/** GET /health through the ingress with the service access token; undefined when not up or not authenticated. */
export async function healthProbe({ baseUrl, token }, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/health`, { headers: { 'x-jwt': `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    return (await res.json())?.build;
  } catch { return undefined; }
}
