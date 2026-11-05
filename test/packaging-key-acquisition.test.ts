// Key-acquisition step in the packaging pipeline — the full failure matrix,
// idempotent re-package and the key-zeroing guarantee (issue #1264; ADR-008 §6,
// §12, D2, D4).
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
//   - `enqueuePackagingStep`, `PackagingStepDeps` (`runner`, `keyProvider`,
//     `signal`, `drmConfig`, `env`, `assets`, `audit`, `auditLog`, `now`),
//     `AssetDrmStore`, `DRM_STEP_DEADLINE_MS`, `DRM_STEP_ERROR_MESSAGES`,
//     `zeroContentKeys`, `DRM_UNSUPPORTED_REFUSAL`, `DRM_NOT_CONFIGURED_REFUSAL`
//     — src/pipeline/packaging.ts (the symbols under test).
//   - `KeyProvider.acquire(req, signal)`, `KeyRequest`
//     (`contentId`, `systems`, `scheme`, `trackGroups`,
//     `keyIds?: Partial<Record<TrackTypeGroup, string>>`), `ContentKey`
//     (`trackGroup`, `keyId`, `key: Uint8Array`), `DrmSignalling`
//     (`pssh`, `licenceUrls`, `certificateUrl`, `hlsKeyUri`),
//     `CLEAR_KEY_SYSTEM_ID` — src/drm/key-provider.ts:51-162.
//   - `KeyProviderError(errorCode, message, attempts?)` —
//     src/drm/key-provider-error.ts:28-41.
//   - `AssetDrm` (`status`, `providerId`, `scheme`, `systems`, `keyIds[]`,
//     `licenceUrls?`, `certificateUrl?`, `requestedAt`, `error?`, `errorCode?`)
//     and `UpdateAssetInput.drm` — src/data/asset-repo.ts:494-511, :958-977.
//   - `DRM_STATUSES` / `DRM_ERROR_CODES` — src/types/drm.ts:87-101.
//   - `DrmStackConfig` (`enabled`, `providerKind`, `providerId`, `authMode`,
//     `scheme`, `systems`, `licenceUrls`, `certificateUrls`, `trackGroups`),
//     `ENV_TOKEN`, `loadDrmStackConfig`'s `DRM_ENABLED` short-circuit —
//     src/drm/drm-config.ts:120-160, :552-558, :634-642.
//   - `ParamStore` (`storeStackConfig`, `loadStackConfig`, `deleteStackConfig`,
//     `listStackNames`) and `StackConfig` — src/services/param-store.ts:213-240.
//   - `RecordAuditInput` (`actor`, `action`, `targetType` in
//     `['asset','collection','job']`, `targetId`, `detail`) —
//     src/data/audit-repo.ts:53, :96-105.
//
// ADDITIVE ONLY: no pre-existing test file or assertion is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clearPackagingRunner,
  enqueuePackagingStep,
  zeroContentKeys,
  DRM_NOT_CONFIGURED_REFUSAL,
  DRM_STEP_DEADLINE_MS,
  DRM_STEP_ERROR_MESSAGES,
  DRM_UNSUPPORTED_REFUSAL,
  type AssetDrmStore,
  type EncryptingPackagingRunner,
  type EncryptionParams,
  type PackageQueue,
  type PackagingJob
} from '../src/pipeline/packaging.js';
import type { AssetDrm } from '../src/data/asset-repo.js';
import type { ContentKey, KeyProvider, KeyRequest } from '../src/drm/key-provider.js';
import { CLEAR_KEY_SYSTEM_ID } from '../src/drm/key-provider.js';
import { KeyProviderError } from '../src/drm/key-provider-error.js';
import type { DrmStackConfig } from '../src/drm/drm-config.js';
// `ENV_TOKEN` is defined (and exported) by the CPIX adapter — drm-config.ts
// imports it from there rather than redeclaring the name (src/drm/cpix-provider.ts:82).
import { ENV_TOKEN } from '../src/drm/cpix-provider.js';
import type { ParamStore, StackConfig } from '../src/services/param-store.js';
import type { RecordAuditInput } from '../src/data/audit-repo.js';

const ASSET_ID = 'asset-1264';
const JOB: PackagingJob = { jobId: ASSET_ID, url: 'http://encore/job/abc' };
const KEY_ID = '11111111-2222-3333-4444-555555555555';
// The raw 16 key bytes a provider hands back. A recognisable non-zero filler so
// "the buffer was zeroed" is a real assertion rather than a tautology.
const KEY_BYTE = 0x5a;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// A runner that reports encryption support, records what it was handed, and can
// be told to fail or to hang on enqueue.
function encryptingRunner(options?: {
  enqueue?: (
    job: PackagingJob & { encryption?: EncryptionParams }
  ) => Promise<void>;
  schemes?: EncryptionParams['scheme'][];
  systems?: string[];
}): {
  runner: EncryptingPackagingRunner;
  seen: (PackagingJob & { encryption?: EncryptionParams })[];
  signals: (AbortSignal | undefined)[];
} {
  const seen: (PackagingJob & { encryption?: EncryptionParams })[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  return {
    seen,
    signals,
    runner: {
      async capabilities() {
        return {
          encryption: true,
          schemes: [...(options?.schemes ?? ['cbcs'])],
          systems: [...(options?.systems ?? [CLEAR_KEY_SYSTEM_ID])]
        };
      },
      async enqueue(job, opts) {
        signals.push(opts?.signal);
        if (options?.enqueue) {
          await options.enqueue(job);
          return;
        }
        seen.push(job);
      }
    }
  };
}

// A key provider whose returned `ContentKey` buffers the test KEEPS a reference
// to, so the zeroing guarantee can be asserted from the outside.
function keyProvider(options?: {
  fail?: unknown;
  trackGroups?: ContentKey['trackGroup'][];
}): {
  provider: KeyProvider & { acquire: ReturnType<typeof vi.fn> };
  issued: ContentKey[];
  requests: KeyRequest[];
  signals: AbortSignal[];
} {
  const issued: ContentKey[] = [];
  const requests: KeyRequest[] = [];
  const signals: AbortSignal[] = [];
  const provider = {
    id: 'primary' as const,
    kind: 'clearkey-dev' as const,
    acquire: vi.fn(async (req: KeyRequest, signal: AbortSignal) => {
      requests.push(req);
      signals.push(signal);
      if (options?.fail !== undefined) throw options.fail;
      const groups = options?.trackGroups ?? req.trackGroups;
      const keys: ContentKey[] = groups.map((trackGroup, index) => ({
        trackGroup,
        // A re-request echoes the persisted key id back (that is the whole
        // point of `KeyRequest.keyIds`); a mint answers with a fresh one.
        keyId: req.keyIds?.[trackGroup] ?? `${KEY_ID.slice(0, -1)}${index}`,
        key: new Uint8Array(16).fill(KEY_BYTE)
      }));
      issued.push(...keys);
      return {
        keys,
        signalling: {
          pssh: { [CLEAR_KEY_SYSTEM_ID]: 'cHNzaA==' },
          licenceUrls: { [CLEAR_KEY_SYSTEM_ID]: 'https://licence.example/' },
          hlsKeyUri: 'skd://key',
          dev: true as const
        }
      };
    })
  };
  return { provider, issued, requests, signals };
}

// The narrow `asset.drm` seam (`AssetDrmStore`), recording every write so a test
// can assert both the persisted shape and that no key material reached it.
function assetDrmStore(initial?: AssetDrm): {
  store: AssetDrmStore;
  writes: AssetDrm[];
  current: () => AssetDrm | undefined;
} {
  let drm = initial;
  const writes: AssetDrm[] = [];
  return {
    writes,
    current: () => drm,
    store: {
      async get() {
        return drm ? { drm } : {};
      },
      async update(_id, patch) {
        if (patch.drm !== undefined) {
          drm = patch.drm;
          writes.push(patch.drm);
        }
        return drm;
      }
    }
  };
}

const STORED_STACK: StackConfig = {
  status: 'ready',
  minioEndpoint: 'https://minio.example.com',
  couchdbUrl: 'https://couch.example.com',
  redisUrl: 'redis://valkey.example.com:6379',
  sourceBucket: 'source',
  packagedBucket: 'packaged',
  services: [{ serviceId: 'svc', instanceName: 'inst' }]
};

const DEV_DRM_CONFIG: DrmStackConfig = {
  enabled: true,
  providerKind: 'clearkey-dev',
  providerId: 'primary',
  scheme: 'cbcs',
  systems: [CLEAR_KEY_SYSTEM_ID]
};

function paramStore(drm?: DrmStackConfig): ParamStore {
  return {
    loadStackConfig: vi.fn(async () =>
      drm ? { ...STORED_STACK, drm } : { ...STORED_STACK }
    ),
    storeStackConfig: vi.fn(async () => {}),
    deleteStackConfig: vi.fn(async () => {}),
    listStackNames: vi.fn(async () => ['main'])
  } satisfies ParamStore;
}

function locator(drm?: DrmStackConfig): {
  paramStore: ParamStore;
  workspaceId: string;
  stackName: string;
} {
  return { paramStore: paramStore(drm), workspaceId: 'ws', stackName: 'main' };
}

function auditSink(): { audit: { record: ReturnType<typeof vi.fn> }; entries: RecordAuditInput[] } {
  const entries: RecordAuditInput[] = [];
  return {
    entries,
    audit: {
      record: vi.fn(async (input: RecordAuditInput) => {
        entries.push(input);
        return input;
      })
    }
  };
}

const KEY_B64 = Buffer.alloc(16, KEY_BYTE).toString('base64');

function expectAllZero(keys: readonly ContentKey[]): void {
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) {
    expect(key.key).toHaveLength(16);
    expect([...key.key].every((b) => b === 0)).toBe(true);
  }
}

const TOUCHED = ['DRM_ENABLED', ENV_TOKEN] as const;
const originals = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of TOUCHED) {
    originals.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of TOUCHED) {
    const value = originals.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ADR-008 §12 failure matrix
// ---------------------------------------------------------------------------

describe('key-acquisition failure matrix (ADR-008 §12, issue #1264)', () => {
  it('DRM flag off: refuses 501 not_configured without reading keys', async () => {
    // `DRM_ENABLED` is unset (see beforeEach), so `loadDrmStackConfig`
    // short-circuits and the step has no usable configuration.
    const { runner, seen } = encryptingRunner();
    const { provider } = keyProvider();
    const assets = assetDrmStore();
    const config = locator(DEV_DRM_CONFIG);

    const outcome = await enqueuePackagingStep(
      { runner, keyProvider: provider, assets: assets.store, drmConfig: config },
      { job: JOB, drm: { requested: true } }
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toEqual(DRM_NOT_CONFIGURED_REFUSAL);
    expect(outcome.refusal.status).toBe(501);
    expect(outcome.refusal.error).toBe('not_configured');
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(assets.writes).toEqual([]);
  });

  it('DRM flag on but the stack block is disabled: refuses 501, no acquire', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const { runner, seen } = encryptingRunner();
    const { provider } = keyProvider();

    const outcome = await enqueuePackagingStep(
      {
        runner,
        keyProvider: provider,
        drmConfig: locator({ ...DEV_DRM_CONFIG, enabled: false })
      },
      { job: JOB, drm: { requested: true } }
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toEqual(DRM_NOT_CONFIGURED_REFUSAL);
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('cpix provider with no credential in the environment: refuses 501, no acquire', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const { runner } = encryptingRunner();
    const { provider } = keyProvider();

    const outcome = await enqueuePackagingStep(
      {
        runner,
        keyProvider: provider,
        env: {},
        drmConfig: locator({
          enabled: true,
          providerKind: 'cpix',
          providerId: 'primary',
          keyServerUrl: 'https://keys.example.com/cpix',
          authMode: 'bearer',
          scheme: 'cbcs',
          systems: [CLEAR_KEY_SYSTEM_ID]
        })
      },
      { job: JOB, drm: { requested: true } }
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toEqual(DRM_NOT_CONFIGURED_REFUSAL);
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it('cpix provider WITH the credential present proceeds to acquire', async () => {
    // The mirror of the case above: credential STATUS is the only thing read,
    // and `configured` must not block the step.
    process.env['DRM_ENABLED'] = 'true';
    const { runner, seen } = encryptingRunner();
    const { provider } = keyProvider();

    const outcome = await enqueuePackagingStep(
      {
        runner,
        keyProvider: provider,
        env: { [ENV_TOKEN]: 'a-token' },
        drmConfig: locator({
          enabled: true,
          providerKind: 'cpix',
          providerId: 'primary',
          keyServerUrl: 'https://keys.example.com/cpix',
          authMode: 'bearer',
          scheme: 'cbcs',
          systems: [CLEAR_KEY_SYSTEM_ID]
        })
      },
      { job: JOB, drm: { requested: true } }
    );

    expect(outcome).toEqual({ ok: true, encrypted: true });
    expect(provider.acquire).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it('runner cannot encrypt: 409 drm_unsupported and KeyProvider.acquire is never called', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const enqueued: PackagingJob[] = [];
    const queue: PackageQueue = {
      async enqueue(job) {
        enqueued.push(job);
      }
    };
    const { provider } = keyProvider();
    const assets = assetDrmStore();

    const outcome = await enqueuePackagingStep(
      {
        runner: clearPackagingRunner(queue),
        keyProvider: provider,
        assets: assets.store,
        drmConfig: locator(DEV_DRM_CONFIG)
      },
      { job: JOB, drm: { requested: true } }
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toEqual(DRM_UNSUPPORTED_REFUSAL);
    expect(outcome.refusal.status).toBe(409);
    expect(outcome.refusal.errorCode).toBe('drm_unsupported');
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(enqueued).toEqual([]);
    expect(assets.writes).toEqual([]);
  });

  it('provider unreachable after 3 attempts: key_provider_unreachable, nothing enqueued', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const unreachable = new KeyProviderError(
      'key_provider_unreachable',
      'key provider did not respond',
      3
    );
    const { runner, seen } = encryptingRunner();
    const { provider } = keyProvider({ fail: unreachable });
    const assets = assetDrmStore();

    await expect(
      enqueuePackagingStep(
        {
          runner,
          keyProvider: provider,
          assets: assets.store,
          drmConfig: locator(DEV_DRM_CONFIG),
          now: () => '2026-11-05T00:00:00.000Z'
        },
        { job: JOB, drm: { requested: true } }
      )
    ).rejects.toBe(unreachable);

    expect(seen).toEqual([]);
    expect(assets.writes).toHaveLength(1);
    const recorded = assets.writes[0] as AssetDrm;
    expect(recorded.status).toBe('failed');
    expect(recorded.errorCode).toBe('key_provider_unreachable');
    expect(recorded.error).toBe(
      DRM_STEP_ERROR_MESSAGES['key_provider_unreachable']
    );
    // No key material anywhere in the persisted block (ADR-008 D4).
    expect(JSON.stringify(recorded)).not.toContain(KEY_B64);
    expect(Object.keys(recorded)).not.toContain('key');
  });

  it('provider 4xx: key_provider_rejected recorded, no retry decision made here', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const rejected = new KeyProviderError(
      'key_provider_rejected',
      'key provider rejected the request',
      1
    );
    const { runner, seen } = encryptingRunner();
    const { provider } = keyProvider({ fail: rejected });
    const assets = assetDrmStore();

    await expect(
      enqueuePackagingStep(
        {
          runner,
          keyProvider: provider,
          assets: assets.store,
          drmConfig: locator(DEV_DRM_CONFIG)
        },
        { job: JOB, drm: { requested: true } }
      )
    ).rejects.toBe(rejected);

    // The adapter owns the retry policy; the step makes exactly ONE call.
    expect(provider.acquire).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    expect((assets.writes[0] as AssetDrm).errorCode).toBe('key_provider_rejected');
    expect((assets.writes[0] as AssetDrm).status).toBe('failed');
  });

  it('malformed provider response: key_provider_invalid_response recorded', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const invalid = new KeyProviderError(
      'key_provider_invalid_response',
      'key provider response could not be parsed',
      1
    );
    const { runner, seen } = encryptingRunner();
    const { provider } = keyProvider({ fail: invalid });
    const assets = assetDrmStore();

    await expect(
      enqueuePackagingStep(
        {
          runner,
          keyProvider: provider,
          assets: assets.store,
          drmConfig: locator(DEV_DRM_CONFIG)
        },
        { job: JOB, drm: { requested: true } }
      )
    ).rejects.toBe(invalid);

    expect(seen).toEqual([]);
    expect((assets.writes[0] as AssetDrm).errorCode).toBe(
      'key_provider_invalid_response'
    );
    expect((assets.writes[0] as AssetDrm).error).toBe(
      DRM_STEP_ERROR_MESSAGES['key_provider_invalid_response']
    );
  });

  it('enqueue fails: drm.status=failed, the error is rethrown for the packagingError path, keys zeroed', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const enqueueFailure = new Error('valkey unavailable');
    const { runner, seen } = encryptingRunner({
      enqueue: async () => {
        throw enqueueFailure;
      }
    });
    const { provider, issued } = keyProvider();
    const assets = assetDrmStore();

    await expect(
      enqueuePackagingStep(
        {
          runner,
          keyProvider: provider,
          assets: assets.store,
          drmConfig: locator(DEV_DRM_CONFIG)
        },
        { job: JOB, drm: { requested: true } }
      )
      // Rethrown by IDENTITY: `triggerPackaging`'s existing catch builds
      // `failed to enqueue packaging job: <message>` from this very error and
      // writes it to `asset.packagingError` (C7, src/pipeline/packaging.ts).
    ).rejects.toBe(enqueueFailure);

    expect(seen).toEqual([]);
    // `pending` was recorded before the enqueue, then `failed` after it threw.
    expect(assets.writes.map((w) => w.status)).toEqual(['pending', 'failed']);
    const failed = assets.writes[1] as AssetDrm;
    expect(failed.errorCode).toBe('packaging_failed');
    expect(failed.error).toBe(DRM_STEP_ERROR_MESSAGES['packaging_failed']);
    // The key ids survive the failure so the retry re-requests the SAME keys.
    expect(failed.keyIds).toHaveLength(1);
    // ...and the key BYTES do not survive it.
    expectAllZero(issued);
  });
});

// ---------------------------------------------------------------------------
// Idempotency (ADR-008 §6 "Idempotency", §12 "Re-package of an already-protected
// asset")
// ---------------------------------------------------------------------------

describe('re-package re-uses persisted keyIds (issue #1264)', () => {
  const PERSISTED: AssetDrm = {
    status: 'protected',
    providerId: 'primary',
    scheme: 'cbcs',
    systems: [CLEAR_KEY_SYSTEM_ID],
    keyIds: [{ trackGroup: 'SD', keyId: KEY_ID }],
    requestedAt: '2026-10-01T00:00:00.000Z',
    protectedAt: '2026-10-01T00:05:00.000Z'
  };

  it('asks the provider for the EXISTING key ids instead of minting new ones', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const { runner, seen } = encryptingRunner();
    const { provider, requests } = keyProvider();
    const assets = assetDrmStore(PERSISTED);

    const outcome = await enqueuePackagingStep(
      {
        runner,
        keyProvider: provider,
        assets: assets.store,
        drmConfig: locator(DEV_DRM_CONFIG)
      },
      { job: JOB, drm: { requested: true } }
    );

    expect(outcome).toEqual({ ok: true, encrypted: true });
    expect(provider.acquire).toHaveBeenCalledTimes(1);
    const request = requests[0] as KeyRequest;
    // THE acceptance criterion: the same key id, supplied as a re-request.
    expect(request.keyIds).toEqual({ SD: KEY_ID });
    expect(request.contentId).toBe(ASSET_ID);
    expect(request.trackGroups).toEqual(['SD']);
    // The package therefore carries the same key id as the published manifest.
    expect(seen[0]?.encryption?.keys[0]?.keyId).toBe(KEY_ID);
    expect((assets.writes[0] as AssetDrm).keyIds).toEqual([
      { trackGroup: 'SD', keyId: KEY_ID }
    ]);
  });

  it('keeps the original requestedAt and moves the status back to pending', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const { runner } = encryptingRunner();
    const { provider } = keyProvider();
    const assets = assetDrmStore(PERSISTED);

    await enqueuePackagingStep(
      {
        runner,
        keyProvider: provider,
        assets: assets.store,
        drmConfig: locator(DEV_DRM_CONFIG),
        now: () => '2026-11-05T12:00:00.000Z'
      },
      { job: JOB, drm: { requested: true } }
    );

    const written = assets.writes[0] as AssetDrm;
    expect(written.requestedAt).toBe(PERSISTED.requestedAt);
    expect(written.status).toBe('pending');
  });

  it('mints (sends no keyIds) for an asset with no persisted protection', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const { runner } = encryptingRunner();
    const { provider, requests } = keyProvider();
    const assets = assetDrmStore();

    await enqueuePackagingStep(
      {
        runner,
        keyProvider: provider,
        assets: assets.store,
        drmConfig: locator(DEV_DRM_CONFIG),
        now: () => '2026-11-05T12:00:00.000Z'
      },
      { job: JOB, drm: { requested: true } }
    );

    const request = requests[0] as KeyRequest;
    expect(request.keyIds).toBeUndefined();
    expect((assets.writes[0] as AssetDrm).requestedAt).toBe(
      '2026-11-05T12:00:00.000Z'
    );
  });

  it('keeps a previously protected track group even when configuration drops it', async () => {
    // A group that already has a published key must not lose it: the requested
    // groups are the configured set UNIONED with the persisted ones.
    process.env['DRM_ENABLED'] = 'true';
    const { runner } = encryptingRunner();
    const { provider, requests } = keyProvider();
    const assets = assetDrmStore({
      ...PERSISTED,
      keyIds: [
        { trackGroup: 'SD', keyId: KEY_ID },
        { trackGroup: 'AUDIO', keyId: '99999999-8888-7777-6666-555555555555' }
      ]
    });

    await enqueuePackagingStep(
      {
        runner,
        keyProvider: provider,
        assets: assets.store,
        drmConfig: locator({ ...DEV_DRM_CONFIG, trackGroups: ['SD'] })
      },
      { job: JOB, drm: { requested: true } }
    );

    const request = requests[0] as KeyRequest;
    expect(request.trackGroups).toEqual(['SD', 'AUDIO']);
    expect(request.keyIds).toEqual({
      SD: KEY_ID,
      AUDIO: '99999999-8888-7777-6666-555555555555'
    });
  });
});

// ---------------------------------------------------------------------------
// Key material handling (ADR-008 D4, §5.1 "zeroed after use", §10)
// ---------------------------------------------------------------------------

describe('content keys are zeroed and never leak (issue #1264)', () => {
  it('zeroes every ContentKey.key buffer after a SUCCESSFUL enqueue', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const { runner, seen } = encryptingRunner();
    const { provider, issued } = keyProvider();
    const assets = assetDrmStore();

    const outcome = await enqueuePackagingStep(
      {
        runner,
        keyProvider: provider,
        assets: assets.store,
        drmConfig: locator(DEV_DRM_CONFIG)
      },
      { job: JOB, drm: { requested: true } }
    );

    expect(outcome).toEqual({ ok: true, encrypted: true });
    // The runner received real key material for its one job...
    expect(
      Buffer.from(seen[0]?.encryption?.keys[0]?.key ?? '', 'base64')
    ).toHaveLength(16);
    // ...and the provider's buffers are zero by the time the step returns.
    expectAllZero(issued);
  });

  it('writes no key material into the asset record or the audit trail', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const { runner } = encryptingRunner();
    const { provider } = keyProvider();
    const assets = assetDrmStore();
    const { audit, entries } = auditSink();

    await enqueuePackagingStep(
      {
        runner,
        keyProvider: provider,
        assets: assets.store,
        drmConfig: locator(DEV_DRM_CONFIG),
        audit
      },
      { job: JOB, drm: { requested: true } }
    );
    // `emitAudit` is fire-and-forget (src/data/audit-emit.ts:59-75), so let the
    // detached write settle before reading the sink.
    await new Promise((resolve) => setImmediate(resolve));

    const persisted = JSON.stringify(assets.writes);
    expect(persisted).not.toContain(KEY_B64);
    expect(persisted).not.toContain('"key"');
    expect(entries.map((e) => e.action)).toEqual(['drm.keys.requested']);
    const audited = JSON.stringify(entries);
    expect(audited).not.toContain(KEY_B64);
    expect(audited).not.toContain('"key"');
    // Key IDENTIFIERS are non-secret and ARE recorded (ADR-008 §10 "Audit").
    expect(entries[0]?.detail?.['keyIds']).toEqual([
      (assets.writes[0] as AssetDrm).keyIds[0]?.keyId
    ]);
    expect(entries[0]?.targetType).toBe('asset');
    expect(entries[0]?.targetId).toBe(ASSET_ID);
  });

  it('emits drm.failed with no key material when the enqueue fails', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const { runner } = encryptingRunner({
      enqueue: async () => {
        throw new Error('queue down');
      }
    });
    const { provider } = keyProvider();
    const assets = assetDrmStore();
    const { audit, entries } = auditSink();

    await expect(
      enqueuePackagingStep(
        {
          runner,
          keyProvider: provider,
          assets: assets.store,
          drmConfig: locator(DEV_DRM_CONFIG),
          audit
        },
        { job: JOB, drm: { requested: true } }
      )
    ).rejects.toThrow('queue down');
    await new Promise((resolve) => setImmediate(resolve));

    expect(entries.map((e) => e.action)).toEqual([
      'drm.keys.requested',
      'drm.failed'
    ]);
    expect(JSON.stringify(entries)).not.toContain(KEY_B64);
    expect(entries[1]?.detail?.['errorCode']).toBe('packaging_failed');
  });

  it('zeroContentKeys overwrites the shared buffer in place', async () => {
    const keys: ContentKey[] = [
      { trackGroup: 'SD', keyId: KEY_ID, key: new Uint8Array(16).fill(KEY_BYTE) }
    ];
    const alias = keys[0]?.key as Uint8Array;
    zeroContentKeys(keys);
    // The alias sees zeroes too — the bytes were overwritten, not re-pointed.
    expect([...alias].every((b) => b === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Whole-step deadline (ADR-008 §12 "whole-step deadline 60 s")
// ---------------------------------------------------------------------------

describe('whole-step 60 s deadline (issue #1264)', () => {
  it('is 60 s and is the signal handed to KeyProvider.acquire', async () => {
    process.env['DRM_ENABLED'] = 'true';
    expect(DRM_STEP_DEADLINE_MS).toBe(60_000);
    const { runner, signals: enqueueSignals } = encryptingRunner();
    const { provider, signals } = keyProvider();

    await enqueuePackagingStep(
      { runner, keyProvider: provider, drmConfig: locator(DEV_DRM_CONFIG) },
      { job: JOB, drm: { requested: true } }
    );

    // One signal, created by the step, shared by both external calls.
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(enqueueSignals[0]).toBe(signals[0]);
  });

  it('propagates a caller-supplied signal to acquire and to the enqueue', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const controller = new AbortController();
    const { runner, signals: enqueueSignals } = encryptingRunner();
    const { provider, signals } = keyProvider();

    await enqueuePackagingStep(
      {
        runner,
        keyProvider: provider,
        signal: controller.signal,
        drmConfig: locator(DEV_DRM_CONFIG)
      },
      { job: JOB, drm: { requested: true } }
    );

    expect(signals[0]).toBe(controller.signal);
    expect(enqueueSignals[0]).toBe(controller.signal);
  });

  it('fails the step — and zeroes the keys — when a runner hangs past the deadline', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const controller = new AbortController();
    const { runner } = encryptingRunner({
      // A runner that ignores the advisory signal and never settles.
      enqueue: () => new Promise<void>(() => {})
    });
    const { provider, issued } = keyProvider();
    const assets = assetDrmStore();

    const step = enqueuePackagingStep(
      {
        runner,
        keyProvider: provider,
        signal: controller.signal,
        assets: assets.store,
        drmConfig: locator(DEV_DRM_CONFIG)
      },
      { job: JOB, drm: { requested: true } }
    );
    // Let the step get as far as the enqueue, then blow the budget.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(step).rejects.toThrow(/deadline/);
    expectAllZero(issued);
    expect(assets.writes.map((w) => w.status)).toEqual(['pending', 'failed']);
    // The deadline message names no key, no provider text and no credential.
    await step.catch((err: unknown) => {
      expect(String((err as Error).message)).not.toContain(KEY_B64);
    });
  });

  it('refuses before contacting the provider when the signal is already aborted', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const { runner, seen } = encryptingRunner();
    const { provider } = keyProvider();

    await expect(
      enqueuePackagingStep(
        {
          runner,
          keyProvider: provider,
          signal: AbortSignal.abort(),
          drmConfig: locator(DEV_DRM_CONFIG)
        },
        { job: JOB, drm: { requested: true } }
      )
    ).rejects.toThrow(/deadline/);
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The step keeps working with the pre-#1264 dependency set
// ---------------------------------------------------------------------------

describe('key-acquisition step with no store and no config locator', () => {
  it('acquires and enqueues using the execution request and capability answer', async () => {
    // No `assets`, no `drmConfig`: the deps shape every pre-#1264 caller used.
    const { runner, seen } = encryptingRunner();
    const { provider, requests } = keyProvider();

    const outcome = await enqueuePackagingStep(
      { runner, keyProvider: provider },
      { job: JOB, drm: { requested: true, systems: [CLEAR_KEY_SYSTEM_ID] } }
    );

    expect(outcome).toEqual({ ok: true, encrypted: true });
    expect((requests[0] as KeyRequest).trackGroups).toEqual(['SD']);
    expect((requests[0] as KeyRequest).keyIds).toBeUndefined();
    expect(seen[0]?.encryption?.protectionSystems).toEqual([CLEAR_KEY_SYSTEM_ID]);
  });

  it('persists the signalling URLs it was given, keyed by system id', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const { runner } = encryptingRunner();
    const { provider } = keyProvider();
    const assets = assetDrmStore();

    await enqueuePackagingStep(
      {
        runner,
        keyProvider: provider,
        assets: assets.store,
        drmConfig: locator({
          ...DEV_DRM_CONFIG,
          certificateUrls: { [CLEAR_KEY_SYSTEM_ID]: 'https://cert.example/app.cer' }
        })
      },
      { job: JOB, drm: { requested: true } }
    );

    const written = assets.writes[0] as AssetDrm;
    expect(written.licenceUrls).toEqual({
      [CLEAR_KEY_SYSTEM_ID]: 'https://licence.example/'
    });
    // The provider supplied no certificate URL, so the configured one is used.
    expect(written.certificateUrl).toBe('https://cert.example/app.cer');
    expect(written.providerId).toBe('primary');
    expect(written.scheme).toBe('cbcs');
    expect(written.systems).toEqual([CLEAR_KEY_SYSTEM_ID]);
  });
});
