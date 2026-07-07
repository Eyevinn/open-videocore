// Internal callback router (issue #9 packaging).
//
// Hosts unauthenticated callbacks that OSC services post back to open-videocore
// to signal asynchronous completion. These endpoints are NOT behind the
// `authenticate` preHandler because the caller is an OSC service, not a
// workspace-scoped client; instead they rely on the unguessable, workspace-
// namespaced `packagingId` carried in the payload to map the callback to an
// asset (the packagingId is the only authority a caller can demonstrate).
//
// SECURITY NOTE: a forged packager-callback can at most set manifestUrls /
// packagingError on an asset whose packagingId the caller already knows; it can
// never change the asset's lifecycle status, cross workspaces (the workspaceId
// is derived from the packagingId and re-validated by the repo's ownership
// guard), or read data back. A malformed/unknown packagingId resolves to 404.
// Hardening this with a shared callback secret is tracked in the issue #9
// friction log.
//
// Issue #8 adds POST /api/v1/internal/encore-callback (transcode completion) to
// this same router. The Encore callback resolves its workspace + job from the
// opaque encoreJobId we issued at submit time, which embeds both (see
// job-repo.encodeEncoreJobId). An unknown id resolves to 404 and is a no-op, so
// the endpoint cannot enumerate or mutate arbitrary workspaces. The handler is
// idempotent: a job already terminal is left untouched, so duplicate callbacks
// never create duplicate renditions.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PackagingService } from '../pipeline/packaging.js';
import type { JobRepository } from '../data/job-repo.js';
import { decodeEncoreJobId } from '../data/job-repo.js';
import type { AssetRepository } from '../data/asset-repo.js';
import { completeTranscode, type CallbackRendition } from '../pipeline/transcode.js';
import type { WebhookDispatcher } from '../services/webhook-dispatcher.js';
import { keys, type EncoreInstanceRecord } from '../encore-scaler/types.js';
import type { Redis } from 'ioredis';

// Packager callback schemas (verified from encore-packager callbackListener.ts 2026-07-07).
// The packager POSTs to {CallbackUrl}/packagerCallback/success or .../failure.
const packagerSuccessSchema = z.object({
  url: z.string().min(1),
  jobId: z.string().min(1), // echoed from our queue message; = assetId in our usage
  outputPath: z.string().optional()
});

const packagerFailureSchema = z.object({
  message: z.string()
});

const ackSchema = z.object({ ok: z.boolean() });
const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

// Encore completion callback payload (issue #8).
//
// SMOKE TEST CONFIRMED (2026-06-01): Encore POSTs its full EncoreJob document
// to progressCallbackUri. The relevant fields are:
//   externalId  — our encoreJobId (embeds workspaceId + jobId)
//   status      — "NEW"|"QUEUED"|"IN_PROGRESS"|"SUCCESSFUL"|"FAILED"|"CANCELLED"
//   message     — error message when status=FAILED
//   output      — array of MediaFile (VideoFile|AudioFile|ImageFile|SubtitleFile)
//                 VideoFile has: file (path), type ("VideoFile"), videoStreams[{width,height}]
//
// We filter output to VideoFile entries only (type === "VideoFile") to extract
// rendition dimensions. The schema is lenient on unknown fields.
const videoStreamSchema = z.object({
  width: z.number().optional(),
  height: z.number().optional()
}).passthrough();

const callbackOutputSchema = z.object({
  file: z.string().optional(),       // path/key of the produced file
  type: z.string().optional(),       // "VideoFile" | "AudioFile" | "ImageFile" | ...
  videoStreams: z.array(videoStreamSchema).optional(),
  overallBitrate: z.number().optional()
}).passthrough();

const encoreCallbackSchema = z.object({
  externalId: z.string().min(1),
  status: z.string().min(1),
  message: z.string().optional(),
  output: z.array(callbackOutputSchema).optional()   // NOTE: "output" not "outputs"
}).passthrough();

const encoreAckSchema = z.object({
  applied: z.boolean(),
  renditionAssetIds: z.array(z.string())
});

type InternalRouterOptions = {
  // The packaging service that resolves the callback to an asset and records
  // manifestUrls / packagingError. When absent (packaging not configured) the
  // packagerCallback endpoints respond 501.
  packaging?: PackagingService;
  // Transcode-callback dependencies (issue #8). When either is absent the
  // encore-callback endpoint responds 501.
  jobRepository?: JobRepository;
  repository?: AssetRepository;
  // Webhook event dispatcher (issue #13). When set, asset/job lifecycle events
  // surfaced by these callbacks are delivered to the workspace's registered
  // webhooks. Fire-and-forget: a delivery failure never affects the callback
  // response. Absent on deployments with webhooks disabled.
  webhookDispatcher?: WebhookDispatcher;
  // Redis client for looking up Encore instance URL at packaging trigger time.
  redis?: Redis;
};

// Build the Encore job API URL for packaging. Looks up the instance URL and
// the Encore-assigned UUID (stored at dispatch time) from the Redis pool.
// Returns undefined when the instance or UUID is not available.
async function resolveEncoreJobUrl(
  encoreJobId: string,
  redis: Redis | undefined
): Promise<string | undefined> {
  if (!redis) return undefined;
  const decoded = decodeEncoreJobId(encoreJobId);
  if (!decoded) return undefined;
  const { workspaceId } = decoded;
  const instanceId = await redis.hget(keys.jobInstance(workspaceId), encoreJobId);
  if (!instanceId) return undefined;
  const [instanceJson, encoreUuid] = await Promise.all([
    redis.hget(keys.pool(workspaceId), instanceId),
    redis.get(keys.jobUuid(encoreJobId))
  ]);
  if (!instanceJson || !encoreUuid) return undefined;
  try {
    const record = JSON.parse(instanceJson) as EncoreInstanceRecord;
    return `${record.url.replace(/\/+$/, '')}/encoreJobs/${encoreUuid}`;
  } catch {
    return undefined;
  }
}

function normaliseRenditions(
  output: z.infer<typeof callbackOutputSchema>[] | undefined
): CallbackRendition[] {
  if (!output) return [];
  // Filter to video files only; other types (audio, image, subtitle) are not renditions.
  const videoFiles = output.filter((o) => !o.type || o.type === 'VideoFile');
  return videoFiles.map((o, i) => {
    const stream = o.videoStreams?.[0];
    return {
      label: `rendition-${i + 1}`,
      width: stream?.width ?? 0,
      height: stream?.height ?? 0,
      objectKey: o.file ?? `rendition-${i + 1}`
    };
  });
}

export const internalRouter: FastifyPluginAsync<InternalRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Packager success callback (issue #9). No auth — see file header.
  // Path: {CallbackUrl}/packagerCallback/success
  // CONTRACT (verified from encore-packager callbackListener.ts 2026-07-07):
  //   body: { url, jobId, outputPath? }  where jobId = assetId we enqueued
  //   200 — manifestUrls written on asset
  //   404 — unknown assetId
  //   501 — packaging not configured
  app.post(
    '/packagerCallback/success',
    {
      schema: {
        body: packagerSuccessSchema,
        response: { 200: ackSchema, 404: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      if (!opts.packaging) {
        return reply
          .code(501)
          .send({ error: 'not_configured', message: 'packaging is not configured' });
      }
      const applied = await opts.packaging.handleSuccess(request.body);
      if (!applied) return reply.code(404).send({ error: 'not_found' });
      // Advance pipeline state when packaging completes (pipeline mode).
      if (opts.repository) {
        const asset = await opts.repository.get(request.body.jobId);
        if (asset?.pipelineStatus === 'packaging') {
          await opts.repository.update(asset.id, { pipelineStatus: 'done' });
        }
      }
      if (opts.webhookDispatcher) {
        void opts.webhookDispatcher.dispatch({
          type: 'package.complete',
          payload: { assetId: request.body.jobId }
        });
      }
      return reply.code(200).send({ ok: true });
    }
  );

  // Packager failure callback (issue #9). No auth — see file header.
  // Path: {CallbackUrl}/packagerCallback/failure
  // CONTRACT: body: { message }  — jobId not echoed on failure path; we record
  //   packagingError on all assets that were recently queued (best-effort).
  //   For simplicity we respond 200 without updating an asset (the asset
  //   remains in its current state and the error is surfaced in logs).
  app.post(
    '/packagerCallback/failure',
    {
      schema: {
        body: packagerFailureSchema,
        response: { 200: ackSchema }
      }
    },
    async (request, reply) => {
      // The packager failure body doesn't include the jobId, so we can only log.
      fastify.log.error({ msg: 'packager reported failure', message: request.body.message });
      return reply.code(200).send({ ok: true });
    }
  );

  // Encore transcode completion callback (issue #8). No auth — see file header.
  // Resolves the job by the embedded workspace+job encoreJobId, then idempotently
  // marks it done/failed and creates ready child assets for each rendition.
  //   200 — callback applied (or no-op for a duplicate / already-terminal job)
  //   404 — unknown encoreJobId (existence not leaked)
  //   501 — transcoding is not configured on this deployment
  app.post(
    '/encore-callback',
    {
      schema: {
        body: encoreCallbackSchema,
        response: { 200: encoreAckSchema, 404: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      const { jobRepository, repository } = opts;
      if (!jobRepository || !repository) {
        return reply
          .code(501)
          .send({ error: 'not_configured', message: 'transcoding is not configured' });
      }
      const { externalId, status, message, output } = request.body;

      const found = await jobRepository.findByEncoreJobId(externalId);
      if (!found) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const upper = status.toUpperCase();
      const success = upper === 'SUCCESSFUL' || upper === 'SUCCESS';
      const result = await completeTranscode(
        {
          jobId: found.job.id,
          sourceAssetId: found.job.assetId,
          success,
          error: success ? undefined : (message ?? `encore status: ${status}`),
          renditions: success ? normaliseRenditions(output) : []
        },
        { jobs: jobRepository, assets: repository }
      );

      // Pipeline orchestration: if this transcode was kicked off by pipeline mode
      // (POST /assets/:id/package with no encoreJobId), auto-trigger packaging now.
      if (result.applied && opts.packaging && opts.redis) {
        const sourceAsset = await repository.get(found.job.assetId);
        if (sourceAsset?.pipelineTranscodeJobId === found.job.id) {
          if (success) {
            const encoreJobUrl = await resolveEncoreJobUrl(externalId, opts.redis);
            if (encoreJobUrl) {
              await repository.update(sourceAsset.id, { pipelineStatus: 'packaging', pipelineError: undefined });
              void opts.packaging.triggerPackaging(sourceAsset.id, encoreJobUrl);
            } else {
              await repository.update(sourceAsset.id, {
                pipelineStatus: 'failed',
                pipelineError: 'Encore instance no longer available for packaging'
              });
            }
          } else {
            await repository.update(sourceAsset.id, {
              pipelineStatus: 'failed',
              pipelineError: message ?? `encore status: ${status}`
            });
          }
        }
      }

      // Notify subscribers (issue #13). Fire-and-forget; only emitted when the
      // callback actually applied (not a duplicate/late no-op) so a redelivered
      // Encore callback never double-fires events. A delivery failure never
      // affects this 200 response.
      if (result.applied && opts.webhookDispatcher) {
        const assetId = found.job.assetId;
        if (success) {
          void opts.webhookDispatcher.dispatch({
            type: 'transcode.complete',
            payload: { assetId, renditionAssetIds: result.renditionAssetIds }
          });
          // The source asset returns to `ready` once its renditions exist.
          void opts.webhookDispatcher.dispatch({
            type: 'asset.ready',
            payload: { assetId }
          });
        } else {
          const error = message ?? `encore status: ${status}`;
          void opts.webhookDispatcher.dispatch({
            type: 'transcode.failed',
            payload: { assetId, error }
          });
          void opts.webhookDispatcher.dispatch({
            type: 'asset.failed',
            payload: { assetId, error }
          });
        }
      }

      return reply.code(200).send(result);
    }
  );
};
