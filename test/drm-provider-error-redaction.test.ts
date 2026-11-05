// Provider error redaction and the three DRM audit actions (ADR-008 §10
// "Logging and error redaction" / "Audit", §5.1; issue #1267).
//
// WHAT THIS GUARDS.
//   1. The `cpix` adapter (#1261) never lets a provider's HTTP response body
//      out: not into a thrown error, not into a log call, not into
//      `AssetDrm.error`. The only things that escape are the `errorCode` enum
//      value and a message written in this repository (method, host and status
//      code are the permitted diagnostics).
//   2. `drm.keys.requested`, `drm.protected` and `drm.failed` are emitted
//      through the existing `emitAudit` path with details that carry
//      identifiers only.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
//   - `CpixProvider` (constructor options `id`, `keyServerUrl`,
//     `spekeVersion: '1.0' | '2.0'`, `authMode: 'basic' | 'bearer' | 'mtls'`,
//     `transport`, `env`, `log`, `maxAttempts`, `backoffBaseMs`), `ENV_TOKEN`, `CpixHttpResponse` (`{ status, body, truncated? }`),
//     `CpixHttpTransport`, `CpixLogger` (`info`/`warn`), `CpixLogFields`
//     (`method`, `host`, `status?`, `latencyMs`, `contentId`, `attempt`,
//     `providerId`, `errorCode?`), `ENV_TOKEN` — src/drm/cpix-provider.ts:116-260,
//     :400-575.
//   - `KeyProviderError` (`errorCode`, `message`, `attempts`),
//     `isKeyProviderError` — src/drm/key-provider-error.ts:28-45.
//   - `KeyRequest` / `ContentKey` / `DrmSignalling` / `KeyProvider.acquire`,
//     `CLEAR_KEY_SYSTEM_ID` — src/drm/key-provider.ts:74-162.
//   - `enqueuePackagingStep`, `PackagingStepDeps` (`runner`, `keyProvider`,
//     `assets`, `audit`, `auditLog`, `now`), `AssetDrmStore`
//     (`get`/`update`), `markDrmProtected`, `DRM_STEP_ERROR_MESSAGES` —
//     src/pipeline/packaging.ts:507-540, and the symbols under test.
//   - `AssetDrm` (`status`, `providerId`, `scheme`, `systems`, `keyIds[]`,
//     `requestedAt`, `protectedAt?`, `error?`, `errorCode?`) —
//     src/data/asset-repo.ts:494-511.
//   - `RecordAuditInput` (`actor`, `action`, `targetType`, `targetId`,
//     `detail`), `AuditEmitter.record` — src/data/audit-repo.ts:96-105,
//     src/data/audit-emit.ts:29-31.
//   - `DRM_ERROR_CODES` — src/types/drm.ts:93-100.
//
// ADDITIVE ONLY: no pre-existing test file or assertion is touched.

import { describe, it, expect, vi } from 'vitest';
import {
  enqueuePackagingStep,
  markDrmProtected,
  DRM_STEP_ERROR_MESSAGES,
  type AssetDrmStore,
  type EncryptingPackagingRunner,
  type EncryptionParams,
  type PackagingJob,
  type PackagingStepDeps
} from '../src/pipeline/packaging.js';
import type { AssetDrm } from '../src/data/asset-repo.js';
import {
  CpixProvider,
  ENV_TOKEN,
  type CpixHttpResponse,
  type CpixLogger
} from '../src/drm/cpix-provider.js';
import { isKeyProviderError, KeyProviderError } from '../src/drm/key-provider-error.js';
import { CLEAR_KEY_SYSTEM_ID } from '../src/drm/key-provider.js';
import type { ContentKey, DrmSignalling, KeyProvider, KeyRequest } from '../src/drm/key-provider.js';
import type { RecordAuditInput } from '../src/data/audit-repo.js';

const ASSET_ID = 'asset-1267';
const KEY_ID = '11111111-2222-3333-4444-555555555555';
const SYSTEM_ID = CLEAR_KEY_SYSTEM_ID;
const JOB: PackagingJob = { jobId: ASSET_ID, url: 'http://transcoder/job/abc' };

// A provider body with several distinctive fragments, each of which would be a
// leak on its own. The 200 case is a syntactically valid-looking but unusable
// document, so the parser rejects it and the response body is in play on the
// error path (issue #1267: "a captured log spy over a simulated 200 CPIX
// response confirms no response body fragment appears in any log call").
const SECRET_FRAGMENTS = [
  'c2VjcmV0LWtleS1ieXRlcw==',
  'tenant-9f3a-internal',
  'Bearer pk_live_do_not_log',
  'SUPPORT-REF-88213'
];
const PROVIDER_BODY = `<?xml version="1.0"?><CPIX xmlns="urn:dashif:org:cpix">
  <ContentKeyList><ContentKey kid="${KEY_ID}">
    <Data><Secret><PlainValue>${SECRET_FRAGMENTS[0]}</PlainValue></Secret></Data>
  </ContentKey></ContentKeyList>
  <Diagnostics tenant="${SECRET_FRAGMENTS[1]}" auth="${SECRET_FRAGMENTS[2]}"
    ref="${SECRET_FRAGMENTS[3]}"/>
</CPIX>`;

const KEY_REQUEST: KeyRequest = {
  contentId: ASSET_ID,
  systems: [SYSTEM_ID],
  scheme: 'cbcs',
  trackGroups: ['SD']
};

function logSpy(): { log: CpixLogger; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    log: {
      info: (obj, msg) => {
        calls.push([obj, msg]);
      },
      warn: (obj, msg) => {
        calls.push([obj, msg]);
      }
    }
  };
}

function cpixProvider(response: CpixHttpResponse, log: CpixLogger): CpixProvider {
  return new CpixProvider({
    id: 'primary',
    keyServerUrl: 'https://keys.example/cpix',
    spekeVersion: '2.0',
    authMode: 'bearer',
    env: { [ENV_TOKEN]: 'env-token-value' },
    log,
    maxAttempts: 1,
    backoffBaseMs: 0,
    transport: async () => response
  });
}

// Everything the adapter emitted, flattened to one searchable string: log
// objects, log messages and the thrown error (message, name, stack and any
// enumerable member).
function emitted(calls: unknown[][], err: unknown): string {
  const parts = calls.map((call) => JSON.stringify(call) ?? '');
  if (err instanceof Error) {
    parts.push(err.message, err.name, err.stack ?? '', JSON.stringify(err) ?? '');
  } else {
    parts.push(String(err), JSON.stringify(err) ?? '');
  }
  return parts.join('\n');
}

describe('cpix adapter error redaction (issue #1267, ADR-008 §10)', () => {
  it('leaks no fragment of a 200 response body into logs or the thrown error', async () => {
    const { log, calls } = logSpy();
    const provider = cpixProvider({ status: 200, body: PROVIDER_BODY }, log);

    const err = await provider
      .acquire(KEY_REQUEST, AbortSignal.timeout(5_000))
      .then(() => undefined)
      .catch((e: unknown) => e);

    // The unusable document is a provider-response fault, not a transport one.
    expect(isKeyProviderError(err)).toBe(true);
    expect((err as KeyProviderError).errorCode).toBe('key_provider_invalid_response');

    const seen = emitted(calls, err);
    // A log call DID happen — otherwise "no fragment appears in any log call"
    // would be vacuously true.
    expect(calls.length).toBeGreaterThan(0);
    for (const fragment of SECRET_FRAGMENTS) {
      expect(seen).not.toContain(fragment);
    }
    // Nor the raw XML, nor the element names that only the body carries.
    expect(seen).not.toContain('PlainValue');
    expect(seen).not.toContain('ContentKeyList');
    expect(seen).not.toContain('<CPIX');
  });

  it('logs only method, host, status and non-secret diagnostics on a 4xx', async () => {
    const { log, calls } = logSpy();
    const provider = cpixProvider({ status: 403, body: PROVIDER_BODY }, log);

    const err = await provider
      .acquire(KEY_REQUEST, AbortSignal.timeout(5_000))
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(isKeyProviderError(err)).toBe(true);
    expect((err as KeyProviderError).errorCode).toBe('key_provider_rejected');

    const seen = emitted(calls, err);
    for (const fragment of SECRET_FRAGMENTS) {
      expect(seen).not.toContain(fragment);
    }
    // The permitted fields, and nothing beyond them: every log object's own
    // property names are checked against the `CpixLogFields` allowlist
    // (src/drm/cpix-provider.ts:215-224).
    const allowed = new Set([
      'method',
      'host',
      'status',
      'latencyMs',
      'contentId',
      'attempt',
      'providerId',
      'errorCode'
    ]);
    for (const [obj] of calls) {
      expect(typeof obj).toBe('object');
      for (const name of Object.keys(obj as Record<string, unknown>)) {
        expect(allowed.has(name), `unexpected log field "${name}"`).toBe(true);
      }
    }
    // The status code is diagnostics the ADR permits; the body is not.
    expect((err as KeyProviderError).message).toContain('403');
    expect((err as KeyProviderError).message).not.toContain('tenant');
  });

  it('never attaches the provider body to the error object', async () => {
    const { log } = logSpy();
    const provider = cpixProvider({ status: 500, body: PROVIDER_BODY }, log);
    const err = await provider
      .acquire(KEY_REQUEST, AbortSignal.timeout(5_000))
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(isKeyProviderError(err)).toBe(true);
    // `KeyProviderError` has no member that could hold a body
    // (src/drm/key-provider-error.ts): `cause` is deliberately absent.
    expect((err as KeyProviderError & { cause?: unknown }).cause).toBeUndefined();
    // Own enumerable members, exhaustively: the two declared fields plus the
    // `name` the constructor sets. No third member exists in which a body
    // could ride along, and this assertion fails if one is ever added.
    expect(Object.keys(err as object).sort()).toEqual(['attempts', 'errorCode', 'name']);
  });
});

// ---------------------------------------------------------------------------
// `AssetDrm.error` on a provider rejection, and the three audit actions
// ---------------------------------------------------------------------------

function assetStore(seed?: AssetDrm): {
  assets: AssetDrmStore;
  patches: { drm?: AssetDrm }[];
} {
  const patches: { drm?: AssetDrm }[] = [];
  let stored = seed;
  return {
    patches,
    assets: {
      async get() {
        return stored ? { drm: stored } : undefined;
      },
      async update(_id, patch) {
        patches.push(patch);
        if (patch.drm) stored = patch.drm;
        return undefined;
      }
    }
  };
}

function auditSink(): { audit: NonNullable<PackagingStepDeps['audit']>; entries: RecordAuditInput[] } {
  const entries: RecordAuditInput[] = [];
  return {
    entries,
    audit: {
      record: vi.fn(async (input: RecordAuditInput) => {
        entries.push(input);
        return undefined;
      })
    }
  };
}

function runner(options?: { enqueue?: () => Promise<void> }): EncryptingPackagingRunner {
  return {
    async capabilities() {
      return { encryption: true, schemes: ['cbcs'], systems: [SYSTEM_ID] };
    },
    async enqueue(_job: PackagingJob & { encryption?: EncryptionParams }) {
      if (options?.enqueue) await options.enqueue();
    }
  };
}

function provider(options?: { fail?: unknown }): KeyProvider {
  return {
    id: 'primary',
    kind: 'cpix',
    async acquire() {
      if (options?.fail !== undefined) throw options.fail;
      const key: ContentKey = {
        trackGroup: 'SD',
        keyId: KEY_ID,
        key: new Uint8Array(16).fill(0x5a)
      };
      const signalling: DrmSignalling = {
        pssh: { [SYSTEM_ID]: 'cHNzaA==' },
        licenceUrls: { [SYSTEM_ID]: 'https://licence.example/licence' }
      };
      return { keys: [key], signalling };
    }
  };
}

const DRM_REQUEST = { requested: true as const, systems: [SYSTEM_ID], scheme: 'cbcs' as const };

// `emitAudit` detaches the write onto the microtask queue
// (src/data/audit-emit.ts:66-74).
async function drainAudit(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function detailOf(entry: RecordAuditInput): Record<string, unknown> {
  return (entry.detail ?? {}) as Record<string, unknown>;
}

describe('AssetDrm.error on a provider rejection (issue #1267)', () => {
  it('carries the fixed message for the errorCode and no provider body excerpt', async () => {
    const store = assetStore();
    const log = { error: vi.fn() };
    // The rejection the `cpix` adapter raises for a 4xx, verbatim in shape:
    // an `errorCode` plus a message written in this repository.
    const rejection = new KeyProviderError(
      'key_provider_rejected',
      'key provider rejected the key request with status 403',
      1
    );

    await expect(
      enqueuePackagingStep(
        {
          runner: runner(),
          keyProvider: provider({ fail: rejection }),
          assets: store.assets,
          auditLog: log,
          now: () => '2026-11-05T10:00:00.000Z'
        },
        { job: JOB, drm: DRM_REQUEST }
      )
    ).rejects.toBe(rejection);

    const drm = store.patches.at(-1)?.drm;
    expect(drm?.status).toBe('failed');
    expect(drm?.errorCode).toBe('key_provider_rejected');
    // The `error` string comes from this repository's own table, keyed by the
    // errorCode — never from the thrown or received text.
    expect(drm?.error).toBe(DRM_STEP_ERROR_MESSAGES['key_provider_rejected']);
    for (const fragment of SECRET_FRAGMENTS) {
      expect(JSON.stringify(drm)).not.toContain(fragment);
    }
    expect(JSON.stringify(drm)).not.toContain('403');
    expect(JSON.stringify(drm)).not.toContain('PlainValue');
  });
});

describe('DRM audit actions (issue #1267, ADR-008 §10 "Audit")', () => {
  it('emits drm.keys.requested after acquire and before the enqueue', async () => {
    const store = assetStore();
    const sink = auditSink();
    let auditedBeforeEnqueue: string[] = [];

    await enqueuePackagingStep(
      {
        runner: runner({
          enqueue: async () => {
            // The #1267 ordering constraint: the audit record must already
            // exist by the time the enqueue runs, so it survives an enqueue
            // failure. `emitAudit` is detached, so drain first.
            await drainAudit();
            auditedBeforeEnqueue = sink.entries.map((e) => e.action);
          }
        }),
        keyProvider: provider(),
        assets: store.assets,
        audit: sink.audit,
        now: () => '2026-11-05T10:00:00.000Z'
      },
      { job: JOB, drm: DRM_REQUEST }
    );
    await drainAudit();

    expect(auditedBeforeEnqueue).toContain('drm.keys.requested');

    const entry = sink.entries.find((e) => e.action === 'drm.keys.requested');
    expect(entry).toBeDefined();
    expect(entry?.targetType).toBe('asset');
    expect(entry?.targetId).toBe(ASSET_ID);
    expect(entry?.actor).toEqual({ principalId: null, origin: 'system' });
    const detail = detailOf(entry as RecordAuditInput);
    expect(detail['assetId']).toBe(ASSET_ID);
    expect(detail['providerId']).toBe('primary');
    expect(detail['systems']).toEqual([SYSTEM_ID]);
    expect(detail['keyIds']).toEqual([KEY_ID]);
    expect(Object.keys(detail)).not.toContain('key');
    expect(JSON.stringify(detail)).not.toContain('"key"');
  });

  it('emits drm.protected when the status transitions to protected', async () => {
    const pending: AssetDrm = {
      status: 'pending',
      providerId: 'primary',
      scheme: 'cbcs',
      systems: [SYSTEM_ID],
      keyIds: [{ trackGroup: 'SD', keyId: KEY_ID }],
      requestedAt: '2026-11-05T09:59:00.000Z',
      error: DRM_STEP_ERROR_MESSAGES['packaging_failed'] as string,
      errorCode: 'packaging_failed'
    };
    const store = assetStore(pending);
    const sink = auditSink();
    const deps: PackagingStepDeps = {
      runner: runner(),
      assets: store.assets,
      audit: sink.audit,
      now: () => '2026-11-05T10:00:00.000Z'
    };

    expect(await markDrmProtected(deps, ASSET_ID)).toBe(true);
    await drainAudit();

    const drm = store.patches.at(-1)?.drm;
    expect(drm?.status).toBe('protected');
    expect(drm?.protectedAt).toBe('2026-11-05T10:00:00.000Z');
    // The previous attempt's failure fields do not survive the transition.
    expect(drm?.error).toBeUndefined();
    expect(drm?.errorCode).toBeUndefined();
    // `requestedAt` is when protection was FIRST requested.
    expect(drm?.requestedAt).toBe('2026-11-05T09:59:00.000Z');

    const entry = sink.entries.find((e) => e.action === 'drm.protected');
    expect(entry).toBeDefined();
    expect(entry?.targetType).toBe('asset');
    expect(entry?.targetId).toBe(ASSET_ID);
    const detail = detailOf(entry as RecordAuditInput);
    expect(detail['assetId']).toBe(ASSET_ID);
    expect(detail['providerId']).toBe('primary');
    expect(detail['keyIds']).toEqual([KEY_ID]);
    expect(Object.keys(detail)).not.toContain('key');
  });

  it('emits nothing and writes nothing when the asset is already protected', async () => {
    const store = assetStore({
      status: 'protected',
      providerId: 'primary',
      scheme: 'cbcs',
      systems: [SYSTEM_ID],
      keyIds: [{ trackGroup: 'SD', keyId: KEY_ID }],
      requestedAt: '2026-11-05T09:59:00.000Z',
      protectedAt: '2026-11-05T09:59:30.000Z'
    });
    const sink = auditSink();

    expect(
      await markDrmProtected(
        { runner: runner(), assets: store.assets, audit: sink.audit },
        ASSET_ID
      )
    ).toBe(false);
    await drainAudit();

    expect(store.patches).toEqual([]);
    expect(sink.entries).toEqual([]);
  });

  it('emits drm.failed with the errorCode and no provider text', async () => {
    const store = assetStore();
    const sink = auditSink();
    const rejection = new KeyProviderError(
      'key_provider_rejected',
      'key provider rejected the key request with status 403',
      1
    );

    await expect(
      enqueuePackagingStep(
        {
          runner: runner(),
          keyProvider: provider({ fail: rejection }),
          assets: store.assets,
          audit: sink.audit,
          now: () => '2026-11-05T10:00:00.000Z'
        },
        { job: JOB, drm: DRM_REQUEST }
      )
    ).rejects.toBe(rejection);
    await drainAudit();

    const entry = sink.entries.find((e) => e.action === 'drm.failed');
    expect(entry).toBeDefined();
    const detail = detailOf(entry as RecordAuditInput);
    expect(detail['assetId']).toBe(ASSET_ID);
    expect(detail['providerId']).toBe('primary');
    expect(detail['errorCode']).toBe('key_provider_rejected');
    expect(Object.keys(detail)).not.toContain('key');
    expect(JSON.stringify(detail)).not.toContain('403');
    for (const fragment of SECRET_FRAGMENTS) {
      expect(JSON.stringify(detail)).not.toContain(fragment);
    }
  });
});
