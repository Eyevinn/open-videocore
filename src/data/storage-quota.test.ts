// Unit tests for the storage-quota counter + admission guard (issue #579,
// ADR-020). Covers: reserve/commit/release accounting, the over-cap rejection,
// the concurrent-in-flight race (two reservations that together exceed the cap
// cannot both succeed), no-cap pass-through, and reconciliation overwriting the
// committed total.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  InMemoryStorageQuotaStore,
  StorageQuotaGuard,
  QuotaExceededError,
  storageCapBytesFromEnv
} from './storage-quota.js';

describe('InMemoryStorageQuotaStore', () => {
  it('reserve/commit moves reserved -> consumed with the TRUE size', async () => {
    const store = new InMemoryStorageQuotaStore();
    const r = await store.reserve(100, 1000);
    expect(r.ok).toBe(true);
    expect((await store.read()).reservedBytes).toBe(100);
    await store.commit({ reserved: 100, actual: 80 });
    const c = await store.read();
    expect(c.reservedBytes).toBe(0);
    expect(c.consumedBytes).toBe(80);
  });

  it('release frees a reservation without committing', async () => {
    const store = new InMemoryStorageQuotaStore();
    await store.reserve(100, 1000);
    await store.release(100);
    const c = await store.read();
    expect(c.reservedBytes).toBe(0);
    expect(c.consumedBytes).toBe(0);
  });

  it('rejects a reservation that would exceed the cap (consumed + reserved + req > cap)', async () => {
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 900 });
    const r = await store.reserve(200, 1000);
    expect(r.ok).toBe(false);
    // Counter is unchanged on a rejected reservation.
    expect((await store.read()).reservedBytes).toBe(0);
  });

  it('race: two concurrent reservations that together exceed the cap cannot both pass', async () => {
    // Cap 1000, empty. Two 600-byte reservations: exactly one must win.
    const store = new InMemoryStorageQuotaStore();
    const [a, b] = await Promise.all([store.reserve(600, 1000), store.reserve(600, 1000)]);
    const wins = [a, b].filter((x) => x.ok).length;
    expect(wins).toBe(1);
    expect((await store.read()).reservedBytes).toBe(600);
  });

  it('applyDelta floors consumed at 0 on deletion', async () => {
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 100 });
    await store.applyDelta(-250);
    expect((await store.read()).consumedBytes).toBe(0);
  });

  it('reconcile overwrites the committed total but leaves reservations', async () => {
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 500 });
    await store.reserve(100, undefined);
    await store.reconcile(42);
    const c = await store.read();
    expect(c.consumedBytes).toBe(42);
    expect(c.reservedBytes).toBe(100);
  });
});

describe('StorageQuotaGuard', () => {
  it('admit throws QuotaExceededError (409 / quota_exceeded) when over cap', async () => {
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 900 });
    const guard = new StorageQuotaGuard({ store, capBytes: () => 1000 });
    await expect(guard.admit(200)).rejects.toBeInstanceOf(QuotaExceededError);
    try {
      await guard.admit(200);
    } catch (err) {
      expect((err as QuotaExceededError).statusCode).toBe(409);
      expect((err as QuotaExceededError).reason).toBe('quota_exceeded');
    }
  });

  it('admit under the cap returns a reservation that commits the true size', async () => {
    const store = new InMemoryStorageQuotaStore();
    const guard = new StorageQuotaGuard({ store, capBytes: () => 1000 });
    const reservation = await guard.admit(300);
    await reservation.commit(250);
    expect((await store.read()).consumedBytes).toBe(250);
  });

  it('no cap configured => admit always succeeds (pass-through)', async () => {
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 10_000 });
    const guard = new StorageQuotaGuard({ store, capBytes: () => undefined });
    const reservation = await guard.admit(1_000_000);
    // No rejection even though far over any sane cap.
    await reservation.commit(1_000_000);
    expect((await store.read()).consumedBytes).toBe(1_010_000);
  });

  it('reservation is idempotent: double commit/release is a no-op', async () => {
    const store = new InMemoryStorageQuotaStore();
    const guard = new StorageQuotaGuard({ store, capBytes: () => 1000 });
    const reservation = await guard.admit(100);
    await reservation.commit(100);
    await reservation.commit(100); // no-op
    await reservation.release(); // no-op
    expect((await store.read()).consumedBytes).toBe(100);
  });
});

describe('storageCapBytesFromEnv', () => {
  const SAVED = process.env['STORAGE_CAP_BYTES'];
  beforeEach(() => {
    delete process.env['STORAGE_CAP_BYTES'];
  });
  afterEach(() => {
    if (SAVED === undefined) delete process.env['STORAGE_CAP_BYTES'];
    else process.env['STORAGE_CAP_BYTES'] = SAVED;
  });

  it('undefined when unset (opt-in)', () => {
    expect(storageCapBytesFromEnv()).toBeUndefined();
  });
  it('undefined when 0 or negative or non-numeric', () => {
    process.env['STORAGE_CAP_BYTES'] = '0';
    expect(storageCapBytesFromEnv()).toBeUndefined();
    process.env['STORAGE_CAP_BYTES'] = '-5';
    expect(storageCapBytesFromEnv()).toBeUndefined();
    process.env['STORAGE_CAP_BYTES'] = 'abc';
    expect(storageCapBytesFromEnv()).toBeUndefined();
  });
  it('parses a positive integer', () => {
    process.env['STORAGE_CAP_BYTES'] = '107374182400';
    expect(storageCapBytesFromEnv()).toBe(107374182400);
  });
});
