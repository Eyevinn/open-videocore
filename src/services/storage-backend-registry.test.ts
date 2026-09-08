// Unit tests for the storage-backend registry service (issue #547, ADR-017).
//
// Focuses on the persistence-split invariants the router relies on:
//   - the NON-SECRET record persisted to the record store NEVER carries the
//     secret access key or session token (ADR-017 D1.3 / C4);
//   - the secret material is fanned out to OSC per-serviceId secrets by role
//     (ADR-017 D1.1 / D4);
//   - the ParamStore-backed record store refuses a record that carries a secret
//     (defence-in-depth mirroring assertNoCredentials, param-store.ts:165-204);
//   - the OSC-managed default is non-deletable (ADR-017 D3).

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  StorageBackendRegistry,
  InMemoryBackendRecordStore,
  ParamStoreBackendRecordStore,
  BackendValidationError,
  DefaultBackendNotDeletableError,
  DEFAULT_BACKEND_ID,
  backendRecordKey,
  type SecretStore,
  type StorageBackendRecord
} from './storage-backend-registry.js';
import type { BucketProbeClient } from './external-backend-validation.js';
import type { ConfigKvStore } from './param-store.js';

const RAW_SECRET = 'raw-secret-value';
const RAW_TOKEN = 'raw-token-value';

function spySecretStore() {
  const saveSecret = vi.fn(
    async (_serviceId: string, _name: string, _value: string) => {}
  );
  const store: SecretStore = { saveSecret };
  return { store, saveSecret };
}

describe('StorageBackendRegistry.register — persistence split', () => {
  it('persists a record with NO secret fields', async () => {
    const records = new InMemoryBackendRecordStore();
    const { store } = spySecretStore();
    const registry = new StorageBackendRegistry(records, store);

    await registry.register('ws1', {
      name: 'b',
      role: 'both',
      bucket: 'bkt',
      accessKeyId: 'AKIA',
      secretAccessKey: RAW_SECRET,
      sessionToken: RAW_TOKEN
    });

    const stored = await records.list('ws1');
    expect(stored).toHaveLength(1);
    const asJson = JSON.stringify(stored[0]);
    // The record carries the NON-SECRET access key id but NEVER the secret/token.
    expect(stored[0].accessKeyId).toBe('AKIA');
    expect(asJson).not.toContain(RAW_SECRET);
    expect(asJson).not.toContain(RAW_TOKEN);
    expect(stored[0]).not.toHaveProperty('secretAccessKey');
    expect(stored[0]).not.toHaveProperty('sessionToken');
    expect(stored[0].hasSessionToken).toBe(true);
  });

  it('fans secrets out per role (source -> encore + ffmpeg-s3; packaged -> packager)', async () => {
    const { store, saveSecret } = spySecretStore();
    const registry = new StorageBackendRegistry(new InMemoryBackendRecordStore(), store);

    await registry.register('ws1', {
      name: 'b',
      role: 'both',
      bucket: 'bkt',
      accessKeyId: 'AKIA',
      secretAccessKey: RAW_SECRET
    });

    const serviceIds = new Set(saveSecret.mock.calls.map((c) => c[0]));
    expect(serviceIds).toEqual(new Set(['encore', 'eyevinn-ffmpeg-s3', 'eyevinn-encore-packager']));
    // Every saved value is the literal secret (no token registered here).
    expect(saveSecret.mock.calls.every((c) => c[2] === RAW_SECRET)).toBe(true);
  });

  it('does not call saveSecret when no SecretStore is wired', async () => {
    const registry = new StorageBackendRegistry(new InMemoryBackendRecordStore());
    expect(registry.canStoreSecrets).toBe(false);
    // Still persists the non-secret record without throwing.
    const view = await registry.register('ws1', {
      name: 'b',
      role: 'source',
      bucket: 'bkt',
      accessKeyId: 'AKIA',
      secretAccessKey: RAW_SECRET
    });
    expect(view.credentials.secretAccessKey).toBe('***redacted***');
  });
});

describe('StorageBackendRegistry.register — validation (issue #550)', () => {
  function okProbeClient(): BucketProbeClient {
    return {
      bucketExists: async () => true,
      listObjectsV2: () => {
        const s = new Readable({ read() {} });
        queueMicrotask(() => s.emit('end'));
        return s;
      },
      putObject: async () => ({}),
      statObject: async () => ({}),
      removeObject: async () => {}
    };
  }

  function unreachableProbeClient(): BucketProbeClient {
    return {
      ...okProbeClient(),
      bucketExists: async () => {
        const err = new Error('boom') as Error & { code: string };
        err.code = 'ECONNREFUSED';
        throw err;
      }
    };
  }

  it('does NOT validate by default (no validate option)', async () => {
    const records = new InMemoryBackendRecordStore();
    const { store } = spySecretStore();
    const registry = new StorageBackendRegistry(records, store);
    expect(registry.validatesOnRegister).toBe(false);
    // Registers without any probe even though no factory is supplied.
    await registry.register('ws1', {
      name: 'b',
      role: 'both',
      bucket: 'bkt',
      accessKeyId: 'AKIA',
      secretAccessKey: RAW_SECRET
    });
    expect(await records.list('ws1')).toHaveLength(1);
  });

  it('validates and registers when the probe passes', async () => {
    const records = new InMemoryBackendRecordStore();
    const { store } = spySecretStore();
    const registry = new StorageBackendRegistry(records, store, {
      probeClientFactory: () => okProbeClient()
    });
    expect(registry.validatesOnRegister).toBe(true);
    const view = await registry.register('ws1', {
      name: 'b',
      role: 'both',
      bucket: 'bkt',
      accessKeyId: 'AKIA',
      secretAccessKey: RAW_SECRET
    });
    expect(view.credentials.secretAccessKey).toBe('***redacted***');
    expect(await records.list('ws1')).toHaveLength(1);
  });

  it('throws BackendValidationError and persists NOTHING when the probe fails', async () => {
    const records = new InMemoryBackendRecordStore();
    const { store, saveSecret } = spySecretStore();
    const registry = new StorageBackendRegistry(records, store, {
      probeClientFactory: () => unreachableProbeClient()
    });
    await expect(
      registry.register('ws1', {
        name: 'b',
        role: 'both',
        bucket: 'bkt',
        accessKeyId: 'AKIA',
        secretAccessKey: RAW_SECRET
      })
    ).rejects.toBeInstanceOf(BackendValidationError);
    // Not silently registered: no record persisted, no secret fanned out.
    expect(await records.list('ws1')).toHaveLength(0);
    expect(saveSecret).not.toHaveBeenCalled();
  });

  it('BackendValidationError carries a machine-readable reason and no secret', async () => {
    const registry = new StorageBackendRegistry(new InMemoryBackendRecordStore(), spySecretStore().store, {
      probeClientFactory: () => unreachableProbeClient()
    });
    try {
      await registry.register('ws1', {
        name: 'b',
        role: 'both',
        bucket: 'bkt',
        accessKeyId: 'AKIA',
        secretAccessKey: RAW_SECRET
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BackendValidationError);
      const e = err as BackendValidationError;
      expect(e.reason).toBe('unreachable');
      expect(JSON.stringify({ m: e.message, c: e.code })).not.toContain(RAW_SECRET);
    }
  });

  it('explicit { enabled: false } opts out of validation', async () => {
    const records = new InMemoryBackendRecordStore();
    const registry = new StorageBackendRegistry(records, spySecretStore().store, {
      enabled: false,
      probeClientFactory: () => unreachableProbeClient()
    });
    expect(registry.validatesOnRegister).toBe(false);
    await registry.register('ws1', {
      name: 'b',
      role: 'both',
      bucket: 'bkt',
      accessKeyId: 'AKIA',
      secretAccessKey: RAW_SECRET
    });
    expect(await records.list('ws1')).toHaveLength(1);
  });
});

describe('StorageBackendRegistry.remove — default protection', () => {
  it('throws DefaultBackendNotDeletableError for the default id', async () => {
    const registry = new StorageBackendRegistry(new InMemoryBackendRecordStore());
    await expect(registry.remove('ws1', DEFAULT_BACKEND_ID)).rejects.toBeInstanceOf(
      DefaultBackendNotDeletableError
    );
  });
});

describe('ParamStoreBackendRecordStore — non-secret store discipline', () => {
  function memKv(): ConfigKvStore & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
      store,
      async set(key, value) {
        store.set(key, value);
      },
      async get(key) {
        return store.get(key);
      },
      async delete(key) {
        store.delete(key);
      },
      async listByPrefix(prefix) {
        return [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value }));
      }
    };
  }

  it('round-trips a non-secret record through the config KV store', async () => {
    const kv = memKv();
    const recStore = new ParamStoreBackendRecordStore(kv);
    const record: StorageBackendRecord = {
      id: 'abc',
      name: 'b',
      role: 'source',
      backend: 'external',
      bucket: 'bkt',
      accessKeyId: 'AKIA',
      hasSessionToken: false,
      createdAt: '2026-09-04T00:00:00.000Z'
    };
    await recStore.put('ws1', record);
    // Persisted under the namespaced key…
    expect(kv.store.has(backendRecordKey('ws1', 'abc'))).toBe(true);
    // …and reads back identically.
    expect(await recStore.get('ws1', 'abc')).toEqual(record);
    expect(await recStore.list('ws1')).toEqual([record]);
    await recStore.delete('ws1', 'abc');
    expect(await recStore.get('ws1', 'abc')).toBeUndefined();
  });

  it('refuses to persist a record that carries a secret field', async () => {
    const recStore = new ParamStoreBackendRecordStore(memKv());
    const leaky = {
      id: 'abc',
      name: 'b',
      role: 'source',
      backend: 'external',
      bucket: 'bkt',
      accessKeyId: 'AKIA',
      hasSessionToken: false,
      createdAt: '2026-09-04T00:00:00.000Z',
      secretAccessKey: RAW_SECRET
    } as unknown as StorageBackendRecord;
    await expect(recStore.put('ws1', leaky)).rejects.toThrow(/secret field/i);
  });
});
