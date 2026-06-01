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

import type { EncoreProfile } from './encode-presets.js';

// What Encore needs to start an ABR transcode: where to read the source, the
// ladder to produce, where to write output, and the id we want echoed back to
// us via the callback listener so we can correlate the completion.
export type EncoreSubmitInput = {
  // Our correlation id. We pass this as Encore's externalId; the callback
  // listener echoes it back on completion. It embeds the workspace + job id
  // (see job-repo.encodeEncoreJobId).
  externalId: string;
  // S3 URI of the source object Encore should read (s3://bucket/key).
  inputUri: string;
  // S3 URI prefix where Encore should write the produced renditions.
  outputUri: string;
  // The resolved ABR ladder.
  profile: EncoreProfile;
};

export type EncoreSubmitResult = {
  // Encore's own internal job id. Recorded for operator traceability; the
  // correlation key we rely on is the externalId we supplied.
  encoreInternalId: string;
};

export interface EncoreClient {
  submit(input: EncoreSubmitInput): Promise<EncoreSubmitResult>;
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
    profile: input.profile.name,
    outputFolder: input.outputUri,
    baseName: 'rendition',
    inputs: [{ uri: input.inputUri, type: 'AudioVideo' }]
    // NOTE: no `outputs` field — Encore profiles are server-side only.
    // profileParams can be added here if the profile uses SpEL expressions.
  };
}

export function makeHttpEncoreClient(config: HttpEncoreConfig): EncoreClient {
  const doFetch = config.fetch ?? globalThis.fetch;
  return {
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
    }
  };
}
