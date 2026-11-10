// An EXISTING on-demand packager is brought onto the current OSC access token
// (issue #1335).
//
// THE BUG: ensurePackagerProvisioned found the instance with getInstance and
// returned 'exists' immediately, so the saveSecret that writes `<stack>.pat` ran
// only on the create path. After this API's own OSC token was rotated (e.g.
// following a revocation) the running packager kept presenting the old value:
// every packaging job it picked up failed inside the packager and the step was
// only marked failed 15 minutes later, on the completion timeout.
//
// Pinned behaviour:
//   - the exists path re-saves `<stack>.pat`, scoped to the packager serviceId,
//     with the token the current call carries (and creates nothing);
//   - with a roll ledger wired it restarts the instance ONCE per process (so it
//     re-reads the secret) and waits for readiness before returning;
//   - a second execution for the same stack refreshes the secret again but does
//     NOT restart a healthy packager mid-job;
//   - without a ledger (or without a restart-capable adapter) the secret is
//     still refreshed and nothing is restarted;
//   - a refresh/restart failure is logged and does not fail the ensure call, and
//     the roll is retried on the next execution;
//   - the raw token never reaches a log line.
//
// Contract sources (CLAUDE.md rule 7), read from the installed SDK v0.24.0:
//   - saveSecret(serviceId, name, value, ctx): Promise<void> — @osaas/
//     client-core lib/core.d.ts:154, adapted as PackagerOscApi.saveSecret(
//     serviceId, name, value) in src/services/packager-provisioning.ts.
//   - getInstance(ctx, serviceId, name, token): Promise<any> — lib/core.d.ts:56.
//   - restartInstance(ctx, serviceId, name, token): Promise<void> —
//     lib/core.d.ts:95 (impl lib/core.js:230-238, POSTs the instance's `restart`
//     _link), adapted as PackagerOscApi.restartInstance(serviceId, name, token).
//   - Secrets are write-only: lib/index.d.ts:6 exports `saveSecret` /
//     `valueOrSecret` and no secret read, which is why the roll is bounded by a
//     per-process ledger instead of a value comparison.

import { describe, it, expect, vi } from 'vitest';
import {
  ensurePackagerProvisioned,
  PackagerPatRollLedger,
  PACKAGER_PAT_PURPOSE,
  type PackagerOscApi,
  type EnsurePackagerDeps
} from '../src/services/packager-provisioning.js';
import { PACKAGER_SERVICE_ID } from '../src/services/stack.js';

const STACK = 'stack-1';
const OLD_TOKEN = 'osc-pat-revoked-value';
const NEW_TOKEN = 'osc-pat-rotated-value';

// Fake OSC surface whose getInstance reports an ALREADY RUNNING packager, i.e.
// the exists path under test.
function makeExistingOscApi(
  overrides: Partial<PackagerOscApi> = {}
): PackagerOscApi {
  return {
    getServiceAccessToken: vi.fn(async () => 'sat-token'),
    getInstance: vi.fn(async () => ({ name: STACK })),
    listInstances: vi.fn(async () => [{ name: STACK }]),
    createInstance: vi.fn(async () => ({ name: STACK })),
    waitForInstanceReady: vi.fn(async () => undefined),
    saveSecret: vi.fn(async () => undefined),
    removeInstance: vi.fn(async () => undefined),
    restartInstance: vi.fn(async () => undefined),
    ...overrides
  };
}

function makeLog() {
  return { info: vi.fn(), error: vi.fn() };
}

function depsFor(
  osc: PackagerOscApi,
  token: string,
  extra: Partial<EnsurePackagerDeps> = {}
): EnsurePackagerDeps {
  return {
    osc,
    coords: {
      stackName: STACK,
      redisUrl: 'redis://valkey:6379',
      minioEndpoint: 'https://objectstore.example.test',
      packagedBucket: 'openvideocore-packaged'
    },
    secrets: {
      minioRootPassword: 'rootpw',
      oscPersonalAccessToken: token
    },
    ...extra
  };
}

const patSecretName = `${STACK}.${PACKAGER_PAT_PURPOSE}`;

describe('existing packager access-token refresh (issue #1335)', () => {
  it('re-saves <stack>.pat with the current token on the exists path', async () => {
    const osc = makeExistingOscApi();

    const result = await ensurePackagerProvisioned(
      depsFor(osc, NEW_TOKEN, { patRollLedger: new PackagerPatRollLedger() })
    );

    expect(result).toEqual({ status: 'exists', instanceName: STACK });
    expect(osc.saveSecret).toHaveBeenCalledWith(
      PACKAGER_SERVICE_ID,
      patSecretName,
      NEW_TOKEN
    );
    // Reuse, not re-provision: the instance is never recreated.
    expect(osc.createInstance).not.toHaveBeenCalled();
  });

  it('rolls the instance once per process so it re-reads the refreshed secret', async () => {
    const osc = makeExistingOscApi();
    const ledger = new PackagerPatRollLedger();

    await ensurePackagerProvisioned(
      depsFor(osc, NEW_TOKEN, { patRollLedger: ledger })
    );

    expect(osc.restartInstance).toHaveBeenCalledWith(
      PACKAGER_SERVICE_ID,
      STACK,
      'sat-token'
    );
    // Readiness is awaited before the caller enqueues onto the packager's queue.
    expect(osc.waitForInstanceReady).toHaveBeenCalledWith(
      PACKAGER_SERVICE_ID,
      STACK
    );
    expect(ledger.hasRolled(STACK)).toBe(true);

    // Second execution in the same process: refresh again (cheap, overwrite),
    // but do not restart a healthy packager that may be mid-job.
    await ensurePackagerProvisioned(
      depsFor(osc, NEW_TOKEN, { patRollLedger: ledger })
    );
    expect(osc.restartInstance).toHaveBeenCalledTimes(1);
    expect(
      (osc.saveSecret as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[1] === patSecretName
      )
    ).toHaveLength(2);
  });

  it('writes the rotated value, not the value the packager was created with', async () => {
    const osc = makeExistingOscApi();

    // Process restarted with a rotated token => fresh ledger, old packager.
    await ensurePackagerProvisioned(
      depsFor(osc, NEW_TOKEN, { patRollLedger: new PackagerPatRollLedger() })
    );

    const patValues = (osc.saveSecret as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[1] === patSecretName)
      .map((c) => c[2]);
    expect(patValues).toContain(NEW_TOKEN);
    expect(patValues).not.toContain(OLD_TOKEN);
  });

  it('skips readiness waiting when the caller opted out (waitForReady: false)', async () => {
    const osc = makeExistingOscApi();

    await ensurePackagerProvisioned(
      depsFor(osc, NEW_TOKEN, {
        patRollLedger: new PackagerPatRollLedger(),
        waitForReady: false
      })
    );

    expect(osc.restartInstance).toHaveBeenCalledTimes(1);
    expect(osc.waitForInstanceReady).not.toHaveBeenCalled();
  });

  it('refreshes but does not roll when no ledger is wired', async () => {
    const osc = makeExistingOscApi();

    const result = await ensurePackagerProvisioned(depsFor(osc, NEW_TOKEN));

    expect(result).toEqual({ status: 'exists', instanceName: STACK });
    expect(osc.saveSecret).toHaveBeenCalledWith(
      PACKAGER_SERVICE_ID,
      patSecretName,
      NEW_TOKEN
    );
    expect(osc.restartInstance).not.toHaveBeenCalled();
  });

  it('refreshes without rolling when the osc adapter cannot restart', async () => {
    // restartInstance is optional on PackagerOscApi, so a pre-#1335 adapter
    // keeps working: the secret is refreshed and nothing is restarted.
    const osc = makeExistingOscApi();
    delete (osc as { restartInstance?: unknown }).restartInstance;

    const result = await ensurePackagerProvisioned(
      depsFor(osc, NEW_TOKEN, { patRollLedger: new PackagerPatRollLedger() })
    );

    expect(result).toEqual({ status: 'exists', instanceName: STACK });
    expect(osc.saveSecret).toHaveBeenCalledWith(
      PACKAGER_SERVICE_ID,
      patSecretName,
      NEW_TOKEN
    );
  });
});

describe('existing packager refresh failure handling (issue #1335)', () => {
  it('does not restart when the secret refresh itself failed', async () => {
    const osc = makeExistingOscApi({
      saveSecret: vi.fn(async () => {
        throw new Error('OSC secret write failed: 503');
      })
    });
    const log = makeLog();
    const ledger = new PackagerPatRollLedger();

    const result = await ensurePackagerProvisioned(
      depsFor(osc, NEW_TOKEN, { patRollLedger: ledger, log })
    );

    // Non-fatal: packaging on an unrotated token must not break because the
    // precautionary refresh could not be written.
    expect(result).toEqual({ status: 'exists', instanceName: STACK });
    // Restarting would only re-read the OLD value, so it is skipped.
    expect(osc.restartInstance).not.toHaveBeenCalled();
    expect(ledger.hasRolled(STACK)).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        stackName: STACK,
        serviceId: PACKAGER_SERVICE_ID,
        phase: 'refresh-pat',
        error: expect.stringContaining('503')
      }),
      expect.any(String)
    );
  });

  it('logs a restart failure, keeps the ensure call successful, and retries later', async () => {
    const restartInstance = vi
      .fn<(serviceId: string, name: string, token: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('restart link not available'))
      .mockResolvedValue(undefined);
    const osc = makeExistingOscApi({ restartInstance });
    const log = makeLog();
    const ledger = new PackagerPatRollLedger();

    const first = await ensurePackagerProvisioned(
      depsFor(osc, NEW_TOKEN, { patRollLedger: ledger, log })
    );
    expect(first).toEqual({ status: 'exists', instanceName: STACK });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        stackName: STACK,
        phase: 'refresh-pat-roll',
        error: expect.stringContaining('restart link not available')
      }),
      expect.any(String)
    );
    // A failed roll must not consume the one claim this process had.
    expect(ledger.hasRolled(STACK)).toBe(false);

    await ensurePackagerProvisioned(
      depsFor(osc, NEW_TOKEN, { patRollLedger: ledger, log })
    );
    expect(restartInstance).toHaveBeenCalledTimes(2);
    expect(ledger.hasRolled(STACK)).toBe(true);
  });

  it('releases the claim when the readiness wait after a roll fails', async () => {
    const osc = makeExistingOscApi({
      waitForInstanceReady: vi.fn(async () => {
        throw new Error('readiness timeout after 300s');
      })
    });
    const log = makeLog();
    const ledger = new PackagerPatRollLedger();

    const result = await ensurePackagerProvisioned(
      depsFor(osc, NEW_TOKEN, { patRollLedger: ledger, log })
    );

    expect(result).toEqual({ status: 'exists', instanceName: STACK });
    expect(ledger.hasRolled(STACK)).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'refresh-pat-roll' }),
      expect.any(String)
    );
  });

  it('never logs the token value', async () => {
    const osc = makeExistingOscApi({
      restartInstance: vi.fn(async () => {
        throw new Error('restart rejected');
      })
    });
    const log = makeLog();

    await ensurePackagerProvisioned(
      depsFor(osc, NEW_TOKEN, {
        patRollLedger: new PackagerPatRollLedger(),
        log
      })
    );

    const logged = JSON.stringify([log.info.mock.calls, log.error.mock.calls]);
    expect(logged).not.toContain(NEW_TOKEN);
  });
});

describe('PackagerPatRollLedger (issue #1335)', () => {
  it('grants one claim per stack and keeps stacks independent', () => {
    const ledger = new PackagerPatRollLedger();

    expect(ledger.claim('a')).toBe(true);
    expect(ledger.claim('a')).toBe(false);
    expect(ledger.claim('b')).toBe(true);
    expect(ledger.hasRolled('a')).toBe(true);
    expect(ledger.hasRolled('c')).toBe(false);
  });

  it('re-grants a claim after it is released', () => {
    const ledger = new PackagerPatRollLedger();

    expect(ledger.claim('a')).toBe(true);
    ledger.release('a');
    expect(ledger.hasRolled('a')).toBe(false);
    expect(ledger.claim('a')).toBe(true);
  });
});
