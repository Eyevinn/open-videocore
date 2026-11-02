// Submit-time refusal of a job whose output destination lives at an endpoint
// this stack cannot write to (issue #1280).
//
// THE DEFECT. A package/execute job may name its output destination either as a
// registered external backend (`externalBackend`, issue #549) or as a named
// export destination (`destination`, issue #573). Either reference may resolve
// to a record registered with its OWN `endpointUrl`
// (StorageBackendRecord.endpointUrl, src/services/storage-backend-registry.ts:93).
// The job path never reads that field: the resolved destination is reduced to a
// bucket + prefix by `parseDestination` (src/pipeline/output-relocation.ts:49-80)
// and copied with the STACK'S OWN object-storage client
// (`relocatePackagedOutput`, output-relocation.ts:136-153, called from
// src/routes/internal.ts:490). So the submit was accepted and the output landed
// in a same-named bucket on this stack's store, never at the operator's
// endpoint.
//
// THE CONTRACT THIS MATCHES. `POST /api/v1/assets/{id}/deliver` already refuses
// exactly this with 422 `destination_unreachable`
// (`destinationEndpointRefusal`, src/pipeline/asset-delivery.ts; applied in
// src/routes/assets.ts POST /:id/deliver; status mapping
// DELIVERY_FAILURE_RESPONSE, src/routes/assets.ts:933). The job submit now
// refuses with the SAME code and envelope via `jobDestinationEndpointRefusal`,
// and registration warns through `jobOutputEndpointWarning`.
//
// SCOPE OF THE REFUSAL. It fires only when the request HAS a resolved
// object-storage endpoint to compare the claim against (production:
// `WorkspaceConnections.s3Config.endpoint`, src/services/workspace-stack.ts:152;
// injected here through the router's `deliveryEndpoint` option, the same seam
// test/asset-deliver-destination.test.ts:168 uses). A destination on the stack's
// own endpoint, or one making no endpoint claim, is still accepted.
//
// Harness mirrors test/execute-external-backend-output.test.ts.

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
import { exportDestinationsRouter } from '../src/routes/export-destinations.js';
import { storageRouter } from '../src/routes/storage.js';
import { DEPLOYMENT_CONTEXT } from '../src/auth/workspace.js';
import {
  STACK_CONFIG_NAMESPACE,
  type WorkspaceStackResolver
} from '../src/services/workspace-stack.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import {
  StorageBackendRegistry,
  InMemoryBackendRecordStore,
  REDACTED,
  type StorageBackendRole,
  type SecretStore
} from '../src/services/storage-backend-registry.js';
import type { EncoreClient, EncoreSubmitInput } from '../src/pipeline/encore-client.js';

const A = { authorization: 'Bearer token-a' };
const RAW_SECRET = 'raw-secret-value';

// The endpoint THIS stack's object-storage client is authenticated against.
const STACK_ENDPOINT = 'https://object-store.stack.test:9000';
// A separate, operator-owned S3-compatible endpoint the stack holds no
// credentials for.
const FOREIGN_ENDPOINT = 'https://storage.partner.example';

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  pipelines: InMemoryPipelineRepository;
  registry: StorageBackendRegistry;
};

function fakeEncore(): EncoreClient {
  return {
    submit: vi.fn(async (_input: EncoreSubmitInput) => ({ encoreInternalId: 'enc-1' })),
    getJobStatus: vi.fn(),
    cancel: vi.fn()
  } as unknown as EncoreClient;
}

async function buildApp(
  opts: { stackEndpoint?: string } = { stackEndpoint: STACK_ENDPOINT }
): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();
  const secretStore: SecretStore = { saveSecret: vi.fn(async () => {}) };
  const registry = new StorageBackendRegistry(new InMemoryBackendRecordStore(), secretStore);

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: jobs,
    pipelineRepository: pipelines,
    encore: fakeEncore(),
    packaging: {} as never,
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket',
    storageBackendRegistry: registry,
    ...(opts.stackEndpoint !== undefined ? { deliveryEndpoint: opts.stackEndpoint } : {})
  });
  await app.ready();
  return { app, assets, pipelines, registry };
}

async function makeSource(h: Harness, name = 'my-video'): Promise<string> {
  const asset = await h.assets.create({ name, objectKey: `ingest/${name}` });
  return asset.id;
}

// Register an output-role backend. `externalBackend` references resolve under
// DEPLOYMENT_CONTEXT and `destination` references under STACK_CONFIG_NAMESPACE
// (both are the single-tenant 'default' workspace), so one registration per
// namespace covers both reference styles.
async function register(
  h: Harness,
  over: {
    workspaceId?: string;
    name?: string;
    bucket?: string;
    role?: StorageBackendRole;
    endpointUrl?: string;
  } = {}
) {
  return h.registry.register(over.workspaceId ?? DEPLOYMENT_CONTEXT, {
    name: over.name ?? 'partner-out',
    role: over.role ?? 'packaged',
    bucket: over.bucket ?? 'partner-bucket',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: RAW_SECRET,
    ...(over.endpointUrl !== undefined ? { endpointUrl: over.endpointUrl } : {})
  });
}

function execute(h: Harness, assetId: string, body: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: `/api/v1/assets/${assetId}/execute`,
    headers: A,
    payload: { pipeline: 'abr-vod', profile: 'program', ...body }
  });
}

describe('job submit refuses an unusable external endpointUrl (issue #1280)', () => {
  it('refuses an execute whose externalBackend is registered at a foreign endpoint', async () => {
    const h = await buildApp();
    const view = await register(h, { endpointUrl: FOREIGN_ENDPOINT });
    const assetId = await makeSource(h);

    const res = await execute(h, assetId, { externalBackend: view.id });

    // Same code + envelope POST /:id/deliver answers for the same situation.
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('destination_unreachable');
    expect(res.json().message).toContain(FOREIGN_ENDPOINT);
    // Critically: no execution was started, so no output can land in a
    // same-named bucket on this stack's own store.
    expect(await h.pipelines.listByAsset(assetId)).toHaveLength(0);
  });

  it('refuses an execute whose named destination is registered at a foreign endpoint', async () => {
    const h = await buildApp();
    const view = await register(h, {
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: 'partner-dest',
      bucket: 'partner-dest-bucket',
      endpointUrl: FOREIGN_ENDPOINT
    });
    const assetId = await makeSource(h);

    const res = await execute(h, assetId, { destination: view.id });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('destination_unreachable');
    expect(await h.pipelines.listByAsset(assetId)).toHaveLength(0);
  });

  it('refuses a package job (pipeline mode) referencing a foreign-endpoint destination', async () => {
    const h = await buildApp();
    const view = await register(h, {
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: 'partner-pkg',
      bucket: 'partner-pkg-bucket',
      endpointUrl: FOREIGN_ENDPOINT
    });
    const assetId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/package`,
      headers: A,
      payload: { destination: view.name }
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('destination_unreachable');
    expect(await h.pipelines.listByAsset(assetId)).toHaveLength(0);
  });

  it('still accepts a destination registered on this stack own endpoint', async () => {
    const h = await buildApp();
    const view = await register(h, {
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: 'same-stack-dest',
      bucket: 'same-stack-bucket',
      // The authority (host + explicit port) matches the stack endpoint, so the
      // relocation client CAN reach it — accepted, unchanged.
      endpointUrl: STACK_ENDPOINT
    });
    const assetId = await makeSource(h);

    const res = await execute(h, assetId, { destination: view.id });

    expect(res.statusCode).toBe(202);
    const execs = await h.pipelines.listByAsset(assetId);
    expect(execs).toHaveLength(1);
    expect(execs[0].destinationBucket).toBe('same-stack-bucket/');
  });

  it('still accepts a destination that makes no endpoint claim', async () => {
    const h = await buildApp();
    const view = await register(h, {
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: 'no-endpoint-dest',
      bucket: 'plain-bucket'
    });
    const assetId = await makeSource(h);

    const res = await execute(h, assetId, { destination: view.name });

    expect(res.statusCode).toBe(202);
    const execs = await h.pipelines.listByAsset(assetId);
    expect(execs[0].destinationBucket).toBe('plain-bucket/');
  });

  it('still accepts an inline destinationBucket override (no endpoint can be claimed)', async () => {
    const h = await buildApp();
    const assetId = await makeSource(h);

    const res = await execute(h, assetId, { destinationBucket: 'inline-bucket/' });

    expect(res.statusCode).toBe(202);
    const execs = await h.pipelines.listByAsset(assetId);
    expect(execs[0].destinationBucket).toBe('inline-bucket/');
  });
});

describe('registration warns that an external endpoint is not used for job output (issue #1280)', () => {
  async function buildDestinationsApp(stackEndpoint?: string) {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const registry = new StorageBackendRegistry(new InMemoryBackendRecordStore(), {
      saveSecret: vi.fn(async () => {})
    } as unknown as SecretStore);
    await app.register(exportDestinationsRouter, {
      prefix: '/api/v1/export-destinations',
      storageBackendRegistry: registry,
      ...(stackEndpoint !== undefined ? { objectStoreEndpoint: stackEndpoint } : {})
    });
    await app.ready();
    return app;
  }

  const body = (endpointUrl?: string) => ({
    name: 'partner-origin',
    role: 'packaged',
    bucket: 'partner-bucket',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: RAW_SECRET,
    ...(endpointUrl !== undefined ? { endpointUrl } : {})
  });

  it('registers the destination and warns the endpoint will not be used for job output', async () => {
    const app = await buildDestinationsApp(STACK_ENDPOINT);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/export-destinations',
      payload: body(FOREIGN_ENDPOINT)
    });

    // Registration still succeeds — the warning is informational, not a refusal.
    expect(res.statusCode).toBe(201);
    const payload = res.json() as { warnings?: string[]; endpointUrl?: string };
    expect(payload.endpointUrl).toBe(FOREIGN_ENDPOINT);
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings?.[0]).toContain('will NOT be used for job output');
    // The warning points at the submit-time behaviour an operator will hit.
    expect(payload.warnings?.[0]).toContain('destination_unreachable');
    // No credential material is ever echoed, warning or not.
    expect(res.payload).not.toContain(RAW_SECRET);
  });

  it('emits no warning for a destination on this stack own endpoint', async () => {
    const app = await buildDestinationsApp(STACK_ENDPOINT);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/export-destinations',
      payload: body(STACK_ENDPOINT)
    });

    expect(res.statusCode).toBe(201);
    expect((res.json() as { warnings?: string[] }).warnings).toBeUndefined();
  });

  it('emits no warning when the destination makes no endpoint claim', async () => {
    const app = await buildDestinationsApp(STACK_ENDPOINT);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/export-destinations',
      payload: body()
    });

    expect(res.statusCode).toBe(201);
    expect((res.json() as { warnings?: string[] }).warnings).toBeUndefined();
  });
});

// The SECOND registration surface over the same StorageBackendRegistry records
// (export-destinations and storage/backends are two views of one registry —
// test/export-destinations-auth-parity.test.ts:52-70). `POST
// /api/v1/storage/backends` answers with its own extended 201 schema
// (`registeredBackendSchema = backendViewSchema.extend({ warnings:
// z.array(z.string()).optional() })`, src/routes/storage.ts:192) and emits the
// warning through the same shared `jobOutputEndpointWarning`
// (src/pipeline/asset-delivery.ts:446). The serialiser is the contract that
// matters here: a zod response schema that had NOT been extended would strip
// `warnings` silently and still compile, so these cases exercise the wire
// payload, not just the handler.
//
// Mirrors the export-destinations block above case for case, injecting the
// stack's object-storage endpoint through the router's `objectStoreEndpoint`
// option (StorageRouterOptions.objectStoreEndpoint, src/routes/storage.ts:74) —
// the same seam `buildDestinationsApp` uses.
describe('backend registration warns that an external endpoint is not used for job output (issue #1280)', () => {
  // /backends keys records under STACK_CONFIG_NAMESPACE and never resolves a
  // stack, so a resolver that throws if touched keeps the harness honest (same
  // stub as test/export-destinations-auth-parity.test.ts:30-34).
  const stackResolverStub = {
    resolve: () => {
      throw new Error('stackResolver.resolve must not be called by these routes');
    }
  } as unknown as WorkspaceStackResolver;

  async function buildBackendsApp(stackEndpoint?: string) {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // storageRouter gates /backends behind authGate, so the presence gate has to
    // be wired and a bearer token sent (unlike the anonymous export-destinations
    // harness above).
    registerAuth(app);
    const registry = new StorageBackendRegistry(new InMemoryBackendRecordStore(), {
      saveSecret: vi.fn(async () => {})
    } as unknown as SecretStore);
    await app.register(storageRouter, {
      prefix: '/api/v1/storage',
      stackResolver: stackResolverStub,
      storageBackendRegistry: registry,
      ...(stackEndpoint !== undefined ? { objectStoreEndpoint: stackEndpoint } : {})
    });
    await app.ready();
    return app;
  }

  // registerBackendSchema (src/routes/storage.ts:141-154): name, role, bucket,
  // accessKeyId, secretAccessKey required-shaped; endpointUrl optional.
  const backendBody = (endpointUrl?: string) => ({
    name: 'partner-backend',
    role: 'packaged',
    bucket: 'partner-bucket',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: RAW_SECRET,
    ...(endpointUrl !== undefined ? { endpointUrl } : {})
  });

  function registerBackend(app: FastifyInstance, endpointUrl?: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/storage/backends',
      headers: A,
      payload: backendBody(endpointUrl)
    });
  }

  it('registers the backend and warns the endpoint will not be used for job output', async () => {
    const app = await buildBackendsApp(STACK_ENDPOINT);

    const res = await registerBackend(app, FOREIGN_ENDPOINT);

    // Registration still succeeds — the warning is informational, not a refusal.
    expect(res.statusCode).toBe(201);
    const payload = res.json() as { warnings?: string[]; endpointUrl?: string };
    expect(payload.endpointUrl).toBe(FOREIGN_ENDPOINT);
    // Present on the WIRE: proves registeredBackendSchema really carries the key
    // through the zod serialiser rather than dropping it.
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings?.[0]).toContain('will NOT be used for job output');
    // The warning points at the submit-time behaviour an operator will hit.
    expect(payload.warnings?.[0]).toContain('destination_unreachable');
    await app.close();
  });

  it('emits no warning for a backend on this stack own endpoint', async () => {
    const app = await buildBackendsApp(STACK_ENDPOINT);

    const res = await registerBackend(app, STACK_ENDPOINT);

    expect(res.statusCode).toBe(201);
    expect((res.json() as { warnings?: string[] }).warnings).toBeUndefined();
    await app.close();
  });

  it('emits no warning when the backend makes no endpoint claim', async () => {
    const app = await buildBackendsApp(STACK_ENDPOINT);

    const res = await registerBackend(app);

    expect(res.statusCode).toBe(201);
    expect((res.json() as { warnings?: string[] }).warnings).toBeUndefined();
    await app.close();
  });

  it('never echoes the registered secret, warning or not', async () => {
    // ADR-017 D1 redaction holds on the extended 201 body too: the view's
    // `credentials.secretAccessKey` is the fixed marker and the raw secret
    // appears nowhere in the serialised payload.
    for (const endpointUrl of [FOREIGN_ENDPOINT, STACK_ENDPOINT, undefined]) {
      const app = await buildBackendsApp(STACK_ENDPOINT);

      const res = await registerBackend(app, endpointUrl);

      expect(res.statusCode).toBe(201);
      const payload = res.json() as { credentials: { secretAccessKey: string } };
      expect(payload.credentials.secretAccessKey).toBe(REDACTED);
      expect(res.payload).not.toContain(RAW_SECRET);
      await app.close();
    }
  });
});
