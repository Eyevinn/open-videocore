// GET /api/v1/jobs/:id encode-attempt surfacing tests (issue #382).
//
// Asserts the job read API additively surfaces the durable encode-attempt
// fields captured by #380/#381:
//   1. a retried transcode job returns encodeAttempts + encodeAttemptLog with
//      per-attempt index/startedAt/endedAt/classification, and the last
//      (successful) entry yields elapsed-time-excluding-retries (endedAt −
//      startedAt).
//   2. a never-retried transcode job reports exactly ONE attempt
//      (encodeAttempts === 1) with a single log entry whose startedAt+endedAt
//      are both set — the overall shape is unchanged aside from the additive
//      fields, and the ingest `attempts` field is untouched.
//
// Uses the same in-memory repo + Zod compiler wiring as jobs-cancel.test.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { jobsRouter } from '../src/routes/jobs.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';

type Harness = { app: FastifyInstance; jobs: InMemoryJobRepository };

async function buildApp(): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const jobs = new InMemoryJobRepository();
  app.decorateRequest('connections', null);
  app.addHook('preHandler', async (request) => {
    (request as unknown as { connections: unknown }).connections = {};
  });

  await app.register(jobsRouter, { prefix: '/api/v1/jobs', repository: jobs });
  await app.ready();
  return { app, jobs };
}

describe('GET /api/v1/jobs/:id encode attempts (issue #382)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildApp();
  });

  it('surfaces encodeAttempts + encodeAttemptLog for a retried transcode job', async () => {
    const job = await h.jobs.create({ type: 'transcode', assetId: 'asset-1' });

    // First dispatch fails with a transport-class error and is re-dispatched.
    await h.jobs.appendEncodeAttempt(job.id, { startedAt: '2026-08-22T10:00:00.000Z' });
    await h.jobs.finalizeEncodeAttempt(job.id, {
      endedAt: '2026-08-22T10:00:35.000Z',
      classification: 'transport'
    });
    // Second (successful) dispatch.
    await h.jobs.appendEncodeAttempt(job.id, { startedAt: '2026-08-22T10:01:00.000Z' });
    await h.jobs.finalizeEncodeAttempt(job.id, { endedAt: '2026-08-22T10:03:00.000Z' });

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // encode attempt count is distinct from ingest `attempts`.
    expect(body.encodeAttempts).toBe(2);
    expect(body.attempts).toBe(0);
    expect(body.encodeAttemptLog).toHaveLength(2);

    // First attempt classified transport (a retry), second is the success.
    expect(body.encodeAttemptLog[0]).toMatchObject({
      index: 1,
      startedAt: '2026-08-22T10:00:00.000Z',
      endedAt: '2026-08-22T10:00:35.000Z',
      classification: 'transport'
    });
    const last = body.encodeAttemptLog[body.encodeAttemptLog.length - 1];
    expect(last).toMatchObject({
      index: 2,
      startedAt: '2026-08-22T10:01:00.000Z',
      endedAt: '2026-08-22T10:03:00.000Z'
    });
    expect(last.classification).toBeUndefined();

    // Documented elapsed-time-excluding-retries: last endedAt − startedAt.
    const elapsedMs = new Date(last.endedAt).getTime() - new Date(last.startedAt).getTime();
    expect(elapsedMs).toBe(120_000); // 2 minutes, excluding the failed 35s attempt
  });

  it('reports exactly one attempt for a never-retried transcode job', async () => {
    const job = await h.jobs.create({ type: 'transcode', assetId: 'asset-2' });

    await h.jobs.appendEncodeAttempt(job.id, { startedAt: '2026-08-22T11:00:00.000Z' });
    await h.jobs.finalizeEncodeAttempt(job.id, { endedAt: '2026-08-22T11:01:30.000Z' });

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.encodeAttempts).toBe(1);
    expect(body.encodeAttemptLog).toHaveLength(1);
    expect(body.encodeAttemptLog[0]).toMatchObject({
      index: 1,
      startedAt: '2026-08-22T11:00:00.000Z',
      endedAt: '2026-08-22T11:01:30.000Z'
    });

    // Overall shape unchanged aside from the additive fields: ingest `attempts`
    // is still present and untouched.
    expect(body.attempts).toBe(0);
    expect(body.id).toBe(job.id);
    expect(body.type).toBe('transcode');
  });

  // --- #515: recoverable interruption surfacing ---

  it('surfaces a distinguishable, recoverable interrupted reason without leaving `failed`', async () => {
    // A job interrupted by scale-down is re-enqueued and stays `running`; the
    // caller-facing record is additively annotated (interrupted + reason) so a
    // Media Developer can tell the interruption apart from a media failure.
    const job = await h.jobs.create({ type: 'transcode', assetId: 'asset-i1' });
    await h.jobs.update(job.id, { status: 'running' });
    await h.jobs.update(job.id, {
      interrupted: true,
      interruptionReason: 'interrupted_by_scaledown'
    });

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Distinguishable + recoverable: not a generic `failed`.
    expect(body.status).toBe('running');
    expect(body.status).not.toBe('failed');
    expect(body.interrupted).toBe(true);
    expect(body.interruptionReason).toBe('interrupted_by_scaledown');
  });

  it('keeps interrupted fields absent (not false) on a job that was never interrupted', async () => {
    // Backward compatibility: the additive fields must be absent — not false /
    // null — so existing consumers of the current shape are unaffected.
    const job = await h.jobs.create({ type: 'transcode', assetId: 'asset-i2' });
    await h.jobs.update(job.id, { status: 'running' });

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.status).toBe('running');
    expect(body.interrupted).toBeUndefined();
    expect(body.interruptionReason).toBeUndefined();
  });

  it('constrains interruptionReason to the documented closed enum (schema shape)', async () => {
    // The response schema enum is exactly the caller-facing interruption
    // vocabulary. A documented value serializes cleanly; an off-contract value
    // is rejected by the response serializer (it is NOT free-form), proving the
    // field is a closed, documented enum callers can rely on.
    const ok = await h.jobs.create({ type: 'transcode', assetId: 'asset-i3a' });
    await h.jobs.update(ok.id, { status: 'running' });
    await h.jobs.update(ok.id, {
      interrupted: true,
      interruptionReason: 'interrupted_by_scaledown'
    });
    const okRes = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${ok.id}` });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json().interruptionReason).toBe('interrupted_by_scaledown');

    // Force an off-contract value past the repo (cast, since the repo type is
    // the closed enum) to prove the response schema constrains it: the closed
    // enum rejects it rather than emitting an undocumented value to the caller.
    const bad = await h.jobs.create({ type: 'transcode', assetId: 'asset-i3b' });
    await h.jobs.update(bad.id, { status: 'running' });
    await h.jobs.update(bad.id, {
      interrupted: true,
      interruptionReason: 'not_a_real_reason' as unknown as 'interrupted_by_scaledown'
    });
    const badRes = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${bad.id}` });
    // Serializer rejects the off-contract value: callers never receive an
    // undocumented interruption reason.
    expect(badRes.statusCode).toBe(500);
  });

  it('omits encode fields for an ingest job that was never dispatched to Encore', async () => {
    const job = await h.jobs.create({
      type: 'ingest-url',
      assetId: 'asset-3',
      sourceUrl: 'https://example.com/a.mp4'
    });

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Additive + optional: absent, not zero, when no encode ever ran.
    expect(body.encodeAttempts).toBeUndefined();
    expect(body.encodeAttemptLog).toBeUndefined();
    expect(body.attempts).toBe(0);
  });
});
