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
//      the asset's lifecycle status — it only annotates the record. Since
//      #1265 packaging completion also SETTLES protection when the completing
//      run carried encryption: a pending `asset.drm` becomes `protected` (with
//      `protectedAt`) in the success callback's own write (`handleSuccess`), and
//      `failed` wherever the failure is actually attributed — the packager's
//      failure callback and the stalled-package sweep, which both correlate the
//      failure themselves and call `settleProtectionFailure` beside their
//      `failPackageJob` (src/routes/internal.ts POST /packagerCallback/failure,
//      src/pipeline/stalled-package-reconciler.ts). See
//      `settleDrmOnPackagerSuccess` / `settleDrmOnPackagerFailure`.
//   3. Both of the above keep an observable `package` Job in step (issue #976):
//      created at enqueue time and settled from the completion callbacks, so the
//      step that produces the customer-facing output is listed by
//      GET /api/v1/jobs like every other step. The lifecycle lives in
//      src/pipeline/package-job.ts, shared with the OSC-native handoff in
//      encore-callback-poller.ts, the packager failure callback, and #336's
//      stalled-package sweep.
//
// DECOUPLING NOTE: the eyevinn-encore-packager already consumes the Valkey
// queue populated by the callback-listener, so in a fully reference-wired stack
// it can package without an explicit enqueue from us. We still enqueue our own
// job entry (idempotently keyed by packagingId) so that (a) the output path is
// under our control and deterministic, and (b) the work is observable and
// resumable on our side rather than depending solely on the listener's
// behaviour. The queue contract for the packager is not formally documented in
// the OSC catalog — see docs/osc-feedback/incoming-issue9-packaging.md.

import type {
  AssetDrm,
  AssetRepository,
  ManifestUrls,
  PackagedOutput
} from '../data/asset-repo.js';
import type { JobRepository } from '../data/job-repo.js';
import type { PipelineExecution, PipelineRepository } from '../data/pipeline-repo.js';
import type { ParamStore, StorageBackendConfig } from '../services/param-store.js';
import type {
  DrmErrorCode,
  DrmSystemId,
  ProtectionScheme,
  TrackTypeGroup
} from '../types/drm.js';
import type {
  ContentKey,
  DrmSignalling,
  KeyProvider,
  KeyRequest
} from '../drm/key-provider.js';
import { resolveDrmSystemIds } from '../drm/key-provider.js';
import type { DrmStackConfig } from '../drm/drm-config.js';
import {
  DRM_NOT_CONFIGURED_PAYLOAD,
  DRM_NOT_CONFIGURED_STATUS,
  loadDrmStackConfig,
  readDrmCredentialStatus
} from '../drm/drm-config.js';
import { isKeyProviderError } from '../drm/key-provider-error.js';
import { emitAudit, originActor, type AuditEmitter, type AuditErrorLog } from '../data/audit-emit.js';
import { logPipelineEvent, type PipelineLogSink } from '../services/pipeline-log.js';
import {
  completePackageJob,
  failPackageJob,
  resolvePackageJobId,
  startPackageJob,
  type PackageJobDeps
} from './package-job.js';

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

// ---------------------------------------------------------------------------
// EncryptingPackagingRunner — the packaging port that CAN carry encryption
// (ADR-008 §7.1, decision D8; issue #1263).
//
// WHY A SECOND PORT AND NOT A WIDER `PackageQueue`. `PackageQueue.enqueue`
// above is the contract the deployed packaging library actually understands:
// `{ jobId, url }` and nothing else (verified from its own redisListener, see
// `PackagingJob`). Encryption is a capability the deployed library does NOT
// have today, so the clear path must stay byte-identical while the encrypting
// shape exists as a declared, testable superset. `PackagingJob` is therefore
// UNCHANGED and every encrypting job is `PackagingJob & { encryption? }` — a
// strict superset, so the existing queue adapter and every pre-existing
// packaging test keep working untouched.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
//   - `PackagingJob` / `PackageQueue` — this file, :187-197 (the queue envelope
//     verified against the packaging library's redisListener.ts).
//   - `ProtectionScheme`, `DrmSystemId`, `DrmErrorCode` — src/types/drm.ts
//     (`PROTECTION_SCHEMES`, `DrmSystemId` + `DRM_SYSTEM_ID_PATTERN`,
//     `DRM_ERROR_CODES` which already contains `'drm_unsupported'`).
//   - `KeyProvider`, `KeyRequest`, `ContentKey`, `DrmSignalling` —
//     src/drm/key-provider.ts:74-165.
//   - The per-execution request shape — `PipelineExecution['drm']`
//     (`{ requested: true; providerId?; systems?; scheme? }`),
//     src/data/pipeline-repo.ts:100, cloned by `cloneDrmRequest` there.
//
// DEVIATION FROM THE ISSUE TEXT, name only: issue #1263 writes the capability
// and parameter types in terms of `DrmSystem`. No such symbol exists — the DRM
// vocabulary module exports `DrmSystemId` (src/types/drm.ts), deliberately an
// open string type carrying a registered common-encryption system id rather
// than a closed vendor-named enum (ADR-008 §5.3 / CLAUDE.md rule 1). The real
// exported symbol is used here; nothing is invented.
// ---------------------------------------------------------------------------

// What a packaging runner can actually do, as answered by the runner itself.
//
// `schemes` / `systems` are only meaningful when `encryption` is true; an
// `encryption: false` runner answers with empty lists (there is no scheme it
// could apply). Read fresh on every call — see `probeEncryptionCapability`.
export type PackagingCapabilities = {
  encryption: boolean;
  schemes: ProtectionScheme[];
  systems: DrmSystemId[];
};

// The encryption instruction handed to a runner that reports `encryption: true`.
//
// !! TRANSIENT KEY MATERIAL — MUST NOT BE PERSISTED OR LOGGED !!
// `keys[].key` is a raw 16-byte content key, base64-encoded. It is the same
// material `ContentKey.key` carries (src/drm/key-provider.ts:112-126) and is
// bound by the same rule (ADR-008 D4 / §10 "Key material"): it lives ONLY in
// the call stack that builds the packaging job. This type must never be
// persisted (the stored shape is `AssetDrm`, which has no `key` member),
// never written to a log or audit entry, never returned in an HTTP response,
// and never embedded in a type that is. Hold it in a local, hand it to the
// runner, drop the reference. Everything else here (`keyId`, `pssh`,
// `protectionSystems`, `hlsKeyUri`) is signalling, not secret.
export type EncryptionParams = {
  scheme: ProtectionScheme;
  // `label` identifies which track group the key binds to (the
  // `ContentKey.trackGroup` value, e.g. 'SD'); `keyId` is the UUID key
  // identifier — the only part of a key that is ever persisted.
  // `key`: base64 of the raw 16 key bytes. TRANSIENT — see the warning above.
  keys: { label: string; keyId: string; key: string }[];
  // Base64 PSSH box per system id (`DrmSignalling.pssh`). Partial by nature: a
  // provider may answer for only some of the requested systems.
  pssh: Partial<Record<DrmSystemId, string>>;
  hlsKeyUri?: string;
  protectionSystems: DrmSystemId[];
};

// The port (ADR-008 §7.1, D8). A superset of `PackageQueue`: `enqueue` accepts
// every job `PackageQueue.enqueue` accepts, plus an optional `encryption`
// block, so an `EncryptingPackagingRunner` is usable anywhere a `PackageQueue`
// is — but not the reverse.
//
// `options.signal` (issue #1264) carries the key-acquisition step's WHOLE-STEP
// deadline into the enqueue, so a runner that can honour cancellation does not
// hold key material past the 60 s budget (ADR-008 §12). It is a second OPTIONAL
// parameter on purpose: a runner implemented with a single `job` parameter —
// `clearPackagingRunner` below, and every fake in the test tree — still
// satisfies this interface, and `EncryptingPackagingRunner` stays assignable to
// `PackageQueue`. A runner that ignores the signal is not trusted to bound the
// step either: `enqueuePackagingStep` ALSO races the returned promise against
// the same signal (see `withAbortDeadline`).
export interface EncryptingPackagingRunner {
  capabilities(): Promise<PackagingCapabilities>;
  enqueue(
    job: PackagingJob & { encryption?: EncryptionParams },
    options?: { signal?: AbortSignal }
  ): Promise<void>;
}

// The capability answer of the runner this deployment actually has.
//
// CORRECT AS OF TODAY, and verified rather than assumed: the deployed packaging
// library exposes no encryption option on any of its three relevant surfaces —
//   C1  shaka-packager-s3 `src/packager.ts`  — builds the packager argv from
//       `{ source, dest, stagingDir, noImplicitAudio, ... }`; no key, keyId,
//       scheme, pssh or `--enable_*_encryption` argument is constructible.
//   C2  encore-packager `src/config.ts`      — the instance config surface
//       (`RedisUrl`, `RedisQueue`, `OutputFolder`, `AwsAccessKeyId`,
//       `AwsSecretAccessKey`, `S3EndpointUrl`, `CallbackUrl`,
//       `PersonalAccessToken`); no encryption field.
//   C3  encore-packager `src/redisListener.ts` — the queue envelope this module
//       enqueues onto is `{ jobId, url }` (see `PackagingJob` above); there is
//       no slot in which encryption parameters could be passed per job.
// So the honest answer is "no", and the gate below turns that into an immediate,
// machine-readable refusal instead of a package that silently comes out clear.
export const NO_ENCRYPTION_CAPABILITY: Readonly<PackagingCapabilities> =
  Object.freeze({ encryption: false, schemes: [], systems: [] });

// Adapt the existing clear-only queue to the port.
//
// NOT CACHED (issue #1263 constraint): `capabilities()` builds a FRESH object
// every call, so no result is memoised across pipeline executions and an
// operator who swaps in an encrypting runner never has a stale "no" served from
// a previous execution. The arrays are copied for the same reason a frozen
// default would otherwise leak: a caller mutating the answer must not be able
// to change what the next probe reports.
export function clearPackagingRunner(
  queue: PackageQueue
): EncryptingPackagingRunner {
  return {
    async capabilities(): Promise<PackagingCapabilities> {
      return {
        encryption: NO_ENCRYPTION_CAPABILITY.encryption,
        schemes: [...NO_ENCRYPTION_CAPABILITY.schemes],
        systems: [...NO_ENCRYPTION_CAPABILITY.systems]
      };
    },
    async enqueue(
      job: PackagingJob & { encryption?: EncryptionParams }
    ): Promise<void> {
      // Defence in depth behind the gate: this runner cannot encrypt, so being
      // handed encryption parameters is a programming error, not a job to run
      // clear. Failing loudly is the only safe answer — silently dropping the
      // block would publish unprotected output under a protected request.
      // The thrown message names NO key material (ADR-008 §10).
      if (job.encryption) {
        throw new Error(
          'packaging runner does not support encryption; refusing to enqueue an encrypted job as clear'
        );
      }
      // Pass only the fields the queue contract defines (`PackagingJob`), never
      // the widened object.
      await queue.enqueue({ jobId: job.jobId, url: job.url });
    }
  };
}

// Probe the runner. A thin, deliberately un-memoised wrapper that exists so the
// "never cached" constraint has ONE place it can be read and tested, and so the
// gate below cannot accidentally be given a cached answer.
export async function probeEncryptionCapability(
  runner: EncryptingPackagingRunner
): Promise<PackagingCapabilities> {
  return runner.capabilities();
}

// The refusal a DRM-requesting package step gets when the runner cannot
// encrypt. `status` and `errorCode` are the issue #1263 contract; `errorCode`
// is typed from `DRM_ERROR_CODES` (src/types/drm.ts) rather than a loose string
// so it cannot drift from the asset-level error vocabulary.
export type DrmUnsupportedRefusal = {
  status: 409;
  error: Extract<DrmErrorCode, 'drm_unsupported'>;
  errorCode: Extract<DrmErrorCode, 'drm_unsupported'>;
  message: string;
};

export const DRM_UNSUPPORTED_REFUSAL: Readonly<DrmUnsupportedRefusal> =
  Object.freeze({
    status: 409,
    error: 'drm_unsupported',
    errorCode: 'drm_unsupported',
    message:
      'DRM protection was requested but the packaging runner for this stack cannot encrypt output; re-run without drm, or deploy a packaging runner that reports encryption support'
  });

// The other two ways a runner can be unable to do what was asked. A runner that
// reports `encryption: true` still cannot apply a protection scheme it does not
// implement, nor signal a DRM system it does not know, and BOTH are the same
// class of failure as `encryption: false` — the capability answer does not
// cover the request. They therefore refuse with the same `409 drm_unsupported`
// shape (`DrmUnsupportedRefusal`) and differ only in `message`.
//
// WHY THEY EXIST: without them the gate reduced the requested systems to the
// runner-supported intersection and proceeded even when that intersection was
// EMPTY, enqueueing `protectionSystems: []` / `pssh: {}` alongside real content
// keys — encrypted output carrying no DRM signalling at all, reported to the
// caller as `{ ok: true, encrypted: true }`. Unplayable output is not a
// success; an unsatisfiable request must fail loud, before any key is minted.
//
// The messages name no system id, scheme or key material: they are static
// operator-facing text (ADR-008 §10 "Logging and error redaction"), exactly
// like DRM_UNSUPPORTED_REFUSAL above.
export const DRM_SYSTEMS_UNSUPPORTED_REFUSAL: Readonly<DrmUnsupportedRefusal> =
  Object.freeze({
    status: 409,
    error: 'drm_unsupported',
    errorCode: 'drm_unsupported',
    message:
      'DRM protection was requested but the packaging runner for this stack supports none of the requested DRM systems; request a system the runner reports, or deploy a packaging runner that supports one'
  });

export const DRM_SCHEME_UNSUPPORTED_REFUSAL: Readonly<DrmUnsupportedRefusal> =
  Object.freeze({
    status: 409,
    error: 'drm_unsupported',
    errorCode: 'drm_unsupported',
    message:
      'DRM protection was requested with a protection scheme the packaging runner for this stack does not support; request a scheme the runner reports, or deploy a packaging runner that supports it'
  });

// The refusal a DRM-requesting step gets when the stack has no usable DRM
// configuration (issue #1264): the deployment kill switch is off, the stack has
// no stored DRM block, the stored block is `enabled: false`, or the configured
// `cpix` provider has no credential in the environment. All four are the same
// class — "DRM is not configured here" — and reuse the EXISTING constants every
// DRM route already answers with (`DRM_NOT_CONFIGURED_STATUS` /
// `DRM_NOT_CONFIGURED_PAYLOAD`, src/drm/drm-config.ts, ADR-008 §9) rather than
// a new status or a new error string.
//
// `errorCode` is the `DrmErrorCode` class of this failure
// (`'drm_not_configured'`, already in `DRM_ERROR_CODES`), carried so a caller
// maps ANY refusal to a machine-readable class without special-casing which
// refusal it got. The HTTP body a route sends stays `DRM_NOT_CONFIGURED_PAYLOAD`.
export type DrmNotConfiguredRefusal = {
  status: typeof DRM_NOT_CONFIGURED_STATUS;
  error: (typeof DRM_NOT_CONFIGURED_PAYLOAD)['error'];
  errorCode: Extract<DrmErrorCode, 'drm_not_configured'>;
  message: string;
};

export const DRM_NOT_CONFIGURED_REFUSAL: Readonly<DrmNotConfiguredRefusal> =
  Object.freeze({
    status: DRM_NOT_CONFIGURED_STATUS,
    error: DRM_NOT_CONFIGURED_PAYLOAD.error,
    errorCode: 'drm_not_configured',
    message: DRM_NOT_CONFIGURED_PAYLOAD.message
  });

// Outcome of the packaging step gate. Discriminated so a caller cannot read
// `refusal` on the proceed path or forget to handle the refusal path.
export type PackagingStepOutcome =
  | { ok: true; encrypted: boolean }
  | { ok: false; refusal: DrmUnsupportedRefusal | DrmNotConfiguredRefusal };

export type PackagingStepRequest = {
  job: PackagingJob;
  // The `package` Job id (issue #976) this enqueue is recorded under — what the
  // caller got back from `startPackageJob` (src/pipeline/package-job.ts) before
  // calling this step. Stamped onto `asset.drm.packageJobId` at STEP 4 so the
  // packager callbacks can settle ONLY this run (`correlatesWithRun`).
  //
  // A caller that wires the ENCRYPTED path MUST pass it on a deployment that
  // records package jobs: without it the completing run's job id cannot match
  // and the protection is deliberately left `pending` rather than settled on a
  // guess. Optional because a deployment with no job repository has no such id
  // (and then neither end has one, which correlates by equality anyway).
  packageJobId?: string;
  // The per-execution DRM request as persisted (`PipelineExecution['drm']`).
  // ABSENT means "no protection requested" — the clear path, which must behave
  // exactly as it did before this port existed.
  drm?: NonNullable<PipelineExecution['drm']>;
};

// Where the step reads the stack's NON-SECRET DRM coordinates from (issue
// #1264, ADR-008 §6 step 1, D5/D6). The read goes through #1262's
// `loadDrmStackConfig`, so the `DRM_ENABLED` short-circuit (no parameter-store
// I/O at all while the flag is off) is reused verbatim instead of re-derived.
//
// OPTIONAL on the deps: a caller that supplies no locator gets the pre-#1264
// behaviour (defaults from the execution request and the runner's capability
// answer) and is NOT refused — the locator is how a deployment opts into
// per-stack coordinates, not a new mandatory dependency.
export type DrmConfigLocator = {
  paramStore: ParamStore;
  workspaceId: string;
  stackName: string;
};

// The persistence seam for `asset.drm` (ADR-008 §6 step 6, D4/D7).
//
// Deliberately NARROW: the step needs to read the asset's persisted key
// identifiers and write the DRM block, nothing else. `AssetRepository`
// satisfies it structurally (`get(id): Promise<Asset | undefined>` and
// `update(id, patch: UpdateAssetInput)` with `UpdateAssetInput.drm`), so the
// real repository is passed directly and a test can pass a two-method fake.
//
// NO KEY MATERIAL CROSSES THIS SEAM: the patch type is `{ drm?: AssetDrm }`,
// and `AssetDrm` has no `key` member (src/data/asset-repo.ts:494-511).
export interface AssetDrmStore {
  get(id: string): Promise<{ drm?: AssetDrm } | undefined>;
  update(id: string, patch: { drm?: AssetDrm }): Promise<unknown>;
}

export type PackagingStepDeps = {
  runner: EncryptingPackagingRunner;
  // Only consulted on the supported path. Optional because today's runner never
  // reports `encryption: true`, so the gate refuses before any key provider is
  // needed — a deployment with no provider wired is still correct.
  keyProvider?: KeyProvider;
  // Bounds the key acquisition (ADR-008 §12 gives the key step a whole-step
  // deadline); `KeyProvider.acquire` takes a MANDATORY signal
  // (src/drm/key-provider.ts:149-165). When absent the step creates its own
  // `AbortSignal.timeout(DRM_STEP_DEADLINE_MS)` — the 60 s whole-step budget.
  signal?: AbortSignal;
  // Per-stack DRM coordinates (step 1). See `DrmConfigLocator`.
  drmConfig?: DrmConfigLocator;
  // Read at CALL time for the credential STATUS of step 1 (never a value —
  // `readDrmCredentialStatus`, src/drm/drm-config.ts:577). Defaults to
  // `process.env`, injectable so a test needs no global mutation.
  env?: NodeJS.ProcessEnv;
  // `asset.drm` read (persisted `keyIds`) + write (`pending` / `failed`).
  // Optional: with no store wired nothing is persisted and no `keyIds` are
  // re-used, which is exactly the pre-#1264 behaviour.
  assets?: AssetDrmStore;
  // Best-effort audit emission (ADR-008 §10 "Audit"), same optional-dependency
  // convention as `PackagingDeps`. Details carry `keyIds` (identifiers) and
  // never key material.
  audit?: AuditEmitter;
  auditLog?: AuditErrorLog;
  // Clock seam, so `requestedAt` is assertable. Defaults to the wall clock.
  now?: () => string;
};

// Fast-fail gate + enqueue for one `package` step (issue #1263 part 3).
//
// ORDER IS THE CONTRACT: the capability probe happens FIRST and EVERY
// `409 drm_unsupported` returns BEFORE `KeyProvider.acquire()` is called, so a
// request that cannot possibly be fulfilled never mints a content key, never
// contacts the key provider, and never leaves key material in a call stack.
// "Cannot be fulfilled" is all three of: the runner cannot encrypt at all; it
// cannot apply the requested protection scheme; it supports none of the
// requested DRM systems. None of the three may degrade into a partial
// success — encrypted output with missing or empty DRM signalling is unplayable
// and must never be reported as `{ ok: true }`.
// The clear path (no `drm`) does not probe for capability at all and enqueues
// exactly the `{ jobId, url }` envelope it always did.
//
// KEY ACQUISITION (issue #1264, ADR-008 §6 / §12 / D2 / D4). Everything from the
// capability probe down to the enqueue is ONE step with ONE 60 s deadline, in
// the order §6 draws it:
//   1. resolve the stack's DRM coordinates (parameter store, via #1262's gated
//      `loadDrmStackConfig`) and the credential STATUS from the environment;
//   2. re-use the asset's persisted `keyIds` when it already has some, so a
//      re-package re-requests the SAME keys instead of minting new ones
//      (§6 "Idempotency", §12 "Re-package of an already-protected asset");
//   3. `KeyProvider.acquire(req, signal)` under the whole-step signal;
//   4. persist `asset.drm = { status: 'pending', ... }` — identifiers only,
//      never key material (D4);
//   5. enqueue the package job with the derived `EncryptionParams`;
//   6. ZERO every `ContentKey.key` the moment `enqueue()` settles, success or
//      failure (`finally`), so the raw bytes do not outlive the step.
// An `enqueue()` rejection records `drm.status = 'failed'` and RETHROWS, so the
// caller's existing `packagingError` path (`triggerPackaging`, C7) attributes
// the failure exactly as it does for a clear package.
export async function enqueuePackagingStep(
  deps: PackagingStepDeps,
  req: PackagingStepRequest
): Promise<PackagingStepOutcome> {
  if (!req.drm) {
    await deps.runner.enqueue({ jobId: req.job.jobId, url: req.job.url });
    return { ok: true, encrypted: false };
  }

  // Probed per call — never cached between executions.
  const caps = await probeEncryptionCapability(deps.runner);
  if (!caps.encryption) {
    return { ok: false, refusal: DRM_UNSUPPORTED_REFUSAL };
  }

  // STEP 1 (ADR-008 §6 step 1, issue #1264): the stack's non-secret DRM
  // coordinates + the credential STATUS. `undefined` means "no locator was
  // supplied", which is NOT a refusal — see `resolveDrmStepConfig`.
  const resolvedConfig = await resolveDrmStepConfig(deps);
  if (!resolvedConfig.ok) {
    return { ok: false, refusal: DRM_NOT_CONFIGURED_REFUSAL };
  }
  const config = resolvedConfig.config;

  // Supported path. Unreachable with today's runner (see
  // NO_ENCRYPTION_CAPABILITY) and deliberately written against the real
  // `KeyProvider` contract rather than a placeholder, so the day a runner does
  // report encryption support there is no invented shape to unpick.
  // STILL BEFORE ANY KEY IS MINTED: narrow `encryption: true` down to what this
  // runner can actually apply to THIS request. Both checks refuse rather than
  // silently degrade — see DRM_SCHEME_UNSUPPORTED_REFUSAL /
  // DRM_SYSTEMS_UNSUPPORTED_REFUSAL for why an empty result must not proceed.
  //
  // Scheme: the per-execution override (`PipelineExecution['drm'].scheme`,
  // src/data/pipeline-repo.ts:100) when given, else the runner's own first
  // reported scheme. A runner that claims encryption but reports NO scheme
  // (`caps.schemes` empty, `PackagingCapabilities` above) can apply none, so
  // `scheme === undefined` refuses too instead of falling back to a guess.
  // The per-stack `scheme` (ADR-008 §5.2, default `cbcs` per D3) sits between
  // the per-execution override and the runner's first reported scheme, so an
  // operator-configured scheme is honoured without the request naming it.
  const scheme: ProtectionScheme | undefined =
    req.drm.scheme ?? config?.scheme ?? caps.schemes[0];
  if (scheme === undefined || !caps.schemes.includes(scheme)) {
    return { ok: false, refusal: DRM_SCHEME_UNSUPPORTED_REFUSAL };
  }
  // Systems: `resolveDrmSystemIds` (src/drm/key-provider.ts:69-71) applies the
  // configured-or-default list, then the intersection with `caps.systems` keeps
  // only the ones this runner can signal. An EMPTY intersection means nothing
  // the caller asked for can be protected — refuse.
  const systems = resolveDrmSystemIds(req.drm.systems ?? config?.systems).filter(
    (id) => caps.systems.includes(id)
  );
  if (systems.length === 0) {
    return { ok: false, refusal: DRM_SYSTEMS_UNSUPPORTED_REFUSAL };
  }
  if (!deps.keyProvider) {
    throw new Error(
      'packaging runner reports encryption support but no key provider is wired'
    );
  }

  // `packagingId = assetId` is the idempotency key for the whole packaging flow
  // (C7) and `KeyRequest.contentId` is "= asset id" (src/drm/key-provider.ts:74-77),
  // so the two are the same value and no second correlation id is introduced
  // (ADR-008 §12 closing note).
  const assetId = req.job.jobId;
  const now = deps.now ?? (() => new Date().toISOString());
  const providerId =
    req.drm.providerId ?? config?.providerId ?? deps.keyProvider.id;

  // STEP 2: the asset's ALREADY PERSISTED protection state. Its `keyIds` are
  // what makes a re-package idempotent — they are handed back to the provider so
  // the same keys are re-requested and an already-published manifest is never
  // orphaned (ADR-008 §6 "Idempotency", §12 last two rows).
  const persisted = deps.assets ? (await deps.assets.get(assetId))?.drm : undefined;
  const trackGroups = resolveTrackGroups(config?.trackGroups, persisted?.keyIds);
  const reusedKeyIds = persistedKeyIdMap(persisted?.keyIds, trackGroups);
  const request: KeyRequest = {
    contentId: assetId,
    systems,
    scheme,
    trackGroups,
    // Omitted rather than sent empty: an empty map would read as "re-request
    // these zero keys" instead of "mint".
    ...(reusedKeyIds ? { keyIds: reusedKeyIds } : {})
  };

  // ONE signal for the WHOLE step (ADR-008 §12 "whole-step deadline 60 s"):
  // created here, before the first external call, and shared by the acquire and
  // the enqueue so the budget covers both rather than restarting per call.
  const signal = deps.signal ?? AbortSignal.timeout(DRM_STEP_DEADLINE_MS);
  // `requestedAt` is "when protection was FIRST requested for this asset"
  // (src/data/asset-repo.ts:484), so a re-package keeps the original stamp.
  const requestedAt = persisted?.requestedAt ?? now();

  // STEP 3: acquire. Also raced against the step signal — `acquire` is
  // contractually bound to honour it, and racing means a provider that does not
  // still cannot hold the step past its deadline.
  let acquired: { keys: ContentKey[]; signalling: DrmSignalling };
  try {
    acquired = await withAbortDeadline(
      deps.keyProvider.acquire(request, signal),
      signal
    );
  } catch (err) {
    // No keys were returned, so there is nothing to zero. Record the classified
    // failure (§12: `key_provider_unreachable` / `key_provider_rejected` /
    // `key_provider_invalid_response`) with a FIXED message — never the thrown
    // text — and rethrow so the caller's existing failure path owns the step.
    await persistDrmState(deps, assetId, {
      status: 'failed',
      providerId,
      scheme,
      systems,
      keyIds: persisted?.keyIds ?? [],
      requestedAt,
      errorCode: classifyKeyAcquisitionError(err)
    });
    emitDrmAudit(deps, 'drm.failed', {
      assetId,
      providerId,
      systems,
      keyIds: (persisted?.keyIds ?? []).map((k) => k.keyId),
      errorCode: classifyKeyAcquisitionError(err)
    });
    throw err;
  }

  const { keys, signalling } = acquired;
  try {
    // STEP 4: persist the pending protection state. IDENTIFIERS ONLY — the
    // mapped `AssetDrm` has no `key` member and nothing here reads `key.key`.
    // `packageJobId` stamps WHICH package run carries this encryption, so the
    // packager callbacks settle this run and no other (`correlatesWithRun`).
    await persistDrmState(deps, assetId, {
      status: 'pending',
      providerId,
      scheme,
      systems,
      keyIds: keys.map((k) => ({ trackGroup: k.trackGroup, keyId: k.keyId })),
      requestedAt,
      licenceUrls: resolveLicenceUrls(systems, signalling, config),
      certificateUrl: resolveCertificateUrl(systems, signalling, config),
      ...(req.packageJobId !== undefined ? { packageJobId: req.packageJobId } : {})
    });
    emitDrmAudit(deps, 'drm.keys.requested', {
      assetId,
      providerId,
      systems,
      keyIds: keys.map((k) => k.keyId)
    });

    // STEP 5: enqueue, carrying the key material for this ONE job (D2).
    try {
      await withAbortDeadline(
        deps.runner.enqueue(
          {
            jobId: req.job.jobId,
            url: req.job.url,
            encryption: toEncryptionParams(scheme, systems, keys, signalling)
          },
          { signal }
        ),
        signal
      );
    } catch (err) {
      // §12 "Keys acquired, enqueue fails": the keys are discarded (the
      // `finally` below zeroes them), `drm.status` becomes `failed`, and the
      // error is rethrown into the EXISTING `packagingError` path (C7) rather
      // than swallowed here — this step does not own the asset's packaging
      // error field.
      await persistDrmState(deps, assetId, {
        status: 'failed',
        providerId,
        scheme,
        systems,
        keyIds: keys.map((k) => ({ trackGroup: k.trackGroup, keyId: k.keyId })),
        requestedAt,
        errorCode: 'packaging_failed'
      });
      emitDrmAudit(deps, 'drm.failed', {
        assetId,
        providerId,
        systems,
        keyIds: keys.map((k) => k.keyId),
        errorCode: 'packaging_failed'
      });
      throw err;
    }
  } finally {
    // STEP 6: zero the raw key bytes the moment the enqueue settles — resolved
    // OR rejected — and on any other throw out of this block (a failed
    // `asset.drm` write included). The `EncryptionParams` handed to the runner
    // carries its own base64 COPY, which is the runner's to hold for the job;
    // what this guarantees is that no `ContentKey.key` buffer still holds key
    // bytes once the step returns (ADR-008 §5.1 "zeroed after use", D4).
    zeroContentKeys(keys);
  }
  return { ok: true, encrypted: true };
}

// ---------------------------------------------------------------------------
// Key-acquisition step helpers (issue #1264)
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
//   - `KeyProvider.acquire(req, signal)`, `KeyRequest` (incl.
//     `keyIds?: Partial<Record<TrackTypeGroup, string>>`), `ContentKey`
//     (`{ trackGroup, keyId, key: Uint8Array, iv? }`), `DrmSignalling`
//     (`pssh`, `licenceUrls`, `certificateUrl`, `hlsKeyUri`) —
//     src/drm/key-provider.ts:74-162.
//   - `KeyProviderError.errorCode` / `isKeyProviderError` —
//     src/drm/key-provider-error.ts:28-45.
//   - `AssetDrm` (`status, providerId, scheme, systems, keyIds[], licenceUrls?,
//     certificateUrl?, requestedAt, protectedAt?, error?, errorCode?`) and
//     `UpdateAssetInput.drm` — src/data/asset-repo.ts:494-511, :958.
//   - `DRM_ERROR_CODES` / `DrmStatus` — src/types/drm.ts:87-101.
//   - `loadDrmStackConfig`, `readDrmCredentialStatus`, `DrmStackConfig`
//     (`enabled, providerKind, providerId, scheme, systems, licenceUrls,
//     certificateUrls, trackGroups, authMode`), `DRM_NOT_CONFIGURED_STATUS`,
//     `DRM_NOT_CONFIGURED_PAYLOAD` — src/drm/drm-config.ts:120-160, :515-519,
//     :577-590, :634-642.
//   - `ParamStore.loadStackConfig` — src/services/param-store.ts:221-224.
//   - `emitAudit` / `originActor` — src/data/audit-emit.ts:44-75.
// ---------------------------------------------------------------------------

// The whole-step deadline of ADR-008 §12 ("whole-step deadline 60 s"). Same
// value as `DEFAULT_DEADLINE_MS` in the CPIX adapter (src/drm/cpix-provider.ts:89),
// which bounds the provider's own retry series INSIDE this budget.
export const DRM_STEP_DEADLINE_MS = 60_000;

// Fixed, operator-facing text per failure class. The persisted `AssetDrm.error`
// is ALWAYS one of these strings — never a thrown message, never a provider
// body (ADR-008 §10 "Provider error bodies are not echoed verbatim"), so no
// repository write can carry key material or a credential even if an adapter
// one day throws something careless.
export const DRM_STEP_ERROR_MESSAGES: Readonly<Partial<Record<DrmErrorCode, string>>> =
  Object.freeze({
    key_provider_unreachable:
      'the key provider could not be reached within the key-acquisition deadline',
    key_provider_rejected: 'the key provider rejected the key request',
    key_provider_invalid_response:
      'the key provider returned a response that could not be parsed',
    drm_not_configured: 'DRM is not configured on this deployment',
    packaging_failed:
      'content keys were acquired but the package job could not be enqueued'
  });

// Step 1: resolve the stack's DRM coordinates and the credential STATUS.
//
// `{ ok: true, config: undefined }` is the NO-LOCATOR case and is deliberately
// not a refusal: a caller that wires no parameter store keeps the pre-#1264
// behaviour (defaults from the execution request and the capability answer).
//
// It refuses (`ok: false`) only when a locator WAS supplied and the stack has no
// usable DRM configuration:
//   - `loadDrmStackConfig` returns undefined — either `DRM_ENABLED` is off (it
//     short-circuits before any parameter-store I/O, src/drm/drm-config.ts:639)
//     or the stack has no stored `drm` block;
//   - the stored block is `enabled: false` (the per-stack switch of §5.2: "both
//     must be true for DRM to act");
//   - the block selects the `cpix` provider but its credential is absent from
//     the environment, so the request could only ever come back rejected. Only
//     the STATUS is read (`readDrmCredentialStatus`) — never a value.
async function resolveDrmStepConfig(
  deps: PackagingStepDeps
): Promise<{ ok: true; config: DrmStackConfig | undefined } | { ok: false }> {
  const locator = deps.drmConfig;
  if (!locator) return { ok: true, config: undefined };
  const config = await loadDrmStackConfig(
    locator.paramStore,
    locator.workspaceId,
    locator.stackName
  );
  if (!config || !config.enabled) return { ok: false };
  if (
    config.providerKind === 'cpix' &&
    readDrmCredentialStatus(config.authMode ?? 'basic', deps.env ?? process.env) ===
      'missing'
  ) {
    return { ok: false };
  }
  return { ok: true, config };
}

// Which track type groups this request binds a key to. The configured set
// (`DrmStackConfig.trackGroups`) or the single-key profile default (D3), UNIONED
// with the groups the asset already holds keys for: a group that was protected
// by an earlier package must keep its key even if the configuration no longer
// lists it, otherwise a re-package would silently orphan a published manifest.
function resolveTrackGroups(
  configured: readonly TrackTypeGroup[] | undefined,
  persisted: readonly { trackGroup: TrackTypeGroup }[] | undefined
): TrackTypeGroup[] {
  const groups: TrackTypeGroup[] =
    configured && configured.length > 0 ? [...configured] : [DEFAULT_TRACK_GROUP];
  for (const entry of persisted ?? []) {
    if (!groups.includes(entry.trackGroup)) {
      groups.push(entry.trackGroup);
    }
  }
  return groups;
}

// The single-key profile's group (ADR-008 D3 "a single-key profile as the
// default"). Same value the pre-#1264 request hardcoded.
const DEFAULT_TRACK_GROUP: TrackTypeGroup = 'SD';

// Step 2: the persisted key identifiers, as `KeyRequest.keyIds`. Returns
// undefined when the asset holds none for the requested groups, which is the
// MINT case; any entry present means "re-request THIS key id" (ADR-008 §6
// "Idempotency"). Never invents an id and never maps a group twice.
function persistedKeyIdMap(
  persisted: readonly { trackGroup: TrackTypeGroup; keyId: string }[] | undefined,
  trackGroups: readonly TrackTypeGroup[]
): Partial<Record<TrackTypeGroup, string>> | undefined {
  if (!persisted || persisted.length === 0) return undefined;
  const map: Partial<Record<TrackTypeGroup, string>> = {};
  for (const entry of persisted) {
    if (!trackGroups.includes(entry.trackGroup)) continue;
    if (map[entry.trackGroup] !== undefined) continue;
    map[entry.trackGroup] = entry.keyId;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

// Per-system licence URLs for the persisted block: the provider's answer wins
// (it is authoritative for the keys it just issued), with the configured
// `licenceUrls` as the fallback for a system the provider said nothing about.
// Narrowed to the systems this package is actually signalled for, so the record
// never advertises a licence URL for a system the output cannot be played with.
function resolveLicenceUrls(
  systems: readonly DrmSystemId[],
  signalling: DrmSignalling,
  config: DrmStackConfig | undefined
): Record<DrmSystemId, string> | undefined {
  const urls: Record<DrmSystemId, string> = {};
  for (const system of systems) {
    const url = signalling.licenceUrls[system] ?? config?.licenceUrls?.[system];
    if (url !== undefined) {
      urls[system] = url;
    }
  }
  return Object.keys(urls).length > 0 ? urls : undefined;
}

// The application certificate URL for the persisted block. `AssetDrm` carries
// ONE (src/data/asset-repo.ts:506) while the config keys them by system id
// (`certificateUrls`, src/drm/drm-config.ts:156), so the provider's own value
// wins and the fallback is the first configured entry among the signalled
// systems — in `systems` order, so the choice is deterministic.
function resolveCertificateUrl(
  systems: readonly DrmSystemId[],
  signalling: DrmSignalling,
  config: DrmStackConfig | undefined
): string | undefined {
  if (signalling.certificateUrl !== undefined) return signalling.certificateUrl;
  for (const system of systems) {
    const url = config?.certificateUrls?.[system];
    if (url !== undefined) return url;
  }
  return undefined;
}

// Map a key-acquisition failure onto the `DrmErrorCode` of ADR-008 §12.
// `KeyProviderError` already classified it at the boundary that observed it
// (src/drm/key-provider-error.ts), so this reads the carried code rather than
// matching on prose. Anything else — an aborted step, a programming error in an
// adapter — is reported as `key_provider_unreachable`, the §12 row that covers
// "unreachable / 5xx / timeout".
function classifyKeyAcquisitionError(err: unknown): DrmErrorCode {
  return isKeyProviderError(err) ? err.errorCode : 'key_provider_unreachable';
}

// Write the asset's DRM block (steps 4 and the two failure paths).
//
// NO KEY MATERIAL: the input shape is `AssetDrm`-minus-`error`, so there is no
// member a key could travel in, and `error` is filled from the FIXED
// `DRM_STEP_ERROR_MESSAGES` table rather than from any thrown or received text.
// Best-effort by design on the FAILURE paths: a repository that cannot record
// the failure must not mask the failure itself, so a write error is swallowed
// after the fact exactly like the `packagingError` write in `triggerPackaging`.
async function persistDrmState(
  deps: PackagingStepDeps,
  assetId: string,
  state: Omit<AssetDrm, 'error'>
): Promise<void> {
  if (!deps.assets) return;
  const drm: AssetDrm = {
    ...state,
    keyIds: state.keyIds.map((k) => ({ trackGroup: k.trackGroup, keyId: k.keyId })),
    systems: [...state.systems],
    ...(state.errorCode !== undefined &&
    DRM_STEP_ERROR_MESSAGES[state.errorCode] !== undefined
      ? { error: DRM_STEP_ERROR_MESSAGES[state.errorCode] }
      : {})
  };
  if (state.status === 'failed') {
    try {
      await deps.assets.update(assetId, { drm });
    } catch (err) {
      deps.auditLog?.error(
        { err, assetId },
        'failed to record DRM failure state on asset (non-fatal)'
      );
    }
    return;
  }
  // The `pending` write is NOT best-effort: it is the record that keys were
  // requested for this asset, and `keyIds` is what makes the next attempt
  // idempotent. Letting it throw stops the step before the enqueue, which is
  // the safe side — an unrecorded key id is a key that can never be re-requested.
  await deps.assets.update(assetId, { drm });
}

// Zero the raw key bytes in place, then drop the buffer references (step 6).
// `fill(0)` overwrites the ONE allocation every holder shares, so a caller still
// holding the `ContentKey` sees zeroes too — which is the point. `length = 0` is
// not used: the typed array is fixed-length, and replacing the reference would
// leave the original bytes resident.
export function zeroContentKeys(keys: readonly ContentKey[]): void {
  for (const key of keys) {
    key.key.fill(0);
  }
}

// Race `work` against the step's abort signal so the whole step is bounded even
// when the awaited call cannot (or does not) honour the signal itself — the
// packaging runner's `enqueue` is the case that matters: `options.signal` is
// advisory for a runner implemented with a single parameter.
//
// The rejection message names the deadline only; it carries no key material, no
// provider text and no credential (ADR-008 §10). Handlers are attached to `work`
// unconditionally, so a late rejection after the race was already lost is
// observed rather than surfacing as an unhandled rejection.
function withAbortDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = (): void =>
      reject(
        new Error(
          `DRM key-acquisition step exceeded its ${DRM_STEP_DEADLINE_MS} ms deadline`
        )
      );
    if (signal.aborted) {
      fail();
    }
    const onAbort = (): void => fail();
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

// Best-effort DRM audit entry (ADR-008 §10 "Audit"): `drm.keys.requested` when
// keys were acquired and recorded, `drm.failed` on either failure path. The
// detail carries `keyIds` — IDENTIFIERS, which §10 states are non-secret — and
// never a key, a licence credential or a provider body. Uses the SAME
// fire-and-forget `emitAudit` helper as the rest of this module, so a failed
// audit write can never fail the packaging step (issue #564).
function emitDrmAudit(
  deps: PackagingStepDeps,
  action: 'drm.keys.requested' | 'drm.failed',
  detail: {
    assetId: string;
    providerId: string;
    systems: DrmSystemId[];
    keyIds: string[];
    errorCode?: DrmErrorCode;
  }
): void {
  emitAudit(
    deps.audit,
    {
      actor: originActor('system'),
      action,
      targetType: 'asset',
      targetId: detail.assetId,
      detail: {
        assetId: detail.assetId,
        providerId: detail.providerId,
        systems: [...detail.systems],
        keyIds: [...detail.keyIds],
        ...(detail.errorCode !== undefined ? { errorCode: detail.errorCode } : {})
      }
    },
    deps.auditLog
  );
}

// Map the key provider's answer onto the runner's encryption block.
//
// TRANSIENT: the returned object carries key material (see `EncryptionParams`).
// It is returned, handed straight to `enqueue`, and dropped — never logged,
// never persisted. `ContentKey.key` is `Uint8Array` (16 bytes,
// src/drm/key-provider.ts:118) and the port wants base64, which is the only
// conversion here.
function toEncryptionParams(
  scheme: ProtectionScheme,
  systems: DrmSystemId[],
  keys: ContentKey[],
  signalling: DrmSignalling
): EncryptionParams {
  const pssh: Partial<Record<DrmSystemId, string>> = {};
  for (const system of systems) {
    const value = signalling.pssh[system];
    if (value !== undefined) {
      pssh[system] = value;
    }
  }
  return {
    scheme,
    keys: keys.map((k) => ({
      label: k.trackGroup,
      keyId: k.keyId,
      key: Buffer.from(k.key).toString('base64')
    })),
    pssh,
    ...(signalling.hlsKeyUri !== undefined
      ? { hlsKeyUri: signalling.hlsKeyUri }
      : {}),
    protectionSystems: systems
  };
}

// The interface issue #8's Encore callback handler depends on. Keeping the
// callback handler coupled only to this (not to PackagingService) keeps the two
// features decoupled: #8 calls triggerPackaging when a transcode succeeds and
// never needs to know how packaging is wired.
export interface PackagingTrigger {
  // Resolves to the id of the `package` Job recorded for this enqueue (issue
  // #976), or undefined when no job repository is wired. Callers that own the
  // execution record use it to populate `steps[].jobId`; callers that have
  // already persisted a running `package` step can ignore it — the service
  // stamps those itself (see `startPackageJob`).
  triggerPackaging(
    assetId: string,
    encoreJobUrl: string
  ): Promise<string | undefined>;
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

// Caller control over the TERMINAL write on the `package` Job during a packager
// success (issue #1279).
//
// `settleJob: false` means "record the packaged output on the asset, but leave
// the Job active — I will settle it". The packager-success route passes it when
// the post-package copy to a caller-requested destination failed: the Job must
// end `failed` with that reason, and a `done` written first could never be
// corrected (`done` is terminal in ALLOWED_JOB_TRANSITIONS, src/data/job-repo.ts).
// Omitted/true keeps the default: handleSuccess settles the Job `done` itself.
export type PackagerSuccessOptions = {
  settleJob?: boolean;
};

// Failure callback payload from the packager (POST .../packagerCallback/failure).
export type PackagerFailurePayload = {
  message: string;
};

// ---------------------------------------------------------------------------
// Callback-side DRM settlement (issue #1265; ADR-008 §8, §12, C7).
//
// The key-acquisition step above leaves the asset at `drm.status = 'pending'`
// once content keys were acquired and the encrypted job was enqueued (STEP 4/5).
// Nothing then moved that state: only packaging completion knows whether the
// protected package actually landed, so the two transitions out of `pending`
// are both driven from where that completion is observed:
//   - packager success -> `protected` + `protectedAt`
//   - packager failure -> `failed`   (ADR-008 §12 "Packager fails after
//     encryption started": `failPackageJob` + `drm.status='failed'`)
//
// WHERE EACH IS DRIVEN FROM (checked, issue #1265 review — the success and
// failure callbacks are NOT symmetric in this codebase):
//   - success: POST /api/v1/internal/packagerCallback/success carries our jobId
//     (= assetId) and is handled by `PackagingService.handleSuccess`, which
//     settles in the same write that records the manifests.
//   - failure: the packager's failure callback carries NO id of ours, so
//     POST /packagerCallback/failure attributes by execution state and calls
//     `failPackageJob` DIRECTLY (src/routes/internal.ts); the stalled-package
//     sweep does the same for a completion signal that never arrives
//     (src/pipeline/stalled-package-reconciler.ts, issue #336).
//     `PackagingService.handleFailure` is NOT on either of those paths, so the
//     failure settlement is wired into both of them via
//     `PackagingService.settleProtectionFailure` — otherwise a real packager
//     failure would leave `pending` with no exit at all.
//
// EITHER transition requires the completing run to be the run that carried the
// encryption — see `correlatesWithRun`. `pending` + a success callback is not
// sufficient: the production enqueue path (`triggerPackaging`) is CLEAR.
//
// BOTH are written as PURE functions over the persisted block, returning the
// `AssetDrm` to patch or `undefined` for "nothing to settle". That keeps the
// whole state machine in one readable place (no transition logic inlined in a
// callback handler), and it is what makes the idempotency guarantee checkable:
// `undefined` means the caller omits `drm` from its patch entirely, so an
// at-least-once duplicate callback cannot overwrite `protectedAt` with a later
// timestamp — `UpdateAssetInput.drm` replaces the block WHOLESALE (applyPatch,
// src/data/asset-repo.ts:2011 and src/data/couch-asset-repo.ts:468), so
// omitting the field is the only way to leave the stored block untouched.
//
// `pending` is the ONLY status either function acts on. A block that is already
// `protected`, `failed` or `unsupported` is terminal for this package run, and a
// clear asset (no `drm` block at all — the overwhelmingly common case, and every
// asset while `DRM_ENABLED` is off) returns `undefined` from both, which is what
// keeps the clear packaging path byte-for-byte unchanged.
//
// NO new `Asset.status` value and no lifecycle change: a DRM failure leaves the
// asset `ready` with `drm.status = 'failed'` (ADR-008 §8, the `packagingError`
// convention, C7).
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
//   - `AssetDrm` (`status`, `providerId`, `scheme`, `systems`, `keyIds[]`,
//     `licenceUrls?`, `certificateUrl?`, `requestedAt`, `protectedAt?`,
//     `error?`, `errorCode?`) — src/data/asset-repo.ts:494-511.
//   - `UpdateAssetInput.drm` (wholesale replacement, never changes `status`) —
//     src/data/asset-repo.ts:976, applied at :2011 (in-memory) / :468
//     (src/data/couch-asset-repo.ts).
//   - `DrmStatus` / `DRM_STATUSES`, `DrmErrorCode` / `DRM_ERROR_CODES` (which
//     already contains `packaging_failed`) — src/types/drm.ts:87-101.
//   - `PackagerSuccessPayload = { url, jobId, outputPath? }` (jobId = assetId),
//     this file, and `PackagingService.handleSuccess` — the handler the SUCCESS
//     route drives (src/routes/internal.ts POST /packagerCallback/success).
//     The FAILURE route drives no handler on this class: it calls
//     `failPackageJob` directly after correlating by execution state
//     (src/routes/internal.ts POST /packagerCallback/failure), as does the
//     stalled-package sweep (src/pipeline/stalled-package-reconciler.ts).
//   - `resolvePackageJobId` / `failPackageJob` (resolution: explicit
//     `steps[].jobId`, else the asset's in-flight package job) —
//     src/pipeline/package-job.ts.
//   - `completePackageJob` / `failPackageJob` idempotency (both early-return on
//     an inactive job) — src/pipeline/package-job.ts:188-236.
// ---------------------------------------------------------------------------

// The FIXED `AssetDrm.error` text for a packager-reported failure. The
// packager's own message is recorded verbatim on `asset.packagingError` (that is
// the existing settlement and it is unchanged); the DRM block carries a static,
// operator-facing sentence instead, exactly like `DRM_STEP_ERROR_MESSAGES`
// above, so no received text can ever reach `structural.drm` (ADR-008 §10
// "Logging and error redaction").
export const DRM_PACKAGER_FAILED_MESSAGE =
  'the packager reported a failure for this asset, so no protected package was produced';

// RUN CORRELATION: does the package run that is completing NOW carry the
// encryption this `pending` block is waiting on? (issue #1265 review.)
//
// `drm.status === 'pending'` alone does not answer that. `triggerPackaging`
// enqueues a CLEAR job (`{ jobId, url }`, no `encryption`) and is the production
// packaging path (src/routes/internal.ts POST /packagerCallback/success ->
// handleSuccess, src/routes/assets.ts package routes -> triggerPackaging), so an
// asset left `pending` by an earlier protected run and then re-packaged clear
// would otherwise be settled `protected` for UNENCRYPTED output — a false
// protection claim. The run that carried `EncryptionParams` stamps its own
// `package` Job id on the block at `enqueuePackagingStep` STEP 4
// (`AssetDrm.packageJobId`, src/data/asset-repo.ts), and this compares it with
// the id of the run now completing:
//   - stamped, ids EQUAL     -> this IS the encrypted run; settle.
//   - stamped, ids DIFFER    -> some other run (a clear re-package) completed;
//                               leave `pending` for the run that owns it.
//   - stamped, id UNKNOWN     -> cannot be shown to be the encrypted run; refuse.
//                               Pending is not settled on a guess.
//   - UNSTAMPED, id UNKNOWN  -> no run identity exists on EITHER end: the
//                               deployment wires no job repository (pre-#976
//                               shape), where every packaging callback is
//                               already correlated by assetId alone. Settles,
//                               because the clear path on such a deployment is
//                               equally unidentifiable and refusing would make
//                               `pending` permanently terminal.
//   - UNSTAMPED, id KNOWN    -> the completing run recorded a `package` Job and
//                               this block never recorded one, so the block
//                               belongs to a different (unidentified) run.
//                               Refuse — this is the clear-re-package case on a
//                               normal deployment.
// A plain `===` expresses all five rows, including the both-undefined one.
//
// KNOWN RESIDUAL (documented, not closed here): `startPackageJob` REUSES the
// asset's still-active `package` Job for a re-enqueue (it increments `attempts`
// rather than creating a second record, src/pipeline/package-job.ts), so a clear
// re-enqueue that lands on the very same job id while the protected run is still
// in flight is indistinguishable from that protected run by job id alone. That
// window needs a per-enqueue identity the packager echoes back, which today's
// queue contract does not carry (ADR-008 C3: `QueueMessage = { jobId, url }`);
// it is called out in `docs/osc-feedback/incoming-packager-no-encryption-support.md`
// as part of the same missing-per-job-contract gap.
function correlatesWithRun(
  drm: AssetDrm,
  completingPackageJobId: string | undefined
): boolean {
  return drm.packageJobId === completingPackageJobId;
}

// Packager SUCCESS: settle a pending protection to `protected`.
//
// Returns `undefined` — "do not write `drm`" — for every non-pending block,
// which is precisely the idempotency requirement: a second success callback for
// the same asset finds `protected` and leaves the stored `protectedAt` alone.
// `error` / `errorCode` are dropped on the way through: a protected package must
// not keep advertising a failure from an earlier attempt.
//
// `completingPackageJobId` is the RUN CORRELATION (see `correlatesWithRun`): the
// `package` Job id of the run whose success is being settled. `pending` alone is
// NOT enough to settle — a clear re-package must never claim protection.
export function settleDrmOnPackagerSuccess(
  drm: AssetDrm | undefined,
  protectedAt: string,
  completingPackageJobId?: string
): AssetDrm | undefined {
  if (!drm || drm.status !== 'pending') return undefined;
  if (!correlatesWithRun(drm, completingPackageJobId)) return undefined;
  // Rebuilt field by field (rather than spread-and-override) so the dropped
  // `error` / `errorCode` are dropped by CONSTRUCTION — a future field added to
  // `AssetDrm` then has to be considered here instead of silently riding along.
  return {
    status: 'protected',
    providerId: drm.providerId,
    scheme: drm.scheme,
    systems: [...drm.systems],
    keyIds: drm.keyIds.map((k) => ({ trackGroup: k.trackGroup, keyId: k.keyId })),
    ...(drm.licenceUrls !== undefined ? { licenceUrls: { ...drm.licenceUrls } } : {}),
    ...(drm.certificateUrl !== undefined ? { certificateUrl: drm.certificateUrl } : {}),
    ...(drm.packageJobId !== undefined ? { packageJobId: drm.packageJobId } : {}),
    requestedAt: drm.requestedAt,
    protectedAt
  };
}

// Packager FAILURE: settle a pending protection to `failed`.
//
// Classified as `packaging_failed` — the same `DrmErrorCode` the key step's
// "keys acquired, enqueue fails" path uses (ADR-008 §12), because it is the same
// class of failure (keys were minted, no protected package landed). No new error
// code and no new error path: the caller's `packagingError` write is what records
// the packager's own message.
// `failingPackageJobId` is the same RUN CORRELATION the success path applies
// (`correlatesWithRun`): a clear re-package failing must not report the earlier
// protected run as `failed` either — that run may still be in flight, and its
// own failure path settles it.
export function settleDrmOnPackagerFailure(
  drm: AssetDrm | undefined,
  failingPackageJobId?: string
): AssetDrm | undefined {
  if (!drm || drm.status !== 'pending') return undefined;
  if (!correlatesWithRun(drm, failingPackageJobId)) return undefined;
  return {
    ...drm,
    systems: [...drm.systems],
    keyIds: drm.keyIds.map((k) => ({ trackGroup: k.trackGroup, keyId: k.keyId })),
    status: 'failed',
    errorCode: 'packaging_failed',
    error: DRM_PACKAGER_FAILED_MESSAGE
  };
}

export type PackagingDeps = {
  assets: AssetRepository;
  queue: PackageQueue;
  // Job + execution records for the `package` step (issue #976). Optional so
  // existing callers/tests that only assert enqueue behaviour are unaffected;
  // when absent, no Job is created and behaviour is exactly as before. See
  // src/pipeline/package-job.ts for the lifecycle (create at enqueue, settle
  // from the completion callbacks).
  jobs?: JobRepository;
  pipeline?: PipelineRepository;
  // Public origin for the packaged bucket (MinIO/CDN). Used to build manifest
  // URLs. Config via env; defaults to a relative path so a missing origin still
  // yields a usable, resolvable manifest reference.
  publicBaseUrl?: string;
  // Test observability hook fired on a recorded packaging failure.
  onError?: (err: unknown) => void;
  // Best-effort audit emission (issue #564). Optional so existing callers /
  // tests are unaffected; when absent, emission is a no-op. A failed audit write
  // is logged, never propagated — packaging never becomes newly failable.
  audit?: AuditEmitter;
  auditLog?: AuditErrorLog;
  // Best-effort operational log emission (issue #995). Optional exactly like
  // `audit` above: when absent no log record is appended and behaviour is
  // unchanged. Wired to the log store that backs GET /api/v1/logs
  // (src/main.ts, `logStore`), so the `package` stage of a run is visible in the
  // Logs tab.
  pipelineLog?: PipelineLogSink;
  // Clock seam for `drm.protectedAt` (issue #1265). Optional and defaulted to
  // the wall clock, so no existing caller changes; a test injects it to assert
  // that a DUPLICATE success callback does not re-stamp `protectedAt` even when
  // the clock has moved on. Same convention as `PackagingStepDeps.now`.
  now?: () => string;
};

// The base the packaging pipeline WRITES manifest URLs against. Stays
// origin-agnostic (a bucket-relative `/<packagedBucket>` path) when
// PACKAGED_PUBLIC_BASE_URL is unset: packaging runs from the packager callback,
// which has no resolved stack connections, and a stored relative path keeps the
// record portable. The public origin is resolved at READ time instead, from the
// resolved stack's own MinIO endpoint — see `packagedPublicOrigin()` /
// `stackPackagedPublicOrigin()` (issue #859), which also upgrades assets that
// were packaged before an origin was known.
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

// The resolved stack's OWN public origin for its packaged objects (issue #859).
//
// On a default, zero-config deployment nothing sets PACKAGED_PUBLIC_BASE_URL, yet
// the stack already HAS a public origin: the per-stack MinIO endpoint it was
// provisioned with. `minioEndpoint` is a REQUIRED field of the persisted stack
// config (services/param-store.ts StackConfig.minioEndpoint) and is resolved per
// request onto `connections.s3Config.endpoint`
// (services/workspace-stack.ts buildConnectionsFromStack), so a caller holding
// resolved connections can derive the origin without a global env read.
//
// Callers MUST source the argument from
// `services/workspace-stack.ts stackResolvedMinioEndpoint(connections)`, NOT from
// `s3Config.endpoint` directly: that same field is also populated verbatim from
// MINIO_URL on the env-override path, where no anonymous-read bucket policy has
// been applied by this codebase and a derived "public" URL would 403.
//
// Returns the endpoint WITHOUT a bucket path segment: a stored manifest URL for
// the zero-config case is already bucket-prefixed (`/<packagedBucket>/...`,
// baked in by `packagingPublicBaseUrl()` at packaging time), and
// `resolvePublicManifestUrl` joins that stored path onto the origin — appending
// the bucket here too would duplicate it. Path-style addressing
// (`<endpoint>/<bucket>/<key>`) is what MinIO serves, mirroring how
// `externalPublicBaseUrl` derives an S3-compatible object URL above.
//
// Returns undefined when no endpoint is available (no PROVISIONED stack resolved —
// callers pass `stackResolvedMinioEndpoint(connections)`, which is undefined on the
// env-override and in-memory paths) or when the value is not an absolute http(s)
// URL — a non-absolute origin is not usable and must fall through to the caller's
// existing fallback rather than be handed to `resolvePublicManifestUrl` (which
// would reject it as a misconfiguration).
//
// The returned origin is REBUILT from the parsed URL — scheme + host(+port) +
// path only — so it can never carry userinfo (`https://user:pw@host` would
// otherwise echo an operator credential into a public API response) and never
// carries a query or fragment (either would make the `origin + '/' + key` join in
// `resolvePublicManifestUrl` malformed). `minioEndpoint` is operator-writable via
// the parameter store, so this is enforced here rather than assumed.
export function stackPackagedPublicOrigin(
  minioEndpoint: string | undefined
): string | undefined {
  const endpoint = minioEndpoint?.trim();
  if (!endpoint) {
    return undefined;
  }
  const parsed = tryParseUrl(endpoint);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return undefined;
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${path}`;
}

// The public-facing origin for the packaged bucket (MinIO/CDN), or undefined when
// neither an explicit origin nor a resolved stack endpoint is available. Unlike
// `packagingPublicBaseUrl()` this does NOT fall back to a relative bucket path:
// callers that require a genuinely public origin (the delivery endpoint) must be
// able to distinguish "configured" from "unset".
//
// Precedence (issue #859):
//   1. `PACKAGED_PUBLIC_BASE_URL` — the explicit operator override — wins when
//      set, verbatim (an operator-fronted CDN origin beats the raw MinIO host).
//   2. the PROVISIONED stack's own `minioEndpoint` (see
//      stackPackagedPublicOrigin), so a zero-config stack still has an ABSOLUTE
//      public origin instead of degrading to a root-relative path.
//   3. undefined — every other deployment shape: no provisioned stack resolved,
//      the env-override path (COUCHDB_URL/MINIO_URL), or in-memory connections.
//      The caller keeps its pre-#859 behaviour (relative value, then the
//      authorized stream proxy). Only the explicit PACKAGED_PUBLIC_BASE_URL makes
//      those deployments advertise a public origin.
export function packagedPublicOrigin(
  stackMinioEndpoint?: string
): string | undefined {
  const raw = process.env['PACKAGED_PUBLIC_BASE_URL'];
  if (!raw || raw.trim().length === 0) {
    return stackPackagedPublicOrigin(stackMinioEndpoint);
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
  ): Promise<string | undefined> {
    // Record the observable `package` Job BEFORE the enqueue (issue #976), so a
    // packager that consumes the queue entry immediately still finds a job to
    // settle, and so the enqueue-failure path below has a record to fail. This
    // also stamps `steps[].jobId` on an already-running `package` step, which is
    // why it precedes the enqueue rather than following it: stamping afterwards
    // would race the packager's own completion callback. Best-effort — never
    // throws (src/pipeline/package-job.ts).
    const packageJobId = await startPackageJob(this.packageJobDeps(), assetId);
    try {
      const job: PackagingJob = {
        jobId: assetId,
        url: encoreJobUrl
      };
      await this.deps.queue.enqueue(job);
      // Audit: package job submitted (issue #564). One entry on a SUCCESSFUL
      // enqueue only — the catch path below is a failed submission that records
      // `packagingError` instead. targetId is the `package` Job id when one was
      // recorded (issue #976 — matching how transcode audits its own job id,
      // src/pipeline/transcode.ts), falling back to the packaging correlation id
      // (= assetId) on a deployment with no job repository wired.
      emitAudit(
        this.deps.audit,
        {
          actor: originActor('system'),
          action: 'job.submitted',
          targetType: 'job',
          targetId: packageJobId ?? assetId,
          detail: { jobType: 'package', assetId }
        },
        this.deps.auditLog
      );
      // Operational log: the `package` stage started (issue #995). Emitted at the
      // SAME point as the audit entry — a successful enqueue — so the Logs tab
      // shows the stage beginning, and the failure branch below reports the
      // enqueue that never happened instead.
      logPipelineEvent(
        this.deps.pipelineLog,
        {
          stage: 'package',
          level: 'info',
          message: `enqueued job ${packageJobId ?? assetId} for asset ${assetId}`
        },
        this.deps.auditLog
      );
    } catch (err) {
      this.deps.onError?.(err);
      const message = err instanceof Error ? err.message : String(err);
      const reason = `failed to enqueue packaging job: ${message}`;
      // The enqueue never happened, so no packager callback can ever settle this
      // job: fail it here with the same reason written onto the asset, so the
      // failure is readable from GET /api/v1/jobs (issue #976).
      await failPackageJob(this.packageJobDeps(), { jobId: packageJobId, assetId }, reason);
      // Operational log: the enqueue failed, so no packager callback can ever
      // settle this job (issue #995). There is no audit entry here (a failed
      // submission is not a submission), but it is exactly the event an operator
      // opens the Logs tab for.
      logPipelineEvent(
        this.deps.pipelineLog,
        {
          stage: 'package',
          level: 'error',
          message: `asset ${assetId}: ${reason}`
        },
        this.deps.auditLog
      );
      try {
        await this.deps.assets.update(assetId, {
          packagingError: reason
        });
      } catch {
        // Detached safety: nothing more we can do if the error write also fails.
      }
    }
    return packageJobId;
  }

  // The package-job bookkeeping dependencies (issue #976). Absent repositories
  // make every helper a no-op, so a PackagingService constructed without them
  // behaves exactly as it did before package jobs existed.
  private packageJobDeps(): PackageJobDeps {
    return {
      jobs: this.deps.jobs,
      pipeline: this.deps.pipeline,
      logger: this.deps.auditLog
    };
  }

  // Invoked by POST /api/v1/internal/packagerCallback/success when the packager
  // signals successful completion. The jobId in the payload is the assetId we
  // used when enqueueing. Writes manifestUrls onto the asset.
  // NEVER changes the asset's lifecycle status.
  //
  // `options.settleJob` (issue #1279) lets the CALLER own the terminal write on
  // the `package` Job when it — and only it — knows whether the packaged output
  // actually reached the destination the caller asked for. See the block guarded
  // by it below; default (omitted) keeps the pre-#1279 behaviour of settling
  // `done` here, which is what every other caller wants.
  async handleSuccess(
    payload: PackagerSuccessPayload,
    options?: PackagerSuccessOptions
  ): Promise<boolean> {
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
    // Settle protection in the SAME write that records the packaged output
    // (issue #1265, ADR-008 §8/§12): the package that just landed IS the
    // protected package, so `drm.status: 'pending' -> 'protected'` and
    // `protectedAt` belong to this one patch rather than a second round-trip
    // that could land without the manifests. `undefined` for a clear asset (no
    // `drm` block) and for an already-settled one, in which case `drm` is left
    // out of the patch entirely and the stored block — including its original
    // `protectedAt` — is untouched: that is what makes a duplicate, at-least-once
    // success callback idempotent (see `settleDrmOnPackagerSuccess`).
    // Resolved ONLY for an asset whose protection is actually pending, so the
    // clear path (no `drm` block — every asset while `DRM_ENABLED` is off) does
    // not take on an extra repository read: its patch is byte-for-byte what it
    // was. `resolvePackageJobId` is read-only and best-effort; an unresolvable
    // id leaves the protection `pending` rather than settling it on a guess.
    const completingPackageJobId =
      asset.drm?.status === 'pending'
        ? await resolvePackageJobId(this.packageJobDeps(), { assetId })
        : undefined;
    const settledDrm = settleDrmOnPackagerSuccess(
      asset.drm,
      (this.deps.now ?? (() => new Date().toISOString()))(),
      completingPackageJobId
    );
    await this.deps.assets.update(assetId, {
      manifestUrls,
      ...(packagedOutput ? { packagedOutput } : {}),
      ...(settledDrm ? { drm: settledDrm } : {}),
      // Clear the packaged-output-stale marker (issue #1290) in the SAME write
      // that repoints the manifests: a re-encode without a package had recorded
      // that these manifests described an older generation of `renditions`
      // (pipeline/transcode.ts completeTranscode), and this callback is the
      // package that resolves it. Stated explicitly here so the clear is
      // readable at the call site; both repositories ALSO clear it on any
      // `manifestUrls` write (applyPatch, data/asset-repo.ts +
      // data/couch-asset-repo.ts), so the invariant does not depend on this
      // line alone.
      packagedOutputStale: false
    });
    // Issue #1279: the packager finishing is NOT the same thing as the output
    // being delivered. When the execution carries a destination override, the
    // packager-success route attempts the copy to that destination BEFORE
    // calling this method and passes `settleJob: false` if the copy failed, so
    // that it can settle the Job `failed` itself with the reason.
    //
    // This return MUST stay ahead of completePackageJob: `done` is terminal in
    // the repository's transition table (ALLOWED_JOB_TRANSITIONS,
    // src/data/job-repo.ts) and both settle helpers early-return on an inactive
    // job (`if (!isActiveJobStatus(job.status)) return job.id;`,
    // src/pipeline/package-job.ts), so a `done` written here could never be
    // corrected afterwards and GET /api/v1/jobs/{id} would keep reporting
    // success for an output that never arrived — the symptom in #1279. The
    // asset writes above still stand: they record where the packager really put
    // the output, which is true whether or not delivery then succeeded. The
    // caller attributes the failure (asset `packagingError`, the execution's
    // `package` step error, and failPackageJob).
    if (options?.settleJob === false) return true;
    // Settle the observable `package` Job (issue #976). Idempotent: an
    // at-least-once packager callback for an already-settled job is a no-op.
    const packageJobId = await completePackageJob(this.packageJobDeps(), { assetId });
    // Audit: package job reached terminal success (issue #564). One entry;
    // emitted only when the asset resolved (a callback for an unknown asset
    // returns false above and records nothing).
    emitAudit(
      this.deps.audit,
      {
        actor: originActor('system'),
        action: 'job.completed',
        targetType: 'job',
        // Same target as the submission entry: the `package` Job id when one
        // exists (issue #976), else the packaging correlation id (= assetId).
        targetId: packageJobId ?? assetId,
        detail: { jobType: 'package', assetId }
      },
      this.deps.auditLog
    );
    // Operational log: the `package` stage reached terminal success (issue #995).
    // Same guard as the audit entry — a callback for an unknown asset returned
    // false above and records nothing.
    logPipelineEvent(
      this.deps.pipelineLog,
      {
        stage: 'package',
        level: 'info',
        message: `job ${packageJobId ?? assetId} for asset ${assetId} completed; HLS and DASH manifests published`
      },
      this.deps.auditLog
    );
    return true;
  }

  // Invoked by POST /api/v1/internal/packagerCallback/failure.
  async handleFailure(assetId: string, message: string): Promise<boolean> {
    const asset = await this.deps.assets.get(assetId);
    if (!asset) return false;
    // Settle protection alongside the EXISTING `packagingError` write (issue
    // #1265, ADR-008 §12 "Packager fails after encryption started"): one patch,
    // no new error path, and no change to `asset.status` — a DRM failure leaves
    // the asset `ready` with `drm.status = 'failed'` (ADR-008 §8, C7). `drm` is
    // omitted from the patch for a clear asset and for an already-terminal
    // protection state, so the clear path is unchanged and a repeated failure
    // callback cannot rewrite a settled block.
    const failingPackageJobId =
      asset.drm?.status === 'pending'
        ? await resolvePackageJobId(this.packageJobDeps(), { assetId })
        : undefined;
    const settledDrm = settleDrmOnPackagerFailure(asset.drm, failingPackageJobId);
    await this.deps.assets.update(assetId, {
      packagingError: message,
      ...(settledDrm ? { drm: settledDrm } : {})
    });
    // Settle the observable `package` Job as failed WITH the reason (issue
    // #976), so the failure is readable from the Jobs tab without opening the
    // asset record. Idempotent, and a no-op when no job repository is wired.
    const packageJobId = await failPackageJob(this.packageJobDeps(), { assetId }, message);
    // Audit: package job reached terminal failure (issue #564). One entry;
    // emitted only when the asset resolved (unknown asset returns false above).
    emitAudit(
      this.deps.audit,
      {
        actor: originActor('system'),
        action: 'job.failed',
        targetType: 'job',
        // Same target as the submission entry (see handleSuccess).
        targetId: packageJobId ?? assetId,
        detail: { jobType: 'package', assetId, error: message }
      },
      this.deps.auditLog
    );
    // Operational log: the `package` stage reached terminal failure (issue #995).
    logPipelineEvent(
      this.deps.pipelineLog,
      {
        stage: 'package',
        level: 'error',
        message: `job ${packageJobId ?? assetId} for asset ${assetId} failed: ${message}`
      },
      this.deps.auditLog
    );
    return true;
  }

  // Settle a pending protection as `failed` WHERE THE FAILURE IS ACTUALLY
  // ATTRIBUTED (issue #1265 review).
  //
  // `handleFailure` above is not the only — nor, today, the live — failure
  // attribution path: the packager's failure callback carries no jobId of ours,
  // so POST /packagerCallback/failure correlates by execution state and calls
  // `failPackageJob` directly (src/routes/internal.ts), and the stalled-package
  // sweep does the same when no completion signal ever arrives
  // (src/pipeline/stalled-package-reconciler.ts, issue #336). Without this
  // method a real packager failure would leave `drm.status = 'pending'` forever,
  // because `pending` has no other exit (ADR-008 §12 "Packager fails after
  // encryption started": `failPackageJob` + `drm.status='failed'`).
  //
  // ONLY the DRM block is touched: `packagingError`, the execution's `package`
  // step and the `package` Job are written by the caller that owns them, exactly
  // as before. Correlated by the FAILING run's package Job id, so a clear
  // re-package failing never reports an earlier protected run as failed
  // (`correlatesWithRun`). Best-effort and never throws: DRM bookkeeping must
  // not turn a failure callback into a 5xx the packager would simply retry.
  // Returns true only when a block was actually settled.
  async settleProtectionFailure(
    assetId: string,
    failingPackageJobId?: string
  ): Promise<boolean> {
    try {
      const asset = await this.deps.assets.get(assetId);
      if (asset?.drm?.status !== 'pending') return false;
      const settledDrm = settleDrmOnPackagerFailure(asset.drm, failingPackageJobId);
      if (!settledDrm) return false;
      await this.deps.assets.update(assetId, { drm: settledDrm });
      return true;
    } catch (err) {
      this.deps.auditLog?.error(
        { err, assetId },
        'failed to settle DRM protection state after a packager failure (non-fatal)'
      );
      return false;
    }
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
