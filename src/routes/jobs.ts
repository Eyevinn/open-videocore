// Workspace-scoped jobs router (issue #5).
//
// Exposes job status for asynchronous pipelines (URL-pull ingest today). Every
// route is behind `authenticate`, so each handler runs with a validated
// request.workspaceId and the job repo scopes reads to that workspace. A job id
// from another workspace resolves to 404 (existence is not leaked).

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Redis } from 'ioredis';
import { InMemoryJobRepository, JOB_STATUSES, JOB_TYPES, JOB_INTERRUPTION_REASONS, type JobRepository, type JobStatus } from '../data/job-repo.js';
import type { PipelineRepository, StepExecution } from '../data/pipeline-repo.js';
import type { AssetRepository } from '../data/asset-repo.js';
import { keys } from '../encore-scaler/types.js';
import { decodeEncoreJobId } from '../data/job-repo.js';
import type { MessageFailureClass } from '../encore-scaler/retry-policy.js';
import { authGate } from '../auth/middleware.js';

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

// Mirrors MessageFailureClass (src/encore-scaler/retry-policy.ts) — the
// message-derived subset that can appear on a completed encode attempt. Kept as a
// local literal enum because MessageFailureClass is a type-only union with no
// runtime value to import; the two are asserted to stay in sync at build time
// below. NOTE (#514): the caller-facing classification enum is deliberately the
// message-derived subset ONLY. The internal 'interrupted_by_scaledown' class is a
// topology event, never a completed-attempt classification, so it is intentionally
// absent here (surfacing it to callers is #515's scope, not this issue's).
const FAILURE_CLASSES = ['transport', 'io-retryable', 'deterministic'] as const;
// Compile-time guard: fails typecheck if MessageFailureClass and FAILURE_CLASSES
// drift.
type _AssertFailureClassInSync = MessageFailureClass extends (typeof FAILURE_CLASSES)[number]
  ? (typeof FAILURE_CLASSES)[number] extends MessageFailureClass
    ? true
    : never
  : never;
const _failureClassInSync: _AssertFailureClassInSync = true;
void _failureClassInSync;

// One Encore dispatch (attempt) of a transcode job (ADR-012, #380/#381).
// `startedAt` is stamped at dispatch; `endedAt`/`classification` on completion.
const encodeAttemptSchema = z.object({
  index: z.number(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  classification: z.enum(FAILURE_CLASSES).optional()
});

const jobSchema = z.object({
  id: z.string(),
  type: z.enum(JOB_TYPES),
  status: z.enum(JOB_STATUSES),
  assetId: z.string(),
  // Human-readable name of the asset `assetId` points at, resolved at read time
  // (issue #988). Mirrors `assetName` on a pipeline execution
  // (src/routes/pipelines.ts:35) so both listings identify an asset by
  // something other than a 26-char ULID. ADDITIVE and OPTIONAL: absent when the
  // asset has been deleted, when the lookup fails, or when the router is
  // registered without an asset repository — `assetId` remains the identifier
  // every asset endpoint accepts, and callers must fall back to it.
  assetName: z
    .string()
    .optional()
    .describe(
      "Human-readable name of the job's asset, resolved at read time. Absent " +
        'when the asset has been deleted or cannot be read; fall back to ' +
        '`assetId`, which is always present.'
    ),
  sourceUrl: z.string(),
  progress: z.number(),
  bytesTransferred: z.number(),
  totalBytes: z.number().optional(),
  // Number of ingest/URL-pull attempts (retry tracking for URL-pull ingest) or,
  // for a `package` job (issue #976), the number of enqueues onto the packager
  // queue — so a re-enqueue reads differently from a slow first run. Distinct
  // from `encodeAttempts` below (Encore dispatches of a transcode job).
  attempts: z.number(),
  error: z.string().optional(),
  // Transcode-job fields (issue #8). Present only when type === 'transcode'.
  encoreJobId: z.string().optional(),
  encoreInternalJobId: z.string().optional(),
  encoreInstanceId: z.string().optional(), // which pool instance is running this job
  profile: z.string().optional(),
  renditionAssetIds: z.array(z.string()).optional(),
  // --- Package-job fields (issue #976). Present only when type === 'package'. ---
  packagingId: z
    .string()
    .optional()
    .describe(
      'Correlation id carried through the packager queue message and echoed on ' +
        'the packager completion callback. The package-job counterpart of ' +
        '`encoreJobId`.'
    ),
  outputPrefix: z
    .string()
    .optional()
    .describe(
      'Deterministic packaged-output prefix this job writes its CMAF/HLS/DASH ' +
        'objects under.'
    ),
  // --- Durable encode-attempt capture (ADR-012, #380/#381) ---
  // Count of Encore dispatches for this transcode job (1 on first dispatch,
  // incremented on each transport-class re-dispatch). DISTINCT from `attempts`
  // above, which counts ingest/URL-pull attempts. Absent until the first
  // dispatch is recorded; a completed, never-retried transcode reports 1.
  encodeAttempts: z.number().optional(),
  // Append-only log of each Encore dispatch, in dispatch order. To attribute
  // elapsed time to the SUCCESSFUL attempt alone (excluding retries), take the
  // LAST entry and compute `endedAt - startedAt`; this is the single documented
  // read for elapsed-time-excluding-retries.
  encodeAttemptLog: z.array(encodeAttemptSchema).optional(),
  // --- Recoverable interruption surfacing (#515) ---
  // True when this job was interrupted by an infrastructure/topology event
  // (NOT a media failure) and is being auto-retried. This is how a caller
  // tells a recoverable interruption apart from a genuine `failed` outcome:
  // an interrupted job is NOT reported as `failed` — its `status` stays
  // `running` while it is auto-retried, and this additive flag plus
  // `interruptionReason` carry the distinguishable, recoverable reason.
  // Additive and OPTIONAL: absent (not false) on jobs never interrupted, so
  // existing consumers of the `status` enum are unaffected.
  interrupted: z
    .boolean()
    .optional()
    .describe(
      'True when the job was interrupted by an infrastructure/topology event ' +
        '(not a media failure) and is being auto-retried. The job stays ' +
        '`running` — it is NOT reported as `failed`. Absent on jobs that were ' +
        'never interrupted. Additive and backward compatible with the existing ' +
        'status enum.'
    ),
  interruptionReason: z
    .enum(JOB_INTERRUPTION_REASONS)
    .optional()
    .describe(
      'Distinguishable, clearly-recoverable reason the job was interrupted, ' +
        'present only when `interrupted` is true. `interrupted_by_scaledown`: ' +
        'the shared worker pool scaled a worker away mid-job, so the work was ' +
        'lost to a topology event (not a media failure). This is RECOVERABLE ' +
        'and typically AUTO-RETRIED by the service with no operator ' +
        'intervention; callers may also retry safely.'
    ),
  createdAt: z.string(),
  updatedAt: z.string()
});

type JobsRouterOptions = {
  repository?: JobRepository;
  redis?: Redis; // for Encore instance lookup
  pipelineRepository?: PipelineRepository; // to release the running pipeline lock on cancel
  // Resolves `assetName` on read (issue #988). OPTIONAL, like every other repo
  // on this router: without it jobs are served exactly as before, with no
  // `assetName`. main.ts injects the same workspace-scoped repository the
  // pipelines router gets (src/main.ts:1910).
  assetRepository?: AssetRepository;
};

export const jobsRouter: FastifyPluginAsync<JobsRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository ?? new InMemoryJobRepository();

  // Resolve a job's asset name for read-time enrichment. Mirrors the pipelines
  // router's enrichment (src/routes/pipelines.ts:95-102) exactly, including the
  // `.catch(() => undefined)`: a deleted asset, a tombstoned one, or an
  // unreachable store degrades to NO name rather than failing the read. The
  // caller still has `assetId`.
  async function resolveAssetName(assetId: string): Promise<string | undefined> {
    const assetRepository = opts.assetRepository;
    if (!assetRepository || !assetId) return undefined;
    const asset = await assetRepository.get(assetId).catch(() => undefined);
    return asset?.name;
  }

  // 401 presence gate (issue #711): reject anonymous requests to this
  // workspace-scoped router. Plugin-scoped so it does not affect public routers.
  // See src/routes/assets.ts for the full rationale.
  app.addHook('preHandler', authGate(app));

  app.get(
    '/',
    {
      
      schema: {
        querystring: z.object({
          limit: z.coerce.number().min(1).max(100).default(50),
          offset: z.coerce.number().min(0).default(0)
        }),
        response: {
          200: z.object({ items: z.array(jobSchema), total: z.number() })
        }
      }
    },
    async (request) => {
      const { items, total } = await repo.list(request.query);
      // Per-row asset lookup, issued in PARALLEL (Promise.all over the page),
      // so a 50-row page costs one round-trip's latency rather than 50 serial
      // ones — the same shape as the pipelines listing
      // (src/routes/pipelines.ts:95-102). Each lookup degrades on its own: one
      // missing asset leaves that row without a name and never fails the page.
      const enriched = await Promise.all(
        items.map(async (job) => ({ ...job, assetName: await resolveAssetName(job.assetId) }))
      );
      return { items: enriched, total };
    }
  );

  // Cancel a job. Requests Encore cancellation (best-effort) and sets the job's
  // status to `cancelled` synchronously, distinct from `failed`. When the job
  // belongs to a running transcode PipelineExecution, its running `transcode`
  // step is marked failed so the asset's pipeline no longer shows RUNNING and a
  // new transcode can be submitted immediately (issue #126).
  app.delete(
    '/:id',
    {

      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: jobSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const job = await repo.get(request.params.id);
      if (!job) return reply.code(404).send({ error: 'not_found' });

      // Already terminal: repeated cancels are idempotent — return as-is without
      // re-cancelling (avoids a terminal→terminal transition, which would throw).
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
        return reply.code(200).send(job);
      }

      // Best-effort Encore cancellation. Must never block the synchronous status
      // update: Encore may be unreachable and cancelling a gone/terminal job is a
      // safe no-op per EncoreClient.cancel's contract (src/pipeline/encore-client.ts:44).
      if (job.encoreInternalJobId) {
        const encore = request.connections?.encore;
        if (encore) {
          try {
            await encore.cancel(job.encoreInternalJobId);
          } catch {
            // Encore unreachable or job already gone — proceed with local cancel.
          }
        }
      }

      // Synchronous local state: mark the job cancelled.
      const updated = await repo.update(request.params.id, {
        status: 'cancelled',
        error: 'cancelled by operator'
      });

      // Release the running pipeline lock: mark the running transcode step failed
      // so the asset's pipeline is no longer RUNNING. No-op when no running
      // execution is found (e.g. non-transcode/ingest jobs).
      const pipelineRepo = opts.pipelineRepository;
      if (pipelineRepo) {
        const execution = await pipelineRepo.findRunningByAssetAndStep(job.assetId, 'transcode');
        if (execution) {
          const now = new Date().toISOString();
          const steps: StepExecution[] = execution.steps.map((s) => ({ ...s }));
          const tIdx = steps.findIndex((s) => s.name === 'transcode');
          if (tIdx >= 0) {
            steps[tIdx] = {
              ...steps[tIdx],
              status: 'failed',
              error: 'cancelled by operator',
              completedAt: now
            };
            await pipelineRepo.update(execution.id, { steps, status: 'failed' });
          }
        }
      }

      return reply.code(200).send(updated ?? job);
    }
  );

  app.get(
    '/:id',
    {

      schema: {
        description:
          'Read a single job. For transcode jobs, `encodeAttempts` is the number ' +
          'of Encore dispatches and `encodeAttemptLog` records each dispatch in ' +
          'order (index, startedAt, endedAt?, classification?). This is DISTINCT ' +
          'from `attempts`, which counts ingest/URL-pull attempts. To obtain the ' +
          'elapsed time of the successful encode alone (excluding retries), read ' +
          'the LAST entry of `encodeAttemptLog` and compute endedAt − startedAt.',
        params: z.object({ id: z.string() }),
        response: { 200: jobSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const job = await repo.get(request.params.id);
      if (!job) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // Resolved ONCE for this job and spread onto every 200 below (the status
      // may be refreshed from Encore, and the instance id annotated, before we
      // reply — but the asset does not change across those branches).
      const assetName = await resolveAssetName(job.assetId);
      // For running transcode jobs, actively poll Encore for the current status.
      // This bridges the gap when the encore-callback-listener cannot reach the
      // API (e.g. local dev). If Encore has no record the job is marked failed.
      if (job.status === 'running' && job.type === 'transcode' && job.encoreInternalJobId) {
        const encore = request.connections?.encore;
        if (encore) {
          try {
            const encoreStatus = await encore.getJobStatus(job.encoreInternalJobId) as JobStatus | undefined;
            if (encoreStatus && encoreStatus !== job.status) {
              const updated = await repo.update(job.id, { status: encoreStatus });
              return reply.code(200).send({ ...(updated ?? job), assetName });
            }
          } catch {
            // Encore unreachable or job not found — leave status as-is
          }
        }
      }
      // Annotate with the Encore pool instance that is (or was) running this job.
      // Read from opts live so a stack provisioned after startup (which activates
      // the scaler and sets opts.redis) is picked up without a restart (#103).
      const redis = opts.redis;
      if (redis && job.encoreJobId) {
        try {
          const decoded = decodeEncoreJobId(job.encoreJobId);
          if (decoded) {
            const instanceId = await redis.hget(keys.jobInstance(decoded.workspaceId), job.encoreJobId);
            if (instanceId) {
              return reply.code(200).send({ ...job, assetName, encoreInstanceId: instanceId });
            }
          }
        } catch {
          // non-fatal — omit encoreInstanceId if lookup fails
        }
      }
      return reply.code(200).send({ ...job, assetName });
    }
  );
};
