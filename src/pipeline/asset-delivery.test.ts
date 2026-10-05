// Unit tests for the asset-delivery byte movement + landing verification
// (issue #1131).
//
// Pure/injected: no live object store, no OSC. A fake DeliveryObjectClient
// models the three primitives the real minio client provides
// (node_modules/minio/dist/esm/internal/client.d.mts:207 bucketExists, :239
// statObject, :354 the legacy 4-arg copyObject) so every truthfulness rule can
// be asserted directly:
//   - success ONLY when the object is re-read at the destination with the
//     source's byte count;
//   - a copy that silently writes nothing, or writes a short object, is a
//     failure, NOT a success;
//   - an unreachable destination and a missing source are refused BEFORE any
//     copy is attempted.

import { describe, it, expect, vi } from 'vitest';
import {
  deliverAssetObject,
  deliveredKeyFor,
  deliveryTimeoutMs,
  destinationEndpointRefusal,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  SINGLE_COPY_MAX_BYTES,
  type DeliveryObjectClient
} from './asset-delivery.js';

function notFound(): Error {
  return Object.assign(new Error('Not Found'), { code: 'NotFound' });
}

type CopyRecord = { targetBucket: string; targetKey: string; source: string };

// An in-memory object store. `copyBehaviour` models what the real store can do
// to us: copy normally, fail loudly, "succeed" while writing nothing, or write
// a truncated object.
class FakeStore implements DeliveryObjectClient {
  readonly buckets = new Set<string>();
  readonly objects = new Map<string, number>();
  readonly copies: CopyRecord[] = [];
  copyBehaviour: 'copy' | 'throw' | 'silently-drop' | 'short-write' = 'copy';
  bucketExistsBehaviour: 'real' | 'throw' = 'real';

  put(bucket: string, key: string, size: number): void {
    this.buckets.add(bucket);
    this.objects.set(`${bucket}/${key}`, size);
  }

  async bucketExists(bucketName: string): Promise<boolean> {
    if (this.bucketExistsBehaviour === 'throw') {
      throw new Error('AccessDenied: s3:ListBucket');
    }
    return this.buckets.has(bucketName);
  }

  async statObject(bucketName: string, objectName: string): Promise<{ size: number; etag: string }> {
    const size = this.objects.get(`${bucketName}/${objectName}`);
    if (size === undefined) throw notFound();
    return { size, etag: `etag-${objectName}` };
  }

  async copyObject(
    targetBucketName: string,
    targetObjectName: string,
    sourceBucketNameAndObjectName: string
  ): Promise<unknown> {
    this.copies.push({
      targetBucket: targetBucketName,
      targetKey: targetObjectName,
      source: sourceBucketNameAndObjectName
    });
    if (this.copyBehaviour === 'throw') {
      throw new Error('NoSuchBucket: the specified bucket does not exist');
    }
    if (this.copyBehaviour === 'silently-drop') {
      return {};
    }
    const rel = sourceBucketNameAndObjectName.replace(/^\//, '');
    const size = this.objects.get(rel) ?? 0;
    this.objects.set(
      `${targetBucketName}/${targetObjectName}`,
      this.copyBehaviour === 'short-write' ? Math.floor(size / 2) : size
    );
    return {};
  }
}

function storeWithSource(size = 2048): FakeStore {
  const store = new FakeStore();
  store.put('src-bucket', 'ingest/master.mp4', size);
  store.buckets.add('deliveries');
  return store;
}

describe('deliveredKeyFor', () => {
  it('preserves the source key under the destination prefix', () => {
    expect(deliveredKeyFor('ingest/master.mp4', 'exports/2026-10-05')).toBe(
      'exports/2026-10-05/ingest/master.mp4'
    );
  });

  it('keeps the bare source key when there is no prefix', () => {
    expect(deliveredKeyFor('ingest/master.mp4', '')).toBe('ingest/master.mp4');
  });

  it('normalises a trailing prefix slash and a leading key slash', () => {
    expect(deliveredKeyFor('/ingest/master.mp4', 'exports/')).toBe('exports/ingest/master.mp4');
  });
});

describe('deliverAssetObject — verified success', () => {
  it('copies the object to the chosen destination and reports the VERIFIED coordinates', async () => {
    const store = storeWithSource(4096);
    const outcome = await deliverAssetObject(store, {
      source: { bucket: 'src-bucket', key: 'ingest/master.mp4' },
      target: { bucket: 'deliveries', prefix: '' }
    });

    expect(outcome).toEqual({
      ok: true,
      bucket: 'deliveries',
      objectKey: 'ingest/master.mp4',
      bytes: 4096,
      etag: 'etag-ingest/master.mp4'
    });
    // The bytes really are at the destination, and the copy used the legacy
    // 4-arg source spelling "/<bucket>/<key>".
    expect(store.objects.get('deliveries/ingest/master.mp4')).toBe(4096);
    expect(store.copies).toEqual([
      {
        targetBucket: 'deliveries',
        targetKey: 'ingest/master.mp4',
        source: '/src-bucket/ingest/master.mp4'
      }
    ]);
  });

  it('keys the delivered object under the destination prefix', async () => {
    const store = storeWithSource();
    const outcome = await deliverAssetObject(store, {
      source: { bucket: 'src-bucket', key: 'ingest/master.mp4' },
      target: { bucket: 'deliveries', prefix: '2026-10-05/asset-1' }
    });

    expect(outcome.ok).toBe(true);
    expect(store.objects.has('deliveries/2026-10-05/asset-1/ingest/master.mp4')).toBe(true);
  });
});

describe('deliverAssetObject — a failure is never reported as a success', () => {
  it('refuses when the destination bucket does not exist, without copying', async () => {
    const store = storeWithSource();
    store.buckets.delete('deliveries');

    const outcome = await deliverAssetObject(store, {
      source: { bucket: 'src-bucket', key: 'ingest/master.mp4' },
      target: { bucket: 'deliveries', prefix: '' }
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'destination_unreachable' });
    expect(store.copies).toHaveLength(0);
  });

  it('refuses when the destination probe itself fails (credential/policy error)', async () => {
    const store = storeWithSource();
    store.bucketExistsBehaviour = 'throw';

    const outcome = await deliverAssetObject(store, {
      source: { bucket: 'src-bucket', key: 'ingest/master.mp4' },
      target: { bucket: 'deliveries', prefix: '' }
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'destination_unreachable' });
    expect(store.copies).toHaveLength(0);
  });

  it('refuses when the source object is absent from the source bucket', async () => {
    const store = new FakeStore();
    store.buckets.add('deliveries');

    const outcome = await deliverAssetObject(store, {
      source: { bucket: 'src-bucket', key: 'ingest/master.mp4' },
      target: { bucket: 'deliveries', prefix: '' }
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'source_missing' });
    expect(store.copies).toHaveLength(0);
  });

  it('refuses a source above the single-copy limit before attempting the copy', async () => {
    const store = storeWithSource(SINGLE_COPY_MAX_BYTES + 1);

    const outcome = await deliverAssetObject(store, {
      source: { bucket: 'src-bucket', key: 'ingest/master.mp4' },
      target: { bucket: 'deliveries', prefix: '' }
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'source_too_large' });
    expect(store.copies).toHaveLength(0);
  });

  it('reports a failed copy as copy_failed, carrying the store error', async () => {
    const store = storeWithSource();
    store.copyBehaviour = 'throw';

    const outcome = await deliverAssetObject(store, {
      source: { bucket: 'src-bucket', key: 'ingest/master.mp4' },
      target: { bucket: 'deliveries', prefix: '' }
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('copy_failed');
    expect(outcome.message).toContain('NoSuchBucket');
  });

  it('reports not_landed when the copy call succeeds but nothing is at the destination', async () => {
    const store = storeWithSource();
    store.copyBehaviour = 'silently-drop';

    const outcome = await deliverAssetObject(store, {
      source: { bucket: 'src-bucket', key: 'ingest/master.mp4' },
      target: { bucket: 'deliveries', prefix: '' }
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('not_landed');
    expect(outcome.message).toContain('no object is present');
  });

  it('reports not_landed when the delivered object is short of the source byte count', async () => {
    const store = storeWithSource(1000);
    store.copyBehaviour = 'short-write';

    const outcome = await deliverAssetObject(store, {
      source: { bucket: 'src-bucket', key: 'ingest/master.mp4' },
      target: { bucket: 'deliveries', prefix: '' }
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('not_landed');
    expect(outcome.message).toContain('incomplete');
  });

  it('reports timeout (not success) when the store never settles', async () => {
    const hanging: DeliveryObjectClient = {
      bucketExists: vi.fn(() => new Promise<boolean>(() => {})),
      statObject: vi.fn(async () => ({ size: 1, etag: 'e' })),
      copyObject: vi.fn(async () => ({}))
    };

    const outcome = await deliverAssetObject(hanging, {
      source: { bucket: 'src-bucket', key: 'ingest/master.mp4' },
      target: { bucket: 'deliveries', prefix: '' },
      timeoutMs: 10
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'timeout' });
    expect(hanging.copyObject).not.toHaveBeenCalled();
  });
});

describe('deliveryTimeoutMs', () => {
  it('defaults when unset and honours a positive override', () => {
    const previous = process.env['DELIVERY_TIMEOUT_MS'];
    try {
      delete process.env['DELIVERY_TIMEOUT_MS'];
      expect(deliveryTimeoutMs()).toBe(DEFAULT_DELIVERY_TIMEOUT_MS);
      process.env['DELIVERY_TIMEOUT_MS'] = '5000';
      expect(deliveryTimeoutMs()).toBe(5000);
      process.env['DELIVERY_TIMEOUT_MS'] = 'not-a-number';
      expect(deliveryTimeoutMs()).toBe(DEFAULT_DELIVERY_TIMEOUT_MS);
      process.env['DELIVERY_TIMEOUT_MS'] = '-1';
      expect(deliveryTimeoutMs()).toBe(DEFAULT_DELIVERY_TIMEOUT_MS);
    } finally {
      if (previous === undefined) delete process.env['DELIVERY_TIMEOUT_MS'];
      else process.env['DELIVERY_TIMEOUT_MS'] = previous;
    }
  });
});

describe('destinationEndpointRefusal', () => {
  it('allows a destination that makes no endpoint claim', () => {
    expect(destinationEndpointRefusal(undefined, 'https://minio.example:9000')).toBeUndefined();
  });

  it('allows a destination registered at the same endpoint the client is credentialed for', () => {
    expect(
      destinationEndpointRefusal('https://minio.example:9000/', 'https://minio.example:9000')
    ).toBeUndefined();
    // Scheme and trailing path differences do not change the authority.
    expect(
      destinationEndpointRefusal('http://minio.example:9000', 'https://minio.example:9000')
    ).toBeUndefined();
    // A bare host:port endpoint (env override form) still compares.
    expect(destinationEndpointRefusal('https://minio.example', 'minio.example')).toBeUndefined();
  });

  it('refuses a destination registered at a different endpoint', () => {
    const refusal = destinationEndpointRefusal(
      'https://s3.partner.example',
      'https://minio.example:9000'
    );
    expect(refusal).toContain('s3.partner.example');
    expect(refusal).toContain('write-only');
  });

  it('refuses a claimed endpoint when our own endpoint is unknown (nothing to compare)', () => {
    expect(destinationEndpointRefusal('https://s3.partner.example', undefined)).toBeDefined();
  });
});
