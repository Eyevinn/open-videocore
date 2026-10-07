// Real adapters. Contract sources:
//  - GitHub REST  GET /repos/{owner}/{repo}/commits/{ref}  -> { sha }
//  - GHCR (OCI distribution API) token exchange + HEAD /v2/<name>/manifests/<tag> -> Docker-Content-Digest.
//    NOT verified authenticated: the package is private (anonymous token -> 401, checked 2026-10-07).
//  - OSC: @osaas/client-core 0.24.0 lib/core.d.ts and lib/context.d.ts
//      Context(config?), ctx.getServiceAccessToken(serviceId), createInstance(ctx, serviceId, sat, body),
//      getInstance(ctx, serviceId, name, sat), restartInstance(ctx, serviceId, name, sat),
//      waitForInstanceReady(serviceId, name, ctx); instance.url (documented in createInstance's example).
//    Service config from get-service-schema eyevinn-open-videocore: name, OscAccessToken, ParameterStoreApiKey,
//    ParameterStore, MinioRootPassword, CouchdbAdminPassword (required). Instance names: ^[a-z0-9]+$, max 20.
export const SERVICE_ID = 'eyevinn-open-videocore';

export function githubAdapter({ repo = 'Eyevinn/open-videocore', token, fetchImpl = fetch } = {}) {
  return {
    async headSha() {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/commits/main`, {
        headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) throw new Error(`GitHub commits/main returned HTTP ${res.status}`);
      const { sha } = await res.json();
      if (!sha) throw new Error('GitHub response has no sha');
      return sha;
    },
  };
}

export function registryAdapter({ image = 'eyevinn-osaas/open-videocore', tag = 'latest', user, token, fetchImpl = fetch } = {}) {
  return {
    async latestDigest() {
      const basic = Buffer.from(`${user}:${token}`).toString('base64');
      const t = await fetchImpl(`https://ghcr.io/token?service=ghcr.io&scope=repository:${image}:pull`, { headers: { authorization: `Basic ${basic}` } });
      if (!t.ok) throw new Error(`GHCR token exchange returned HTTP ${t.status}`);
      const bearer = (await t.json()).token;
      const m = await fetchImpl(`https://ghcr.io/v2/${image}/manifests/${tag}`, {
        method: 'HEAD',
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' },
      });
      const digest = m.headers.get('docker-content-digest');
      if (!m.ok || !digest) throw new Error(`GHCR manifest HEAD returned HTTP ${m.status}`);
      return digest;
    },
  };
}

/** @param {{ name: string, env: Record<string,string|undefined>, importCore?: () => Promise<any> }} opts */
export function oscInstanceAdapter({ name, env, importCore = () => import('@osaas/client-core') }) {
  return {
    async ensureFresh() {
      const core = await importCore();
      const ctx = new core.Context({ personalAccessToken: env.OSC_ACCESS_TOKEN, environment: env.OSC_ENV ?? 'prod' });
      const sat = await ctx.getServiceAccessToken(SERVICE_ID);
      let existing;
      try { existing = await core.getInstance(ctx, SERVICE_ID, name, sat); } catch { existing = undefined; }
      if (existing && existing.name === name) {
        await core.restartInstance(ctx, SERVICE_ID, name, sat); // picks up the latest image
      } else {
        existing = await core.createInstance(ctx, SERVICE_ID, sat, {
          name,
          OscAccessToken: env.E2E_INSTANCE_OSC_ACCESS_TOKEN,
          ParameterStoreApiKey: env.E2E_PARAMETER_STORE_API_KEY,
          ParameterStore: env.E2E_PARAMETER_STORE,
          MinioRootPassword: env.E2E_MINIO_ROOT_PASSWORD,
          CouchdbAdminPassword: env.E2E_COUCHDB_ADMIN_PASSWORD,
        });
      }
      await core.waitForInstanceReady(SERVICE_ID, name, ctx);
      const inst = await core.getInstance(ctx, SERVICE_ID, name, sat);
      if (!inst?.url) throw new Error('instance has no url');
      return { baseUrl: inst.url, token: sat };
    },
  };
}

export async function healthProbe(baseUrl, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    return (await res.json())?.build;
  } catch { return undefined; }
}
