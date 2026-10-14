// Bounded readiness waits on the two paths #1038/#1045 missed (issue #1055).
//
// #1045 moved the five readiness waits in src/routes/provision.ts onto the
// shared bounded helper. Two call sites outside that file still used
// @osaas/client-core's waitForInstanceReady:
//
//   1. the ON-DEMAND PACKAGER (src/services/packager-provisioning.ts), which
//      every stack hits on its FIRST packaging job, and
//   2. the CONFIG-QUEUE bootstrap (the dedicated Valkey ensureParameterStore
//      creates for the config service, wired in src/main.ts).
//
// The SDK helper is
//
//   async function waitForInstanceReady(serviceId, name, ctx) {
//     const serviceAccessToken = await ctx.getServiceAccessToken(serviceId);
//     let instanceOk = false;
//     while (!instanceOk) {
//       await delay(1000);
//       const status = await getInstanceHealth(ctx, serviceId, name, serviceAccessToken);
//       if (status && status === 'running') { instanceOk = true; }
//     }
//   }
//
// — no deadline, and no try around the probe. So one dropped poll out of
// several hundred (`fetch failed`) failed a stack's first packaging job, and a
// Valkey that never reported `running` hung the startup bootstrap with no error.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7),
// @osaas/client-core@0.24.0 as installed in node_modules:
//   - lib/core.d.ts:86   getInstanceHealth(context: Context, serviceId: string,
//                          name: string, token: string): Promise<string>
//     => serviceId is argument 2, the instance name argument 3; that is what the
//     assertions below index into.
//   - lib/core.js:343-353  waitForInstanceReady's body, quoted verbatim above —
//     the source of both defects, and of the `running` ready state and 1s
//     cadence the bounded helper stays compatible with.
//   - lib/core.d.ts:153  waitForInstanceReady(serviceId: string, name: string,
//                          ctx: Context): Promise<void>  — the helper replaced.
//   - lib/context.d.ts:25  Context.getServiceAccessToken(serviceId):
//                          Promise<string>
// Same-repo contracts:
//   - src/services/stack.ts:54  PACKAGER_SERVICE_ID = 'eyevinn-encore-packager'
//   - src/services/packager-provisioning.ts  packagerOscApiFromContext(osc,
//     readiness) / PackagerOscApi.waitForInstanceReady(serviceId, name)
//   - src/services/param-store.ts  OscInstanceApi.waitForInstanceReady(
//     serviceId, name) and VALKEY_SERVICE_ID = 'valkey-io-valkey'
//   - src/services/instance-readiness.ts  waitForInstanceReadyBounded(context,
//     serviceId, name, { timeoutMs, pollIntervalMs, label })

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The health probe the bounded helper owns. Each test installs its own
// behaviour; the default is "ready on the first poll".
const getInstanceHealth = vi.fn(async (..._args: unknown[]) => 'running');
const createInstance = vi.fn(async () => ({ name: 'stack-1' }));
const getInstance = vi.fn(async () => undefined);
const saveSecret = vi.fn(async () => undefined);
const removeInstance = vi.fn(async () => undefined);

vi.mock('@osaas/client-core', () => ({
  createInstance: (...args: unknown[]) => createInstance(...(args as [])),
  getInstance: (...args: unknown[]) => getInstance(...(args as [])),
  removeInstance: (...args: unknown[]) => removeInstance(...(args as [])),
  saveSecret: (...args: unknown[]) => saveSecret(...(args as [])),
  getInstanceHealth: (...args: unknown[]) => getInstanceHealth(...(args as [])),
  // Nothing under src/ imports the SDK's waitForInstanceReady any more — that
  // is the point of #1038 (provision.ts) and #1055 (these two paths). Exported
  // on the mock only so a reintroduction fails on an assertion here rather than
  // on a missing export somewhere unrelated.
  waitForInstanceReady: vi.fn(async () => undefined),
  Context: class {}
}));

const { packagerOscApiFromContext, ensurePackagerProvisioned } = await import(
  '../src/services/packager-provisioning.js'
);
const { PACKAGER_SERVICE_ID } = await import('../src/services/stack.js');
const { ensureParameterStore } = await import('../src/services/param-store.js');
const { waitForInstanceReadyBounded } = await import(
  '../src/services/instance-readiness.js'
);

type OscContext = Parameters<typeof packagerOscApiFromContext>[0];

// Minimal @osaas/client-core Context stand-in. getServiceAccessToken is the
// only member either path calls on it (lib/context.d.ts:25).
function fakeContext(): OscContext {
  return {
    getServiceAccessToken: vi.fn(async () => 'sat-token')
  } as unknown as OscContext;
}

function makeLog() {
  return { info: vi.fn(), error: vi.fn() };
}

const coords = {
  stackName: 'stack-1',
  redisUrl: 'redis://valkey:6379',
  minioEndpoint: 'https://minio.example',
  packagedBucket: 'openvideocore-packaged'
};
// Fixture values only — never real credentials. Prefixed so a secret scanner
// (and a reader) can tell at a glance that these are dummies (#1055 review,
// non-blocking finding 4).
const secrets = {
  minioRootPassword: 'dummy-root-password',
  oscPersonalAccessToken: 'test-access-token'
};

// Stand-in for the caller's `package` step: it awaits the packager ensure the
// way src/main.ts's ensurePackaging closure does, and only enqueues once that
// resolves. A readiness failure must leave the step `failed` with the cause —
// never hang, never silently enqueue onto a queue with no consumer.
async function runPackageStep(ensure: () => Promise<unknown>) {
  try {
    await ensure();
    return { status: 'enqueued' as const };
  } catch (err) {
    return {
      status: 'failed' as const,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

beforeEach(() => {
  getInstanceHealth.mockReset();
  getInstanceHealth.mockImplementation(async () => 'running');
  createInstance.mockReset();
  createInstance.mockImplementation(async () => ({ name: 'stack-1' }));
  getInstance.mockReset();
  getInstance.mockImplementation(async () => undefined);
  saveSecret.mockReset();
  saveSecret.mockImplementation(async () => undefined);
});

describe('on-demand packager readiness wait is bounded (issue #1055)', () => {
  it('tolerates a single dropped health poll: provisions and the package step proceeds', async () => {
    // ONE probe rejects the way the 2026-09-30 incident did, then the packager
    // reports ready. Under the SDK helper the rejection propagated and failed
    // the package step; the bounded helper treats it as "not ready yet".
    getInstanceHealth
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue('running');

    const log = makeLog();
    const osc = packagerOscApiFromContext(fakeContext(), {
      // Collapse the 1s SDK cadence so this test does not sleep. The deadline is
      // generous: the point is the retry, not the timeout.
      pollIntervalMs: 1,
      timeoutMs: 5_000
    });

    const step = await runPackageStep(() =>
      ensurePackagerProvisioned({ osc, coords, secrets, log })
    );

    expect(step).toEqual({ status: 'enqueued' });
    expect(createInstance).toHaveBeenCalledOnce();
    // Probed at least twice: the dropped poll, then the successful one.
    expect(getInstanceHealth.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Every probe targeted the packager instance (args 2 and 3 of
    // getInstanceHealth, lib/core.d.ts:86).
    for (const call of getInstanceHealth.mock.calls) {
      expect(call[1]).toBe(PACKAGER_SERVICE_ID);
      expect(call[2]).toBe('stack-1');
    }
    // Reported ready, so the step was not merely "not failed".
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        stackName: 'stack-1',
        serviceId: PACKAGER_SERVICE_ID
      }),
      expect.stringContaining('ready')
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('fails the package step at the deadline, naming the service and the last probe error', async () => {
    // A packager that never reports running: under the SDK helper this looped
    // forever. Now it must end at the deadline with an attributable error.
    getInstanceHealth.mockRejectedValue(new Error('fetch failed'));

    const log = makeLog();
    const osc = packagerOscApiFromContext(fakeContext(), {
      pollIntervalMs: 2,
      timeoutMs: 30
    });

    const step = await runPackageStep(() =>
      ensurePackagerProvisioned({ osc, coords, secrets, log })
    );

    expect(step.status).toBe('failed');
    // Names the service…
    expect(step.error).toContain(PACKAGER_SERVICE_ID);
    expect(step.error).toContain('eyevinn-encore-packager');
    // …the instance and the label…
    expect(step.error).toContain('stack-1');
    expect(step.error).toContain('packager');
    // …and the last probe error, instead of surfacing a bare `fetch failed`
    // with no attribution.
    expect(step.error).toContain('fetch failed');
    expect(step.error).toMatch(/timed out after 30ms/);
    // Logged as a readiness failure before being rethrown (the #335 contract
    // this path already had: log then rethrow, packager-provisioning.ts).
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'stack-1', phase: 'ready' }),
      expect.any(String)
    );
    // Never falsely reported ready.
    expect(log.info).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('ready')
    );
  });

  it('never reports ready on an instance stuck in a non-running health state', async () => {
    // Not an error — a health endpoint that keeps answering `starting`. The
    // timeout message carries the last reported health instead of a probe error.
    getInstanceHealth.mockResolvedValue('starting');

    const osc = packagerOscApiFromContext(fakeContext(), {
      pollIntervalMs: 2,
      timeoutMs: 30
    });

    const step = await runPackageStep(() =>
      ensurePackagerProvisioned({ osc, coords, secrets })
    );

    expect(step.status).toBe('failed');
    expect(step.error).toContain(PACKAGER_SERVICE_ID);
    expect(step.error).toContain('last reported health: starting');
  });
});

describe('config-queue bootstrap readiness wait is bounded (issue #1055)', () => {
  const log = { info: vi.fn(), warn: vi.fn() };

  // The adapter ensureParameterStore is given, built exactly as src/main.ts
  // builds it for the startup bootstrap: the bounded helper with the
  // 'config queue' label. OscInstanceApi's shape is unchanged
  // (src/services/param-store.ts), so only the fulfilment differs.
  function makeOsc(readiness: { timeoutMs: number; pollIntervalMs: number }) {
    const ctx = fakeContext();
    return {
      getServiceAccessToken: (serviceId: string) =>
        ctx.getServiceAccessToken(serviceId),
      getInstance: vi.fn(async () => undefined),
      createInstance: vi.fn(async () => ({ name: 'ovcconfig' })),
      waitForInstanceReady: (serviceId: string, name: string) =>
        waitForInstanceReadyBounded(ctx, serviceId, name, {
          ...readiness,
          label: 'config queue'
        }),
      getPortsForInstance: vi.fn(async () => [
        { externalIp: '10.0.0.1', externalPort: 6379, internalPort: 6379 }
      ])
    };
  }

  beforeEach(() => {
    process.env['PARAMETER_STORE_API_KEY'] = 'key123';
    delete process.env['PARAMETER_STORE_INSTANCE_NAME'];
    log.info.mockReset();
    log.warn.mockReset();
  });

  afterEach(() => {
    delete process.env['PARAMETER_STORE_API_KEY'];
    delete process.env['PARAMETER_STORE_INSTANCE_NAME'];
  });

  it('tolerates a dropped poll and still bootstraps the config service', async () => {
    getInstanceHealth
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue('running');

    const osc = makeOsc({ timeoutMs: 5_000, pollIntervalMs: 1 });
    expect(await ensureParameterStore({ osc, log })).toBe(true);
    // The config service itself is created only after its Valkey reported ready.
    expect(osc.createInstance).toHaveBeenCalledTimes(2);
  });

  it('gives up at a deadline instead of hanging startup forever', async () => {
    getInstanceHealth.mockRejectedValue(new Error('fetch failed'));

    const osc = makeOsc({ timeoutMs: 30, pollIntervalMs: 2 });
    // ensureParameterStore's own contract on failure: warn and return false, so
    // the deployment starts without persistence rather than never starting.
    expect(await ensureParameterStore({ osc, log })).toBe(false);

    const warning = log.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warning).toContain('valkey-io-valkey');
    expect(warning).toContain('config queue');
    expect(warning).toContain('fetch failed');
    expect(warning).toMatch(/timed out after 30ms/);
    // The Valkey was created, but the config service was NOT: we never pretend
    // a dependency is live.
    const created = osc.createInstance.mock.calls.length;
    expect(created).toBe(1);
  });
});
