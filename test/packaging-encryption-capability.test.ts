// EncryptingPackagingRunner port, capability probe and the
// `409 drm_unsupported` fast-fail gate (issue #1263, ADR-008 §7.1 / D8).
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
//   - `EncryptingPackagingRunner`, `EncryptionParams`, `PackagingCapabilities`,
//     `clearPackagingRunner`, `probeEncryptionCapability`,
//     `enqueuePackagingStep`, `DRM_UNSUPPORTED_REFUSAL` — the symbols under
//     test, src/pipeline/packaging.ts.
//   - `PackagingJob` = `{ jobId, url }` — src/pipeline/packaging.ts:187-190
//     (verified from the packaging library's own redisListener envelope). The
//     superset claim is asserted below rather than asserted in prose.
//   - `KeyProvider.acquire(req, signal)` — src/drm/key-provider.ts:149-165.
//     The gate must refuse BEFORE this is called; the spy proves it.
//   - `PipelineExecution['drm']` = `{ requested: true; providerId?; systems?;
//     scheme? }` — src/data/pipeline-repo.ts:100.
//   - `DRM_ERROR_CODES` contains `'drm_unsupported'` — src/types/drm.ts.
//
// ADDITIVE ONLY: no pre-existing packaging test is touched, and nothing here
// changes `PackagingJob` or `PackageQueue`.

import { describe, it, expect, vi } from 'vitest';
import {
  clearPackagingRunner,
  enqueuePackagingStep,
  probeEncryptionCapability,
  DRM_UNSUPPORTED_REFUSAL,
  DRM_SCHEME_UNSUPPORTED_REFUSAL,
  DRM_SYSTEMS_UNSUPPORTED_REFUSAL,
  type EncryptingPackagingRunner,
  type EncryptionParams,
  type PackageQueue,
  type PackagingJob
} from '../src/pipeline/packaging.js';
import type { KeyProvider } from '../src/drm/key-provider.js';
import {
  CLEAR_KEY_SYSTEM_ID,
  DEFAULT_DRM_SYSTEM_IDS
} from '../src/drm/key-provider.js';

const JOB: PackagingJob = { jobId: 'asset-1', url: 'http://encore/job/abc' };

function recordingQueue(): {
  queue: PackageQueue;
  enqueued: PackagingJob[];
} {
  const enqueued: PackagingJob[] = [];
  return {
    enqueued,
    queue: {
      async enqueue(job) {
        enqueued.push(job);
      }
    }
  };
}

// A key provider that would answer if it were ever reached. `acquire` is a spy
// so "not called" is an assertion, not an assumption.
function spyKeyProvider(): KeyProvider & { acquire: ReturnType<typeof vi.fn> } {
  return {
    id: 'primary',
    kind: 'clearkey-dev',
    acquire: vi.fn(async () => ({
      keys: [
        {
          trackGroup: 'SD' as const,
          keyId: '11111111-2222-3333-4444-555555555555',
          key: new Uint8Array(16).fill(7)
        }
      ],
      signalling: {
        pssh: { [CLEAR_KEY_SYSTEM_ID]: 'cHNzaA==' },
        licenceUrls: { [CLEAR_KEY_SYSTEM_ID]: 'https://licence.example/' },
        hlsKeyUri: 'skd://key',
        dev: true as const
      }
    }))
  };
}

describe('packaging capability probe (issue #1263)', () => {
  it('reports no encryption support for the deployed clear-only runner', async () => {
    const { queue } = recordingQueue();
    const caps = await probeEncryptionCapability(clearPackagingRunner(queue));
    expect(caps).toEqual({ encryption: false, schemes: [], systems: [] });
  });

  it('does not cache the probe result between calls', async () => {
    const { queue } = recordingQueue();
    const runner = clearPackagingRunner(queue);
    const first = await runner.capabilities();
    // Mutating one answer must not be visible in the next probe — a cached
    // (shared) object would leak the mutation across pipeline executions.
    first.encryption = true;
    first.schemes.push('cenc');
    first.systems.push(CLEAR_KEY_SYSTEM_ID);
    const second = await runner.capabilities();
    expect(second).toEqual({ encryption: false, schemes: [], systems: [] });
    expect(second).not.toBe(first);
  });
});

describe('packaging DRM fast-fail gate (issue #1263)', () => {
  it('returns 409 drm_unsupported without calling KeyProvider.acquire', async () => {
    const { queue, enqueued } = recordingQueue();
    const keyProvider = spyKeyProvider();
    const outcome = await enqueuePackagingStep(
      { runner: clearPackagingRunner(queue), keyProvider },
      { job: JOB, drm: { requested: true } }
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal.status).toBe(409);
    expect(outcome.refusal.errorCode).toBe('drm_unsupported');
    expect(outcome.refusal.error).toBe('drm_unsupported');
    expect(outcome.refusal).toEqual(DRM_UNSUPPORTED_REFUSAL);

    // The whole point of the gate: no key was requested and no job was queued.
    expect(keyProvider.acquire).not.toHaveBeenCalled();
    expect(enqueued).toEqual([]);
  });

  it('refuses before acquiring even when the request names a scheme and systems', async () => {
    const { queue, enqueued } = recordingQueue();
    const keyProvider = spyKeyProvider();
    const outcome = await enqueuePackagingStep(
      { runner: clearPackagingRunner(queue), keyProvider },
      {
        job: JOB,
        drm: {
          requested: true,
          providerId: 'primary',
          scheme: 'cbcs',
          systems: [CLEAR_KEY_SYSTEM_ID]
        }
      }
    );
    expect(outcome.ok).toBe(false);
    expect(keyProvider.acquire).not.toHaveBeenCalled();
    expect(enqueued).toEqual([]);
  });

  it('enqueues normally, and clear, when the step carries no drm field', async () => {
    const { queue, enqueued } = recordingQueue();
    const keyProvider = spyKeyProvider();
    const outcome = await enqueuePackagingStep(
      { runner: clearPackagingRunner(queue), keyProvider },
      { job: JOB }
    );
    expect(outcome).toEqual({ ok: true, encrypted: false });
    // Exactly the pre-existing `{ jobId, url }` envelope — no extra member.
    expect(enqueued).toEqual([{ jobId: 'asset-1', url: 'http://encore/job/abc' }]);
    expect(Object.keys(enqueued[0] as object).sort()).toEqual(['jobId', 'url']);
    expect(keyProvider.acquire).not.toHaveBeenCalled();
  });

  it('works with no key provider wired at all (clear path and refusal path)', async () => {
    const { queue, enqueued } = recordingQueue();
    const runner = clearPackagingRunner(queue);
    expect(await enqueuePackagingStep({ runner }, { job: JOB })).toEqual({
      ok: true,
      encrypted: false
    });
    const refused = await enqueuePackagingStep(
      { runner },
      { job: JOB, drm: { requested: true } }
    );
    expect(refused.ok).toBe(false);
    expect(enqueued).toHaveLength(1);
  });
});

describe('EncryptingPackagingRunner port shape (issue #1263)', () => {
  it('is a strict superset of PackageQueue: an encrypting runner is usable as one', async () => {
    const { queue, enqueued } = recordingQueue();
    const runner = clearPackagingRunner(queue);
    // Structural assignability is the superset claim; it is checked at compile
    // time by this assignment and at run time by the enqueue below.
    const asQueue: PackageQueue = runner;
    await asQueue.enqueue(JOB);
    expect(enqueued).toEqual([JOB]);
  });

  it('refuses loudly rather than silently packaging an encrypted job as clear', async () => {
    const { queue, enqueued } = recordingQueue();
    const runner = clearPackagingRunner(queue);
    const encryption: EncryptionParams = {
      scheme: 'cbcs',
      keys: [
        {
          label: 'SD',
          keyId: '11111111-2222-3333-4444-555555555555',
          key: Buffer.alloc(16, 7).toString('base64')
        }
      ],
      pssh: { [CLEAR_KEY_SYSTEM_ID]: 'cHNzaA==' },
      protectionSystems: [CLEAR_KEY_SYSTEM_ID]
    };
    await expect(runner.enqueue({ ...JOB, encryption })).rejects.toThrow(
      /does not support encryption/
    );
    expect(enqueued).toEqual([]);
    // The refusal must not leak key material into the error text.
    await runner
      .enqueue({ ...JOB, encryption })
      .catch((err: unknown) =>
        expect(String((err as Error).message)).not.toContain(
          encryption.keys[0]?.key
        )
      );
  });

  it('encrypts through the port when a runner does report support', async () => {
    // Forward-looking: proves the supported branch asks the key provider and
    // passes base64 key material + signalling through, so the port is not a
    // dead declaration. No deployed runner answers this way today.
    const seen: (PackagingJob & { encryption?: EncryptionParams })[] = [];
    const keyProvider = spyKeyProvider();
    const encrypting: EncryptingPackagingRunner = {
      async capabilities() {
        return {
          encryption: true,
          schemes: ['cbcs'],
          systems: [CLEAR_KEY_SYSTEM_ID]
        };
      },
      async enqueue(job) {
        seen.push(job);
      }
    };
    const outcome = await enqueuePackagingStep(
      { runner: encrypting, keyProvider },
      { job: JOB, drm: { requested: true, systems: [CLEAR_KEY_SYSTEM_ID] } }
    );
    expect(outcome).toEqual({ ok: true, encrypted: true });
    expect(keyProvider.acquire).toHaveBeenCalledTimes(1);
    const params = seen[0]?.encryption;
    expect(params?.scheme).toBe('cbcs');
    expect(params?.protectionSystems).toEqual([CLEAR_KEY_SYSTEM_ID]);
    expect(params?.keys[0]?.label).toBe('SD');
    expect(params?.keys[0]?.keyId).toBe('11111111-2222-3333-4444-555555555555');
    // base64 of 16 bytes
    expect(Buffer.from(params?.keys[0]?.key ?? '', 'base64')).toHaveLength(16);
    expect(params?.pssh[CLEAR_KEY_SYSTEM_ID]).toBe('cHNzaA==');
    expect(params?.hlsKeyUri).toBe('skd://key');
  });
});

// ---------------------------------------------------------------------------
// ADDITIVE (PR #1324 review finding 2): the capability intersection must fail
// loud, not degrade. The gate used to filter the requested DRM systems against
// `caps.systems` and proceed regardless of the result, so an EMPTY intersection
// enqueued `protectionSystems: []` / `pssh: {}` next to real content keys and
// returned `{ ok: true, encrypted: true }` — encrypted, unplayable output
// reported as a success.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
//   - `PackagingCapabilities` = `{ encryption, schemes, systems }` —
//     src/pipeline/packaging.ts (the probe answer being intersected).
//   - `DRM_SYSTEMS_UNSUPPORTED_REFUSAL`, `DRM_SCHEME_UNSUPPORTED_REFUSAL`,
//     `DrmUnsupportedRefusal` (`{ status: 409, error, errorCode, message }`) —
//     src/pipeline/packaging.ts, same shape as `DRM_UNSUPPORTED_REFUSAL`.
//   - `resolveDrmSystemIds` / `DEFAULT_DRM_SYSTEM_IDS` —
//     src/drm/key-provider.ts:51-71 (an omitted `drm.systems` falls back to the
//     registered defaults, which is what the first case below exercises).
//   - `PROTECTION_SCHEMES` = `['cenc','cbcs']` — src/types/drm.ts:75-76 (the
//     two schemes the mismatch case below plays against each other).
// ---------------------------------------------------------------------------

// A runner that reports whatever capabilities a case needs and records what it
// was handed, so "nothing was enqueued" is an assertion.
function capableRunner(caps: {
  schemes: EncryptionParams['scheme'][];
  systems: string[];
}): {
  runner: EncryptingPackagingRunner;
  seen: (PackagingJob & { encryption?: EncryptionParams })[];
} {
  const seen: (PackagingJob & { encryption?: EncryptionParams })[] = [];
  return {
    seen,
    runner: {
      async capabilities() {
        return {
          encryption: true,
          schemes: [...caps.schemes],
          systems: [...caps.systems]
        };
      },
      async enqueue(job) {
        seen.push(job);
      }
    }
  };
}

describe('packaging DRM capability intersection fails loud (PR #1324 finding 2)', () => {
  it('refuses when the runner supports none of the requested DRM systems', async () => {
    // The runner can encrypt, and with the SAME scheme that is asked for — but
    // it only knows a system nobody asked for. Nothing requested is protectable.
    const { runner, seen } = capableRunner({
      schemes: ['cbcs'],
      systems: [CLEAR_KEY_SYSTEM_ID]
    });
    const keyProvider = spyKeyProvider();

    const outcome = await enqueuePackagingStep(
      { runner, keyProvider },
      {
        job: JOB,
        drm: {
          requested: true,
          scheme: 'cbcs',
          systems: [DEFAULT_DRM_SYSTEM_IDS[0] as string]
        }
      }
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toEqual(DRM_SYSTEMS_UNSUPPORTED_REFUSAL);
    expect(outcome.refusal.status).toBe(409);
    expect(outcome.refusal.errorCode).toBe('drm_unsupported');
    // Fail loud = fail EARLY: no key minted, nothing queued.
    expect(keyProvider.acquire).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('refuses rather than enqueueing encrypted output with empty DRM signalling', async () => {
    // The regression this pins: the old code reached `enqueue` with
    // `protectionSystems: []` and `pssh: {}` while carrying real content keys,
    // and answered `{ ok: true, encrypted: true }`.
    const { runner, seen } = capableRunner({
      schemes: ['cbcs'],
      systems: ['00000000-0000-0000-0000-000000000000']
    });
    const keyProvider = spyKeyProvider();

    const outcome = await enqueuePackagingStep(
      { runner, keyProvider },
      { job: JOB, drm: { requested: true, systems: [CLEAR_KEY_SYSTEM_ID] } }
    );

    expect(outcome).not.toEqual({ ok: true, encrypted: true });
    expect(outcome.ok).toBe(false);
    expect(seen).toEqual([]);
    expect(
      seen.some((job) => job.encryption?.protectionSystems.length === 0)
    ).toBe(false);
  });

  it('refuses when the requested protection scheme is not supported', async () => {
    const { runner, seen } = capableRunner({
      schemes: ['cbcs'],
      systems: [CLEAR_KEY_SYSTEM_ID]
    });
    const keyProvider = spyKeyProvider();

    const outcome = await enqueuePackagingStep(
      { runner, keyProvider },
      {
        job: JOB,
        drm: {
          requested: true,
          scheme: 'cenc',
          systems: [CLEAR_KEY_SYSTEM_ID]
        }
      }
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toEqual(DRM_SCHEME_UNSUPPORTED_REFUSAL);
    expect(keyProvider.acquire).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('refuses when a runner claims encryption but reports no scheme at all', async () => {
    // `encryption: true` with an empty `schemes` list is self-contradictory:
    // there is no scheme it could apply. Refuse instead of guessing one.
    const { runner, seen } = capableRunner({
      schemes: [],
      systems: [CLEAR_KEY_SYSTEM_ID]
    });
    const keyProvider = spyKeyProvider();

    const outcome = await enqueuePackagingStep(
      { runner, keyProvider },
      { job: JOB, drm: { requested: true, systems: [CLEAR_KEY_SYSTEM_ID] } }
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toEqual(DRM_SCHEME_UNSUPPORTED_REFUSAL);
    expect(keyProvider.acquire).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('still narrows (does not refuse) when only SOME requested systems are supported', async () => {
    // The intersection is still a narrowing operation — only an EMPTY result is
    // fatal. This pins that the fix did not over-tighten into "all or nothing".
    const supported = CLEAR_KEY_SYSTEM_ID;
    const unsupported = DEFAULT_DRM_SYSTEM_IDS[0] as string;
    const { runner, seen } = capableRunner({
      schemes: ['cbcs'],
      systems: [supported]
    });
    const keyProvider = spyKeyProvider();

    const outcome = await enqueuePackagingStep(
      { runner, keyProvider },
      {
        job: JOB,
        drm: { requested: true, systems: [unsupported, supported] }
      }
    );

    expect(outcome).toEqual({ ok: true, encrypted: true });
    expect(keyProvider.acquire).toHaveBeenCalledTimes(1);
    expect(seen[0]?.encryption?.protectionSystems).toEqual([supported]);
  });
});
