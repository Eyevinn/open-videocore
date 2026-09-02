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

import type { AssetRepository, ManifestUrls, PackagedOutput } from '../data/asset-repo.js';
import type { StorageBackendConfig } from '../services/param-store.js';

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

// Build the public manifest URLs for packaged output that was RELOCATED to a
// per-execution override destination (issue #208/#210). Unlike the default
// `manifestUrlsFor` (which assumes the provisioned packaged bucket + the
// deterministic `packaged/<assetId>` prefix), the location here is the resolved
// `{ bucket, prefix }` the relocation actually copied the CMAF/HLS/DASH objects
// to (recorded on the execution as `resolvedOutputLocation`). The deterministic
// manifest filenames are unchanged: relocation mirrors the packaged layout
// verbatim, so `index.m3u8` (HLS) and `manifest.mpd` (DASH) sit directly under
// the resolved prefix. `origin` is the same public origin used for the default
// case (see `packagingPublicBaseUrl`), with the destination bucket + prefix
// appended so the URL points at the override bucket rather than the default one.
export function manifestUrlsForLocation(
  location: { bucket: string; prefix: string },
  origin: string
): ManifestUrls {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const cleanPrefix = location.prefix.replace(/^\/+|\/+$/g, '');
  const segments = [cleanOrigin, location.bucket, cleanPrefix].filter(
    (s) => s.length > 0
  );
  const base = segments.join('/');
  return {
    hls: `${base}/index.m3u8`,
    dash: `${base}/manifest.mpd`
  };
}

// The public origin the packaged output is served from, WITHOUT the default
// bucket path segment `manifestUrlsFor`/`packagingPublicBaseUrl` bake in. Used
// to build URLs for a relocated override destination whose bucket differs from
// the provisioned packaged bucket (issue #210). When `PACKAGED_PUBLIC_BASE_URL`
// is set it is the full origin+bucket path (e.g. `https://cdn/packaged`); we
// strip the trailing default-bucket segment so the override bucket can be
// substituted. When unset the default base is `/<packagedBucket>`, whose origin
// is empty (a root-relative reference), matching the default case.
//
// NOTE: distinct from `packagedPublicOrigin` (issue #200) which returns the raw
// configured origin or undefined; this one strips the default-bucket segment so
// a relocation override bucket can be substituted, and always returns a string.
export function packagedRelocationOrigin(): string {
  const base = packagingPublicBaseUrl().replace(/\/+$/, '');
  const bucketSuffix = `/${packagedBucket()}`;
  if (base.endsWith(bucketSuffix)) {
    return base.slice(0, base.length - bucketSuffix.length);
  }
  if (base === packagedBucket() || base === `/${packagedBucket()}`) {
    return '';
  }
  return base;
}

// Derive the public base origin (scheme://host[:port][/prefix]) for objects in
// an EXTERNAL S3-compatible storage backend (issue #213). Precedence:
//   1. `publicBaseUrl` (an operator-supplied CDN/public origin fronting the
//      bucket) wins verbatim when set — the operator controls the emitted host.
//   2. Otherwise the URL is derived from `endpointUrl` + `bucket` using a
//      path-style address (`<endpointUrl>/<bucket>`), which every S3-compatible
//      store supports without DNS/vhost setup. `region` is not embedded in the
//      host here: a supplied `endpointUrl` is already the regional endpoint, and
//      path-style addressing keeps the derivation deterministic and
//      credential-free.
// Returns undefined when the backend is not external or lacks the coordinates
// needed to build a public URL (no publicBaseUrl and no endpointUrl) — the
// caller then falls back to the proxied path. NEVER embeds credentials.
export function externalPublicBaseUrl(
  backend: StorageBackendConfig | undefined
): string | undefined {
  if (!backend || backend.backend !== 'external') return undefined;
  if (backend.publicBaseUrl) {
    return backend.publicBaseUrl.replace(/\/+$/, '');
  }
  if (backend.endpointUrl) {
    const endpoint = backend.endpointUrl.replace(/\/+$/, '');
    return `${endpoint}/${backend.bucket.replace(/^\/+|\/+$/g, '')}`;
  }
  return undefined;
}

// Build a public object URL for a single stored object key against an external
// backend's public base (see externalPublicBaseUrl). The object key is appended
// as a path segment; the deterministic manifest names (index.m3u8 / manifest.mpd)
// are preserved by the caller. NEVER embeds credentials or signed query params.
export function externalObjectUrl(base: string, objectKey: string): string {
  return `${base.replace(/\/+$/, '')}/${objectKey.replace(/^\/+/, '')}`;
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

// Raised by `resolvePublicManifestUrl` when a stored manifest URL is not already
// public and `PACKAGED_PUBLIC_BASE_URL` is set but INVALID (not an absolute URL),
// so we cannot resolve the relative path to a public-facing origin. This is an
// explicit misconfiguration — distinct from the unset/zero-config case, which
// returns the stored value verbatim (issue #320). The delivery endpoint surfaces
// this as a clear 501 not_configured rather than a broken rewrite.
export class PublicManifestBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicManifestBaseUrlError';
  }
}

// The configured public-facing origin for the packaged bucket (MinIO/CDN), or
// undefined when `PACKAGED_PUBLIC_BASE_URL` is unset. Unlike
// `packagingPublicBaseUrl()` this does NOT fall back to a relative bucket path:
// callers that require a genuinely public origin (the delivery endpoint) must be
// able to distinguish "configured" from "unset".
export function packagedPublicOrigin(): string | undefined {
  const raw = process.env['PACKAGED_PUBLIC_BASE_URL'];
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  return raw;
}

// Resolve a stored manifest URL to a public-facing URL at read time (issue #200).
//
// `manifestUrls` are written at packaging time from `packagingPublicBaseUrl()`,
// which falls back to a RELATIVE `/<bucket>` path when `PACKAGED_PUBLIC_BASE_URL`
// is unset. A relative or internal-host URL is not fetchable by an external
// client, so we normalise here against the configured public origin:
//   - Already absolute AND same host as the public origin -> returned as-is.
//   - Relative (or an unparseable/relative-looking value)  -> resolved against
//     the public origin, preserving the stored path + query.
//   - Absolute with a DIFFERENT (internal) host            -> host + scheme
//     rewritten to the public origin, path + query preserved.
// When `PACKAGED_PUBLIC_BASE_URL` is genuinely UNSET (the default, zero-config
// state) we return the stored value verbatim — the pre-#200 behaviour — so an
// unconfigured MinIO-backed stack still serves its relative manifest reference
// instead of 501ing (issue #320). We only throw `PublicManifestBaseUrlError`
// when the origin is SET but not a usable absolute URL (explicit misconfig) and
// the stored value is relative, so the miswiring is surfaced explicitly.
export function resolvePublicManifestUrl(
  stored: string,
  publicOrigin: string | undefined = packagedPublicOrigin()
): string {
  const parsedStored = tryParseUrl(stored);

  // No configured public origin (PACKAGED_PUBLIC_BASE_URL unset/empty — the
  // default, zero-config state for a MinIO-backed stack). There is no target to
  // rewrite against, so we hand back the stored value verbatim in BOTH cases:
  //   - Already absolute -> returned as-is (we cannot know it is the public host
  //     but there is nothing to rewrite to).
  //   - Relative -> returned as-is too, restoring the pre-#200 behaviour where
  //     delivery echoed asset.manifestUrls unchanged. This avoids regressing the
  //     unconfigured stack into a 501 (issue #320); an operator who needs an
  //     externally-reachable origin sets PACKAGED_PUBLIC_BASE_URL.
  if (!publicOrigin) {
    return stored;
  }

  const parsedOrigin = tryParseUrl(publicOrigin);
  if (!parsedOrigin) {
    // Configured origin is itself not an absolute URL (e.g. a relative path).
    // It is not a usable public origin, so treat it like "unset".
    if (parsedStored) {
      return stored;
    }
    throw new PublicManifestBaseUrlError(
      `PACKAGED_PUBLIC_BASE_URL ("${publicOrigin}") is not an absolute URL and ` +
        'cannot be used to build a public-facing manifest URL. Set it to an ' +
        'absolute origin such as https://cdn.example.com/openvideocore-packaged.'
    );
  }

  // Relative stored value: join the public base and the stored path.
  if (!parsedStored) {
    const base = publicOrigin.replace(/\/+$/, '');
    const path = stored.startsWith('/') ? stored : `/${stored}`;
    return `${base}${path}`;
  }

  // Already absolute and pointing at the public host: nothing to rewrite.
  if (parsedStored.host === parsedOrigin.host) {
    return stored;
  }

  // Absolute but internal host: rewrite scheme + host to the public origin,
  // preserving the stored path + query + fragment.
  parsedStored.protocol = parsedOrigin.protocol;
  parsedStored.host = parsedOrigin.host;
  return parsedStored.toString();
}

function tryParseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
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
    // Durably persist the ACTUAL packaged-object location (issue #502): the
    // packaged bucket, the full job-nested prefix (`<assetId>/<packagerJobId>/`)
    // reported via `outputPath`, and the master HLS/DASH object keys. Delivery/
    // stream reads these to resolve the real manifest objects instead of a
    // derived flat path. Omitted (undefined) when the packager reported no
    // `outputPath`, so the record only ever holds a verified location.
    const packagedOutput = packagedOutputFromCallback(payload.outputPath, packagedBucket());
    await this.deps.assets.update(assetId, {
      manifestUrls,
      ...(packagedOutput ? { packagedOutput } : {})
    });
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

// The deterministic master-manifest filenames the packager's shaka-packager-s3
// backend produces under the output directory (HLS `index.m3u8`, DASH
// `manifest.mpd`). Kept as named constants so the manifest-URL builder and the
// packaged-output key derivation (issue #502) stay in lock-step and never drift.
export const MASTER_HLS_FILENAME = 'index.m3u8';
export const MASTER_DASH_FILENAME = 'manifest.mpd';

// Derive the durable packaged-output location (issue #502) from the packager
// callback's `outputPath`. `outputPath` is the packager's CMAF output DIRECTORY
// — the full, job-nested prefix it wrote every object under
// (`<assetId>/<packagerJobId>/`, from the packager's instance `OutputFolder` +
// `OutputSubfolderTemplate` default `$INPUTNAME$/$JOBID$`; verified in ADR-011
// and docs/osc-feedback/incoming-per-job-packager-output.md). We normalise it to
// an object-key prefix (no scheme/bucket, trailing slash) and append the
// deterministic master-manifest filenames to build the master HLS/DASH keys, so
// stream/delivery can resolve the REAL objects that exist.
//
// When `outputPath` is absent (a legacy packager or a callback that omits it) we
// return undefined — the asset then relies on the lazy-resolution fallback
// (`resolvePackagedPrefix`) at delivery time rather than persisting a guessed
// flat prefix. `bucket` is the effective packaged bucket for this deployment.
export function packagedOutputFromCallback(
  outputPath: string | undefined,
  bucket: string
): PackagedOutput | undefined {
  const prefix = normalizePackagedPrefix(outputPath, bucket);
  if (prefix === undefined) {
    return undefined;
  }
  return {
    bucket,
    prefix,
    masterHlsKey: `${prefix}${MASTER_HLS_FILENAME}`,
    masterDashKey: `${prefix}${MASTER_DASH_FILENAME}`
  };
}

// Normalise the packager's `outputPath` to a bucket-excluded, trailing-slash
// object-key prefix, or undefined when it carries no usable path. Handles the
// forms the packager may report:
//   - a full `s3://<bucket>/<assetId>/<jobId>/` URI (strips scheme + bucket),
//   - an absolute or relative path (`/<bucket>/<assetId>/<jobId>/` or
//     `<assetId>/<jobId>/`),
// stripping a leading `<bucket>/` segment so the returned prefix follows the
// bucket-excluded object-key convention (issue #342) that the `/:id/stream/*`
// proxy and relocation both use. A trailing slash is always present so callers
// can append a filename directly.
function normalizePackagedPrefix(
  outputPath: string | undefined,
  bucket?: string
): string | undefined {
  if (!outputPath) return undefined;
  let path = outputPath.trim();
  if (path.length === 0) return undefined;
  // Strip an s3://<bucket>/ (or any scheme://host/) prefix down to the path.
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i.exec(path);
  if (schemeMatch) {
    path = path.slice(schemeMatch[0].length);
  } else {
    path = path.replace(/^\/+/, '');
  }
  // Strip a leading bucket segment if present (bucket-excluded convention #342).
  const effectiveBucket = (bucket ?? packagedBucket()).replace(/^\/+|\/+$/g, '');
  if (effectiveBucket) {
    const bucketPrefix = `${effectiveBucket}/`;
    if (path.startsWith(bucketPrefix)) {
      path = path.slice(bucketPrefix.length);
    }
  }
  path = path.replace(/^\/+/, '');
  if (path.length === 0) return undefined;
  // Always terminate with a single trailing slash so it is an object-key prefix.
  return path.endsWith('/') ? path : `${path}/`;
}

// The minimal object-store list surface the lazy-resolution fallback needs. It
// mirrors `listObjectsV2(bucket, prefix, recursive) -> stream of { name }`
// (minio ^8.x; verified in src/pipeline/output-relocation.ts:29-40 and
// src/data/storage.ts:226) so the real MinioClient satisfies it and tests can
// inject a lightweight fake without a live object store.
export interface PackagedObjectLister {
  listObjectsV2(
    bucketName: string,
    prefix: string,
    recursive: boolean
  ): import('node:stream').Readable;
}

// Resolve an asset's packaged location for delivery/stream (issue #502).
//
// Preferred path: the durable `packagedOutput` persisted from the packager
// callback (`<assetId>/<packagerJobId>/` + master keys) — used verbatim, no
// object-store round-trip.
//
// Back-compat fallback: assets packaged BEFORE #502 have no persisted prefix.
// For those we lazily list the packaged bucket under `<assetId>/` and pick the
// NEWEST job prefix (lexicographically greatest immediate sub-segment — the
// packager's `$JOBID$` is a monotonic/ULID-like id, so the greatest is the most
// recent package), then derive the master keys under it. Returns undefined when
// nothing is found (the caller then falls back to its existing flat-prefix
// behaviour, unchanged).
export async function resolvePackagedOutput(
  asset: { id: string; packagedOutput?: PackagedOutput },
  lister: PackagedObjectLister,
  bucket: string = packagedBucket()
): Promise<PackagedOutput | undefined> {
  const persisted = asset.packagedOutput;
  if (persisted?.prefix) {
    return persisted;
  }
  const prefix = await lazyResolvePackagedPrefix(asset.id, lister, bucket);
  if (!prefix) return undefined;
  return {
    bucket,
    prefix,
    masterHlsKey: `${prefix}${MASTER_HLS_FILENAME}`,
    masterDashKey: `${prefix}${MASTER_DASH_FILENAME}`
  };
}

// List the packaged bucket under `<assetId>/` and return the newest job prefix
// (`<assetId>/<packagerJobId>/`), or undefined when the asset has no packaged
// objects. The newest job is the lexicographically greatest first path segment
// beneath `<assetId>/` — the packager's `$JOBID$` sorts monotonically. Errors
// from the lister reject so the caller can decide (it falls back to the flat
// prefix on failure).
async function lazyResolvePackagedPrefix(
  assetId: string,
  lister: PackagedObjectLister,
  bucket: string
): Promise<string | undefined> {
  const assetPrefix = `${assetId}/`;
  const keys = await listKeysUnderPrefix(lister, bucket, assetPrefix);
  let newestJob: string | undefined;
  for (const key of keys) {
    if (!key.startsWith(assetPrefix)) continue;
    const rest = key.slice(assetPrefix.length);
    const slash = rest.indexOf('/');
    // A direct object at `<assetId>/index.m3u8` (a legacy FLAT package, no job
    // subfolder) has no nested job segment — treat `<assetId>/` itself as the
    // prefix so those still resolve.
    if (slash < 0) {
      newestJob ??= '';
      continue;
    }
    const job = rest.slice(0, slash);
    if (newestJob === undefined || newestJob === '' || job > newestJob) {
      newestJob = job;
    }
  }
  if (newestJob === undefined) return undefined;
  return newestJob === '' ? assetPrefix : `${assetPrefix}${newestJob}/`;
}

function listKeysUnderPrefix(
  lister: PackagedObjectLister,
  bucket: string,
  prefix: string
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const keys: string[] = [];
    const stream = lister.listObjectsV2(bucket, prefix, true);
    stream.on('data', (obj: { name?: string }) => {
      if (obj.name) keys.push(obj.name);
    });
    stream.on('end', () => resolve(keys));
    stream.on('error', reject);
  });
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
