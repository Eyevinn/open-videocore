// The `KeyProvider` port (ADR-008 §5.1, decisions D1/D3/D4; issue #1260).
//
// This is the seam every key-acquisition path goes through: one adapter per
// PROTOCOL, never per vendor (ADR-008 D1). Two adapters exist:
//   - `cpix`         — generic CPIX 2.3 / SPEKE over HTTPS (request builder in
//                      cpix-request.ts; the HTTP client and response parser are
//                      a separate ticket).
//   - `clearkey-dev` — locally generated keys for development only
//                      (clearkey-dev-provider.ts).
//
// CONTRACT SOURCES (contract-first, CLAUDE.md rule 7). Every type below is
// copied field-for-field from ADR-008 §5.1 `## 5.1 Port`; the two deliberate,
// documented deviations are marked `DEVIATION` inline and nothing else differs:
//   - ADR-008 §5.1 — `DrmSystem`, `ProtectionScheme`, `TrackTypeGroup`,
//     `KeyRequest`, `ContentKey`, `DrmSignalling`, `KeyProvider`.
//   - ADR-008 §4 D1 (adapter set + `kind` values), D3 (scheme/track-group
//     defaults), D4 (keys are never persisted, logged or returned).
//   - src/types/drm.ts — the already-landed shared vocabulary (issue #1259):
//     `DrmSystemId`, `ProtectionScheme`, `TrackTypeGroup`. Imported rather than
//     redeclared so the port, the persisted `AssetDrm` (src/data/asset-repo.ts)
//     and the document schema (src/data/asset-document.ts) cannot drift.
//
// NAMING (CLAUDE.md rule 1, ADR-008 §5.3): no vendor, company or product name
// appears in any identifier, type member, value or comment here. ADR-008 §5.1
// spells `DrmSystem` as a three-value union of product short names; those names
// are trademarks, so — exactly as issue #1259 already resolved for the persisted
// model — a DRM system is identified by its registered common-encryption system
// id (`DrmSystemId`, src/types/drm.ts), which is the identity the protocol
// itself carries in `DRMSystem@systemId`. The field NAMES of §5.1 are unchanged.

import type { DrmSystemId, ProtectionScheme, TrackTypeGroup } from '../types/drm.js';

export type { DrmSystemId, ProtectionScheme, TrackTypeGroup };

// Well-known common-encryption system ids, used when the stack configuration
// (`StackConfig.drm.systemIds`, ADR-008 §5.2) does not pin its own set.
//
// ADR-008 §6 "Request shape": "Registered system ids are configuration
// (`systemIds`), with well-known defaults, so a provider using a non-default id
// needs no code change." No id is therefore hardcoded on a request path — the
// request builder is always GIVEN the ids to ask for (`KeyRequest.systems`), and
// these defaults are only the fallback `resolveDrmSystemIds()` applies when
// configuration supplies none.
//
// Contract source (fetched 2026-11-04): DASH-IF "Content Protection
// Identifiers" registry, https://dashif.org/identifiers/content_protection/ —
// the authoritative list of allocated system ids. The three below are the
// registry rows for the three widely deployed key systems and are the same
// values the #1259 document round-trip test already uses. The shape is fixed by
// `cpix:UUIDType` (cpix.xsd:6-10), validated by `isDrmSystemId()`.
export const DEFAULT_DRM_SYSTEM_IDS: readonly DrmSystemId[] = Object.freeze([
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
  '9a04f079-9840-4286-ab92-e65be0885f95',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2'
]);

// W3C Clear Key, as registered for DASH presentations in the same DASH-IF
// registry ("This identifier is meant to be used to signal the availability of
// W3C Clear Key in the context of a DASH presentation"). Not a product — the
// W3C-defined cleartext key system, which is why it is the default the
// development adapter signals (ADR-008 §5.3 "Self-hosted clear-key").
export const CLEAR_KEY_SYSTEM_ID: DrmSystemId = 'e2719d58-a985-b3c9-781a-b030af78d30e';

// The configured system ids for a stack, with the well-known defaults as
// fallback. Returns a defensive copy, so a caller cannot mutate the defaults.
// An empty configured array is treated as "not configured" rather than as "ask
// for no systems" — a key request for zero systems is a configuration mistake,
// not an intent.
export function resolveDrmSystemIds(configured?: readonly DrmSystemId[]): DrmSystemId[] {
  return configured && configured.length > 0 ? [...configured] : [...DEFAULT_DRM_SYSTEM_IDS];
}

// What to ask the provider for (ADR-008 §5.1 `KeyRequest`).
export type KeyRequest = {
  // = asset id. Stable on purpose: a re-package re-requests the SAME kids
  // instead of minting new ones, so a retry cannot orphan an already-published
  // manifest (ADR-008 §6 "Idempotency").
  contentId: string;
  // The systems to request, each as its registered common-encryption system id.
  // Supplied by the caller from configuration (see `resolveDrmSystemIds`).
  systems: DrmSystemId[];
  scheme: ProtectionScheme;
  // `['AUDIO','SD','HD']` etc. A SINGLE element is the single-key profile, which
  // is the default (ADR-008 D3).
  trackGroups: TrackTypeGroup[];
  // Supplied on re-package for key stability (ADR-008 §5.1/§6).
  //
  // DEVIATION from §5.1, optionality only: the ADR writes
  // `Record<TrackTypeGroup, string>`, which demands an entry for all four
  // groups. A request names its groups in `trackGroups` and the default profile
  // has exactly one, so a total record would be unsatisfiable for the default
  // case. `Partial` is the usable shape; the field name and value type are
  // unchanged.
  keyIds?: Partial<Record<TrackTypeGroup, string>>;
};

// One content key (ADR-008 §5.1 `ContentKey`).
//
// TRANSIENT (ADR-008 D4 / §10 "Key material"). `key` holds raw key bytes and
// lives ONLY in the call stack that builds the package job. This type must never
// be:
//   - persisted      — the stored shape is `AssetDrm` (src/data/asset-repo.ts),
//                      which carries `keyIds` (IDENTIFIERS) and no `key` member;
//   - logged         — adapters log method, host, status, latency and
//                      `contentId` only (ADR-008 §10);
//   - audited        — `emitAudit` details carry `keyIds`, never keys;
//   - returned       — no HTTP response schema contains key material, including
//                      `GET /api/v1/assets/:id/drm` and the delivery `drm`
//                      block (ADR-008 §9).
// Hold it in a local, hand it to the packaging job, drop the reference. Do not
// widen any persisted or serialised type to accept a `ContentKey`.
export type ContentKey = {
  trackGroup: TrackTypeGroup;
  // UUID. This is the only part of a key that is ever persisted (ADR-008 D4).
  keyId: string;
  // 16 bytes, TRANSIENT — never persisted, never logged (ADR-008 §5.1).
  key: Uint8Array;
  // Hex, optional (provider-supplied) (ADR-008 §5.1).
  iv?: string;
};

// Everything a packager and a player need in order to signal the protection
// (ADR-008 §5.1 `DrmSignalling`). All maps are keyed by system id and are
// PARTIAL by nature: a provider may return data for only some requested
// systems, and the key space is the open registry of system ids rather than a
// closed enum (the same reasoning as `AssetDrm.licenceUrls`, asset-repo.ts).
// No member of this type carries key material.
export type DrmSignalling = {
  // Base64 PSSH box per system.
  pssh: Record<DrmSystemId, string>;
  // DASH ContentProtection element per system, base64.
  contentProtectionData?: Record<DrmSystemId, string>;
  // Base64 HLS key lines per system.
  hlsSignallingData?: Record<DrmSystemId, string>;
  licenceUrls: Record<DrmSystemId, string>;
  // Application certificate URL, where the system needs one.
  certificateUrl?: string;
  // HLS key URI, where the system uses one.
  hlsKeyUri?: string;
  // Development marker (issue #1260; ADR-008 §10 "Clear-key adapter"): set by
  // `clearkey-dev` ONLY, so a development stream can never be mistaken for
  // protected content anywhere downstream. Absent for every real provider —
  // this is the one member not in the §5.1 listing, added because §10 requires
  // the marking and the issue specifies it on this type.
  dev?: true;
};

// The port itself (ADR-008 §5.1 `KeyProvider`).
export interface KeyProvider {
  // Operator-chosen config id, e.g. 'primary' (ADR-008 §5.2 `providerId`).
  readonly id: string;
  // The PROTOCOL the adapter speaks — never a vendor (ADR-008 D1/§5.3).
  readonly kind: 'cpix' | 'clearkey-dev';
  // `signal` is mandatory, not optional: every external call in this codebase
  // is bounded (ADR-008 §12 gives the key step a 60 s whole-step deadline), and
  // an adapter that generates keys locally still honours an already-aborted
  // signal so callers behave identically across adapters.
  acquire(
    req: KeyRequest,
    signal: AbortSignal
  ): Promise<{ keys: ContentKey[]; signalling: DrmSignalling }>;
}
