import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ResolverHealthSignal } from './resolver-health.js';
import { WorkspaceStackResolver } from './workspace-stack.js';
import type { Context } from '@osaas/client-core';

// Minimal Context stand-in — the no-storage / env-override paths exercised here
// never call into it beyond construction.
const fakeContext = {} as unknown as Context;

// Env vars the resolver reads for the env-override (healthy) path. Saved and
// restored so tests never leak state (mirrors public-base-url.test.ts).
const SAVED = {
  couch: process.env['COUCHDB_URL'],
  minio: process.env['MINIO_URL']
};

beforeEach(() => {
  delete process.env['COUCHDB_URL'];
  delete process.env['MINIO_URL'];
});

afterEach(() => {
  if (SAVED.couch === undefined) delete process.env['COUCHDB_URL'];
  else process.env['COUCHDB_URL'] = SAVED.couch;
  if (SAVED.minio === undefined) delete process.env['MINIO_URL'];
  else process.env['MINIO_URL'] = SAVED.minio;
});

describe('ResolverHealthSignal (issue #422)', () => {
  it('starts healthy (not degraded, mode none, zero counters)', () => {
    const sig = new ResolverHealthSignal();
    const s = sig.snapshot();
    expect(s.degraded).toBe(false);
    expect(s.mode).toBe('none');
    expect(s.noStorageFallbackTotal).toBe(0);
    expect(s.staleFallbackTotal).toBe(0);
    expect(s.lastDegradedAt).toBeNull();
  });

  it('flips to degraded no-storage state and increments the counter', () => {
    let clock = 1000;
    const sig = new ResolverHealthSignal(() => clock);
    sig.markNoStorageFallback();
    const s = sig.snapshot();
    expect(s.degraded).toBe(true);
    expect(s.mode).toBe('no-storage');
    expect(s.noStorageFallbackTotal).toBe(1);
    expect(s.lastDegradedAt).toBe(1000);
  });

  it('accumulates the no-storage counter across refresh cycles while degraded', () => {
    const sig = new ResolverHealthSignal();
    sig.markNoStorageFallback();
    sig.markNoStorageFallback();
    sig.markNoStorageFallback();
    expect(sig.snapshot().noStorageFallbackTotal).toBe(3);
    expect(sig.snapshot().degraded).toBe(true);
  });

  it('flips to the stale last-known-good degraded state', () => {
    const sig = new ResolverHealthSignal();
    sig.markStaleLastKnownGood();
    const s = sig.snapshot();
    expect(s.degraded).toBe(true);
    expect(s.mode).toBe('stale-last-known-good');
    expect(s.staleFallbackTotal).toBe(1);
  });

  it('clears the degraded gauge on recovery but keeps the counters', () => {
    const sig = new ResolverHealthSignal();
    sig.markNoStorageFallback();
    sig.markHealthy();
    const s = sig.snapshot();
    expect(s.degraded).toBe(false);
    expect(s.mode).toBe('none');
    // Counter persists so an alert can fire on rate-of-change post-recovery.
    expect(s.noStorageFallbackTotal).toBe(1);
  });
});

describe('WorkspaceStackResolver emits the degraded signal (issue #422)', () => {
  it('signals no-storage fallback when no parameter store is configured', async () => {
    const sig = new ResolverHealthSignal();
    const resolver = new WorkspaceStackResolver({
      paramStore: undefined,
      oscContext: fakeContext,
      minioPassword: '',
      couchPassword: '',
      resolverHealth: sig
    });

    // Baseline: healthy before any resolve.
    expect(sig.snapshot().degraded).toBe(false);

    await resolver.resolve();

    const s = sig.snapshot();
    expect(s.degraded).toBe(true);
    expect(s.mode).toBe('no-storage');
    expect(s.noStorageFallbackTotal).toBe(1);
  });

  it('stays healthy when an explicit env override serves live connections', async () => {
    process.env['COUCHDB_URL'] = 'http://admin:pw@couch.example.test:5984';
    const sig = new ResolverHealthSignal();
    const resolver = new WorkspaceStackResolver({
      paramStore: undefined,
      oscContext: fakeContext,
      minioPassword: '',
      couchPassword: '',
      resolverHealth: sig
    });

    await resolver.resolve();

    const s = sig.snapshot();
    expect(s.degraded).toBe(false);
    expect(s.mode).toBe('none');
    expect(s.noStorageFallbackTotal).toBe(0);
  });
});
