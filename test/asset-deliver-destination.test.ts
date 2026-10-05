// POST /api/v1/assets/:id/deliver — destination-aware delivery of an existing
// asset to a registered export destination (issue #1131, prerequisite for #945
// and the #910/#911 export-from-detail UI).
//
// What these tests pin down (the acceptance criteria of #1131):
//   1. SUCCESS ONLY ON A REAL LANDING — a 200 `{ status: 'delivered' }` is
//      returned only when the object is actually present at the chosen
//      destination bucket, with the source's byte count. The fake store is
//      asserted directly, so a handler that reported success without copying
//      would fail these tests.
//   2. A STORAGE FAILURE IS A TRUTHFUL ERROR — a failed copy, and a copy the
//      store "accepts" while writing nothing, are 502s, never a false 200.
//   3. AN UNKNOWN / INVALID DESTINATION IS A CLEAR 4xx.
//   4. A DESTINATION THAT IS NOT AN OUTPUT-ROLE TARGET IS A CLEAR 4xx, and is
//      distinguishable from an unknown one.
//
// Contract symbols exercised:
//   - StorageBackendRegistry.register / resolveForOutput / resolveDestinationBucket
//     (src/services/storage-backend-registry.ts:620, :1036, :982)
//   - the export-destinations workspace namespace STACK_CONFIG_NAMESPACE
//     (src/routes/export-destinations.ts:187)
//   - resolveJobDestination + parseDestination on the assets router
//     (src/routes/assets.ts; src/pipeline/output-relocation.ts:57)
//   - deliverAssetObject / DeliveryObjectClient (src/pipeline/asset-delivery.ts),
//     whose three primitives mirror minio ^8.x bucketExists / statObject /
//     copyObject (node_modules/minio/dist/esm/internal/client.d.mts:207,239,354)
//
// Harness mirrors test/job-reference-export-destination.test.ts (single-arg
// repo signatures) so it is unaffected by the two-arg workspace-scoping drift.

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
import {
  StorageBackendRegistry,
  InMemoryBackendRecordStore,
  type SecretStore,
  type StorageBackendRole
} from '../src/services/storage-backend-registry.js';
import { STACK_CONFIG_NAMESPACE } from '../src/services/workspace-stack.js';
import type { DeliveryObjectClient } from '../src/pipeline/asset-delivery.js';
import type { RecordAuditInput } from '../src/data/audit-repo.js';

const A = { authorization: 'Bearer token-a' };

const SOURCE_BUCKET = 'src-bucket';
const SOURCE_KEY = 'ingest/master.mp4';
const SOURCE_BYTES = 8192;
// The storage endpoint the injected delivery client is credentialed against.
// A destination registered at THIS endpoint is deliverable; one registered
// elsewhere is refused (its secret is write-only in OSC secrets).
const OUR_ENDPOINT = 'https://minio.stack.example:9000';

function notFound(): Error {
  return Object.assign(new Error('Not Found'), { code: 'NotFound' });
}

type CopyRecord = { targetBucket: string; targetKey: string; source: string };

// In-memory object store standing in for the per-request stack client. Models
// exactly the primitives the route uses, plus the two ways a real store can
// betray us: a loud copy failure and a copy that is accepted but writes nothing.
class FakeStore implements DeliveryObjectClient {
  readonly buckets = new Set<string>([SOURCE_BUCKET]);
  readonly objects = new Map<string, number>();
  readonly copies: CopyRecord[] = [];
  copyBehaviour: 'copy' | 'throw' | 'silently-drop' = 'copy';

  put(bucket: string, key: string, size: number): void {
    this.buckets.add(bucket);
    this.objects.set(`${bucket}/${key}`, size);
  }

  async bucketExists(bucketName: string): Promise<boolean> {
    return this.buckets.has(bucketName);
  }

  async statObject(bucketName: string, objectName: string): Promise<{ size: number; etag: string }> {
    const size = this.objects.get(`${bucketName}/${objectName}`);
    if (size === undefined) throw notFound();
    return { size, etag: `etag-${objectName}` };
  }

  async copyObject(
    targetBucketName: string,
    targetObjectName: string,
    sourceBucketNameAndObjectName: string
  ): Promise<unknown> {
    this.copies.push({
      targetBucket: targetBucketName,
      targetKey: targetObjectName,
      source: sourceBucketNameAndObjectName
    });
    if (this.copyBehaviour === 'throw') {
      throw new Error('NoSuchBucket: the specified bucket does not exist');
    }
    if (this.copyBehaviour === 'silently-drop') {
      return {};
    }
    const size = this.objects.get(sourceBucketNameAndObjectName.replace(/^\//, '')) ?? 0;
    this.objects.set(`${targetBucketName}/${targetObjectName}`, size);
    return {};
  }
}

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  registry: StorageBackendRegistry;
  store: FakeStore;
  audits: RecordAuditInput[];
};

// A no-op SecretStore so register() persists the non-secret record. Delivery
// never reads a secret (the registry cannot hand one back), so a recording stub
// is sufficient.
function fakeSecretStore(): SecretStore {
  return { saveSecret: vi.fn(async () => {}) };
}

type BuildOptions = {
  // Omit the registry to exercise the 501 (no destinations configured).
  withRegistry?: boolean;
  // Omit the delivery client to exercise the 501 (no object storage).
  withClient?: boolean;
  // Override the endpoint the client is credentialed against.
  endpoint?: string;
};

async function buildApp(options: BuildOptions = {}): Promise<Harness> {
  const { withRegistry = true, withClient = true, endpoint = OUR_ENDPOINT } = options;
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const assets = new InMemoryAssetRepository();
  const registry = new StorageBackendRegistry(new InMemoryBackendRecordStore(), fakeSecretStore());
  const store = new FakeStore();
  const audits: RecordAuditInput[] = [];

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: new InMemoryJobRepository(),
    sourceBucket: SOURCE_BUCKET,
    ...(withRegistry ? { storageBackendRegistry: registry } : {}),
    ...(withClient ? { deliveryClient: store } : {}),
    deliveryEndpoint: endpoint,
    audit: {
      record: async (input: RecordAuditInput) => {
        audits.push(input);
        return input;
      }
    }
  });
  await app.ready();
  return { app, assets, registry, store, audits };
}

// An asset whose source bytes really exist in the source bucket.
async function makeStoredAsset(h: Harness, name = 'my-video'): Promise<string> {
  const asset = await h.assets.create({ name, objectKey: SOURCE_KEY });
  h.store.put(SOURCE_BUCKET, SOURCE_KEY, SOURCE_BYTES);
  return asset.id;
}

async function registerDestination(
  h: Harness,
  opts: {
    name: string;
    bucket: string;
    role?: StorageBackendRole;
    pathTemplate?: string;
    endpointUrl?: string | null;
    createBucket?: boolean;
  }
): Promise<{ id: string; name: string }> {
  const {
    name,
    bucket,
    role = 'packaged',
    pathTemplate,
    endpointUrl = OUR_ENDPOINT,
    createBucket = true
  } = opts;
  const view = await h.registry.register(STACK_CONFIG_NAMESPACE, {
    name,
    role,
    bucket,
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'shhh',
    ...(pathTemplate !== undefined ? { pathTemplate } : {}),
    ...(endpointUrl ? { endpointUrl } : {})
  });
  if (createBucket) h.store.buckets.add(bucket);
  return { id: view.id, name: view.name };
}

function deliver(h: Harness, assetId: string, payload: unknown) {
  return h.app.inject({
    method: 'POST',
    url: `/api/v1/assets/${assetId}/deliver`,
    headers: A,
    payload: payload as Record<string, unknown>
  });
}

describe('POST /:id/deliver — success only on a real landing (issue #1131)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delivers the asset to the chosen destination and reports the verified coordinates', async () => {
    const h = await buildApp();
    const dest = await registerDestination(h, { name: 'partner-out', bucket: 'partner-bucket' });
    const assetId = await makeStoredAsset(h);

    const res = await deliver(h, assetId, { destination: dest.id });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      assetId,
      status: 'delivered',
      destination: { id: dest.id, name: 'partner-out', role: 'packaged' },
      bucket: 'partner-bucket',
      objectKey: SOURCE_KEY,
      bytes: SOURCE_BYTES
    });
    expect(typeof body.deliveredAt).toBe('string');

    // The object REALLY landed in the chosen destination bucket (not the
    // source bucket, not some default), and the copy was server-side.
    expect(h.store.objects.get(`partner-bucket/${SOURCE_KEY}`)).toBe(SOURCE_BYTES);
    expect(h.store.copies).toEqual([
      {
        targetBucket: 'partner-bucket',
        targetKey: SOURCE_KEY,
        source: `/${SOURCE_BUCKET}/${SOURCE_KEY}`
      }
    ]);
  });

  it('resolves a destination by NAME as well as by id', async () => {
    const h = await buildApp();
    await registerDestination(h, { name: 'by-name-out', bucket: 'named-bucket' });
    const assetId = await makeStoredAsset(h);

    const res = await deliver(h, assetId, { destination: 'by-name-out' });

    expect(res.statusCode).toBe(200);
    expect(h.store.objects.has(`named-bucket/${SOURCE_KEY}`)).toBe(true);
  });

  it('keys the delivered object under the destination path template (issue #574)', async () => {
    const h = await buildApp();
    const dest = await registerDestination(h, {
      name: 'templated-out',
      bucket: 'templated-bucket',
      pathTemplate: '{assetId}'
    });
    const assetId = await makeStoredAsset(h);

    const res = await deliver(h, assetId, { destination: dest.id });

    expect(res.statusCode).toBe(200);
    expect(res.json().objectKey).toBe(`${assetId}/${SOURCE_KEY}`);
    expect(h.store.objects.has(`templated-bucket/${assetId}/${SOURCE_KEY}`)).toBe(true);
  });

  it('audits a delivery only when it actually landed', async () => {
    const h = await buildApp();
    const dest = await registerDestination(h, { name: 'audited-out', bucket: 'audited-bucket' });
    const assetId = await makeStoredAsset(h);

    await deliver(h, assetId, { destination: dest.id });
    // emitAudit is fire-and-forget; let the detached write settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'asset.delivered',
      targetType: 'asset',
      targetId: assetId
    });

    // A failing delivery emits nothing.
    h.store.copyBehaviour = 'throw';
    const second = await makeStoredAsset(h, 'second');
    const failed = await deliver(h, second, { destination: dest.id });
    expect(failed.statusCode).toBe(502);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.audits).toHaveLength(1);
  });
});

describe('POST /:id/deliver — a storage failure is reported truthfully', () => {
  it('answers 502 when the copy fails, and nothing lands', async () => {
    const h = await buildApp();
    const dest = await registerDestination(h, { name: 'failing-out', bucket: 'failing-bucket' });
    const assetId = await makeStoredAsset(h);
    h.store.copyBehaviour = 'throw';

    const res = await deliver(h, assetId, { destination: dest.id });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('delivery_failed');
    expect(h.store.objects.has(`failing-bucket/${SOURCE_KEY}`)).toBe(false);
  });

  it('answers 502 — never a false 200 — when the store accepts the copy but writes nothing', async () => {
    const h = await buildApp();
    const dest = await registerDestination(h, { name: 'lying-out', bucket: 'lying-bucket' });
    const assetId = await makeStoredAsset(h);
    h.store.copyBehaviour = 'silently-drop';

    const res = await deliver(h, assetId, { destination: dest.id });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'delivery_failed' });
    expect(res.json().message).toContain('no object is present');
    // The copy WAS attempted, and the handler still refused to call it a success.
    expect(h.store.copies).toHaveLength(1);
  });

  it('answers 422 when the destination bucket is not reachable with our credentials', async () => {
    const h = await buildApp();
    const dest = await registerDestination(h, {
      name: 'absent-out',
      bucket: 'absent-bucket',
      createBucket: false
    });
    const assetId = await makeStoredAsset(h);

    const res = await deliver(h, assetId, { destination: dest.id });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('destination_unreachable');
    expect(h.store.copies).toHaveLength(0);
  });

  it('answers 422 for a destination registered at an endpoint this API holds no credentials for', async () => {
    const h = await buildApp();
    const dest = await registerDestination(h, {
      name: 'foreign-out',
      bucket: 'foreign-bucket',
      endpointUrl: 'https://s3.partner.example'
    });
    const assetId = await makeStoredAsset(h);

    const res = await deliver(h, assetId, { destination: dest.id });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('destination_unreachable');
    // Critically: no copy was attempted, so a same-named local bucket could
    // never have been mistaken for the operator's destination.
    expect(h.store.copies).toHaveLength(0);
  });

  it('answers 409 when the asset document names an object that is not in the bucket', async () => {
    const h = await buildApp();
    const dest = await registerDestination(h, { name: 'orphan-out', bucket: 'orphan-bucket' });
    // Asset with an objectKey but NO bytes in the store.
    const asset = await h.assets.create({ name: 'orphan', objectKey: 'ingest/gone.mp4' });

    const res = await deliver(h, asset.id, { destination: dest.id });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('source_missing');
  });

  it('answers 409 for an asset with no stored source object at all', async () => {
    const h = await buildApp();
    const dest = await registerDestination(h, { name: 'nosrc-out', bucket: 'nosrc-bucket' });
    const asset = await h.assets.create({ name: 'metadata-only' });

    const res = await deliver(h, asset.id, { destination: dest.id });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_object');
  });
});

describe('POST /:id/deliver — invalid destinations are clear 4xx', () => {
  it('answers 400 for a reference that matches no registered destination', async () => {
    const h = await buildApp();
    const assetId = await makeStoredAsset(h);

    const res = await deliver(h, assetId, { destination: 'no-such-destination' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
    expect(res.json().message).toContain('no-such-destination');
    expect(h.store.copies).toHaveLength(0);
  });

  it('answers 400 for the platform-managed default (where the asset already is)', async () => {
    const h = await buildApp();
    const assetId = await makeStoredAsset(h);

    const res = await deliver(h, assetId, { destination: 'default' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('not an export destination');
    expect(h.store.copies).toHaveLength(0);
  });

  it('answers 422 for a registered backend that is not an output-role destination', async () => {
    const h = await buildApp();
    const sourceOnly = await registerDestination(h, {
      name: 'ingest-only',
      bucket: 'ingest-bucket',
      role: 'source'
    });
    const archive = await registerDestination(h, {
      name: 'cold-store',
      bucket: 'cold-bucket',
      role: 'archive'
    });
    const assetId = await makeStoredAsset(h);

    for (const ref of [sourceOnly.id, archive.id]) {
      const res = await deliver(h, assetId, { destination: ref });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('backend_role');
      // The message distinguishes "registered, wrong role" from "unknown".
      expect(res.json().message).toContain('cannot receive a delivery');
    }
    expect(h.store.copies).toHaveLength(0);
  });

  it('delivers to a `both`-role destination (it serves the output path too)', async () => {
    const h = await buildApp();
    const dest = await registerDestination(h, {
      name: 'dual-role-out',
      bucket: 'dual-bucket',
      role: 'both'
    });
    const assetId = await makeStoredAsset(h);

    const res = await deliver(h, assetId, { destination: dest.id });

    expect(res.statusCode).toBe(200);
    expect(res.json().destination.role).toBe('both');
  });

  it('rejects a body with no destination, and one with unknown fields', async () => {
    const h = await buildApp();
    const assetId = await makeStoredAsset(h);

    expect((await deliver(h, assetId, {})).statusCode).toBe(400);
    expect(
      (await deliver(h, assetId, { destination: 'x', destinationBucket: 'sneaky-bucket/' }))
        .statusCode
    ).toBe(400);
    expect(h.store.copies).toHaveLength(0);
  });

  it('answers 404 for an unknown asset, without leaking destination state', async () => {
    const h = await buildApp();
    await registerDestination(h, { name: 'unused-out', bucket: 'unused-bucket' });

    const res = await deliver(h, 'no-such-asset', { destination: 'unused-out' });

    expect(res.statusCode).toBe(404);
    expect(h.store.copies).toHaveLength(0);
  });
});

describe('POST /:id/deliver — unconfigured deployments degrade to 501', () => {
  it('answers 501 when no storage-backend registry is wired', async () => {
    const h = await buildApp({ withRegistry: false });
    const assetId = await makeStoredAsset(h);

    const res = await deliver(h, assetId, { destination: 'anything' });

    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_configured');
  });

  it('answers 501 when no object-storage client is available', async () => {
    const h = await buildApp({ withClient: false });
    const dest = await registerDestination(h, { name: 'no-client-out', bucket: 'no-client-bucket' });
    const asset = await h.assets.create({ name: 'stored', objectKey: SOURCE_KEY });

    const res = await deliver(h, asset.id, { destination: dest.id });

    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_configured');
  });

  it('requires authentication', async () => {
    const h = await buildApp();
    const assetId = await makeStoredAsset(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/deliver`,
      payload: { destination: 'anything' }
    });

    expect(res.statusCode).toBe(401);
  });
});
