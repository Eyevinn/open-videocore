// Shared DRM enums and the deployment kill switch (ADR-008 "DRM protection for
// packaged VOD output", issue #1259).
//
// This module holds ONLY the vendor-neutral vocabulary that both the asset
// domain model (src/data/asset-repo.ts) and the per-execution request
// (src/data/pipeline-repo.ts) need, so neither has to import the other. It is
// deliberately dependency-free: no key provider, no transport, no Zod — the
// persisted/validated shapes live with their owners (`AssetDrm` in
// asset-repo.ts, `AssetDrmSchema` in asset-document.ts).
//
// Contract source: ADR-008 §5.1 (the `KeyProvider` port — `DrmSystem`,
// `ProtectionScheme`, `TrackTypeGroup`), §8 (the `AssetDrm` status/errorCode
// enums) and decision D9 (`DRM_ENABLED`, default `false`).
//
// Naming (CLAUDE.md rule 1 / ADR-008 §5.3): no vendor or company name appears
// in any identifier here. Adapters are named after the PROTOCOL they speak, and
// the `DrmSystem` members are the standardised key-system identifiers a player
// must be handed to configure EME — the interoperability vocabulary, not a
// product catalogue. Operator-facing vendor identity is free text in the
// per-stack config `label` (ADR-008 §5.2), never an enum.
//
// NO KEY MATERIAL (ADR-008 D4): nothing in this module, and nothing in any type
// built from it, carries a content key. Only key IDENTIFIERS (`keyId`), system
// ids, licence/certificate URLs and status are ever persisted.

// The DRM systems a package can be protected for (ADR-008 §5.1).
export const DRM_SYSTEMS = ['widevine', 'playready', 'fairplay'] as const;
export type DrmSystem = (typeof DRM_SYSTEMS)[number];

// CMAF common-encryption protection scheme (ADR-008 §5.1). `cbcs` is the
// per-stack default (D3); `cenc` is the full-sample AES-CTR alternative.
export const PROTECTION_SCHEMES = ['cenc', 'cbcs'] as const;
export type ProtectionScheme = (typeof PROTECTION_SCHEMES)[number];

// Track type groups a distinct content key can be bound to (ADR-008 §5.1/D3).
// One key per group, with the single-key profile (one group) as the default.
export const TRACK_TYPE_GROUPS = ['AUDIO', 'SD', 'HD', 'UHD1'] as const;
export type TrackTypeGroup = (typeof TRACK_TYPE_GROUPS)[number];

// Lifecycle of an asset's protection (ADR-008 §8). DELIBERATELY independent of
// `Asset.status`: an asset whose DRM step failed is still `ready` and carries
// `drm.status = 'failed'`, exactly as `packagingError` never moves the lifecycle
// (ADR-008 §8 "C7" paragraph).
export const DRM_STATUSES = ['pending', 'protected', 'failed', 'unsupported'] as const;
export type DrmStatus = (typeof DRM_STATUSES)[number];

// Machine-readable failure classes (ADR-008 §8). Provider error bodies are NOT
// echoed verbatim — they are mapped onto one of these and a truncated, scrubbed
// message (ADR-008 §10 "Logging and error redaction").
export const DRM_ERROR_CODES = [
  'drm_unsupported',
  'key_provider_unreachable',
  'key_provider_rejected',
  'key_provider_invalid_response',
  'drm_not_configured',
  'packaging_failed'
] as const;
export type DrmErrorCode = (typeof DRM_ERROR_CODES)[number];

// Deployment-level kill switch (ADR-008 D9). OFF by default: with the flag
// unset or anything other than `true`, no DRM field is written to any document
// and none is read back, so the clear path is byte-for-byte unchanged and every
// pre-existing asset document round-trips exactly as it did before #1259.
// Mirrors the `WATCH_FOLDER_ENABLED === 'true'` convention
// (src/pipeline/watch-folder.ts:69) also used by `thumbnailMultiSizeEnabled()`
// (src/pipeline/thumbnail.ts:63).
//
// Read at CALL time, never cached, so a test (and an operator restart) sees the
// current value rather than one captured at module load.
export function drmEnabled(): boolean {
  return process.env['DRM_ENABLED'] === 'true';
}
