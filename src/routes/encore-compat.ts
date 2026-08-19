// Encore-compatible transcode submission API.
//
// This router lets integrators who currently POST jobs directly to an Encore
// OSC instance migrate to open-videocore with nothing more than a base-URL
// swap: point the client at `<api>/api/v1/encore` instead of the Encore URL and
// keep the exact same request/response payloads.
//
// It is a thin translation layer, NOT a re-implementation of Encore. A submit:
//   1. accepts the native Encore POST /encoreJobs shape (permissively — unknown
//      fields pass through unvalidated so future Encore fields don't break us),
//   2. materialises the first input as an asset (source-of-truth for the MAM),
//   3. delegates the actual encode to the existing `submitTranscode` orchestrator
//      (which talks to the Encore auto-scaler pool, ADR-006), and
//   4. returns an Encore-shaped `{ id, externalId, status }` so a polling or
//      callback-driven integration keeps working unchanged.
//
// Contracts fetched before writing (CLAUDE.md rule 7):
//   - src/pipeline/encore-client.ts — the native Encore POST /encoreJobs payload
//     shape (externalId?, inputs[].uri, outputFolder, profile?, profileParams?,
//     progressCallbackUri?). profileParams is a TOP-LEVEL key (sibling of
//     profile), written by toEncorePayload (encore-client.ts:92).
//   - src/pipeline/transcode.ts — submitTranscode(params, deps) returns
//     { jobId, encoreJobId }; deps = { jobs, assets, encore }. params accepts an
//     optional profileParams?: Record<string,string> (issue #287) threaded into
//     the Encore job document.
//   - src/data/asset-repo.ts — AssetRepository.create(CreateAssetInput):
//     { name, sourceMethod?: 'url-pull', originUri? }.
//   - src/data/job-repo.ts — JobRepository.findByEncoreJobId(id) returns
//     { job: Job } | undefined; Job.status ∈ 'pending'|'running'|'done'|'failed'.
//   - src/auth/workspace.ts — DEPLOYMENT_CONTEXT ('default'), the fixed context
//     token embedded in the encoreJobId (OSC provides structural isolation).
//   - src/pipeline/encode-presets.ts — PRESET_NAMES = ['1080p','720p','480p'].
//
// Auth: unauthenticated by design, matching Encore's own submit API. The OSC
// platform terminates auth at the edge (ADR-003), so this router — like the
// internal callback router — trusts every request that reaches it.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  InMemoryAssetRepository,
  type AssetRepository
} from '../data/asset-repo.js';
import { InMemoryJobRepository, type JobRepository, type JobStatus } from '../data/job-repo.js';
import { submitTranscode } from '../pipeline/transcode.js';
import { DEPLOYMENT_CONTEXT } from '../auth/workspace.js';
import { PRESET_NAMES, type PresetName } from '../pipeline/encode-presets.js';
import type { EncoreClient } from '../pipeline/encore-client.js';

export type EncoreCompatRouterOptions = {
  repository: AssetRepository;
  jobRepository: JobRepository;
  // Encore transcode client (the auto-scaler pool). When absent, submit
  // responds 501 (transcoding is not configured on this deployment).
  encore?: EncoreClient;
  // S3 buckets Encore reads the source from / writes renditions to.
  sourceBucket?: string;
  outputBucket?: string;
};

// The native Encore POST /encoreJobs payload. Permissive by design
// (`.passthrough()` on the outer object and on nested inputs/profile) so an
// integrator's existing payload — including Encore fields we don't model —
// validates and migrates without edits. We only assert the fields we consume.
const encoreInputSchema = z
  .object({
    uri: z.string().min(1),
    analyzed: z.boolean().optional()
  })
  .passthrough();

const encoreProfileSchema = z
  .object({
    name: z.string().min(1).optional()
  })
  .passthrough();

// profileParams (issue #289): a flat string map carried at the TOP LEVEL of the
// native Encore job document (a sibling of `profile`, NOT nested inside it) —
// see toEncorePayload in src/pipeline/encore-client.ts:92, which writes
// `profileParams` as a top-level key alongside `profile`. A compat client
// mimicking the native Encore POST /encoreJobs shape therefore sends it at the
// top level. Encore evaluates the entries as SpEL expression properties within
// the named server-side profile. Verified shape: SVT Encore
// `EncoreJob.profileParams: Map<String, Any?>` defaulting to `{}`
// (github.com/svt/encore, encore-common/.../model/EncoreJob.kt). We constrain
// our contract to string values, matching the native /:id/transcode route
// (src/routes/assets.ts:144). Omitted -> unchanged default output.
const encoreProfileParamsSchema = z.record(z.string(), z.string());

const encoreJobSchema = z
  .object({
    externalId: z.string().optional(),
    inputs: z.array(encoreInputSchema).min(1),
    outputFolder: z.string().min(1),
    profile: encoreProfileSchema.optional(),
    profileParams: encoreProfileParamsSchema.optional(),
    progressCallbackUri: z.string().optional()
  })
  .passthrough();

// Encore-shaped response. Enough for a caller to poll GET /encoreJobs/:id or
// receive a callback and correlate by externalId.
const encoreJobResponseSchema = z.object({
  id: z.string(),
  externalId: z.string(),
  status: z.string(),
  message: z.string().optional()
});

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

// Map our internal Job.status to the Encore job status vocabulary the caller
// expects. pending/queued -> QUEUED, running -> IN_PROGRESS, done -> SUCCESSFUL,
// failed -> FAILED.
function toEncoreStatus(status: JobStatus): string {
  switch (status) {
    case 'running':
      return 'IN_PROGRESS';
    case 'done':
      return 'SUCCESSFUL';
    case 'failed':
      return 'FAILED';
    case 'pending':
    case 'queued':
    default:
      return 'QUEUED';
  }
}

// Derive a human asset name from the last path segment of a source URI. Falls
// back to the whole URI when there is no meaningful segment.
function nameFromUri(uri: string): string {
  // Strip any query/fragment, then take the last non-empty path segment.
  const withoutQuery = uri.split(/[?#]/)[0];
  const segments = withoutQuery.split('/').filter(Boolean);
  const last = segments.pop();
  if (!last) {
    return uri;
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export const encoreCompatRouter: FastifyPluginAsync<EncoreCompatRouterOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository ?? new InMemoryAssetRepository();
  const jobs = opts.jobRepository ?? new InMemoryJobRepository();

  // Submit a transcode job in the native Encore shape.
  //   200 — accepted; Encore-shaped { id, externalId, status: "QUEUED" }
  //   501 — transcoding is not configured on this deployment
  //   502 — the Encore submission failed
  app.post(
    '/encoreJobs',
    {
      schema: {
        body: encoreJobSchema,
        response: { 200: encoreJobResponseSchema, 501: errorSchema, 502: errorSchema }
      }
    },
    async (request, reply) => {
      if (!opts.encore || !opts.sourceBucket || !opts.outputBucket) {
        return reply
          .code(501)
          .send({ error: 'not_configured', message: 'transcoding is not configured' });
      }

      const body = request.body;
      const sourceUri = body.inputs[0].uri;

      // Materialise the source as an asset so the encode is tracked in the MAM
      // exactly as a native /assets/:id/transcode would be. url-pull is the
      // closest sourceMethod: Encore reads the source directly from its URI.
      const asset = await repo.create({
        name: nameFromUri(sourceUri),
        sourceMethod: 'url-pull',
        originUri: sourceUri
      });

      // Resolve the profile by name if the caller supplied one. Only our known
      // presets are honoured; an unknown name falls through to submitTranscode's
      // default (resolveProfile handles undefined). Inline custom Encore
      // profiles are not translated here — a named preset covers the migration
      // path; custom-profile forwarding is a follow-up.
      const profileName = body.profile?.name;
      const preset = PRESET_NAMES.includes(profileName as PresetName)
        ? (profileName as PresetName)
        : undefined;

      // The scaler injects progressCallbackUri at dispatch time, pointing at the
      // callback listener paired with the chosen Encore instance (ADR-006), which
      // drives completion + our own webhooks. A caller-supplied
      // body.progressCallbackUri is not forwarded; polling GET /encoreJobs/:id
      // works today.
      try {
        const result = await submitTranscode(
          {
            workspaceId: DEPLOYMENT_CONTEXT,
            sourceAssetId: asset.id,
            // The source is read from its origin URI by Encore; the object key
            // is the URI so submitTranscode builds an s3:// input against the
            // source bucket. For s3:// sources this is the object path; for
            // https:// sources Encore fetches the URI directly.
            sourceObjectKey: sourceUri,
            preset,
            // Forward the compat request's top-level profileParams verbatim
            // (issue #289) so a parametrised profile reaches Encore's job
            // document intact, at parity with the native /:id/transcode route.
            // submitTranscode threads it into EncoreSubmitInput.profileParams
            // and toEncorePayload writes the Encore job document's top-level
            // `profileParams` object (src/pipeline/encore-client.ts:92). When
            // the caller omits it, this is undefined and the field is dropped
            // from the payload so Encore uses its `{}` default (unchanged).
            profileParams: body.profileParams,
            sourceBucket: opts.sourceBucket,
            outputBucket: opts.outputBucket
          },
          {
            jobs,
            assets: repo,
            encore: opts.encore
          }
        );
        return reply.code(200).send({
          id: result.encoreJobId,
          externalId: body.externalId ?? result.encoreJobId,
          status: 'QUEUED'
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: 'encore_submit_failed', message });
      }
    }
  );

  // Poll a submitted job's status in the native Encore shape. Looks the job up
  // by the encoreJobId we issued on submit (our correlation key).
  //   200 — Encore-shaped { id, externalId, status, message? }
  //   404 — unknown job id
  app.get(
    '/encoreJobs/:id',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: encoreJobResponseSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const found = await jobs.findByEncoreJobId(request.params.id);
      if (!found) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const job = found.job;
      return reply.code(200).send({
        id: request.params.id,
        externalId: request.params.id,
        status: toEncoreStatus(job.status),
        message: job.error
      });
    }
  );
};
