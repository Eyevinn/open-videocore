// `drm-no-key-leak` — no content key may cross a persistence, serialisation,
// audit or HTTP boundary (ADR-008 §10 "Key material", D4; issue #1267).
//
// WHAT THIS GUARDS. Every DRM-carrying shape in the codebase is either
// TRANSIENT (lives only in the call stack that builds a packaging job) or a
// SINK (persisted, serialised, logged, audited or returned). Key bytes are
// allowed in the former and never in the latter. The type system cannot state
// that rule, so it is stated here: each sink is enumerated below with a
// fully-populated fixture, serialised through `JSON.stringify`, and asserted to
// carry no property whose name is `key`, `keys`, `plainValue`, `PlainValue` or
// anything else matching /key/i beyond the allowed `keyId` / `keyIds`.
//
// WHY AN ALLOWLIST OF FILES TOO (issue #1267 constraint: "adding a new sink
// without a corresponding test entry must cause a CI failure"). A fixture list
// alone only covers the sinks someone remembered. `declares a drm member` below
// therefore scans `src/` for every type that declares a `drm` member and
// asserts the set of files equals `DRM_MEMBER_FILES`. A new DRM-carrying type in
// a new module fails this test until it is reviewed and either added to the
// enumerated sinks or recorded as transient.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
//   - `AssetDrm` (`status`, `providerId`, `scheme`, `systems`,
//     `keyIds: { trackGroup, keyId }[]`, `licenceUrls?`, `certificateUrl?`,
//     `requestedAt`, `protectedAt?`, `error?`, `errorCode?`) and `Asset.drm?` —
//     src/data/asset-repo.ts:494-511, :730.
//   - `AssetDrmSchema` / `DocAssetDrm` (the document write shape) —
//     src/data/asset-document.ts:211-228.
//   - `PipelineExecution['drm']`
//     (`{ requested: true; providerId?; systems?; scheme? }`) —
//     src/data/pipeline-repo.ts:100.
//   - `PackagingJob` (`{ jobId, url }`), `PackageQueue.enqueue`,
//     `EncryptionParams` (`scheme`, `keys: { label, keyId, key }[]`, `pssh`,
//     `hlsKeyUri?`, `protectionSystems`), `clearPackagingRunner`,
//     `enqueuePackagingStep`, `PackagingStepDeps`, `AssetDrmStore`,
//     `markDrmProtected`, `DRM_AUDIT_ACTIONS` — src/pipeline/packaging.ts:282-296,
//     :507-510, and the symbols under test.
//   - `ContentKey` (`trackGroup`, `keyId`, `key: Uint8Array`, `iv?`),
//     `DrmSignalling` (`pssh`, `licenceUrls`, `certificateUrl`, `hlsKeyUri`),
//     `KeyProvider.acquire(req, signal)`, `CLEAR_KEY_SYSTEM_ID` —
//     src/drm/key-provider.ts:51-162.
//   - `PRESERVED_DRM` (symbol-keyed flag-off carrier, invisible to
//     `JSON.stringify`) and `DrmStatus` / `DrmErrorCode` — src/types/drm.ts.
//   - `RecordAuditInput` (`actor`, `action`, `targetType`, `targetId`,
//     `detail`) and `AuditEmitter.record` — src/data/audit-repo.ts:96-105,
//     src/data/audit-emit.ts:29-31.
//
// ADDITIVE ONLY: no pre-existing test file or assertion is touched.

import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  clearPackagingRunner,
  enqueuePackagingStep,
  markDrmProtected,
  DRM_AUDIT_ACTIONS,
  type AssetDrmStore,
  type EncryptingPackagingRunner,
  type EncryptionParams,
  type PackageQueue,
  type PackagingJob,
  type PackagingStepDeps
} from '../src/pipeline/packaging.js';
import type { Asset, AssetDrm } from '../src/data/asset-repo.js';
import { AssetDrmSchema } from '../src/data/asset-document.js';
import type { PipelineExecution } from '../src/data/pipeline-repo.js';
import type { ContentKey, DrmSignalling, KeyProvider } from '../src/drm/key-provider.js';
import { CLEAR_KEY_SYSTEM_ID } from '../src/drm/key-provider.js';
import { PRESERVED_DRM } from '../src/types/drm.js';
import type { RecordAuditInput } from '../src/data/audit-repo.js';

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

// The ONLY /key/i property names a sink may carry: key IDENTIFIERS, which
// ADR-008 D4 states are the one part of a key that is ever persisted.
const ALLOWED_KEY_PROPERTIES = new Set(['keyId', 'keyIds']);

// Names that are forbidden even though some of them do not match /key/i
// (issue #1267 names them explicitly).
const FORBIDDEN_PROPERTIES = new Set(['key', 'keys', 'plainValue', 'PlainValue']);

// Every offending property PATH in the serialised form of `value`. Walks the
// JSON round-trip rather than the live object, so what is inspected is exactly
// what would be written to CouchDB, sent on an HTTP response or handed to a log.
function keyLeaks(value: unknown): string[] {
  const serialised = JSON.stringify(value);
  const parsed: unknown = serialised === undefined ? undefined : JSON.parse(serialised);
  const leaks: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [name, child] of Object.entries(node)) {
      const here = path === '' ? name : `${path}.${name}`;
      const offends =
        FORBIDDEN_PROPERTIES.has(name) ||
        (/key/i.test(name) && !ALLOWED_KEY_PROPERTIES.has(name));
      if (offends) leaks.push(here);
      visit(child, here);
    }
  };
  visit(parsed, '');
  return leaks;
}

// ---------------------------------------------------------------------------
// Fixtures — one fully-populated value per sink
// ---------------------------------------------------------------------------

const ASSET_ID = 'asset-1267';
const KEY_ID = '11111111-2222-3333-4444-555555555555';
const SYSTEM_ID = CLEAR_KEY_SYSTEM_ID;
const KEY_BYTE = 0x5a;

// Sink 1: the persisted / serialised asset protection block. Every optional
// member populated, so the walk sees the widest shape this type can take.
const assetDrm: AssetDrm = {
  status: 'protected',
  providerId: 'primary',
  scheme: 'cbcs',
  systems: [SYSTEM_ID],
  keyIds: [{ trackGroup: 'SD', keyId: KEY_ID }],
  licenceUrls: { [SYSTEM_ID]: 'https://licence.example/licence' },
  certificateUrl: 'https://licence.example/cert',
  requestedAt: '2026-11-05T10:00:00.000Z',
  protectedAt: '2026-11-05T10:00:05.000Z',
  error: 'the key provider rejected the key request',
  errorCode: 'key_provider_rejected'
};

// The same block before the package landed: `pending`, no `protectedAt`, and
// carrying the redacted error of an earlier attempt (which the transition
// drops). Written out rather than spread with `protectedAt: undefined`, because
// `exactOptionalPropertyTypes` makes an explicit `undefined` a type error.
const pendingDrm: AssetDrm = {
  status: 'pending',
  providerId: 'primary',
  scheme: 'cbcs',
  systems: [SYSTEM_ID],
  keyIds: [{ trackGroup: 'SD', keyId: KEY_ID }],
  licenceUrls: { [SYSTEM_ID]: 'https://licence.example/licence' },
  certificateUrl: 'https://licence.example/cert',
  requestedAt: '2026-11-05T10:00:00.000Z',
  error: 'the key provider rejected the key request',
  errorCode: 'key_provider_rejected'
};

// Sink 3: the per-execution DRM request that rides on a pipeline execution.
const executionDrm: NonNullable<PipelineExecution['drm']> = {
  requested: true,
  providerId: 'primary',
  systems: [SYSTEM_ID],
  scheme: 'cbcs'
};

// Sink 6 inputs: the three audit details, built by the module under test.
async function captureAuditEntries(
  run: (deps: PackagingStepDeps) => Promise<unknown>,
  seed?: AssetDrm
): Promise<{ entries: RecordAuditInput[]; patches: { drm?: AssetDrm }[] }> {
  const entries: RecordAuditInput[] = [];
  const patches: { drm?: AssetDrm }[] = [];
  let stored: AssetDrm | undefined = seed;
  const assets: AssetDrmStore = {
    async get() {
      return stored ? { drm: stored } : undefined;
    },
    async update(_id, patch) {
      patches.push(patch);
      if (patch.drm) stored = patch.drm;
      return undefined;
    }
  };
  const deps: PackagingStepDeps = {
    runner: encryptingRunner().runner,
    keyProvider: keyProvider().provider,
    assets,
    audit: {
      async record(input) {
        entries.push(input);
        return undefined;
      }
    },
    now: () => '2026-11-05T10:00:00.000Z'
  };
  await run(deps);
  // `emitAudit` is fire-and-forget (src/data/audit-emit.ts:66-74): the write is
  // detached onto the microtask queue, so drain it before asserting.
  await Promise.resolve();
  await Promise.resolve();
  return { entries, patches };
}

function encryptingRunner(options?: {
  enqueue?: (job: PackagingJob & { encryption?: EncryptionParams }) => Promise<void>;
}): { runner: EncryptingPackagingRunner; seen: (PackagingJob & { encryption?: EncryptionParams })[] } {
  const seen: (PackagingJob & { encryption?: EncryptionParams })[] = [];
  return {
    seen,
    runner: {
      async capabilities() {
        return { encryption: true, schemes: ['cbcs'], systems: [SYSTEM_ID] };
      },
      async enqueue(job) {
        seen.push(job);
        if (options?.enqueue) await options.enqueue(job);
      }
    }
  };
}

function keyProvider(options?: { fail?: unknown }): {
  provider: KeyProvider;
  issued: ContentKey[];
} {
  const issued: ContentKey[] = [];
  return {
    issued,
    provider: {
      id: 'primary',
      kind: 'cpix',
      async acquire() {
        if (options?.fail !== undefined) throw options.fail;
        const key: ContentKey = {
          trackGroup: 'SD',
          keyId: KEY_ID,
          key: new Uint8Array(16).fill(KEY_BYTE)
        };
        issued.push(key);
        const signalling: DrmSignalling = {
          pssh: { [SYSTEM_ID]: 'cHNzaA==' },
          licenceUrls: { [SYSTEM_ID]: 'https://licence.example/licence' }
        };
        return { keys: [key], signalling };
      }
    }
  };
}

// ---------------------------------------------------------------------------
// The enumerated sinks
// ---------------------------------------------------------------------------

type Sink = { name: string; value: unknown };

async function enumerateSinks(): Promise<Sink[]> {
  const sinks: Sink[] = [];

  // 1. `AssetDrm` — the domain block routes send and the mapper persists.
  sinks.push({ name: 'AssetDrm (src/data/asset-repo.ts:494)', value: assetDrm });

  // 2. The DOCUMENT write shape, i.e. what the schema actually accepts and
  //    therefore what reaches CouchDB (`AssetDrmSchema.parse`, which strips
  //    unknown members — so this asserts the SCHEMA, not just the fixture).
  sinks.push({
    name: 'DocAssetDrm (src/data/asset-document.ts:211)',
    value: AssetDrmSchema.parse(assetDrm)
  });

  // 3. `PipelineExecution.drm` — persisted on the execution document.
  sinks.push({ name: "PipelineExecution['drm'] (src/data/pipeline-repo.ts:100)", value: executionDrm });

  // 4. The QUEUE ENTRY. `PackagingJob` is `{ jobId, url }`
  //    (src/pipeline/packaging.ts) and `clearPackagingRunner` is the adapter
  //    that puts a job on the real queue, so the entry is captured from a
  //    recording `PackageQueue` rather than hand-written.
  const enqueued: PackagingJob[] = [];
  const queue: PackageQueue = {
    async enqueue(job) {
      enqueued.push(job);
    }
  };
  await enqueuePackagingStep(
    { runner: clearPackagingRunner(queue) },
    { job: { jobId: ASSET_ID, url: 'http://transcoder/job/abc' } }
  );
  sinks.push({ name: 'PackageQueue entry (clearPackagingRunner)', value: enqueued });

  // 5. The HTTP response shape that carries `drm` — routes send the domain
  //    object directly (`reply.send(asset)`, src/routes/assets.ts), and the
  //    symbol-keyed flag-off carrier must stay invisible to the serialiser
  //    (src/types/drm.ts `PRESERVED_DRM`).
  const responseShape: Pick<Asset, 'id' | 'drm'> & { [PRESERVED_DRM]?: AssetDrm } = {
    id: ASSET_ID,
    drm: assetDrm,
    [PRESERVED_DRM]: assetDrm
  };
  sinks.push({ name: 'HTTP response drm block (Pick<Asset,"drm">)', value: responseShape });

  // 6. The three audit details and the persisted patches produced by the real
  //    emitters, for the real key-acquisition and protected-transition paths.
  const acquired = await captureAuditEntries((deps) =>
    enqueuePackagingStep(deps, {
      job: { jobId: ASSET_ID, url: 'http://transcoder/job/abc' },
      drm: { requested: true, systems: [SYSTEM_ID], scheme: 'cbcs' }
    })
  );
  sinks.push({ name: 'audit detail drm.keys.requested', value: acquired.entries });
  sinks.push({ name: 'asset.drm patches (key-acquisition path)', value: acquired.patches });

  const protectedRun = await captureAuditEntries(
    (deps) => markDrmProtected(deps, ASSET_ID),
    pendingDrm
  );
  sinks.push({ name: 'audit detail drm.protected', value: protectedRun.entries });

  const failedRun = await captureAuditEntries(
    (deps) =>
      enqueuePackagingStep(
        { ...deps, keyProvider: keyProvider({ fail: new Error('provider down') }).provider },
        {
          job: { jobId: ASSET_ID, url: 'http://transcoder/job/abc' },
          drm: { requested: true, systems: [SYSTEM_ID], scheme: 'cbcs' }
        }
      ).catch(() => undefined),
    assetDrm
  );
  sinks.push({ name: 'audit detail drm.failed', value: failedRun.entries });

  return sinks;
}

// Files that declare a `drm` member on a type. Reviewed one by one: each is
// either an enumerated sink above or TRANSIENT key-carrying code that the
// enumerated sinks prove cannot reach a boundary.
const DRM_MEMBER_FILES = [
  // `AssetDrm` + `Asset.drm` + `UpdateAssetInput.drm` — sinks 1 and 5.
  'src/data/asset-repo.ts',
  // `AssetDocument.structural.drm` / `AssetDrmSchema` — sink 2.
  'src/data/asset-document.ts',
  // `PipelineExecution.drm` + `cloneDrmRequest` — sink 3.
  'src/data/pipeline-repo.ts',
  // The execution document mapper for sink 3.
  'src/data/couch-pipeline-repo.ts',
  // `EncryptionParams` (TRANSIENT) + the queue entry of sink 4 + the audit
  // details of sink 6.
  'src/pipeline/packaging.ts',
  // `StackConfig.drm` — operator configuration, no key material (ADR-008 §5.2).
  'src/services/param-store.ts',
  // `DrmStackConfig` / `DrmConfigView` — operator configuration, no key
  // material; credentials are read from the environment at call time.
  'src/drm/drm-config.ts',
  // The delivery `drm` block, `GET /:id/drm` and the `drm` request member on
  // POST /:id/package / POST /:id/execute (issue #1266). REVIEWED: all four are
  // closed `z.object` schemas with no `key`, `keys` or `iv` member, so the
  // serialiser cannot emit one. The response shapes are PROJECTIONS of the
  // persisted `AssetDrm` (sink 1) — `deliveryDrmFor` copies `scheme`, the
  // system ids, the licence/certificate URLs and the key IDENTIFIERS only, and
  // `GET /:id/drm` sends the stored block itself. The request member is the
  // intent shape of `PipelineExecution['drm']` (sink 3), which carries no key
  // identifier at all. No key material exists anywhere in this module: it never
  // constructs a `ContentKey`, an `EncryptionParams` or a `DrmSignalling`.
  'src/routes/assets.ts'
];

async function sourceFilesDeclaringDrmMember(): Promise<string[]> {
  const root = new URL('../src/', import.meta.url).pathname;
  const found: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path, `${rel}/`);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const source = await readFile(path, 'utf8');
      // A type member named exactly `drm`, optional or not. Deliberately not a
      // parse: the point is a cheap, over-inclusive net that fails LOUD.
      if (/^\s*drm\??:/m.test(source)) found.push(`src/${rel}`);
    }
  };
  await walk(root, '');
  return found.sort();
}

describe('drm-no-key-leak (issue #1267, ADR-008 §10 / D4)', () => {
  it('no enumerated serialisation sink carries key material', async () => {
    const sinks = await enumerateSinks();
    // Guards the enumeration itself: a silently empty list would pass every
    // assertion below.
    expect(sinks.length).toBeGreaterThanOrEqual(9);
    for (const sink of sinks) {
      expect(keyLeaks(sink.value), `key-like property in ${sink.name}`).toEqual([]);
    }
  });

  it('detects a raw key field added to any sink fixture', async () => {
    const sinks = await enumerateSinks();
    for (const sink of sinks) {
      // The negative control of the acceptance criteria: the same detector,
      // over the same sink value with a raw `key` member grafted on, must
      // report a leak. A detector that cannot see this is a detector that
      // proves nothing above.
      const tampered = Array.isArray(sink.value)
        ? [...(sink.value as unknown[]), { key: 'abc' }]
        : { ...(sink.value as Record<string, unknown>), key: 'abc' };
      expect(keyLeaks(tampered).length, `tampered ${sink.name}`).toBeGreaterThan(0);
    }
  });

  it('flags every forbidden property name, and no allowed one', () => {
    expect(keyLeaks({ key: 'abc' })).toEqual(['key']);
    expect(keyLeaks({ keys: [{ keyId: KEY_ID, key: 'abc' }] })).toEqual(['keys', 'keys[0].key']);
    expect(keyLeaks({ plainValue: 'abc' })).toEqual(['plainValue']);
    expect(keyLeaks({ PlainValue: 'abc' })).toEqual(['PlainValue']);
    expect(keyLeaks({ contentKey: 'abc' })).toEqual(['contentKey']);
    expect(keyLeaks({ KEY: 'abc' })).toEqual(['KEY']);
    expect(keyLeaks({ nested: { deep: [{ keyMaterial: 'abc' }] } })).toEqual([
      'nested.deep[0].keyMaterial'
    ]);
    expect(keyLeaks({ keyId: KEY_ID, keyIds: [{ trackGroup: 'SD', keyId: KEY_ID }] })).toEqual([]);
  });

  it('every file declaring a drm member is a reviewed sink (allowlist)', async () => {
    // The CI failure the #1267 constraint asks for: a new DRM-carrying type in
    // a module nobody listed here fails until it is reviewed and either added
    // to the enumerated sinks above or recorded as transient.
    expect(await sourceFilesDeclaringDrmMember()).toEqual([...DRM_MEMBER_FILES].sort());
  });

  it('the audit action vocabulary is exactly the three #1267 actions', () => {
    expect([...DRM_AUDIT_ACTIONS]).toEqual(['drm.keys.requested', 'drm.protected', 'drm.failed']);
  });
});
