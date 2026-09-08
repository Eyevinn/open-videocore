// Execute-path external-backend OUTPUT wiring tests (issue #549, ADR-017 D4).
//
// POST /api/v1/assets/:id/execute may reference a REGISTERED external storage
// backend (by id or name) via the optional `externalBackend` body field so this
// execution's transcode/package OUTPUT is written to that backend's bucket
// instead of OSC-managed default storage. The reference is resolved at JOB TIME
// against the StorageBackendRegistry to the backend's NON-SECRET coordinates and
// translated into the per-execution `destinationBucket` the post-package
// relocation path (ADR-011) already consumes — credentials are NEVER inline and
// NEVER persisted on the execution record.
//
// Acceptance mapped:
//   - a job targeting a registered external backend records that bucket as its
//     output destination (persisted on the execution as `destinationBucket`);
//   - the default output path is UNCHANGED when no external backend is
//     referenced (no destinationBucket persisted).
//
// Harness mirrors test/execute-profile-params.test.ts (current single-arg
// repository signatures) so it is unaffected by the workspace-scoping drift that
// 409s test/transcode.test.ts.

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = { 'token-a': 'workspace-a' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { DEPLOYMENT_CONTEXT } from '../src/auth/workspace.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import {
  StorageBackendRegistry,
  InMemoryBackendRecordStore,
  type SecretStore
} from '../src/services/storage-backend-registry.js';
import type { EncoreClient, EncoreSubmitInput } from '../src/pipeline/encore-client.js';

const A = { authorization: 'Bearer token-a' };
const RAW_SECRET = 'raw-secret-value';

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  pipelines: InMemoryPipelineRepository;
  registry: StorageBackendRegistry;
  saveSecret: ReturnType<typeof vi.fn>;
};

function fakeEncore(): EncoreClient {
  return {
    submit: vi.fn(async (_input: EncoreSubmitInput) => ({ encoreInternalId: 'enc-1' })),
    getJobStatus: vi.fn(),
    cancel: vi.fn()
  } as unknown as EncoreClient;
}

async function buildApp(opts: { withRegistry: boolean } = { withRegistry: true }): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();
  const saveSecret = vi.fn(async (_s: string, _n: string, _v: string) => {});
  const secretStore: SecretStore = { saveSecret };
  const registry = new StorageBackendRegistry(new InMemoryBackendRecordStore(), secretStore);

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: jobs,
    pipelineRepository: pipelines,
    encore: fakeEncore(),
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket',
    ...(opts.withRegistry ? { storageBackendRegistry: registry } : {})
  });
  await app.ready();
  return { app, assets, pipelines, registry, saveSecret };
}

async function makeSource(h: Harness, name = 'my-video'): Promise<string> {
  const asset = await h.assets.create({ name, objectKey: `ingest/${name}` });
  return asset.id;
}

// Register an external backend under the DEPLOYMENT_CONTEXT workspace the execute
// route resolves against.
async function register(
  h: Harness,
  over: Partial<{ name: string; role: 'source' | 'packaged' | 'both' | 'archive'; bucket: string }> = {}
) {
  return h.registry.register(DEPLOYMENT_CONTEXT, {
    name: over.name ?? 'our-bucket',
    role: over.role ?? 'packaged',
    bucket: over.bucket ?? 'external-out',
    accessKeyId: 'AKIA',
    secretAccessKey: RAW_SECRET,
    endpointUrl: 'https://s3.example.test'
  });
}

describe('execute external-backend output (issue #549)', () => {
  it('writes output to the registered backend bucket when referenced by id', async () => {
    const h = await buildApp();
    const view = await register(h);
    const sourceId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${sourceId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', profile: 'program', externalBackend: view.id }
    });

    expect(res.statusCode).toBe(202);
    const execs = await h.pipelines.listByAsset(sourceId);
    expect(execs).toHaveLength(1);
    // The registered backend's bucket is recorded as this execution's output
    // destination, in the s3:// form the relocation path consumes.
    expect(execs[0].destinationBucket).toBe('s3://external-out/');
    // No credential material is ever persisted on the execution record.
    expect(JSON.stringify(execs[0])).not.toContain(RAW_SECRET);
  });

  it('resolves a registered backend referenced by name', async () => {
    const h = await buildApp();
    await register(h, { name: 'my-cold-store', bucket: 'cold' });
    const sourceId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${sourceId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', profile: 'program', externalBackend: 'my-cold-store' }
    });

    expect(res.statusCode).toBe(202);
    const execs = await h.pipelines.listByAsset(sourceId);
    expect(execs[0].destinationBucket).toBe('s3://cold/');
  });

  it('leaves the default output path unchanged when no backend is referenced', async () => {
    const h = await buildApp();
    await register(h);
    const sourceId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${sourceId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', profile: 'program' }
    });

    expect(res.statusCode).toBe(202);
    const execs = await h.pipelines.listByAsset(sourceId);
    // No override recorded -> later stages use OSC-managed default storage.
    expect(execs[0].destinationBucket).toBeUndefined();
  });

  it('rejects an unknown backend reference with 422', async () => {
    const h = await buildApp();
    const sourceId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${sourceId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', profile: 'program', externalBackend: 'does-not-exist' }
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('unknown_backend');
    expect(await h.pipelines.listByAsset(sourceId)).toHaveLength(0);
  });

  it('rejects a source-only backend for output with 422', async () => {
    const h = await buildApp();
    const view = await register(h, { role: 'source' });
    const sourceId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${sourceId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', profile: 'program', externalBackend: view.id }
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('backend_role');
  });

  it('rejects an archive-role backend for output with 422', async () => {
    // 'archive' is a valid StorageBackendRole but is NOT write-capable: its
    // secret fans only to source-reader consumers (mappingsForRole), never the
    // packager. ADR-017 D4 admits only 'packaged'/'both' for output, so an
    // archive backend referenced as the output target must be rejected.
    const h = await buildApp();
    const view = await register(h, { role: 'archive' });
    const sourceId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${sourceId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', profile: 'program', externalBackend: view.id }
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('backend_role');
    // The message reflects the actual referenced role, not a hardcoded "source".
    expect(res.json().message).toContain('"archive"');
    expect(await h.pipelines.listByAsset(sourceId)).toHaveLength(0);
  });

  it('rejects supplying both externalBackend and destinationBucket with 400', async () => {
    const h = await buildApp();
    const view = await register(h);
    const sourceId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${sourceId}/execute`,
      headers: A,
      payload: {
        pipeline: 'abr-vod',
        profile: 'program',
        externalBackend: view.id,
        destinationBucket: 'other-bucket/'
      }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('responds 501 when the registry is not configured on the deployment', async () => {
    const h = await buildApp({ withRegistry: false });
    const sourceId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${sourceId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', profile: 'program', externalBackend: 'our-bucket' }
    });

    expect(res.statusCode).toBe(501);
  });

  it('treats the implicit OSC-managed default id as "no override" (default path)', async () => {
    const h = await buildApp();
    const sourceId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${sourceId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', profile: 'program', externalBackend: 'default' }
    });

    // 'default' is the implicit OSC-managed backend (ADR-017 D3), not an external
    // one -> it means "use the default output path", identical to omitting the
    // field. The execution starts with NO destinationBucket recorded.
    expect(res.statusCode).toBe(202);
    const execs = await h.pipelines.listByAsset(sourceId);
    expect(execs[0].destinationBucket).toBeUndefined();
  });
});
