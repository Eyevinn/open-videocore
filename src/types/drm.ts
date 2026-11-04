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
// Contract source: ADR-008 §5.1 (the `KeyProvider` port — system identity,
// `ProtectionScheme`, `TrackTypeGroup`), §6 (CPIX request shape — system ids
// are configuration with well-known defaults), §8 (the `AssetDrm`
// status/errorCode enums) and decision D9 (`DRM_ENABLED`, default `false`).
//
// Naming (CLAUDE.md rule 1 / ADR-008 §5.3): no vendor or company name appears
// in any identifier, enum value or persisted value here. Adapters are named
// after the PROTOCOL they speak, and a DRM system is identified by its
// registered common-encryption system id (see `DrmSystemId` below), which is
// the standards vocabulary the protocol itself carries. Operator-facing vendor
// identity is free text in the per-stack config `label` (ADR-008 §5.2), never
// an enum and never persisted on an asset.
//
// NO KEY MATERIAL (ADR-008 D4): nothing in this module, and nothing in any type
// built from it, carries a content key. Only key IDENTIFIERS (`keyId`), system
// ids, licence/certificate URLs and status are ever persisted.

// Identity of a DRM system a package can be protected for (ADR-008 §5.1/§6).
//
// A system is identified by its COMMON-ENCRYPTION SYSTEM ID — the registered
// UUID the protocol itself uses — never by a short product name.
//
// Contract source (fetched 2026-11-03):
//   - CPIX 2.3 XML schema, `Dash-Industry-Forum/CPIX@master`
//     `XmlSchema/cpix.xsd`: `complexType DRMSystemType` declares
//     `<xs:attribute name="systemId" type="cpix:UUIDType" use="required"/>`
//     (cpix.xsd:114), and `simpleType UUIDType` restricts `xs:string` to
//     `[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}`
//     (cpix.xsd:6-10). So a system id is exactly a UUID, and it is the field
//     SPEKE v2 / CPIX already carries per `@kid`/`@systemId` pair.
//   - Registered values: DASH-IF "Content Protection Identifiers" registry,
//     https://dashif.org/identifiers/content_protection/ — the single
//     authoritative list of allocated system ids.
//
// WHY AN ID AND NOT A SHORT NAME (CLAUDE.md rule 1, ADR-008 §5.3): the short
// names in circulation for the deployed key systems are vendor trademarks, and
// §5.3 fixes that "no vendor name appears in any identifier, enum value, env
// var, route, file name, error string or configuration key". The system id is
// the standards-registered, vendor-neutral identity of the same thing, so
// nothing is lost: it is what goes into the CPIX request, what comes back in
// the response, and what a DASH `ContentProtection@schemeIdUri`
// (`urn:uuid:<systemId>`) and an EME key-system lookup are keyed on.
// Operator-facing naming stays free text in the per-stack `label`
// (ADR-008 §5.2) — never an enum, never persisted per asset.
//
// DELIBERATELY NOT A CLOSED ENUM: ADR-008 §6 "Request shape" states that
// registered system ids are configuration (`systemIds`) with well-known
// defaults, "so a provider using a non-default id needs no code change".
// Validation is therefore on the SHAPE the contract fixes (`cpix:UUIDType`)
// rather than on a hardcoded membership list — a malformed value is still
// rejected rather than silently persisted.
export type DrmSystemId = string;

// `cpix:UUIDType` (cpix.xsd:6-10), anchored. Hyphenated 8-4-4-4-12 hex; the
// schema is case-insensitive, so this is too.
export const DRM_SYSTEM_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isDrmSystemId(value: unknown): value is DrmSystemId {
  return typeof value === 'string' && DRM_SYSTEM_ID_PATTERN.test(value);
}

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
// unset or anything other than `true`, no DRM field is written from domain
// state and none is read back onto it, so the clear path is byte-for-byte
// unchanged and every pre-existing asset document round-trips exactly as it did
// before #1259. "Not read back" does NOT mean "dropped on the next write" — see
// `PRESERVED_DRM` below.
// Mirrors the `WATCH_FOLDER_ENABLED === 'true'` convention
// (src/pipeline/watch-folder.ts:69) also used by `thumbnailMultiSizeEnabled()`
// (src/pipeline/thumbnail.ts:63).
//
// Read at CALL time, never cached, so a test (and an operator restart) sees the
// current value rather than one captured at module load.
export function drmEnabled(): boolean {
  return process.env['DRM_ENABLED'] === 'true';
}

// Flag-off preservation carrier for an already-persisted `structural.drm` block.
//
// WHY THIS EXISTS. Every CouchDB write seam is a read-modify-write through
// `fromDoc` -> patch -> `toDoc` (src/data/couch-asset-repo.ts), and `toDoc`
// rebuilds the WHOLE document from the domain object rather than merging the
// prior body. So a field the read gate refuses to load is a field the next
// unrelated write (a rename, a thumbnail, a status change) deletes. With
// `DRM_ENABLED` off that would permanently destroy key identifiers, licence
// URLs and `protectedAt` — turning a reversible kill switch into data loss.
// `fromAssetDocument` therefore parks the persisted block here and
// `toAssetDocument` writes it straight back out, so flag-off is lossless and
// toggling the flag on again finds the asset exactly as it was.
//
// WHY A SYMBOL KEY, not a normal optional field. The whole point of the read
// gate is that nothing DRM-related can reach an HTTP response while the feature
// is off, and routes send the domain object directly (`reply.send(asset)`,
// src/routes/assets.ts). `JSON.stringify` ignores symbol-keyed properties, so
// this carrier cannot serialise into a response, a log line or the PostgreSQL
// search projection — while object spread (`{ ...existing }`, the shape of
// every patch helper) DOES copy it, so it survives the read-modify-write it
// exists for. It is transport for the mappers, not domain state: nothing reads
// it except `toAssetDocument`, and when the flag is ON it is never populated
// (the block loads into `Asset.drm` as normal).
export const PRESERVED_DRM: unique symbol = Symbol('open-videocore.preservedDrm');
