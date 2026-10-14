// Archive retention config router tests (issue #325, foundation for #323).
//
// Proves the two config behaviours the sweep depends on:
//   1. Default-off: ARCHIVE_RETENTION_MS unset (or 0) resolves to 0 = never
//      purge, behaviourally identical to today for every existing deployment.
//   2. Hot override: PATCH /config hot-swaps the live retention window with no
//      restart and fires onConfigChange, exactly as scaler's config PATCH does.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Live-mutable-var + onConfigChange PATCH pattern mirrored from
//     src/routes/scaler.ts:88-152.
//   - Router boundary test harness (register once, inject) mirrored from
//     test/scaler-late-init.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import {
  retentionRouter,
  archiveRetentionMsFromEnv,
  auditRetentionMsFromEnv,
  logRetentionMsFromEnv,
  RETENTION_DISABLED_MS
} from '../src/routes/retention.js';

describe('archiveRetentionMsFromEnv default-off (#325)', () => {
  const original = process.env['ARCHIVE_RETENTION_MS'];

  afterEach(() => {
    if (original === undefined) {
      delete process.env['ARCHIVE_RETENTION_MS'];
    } else {
      process.env['ARCHIVE_RETENTION_MS'] = original;
    }
  });

  it('resolves to 0 (never purge) when ARCHIVE_RETENTION_MS is unset', () => {
    delete process.env['ARCHIVE_RETENTION_MS'];
    expect(archiveRetentionMsFromEnv()).toBe(RETENTION_DISABLED_MS);
    expect(archiveRetentionMsFromEnv()).toBe(0);
  });

  it('resolves to 0 (never purge) when ARCHIVE_RETENTION_MS is explicitly "0"', () => {
    process.env['ARCHIVE_RETENTION_MS'] = '0';
    expect(archiveRetentionMsFromEnv()).toBe(0);
  });

  it('resolves to the configured window when ARCHIVE_RETENTION_MS is a positive int', () => {
    process.env['ARCHIVE_RETENTION_MS'] = '86400000';
    expect(archiveRetentionMsFromEnv()).toBe(86_400_000);
  });

  it('falls back to disabled on a non-numeric or negative value', () => {
    process.env['ARCHIVE_RETENTION_MS'] = 'not-a-number';
    expect(archiveRetentionMsFromEnv()).toBe(0);
    process.env['ARCHIVE_RETENTION_MS'] = '-5';
    expect(archiveRetentionMsFromEnv()).toBe(0);
  });
});

describe('PATCH /retention/config hot override (#325)', () => {
  let app: FastifyInstance;
  // The shared options object main.ts holds by reference; onConfigChange
  // propagates the live window to the instance-global var the sweep reads.
  let options: {
    prefix: string;
    retentionMs: number;
    auditRetentionMs?: number;
    logRetentionMs?: number;
    onConfigChange?: (cfg: {
      retentionMs: number;
      auditRetentionMs: number;
      logRetentionMs: number;
    }) => void;
  };
  let onConfigChange: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    onConfigChange = vi.fn();
    options = {
      prefix: '/retention',
      retentionMs: 0, // boot default: disabled
      auditRetentionMs: 0, // boot default: indefinite retention
      logRetentionMs: 0, // boot default: indefinite retention (issue #1067)
      onConfigChange
    };
    await app.register(retentionRouter, options);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports both boot defaults (0 = disabled / indefinite) on GET /config', async () => {
    const res = await app.inject({ method: 'GET', url: '/retention/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ retentionMs: 0, auditRetentionMs: 0, logRetentionMs: 0 });
  });

  it('hot-swaps the live retention window without restart and fires onConfigChange', async () => {
    // Before: disabled.
    const before = await app.inject({ method: 'GET', url: '/retention/config' });
    expect(before.json()).toEqual({ retentionMs: 0, auditRetentionMs: 0, logRetentionMs: 0 });

    // Hot override on the SAME running app — no re-registration, no restart.
    const patch = await app.inject({
      method: 'PATCH',
      url: '/retention/config',
      payload: { retentionMs: 3_600_000 }
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({
      retentionMs: 3_600_000,
      auditRetentionMs: 0,
      logRetentionMs: 0
    });

    // The callback (what main.ts uses to mutate the instance-global var) fired
    // with both effective windows.
    expect(onConfigChange).toHaveBeenCalledWith({
      retentionMs: 3_600_000,
      auditRetentionMs: 0,
      logRetentionMs: 0
    });

    // GET now reflects the new live window on the same app.
    const after = await app.inject({ method: 'GET', url: '/retention/config' });
    expect(after.json()).toEqual({
      retentionMs: 3_600_000,
      auditRetentionMs: 0,
      logRetentionMs: 0
    });
  });

  it('hot-swaps the AUDIT-LOG retention window independently (issue #566)', async () => {
    // Set only the audit window; the archived-asset window is untouched.
    const patch = await app.inject({
      method: 'PATCH',
      url: '/retention/config',
      payload: { auditRetentionMs: 7_200_000 }
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({
      retentionMs: 0,
      auditRetentionMs: 7_200_000,
      logRetentionMs: 0
    });
    expect(onConfigChange).toHaveBeenCalledWith({
      retentionMs: 0,
      auditRetentionMs: 7_200_000,
      logRetentionMs: 0
    });

    const after = await app.inject({ method: 'GET', url: '/retention/config' });
    expect(after.json()).toEqual({
      retentionMs: 0,
      auditRetentionMs: 7_200_000,
      logRetentionMs: 0
    });
  });

  it('hot-swaps the OPERATIONAL-LOG retention window independently (issue #1067)', async () => {
    // Set only the log window; the archived-asset and audit windows are
    // untouched — the three windows share one surface but move independently.
    const patch = await app.inject({
      method: 'PATCH',
      url: '/retention/config',
      payload: { logRetentionMs: 1_800_000 }
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({
      retentionMs: 0,
      auditRetentionMs: 0,
      logRetentionMs: 1_800_000
    });
    expect(onConfigChange).toHaveBeenCalledWith({
      retentionMs: 0,
      auditRetentionMs: 0,
      logRetentionMs: 1_800_000
    });

    const after = await app.inject({ method: 'GET', url: '/retention/config' });
    expect(after.json()).toEqual({
      retentionMs: 0,
      auditRetentionMs: 0,
      logRetentionMs: 1_800_000
    });
  });

  it('rejects a negative log window (same validation as the audit window, #1067)', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: '/retention/config',
      payload: { logRetentionMs: -1 }
    });
    expect(patch.statusCode).toBe(400);
    // The live window is unchanged by the rejected PATCH.
    const after = await app.inject({ method: 'GET', url: '/retention/config' });
    expect(after.json()).toMatchObject({ logRetentionMs: 0 });
  });
});

describe('auditRetentionMsFromEnv default-off (#566)', () => {
  const original = process.env['AUDIT_RETENTION_MS'];
  afterEach(() => {
    if (original === undefined) delete process.env['AUDIT_RETENTION_MS'];
    else process.env['AUDIT_RETENTION_MS'] = original;
  });

  it('resolves to 0 (indefinite retention) when AUDIT_RETENTION_MS is unset or 0', () => {
    delete process.env['AUDIT_RETENTION_MS'];
    expect(auditRetentionMsFromEnv()).toBe(RETENTION_DISABLED_MS);
    process.env['AUDIT_RETENTION_MS'] = '0';
    expect(auditRetentionMsFromEnv()).toBe(0);
  });

  it('resolves to the configured window and falls back to disabled on bad input', () => {
    process.env['AUDIT_RETENTION_MS'] = '86400000';
    expect(auditRetentionMsFromEnv()).toBe(86_400_000);
    process.env['AUDIT_RETENTION_MS'] = 'nope';
    expect(auditRetentionMsFromEnv()).toBe(0);
    process.env['AUDIT_RETENTION_MS'] = '-5';
    expect(auditRetentionMsFromEnv()).toBe(0);
  });
});

// Operational-log window (issue #1067): same default-off env contract as the
// audit window above, so a deployment that does not set LOG_RETENTION_MS keeps
// its log records indefinitely (#996's behaviour).
describe('logRetentionMsFromEnv default-off (#1067)', () => {
  const original = process.env['LOG_RETENTION_MS'];
  afterEach(() => {
    if (original === undefined) delete process.env['LOG_RETENTION_MS'];
    else process.env['LOG_RETENTION_MS'] = original;
  });

  it('resolves to 0 (indefinite retention) when LOG_RETENTION_MS is unset or 0', () => {
    delete process.env['LOG_RETENTION_MS'];
    expect(logRetentionMsFromEnv()).toBe(RETENTION_DISABLED_MS);
    process.env['LOG_RETENTION_MS'] = '0';
    expect(logRetentionMsFromEnv()).toBe(0);
  });

  it('resolves to the configured window and falls back to disabled on bad input', () => {
    process.env['LOG_RETENTION_MS'] = '86400000';
    expect(logRetentionMsFromEnv()).toBe(86_400_000);
    process.env['LOG_RETENTION_MS'] = 'nope';
    expect(logRetentionMsFromEnv()).toBe(0);
    process.env['LOG_RETENTION_MS'] = '-5';
    expect(logRetentionMsFromEnv()).toBe(0);
  });
});
