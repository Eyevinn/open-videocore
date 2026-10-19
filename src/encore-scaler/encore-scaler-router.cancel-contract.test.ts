// #1232: the scaler facade's remote cancel leg must speak the verified
// transcoder cancel contract, with the id the transcoder assigned.
//
// Before this fix the facade proxied `DELETE {instanceUrl}/encoreJobs/{externalId}`
// — wrong method, wrong path, and our own correlation id rather than the id the
// transcoder assigned — so against a real instance the remote leg was a silent
// no-op while the caller was told `200 {status:'CANCELLED'}` and the job kept
// transcoding.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - Cancel shape: upstream transcoder controller `EncoreController.kt`
//     (github.com/svt/encore,
//     encore-web/src/main/kotlin/se/svt/oss/encore/controller/EncoreController.kt) —
//     `@PostMapping("/{jobId}/cancel") fun cancel(@PathVariable jobId: UUID, ...)`:
//     POST, no request body, 404 when the job does not exist, and 409 only when
//     the job's status is not cancellable (the handler cancels NEW/QUEUED/
//     IN_PROGRESS and throws CONFLICT for every other status). Hence 404/409
//     both mean "nothing left to cancel" and are idempotent no-ops. The same
//     shape is implemented by `EncoreClient.cancel`, src/pipeline/encore-client.ts,
//     which returns early on 404/409 — so a refusal this facade raises itself
//     must use a status outside that window (see the unknown-id test below).
//   - Transcoder-assigned id lookup: `keys.jobUuid(encoreJobId)` (a plain string
//     key, `redis.get`), src/encore-scaler/types.ts, written at dispatch time in
//     src/encore-scaler/scaler-loop.ts and read the same way by
//     makeScalingEncoreClient().cancel (src/encore-scaler/index.ts).
//   - Valkey key schema keys.pool / keys.jobInstance / keys.jobStatus and the
//     pool record `{ url }` shape: src/encore-scaler/types.ts.

import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';

import { encoreScalerRouter } from './encore-scaler-router.js';
import { keys } from './types.js';

// Minimal in-memory stand-in for the subset of ioredis the DELETE handler uses:
// list ops, hash ops, and the plain string `get` used for keys.jobUuid.
class FakeRedis {
  private lists = new Map<string, string[]>();
  private hashes = new Map<string, Map<string, string>>();
  private strings = new Map<string, string>();

  private list(key: string): string[] {
    let l = this.lists.get(key);
    if (!l) {
      l = [];
      this.lists.set(key, l);
    }
    return l;
  }

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }

  async lpush(key: string, value: string): Promise<number> {
    const l = this.list(key);
    l.unshift(value);
    return l.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.list(key);
    if (start === 0 && stop === -1) return [...l];
    const end = stop < 0 ? l.length + stop + 1 : stop + 1;
    return l.slice(start, end);
  }

  async lrem(key: string, count: number, value: string): Promise<number> {
    if (count !== 0) throw new Error(`FakeRedis.lrem only models count 0, got ${count}`);
    const l = this.list(key);
    const before = l.length;
    const kept = l.filter((v) => v !== value);
    this.lists.set(key, kept);
    return before - kept.length;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hash(key).get(field) ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    this.hash(key).set(field, value);
    return 1;
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }
}

const WS = 'ws1';
const EXTERNAL_ID = 'ws1:job-42';
const TRANSCODER_JOB_ID = '2b1f9f0e-0000-4a1b-9f3a-cafebabe1234';
const INSTANCE_ID = 'inst-a';
const INSTANCE_URL = 'https://instance-a.example.osc/';

async function buildApp(redis: FakeRedis): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(encoreScalerRouter, {
    redis: redis as unknown as Redis,
    workspaceId: WS,
    getToken: async () => 'test-token'
  });
  await app.ready();
  return app;
}

// Seed a job that has been dispatched to a pooled instance.
async function seedDispatched(redis: FakeRedis, opts: { withTranscoderId: boolean }) {
  await redis.hset(keys.jobInstance(WS), EXTERNAL_ID, INSTANCE_ID);
  await redis.hset(keys.pool(WS), INSTANCE_ID, JSON.stringify({ url: INSTANCE_URL }));
  await redis.hset(keys.jobStatus(WS), EXTERNAL_ID, 'RUNNING');
  if (opts.withTranscoderId) {
    await redis.set(keys.jobUuid(EXTERNAL_ID), TRANSCODER_JOB_ID);
  }
}

describe('#1232 scaler facade cancel speaks the verified transcoder contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs {instanceUrl}/encoreJobs/{transcoderJobId}/cancel with no body', async () => {
    const redis = new FakeRedis();
    await seedDispatched(redis, { withTranscoderId: true });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response('', { status: 200 });
      })
    );

    const app = await buildApp(redis);
    try {
      const res = await app.inject({ method: 'DELETE', url: `/encoreJobs/${EXTERNAL_ID}` });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: EXTERNAL_ID, status: 'CANCELLED' });

      // Exactly one outbound call, pinned to the verified contract.
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        `https://instance-a.example.osc/encoreJobs/${TRANSCODER_JOB_ID}/cancel`
      );
      expect(calls[0].init?.method).toBe('POST');
      // No body: the contract's cancel takes none.
      expect(calls[0].init?.body).toBeUndefined();
      // Our own correlation id must NOT appear in the cancel URL.
      expect(calls[0].url).not.toContain(encodeURIComponent(EXTERNAL_ID));

      expect(await redis.hget(keys.jobStatus(WS), EXTERNAL_ID)).toBe('CANCELLED');
    } finally {
      await app.close();
    }
  });

  it('treats 404/409 from the instance as an idempotent no-op (already terminal)', async () => {
    for (const status of [404, 409]) {
      const redis = new FakeRedis();
      await seedDispatched(redis, { withTranscoderId: true });
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));

      const app = await buildApp(redis);
      try {
        const res = await app.inject({ method: 'DELETE', url: `/encoreJobs/${EXTERNAL_ID}` });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ id: EXTERNAL_ID, status: 'CANCELLED' });
        expect(await redis.hget(keys.jobStatus(WS), EXTERNAL_ID)).toBe('CANCELLED');
      } finally {
        await app.close();
      }
    }
  });

  it('does not report CANCELLED when the instance rejects the cancel', async () => {
    const redis = new FakeRedis();
    await seedDispatched(redis, { withTranscoderId: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    const app = await buildApp(redis);
    try {
      const res = await app.inject({ method: 'DELETE', url: `/encoreJobs/${EXTERNAL_ID}` });
      expect(res.statusCode).toBe(502);
      const body = res.json() as { id: string; status: string };
      expect(body.status).toBe('CANCEL_FAILED');
      // The job is still running on the instance, so local state must not lie.
      expect(await redis.hget(keys.jobStatus(WS), EXTERNAL_ID)).toBe('RUNNING');
    } finally {
      await app.close();
    }
  });

  it('refuses to claim CANCELLED when the transcoder-assigned id is unknown', async () => {
    const redis = new FakeRedis();
    await seedDispatched(redis, { withTranscoderId: false });
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const app = await buildApp(redis);
    try {
      const res = await app.inject({ method: 'DELETE', url: `/encoreJobs/${EXTERNAL_ID}` });

      // The refusal must NOT reuse 404/409: those are the contract's
      // "already terminal / nothing to cancel" no-op statuses, and
      // `EncoreClient.cancel` (src/pipeline/encore-client.ts) returns early on
      // them — so a client pointed at this facade would read an unforwarded
      // cancel as a successful one while the job is still transcoding.
      expect(res.statusCode).not.toBe(404);
      expect(res.statusCode).not.toBe(409);
      expect(res.statusCode).toBe(503);
      const body = res.json() as { id: string; status: string; error: string };
      expect(body.status).toBe('CANCEL_NOT_HONOURED');
      expect(body.error).toMatch(/transcoder-assigned job id/i);

      // No cancel we cannot address is attempted, and local state is untouched.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await redis.hget(keys.jobStatus(WS), EXTERNAL_ID)).toBe('RUNNING');
    } finally {
      await app.close();
    }
  });
});
