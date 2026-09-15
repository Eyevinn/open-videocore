// Integration test: the internal Encore completion callback emits the
// encode-completion webhook event (issue #693, ADR-022).
//
// Wires the real internalRouter over in-memory repositories and a real
// WebhookDispatcher (with a recording fetch stub), registers a webhook
// subscribed to `encode.completed`, then POSTs a SUCCESSFUL Encore callback and
// asserts that:
//   - an `encode.completed` event is delivered over the same outbound-webhook
//     transport as `transcode.complete` (ADR-022 Option A);
//   - its payload validates against encodeCompletionEventSchema (#691);
//   - the derived fields are correct — encodeDurationMs from the last encode
//     attempt (ADR-012 D3), codec passed through, and a 1080p variant maps to
//     resolutionTier `fhd`;
//   - it is emitted IN ADDITION TO `transcode.complete`, not instead of it;
//   - it is gated by the `result.applied` idempotency guard so a redelivered
//     callback never double-emits (never double-meters).
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - Emission boundary + `result.applied` guard — src/routes/internal.ts
//     (encore-callback handler, applied-success branch).
//   - encodeCompletionEventSchema / ENCODE_COMPLETION_EVENT_TYPE /
//     resolutionTierForHeight / encodeDurationMsFromAttempt —
//     src/pipeline/encode-completion-event.ts.
//   - WebhookDispatcher.dispatch({type,payload}) single-arg signature +
//     { event, payload, timestamp } wire envelope — src/services/
//     webhook-dispatcher.ts.
//   - InMemoryJobRepository (create/update/appendEncodeAttempt/findByEncoreJobId)
//     + encodeEncoreJobId — src/data/job-repo.ts.
//   - InMemoryAssetRepository / InMemoryWebhookRepository — src/data/*.

import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { internalRouter } from './internal.js';
import { InMemoryWebhookRepository } from '../data/inmemory-webhook-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryJobRepository, encodeEncoreJobId } from '../data/job-repo.js';
import { WebhookDispatcher } from '../services/webhook-dispatcher.js';
import {
  ENCODE_COMPLETION_EVENT_TYPE,
  encodeCompletionEventSchema
} from '../pipeline/encode-completion-event.js';

type Delivered = { event: string; payload: unknown };

// Build the app + a real dispatcher whose fetch stub records the delivered
// { event, payload } envelopes so we can assert on the encode.completed payload.
async function buildApp(subscribedEvents: string[]) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const jobs = new InMemoryJobRepository();
  const assets = new InMemoryAssetRepository();
  const webhookRepo = new InMemoryWebhookRepository();
  await webhookRepo.create({ url: 'https://hook.example', events: subscribedEvents });

  const delivered: Delivered[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { event: string; payload: unknown };
    delivered.push({ event: body.event, payload: body.payload });
    return new Response(null, { status: 200 });
  });
  const dispatcher = new WebhookDispatcher({
    repository: webhookRepo,
    fetchImpl: fetchImpl as unknown as typeof fetch
  });

  await app.register(internalRouter, {
    prefix: '/api/v1/internal',
    jobRepository: jobs,
    repository: assets,
    webhookDispatcher: dispatcher
  });
  await app.ready();
  return { app, jobs, assets, delivered };
}

// Create a `running` transcode job over a `processing` source asset with one
// settled encode attempt whose timing is a known 42s window, and return the
// Encore externalId the callback resolves against.
async function seedRunningTranscode(
  jobs: InMemoryJobRepository,
  assets: InMemoryAssetRepository,
  timing: { startedAt: string; endedAt: string }
) {
  const asset = await assets.create({ name: 'clip' });
  await assets.update(asset.id, { status: 'processing' });
  const job = await jobs.create({ type: 'transcode', assetId: asset.id, profile: 'program' });
  const externalId = encodeEncoreJobId('ctx', job.id);
  await jobs.update(job.id, { encoreJobId: externalId, status: 'queued' });
  await jobs.update(job.id, { status: 'running' });
  // The scaler stamps startedAt on dispatch and the poller stamps endedAt on
  // completion (ADR-012); replicate a single settled attempt.
  await jobs.appendEncodeAttempt(job.id, { startedAt: timing.startedAt });
  await jobs.finalizeEncodeAttempt(job.id, { endedAt: timing.endedAt });
  return { assetId: asset.id, externalId };
}

// A successful Encore callback body producing one 1080p VideoFile.
//
// NOTE ON codec (rule 7): the Encore completion callback schema this route
// parses (callbackOutputSchema / videoStreamSchema, src/routes/internal.ts)
// deliberately extracts only width/height/bitrate — the SVT Encore per-stream
// codec field is not modeled in the repo and is not verified against the live
// Encore contract here, so `normaliseRenditions` produces no `codec`. That is
// why the #691 schema types `codec` OPTIONAL ("Encore does not always report a
// per-rendition codec"). Codec PASS-THROUGH (CallbackRendition.codec ->
// event.codec) is instead covered end-to-end by the unit test
// transcode.complete-result.test.ts, where a CallbackRendition carries a codec.
function successCallback(externalId: string) {
  return {
    externalId,
    status: 'SUCCESSFUL',
    output: [
      {
        file: 'transcode/asset/job/1080.mp4',
        type: 'VideoFile',
        videoStreams: [{ width: 1920, height: 1080 }],
        overallBitrate: 5_000_000
      }
    ]
  };
}

describe('encode-completion event emission on transcode completion (issue #693)', () => {
  it('emits encode.completed with a valid, correctly-derived payload alongside transcode.complete', async () => {
    const { app, jobs, assets, delivered } = await buildApp([
      'transcode.complete',
      ENCODE_COMPLETION_EVENT_TYPE
    ]);
    const { assetId, externalId } = await seedRunningTranscode(jobs, assets, {
      startedAt: '2026-09-14T10:00:00.000Z',
      endedAt: '2026-09-14T10:00:42.000Z'
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/encore-callback',
      payload: successCallback(externalId)
    });
    expect(res.statusCode).toBe(200);
    // Let the fire-and-forget deliveries settle.
    await new Promise((r) => setImmediate(r));

    // Emitted IN ADDITION TO transcode.complete (not instead of it).
    expect(delivered.map((d) => d.event)).toContain('transcode.complete');
    const encodeEvents = delivered.filter((d) => d.event === ENCODE_COMPLETION_EVENT_TYPE);
    expect(encodeEvents).toHaveLength(1);

    // Payload validates against the #691 schema.
    const parsed = encodeCompletionEventSchema.parse(encodeEvents[0].payload);

    // Required derived fields.
    expect(parsed.eventType).toBe('encode.completed');
    expect(parsed.assetId).toBe(assetId);
    expect(parsed.jobId).toMatch(/^job-/);
    // encodeDurationMs from the last attempt: 10:00:42 - 10:00:00 = 42_000ms.
    expect(parsed.encodeDurationMs).toBe(42_000);
    // 1080p variant height -> fhd tier.
    expect(parsed.resolutionTier).toBe('fhd');
    expect(typeof parsed.occurredAt).toBe('string');

    // Optional companions derived from the produced variant + job.
    // codec: absent at this boundary (the Encore callback carries no per-stream
    // codec — see the note on successCallback); its pass-through is covered in
    // transcode.complete-result.test.ts.
    expect(parsed.codec).toBeUndefined();
    expect(parsed.height).toBe(1080);
    expect(parsed.width).toBe(1920);
    expect(parsed.bitrateBps).toBe(5_000_000);
    expect(parsed.profile).toBe('program');
    expect(parsed.renditionCount).toBe(1);
  });

  it('does not emit encode.completed on a duplicate (already-terminal) callback — no double-meter', async () => {
    const { app, jobs, assets, delivered } = await buildApp([ENCODE_COMPLETION_EVENT_TYPE]);
    const { externalId } = await seedRunningTranscode(jobs, assets, {
      startedAt: '2026-09-14T10:00:00.000Z',
      endedAt: '2026-09-14T10:00:30.000Z'
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/encore-callback',
      payload: successCallback(externalId)
    });
    expect(first.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));

    // Redelivered callback: completeTranscode no-ops (job already `done`), so the
    // applied guard must suppress a second encode.completed emission.
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/encore-callback',
      payload: successCallback(externalId)
    });
    expect(dup.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));

    const encodeEvents = delivered.filter((d) => d.event === ENCODE_COMPLETION_EVENT_TYPE);
    expect(encodeEvents).toHaveLength(1);
  });

  it('emits resolutionTier `unknown` and omits duration-derived companions when Encore reported no dimensions', async () => {
    const { app, jobs, assets, delivered } = await buildApp([ENCODE_COMPLETION_EVENT_TYPE]);
    const { externalId } = await seedRunningTranscode(jobs, assets, {
      startedAt: '2026-09-14T10:00:00.000Z',
      endedAt: '2026-09-14T10:00:12.000Z'
    });

    // A VideoFile with no videoStreams -> height/width normalise to 0.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/encore-callback',
      payload: {
        externalId,
        status: 'SUCCESSFUL',
        output: [{ file: 'transcode/asset/job/out.mp4', type: 'VideoFile' }]
      }
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));

    const encodeEvents = delivered.filter((d) => d.event === ENCODE_COMPLETION_EVENT_TYPE);
    expect(encodeEvents).toHaveLength(1);
    const parsed = encodeCompletionEventSchema.parse(encodeEvents[0].payload);
    expect(parsed.resolutionTier).toBe('unknown');
    // No measurable dimensions -> optional height/width omitted (not defaulted).
    expect(parsed.height).toBeUndefined();
    expect(parsed.width).toBeUndefined();
    // Duration still derives from the attempt log.
    expect(parsed.encodeDurationMs).toBe(12_000);
  });
});
