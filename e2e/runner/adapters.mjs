// Real adapters. Contract sources (verified 2026-10-08):
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
export const SERVICE_ID = 'eyevinn-open-videocore';

/**
 * The commit the `:latest` image was built from, read from the registry. The platform builds the image without git
 * metadata, so GET /health reports build.commit/sourceDigest as "unknown" (verified on a live beta instance
 * 2026-10-08); the image itself carries the commit as the label io.osaas.repo.commit (confirmed on the image).
 * Contract: the OCI distribution API. GET https://ghcr.io/token?service=ghcr.io&scope=repository:<image>:pull with
 * Basic auth returns {token}; GET /v2/<image>/manifests/<tag> returns an image index (manifests[] with
 * platform.os/architecture) or a manifest (config.digest); GET /v2/<image>/blobs/<config digest> is the image config
 * JSON, whose labels are config.Labels (some tools print them lowercase, so both are read).
 * The package is private: anonymous requests get 401 (checked), so this needs a read:packages token. The
 * authenticated path has NOT been exercised yet; the first live run is the test.
 * @param {{ user: string, token: string, image?: string, tag?: string, fetchImpl?: typeof fetch }} opts
 */
export function registryAdapter({ user, token, image = 'eyevinn-osaas/open-videocore', tag = 'latest', fetchImpl = fetch }) {
  const ACCEPT = 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json';
  const get = async (url, bearer, extra = {}) => {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${bearer}`, ...extra }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`registry ${new URL(url).pathname.split('/').slice(3, 4)[0] ?? 'request'} returned HTTP ${res.status}`);
    return res;
  };
  return {
    /** @returns {Promise<{ digest: string, commit: string }>} digest = what the tag points to now */
    async latest() {
      const basic = Buffer.from(`${user}:${token}`).toString('base64');
      const t = await fetchImpl(`https://ghcr.io/token?service=ghcr.io&scope=repository:${image}:pull`, { headers: { authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(30_000) });
      if (!t.ok) throw new Error(`registry token exchange returned HTTP ${t.status}`);
      const bearer = (await t.json()).token;
      if (!bearer) throw new Error('registry token exchange returned no token');
      const top = await get(`https://ghcr.io/v2/${image}/manifests/${tag}`, bearer, { accept: ACCEPT });
      const digest = top.headers.get('docker-content-digest');
      let manifest = await top.json();
      if (Array.isArray(manifest.manifests)) { // an index: take the linux/amd64 image, never an attestation
        const pick = manifest.manifests.find((m) => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64')
          ?? manifest.manifests.find((m) => m.platform?.architecture && m.platform.architecture !== 'unknown');
        if (!pick?.digest) throw new Error('image index has no usable platform manifest');
        manifest = await (await get(`https://ghcr.io/v2/${image}/manifests/${pick.digest}`, bearer, { accept: ACCEPT })).json();
      }
      const cfgDigest = manifest.config?.digest;
      if (!cfgDigest) throw new Error('manifest has no config digest');
      const cfg = await (await get(`https://ghcr.io/v2/${image}/blobs/${cfgDigest}`, bearer)).json();
      const labels = cfg.config?.Labels ?? cfg.config?.labels ?? {};
      const commit = labels['io.osaas.repo.commit'];
      if (!/^[0-9a-f]{40}$/.test(String(commit))) throw new Error('image has no usable io.osaas.repo.commit label');
      if (!digest) throw new Error('registry returned no docker-content-digest');
      return { digest, commit };
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
