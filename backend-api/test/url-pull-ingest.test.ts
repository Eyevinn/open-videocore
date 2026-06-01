// URL-pull ingest tests (issue #5).
//
// Exercises POST /api/v1/assets/ingest-url + GET /api/v1/jobs/:id end to end
// against in-memory repositories and a fake MinIO/storage layer. The pull
// worker runs in-process; tests inject a fake fetch, a fake S3 reader, and a
// no-wait sleep so retry/backoff paths run instantly.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = { 'token-a': 'workspace-a', 'token-b': 'workspace-b' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { jobsRouter } from '../src/routes/jobs.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { SourceTooLargeError } from '../src/data/storage.js';
import type { OpenedSource } from '../src/pipeline/source.js';
import type { PullDeps } from '../src/pipeline/url-pull-worker.js';

const A = { authorization: 'Bearer token-a' };

// A fake WorkspaceStorage that records what it stored and enforces maxBytes the
// same way the real putStream does, so the size-limit path is exercised without
// MinIO.
class FakeStorage {
  stored: { key: string; bytes: number } | undefined;
  constructor(private readonly fail?: Error) {}
  async putStream(
    key: string,
    source: Readable,
    opts: { maxBytes: number; totalBytes?: number; onProgress?: (b: number, t?: number) => void }
  ): Promise<{ etag: string; bytesTransferred: number }> {
    if (this.fail) throw this.fail;
    let transferred = 0;
    for await (const chunk of source) {
      transferred += (chunk as Buffer).length;
      if (transferred > opts.maxBytes) {
        throw new SourceTooLargeError(opts.maxBytes);
      }
      opts.onProgress?.(transferred, opts.totalBytes);
    }
    this.stored = { key, bytes: transferred };
    return { etag: 'etag-1', bytesTransferred: transferred };
  }
}

function httpResponse(body: Buffer, totalBytes?: number): OpenedSource {
  return {
    stream: Readable.from([body]),
    totalBytes
  };
}

type Harness = {
  app: FastifyInstance;
  jobs: InMemoryJobRepository;
  assets: InMemoryAssetRepository;
  storage: FakeStorage;
};

async function buildApp(opts: {
  storage?: FakeStorage;
  pullDeps?: PullDeps;
  storageFor?: boolean;
}): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const jobs = new InMemoryJobRepository();
  const assets = new InMemoryAssetRepository();
  const storage = opts.storage ?? new FakeStorage();

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: jobs,
    storageFor: opts.storageFor === false ? undefined : () => storage as never,
    pullDeps: { sleep: async () => {}, baseBackoffMs: 0, ...opts.pullDeps }
  });
  await app.register(jobsRouter, { prefix: '/api/v1/jobs', repository: jobs });
  await app.ready();
  return { app, jobs, assets, storage };
}

// Poll a job until it reaches a terminal state (worker runs detached).
async function waitForJob(
  app: FastifyInstance,
  jobId: string,
  timeoutMs = 2000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers: A });
    const body = res.json();
    if (body.status === 'done' || body.status === 'failed') return body;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not reach terminal state in time');
}

describe('URL-pull ingest (issue #5)', () => {
  describe('happy path — HTTP source', () => {
    it('creates asset + job, streams to storage, and advances asset to processing', async () => {
      const payload = Buffer.from('hello-video-bytes');
      const fetch = vi.fn(async () =>
        new Response(payload, { headers: { 'content-length': String(payload.length) } })
      ) as unknown as typeof globalThis.fetch;

      const { app, assets } = await buildApp({ pullDeps: { fetch } });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/ingest-url',
        headers: A,
        payload: { sourceUrl: 'https://example.com/clip.mp4', name: 'clip' }
      });
      expect(res.statusCode).toBe(202);
      const { assetId, jobId } = res.json();
      expect(assetId).toBeTruthy();
      expect(jobId).toBeTruthy();

      const job = await waitForJob(app, jobId);
      expect(job.status).toBe('done');
      expect(job.progress).toBe(100);
      expect(job.bytesTransferred).toBe(payload.length);

      const asset = await assets.get('workspace-a', assetId as string);
      expect(asset?.status).toBe('processing');
      expect(asset?.objectKey).toBe(`ingest/${assetId}`);
    });
  });

  describe('S3 source', () => {
    it('pulls via the injected S3 reader', async () => {
      const payload = Buffer.from('s3-object-bytes');
      const openS3 = vi.fn(
        async (): Promise<OpenedSource> => httpResponse(payload, payload.length)
      );
      const { app } = await buildApp({ pullDeps: { openS3 } });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/ingest-url',
        headers: A,
        payload: { sourceUrl: 's3://my-bucket/path/to/object.mp4' }
      });
      expect(res.statusCode).toBe(202);
      const job = await waitForJob(app, res.json().jobId);
      expect(job.status).toBe('done');
      expect(openS3).toHaveBeenCalledOnce();
    });
  });

  describe('size limit', () => {
    it('fails the job and moves the asset to failed when the source exceeds the cap', async () => {
      const big = Buffer.alloc(2048);
      const fetch = vi.fn(async () => new Response(big)) as unknown as typeof globalThis.fetch;
      const { app, assets } = await buildApp({
        pullDeps: { fetch, maxBytes: 1024 }
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/ingest-url',
        headers: A,
        payload: { sourceUrl: 'https://example.com/huge.mp4' }
      });
      expect(res.statusCode).toBe(202);
      const job = await waitForJob(app, res.json().jobId);
      expect(job.status).toBe('failed');
      expect(String(job.error)).toContain('maximum allowed size');
      // Size errors are permanent — exactly one attempt.
      expect(job.attempts).toBe(1);
      const asset = await assets.get('workspace-a', res.json().assetId);
      expect(asset?.status).toBe('failed');
    });
  });

  describe('retry on transient failure', () => {
    it('retries up to 3 attempts with backoff then succeeds', async () => {
      const payload = Buffer.from('eventually-ok');
      let calls = 0;
      const fetch = vi.fn(async () => {
        calls++;
        if (calls < 3) throw new Error('ECONNRESET');
        return new Response(payload, {
          headers: { 'content-length': String(payload.length) }
        });
      }) as unknown as typeof globalThis.fetch;

      const { app } = await buildApp({ pullDeps: { fetch } });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/ingest-url',
        headers: A,
        payload: { sourceUrl: 'https://example.com/clip.mp4' }
      });
      const job = await waitForJob(app, res.json().jobId);
      expect(job.status).toBe('done');
      expect(calls).toBe(3);
      expect(job.attempts).toBe(3);
    });

    it('records the error after exhausting all attempts', async () => {
      const fetch = vi.fn(async () => {
        throw new Error('persistent network failure');
      }) as unknown as typeof globalThis.fetch;
      const { app, assets } = await buildApp({ pullDeps: { fetch } });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/ingest-url',
        headers: A,
        payload: { sourceUrl: 'https://example.com/clip.mp4' }
      });
      const job = await waitForJob(app, res.json().jobId);
      expect(job.status).toBe('failed');
      expect(String(job.error)).toContain('persistent network failure');
      expect(job.attempts).toBe(3);
      const asset = await assets.get('workspace-a', res.json().assetId);
      expect(asset?.status).toBe('failed');
    });
  });

  describe('input + SSRF validation', () => {
    it('rejects an unsupported scheme with 400', async () => {
      const { app } = await buildApp({});
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/ingest-url',
        headers: A,
        payload: { sourceUrl: 'ftp://example.com/clip.mp4' }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_source');
    });

    it('rejects a private/internal host with 400 (SSRF guard)', async () => {
      const { app } = await buildApp({});
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/ingest-url',
        headers: A,
        payload: { sourceUrl: 'http://169.254.169.254/latest/meta-data/' }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_source');
    });

    it('returns 501 when storage is not configured', async () => {
      const { app } = await buildApp({ storageFor: false });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/ingest-url',
        headers: A,
        payload: { sourceUrl: 'https://example.com/clip.mp4' }
      });
      expect(res.statusCode).toBe(501);
    });
  });

  describe('job workspace scoping', () => {
    it('does not expose a job to another workspace (404)', async () => {
      const payload = Buffer.from('x');
      const fetch = vi.fn(async () =>
        new Response(payload, { headers: { 'content-length': '1' } })
      ) as unknown as typeof globalThis.fetch;
      const { app } = await buildApp({ pullDeps: { fetch } });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/ingest-url',
        headers: A,
        payload: { sourceUrl: 'https://example.com/clip.mp4' }
      });
      const cross = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${res.json().jobId}`,
        headers: { authorization: 'Bearer token-b' }
      });
      expect(cross.statusCode).toBe(404);
    });
  });
});
