// Encore transcode client (issue #8).
//
// Encore is a long-lived OSC instance (provisioned as part of the stack, see
// services/stack.ts and routes/provision.ts) that exposes a REST API for
// submitting transcode jobs. Unlike the ephemeral eyevinn-ffmpeg-s3 probe job
// (issue #6), we do NOT create/remove an OSC instance per transcode — we POST a
// job to the already-running Encore instance and let the
// eyevinn-encore-callback-listener notify us on completion.
//
// This module declares a narrow EncoreClient interface plus an HTTP-backed
// implementation. The interface is injected into the transcode route so tests
// can substitute a fake without standing up Encore.

// What Encore needs to start a transcode: where to read the source, the
// server-side named profile to apply, where to write output, and the id we want
// echoed back via the callback listener so we can correlate the completion.
export type EncoreSubmitInput = {
  // Our correlation id. We pass this as Encore's externalId; the callback
  // listener echoes it back on completion. It embeds the workspace + job id
  // (see job-repo.encodeEncoreJobId).
  externalId: string;
  // If set, Encore will POST its job document here when the job completes.
  // Should point at POST /api/v1/internal/encore-callback on our API.
  progressCallbackUri?: string;
  // S3 URI of the source object Encore should read (s3://bucket/key).
  inputUri: string;
  // S3 URI prefix where Encore should write the produced renditions.
  outputUri: string;
  // Named profile string forwarded verbatim to Encore (server-side resolution).
  profile: string;
};

export type EncoreSubmitResult = {
  // Encore's own internal job id. Recorded for operator traceability; the
  // correlation key we rely on is the externalId we supplied.
  encoreInternalId: string;
};

export interface EncoreClient {
  submit(input: EncoreSubmitInput): Promise<EncoreSubmitResult>;
  // Poll Encore for the current status of a job by its internal Encore id.
  // Returns a normalized JobStatus string, or undefined if the job is unknown.
  getJobStatus(encoreJobId: string): Promise<string | undefined>;
  // Request cancellation of an in-flight Encore job by its internal Encore id.
  // Contract: POST {baseUrl}/encoreJobs/{jobId}/cancel — SVT Encore
  // EncoreController.kt (github.com/svt/encore, encore-web/.../controller/
  // EncoreController.kt), verified 2026-07-09. Only NEW/QUEUED/IN_PROGRESS jobs
  // are cancellable; cancelling an already-gone/terminal job is a no-op.
  cancel(encoreJobId: string): Promise<void>;
}

// Configuration for the HTTP-backed client. The base URL is the provisioned
// Encore instance URL; the service access token authenticates the call.
export type HttpEncoreConfig = {
  baseUrl: string;
  // Resolves a fresh OSC service access token for Encore on each submit.
  getToken: () => Promise<string>;
  // Injectable fetch for tests; defaults to global fetch.
  fetch?: typeof globalThis.fetch;
};

// Map our EncoreProfile to Encore's job-creation payload.
//
// SMOKE TEST CONFIRMED (2026-06-01): Encore's API schema has NO top-level
// `outputs` field. Profiles are server-side named configurations — the profile
// name string is the only way to select a ladder. `profileParams` may be used
// to evaluate SpEL expressions within the profile if needed.
//
// Our preset names (abr-1080p, abr-720p, abr-480p) must match profiles
// registered in the provisioned Encore instance. The only confirmed built-in
// profile name is "program". See OSC friction log incoming-issue8-transcode.md.
export function toEncorePayload(input: EncoreSubmitInput): Record<string, unknown> {
  return {
    externalId: input.externalId,
    ...(input.progressCallbackUri ? { progressCallbackUri: input.progressCallbackUri } : {}),
    profile: input.profile,
    outputFolder: input.outputUri,
    baseName: 'rendition',
    inputs: [{ uri: input.inputUri, type: 'AudioVideo' }]
    // NOTE: no `outputs` field — Encore profiles are server-side only.
    // profileParams can be added here if the profile uses SpEL expressions.
  };
}

// Map Encore's status strings to our internal job status.
function normalizeEncoreStatus(encoreStatus: string): string | undefined {
  const s = encoreStatus.toUpperCase();
  if (s === 'SUCCESSFUL') return 'done';
  if (s === 'FAILED' || s === 'CANCELLED') return 'failed';
  if (s === 'IN_PROGRESS' || s === 'QUEUED') return 'running';
  return undefined;
}

export function makeHttpEncoreClient(config: HttpEncoreConfig): EncoreClient {
  const doFetch = config.fetch ?? globalThis.fetch;
  return {
    async getJobStatus(encoreJobId: string): Promise<string | undefined> {
      const token = await config.getToken();
      const res = await doFetch(`${config.baseUrl.replace(/\/$/, '')}/encoreJobs/${encoreJobId}`, {
        headers: { authorization: `Bearer ${token}` }
      });
      // 404 means Encore cleaned up the job (typically happens after success).
      // We cannot distinguish success from failure here, so return undefined
      // and let the caller decide (don't overwrite a known status).
      if (res.status === 404) return undefined;
      if (!res.ok) return undefined;
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      return body.status ? normalizeEncoreStatus(body.status) : undefined;
    },
    async submit(input: EncoreSubmitInput): Promise<EncoreSubmitResult> {
      const token = await config.getToken();
      const res = await doFetch(`${config.baseUrl.replace(/\/$/, '')}/encoreJobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(toEncorePayload(input))
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Encore job submission failed: ${res.status} ${text}`.trim());
      }
      const body = (await res.json().catch(() => ({}))) as { id?: string; jobId?: string };
      return { encoreInternalId: String(body.id ?? body.jobId ?? '') };
    },
    async cancel(encoreJobId: string): Promise<void> {
      // POST {baseUrl}/encoreJobs/{jobId}/cancel — SVT Encore
      // EncoreController.kt (github.com/svt/encore, encore-web/.../controller/
      // EncoreController.kt), verified 2026-07-09. No request body.
      const token = await config.getToken();
      const res = await doFetch(
        `${config.baseUrl.replace(/\/$/, '')}/encoreJobs/${encoreJobId}/cancel`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` }
        }
      );
      // Idempotent no-op: 404 = job already gone, 409 = job in a terminal /
      // non-cancellable state. Cancelling an already-finished job must not error.
      if (res.status === 404 || res.status === 409) return;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Encore job cancellation failed: ${res.status} ${text}`.trim());
      }
    }
  };
}
