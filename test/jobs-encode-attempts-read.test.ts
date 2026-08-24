// Job read-API encode-attempt surfacing (issue #382).
//
// Verifies that GET /api/v1/jobs/:id and GET /api/v1/jobs expose the durable
// encode-attempt fields captured by #380 (ADR-012), so a Media Developer can
// attribute elapsed time to the successful attempt alone:
//   1. a transcode job with an attempt log returns encodeAttempts +
//      encodeAttemptLog (index/startedAt/endedAt/classification) on the wire,
//      and the last entry yields elapsed-time-excluding-retries.
//   2. a never-retried transcode job reports exactly one attempt.
//   3. an ingest job (no encode attempts) omits both fields and keeps its
//      ingest-only `attempts` field intact.
//
// Uses the in-memory job repo + the same Zod serializer the production stack
// wires, so a shape that the wire schema would strip is caught here.

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { jobsRouter } from '../src/routes/jobs.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';

type Harness = {
  app: FastifyInstance;
  jobs: InMemoryJobRepository;
};

async function buildApp(): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const jobs = new InMemoryJobRepository();

  app.decorateRequest('connections', null);
  app.addHook('preHandler', async (request) => {
    (request as unknown as { connections: unknown }).connections = { encore: undefined };
  });

  await app.register(jobsRouter, { prefix: '/api/v1/jobs', repository: jobs });
  await app.ready();
  return { app, jobs };
}

describe('job read API surfaces encode attempts (issue #382)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildApp();
  });

  it('returns encodeAttempts + per-attempt log; last entry gives elapsed-excluding-retries', async () => {
    const job = await h.jobs.create({ type: 'transcode', assetId: 'asset-1' });
    // A transport-class retry then a successful attempt.
    await h.jobs.appendEncodeAttempt(job.id, {
      startedAt: '2026-08-24T10:00:00.000Z',
      endedAt: '2026-08-24T10:00:35.000Z',
      classification: 'transport'
    });
    await h.jobs.appendEncodeAttempt(job.id, {
      startedAt: '2026-08-24T10:01:00.000Z',
      endedAt: '2026-08-24T10:05:00.000Z'
    });

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.encodeAttempts).toBe(2);
    expect(body.encodeAttemptLog).toHaveLength(2);
    expect(body.encodeAttemptLog[0]).toMatchObject({
      index: 1,
      startedAt: '2026-08-24T10:00:00.000Z',
      endedAt: '2026-08-24T10:00:35.000Z',
      classification: 'transport'
    });
    // Successful (last) attempt carries no classification.
    expect(body.encodeAttemptLog[1].classification).toBeUndefined();

    // The single documented read (ADR-012): elapsed excluding retries.
    const last = body.encodeAttemptLog.at(-1);
    const elapsedMs = Date.parse(last.endedAt) - Date.parse(last.startedAt);
    expect(elapsedMs).toBe(4 * 60 * 1000); // 4 minutes, retries excluded
  });

  it('reports exactly one attempt for a never-retried transcode job', async () => {
    const job = await h.jobs.create({ type: 'transcode', assetId: 'asset-2' });
    await h.jobs.appendEncodeAttempt(job.id, {
      startedAt: '2026-08-24T11:00:00.000Z',
      endedAt: '2026-08-24T11:02:00.000Z'
    });

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });
    const body = res.json();
    expect(body.encodeAttempts).toBe(1);
    expect(body.encodeAttemptLog).toHaveLength(1);
    expect(body.encodeAttemptLog[0].classification).toBeUndefined();
  });

  it('leaves ingest jobs unchanged: encode fields absent, ingest `attempts` intact', async () => {
    const job = await h.jobs.create({
      type: 'ingest-url',
      assetId: 'asset-3',
      sourceUrl: 'https://example.com/src.mp4'
    });
    await h.jobs.update(job.id, { attempts: 2 });

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });
    const body = res.json();
    expect(body.attempts).toBe(2); // ingest attempts unchanged
    expect(body.encodeAttempts).toBeUndefined();
    expect(body.encodeAttemptLog).toBeUndefined();
  });

  it('surfaces the fields in the list endpoint too', async () => {
    const job = await h.jobs.create({ type: 'transcode', assetId: 'asset-4' });
    await h.jobs.appendEncodeAttempt(job.id, {
      startedAt: '2026-08-24T12:00:00.000Z',
      endedAt: '2026-08-24T12:01:00.000Z'
    });

    const res = await h.app.inject({ method: 'GET', url: '/api/v1/jobs' });
    const item = res.json().items.find((j: { id: string }) => j.id === job.id);
    expect(item.encodeAttempts).toBe(1);
    expect(item.encodeAttemptLog).toHaveLength(1);
  });
});
