// Default SubtitleGenerator backed by the OSC eyevinn-auto-subtitles service
// (issue #114).
//
// eyevinn-auto-subtitles ("Subtitle Generator") is a Whisper-based transcription
// SERVICE. Unlike eyevinn-ffmpeg-s3 (an ephemeral job runner via createJob/
// removeJob), it is a LONG-LIVED instance we call over HTTP at its instance URL.
// This runner resolves that instance URL (getInstance().url) and its service
// access token, then POSTs the transcription request to the service's
// `/transcribe/s3` endpoint.
//
// !!! WIRE SHAPE NOT CONTRACT-VERIFIED !!!
// The get-service-schema tool describes the create-service-instance CONFIG for
// eyevinn-auto-subtitles (required `name` (^\w+$) + `openaikey`; optional
// awsAccessKeyId/awsSecretAccessKey/awsRegion/s3Endpoint) and that the service
// exposes a `/transcribe/s3` endpoint — but it does NOT pin down the exact
// request/response BODY shape of that endpoint. That un-verified wire shape is
// deliberately ISOLATED in this file (behind the injected SubtitleGenerator
// interface from subtitle-generator.ts) so it can be corrected in one place, or
// swapped for a stub, without touching the fire-and-forget orchestration. The
// request/response mapping below encodes our best-effort assumption:
//   request : { url: <presigned source>, language?, format? } (+ output hint)
//   response: either the subtitle body as text, or a JSON envelope carrying it.
// When the service is wired to the same S3 as our MinIO bucket it may instead
// write the result object itself; in that case set OSC_AUTO_SUBTITLES_WRITES_S3
// so we return `{ written: true }` and let the service's own upload stand.
//
// Contract sources:
//   - get-service-schema `eyevinn-auto-subtitles` (config + /transcribe/s3).
//   - services/stack.ts AUTO_SUBTITLES_SERVICE_ID.

import { getInstance, type Context } from '@osaas/client-core';
import { AUTO_SUBTITLES_SERVICE_ID } from '../services/stack.js';
import type {
  SubtitleGenerator,
  SubtitleGeneratorParams,
  SubtitleGeneratorResult
} from './subtitle-generator.js';

// Subset of the OSC SDK surface this runner needs, declared structurally so the
// real SDK functions satisfy it and callers can pass lightweight fakes (mirrors
// OscJobApi in osc-ffprobe.ts / osc-clip.ts). We only need instance resolution
// (to find the service URL) and the context's service-access-token minting.
export type OscSubtitleApi = {
  context: Context;
  getInstance: typeof getInstance;
  // The long-lived instance name to call. auto-subtitles is provisioned
  // separately (it needs an OpenAI key), so the deployment supplies the name it
  // created; there is no per-request instance.
  instanceName: string;
  // Whether the service writes the subtitle object to S3 itself. When true we
  // skip the upload path and return `{ written: true }`. Defaults to false.
  writesToS3?: boolean;
  // Injectable fetch for tests; defaults to the global fetch.
  fetchImpl?: typeof fetch;
};

// Build the JSON request body for `/transcribe/s3`. Kept in one function so the
// (unverified) field names are easy to correct once the real contract is known.
export function transcribeRequestBody(params: SubtitleGeneratorParams): Record<string, unknown> {
  return {
    // Presigned GET URL of the source media. `url` mirrors the ffmpeg-s3 `-i`
    // convention; the S3 endpoint accepts an addressable source.
    url: params.presignedSourceUrl,
    // Requested output format (Whisper commonly emits WebVTT).
    format: params.format,
    // Destination object key hint, used when the service writes to S3 itself.
    outputKey: params.destinationKey
  };
}

// Resolve the base URL of the long-lived auto-subtitles instance. Throws when
// the instance cannot be resolved so the orchestrator records a clear error.
async function resolveInstanceUrl(api: OscSubtitleApi, token: string): Promise<string> {
  const instance = await api.getInstance(
    api.context,
    AUTO_SUBTITLES_SERVICE_ID,
    api.instanceName,
    token
  );
  const url = (instance as { url?: string } | undefined)?.url;
  if (!url) {
    throw new Error(
      `auto-subtitles instance "${api.instanceName}" has no resolvable URL`
    );
  }
  return url.replace(/\/+$/, '');
}

// Construct the production SubtitleGenerator. Each invocation resolves the
// service token + instance URL, POSTs the transcription request, and returns
// either the subtitle body (for the orchestrator to upload) or `{ written: true }`
// when the service writes to S3 itself.
export function makeOscSubtitleGenerator(api: OscSubtitleApi): SubtitleGenerator {
  const doFetch = api.fetchImpl ?? fetch;
  return async (params: SubtitleGeneratorParams): Promise<SubtitleGeneratorResult> => {
    const token = await api.context.getServiceAccessToken(AUTO_SUBTITLES_SERVICE_ID);
    const baseUrl = await resolveInstanceUrl(api, token);

    const res = await doFetch(`${baseUrl}/transcribe/s3`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // OSC terminates service auth at the edge using the SAT bearer.
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(transcribeRequestBody(params))
    });
    if (!res.ok) {
      throw new Error(`auto-subtitles /transcribe/s3 failed: HTTP ${res.status}`);
    }

    // When the service uploads the result to S3 itself, the object is already at
    // destinationKey — nothing for us to upload.
    if (api.writesToS3) {
      return { written: true, format: params.format };
    }

    // Otherwise the service returns the subtitle body. Accept either a raw text
    // body or a JSON envelope with a `content`/`subtitles` field, since the exact
    // response shape is not contract-verified (see file header).
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const json = (await res.json()) as {
        content?: string;
        subtitles?: string;
        language?: string;
        format?: string;
      };
      const content = json.content ?? json.subtitles;
      if (content === undefined) {
        throw new Error('auto-subtitles response JSON carried no subtitle content');
      }
      return {
        content,
        language: json.language,
        format: (json.format as SubtitleGeneratorResult['format']) ?? params.format
      };
    }
    const text = await res.text();
    return { content: text, format: params.format };
  };
}
