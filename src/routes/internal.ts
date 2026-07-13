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
import { outputPrefix } from '../pipeline/packaging.js';
import {
  parseDestination,
  relocatePackagedOutput,
  type RelocationClient
} from '../pipeline/output-relocation.js';
import type { JobRepository } from '../data/job-repo.js';
import { decodeEncoreJobId } from '../data/job-repo.js';
import type { AssetRepository } from '../data/asset-repo.js';
import type { PipelineRepository, StepExecution } from '../data/pipeline-repo.js';
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
  renditionCount: z.number()
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
  // PipelineExecution tracking (PipelineExecution feature). When set, transcode/
  // package completion callbacks advance the matching running execution.
  pipelineRepository?: PipelineRepository;
  // Post-package relocation (issue #208, ADR-011). Resolves the S3/MinIO client
  // and the packaged/staging bucket for the stack so a packaging success can
  // server-side-copy this execution's output to a per-execution
  // `destinationBucket` override. Returns undefined when storage is not
  // configured (no override relocation is then possible; behaviour is unchanged
  // for executions with no override anyway). Reuses the resolver-built
  // MinioClient (src/services/workspace-stack.ts) — no new client abstraction.
  resolveRelocation?: () => Promise<
    { client: RelocationClient; packagedBucket: string } | undefined
  >;
};

// Are all steps of an execution terminal (done)? Used to close out an execution.
function allStepsDone(steps: StepExecution[]): boolean {
  return steps.every((s) => s.status === 'done');
}

// Build the Encore job API URL for packaging. Looks up the instance URL and
// the Encore-assigned UUID (stored at dispatch time) from the Redis pool.
// Returns undefined when the instance or UUID is not available.
async function resolveEncoreJobUrl(
  encoreJobId: string,
  redis: Redis | undefined
): Promise<string | undefined> {
  if (!redis) return undefined;
  // Fast path: full URL stored at dispatch time (survives pool teardown).
  const direct = await redis.get(keys.jobEncoreUrl(encoreJobId));
  if (direct) return direct;
  // Fallback: reconstruct from pool record + UUID (pre-jobEncoreUrl jobs).
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

// Decrement the running Encore instance's activeJobs after a job completes.
// Mirrors in reverse the increment in scaler-loop.dispatch() so a completed job
// frees its slot rather than pinning the pool at capacity forever. Best-effort:
// the pool hash is the durable source of truth and any failure is swallowed.
async function decrementActiveJobs(
  encoreJobId: string,
  redis: Redis | undefined
): Promise<void> {
  if (!redis) return;
  try {
    const decoded = decodeEncoreJobId(encoreJobId);
    if (!decoded) return;
    const { workspaceId } = decoded;
    const instanceId = await redis.hget(keys.jobInstance(workspaceId), encoreJobId);
    if (!instanceId) return;
    const instanceJson = await redis.hget(keys.pool(workspaceId), instanceId);
    if (!instanceJson) return;
    const record = JSON.parse(instanceJson) as EncoreInstanceRecord;
    record.activeJobs = Math.max(0, record.activeJobs - 1);
    if (record.activeJobs === 0) {
      record.lastIdleAt = Date.now();
    }
    await redis.hset(keys.pool(workspaceId), instanceId, JSON.stringify(record));
  } catch {
    // Swallowed: freeing the slot is best-effort; reconciliation will correct
    // any drift on the next scaler tick.
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
      objectKey: o.file ?? `rendition-${i + 1}`,
      bitrateBps: o.overallBitrate
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
      // Advance the matching PipelineExecution when packaging completes.
      if (opts.pipelineRepository) {
        const execution = await opts.pipelineRepository.findRunningByAssetAndStep(
          request.body.jobId,
          'package'
        );
        if (execution) {
          // Post-package relocation (issue #208, ADR-011). If this execution
          // carries a per-execution destination override, server-side-copy the
          // packaged output from the default staging bucket to the override
          // destination and record the resolved location for delivery (#210).
          // Idempotent per packagingId: the packager callback is at-least-once,
          // so a repeat success for an already-relocated packagingId must not
          // re-copy or double-record. packagingId === assetId in our usage
          // (see packaging.ts:44), and assetId === request.body.jobId.
          const packagingId = request.body.jobId;
          const alreadyRelocated =
            execution.relocatedPackagingIds?.includes(packagingId) ?? false;
          let relocationPatch:
            | Partial<
                Pick<
                  typeof execution,
                  'resolvedOutputLocation' | 'relocatedPackagingIds'
                >
              >
            | undefined;
          if (
            execution.destinationBucket &&
            !alreadyRelocated &&
            opts.resolveRelocation
          ) {
            const destination = parseDestination(execution.destinationBucket);
            const relocation = await opts.resolveRelocation();
            if (destination && relocation) {
              try {
                const result = await relocatePackagedOutput(relocation.client, {
                  sourceBucket: relocation.packagedBucket,
                  sourcePrefix: outputPrefix(packagingId),
                  destination
                });
                relocationPatch = {
                  resolvedOutputLocation: {
                    bucket: result.destination.bucket,
                    prefix: result.destination.prefix
                  },
                  relocatedPackagingIds: [
                    ...(execution.relocatedPackagingIds ?? []),
                    packagingId
                  ]
                };
              } catch (err) {
                // Leave the relocation un-recorded so the copy is retried on a
                // subsequent (at-least-once) packager callback. The packaged
                // output already exists at the default staging location, so the
                // execution still advances below and downstream is not blocked.
                fastify.log.error(
                  { err, packagingId, executionId: execution.id },
                  'post-package relocation to destination override failed'
                );
              }
            }
          }
          const now = new Date().toISOString();
          const steps = execution.steps.map((s) =>
            s.name === 'package' && s.status === 'running'
              ? { ...s, status: 'done' as const, completedAt: now }
              : s
          );
          await opts.pipelineRepository.update(execution.id, {
            steps,
            status: allStepsDone(steps) ? 'done' : 'running',
            ...(relocationPatch ?? {})
          });
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
  // marks it done/failed and records the produced renditions as embedded variants
  // on the single source asset (issue #79 — no child assets).
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

      // Free the slot on the Encore instance that ran this job so the scaler
      // can reuse its capacity. Only on a terminal completion that applied.
      if (result.applied) {
        await decrementActiveJobs(externalId, opts.redis);
      }

      // Advance the matching PipelineExecution. If this transcode was part of a
      // pipeline (e.g. abr-vod / full), mark the transcode step done/failed and,
      // on success, trigger the next step when it is `package`.
      if (result.applied && opts.pipelineRepository) {
        const execution = await opts.pipelineRepository.findRunningByAssetAndStep(
          found.job.assetId,
          'transcode'
        );
        // Match the specific execution by the encoreJobId stored on the step, so
        // concurrent executions never advance the wrong one.
        if (execution && execution.steps.some((s) => s.name === 'transcode' && s.encoreJobId === externalId)) {
          const now = new Date().toISOString();
          const steps: StepExecution[] = execution.steps.map((s) => ({ ...s }));
          const tIdx = steps.findIndex((s) => s.name === 'transcode' && s.encoreJobId === externalId);

          if (!success) {
            steps[tIdx] = {
              ...steps[tIdx],
              status: 'failed',
              error: message ?? `encore status: ${status}`,
              completedAt: now
            };
            await opts.pipelineRepository.update(execution.id, { steps, status: 'failed' });
          } else {
            steps[tIdx] = { ...steps[tIdx], status: 'done', completedAt: now };
            // Find the next pending step. When it is `package`, trigger packaging.
            const nextIdx = steps.findIndex((s) => s.status === 'pending');
            if (nextIdx >= 0 && steps[nextIdx].name === 'package' && opts.packaging && opts.redis) {
              const encoreJobUrl = await resolveEncoreJobUrl(externalId, opts.redis);
              if (encoreJobUrl) {
                steps[nextIdx] = { ...steps[nextIdx], status: 'running', startedAt: now };
                await opts.pipelineRepository.update(execution.id, { steps, status: 'running' });
                void opts.packaging.triggerPackaging(found.job.assetId, encoreJobUrl);
              } else {
                steps[nextIdx] = {
                  ...steps[nextIdx],
                  status: 'failed',
                  error: 'Encore instance no longer available for packaging',
                  completedAt: now
                };
                await opts.pipelineRepository.update(execution.id, { steps, status: 'failed' });
              }
            } else {
              await opts.pipelineRepository.update(execution.id, {
                steps,
                status: allStepsDone(steps) ? 'done' : 'running'
              });
            }
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
            payload: { assetId, renditionCount: result.renditionCount }
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
