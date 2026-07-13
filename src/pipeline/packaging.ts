// HLS/DASH packaging pipeline (issue #9).
//
// After Encore finishes transcoding an asset's ABR ladder, the
// eyevinn-encore-callback-listener bridges the completion event onto the Valkey
// queue and the eyevinn-encore-packager consumes it, producing CMAF-packaged
// HLS + DASH manifests (shared media segments) under the packaged MinIO bucket.
//
// This module owns the open-videocore side of that flow:
//   1. `PackagingService.triggerPackaging(...)` is invoked from the Encore
//      callback handler (issue #8) when a transcode succeeds. It computes the
//      deterministic packaged-output prefix for the asset, enqueues a packaging
//      job onto the Valkey queue for the packager to pick up, and records the
//      correlation so the later packager callback can be mapped back to the
//      asset. It is decoupled from issue #8 via the `PackagingTrigger`
//      interface — the callback handler only depends on that interface.
//   2. `PackagingService.handleCallback(...)` is invoked by the
//      POST /api/v1/internal/packager-callback route when the packager signals
//      completion. On success it writes `manifestUrls` (HLS + DASH) onto the
//      asset; on failure it records `packagingError`. Packaging NEVER changes
//      the asset's lifecycle status — it only annotates the record.
//
// DECOUPLING NOTE: the eyevinn-encore-packager already consumes the Valkey
// queue populated by the callback-listener, so in a fully reference-wired stack
// it can package without an explicit enqueue from us. We still enqueue our own
// job entry (idempotently keyed by packagingId) so that (a) the output path is
// under our control and deterministic, and (b) the work is observable and
// resumable on our side rather than depending solely on the listener's
// behaviour. The queue contract for the packager is not formally documented in
// the OSC catalog — see docs/osc-feedback/incoming-issue9-packaging.md.

import type { AssetRepository, ManifestUrls } from '../data/asset-repo.js';

// The bucket the packager writes streaming output into (mirrors PACKAGED_BUCKET
// in routes/provision.ts and the packager's OutputFolder).
export const DEFAULT_PACKAGED_BUCKET = 'openvideocore-packaged';

export function packagedBucket(): string {
  return process.env['MINIO_PACKAGED_BUCKET'] ?? DEFAULT_PACKAGED_BUCKET;
}

// A correlation id carried through the queue + packager callback so a
// completion event can be mapped back to the originating asset. It is the
// asset id (OSC provides structural isolation, so no workspace namespace).
export function packagingId(assetId: string): string {
  return assetId;
}

// Parse a packagingId back into its parts. Returns undefined for a malformed
// value so a forged callback payload cannot crash the handler.
export function parsePackagingId(
  id: string
): { assetId: string } | undefined {
  if (!id || id.length === 0) {
    return undefined;
  }
  return { assetId: id };
}

// The deterministic output prefix (inside the packaged bucket) where the
// packager writes this asset's CMAF segments + manifests.
export function outputPrefix(assetId: string): string {
  return `packaged/${assetId}`;
}

// Build the public manifest URLs for an asset's packaged output. CMAF means HLS
// and DASH reference the same underlying media segments under one prefix; only
// the manifest filenames differ. `baseUrl` is the publicly reachable MinIO/CDN
// origin for the packaged bucket (config via env). When the packager reports
// explicit manifest paths in its callback we prefer those (see handleCallback).
export function manifestUrlsFor(assetId: string, baseUrl: string): ManifestUrls {
  const base = `${baseUrl.replace(/\/+$/, '')}/${outputPrefix(assetId)}`;
  return {
    hls: `${base}/index.m3u8`,
    dash: `${base}/manifest.mpd`
  };
}

// The job enqueued onto the Valkey sorted-set queue for the packager to consume.
// CONTRACT (verified from encore-packager redisListener.ts 2026-07-07):
//   { jobId: string, url: string }
//   - jobId: our correlation id returned verbatim in the packager callback
//   - url:   the Encore job API URL the packager fetches output details from
export type PackagingJob = {
  jobId: string;
  url: string;
};

// The queue publisher. Default implementation is Valkey/Redis-backed
// (see osc-packager-queue.ts); injected so tests can assert enqueue without a
// live Valkey, and so the transport stays swappable.
export interface PackageQueue {
  enqueue(job: PackagingJob): Promise<void>;
}

// The interface issue #8's Encore callback handler depends on. Keeping the
// callback handler coupled only to this (not to PackagingService) keeps the two
// features decoupled: #8 calls triggerPackaging when a transcode succeeds and
// never needs to know how packaging is wired.
export interface PackagingTrigger {
  triggerPackaging(
    assetId: string,
    encoreJobUrl: string
  ): Promise<void>;
}

// Success callback payload from the packager (POST .../packagerCallback/success).
// CONTRACT (verified from encore-packager callbackListener.ts 2026-07-07):
//   { url: string, jobId: string, outputPath?: string }
//   - url:        the Encore job URL that was packaged
//   - jobId:      echoed back from the queue message (= assetId in our usage)
//   - outputPath: S3/local path of the packager's CMAF output directory
export type PackagerSuccessPayload = {
  url: string;
  jobId: string;
  outputPath?: string;
};

// Failure callback payload from the packager (POST .../packagerCallback/failure).
export type PackagerFailurePayload = {
  message: string;
};

export type PackagingDeps = {
  assets: AssetRepository;
  queue: PackageQueue;
  // Public origin for the packaged bucket (MinIO/CDN). Used to build manifest
  // URLs. Config via env; defaults to a relative path so a missing origin still
  // yields a usable, resolvable manifest reference.
  publicBaseUrl?: string;
  // Test observability hook fired on a recorded packaging failure.
  onError?: (err: unknown) => void;
};

export function packagingPublicBaseUrl(): string {
  return process.env['PACKAGED_PUBLIC_BASE_URL'] ?? `/${packagedBucket()}`;
}

// Delivery mode selects HOW packaged output is exposed to players (issue #201).
//   - 'public': the packaged bucket is anonymously readable and delivery
//     advertises the already-public CMAF manifest URLs (default; the existing
//     behaviour).
//   - 'proxy':  the packaged bucket stays private and packaged objects are
//     streamed back through an authorized API route. Delivery advertises those
//     proxy URLs instead, so no anonymous bucket read is required (useful for
//     multi-tenant deployments).
// The two modes are mutually selectable — never both active — because they have
// deliberately different security postures. Config via env (12-factor), mirrors
// how packagingPublicBaseUrl() reads PACKAGED_PUBLIC_BASE_URL above.
export const DELIVERY_MODES = ['public', 'proxy'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export function deliveryMode(): DeliveryMode {
  const raw = process.env['DELIVERY_MODE']?.trim().toLowerCase();
  if (raw === 'proxy') {
    return 'proxy';
  }
  // Anything unset/unrecognised falls back to the safe, backwards-compatible
  // default so an existing public-bucket deployment is unaffected.
  return 'public';
}

// The URL prefix (relative to the assets router) under which packaged objects
// are streamed back through the proxy route. Segment/manifest relative
// references resolve under this prefix because the manifest is itself served
// from `<prefix>/index.m3u8`.
export function proxyStreamPrefix(assetId: string): string {
  return `${assetId}/stream`;
}

// Build the proxy manifest URLs for an asset's packaged output (issue #201).
// `apiBaseUrl` is the publicly reachable origin of THIS API (config via env,
// PUBLIC_BASE_URL) up to and including the assets-router mount point, e.g.
// `https://api.example/api/v1/assets`. When absent we fall back to a relative
// path so a same-origin player still resolves the manifest and its (relative)
// segment references back through the proxy.
export function proxyManifestUrlsFor(assetId: string, apiBaseUrl: string): ManifestUrls {
  const base = `${apiBaseUrl.replace(/\/+$/, '')}/${proxyStreamPrefix(assetId)}`;
  return {
    hls: `${base}/index.m3u8`,
    dash: `${base}/manifest.mpd`
  };
}

export class PackagingService implements PackagingTrigger {
  constructor(private readonly deps: PackagingDeps) {}

  // Invoked from the Encore callback handler (issue #8) when a transcode
  // succeeds. Enqueues a packaging job for the packager. NEVER throws into the
  // caller: a queue failure is recorded as `packagingError` on the asset.
  // The job format matches the packager's sorted-set contract: { jobId, url }.
  // We use assetId as jobId so the callback can resolve back to the asset.
  async triggerPackaging(
    assetId: string,
    encoreJobUrl: string
  ): Promise<void> {
    try {
      const job: PackagingJob = {
        jobId: assetId,
        url: encoreJobUrl
      };
      await this.deps.queue.enqueue(job);
    } catch (err) {
      this.deps.onError?.(err);
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.deps.assets.update(assetId, {
          packagingError: `failed to enqueue packaging job: ${message}`
        });
      } catch {
        // Detached safety: nothing more we can do if the error write also fails.
      }
    }
  }

  // Invoked by POST /api/v1/internal/packagerCallback/success when the packager
  // signals successful completion. The jobId in the payload is the assetId we
  // used when enqueueing. Writes manifestUrls onto the asset.
  // NEVER changes the asset's lifecycle status.
  async handleSuccess(payload: PackagerSuccessPayload): Promise<boolean> {
    const assetId = payload.jobId; // we set jobId = assetId at enqueue time
    const asset = await this.deps.assets.get(assetId);
    if (!asset) return false;

    const base = this.deps.publicBaseUrl ?? packagingPublicBaseUrl();
    // outputPath from the packager is the S3/local directory (e.g.
    // "/rendition_x264_3100/job-abc/"). Append known shaka-packager-s3 manifest
    // filenames to construct public URLs. Falls back to our deterministic names.
    const manifestUrls = outputPathToManifestUrls(payload.outputPath, base, assetId);
    await this.deps.assets.update(assetId, { manifestUrls });
    return true;
  }

  // Invoked by POST /api/v1/internal/packagerCallback/failure.
  async handleFailure(assetId: string, message: string): Promise<boolean> {
    const asset = await this.deps.assets.get(assetId);
    if (!asset) return false;
    await this.deps.assets.update(assetId, { packagingError: message });
    return true;
  }
}

// Build manifest URLs from the packager's reported outputPath. The packager's
// shaka-packager-s3 backend produces index.m3u8 (HLS) and manifest.mpd (DASH)
// by default under the output directory. When outputPath is absent we fall back
// to the deterministic names under our own outputPrefix.
function outputPathToManifestUrls(
  outputPath: string | undefined,
  publicBaseUrl: string,
  assetId: string
): ManifestUrls {
  const origin = publicBaseUrl.replace(/\/+$/, '');
  if (outputPath) {
    const dir = outputPath.replace(/\/+$/, '');
    return {
      hls: `${origin}${dir}/index.m3u8`,
      dash: `${origin}${dir}/manifest.mpd`
    };
  }
  return manifestUrlsFor(assetId, publicBaseUrl);
}
