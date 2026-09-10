// Job -> named export-destination reference tests (issue #573).
//
// A package/publish job may reference a NAMED export destination by id/name via
// the new `destination` field on POST /api/v1/assets/:id/execute and
// POST /api/v1/assets/:id/package, resolving it server-side to the SAME
// per-execution `destinationBucket` string the ADR-011 post-package relocation
// path already consumes (output-relocation.ts parseDestination).
//
// This is a RESOLUTION LAYER, not a new delivery mechanism: a job referencing an
// existing named destination must persist the identical `destinationBucket` an
// equivalent inline override would. The inline override path must keep working
// unchanged (non-breaking), and supplying BOTH a named reference and an inline
// override on the same job is ambiguous and rejected with 400.
//
// Contract symbols exercised:
//   - StorageBackendRegistry.resolveDestinationBucket (src/services/storage-backend-registry.ts)
//   - StorageBackendRegistry.register / findByRef (id + name resolution)
//   - resolveJobDestination edge resolver on the assets router (src/routes/assets.ts)
//   - PipelineExecution.destinationBucket persisted for the relocation (src/data/pipeline-repo.ts)
//
// Harness mirrors test/execute-profile-params.test.ts (current single-arg repo
// signatures) so it is unaffected by the two-arg workspace-scoping drift.

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import {
  StorageBackendRegistry,
  InMemoryBackendRecordStore,
  type SecretStore,
  type StorageBackendRole
} from '../src/services/storage-backend-registry.js';
import { STACK_CONFIG_NAMESPACE } from '../src/services/workspace-stack.js';
import type { EncoreClient, EncoreSubmitInput } from '../src/pipeline/encore-client.js';

const A = { authorization: 'Bearer token-a' };

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  pipelines: InMemoryPipelineRepository;
  registry: StorageBackendRegistry;
  submitted: EncoreSubmitInput[];
};

function fakeEncore(): { client: EncoreClient; submitted: EncoreSubmitInput[] } {
  const submitted: EncoreSubmitInput[] = [];
  const client = {
    submit: vi.fn(async (input: EncoreSubmitInput) => {
      submitted.push(input);
      return { encoreInternalId: 'encore-internal-1' };
    }),
    getJobStatus: vi.fn(),
    cancel: vi.fn()
  } as unknown as EncoreClient;
  return { client, submitted };
}

// A no-op SecretStore so register() persists the non-secret record. Destination
// resolution never reads secrets, so a recording stub is sufficient.
function fakeSecretStore(): SecretStore {
  return { saveSecret: vi.fn(async () => {}) };
}

async function buildApp(): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();
  const registry = new StorageBackendRegistry(
    new InMemoryBackendRecordStore(),
    fakeSecretStore()
  );
  const { client, submitted } = fakeEncore();

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: jobs,
    pipelineRepository: pipelines,
    encore: client,
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket',
    packaging: {} as never,
    storageBackendRegistry: registry
  });
  await app.ready();
  return { app, assets, pipelines, registry, submitted };
}

async function makeSource(h: Harness, name = 'my-video'): Promise<string> {
  const asset = await h.assets.create({ name, objectKey: `ingest/${name}` });
  return asset.id;
}

// Register a named output-role destination and return its id + name. Accepts an
// optional per-destination path template (issue #574).
async function registerDestination(
  h: Harness,
  name: string,
  bucket: string,
  role: StorageBackendRole = 'packaged',
  pathTemplate?: string
): Promise<{ id: string; name: string }> {
  const view = await h.registry.register(STACK_CONFIG_NAMESPACE, {
    name,
    role,
    bucket,
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'shhh',
    ...(pathTemplate !== undefined ? { pathTemplate } : {})
  });
  return { id: view.id, name: view.name };
}

// The single running execution created for an asset carries the resolved
// destinationBucket the relocation will consume.
async function persistedDestinationBucket(
  h: Harness,
  assetId: string
): Promise<string | undefined> {
  const execs = await h.pipelines.listByAsset(assetId);
  expect(execs).toHaveLength(1);
  return execs[0].destinationBucket;
}

describe('job -> named export-destination reference (issue #573)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves a named destination by id to the SAME destinationBucket an inline override yields', async () => {
    const h = await buildApp();
    const named = await registerDestination(h, 'cold-archive-out', 'delivery-bucket');

    // Named reference by id.
    const refId = await makeSource(h, 'via-id');
    const byId = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${refId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', destination: named.id }
    });
    expect(byId.statusCode).toBe(202);
    const resolvedById = await persistedDestinationBucket(h, refId);

    // Equivalent inline override (plain bucket/ path).
    const inlineId = await makeSource(h, 'via-inline');
    const inline = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${inlineId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', destinationBucket: 'delivery-bucket' }
    });
    expect(inline.statusCode).toBe(202);
    const resolvedInline = await persistedDestinationBucket(h, inlineId);

    // A named reference relocates output IDENTICALLY to the equivalent inline
    // override: both persist the same normalized destinationBucket the ADR-011
    // relocation path consumes.
    expect(resolvedById).toBe('delivery-bucket/');
    expect(resolvedInline).toBe('delivery-bucket/');
    expect(resolvedById).toBe(resolvedInline);
  });

  it('resolves a named destination by name too', async () => {
    const h = await buildApp();
    const named = await registerDestination(h, 'my-cdn-origin', 'origin-bucket');
    const assetId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', destination: named.name }
    });

    expect(res.statusCode).toBe(202);
    expect(await persistedDestinationBucket(h, assetId)).toBe('origin-bucket/');
  });

  it('keeps the inline destinationBucket override working unchanged (non-breaking)', async () => {
    const h = await buildApp();
    const assetId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', destinationBucket: 's3://ext-bucket/prefix/' }
    });

    expect(res.statusCode).toBe(202);
    // Persisted verbatim (trailing-slash normalized by destinationBucketSchema),
    // untouched by the new resolution layer.
    expect(await persistedDestinationBucket(h, assetId)).toBe('s3://ext-bucket/prefix/');
  });

  it('leaves destinationBucket unset when neither field is supplied', async () => {
    const h = await buildApp();
    const assetId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod' }
    });

    expect(res.statusCode).toBe(202);
    expect(await persistedDestinationBucket(h, assetId)).toBeUndefined();
  });

  it('rejects supplying BOTH a named reference and an inline override as ambiguous (400)', async () => {
    const h = await buildApp();
    const named = await registerDestination(h, 'dst', 'some-bucket');
    const assetId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/execute`,
      headers: A,
      payload: {
        pipeline: 'abr-vod',
        destination: named.id,
        destinationBucket: 'some-bucket'
      }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ambiguous_destination');
    // No execution created for an ambiguous request.
    expect(await h.pipelines.listByAsset(assetId)).toHaveLength(0);
  });

  it('returns a clear 400 when the referenced destination does not resolve', async () => {
    const h = await buildApp();
    const assetId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', destination: 'does-not-exist' }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
    expect(res.json().message).toContain('does-not-exist');
    expect(await h.pipelines.listByAsset(assetId)).toHaveLength(0);
  });

  it('rejects referencing a source-only backend (not a delivery destination) with 400', async () => {
    const h = await buildApp();
    // A 'source'-role backend is registered but is NOT an export destination.
    const src = await registerDestination(h, 'ingest-only', 'ingest-bucket', 'source');
    const assetId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', destination: src.id }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });

  it("resolves a 'both'-role backend (serves output) as a destination", async () => {
    const h = await buildApp();
    const both = await registerDestination(h, 'shared', 'shared-bucket', 'both');
    const assetId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', destination: both.id }
    });

    expect(res.statusCode).toBe(202);
    expect(await persistedDestinationBucket(h, assetId)).toBe('shared-bucket/');
  });

  it('POST /:id/package (pipeline mode) also accepts a named destination reference', async () => {
    const h = await buildApp();
    const named = await registerDestination(h, 'pkg-out', 'pkg-bucket');
    const assetId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/package`,
      headers: A,
      payload: { destination: named.id }
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().pipelineMode).toBe(true);
    expect(await persistedDestinationBucket(h, assetId)).toBe('pkg-bucket/');
  });

  it('POST /:id/package rejects both a named reference and inline override (400)', async () => {
    const h = await buildApp();
    const named = await registerDestination(h, 'pkg-out2', 'pkg-bucket2');
    const assetId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/package`,
      headers: A,
      payload: { destination: named.id, destinationBucket: 'pkg-bucket2' }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ambiguous_destination');
  });
});

describe('per-destination path templating (issue #574)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keys the persisted destinationBucket by asset id when the destination has a template', async () => {
    const h = await buildApp();
    // A destination templated by asset id under the delivery bucket.
    const named = await registerDestination(
      h,
      'templated-out',
      'delivery-bucket',
      'packaged',
      'by-asset/{assetId}'
    );
    const assetId = await makeSource(h, 'templated-video');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', destination: named.id }
    });

    expect(res.statusCode).toBe(202);
    // The relocation destinationBucket is keyed UNDER the bucket by the template,
    // rendered with THIS job's asset id.
    expect(await persistedDestinationBucket(h, assetId)).toBe(
      `delivery-bucket/by-asset/${assetId}/`
    );
  });

  it('keys by a UTC date token', async () => {
    const h = await buildApp();
    const named = await registerDestination(
      h,
      'dated-out',
      'delivery-bucket',
      'packaged',
      '{date}/{assetId}'
    );
    const assetId = await makeSource(h, 'dated-video');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', destination: named.id }
    });

    expect(res.statusCode).toBe(202);
    const persisted = await persistedDestinationBucket(h, assetId);
    // delivery-bucket/YYYY-MM-DD/<assetId>/
    expect(persisted).toMatch(
      new RegExp(`^delivery-bucket/\\d{4}-\\d{2}-\\d{2}/${assetId}/$`)
    );
  });

  it('leaves a static-prefix (template-less) destination unaffected', async () => {
    const h = await buildApp();
    const named = await registerDestination(h, 'static-out', 'static-bucket');
    const assetId = await makeSource(h, 'static-video');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', destination: named.id }
    });

    expect(res.statusCode).toBe(202);
    // No template -> the bare bucket form, identical to the pre-#574 behaviour.
    expect(await persistedDestinationBucket(h, assetId)).toBe('static-bucket/');
  });
});
