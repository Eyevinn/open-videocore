// The multipart-upload path signs with the credential the stack's object store
// was CREATED with (issue #1342).
//
// The reported failure: on a freshly provisioned stack, starting a multipart
// upload was refused by the object store with "request signature does not
// match", while encoding — which reaches the same object store through a
// different credential read path — worked. Three candidate causes were named:
// a derivation mismatch between provision time and read time, a credential not
// applied to new stacks, and a stale cached client.
//
// What this test pins, end to end and with a real signature check:
//   1. PROVISION side — `planObjectStoreCredential` decides the credential the
//      object-store instance is created with (the id becomes
//      `StackConfig.objectStoreAccessKeyId`, the secret becomes the instance's
//      root password). The stub store below is started with exactly that pair
//      and verifies AWS SigV4 on every request, so it accepts nothing else.
//   2. READ side — the API's own object-storage client is built by the stack
//      resolver from the STORED config
//      (`WorkspaceStackResolver.resolve` -> `buildConnectionsFromStack` ->
//      `resolveObjectStoreCredential`), and reached by the upload routes through
//      the request-scoped factory (`makeRequestScopedStorageFactory`), which is
//      the exact wiring `POST /api/v1/assets/:id/multipart/initiate` uses
//      (src/main.ts `storageFor`, src/routes/asset-upload.ts).
//   3. The whole multipart handshake the route exposes — initiate, per-part
//      presigned PUT, complete — succeeds for a 4.7 MB payload and the assembled
//      object is byte-identical to what was sent.
//   4. The derivation is what makes that work: a store created with the LEGACY
//      deployment-wide pair (`admin` + MINIO_ROOT_PASSWORD) REFUSES the
//      per-stack-signed init, which is the signature-mismatch shape from the
//      report. That is the assertion that would fail if any read path drifted
//      back to the deployment-wide credential.
//   5. A stale cached client cannot survive a credential change: after the
//      stored config is re-issued under a new credential and the resolver is
//      invalidated (what the provision route does via `onStackChange`), init
//      signs with the NEW pair.
//
// Contract sources verified (CLAUDE.md rule 7):
//   - `planObjectStoreCredential(args): ObjectStoreCredentialPlan` and
//     `resolveObjectStoreCredential({ storedAccessKeyId, seed,
//     legacySecretAccessKey }): ObjectStoreCredential`, plus
//     `LEGACY_OBJECT_STORE_ACCESS_KEY_ID` and
//     `newObjectStoreCredentialGeneration()` —
//     src/services/object-store-credentials.ts.
//   - `StackConfig.objectStoreAccessKeyId?: string`,
//     `StackConfig.minioEndpoint/sourceBucket/status`, and the `ParamStore`
//     interface (`storeStackConfig`/`loadStackConfig`/`deleteStackConfig`/
//     `listStackNames`) + `stackConfigKey(workspaceId, name)` —
//     src/services/param-store.ts.
//   - `WorkspaceStackResolver.resolve(stackName?)`, `.resolveCached(stackName?)`,
//     `.invalidate()` and `STACK_CONFIG_NAMESPACE` —
//     src/services/workspace-stack.ts.
//   - `makeRequestScopedStorageFactory(resolver): StorageFactory` and
//     `runWithRequestStack(stackName, fn)` — src/services/request-stack-context.ts.
//   - `WorkspaceStorage.initiateMultipartUpload(localKey): Promise<string>`,
//     `.presignedUploadPart(localKey, uploadId, partNumber, expirySeconds)`,
//     `.completeMultipartUpload(localKey, uploadId, parts)` and
//     `CompletedPart { partNumber, etag }` — src/data/storage.ts.
//   - `sourceObjectKey(assetId): string` — src/routes/asset-upload.ts, the key
//     the multipart routes derive server-side.
//   - SigV4 wire rules the stub store verifies against: see the contract list in
//     test/s3-sigv4-multipart-store.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@osaas/client-core', () => ({
  listSubscriptions: vi.fn(async () => {
    throw new Error('listSubscriptions must never be called in this test');
  }),
  Context: class {}
}));

import {
  LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
  newObjectStoreCredentialGeneration,
  planObjectStoreCredential,
  type ObjectStoreCredential
} from '../src/services/object-store-credentials.js';
import {
  WorkspaceStackResolver,
  STACK_CONFIG_NAMESPACE
} from '../src/services/workspace-stack.js';
import { makeRequestScopedStorageFactory, runWithRequestStack } from '../src/services/request-stack-context.js';
import { sourceObjectKey } from '../src/routes/asset-upload.js';
import { stackConfigKey, type ParamStore, type StackConfig } from '../src/services/param-store.js';
import { startSigV4MultipartStore, type SigV4MultipartStore } from './s3-sigv4-multipart-store.js';
import type { CompletedPart } from '../src/data/storage.js';
import type { Context } from '@osaas/client-core';

// MINIO_ROOT_PASSWORD on the deployment under test: the derivation SEED and the
// legacy deployment-wide secret, as documented in README.md and in
// services/object-store-credentials.ts. Long and mixed enough to clear the
// issue-time strength gate, so `planObjectStoreCredential` really issues a
// per-stack credential rather than downgrading to the shared one.
const SEED = 'oT7qf2YhV8sJpL4wZr3NbXkE6cDmA9uQ';
const COUCH_PASSWORD = 'couch-password';
const STACK_NAME = 'freshstack';
const SOURCE_BUCKET = 'openvideocore-source';
const ASSET_ID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';

// The payload size from the report: 4.7 MB, uploaded as two parts.
const PAYLOAD_BYTES = 4_700_000;

const oscContext = {} as unknown as Context;

const SAVED = { couch: process.env['COUCHDB_URL'], minio: process.env['MINIO_URL'] };

beforeEach(() => {
  // Force the parameter-store path: with either of these set the resolver takes
  // the env-override branch and never reads the stack config.
  delete process.env['COUCHDB_URL'];
  delete process.env['MINIO_URL'];
});

afterEach(() => {
  if (SAVED.couch === undefined) delete process.env['COUCHDB_URL'];
  else process.env['COUCHDB_URL'] = SAVED.couch;
  if (SAVED.minio === undefined) delete process.env['MINIO_URL'];
  else process.env['MINIO_URL'] = SAVED.minio;
});

// The credential a provision run decides for a brand-new stack: no stored
// config, no pre-existing object-store instance, a parameter store available,
// and a fresh generation nonce. This is the pair the instance is created with.
function provisionCredentialForNewStack(): ObjectStoreCredential {
  const plan = planObjectStoreCredential({
    stackName: STACK_NAME,
    seed: SEED,
    legacySecretAccessKey: SEED,
    storedAccessKeyId: undefined,
    storedConfigExists: false,
    objectStoreInstanceExists: false,
    generation: newObjectStoreCredentialGeneration(),
    paramStoreAvailable: true
  });
  // A downgrade here would mean the test was asserting the legacy path by
  // accident, so hold the precondition explicitly.
  expect(plan.perStack).toBe(true);
  expect(plan.downgradeReason).toBeUndefined();
  expect(plan.credential.accessKeyId).not.toBe(LEGACY_OBJECT_STORE_ACCESS_KEY_ID);
  return plan.credential;
}

// The stack config the provision route persists once the stack is live: the
// non-secret access key id is recorded, the secret is NOT stored anywhere.
function readyStackConfig(endpoint: string, accessKeyId: string | undefined): StackConfig {
  return {
    status: 'ready',
    minioEndpoint: endpoint,
    couchdbUrl: 'http://127.0.0.1:5984',
    redisUrl: 'redis://127.0.0.1:6379',
    sourceBucket: SOURCE_BUCKET,
    packagedBucket: 'openvideocore-packaged',
    ...(accessKeyId ? { objectStoreAccessKeyId: accessKeyId } : {}),
    services: []
  };
}

function makeStore(configs: Record<string, StackConfig>): ParamStore {
  const byKey = new Map<string, StackConfig>();
  for (const [name, config] of Object.entries(configs)) {
    byKey.set(stackConfigKey(STACK_CONFIG_NAMESPACE, name), config);
  }
  return {
    async storeStackConfig(ws, name, config) {
      byKey.set(stackConfigKey(ws, name), config);
    },
    async loadStackConfig(ws, name) {
      return byKey.get(stackConfigKey(ws, name));
    },
    async deleteStackConfig(ws, name) {
      byKey.delete(stackConfigKey(ws, name));
    },
    async listStackNames(ws) {
      const prefix = stackConfigKey(ws, '');
      return [...byKey.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    }
  };
}

function makeResolver(paramStore: ParamStore): WorkspaceStackResolver {
  return new WorkspaceStackResolver({
    paramStore,
    oscContext,
    // MINIO_ROOT_PASSWORD in both of its roles (seed + legacy secret).
    minioPassword: SEED,
    couchPassword: COUCH_PASSWORD
  });
}

// The object-storage handle the upload routes get for a request on this stack:
// the same resolver cache + request-scoped factory main.ts wires into
// `assetUploadRouter`.
async function storageForRequest(resolver: WorkspaceStackResolver) {
  await resolver.resolve(STACK_NAME);
  const storageFor = makeRequestScopedStorageFactory(resolver);
  return runWithRequestStack(STACK_NAME, () => storageFor());
}

async function withStore(
  credential: { accessKeyId: string; secretAccessKey: string },
  fn: (store: SigV4MultipartStore) => Promise<void>
): Promise<void> {
  const store = await startSigV4MultipartStore({
    bucket: SOURCE_BUCKET,
    accessKey: credential.accessKeyId,
    secretKey: credential.secretAccessKey
  });
  try {
    await fn(store);
  } finally {
    await store.close();
  }
}

describe('multipart init signs with the stack object store credential (issue #1342)', () => {
  it('initiates and completes a 4.7 MB multipart upload on a freshly provisioned stack', async () => {
    const credential = provisionCredentialForNewStack();

    await withStore(credential, async (store) => {
      const paramStore = makeStore({
        [STACK_NAME]: readyStackConfig(store.endpoint, credential.accessKeyId)
      });
      const storage = await storageForRequest(makeResolver(paramStore));
      const objectKey = sourceObjectKey(ASSET_ID);

      // 1. initiate — the request the reported 500 came from. A credential the
      // store was not created with is refused here before anything else.
      const uploadId = await storage.initiateMultipartUpload(objectKey);
      expect(uploadId).toMatch(/^upload-\d+$/);

      // 2. two presigned part PUTs, pushed straight to the store the way a
      // browser does (no Authorization header, signature in the query).
      const payload = Buffer.alloc(PAYLOAD_BYTES);
      for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
      const half = Math.ceil(PAYLOAD_BYTES / 2);
      const chunks = [payload.subarray(0, half), payload.subarray(half)];
      const parts: CompletedPart[] = [];
      for (const [index, chunk] of chunks.entries()) {
        const partNumber = index + 1;
        const url = await storage.presignedUploadPart(objectKey, uploadId, partNumber, 900);
        const res = await fetch(url, { method: 'PUT', body: chunk });
        expect(res.status).toBe(200);
        const etag = (res.headers.get('etag') ?? '').replace(/"/g, '');
        expect(etag).not.toBe('');
        parts.push({ partNumber, etag });
      }

      // 3. complete — the parts are stitched into the source object.
      const { etag } = await storage.completeMultipartUpload(objectKey, uploadId, parts);
      expect(etag).not.toBe('');

      const stored = store.objects.get(objectKey);
      expect(stored?.length).toBe(PAYLOAD_BYTES);
      expect(stored?.equals(payload)).toBe(true);

      // Every request the store handled verified, and all of them presented the
      // stack's own access key id — not the deployment-wide root user.
      const refused = store.requests.filter((r) => r.status >= 400);
      expect(refused).toEqual([]);
      const init = store.requests.find((r) => r.op === 'CreateMultipartUpload');
      expect(init?.accessKeyId).toBe(credential.accessKeyId);
      expect(init?.authStyle).toBe('header');
      const partWrites = store.requests.filter((r) => r.op === 'UploadPart');
      expect(partWrites).toHaveLength(2);
      for (const write of partWrites) {
        expect(write.accessKeyId).toBe(credential.accessKeyId);
        expect(write.authStyle).toBe('query');
      }
      expect(store.requests.some((r) => r.op === 'CompleteMultipartUpload' && r.status === 200)).toBe(
        true
      );
    });
  });

  it('is refused by a store created with the legacy deployment-wide credential', async () => {
    // The failure shape from the report: the signer and the store disagree. A
    // store still on `admin` + MINIO_ROOT_PASSWORD does not know the per-stack
    // key id at all, so the init our routes sign is rejected rather than served.
    const perStack = provisionCredentialForNewStack();

    await withStore(
      { accessKeyId: LEGACY_OBJECT_STORE_ACCESS_KEY_ID, secretAccessKey: SEED },
      async (store) => {
        const paramStore = makeStore({
          [STACK_NAME]: readyStackConfig(store.endpoint, perStack.accessKeyId)
        });
        const storage = await storageForRequest(makeResolver(paramStore));

        await expect(
          storage.initiateMultipartUpload(sourceObjectKey(ASSET_ID))
        ).rejects.toThrow();
        expect(store.requests.some((r) => r.status === 403)).toBe(true);
        expect(store.objects.size).toBe(0);
      }
    );
  });

  it('reports at ERROR when the resolved credential is not the one the stack was created with', async () => {
    // The in-repo hole the incident would have been diagnosed by: with no seed
    // in this process, the stack's recorded per-stack id cannot be re-derived
    // and the resolver substitutes the legacy deployment-wide pair — a
    // credential the live instance has never heard of. The substitution used to
    // be silent, so the first signed request (the multipart initiate) failed
    // with nothing naming the stack or the credential.
    const perStack = provisionCredentialForNewStack();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await withStore(perStack, async (store) => {
      const paramStore = makeStore({
        [STACK_NAME]: readyStackConfig(store.endpoint, perStack.accessKeyId)
      });
      const resolver = new WorkspaceStackResolver({
        paramStore,
        oscContext,
        // MINIO_ROOT_PASSWORD missing on this process — the reachable cause.
        minioPassword: '',
        couchPassword: COUCH_PASSWORD,
        log
      });
      const storage = await storageForRequest(resolver);

      await expect(
        storage.initiateMultipartUpload(sourceObjectKey(ASSET_ID))
      ).rejects.toThrow();

      const reported = log.error.mock.calls.find(([obj]) =>
        Boolean(obj && typeof obj === 'object' && 'expectedAccessKeyId' in obj)
      );
      expect(reported).toBeDefined();
      const [context, message] = reported!;
      expect(context).toMatchObject({
        stackName: STACK_NAME,
        expectedAccessKeyId: perStack.accessKeyId,
        resolvedAccessKeyId: LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
        resolvedSecretPresent: false,
        seedConfigured: false
      });
      expect(String(message)).toContain('MINIO_ROOT_PASSWORD');
      // The report must stay secret-free: no part of the credential material.
      const logged = JSON.stringify(log.error.mock.calls);
      expect(logged).not.toContain(perStack.secretAccessKey);
      expect(logged).not.toContain(SEED);
    });
  });

  it('does not keep signing with a cached client after the stack credential changes', async () => {
    // "Stale cached client" was one of the named candidates. The resolver caches
    // connections (and therefore the signing client) for 5 minutes, so a
    // re-issued credential must be picked up by the invalidation the provision
    // route performs — not waited out.
    const firstCredential = provisionCredentialForNewStack();
    const reIssued = planObjectStoreCredential({
      stackName: STACK_NAME,
      seed: SEED,
      legacySecretAccessKey: SEED,
      storedAccessKeyId: undefined,
      storedConfigExists: false,
      objectStoreInstanceExists: false,
      // A re-provision of the same stack name mints a NEW generation, so the
      // pair differs from the retired one.
      generation: newObjectStoreCredentialGeneration(),
      paramStoreAvailable: true
    }).credential;
    expect(reIssued.accessKeyId).not.toBe(firstCredential.accessKeyId);

    await withStore(firstCredential, async (first) => {
      const paramStore = makeStore({
        [STACK_NAME]: readyStackConfig(first.endpoint, firstCredential.accessKeyId)
      });
      const resolver = makeResolver(paramStore);
      const storage = await storageForRequest(resolver);
      await storage.initiateMultipartUpload(sourceObjectKey(ASSET_ID));

      await withStore(reIssued, async (second) => {
        // The stack is re-provisioned: new endpoint, new recorded key id.
        await paramStore.storeStackConfig(
          STACK_CONFIG_NAMESPACE,
          STACK_NAME,
          readyStackConfig(second.endpoint, reIssued.accessKeyId)
        );
        resolver.invalidate();

        const reResolved = await storageForRequest(resolver);
        const uploadId = await reResolved.initiateMultipartUpload(sourceObjectKey(ASSET_ID));
        expect(uploadId).toMatch(/^upload-\d+$/);
        const init = second.requests.find((r) => r.op === 'CreateMultipartUpload');
        expect(init?.accessKeyId).toBe(reIssued.accessKeyId);
        expect(second.requests.filter((r) => r.status >= 400)).toEqual([]);
      });
    });
  });
});
