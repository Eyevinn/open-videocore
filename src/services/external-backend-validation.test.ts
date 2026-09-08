// Unit tests for registration-time reachability + permission validation
// (issue #550). Uses an injected BucketProbeClient factory so no live bucket is
// touched — mirrors the injected-fetch pattern in profiles-reachability.test.ts.
//
// Invariants under test:
//   - a bad endpoint / bad credentials / missing bucket / denied permission
//     each surface a distinct machine-readable reason;
//   - the probe is REVERSIBLE: the probe object it writes is always removed;
//   - the secret is NEVER present in any result message, reason, or code.

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  validateExternalBackend,
  type BucketProbeClient,
  type ExternalBackendProbeTarget
} from './external-backend-validation.js';

const SECRET = 'super-secret-key-value-do-not-leak';

const target: ExternalBackendProbeTarget = {
  bucket: 'my-bucket',
  accessKeyId: 'AKIA',
  secretAccessKey: SECRET,
  endpointUrl: 'https://s3.example.com',
  region: 'us-east-1'
};

// A configurable in-memory probe client. Each op can be told to succeed, throw
// an S3-style error (with a `.code`), or (for list) emit data/end/error.
type Behaviour = {
  bucketExists?: () => Promise<boolean>;
  list?: () => Readable;
  putObject?: () => Promise<unknown>;
  statObject?: () => Promise<unknown>;
  removeObject?: () => Promise<void>;
};

function s3Error(code: string): Error & { code: string } {
  const err = new Error(`s3 error: ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

function okListStream(): Readable {
  const s = new Readable({ read() {} });
  queueMicrotask(() => s.emit('end'));
  return s;
}

function errListStream(code: string): Readable {
  const s = new Readable({ read() {} });
  queueMicrotask(() => s.emit('error', s3Error(code)));
  return s;
}

function makeClient(b: Behaviour): { client: BucketProbeClient; removed: string[] } {
  const removed: string[] = [];
  const client: BucketProbeClient = {
    bucketExists: b.bucketExists ?? (async () => true),
    listObjectsV2: b.list ?? (() => okListStream()),
    putObject: b.putObject ?? (async () => ({})),
    statObject: b.statObject ?? (async () => ({})),
    removeObject:
      b.removeObject ??
      (async (_bkt: string, key: string) => {
        removed.push(key);
      })
  };
  return { client, removed };
}

describe('validateExternalBackend — success', () => {
  it('confirms reachable + list + write + read and reverses the write probe', async () => {
    const { client, removed } = makeClient({});
    const result = await validateExternalBackend(target, { probeClientFactory: () => client });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks).toEqual({ reachable: true, list: true, write: true, read: true });
    }
    // Reversible: exactly one probe object was written and then removed.
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain('.openvideocore-registration-probe/');
  });
});

describe('validateExternalBackend — machine-readable failures', () => {
  it('reports "unreachable" on a transport/connection error', async () => {
    const { client } = makeClient({
      bucketExists: async () => {
        throw s3Error('ENOTFOUND');
      }
    });
    const result = await validateExternalBackend(target, { probeClientFactory: () => client });
    expect(result).toMatchObject({ ok: false, reason: 'unreachable', code: 'ENOTFOUND' });
  });

  it('reports "unauthorized" when credentials are rejected', async () => {
    const { client } = makeClient({
      bucketExists: async () => {
        throw s3Error('InvalidAccessKeyId');
      }
    });
    const result = await validateExternalBackend(target, { probeClientFactory: () => client });
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized', code: 'InvalidAccessKeyId' });
  });

  it('reports "bucket_not_found" when the bucket does not exist', async () => {
    const { client } = makeClient({ bucketExists: async () => false });
    const result = await validateExternalBackend(target, { probeClientFactory: () => client });
    expect(result).toMatchObject({ ok: false, reason: 'bucket_not_found' });
  });

  it('reports "forbidden_list" when list is denied', async () => {
    const { client } = makeClient({ list: () => errListStream('AccessDenied') });
    const result = await validateExternalBackend(target, { probeClientFactory: () => client });
    expect(result).toMatchObject({ ok: false, reason: 'forbidden_list', code: 'AccessDenied' });
  });

  it('reports "forbidden_write" when put is denied', async () => {
    const { client } = makeClient({
      putObject: async () => {
        throw s3Error('AccessDenied');
      }
    });
    const result = await validateExternalBackend(target, { probeClientFactory: () => client });
    expect(result).toMatchObject({ ok: false, reason: 'forbidden_write', code: 'AccessDenied' });
  });

  it('reports "forbidden_read" when stat is denied, but STILL reverses the write', async () => {
    const { client, removed } = makeClient({
      statObject: async () => {
        throw s3Error('AccessDenied');
      }
    });
    const result = await validateExternalBackend(target, { probeClientFactory: () => client });
    expect(result).toMatchObject({ ok: false, reason: 'forbidden_read', code: 'AccessDenied' });
    // The write probe is reversed even when the read probe fails.
    expect(removed).toHaveLength(1);
  });

  it('reports "probe_cleanup_failed" when the probe object cannot be removed', async () => {
    const { client } = makeClient({
      removeObject: async () => {
        throw s3Error('AccessDenied');
      }
    });
    const result = await validateExternalBackend(target, { probeClientFactory: () => client });
    expect(result).toMatchObject({ ok: false, reason: 'probe_cleanup_failed' });
  });

  it('reports "unreachable" when the endpoint URL is malformed', async () => {
    const bad: ExternalBackendProbeTarget = { ...target, endpointUrl: 'not a url' };
    const result = await validateExternalBackend(bad);
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
  });
});

describe('validateExternalBackend — secret hygiene', () => {
  it('never includes the secret in any failure output', async () => {
    const { client } = makeClient({
      bucketExists: async () => {
        throw s3Error('SignatureDoesNotMatch');
      }
    });
    const result = await validateExternalBackend(target, { probeClientFactory: () => client });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
  });

  it('never includes the secret on the success path', async () => {
    const { client } = makeClient({});
    const result = await validateExternalBackend(target, { probeClientFactory: () => client });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('probe client factory receives the secret but callers never do', async () => {
    const factory = vi.fn(() => makeClient({}).client);
    await validateExternalBackend(target, { probeClientFactory: factory });
    // The factory is the ONLY place the secret is used.
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ secretAccessKey: SECRET }));
  });
});
