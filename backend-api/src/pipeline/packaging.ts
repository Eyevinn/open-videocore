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
import { assertValidWorkspaceId } from '../data/guard.js';

// The bucket the packager writes streaming output into (mirrors PACKAGED_BUCKET
// in routes/provision.ts and the packager's OutputFolder).
export const DEFAULT_PACKAGED_BUCKET = 'openvideocore-packaged';

export function packagedBucket(): string {
  return process.env['MINIO_PACKAGED_BUCKET'] ?? DEFAULT_PACKAGED_BUCKET;
}

// A correlation id carried through the queue + packager callback so a
// completion event can be mapped back to the originating asset. It is the
// workspace-namespaced asset id, so it cannot collide across workspaces and
// leaks no more than the asset id already does to its owner.
export function packagingId(workspaceId: string, assetId: string): string {
  assertValidWorkspaceId(workspaceId);
  return `${workspaceId}:${assetId}`;
}

// Parse a packagingId back into its parts. Returns undefined for a malformed
// value so a forged callback payload cannot crash the handler.
export function parsePackagingId(
  id: string
): { workspaceId: string; assetId: string } | undefined {
  const idx = id.indexOf(':');
  if (idx <= 0 || idx === id.length - 1) {
    return undefined;
  }
  const workspaceId = id.slice(0, idx);
  const assetId = id.slice(idx + 1);
  try {
    assertValidWorkspaceId(workspaceId);
  } catch {
    return undefined;
  }
  return { workspaceId, assetId };
}

// The deterministic output prefix (inside the packaged bucket) where the
// packager writes this asset's CMAF segments + manifests. Workspace-prefixed so
// packaged output is partitioned the same way source objects are.
export function outputPrefix(workspaceId: string, assetId: string): string {
  assertValidWorkspaceId(workspaceId);
  return `${workspaceId}/packaged/${assetId}`;
}

// Build the public manifest URLs for an asset's packaged output. CMAF means HLS
// and DASH reference the same underlying media segments under one prefix; only
// the manifest filenames differ. `baseUrl` is the publicly reachable MinIO/CDN
// origin for the packaged bucket (config via env). When the packager reports
// explicit manifest paths in its callback we prefer those (see handleCallback).
export function manifestUrlsFor(workspaceId: string, assetId: string, baseUrl: string): ManifestUrls {
  const base = `${baseUrl.replace(/\/+$/, '')}/${outputPrefix(workspaceId, assetId)}`;
  return {
    hls: `${base}/index.m3u8`,
    dash: `${base}/manifest.mpd`
  };
}

// One Encore output rendition (a transcoded ABR variant) as reported by the
// Encore callback. Kept permissive — the callback handler (issue #8) forwards
// whatever Encore produced; the packager consumes the segment/object locations.
export type EncoreOutput = {
  // The MinIO object key / URI of a transcoded rendition.
  file: string;
  // Optional rendition hints (bitrate, resolution) when Encore supplies them.
  type?: string;
};

// The job enqueued onto the Valkey queue for the packager to consume.
export type PackagingJob = {
  packagingId: string;
  workspaceId: string;
  assetId: string;
  // Where the packager should write CMAF output (inside the packaged bucket).
  outputPrefix: string;
  // The transcoded renditions to package.
  inputs: EncoreOutput[];
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
    workspaceId: string,
    assetId: string,
    encoreOutputs: EncoreOutput[]
  ): Promise<void>;
}

// The shape of the packager's completion callback (POST .../packager-callback).
// `status` distinguishes success from failure. On success the packager MAY
// report explicit manifest object keys; when it does not we fall back to the
// deterministic CMAF manifest names under the output prefix.
export type PackagerCallbackPayload = {
  packagingId: string;
  status: 'success' | 'failed';
  // Explicit manifest object keys (relative to the packaged bucket) when known.
  hlsManifest?: string;
  dashManifest?: string;
  // Failure reason when status === 'failed'.
  error?: string;
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

export class PackagingService implements PackagingTrigger {
  constructor(private readonly deps: PackagingDeps) {}

  // Invoked from the Encore callback handler (issue #8) when a transcode
  // succeeds. Enqueues a packaging job for the packager. NEVER throws into the
  // caller: a queue failure is recorded as `packagingError` on the asset (which
  // does not change the asset status) so the callback handler stays simple and
  // a packaging hiccup cannot fail the transcode-completion path. Idempotent:
  // the job is keyed by packagingId so a redelivered transcode callback
  // re-enqueues the same deterministic job/output rather than forking output.
  async triggerPackaging(
    workspaceId: string,
    assetId: string,
    encoreOutputs: EncoreOutput[]
  ): Promise<void> {
    try {
      const job: PackagingJob = {
        packagingId: packagingId(workspaceId, assetId),
        workspaceId,
        assetId,
        outputPrefix: outputPrefix(workspaceId, assetId),
        inputs: encoreOutputs
      };
      await this.deps.queue.enqueue(job);
    } catch (err) {
      this.deps.onError?.(err);
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.deps.assets.update(workspaceId, assetId, {
          packagingError: `failed to enqueue packaging job: ${message}`
        });
      } catch {
        // Detached safety: nothing more we can do if the error write also fails.
      }
    }
  }

  // Invoked by POST /api/v1/internal/packager-callback when the packager
  // signals completion. Resolves the packagingId to a workspace+asset, then
  // writes manifestUrls (success) or packagingError (failure). Returns whether
  // the callback resolved to a known asset so the route can answer 200/404.
  // NEVER changes the asset's lifecycle status.
  async handleCallback(payload: PackagerCallbackPayload): Promise<boolean> {
    const parsed = parsePackagingId(payload.packagingId);
    if (!parsed) {
      return false;
    }
    const { workspaceId, assetId } = parsed;
    const asset = await this.deps.assets.get(workspaceId, assetId);
    if (!asset) {
      return false;
    }

    if (payload.status === 'failed') {
      await this.deps.assets.update(workspaceId, assetId, {
        packagingError: payload.error ?? 'packaging failed'
      });
      return true;
    }

    // Success: prefer explicit manifest paths from the packager; otherwise fall
    // back to the deterministic CMAF manifest names under the output prefix.
    const base = this.deps.publicBaseUrl ?? packagingPublicBaseUrl();
    const fallback = manifestUrlsFor(workspaceId, assetId, base);
    const origin = base.replace(/\/+$/, '');
    const manifestUrls: ManifestUrls = {
      hls: payload.hlsManifest ? `${origin}/${stripLeadingSlash(payload.hlsManifest)}` : fallback.hls,
      dash: payload.dashManifest
        ? `${origin}/${stripLeadingSlash(payload.dashManifest)}`
        : fallback.dash
    };
    await this.deps.assets.update(workspaceId, assetId, { manifestUrls });
    return true;
  }
}

function stripLeadingSlash(s: string): string {
  return s.replace(/^\/+/, '');
}
