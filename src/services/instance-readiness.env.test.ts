// Regression: an invalid PROVISION_READY_TIMEOUT_MS must not un-bound the
// readiness wait (issue #1055 review, blocking finding 2).
//
// src/main.ts used to pass `parseInt(process.env['PROVISION_READY_TIMEOUT_MS'],
// 10)` straight through. `parseInt('abc', 10)` is NaN, and NaN is not nullish,
// so it survived `readyTimeoutMs ?? DEFAULT_INSTANCE_READY_TIMEOUT_MS` in
// src/routes/provision.ts and `options.timeoutMs ??
// DEFAULT_INSTANCE_READY_TIMEOUT_MS` in waitForInstanceReadyBounded, reaching
// the poll loop as the deadline. There every guard goes dead: `remaining <= 0`
// is false, `Math.min(pollIntervalMs, NaN)` is NaN so the sleep is effectively
// zero, and `Date.now() >= deadline` is never true — so the "bounded" wait
// became an unbounded hot loop of getInstanceHealth calls. `'0'` was the milder
// variant: truthy, forwarded, and the deadline already in the past.
//
// CONTRACTS VERIFIED BEFORE WRITING (CLAUDE.md rule 7), same-repo sources read
// at their cited lines:
//   - src/services/instance-readiness.ts  resolveReadinessDurationMs(raw,
//     defaultMs, envName, log?) -> number; DEFAULT_INSTANCE_READY_TIMEOUT_MS
//     (= 5 * 60_000); DEFAULT_INSTANCE_READY_POLL_INTERVAL_MS (= 1_000);
//     InstanceReadinessLogger = { warn: (obj: unknown, msg?: string) => void }
//   - src/services/instance-readiness.ts  waitForInstanceReadyBounded(context,
//     serviceId, name, { timeoutMs, pollIntervalMs, label }) — the consumer
//     whose loop guards the validation protects (its `remaining <= 0` /
//     `Date.now() >= deadline` checks)
//   - src/routes/provision.ts  readinessOptions = { timeoutMs: readyTimeoutMs ??
//     DEFAULT_INSTANCE_READY_TIMEOUT_MS, pollIntervalMs: readyPollIntervalMs ??
//     DEFAULT_INSTANCE_READY_POLL_INTERVAL_MS } — the `??` that NaN defeated
//   - src/main.ts  provisionRouter registration options readyTimeoutMs /
//     readyPollIntervalMs, the call sites now routed through the resolver
//   - @osaas/client-core@0.24.0 lib/core.d.ts:86  getInstanceHealth(context,
//     serviceId, name, token): Promise<string> — the probe counted below

import { describe, it, expect, vi } from 'vitest';
import {
  resolveReadinessDurationMs,
  DEFAULT_INSTANCE_READY_TIMEOUT_MS,
  DEFAULT_INSTANCE_READY_POLL_INTERVAL_MS
} from './instance-readiness.js';

describe('resolveReadinessDurationMs', () => {
  it('falls back to the default and warns for a malformed value', () => {
    const warn = vi.fn();

    const resolved = resolveReadinessDurationMs(
      'abc',
      DEFAULT_INSTANCE_READY_TIMEOUT_MS,
      'PROVISION_READY_TIMEOUT_MS',
      { warn }
    );

    // The whole point: NaN never reaches the poll loop.
    expect(resolved).toBe(DEFAULT_INSTANCE_READY_TIMEOUT_MS);
    expect(Number.isFinite(resolved)).toBe(true);

    expect(warn).toHaveBeenCalledTimes(1);
    // The warning has to name the rejected value, or an operator cannot see
    // which env var silently reverted to the default.
    const [obj, msg] = warn.mock.calls[0]!;
    expect(obj).toMatchObject({
      env: 'PROVISION_READY_TIMEOUT_MS',
      value: 'abc',
      fallbackMs: DEFAULT_INSTANCE_READY_TIMEOUT_MS
    });
    expect(String(msg)).toContain('PROVISION_READY_TIMEOUT_MS');
    expect(String(msg)).toContain('abc');
  });

  it('falls back to the default and warns for a zero value', () => {
    const warn = vi.fn();

    const resolved = resolveReadinessDurationMs(
      '0',
      DEFAULT_INSTANCE_READY_TIMEOUT_MS,
      'PROVISION_READY_TIMEOUT_MS',
      { warn }
    );

    // '0' is truthy as a string, so the old `process.env[...] ? ... : {}` guard
    // forwarded it: the deadline landed in the past and the wait timed out
    // before its first probe.
    expect(resolved).toBe(DEFAULT_INSTANCE_READY_TIMEOUT_MS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ value: '0' });
  });

  it('falls back to the default for a negative value', () => {
    const warn = vi.fn();
    expect(
      resolveReadinessDurationMs(
        '-1',
        DEFAULT_INSTANCE_READY_TIMEOUT_MS,
        'PROVISION_READY_TIMEOUT_MS',
        { warn }
      )
    ).toBe(DEFAULT_INSTANCE_READY_TIMEOUT_MS);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('uses the default silently when the variable is unset or empty', () => {
    const warn = vi.fn();

    expect(
      resolveReadinessDurationMs(
        undefined,
        DEFAULT_INSTANCE_READY_POLL_INTERVAL_MS,
        'PROVISION_READY_POLL_INTERVAL_MS',
        { warn }
      )
    ).toBe(DEFAULT_INSTANCE_READY_POLL_INTERVAL_MS);
    expect(
      resolveReadinessDurationMs(
        '   ',
        DEFAULT_INSTANCE_READY_POLL_INTERVAL_MS,
        'PROVISION_READY_POLL_INTERVAL_MS',
        { warn }
      )
    ).toBe(DEFAULT_INSTANCE_READY_POLL_INTERVAL_MS);

    // Not configuring the bound is not an error, so nothing is logged.
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts a valid positive override', () => {
    const warn = vi.fn();
    expect(
      resolveReadinessDurationMs(
        '45000',
        DEFAULT_INSTANCE_READY_TIMEOUT_MS,
        'PROVISION_READY_TIMEOUT_MS',
        { warn }
      )
    ).toBe(45_000);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('waitForInstanceReadyBounded with a non-finite timeout', () => {
  it('shows why the env read must be validated: NaN defeats every guard', async () => {
    // This is the failure the resolver prevents, reproduced directly against
    // the helper so the connection is testable rather than asserted in prose.
    // With timeoutMs = NaN the loop neither returns nor throws; it keeps
    // probing. We let it run for a bounded number of probes and then resolve
    // 'running' to end it, and assert it had already over-polled far past the
    // one probe a sane 1ms deadline would allow.
    const probes = { count: 0 };
    const getServiceAccessToken = vi.fn(async () => 'test-service-token');
    const context = { getServiceAccessToken } as never;

    vi.resetModules();
    vi.doMock('@osaas/client-core', () => ({
      getInstanceHealth: async () => {
        probes.count += 1;
        return probes.count >= 25 ? 'running' : 'starting';
      }
    }));
    const { waitForInstanceReadyBounded: boundedUnderMock } = await import(
      './instance-readiness.js'
    );

    await boundedUnderMock(context, 'some-service', 'inst-1', {
      timeoutMs: Number.NaN,
      pollIntervalMs: DEFAULT_INSTANCE_READY_POLL_INTERVAL_MS
    });

    // 25 probes at the nominal 1s cadence would take 25 seconds; they happened
    // inside this test because Math.min(1000, NaN) is NaN => immediate timer.
    expect(probes.count).toBe(25);
    expect(Math.min(DEFAULT_INSTANCE_READY_POLL_INTERVAL_MS, Number.NaN)).toBeNaN();

    vi.doUnmock('@osaas/client-core');
    vi.resetModules();
  }, 10_000);

  it('a validated timeout is finite, so the same wait ends on its deadline', async () => {
    const probes = { count: 0 };
    vi.resetModules();
    vi.doMock('@osaas/client-core', () => ({
      getInstanceHealth: async () => {
        probes.count += 1;
        return 'starting';
      }
    }));
    const { waitForInstanceReadyBounded: boundedUnderMock } = await import(
      './instance-readiness.js'
    );

    const timeoutMs = resolveReadinessDurationMs(
      'abc',
      20, // stand-in for DEFAULT_INSTANCE_READY_TIMEOUT_MS, kept test-fast
      'PROVISION_READY_TIMEOUT_MS'
    );
    expect(timeoutMs).toBe(20);

    await expect(
      boundedUnderMock(
        { getServiceAccessToken: async () => 'test-service-token' } as never,
        'some-service',
        'inst-1',
        { timeoutMs, pollIntervalMs: 5, label: 'config queue' }
      )
    ).rejects.toThrow(/timed out after 20ms waiting for OSC instance inst-1/);

    // Bounded: a handful of probes, not an unbounded hot loop.
    expect(probes.count).toBeLessThan(10);

    vi.doUnmock('@osaas/client-core');
    vi.resetModules();
  });
});
