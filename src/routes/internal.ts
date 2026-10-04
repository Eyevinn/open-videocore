// Internal callback router (issue #9 packaging).
//
// Hosts unauthenticated callbacks that OSC services post back to open-videocore
// to signal asynchronous completion. These endpoints are NOT behind the
// `authenticate` preHandler because the caller is an OSC service, not a
// workspace-scoped client. What a caller must demonstrate to reach anything
// DIFFERS per endpoint — the success callback is bound to an unguessable id it
// has to know, the failure callback requires no identifier at all — so read the
// SECURITY NOTE below before assuming any of them is id-gated.
//
// SECURITY NOTE — the two packager callbacks have DIFFERENT blast radii, and the
// failure one is wide:
//
//   * SUCCESS (`/packagerCallback/success`) is identifier-bound. A forged call
//     can at most set manifestUrls on an asset whose id the caller already
//     knows; it can never change the asset's lifecycle status or read data
//     back, and an unknown id resolves to 404.
//
//   * FAILURE (`/packagerCallback/failure`) requires NO identifier at all. The
//     packager sends only `{ message }` — it has no id of ours to send — so the
//     handler correlates by EXECUTION STATE instead: it fails every execution
//     currently stalled on a running `package` step, settles each one's package
//     Job (failPackageJob) and dispatches a `package.failed` webhook for each.
//     Since issue #1058 that sweep runs on EVERY PROVISIONED STACK, not just the
//     first-listed one, because the payload carries no stack identity either.
//     So one unauthenticated, bodyless-but-for-a-message POST can fail every
//     in-flight packaging job in the deployment. This is a widened version of a
//     fan-out that already existed within one stack (issue #209 attribution), and
//     it is bounded by the isolation model in
//     docs/architecture/ADR-020-quota-deployment-model-and-metering-source.md
//     ("One deployed open-videocore instance is one tenant", Decision 1):
//     stacks 2..N belong to the SAME tenant, so nothing crosses a tenant
//     boundary — but it is strictly more than the success path can do. Note the
//     ADR numbers are ambiguous here (two files share each of 018 and 020), so
//     this cites the filename deliberately; ADR-018's "stack" wording is a
//     different document and is NOT the authority for this claim.
//
// Hardening both with a shared callback secret is tracked in the issue #9
// friction log; getting a correlation id onto the failure callback is tracked in
// the encore-packager contract friction log.
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
import { isStepComplete } from '../data/pipeline-repo.js';
import type { PipelineRepository, StepExecution } from '../data/pipeline-repo.js';
import { completeTranscode, type CallbackRendition } from '../pipeline/transcode.js';
import type { PipelineLogSink } from '../services/pipeline-log.js';
// #829: the terminal-transcode webhook events are owned by the shared module so
// this route and the completion poller (src/pipeline/encore-callback-poller.ts)
// — the two paths that can apply a transcode completion — emit identical
// payloads from one place.
import { dispatchTranscodeCompletionEvents } from '../pipeline/transcode-completion-events.js';
// Package-step Job records (issue #976). The packager's failure callback is the
// live failure path — it carries no jobId, so it settles the job the same way it
// settles the execution: by correlating on a running `package` step.
import { failPackageJob } from '../pipeline/package-job.js';
import type { AuditEmitter } from '../data/audit-emit.js';
import type { WebhookDispatcher } from '../services/webhook-dispatcher.js';
import { keys, type EncoreInstanceRecord } from '../encore-scaler/types.js';
import { pinInstanceForPackaging, unpinInstanceForPackaging } from '../encore-scaler/packaging-pin.js';
import { resolvePackagingInstanceId } from '../encore-scaler/packaging-target.js';
import type { Redis } from 'ioredis';
import { runWithRequestStack } from '../services/request-stack-context.js';

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
  // Best-effort audit emission (issue #564). Passed to completeTranscode so the
  // transcode job's terminal (done/failed) transition emits exactly one audit
  // entry, fire-and-forget. Absent => transcode completion runs un-audited.
  audit?: AuditEmitter;
  // The provisioned stack names, in parameter-store listing order (issue #1058).
  // The packager's callbacks carry no stack identity of ours, so they fall back
  // to searching the provisioned stacks for the execution/asset the callback
  // belongs to. Wired from WorkspaceStackResolver.listStackNames(). Absent (or
  // empty) => the single default resolution is used, unchanged.
  listStackNames?: () => Promise<string[]>;
  // Best-effort operational log emission (issue #995). Passed to
  // completeTranscode so the transcode job's terminal transition also appends one
  // record to the log store GET /api/v1/logs reads (src/main.ts,
  // `logStore`; read path src/routes/logs.ts:94). Absent => no log record.
  pipelineLog?: PipelineLogSink;
};

// The provisioned stack names, never throwing (issue #1058). These callbacks are
// unauthenticated and best-effort: a parameter-store blip must degrade to "just
// the default stack", never fail the callback.
async function listStackNamesSafely(opts: InternalRouterOptions): Promise<string[]> {
  if (!opts.listStackNames) return [];
  try {
    return await opts.listStackNames();
  } catch {
    return [];
  }
}

// Are all steps of an execution settled? Used to close out an execution. A
// `skipped` optional step (issue #789) counts as settled alongside `done`, so a
// callback-driven `full` run still completes when the stack has no subtitles /
// scene-detection instance configured.
function allStepsDone(steps: StepExecution[]): boolean {
  return steps.every(isStepComplete);
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

  // Which provisioned stack holds `assetId` (issue #1058).
  //
  // The packager's success callback identifies the work by OUR assetId and
  // nothing else, so unlike the Encore callback there is no stack identity to
  // decode. Probe the default resolution FIRST — on a single-stack install (and
  // for every asset on the first-listed stack) that is one lookup and the
  // behaviour is exactly as before — and only then try the other provisioned
  // stacks. Returns undefined when the default stack owns the asset, when no
  // stack does (the handler then 404s as before), or when there is no asset repo
  // wired at all.
  async function stackOwningAsset(assetId: string): Promise<string | undefined> {
    const assets = opts.repository;
    if (!assets) return undefined;
    try {
      if (await assets.get(assetId)) return undefined;
      for (const name of await listStackNamesSafely(opts)) {
        const found = await runWithRequestStack(name, async () => assets.get(assetId));
        if (found) return name;
      }
    } catch (err) {
      // Best-effort: a lookup failure degrades to the default resolution rather
      // than failing an unauthenticated callback that would just be retried.
      fastify.log.warn({ err, assetId }, 'could not determine the stack owning the asset');
    }
    return undefined;
  }

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
      // Not-configured first: a deployment without packaging must answer 501
      // without doing any lookup work at all.
      if (!opts.packaging) {
        return reply
          .code(501)
          .send({ error: 'not_configured', message: 'packaging is not configured' });
      }
      // The packager callback carries only `jobId` (= the assetId we enqueued)
      // and no stack identity (issue #1058). Find the stack whose asset store
      // actually holds that asset and run the whole handler — manifest write,
      // pipeline advance, relocation — inside it, so a packaging success for a
      // non-default stack is applied there instead of 404ing.
      const owningStack = await stackOwningAsset(request.body.jobId);
      return runWithRequestStack(owningStack, async () => {
        const applied = await opts.packaging!.handleSuccess(request.body);
        if (!applied) return reply.code(404).send({ error: 'not_found' });
        // Advance the matching PipelineExecution when packaging completes.
        if (opts.pipelineRepository) {
          const execution = await opts.pipelineRepository.findRunningByAssetAndStep(
            request.body.jobId,
            'package'
          );
          if (execution) {
            // #525 pt.2: packaging for this execution is confirmed complete —
            // release the pin (packaging-pin.ts) that kept the transcode
            // instance alive against premature scale-down while this was
            // pending. Best-effort: a release failure must never fail the
            // packager's callback (it would just retry); the pin's own TTL is
            // the safety net if this never runs.
            if (opts.redis) {
              try {
                // Correlate via the `transcode` step, falling back to the
                // `package` step (issue #739). A package-only execution has NO
                // transcode step — its single `package` step carries the earlier
                // transcode's Encore job id, stamped at dispatch
                // (src/routes/assets.ts, package-only branch), which is the id the
                // pin was taken under. Without the fallback the lookup resolves
                // `undefined`, the unpin is skipped, and the pin holds an
                // otherwise-idle instance out of scale-down for its full TTL.
                // CONTRACT: `StepExecution.encoreJobId?: string`
                // (src/data/pipeline-repo.ts:43-56, field at :47).
                const encoreJobId =
                  execution.steps.find((s) => s.name === 'transcode')?.encoreJobId ??
                  execution.steps.find((s) => s.name === 'package')?.encoreJobId;
                if (encoreJobId) {
                  // Resolve the pinned instance through the shared resolver
                  // (CONTRACT: `resolvePackagingInstanceId(redis, encoreJobId)`,
                  // src/encore-scaler/packaging-target.ts) rather than reading
                  // keys.jobInstance directly. By the time a packager success
                  // callback arrives, the transcode it followed has succeeded —
                  // and the callback poller hdel's keys.jobInstance on exactly
                  // that event (encore-callback-poller.ts), so the direct read
                  // resolved null and the unpin was silently skipped, holding an
                  // idle instance out of scale-down for the pin's full TTL. The
                  // resolver reads keys.jobTerminalInstance, which is retained
                  // past terminal for precisely this.
                  const instanceId = await resolvePackagingInstanceId(opts.redis, encoreJobId);
                  if (instanceId) {
                    await unpinInstanceForPackaging(opts.redis, instanceId, encoreJobId);
                  }
                }
              } catch (err) {
                fastify.log.warn({ err, executionId: execution.id }, 'failed to release packaging pin after packager success');
              }
            }
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
      });
    }
  );

  // Packager failure callback (issue #9, attribution hardened by #209). No auth
  // — see file header.
  // Path: {CallbackUrl}/packagerCallback/failure
  // CONTRACT: body: { message } ONLY — the packager does NOT echo the jobId on
  //   the failure path (verified from encore-packager callbackListener.ts). So
  //   we cannot correlate the failure by a packager-supplied id. Instead we
  //   correlate by open-videocore-side EXECUTION STATE: any pipeline execution
  //   currently blocked on a running `package` step is awaiting exactly this
  //   packager callback, so we mark that step (and the execution) failed and
  //   record the packager's human-readable message as an attributable error on
  //   the execution record. This is what makes a destination that could not be
  //   pre-validated (issue #209 — e.g. an external `s3://` endpoint the API
  //   cannot probe) surface as a clear failure tied to the right execution
  //   rather than an opaque log line.
  //   200 — acknowledged (always; the callback is best-effort from the packager).
  app.post(
    '/packagerCallback/failure',
    {
      schema: {
        body: packagerFailureSchema,
        response: { 200: ackSchema }
      }
    },
    async (request, reply) => {
      const message = request.body.message;
      // Always log — this is the durable record when no execution matches.
      fastify.log.error({ msg: 'packager reported failure', message });

      // This callback carries NO identifier of ours — not even an assetId — so
      // there is no stack identity to decode (issue #1058). Attribution is by
      // execution state, so run it once per PROVISIONED stack rather than only on
      // the first-listed one; otherwise a packager failure for an execution on any
      // other stack is never attributed and that execution stalls. With no
      // parameter store (env override / local run) the single default resolution
      // is used, byte-identical to before.
      const stacks = opts.listStackNames ? await listStackNamesSafely(opts) : [];
      const candidates: Array<string | undefined> = stacks.length > 0 ? stacks : [undefined];
      for (const stack of candidates) {
        await runWithRequestStack(stack, async () => {
          // Correlate by execution state (NOT a packager jobId, which is absent).
          // Every execution stalled on a running `package` step is waiting on the
          // packager; record the failure reason on each so the error is attributable
          // on the asset/execution record instead of only in logs.
          if (opts.pipelineRepository) {
            try {
              const running = await opts.pipelineRepository.listAll({ status: 'running' });
              const now = new Date().toISOString();
              for (const execution of running.items) {
                const hasRunningPackage = execution.steps.some(
                  (s) => s.name === 'package' && s.status === 'running'
                );
                if (!hasRunningPackage) continue;
                const reason = `packager failure: ${message}`;
                const runningPackageStep = execution.steps.find(
                  (s) => s.name === 'package' && s.status === 'running'
                );
                const steps = execution.steps.map((s) =>
                  s.name === 'package' && s.status === 'running'
                    ? {
                        ...s,
                        status: 'failed' as const,
                        error: reason,
                        completedAt: now
                      }
                    : s
                );
                await opts.pipelineRepository.update(execution.id, {
                  steps,
                  status: 'failed'
                });
                // Settle this execution's `package` Job with the same reason (issue
                // #976). The packager's failure callback carries no jobId of ours,
                // so the job is resolved exactly the way the execution is: by the
                // step's own jobId (stamped at enqueue), falling back to the
                // asset's in-flight package job. Best-effort — never throws, so
                // attribution stays as resilient as it was.
                await failPackageJob(
                  { jobs: opts.jobRepository, pipeline: opts.pipelineRepository, logger: fastify.log },
                  { jobId: runningPackageStep?.jobId, assetId: execution.assetId },
                  reason
                );
                if (opts.webhookDispatcher) {
                  void opts.webhookDispatcher.dispatch({
                    type: 'package.failed',
                    payload: { assetId: execution.assetId, error: message }
                  });
                }
              }
            } catch (err) {
              // Attribution is best-effort: a repo error must never turn the
              // packager's callback into a 5xx (it would just be retried). The log
              // line above is the fallback record.
              fastify.log.error({ err }, 'failed to attribute packager failure to a running execution');
            }
          }
        });
      }

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
      // Re-enter the stack this job belongs to (issue #1058). The callback is
      // unauthenticated and carries NO X-Stack-Name, so without this the data
      // plane resolves the first-listed stack and findByEncoreJobId misses a job
      // that lives on any other stack — the job would stay `running` and its
      // asset `processing` forever. The identity is already in the id we issued:
      // encodeEncoreJobId(contextId, jobLocalId) puts the resolved stack name in
      // the prefix (src/data/job-repo.ts), and decodeEncoreJobId reads it back.
      // A contextId that is not a provisioned stack name (the DEPLOYMENT_CONTEXT
      // fallback) resolves to the workspace default exactly as before.
      const callbackStack = decodeEncoreJobId(request.body.externalId)?.workspaceId;
      return runWithRequestStack(callbackStack, async () => {
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
          {
            jobs: jobRepository,
            assets: repository,
            audit: opts.audit,
            auditLog: fastify.log,
            // Operational log for the `transcode` stage's terminal state (issue
            // #995), appended at the same point as the audit entry inside
            // completeTranscode. This route is one of the paths that applies a
            // transcode terminal state, so without it a completion that arrives
            // here leaves the Logs tab showing a stage that started and never
            // finished. Emitted INSIDE the issue #1058 stack re-entry above, so
            // the record is written for the stack the job actually belongs to.
            pipelineLog: opts.pipelineLog
          }
        );

        // #525 pt.2: pin the instance that ran this job against premature
        // scale-down BEFORE decrementActiveJobs below makes it look idle to the
        // scaler's teardown check — mirrors the same fix in
        // encore-callback-poller.ts (this route is this deployment's OTHER
        // transcode->package handoff path, subject to the identical race).
        // Released below on every exit that doesn't hand off to a genuinely
        // enqueued packaging job, by the packager's success callback once
        // packaging completes, or by the pin's own TTL otherwise.
        let pinnedInstanceId: string | undefined;
        if (result.applied && success && opts.redis) {
          const decoded = decodeEncoreJobId(externalId);
          if (decoded) {
            try {
              const instanceId = await opts.redis.hget(keys.jobInstance(decoded.workspaceId), externalId);
              if (instanceId) {
                await pinInstanceForPackaging(opts.redis, instanceId, externalId);
                pinnedInstanceId = instanceId;
              }
            } catch (err) {
              fastify.log.warn({ err, externalId }, 'failed to pin instance for packaging handoff');
            }
          }
        }
        const releasePendingPackagingPin = async (): Promise<void> => {
          if (!pinnedInstanceId || !opts.redis) return;
          try {
            await unpinInstanceForPackaging(opts.redis, pinnedInstanceId, externalId);
          } catch (err) {
            fastify.log.warn({ err, externalId, instanceId: pinnedInstanceId }, 'failed to release packaging pin');
          }
        };
        let packagingHandedOff = false;

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
                  // Awaited (was fire-and-forget) so the `package` Job record and
                  // its `steps[].jobId` stamp (issue #976) exist before the
                  // packager — which consumes the queue entry this call writes —
                  // can post its completion callback back at us. triggerPackaging
                  // still never throws: an enqueue failure records the reason on
                  // the asset and on the package job.
                  await opts.packaging.triggerPackaging(found.job.assetId, encoreJobUrl);
                  // #525 pt.2: packaging is genuinely in flight — leave the pin
                  // in place until the packager's success callback releases it.
                  packagingHandedOff = true;
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

        // #525 pt.2: any path above that did not hand this job's pin off to a
        // genuinely enqueued packaging job must release it here rather than
        // waiting out its TTL.
        if (!packagingHandedOff) {
          await releasePendingPackagingPin();
        }

        // Notify subscribers (issue #13). Fire-and-forget; only emitted when the
        // callback actually applied (not a duplicate/late no-op) so a redelivered
        // Encore callback never double-fires events. A delivery failure never
        // affects this 200 response. #829: the emission itself lives in
        // src/pipeline/transcode-completion-events.ts, shared with the completion
        // poller so both terminal-state paths produce identical payloads.
        dispatchTranscodeCompletionEvents({
          dispatcher: opts.webhookDispatcher,
          job: found.job,
          success,
          error: message ?? `encore status: ${status}`,
          result
        });

        return reply.code(200).send(result);
      });
    }
  );
};
