// Non-secret per-stack DRM configuration: the `StackConfig.drm` model, its
// validation, the gated parameter-store read/write, the runtime credential
// STATUS reader, and the shared `DRM_ENABLED` gate (issue #1295).
//
// Contract sources (fetched 2026-11-04, CLAUDE.md rule 7). Each symbol below is
// REUSED, never redefined:
//   - ADR-008 §5.2 "Configuration model" (docs/architecture/ADR-008-drm-protection.md:175-215)
//     — the exact field list of the `StackConfig.drm` block (`enabled`,
//     `providerKind`, `providerId`, `label`, `keyServerUrl`, `spekeVersion`,
//     `authMode`, `scheme`, `systems`, `systemIds`, `licenceUrls`,
//     `certificateUrl`, `trackGroups`), the credential env-var table, and
//     "v1 supports ONE provider configuration per stack".
//   - ADR-008 §9 "API surface" (ADR-008-drm-protection.md:366-374) — "every
//     route is `501 not_configured` while `DRM_ENABLED=false`" and
//     "credential presence reported as `credentials: "configured" | "missing"`,
//     never values".
//   - ADR-008 D5 (line 121) — credentials are operator ENV VARS; coordinates
//     are non-secret and live in the per-stack parameter store.
//   - ADR-008 D6 (line 122) — "DRM config is per stack (the same scoping
//     `StackConfig` already has)"; no `workspaceId` on any DRM document.
//   - ADR-008 D9 (line 125) — `DRM_ENABLED`, default `false`.
//   - src/types/drm.ts:`PROTECTION_SCHEMES`, `ProtectionScheme`,
//     `TRACK_TYPE_GROUPS`, `TrackTypeGroup`, `DRM_SYSTEM_ID_PATTERN`,
//     `isDrmSystemId`, `DrmSystemId`, `drmEnabled` — the shared vocabulary.
//   - src/drm/cpix-provider.ts:`CPIX_AUTH_MODES`, `CpixAuthMode`,
//     `ENV_USERNAME`, `ENV_PASSWORD`, `ENV_TOKEN`, `ENV_CLIENT_CERT`,
//     `ENV_CLIENT_KEY` — the auth-mode enum and the verbatim env-var names.
//     cpix-provider.ts:75-78 states these are "exported so the config surface
//     (`GET /api/v1/drm/config` reporting `credentials: configured | missing`,
//     §9) ... read the same constants instead of retyping the strings", which
//     is exactly what `readDrmCredentialStatus` below does.
//   - src/drm/cpix-request.ts:`SpekeVersion` (= `'1.0' | '2.0'`, line 99).
//   - src/services/param-store.ts:`ParamStore.loadStackConfig` /
//     `storeStackConfig` / `StackConfig` — the read/write API this module
//     gates. `storeStackConfig` persists the WHOLE `StackConfig` via
//     `JSON.stringify` after `assertNoCredentials`, so a new optional member
//     round-trips without a store-side change.
//
// NO SECRET VALUE EVER CROSSES THIS MODULE'S BOUNDARY (ADR-008 §5.2, §10, D4).
// `readDrmCredentialStatus` tests PRESENCE only: it never returns, embeds,
// logs, or stores a credential, and `DrmCredentialStatus` is a two-value string
// union so there is nowhere for a value to hide. Nothing here accepts a
// credential as input either — the only credential source is `process.env`,
// read at CALL time.
//
// That guarantee rests on an ALLOWLIST, not on a list of forbidden names:
// `validateDrmStackConfig` rejects every key outside
// `DRM_STACK_CONFIG_FIELD_NAMES`, and `projectDrmStackConfig` drops them on the
// way to the store and to the response. A credential under a name nobody
// anticipated (`clientSecret`, `authToken`, `pwd`) is therefore refused because
// it is not a DRM coordinate, which is also why a typo'd field is a `400`
// rather than a silently ignored one. `DRM_CREDENTIAL_FIELD_NAMES` survives as
// the diagnostic layer that turns the common mistakes into a specific message.
//
// The read view adds exactly one derived field, `credentials`
// (`DrmConfigView`), and the write path accepts it as a status value and strips
// it — so GET `/api/v1/drm/config` → PUT the same body back is valid, which it
// must be for any client that edits a config it just read.
//
// NAMING (CLAUDE.md rule 1 / ADR-008 §5.3): no vendor or product name appears
// in any identifier, enum value, env var or configuration key. ADR-008 §5.2's
// JSON sketch keys `systems` / `licenceUrls` by short product names; §5.3
// overrides that ("no vendor name appears in any identifier, enum value, env
// var, route, file name, error string or configuration key"), and src/types/drm.ts
// already resolved it the same way — a DRM system is identified by its
// registered common-encryption system id (`DrmSystemId`, a UUID). So `systems`
// is `DrmSystemId[]` and `licenceUrls` is keyed BY SYSTEM ID. Operator-facing
// vendor identity stays free text in `label`.

import {
  CPIX_AUTH_MODES,
  ENV_CLIENT_CERT,
  ENV_CLIENT_KEY,
  ENV_PASSWORD,
  ENV_TOKEN,
  ENV_USERNAME,
  type CpixAuthMode
} from './cpix-provider.js';
import type { SpekeVersion } from './cpix-request.js';
import {
  PROTECTION_SCHEMES,
  TRACK_TYPE_GROUPS,
  drmEnabled,
  isDrmSystemId,
  type DrmSystemId,
  type ProtectionScheme,
  type TrackTypeGroup
} from '../types/drm.js';
import type { ParamStore, StackConfig } from '../services/param-store.js';

// Key-acquisition adapter kinds (ADR-008 D1, §5.2 `providerKind`). Named after
// the PROTOCOL, never a vendor: `cpix` speaks generic CPIX 2.3 / SPEKE v2 over
// HTTPS; `clearkey-dev` generates keys locally and is development-only
// (ADR-008 §5.3 "never for production content").
export const DRM_PROVIDER_KINDS = ['cpix', 'clearkey-dev'] as const;
export type DrmProviderKind = (typeof DRM_PROVIDER_KINDS)[number];

// The `spekeVersion` enum of ADR-008 §5.2, as a runtime membership list.
// `SpekeVersion` itself is a bare union in cpix-request.ts:99 with no companion
// array, so this is the array form of THAT type — the `satisfies` clause makes
// the compiler reject any drift between the two.
export const DRM_SPEKE_VERSIONS = ['1.0', '2.0'] as const satisfies readonly SpekeVersion[];

// Auth modes, re-exported from the single definition in cpix-provider.ts so a
// consumer of the config model does not have to import the provider.
export { CPIX_AUTH_MODES, type CpixAuthMode };

// Whether the operator credential for a given `authMode` is present in the
// environment. The ONLY thing any DRM surface is allowed to say about a
// credential (ADR-008 §9).
export const DRM_CREDENTIAL_STATUSES = ['configured', 'missing'] as const;
export type DrmCredentialStatus = (typeof DRM_CREDENTIAL_STATUSES)[number];

// The non-secret DRM block persisted on a stack's config (ADR-008 §5.2).
//
// Every member is a URL, an identifier, an enum value or free text. There is
// deliberately NO member for a username, password, token, certificate or key:
// those are operator env vars (D5) and are rejected on the write path by
// `assertNoDrmCredentials` (param-store.ts) as defence in depth.
export type DrmStackConfig = {
  // Per-stack switch, independent of the deployment-level `DRM_ENABLED` kill
  // switch (D9). Both must be true for DRM to act: the flag gates the whole
  // deployment, this gates one stack.
  enabled: boolean;
  providerKind: DrmProviderKind;
  // Opaque operator-chosen id for this provider configuration. v1 supports ONE
  // per stack (ADR-008 §5.2); the field exists so per-asset provider selection
  // is additive later.
  providerId: string;
  // Operator-chosen free text identifying the provider in the UI. NOT an enum
  // and never persisted on an asset (ADR-008 §5.2/§5.3) — this is the one place
  // vendor identity lives, as operator DATA rather than as code.
  label?: string;
  // The provider's CPIX/SPEKE endpoint. HTTPS ONLY (see `validateDrmStackConfig`):
  // a key request and its response carry key material, so plaintext HTTP is
  // refused outright rather than warned about (ADR-008 §10).
  // Required for `providerKind: 'cpix'`; meaningless for `clearkey-dev`, which
  // generates keys locally and calls no endpoint.
  keyServerUrl?: string;
  spekeVersion?: SpekeVersion;
  authMode?: CpixAuthMode;
  // CMAF common-encryption scheme (`PROTECTION_SCHEMES`). Default `cbcs` (D3).
  scheme?: ProtectionScheme;
  // Registered common-encryption system ids to request keys for. Absent or
  // empty means "use the well-known defaults" — `resolveDrmSystemIds`
  // (key-provider.ts) owns that fallback, not this type.
  systems?: DrmSystemId[];
  // Per-system licence service URLs, keyed BY SYSTEM ID, handed to players via
  // the delivery `drm` block (ADR-008 §9). Licence requests never pass through
  // open-videocore (N4), so these are opaque pass-through values.
  licenceUrls?: Record<DrmSystemId, string>;
  // Per-system certificate URLs, keyed BY SYSTEM ID. ADR-008 §5.2 sketches a
  // single `certificateUrl`, but §9's delivery block carries a certificate
  // alongside ONE system's entry, so keying it the same way as `licenceUrls`
  // keeps the two consistent and stays additive.
  certificateUrls?: Record<DrmSystemId, string>;
  // Track type groups a distinct key is bound to (`TRACK_TYPE_GROUPS`).
  // Absent means the single-key profile (D3 default).
  trackGroups?: TrackTypeGroup[];
};

// One rejected field, as `field` + a machine-readable `reason`. Messages are
// built from the FIELD NAME and the allowed set only — never from a credential
// or from a provider error body (ADR-008 §10 "Logging and error redaction").
export type DrmConfigValidationError = { field: string; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// True only for a syntactically valid absolute `https:` URL. Used for every URL
// in the model: the key server (key material in flight) and the licence /
// certificate URLs (handed to players, so a plaintext one would downgrade the
// player's licence exchange).
function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  // No embedded userinfo: a credential must never reach the parameter store
  // (D5), and `https://user:pass@host/` would smuggle one through a URL field.
  if (parsed.username !== '' || parsed.password !== '') return false;
  return parsed.protocol === 'https:';
}

// The ALLOWLIST: every key `StackConfig.drm` may carry (ADR-008 §5.2's field
// list, as adapted by §5.3 — see the header note on `certificateUrls`). This is
// the authoritative gate on the write path: a key that is not here is not a DRM
// coordinate, so it is never validated, never persisted and never returned,
// whatever it is named. The name denylist below is only a DIAGNOSTIC layer on
// top of it (a better error message for a recognisably credential-shaped key),
// not the defence — a denylist alone cannot see a key it was not told about.
export const DRM_STACK_CONFIG_FIELD_NAMES = Object.freeze([
  'enabled',
  'providerKind',
  'providerId',
  'label',
  'keyServerUrl',
  'spekeVersion',
  'authMode',
  'scheme',
  'systems',
  'licenceUrls',
  'certificateUrls',
  'trackGroups'
] as const) satisfies readonly (keyof DrmStackConfig)[];

// Compile-time drift guard in the OTHER direction: `satisfies` above proves
// every listed name is a real member, and this proves every real member is
// listed. Adding a field to `DrmStackConfig` without adding it here is a type
// error rather than a silently un-persistable field.
type UnlistedDrmStackConfigField = Exclude<
  keyof DrmStackConfig,
  (typeof DRM_STACK_CONFIG_FIELD_NAMES)[number]
>;
const _allDrmFieldsListed: UnlistedDrmStackConfigField extends never
  ? true
  : never = true;
void _allDrmFieldsListed;

// Keys that exist on the READ view only (`DrmConfigView`) and are DERIVED, not
// stored. A client that GETs the config and PUTs it back unchanged sends these,
// so the write path must accept them — and then DROP them (`projectDrmStackConfig`),
// because the stored block has no such member. `credentials` is the credential
// STATUS of ADR-008 §9 (`'configured' | 'missing'`), not a credential value;
// conflating the two is what made the GET→PUT round trip impossible.
export const DRM_CONFIG_VIEW_ONLY_FIELD_NAMES: readonly string[] = Object.freeze(
  ['credentials']
);

// Field names that would carry a SECRET VALUE. ADR-008 §5.2 keeps every
// credential in the environment, so any of these appearing in a config body is
// a rejected field rather than a stored one (the `400 invalid_field` of §9).
//
// Diagnostic layer only — `DRM_STACK_CONFIG_FIELD_NAMES` is what actually keeps
// an unlisted key out of the store. Deliberately NOT containing `credentials`:
// that name belongs to the read view's status field (see
// `DRM_CONFIG_VIEW_ONLY_FIELD_NAMES`), and a non-status value under it is
// rejected by its own check in `validateDrmStackConfig` instead.
export const DRM_CREDENTIAL_FIELD_NAMES: readonly string[] = Object.freeze([
  'username',
  'password',
  'pwd',
  'passphrase',
  'token',
  'authToken',
  'secret',
  'clientSecret',
  'clientCert',
  'clientKey',
  'certificate',
  'privateKey',
  'apiKey'
]);

// Validate a candidate `StackConfig.drm` block (ADR-008 §5.2).
//
// Returns EVERY problem rather than throwing on the first, so an operator fixes
// one round-trip instead of N. An empty array means valid.
//
// Checks, in order: no credential-shaped field; no unknown field (allowlist);
// required members present and well-typed; each enum value in its shared
// membership list; every URL an absolute credential-free `https:` URL; every
// system id a `cpix:UUIDType`.
export function validateDrmStackConfig(
  candidate: unknown
): DrmConfigValidationError[] {
  const errors: DrmConfigValidationError[] = [];
  if (!isPlainObject(candidate)) {
    return [{ field: 'drm', reason: 'must be an object' }];
  }

  // The candidate's OWN keys. Enumerated (rather than probed name by name with
  // `in`) so an unlisted key cannot hide from the checks below, and so a key
  // inherited from a prototype is not mistaken for a submitted one.
  const keys = Object.keys(candidate);

  // Credential-shaped fields first: refuse the whole body before validating the
  // rest, so a caller never gets a "looks nearly valid" response for a body
  // that tried to store a secret.
  for (const name of keys) {
    if (DRM_CREDENTIAL_FIELD_NAMES.includes(name)) {
      errors.push({
        field: name,
        reason:
          'credentials are operator environment variables and are never stored in the parameter store'
      });
    }
  }
  // `credentials` is the read view's derived STATUS field (ADR-008 §9), so it
  // round-trips from a GET; anything else under that name is an attempt to
  // write a credential and is refused with the same diagnostic.
  const credentials = candidate['credentials'];
  if (
    credentials !== undefined &&
    !DRM_CREDENTIAL_STATUSES.includes(credentials as DrmCredentialStatus)
  ) {
    errors.push({
      field: 'credentials',
      reason: `is read-only and must be one of ${DRM_CREDENTIAL_STATUSES.join(
        ', '
      )}; credentials are operator environment variables and are never stored in the parameter store`
    });
  }
  if (errors.length > 0) return errors;

  // ALLOWLIST: anything that is neither a stored coordinate nor a derived
  // read-view field is rejected rather than stored. This is what closes the
  // name-denylist bypass (a key called `clientSecret2` or `sessionKey` is not a
  // DRM coordinate whether or not the denylist happens to name it) and what
  // turns a typo (`scheem`) into a `400` instead of a silently ignored field.
  for (const name of keys) {
    if ((DRM_STACK_CONFIG_FIELD_NAMES as readonly string[]).includes(name)) {
      continue;
    }
    if (DRM_CONFIG_VIEW_ONLY_FIELD_NAMES.includes(name)) continue;
    errors.push({
      field: name,
      reason: `is not a DRM configuration field; allowed fields are ${DRM_STACK_CONFIG_FIELD_NAMES.join(
        ', '
      )}`
    });
  }

  if (typeof candidate['enabled'] !== 'boolean') {
    errors.push({ field: 'enabled', reason: 'must be a boolean' });
  }

  const providerKind = candidate['providerKind'];
  if (!DRM_PROVIDER_KINDS.includes(providerKind as DrmProviderKind)) {
    errors.push({
      field: 'providerKind',
      reason: `must be one of ${DRM_PROVIDER_KINDS.join(', ')}`
    });
  }

  const providerId = candidate['providerId'];
  if (typeof providerId !== 'string' || providerId.trim().length === 0) {
    errors.push({ field: 'providerId', reason: 'must be a non-empty string' });
  }

  if ('label' in candidate && typeof candidate['label'] !== 'string') {
    errors.push({ field: 'label', reason: 'must be a string' });
  }

  // `keyServerUrl` is REQUIRED for the `cpix` adapter (it has nowhere to send a
  // key request otherwise) and meaningless for `clearkey-dev`. When present it
  // must be https either way.
  const keyServerUrl = candidate['keyServerUrl'];
  if (keyServerUrl === undefined) {
    if (providerKind === 'cpix') {
      errors.push({
        field: 'keyServerUrl',
        reason: "is required when providerKind is 'cpix'"
      });
    }
  } else if (!isHttpsUrl(keyServerUrl)) {
    errors.push({
      field: 'keyServerUrl',
      reason: 'must be an absolute https:// URL with no embedded credentials'
    });
  }

  const spekeVersion = candidate['spekeVersion'];
  if (
    spekeVersion !== undefined &&
    !DRM_SPEKE_VERSIONS.includes(spekeVersion as SpekeVersion)
  ) {
    errors.push({
      field: 'spekeVersion',
      reason: `must be one of ${DRM_SPEKE_VERSIONS.join(', ')}`
    });
  }

  const authMode = candidate['authMode'];
  if (authMode !== undefined && !CPIX_AUTH_MODES.includes(authMode as CpixAuthMode)) {
    errors.push({
      field: 'authMode',
      reason: `must be one of ${CPIX_AUTH_MODES.join(', ')}`
    });
  }

  const scheme = candidate['scheme'];
  if (
    scheme !== undefined &&
    !PROTECTION_SCHEMES.includes(scheme as ProtectionScheme)
  ) {
    errors.push({
      field: 'scheme',
      reason: `must be one of ${PROTECTION_SCHEMES.join(', ')}`
    });
  }

  const systems = candidate['systems'];
  if (systems !== undefined) {
    if (!Array.isArray(systems)) {
      errors.push({ field: 'systems', reason: 'must be an array of system ids' });
    } else {
      systems.forEach((entry, index) => {
        if (!isDrmSystemId(entry)) {
          errors.push({
            field: `systems[${index}]`,
            reason: 'must be a registered DRM system id (UUID)'
          });
        }
      });
    }
  }

  const trackGroups = candidate['trackGroups'];
  if (trackGroups !== undefined) {
    if (!Array.isArray(trackGroups)) {
      errors.push({ field: 'trackGroups', reason: 'must be an array' });
    } else {
      trackGroups.forEach((entry, index) => {
        if (!TRACK_TYPE_GROUPS.includes(entry as TrackTypeGroup)) {
          errors.push({
            field: `trackGroups[${index}]`,
            reason: `must be one of ${TRACK_TYPE_GROUPS.join(', ')}`
          });
        }
      });
    }
  }

  // `licenceUrls` / `certificateUrls` are keyed by system id and valued with an
  // https URL. Both halves are validated: a malformed KEY would silently never
  // match a requested system, which is a configuration bug that should surface
  // at write time rather than as a player failure.
  for (const field of ['licenceUrls', 'certificateUrls'] as const) {
    const value = candidate[field];
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      errors.push({
        field,
        reason: 'must be an object keyed by DRM system id'
      });
      continue;
    }
    for (const [systemId, url] of Object.entries(value)) {
      if (!isDrmSystemId(systemId)) {
        errors.push({
          field: `${field}.${systemId}`,
          reason: 'key must be a registered DRM system id (UUID)'
        });
      }
      if (!isHttpsUrl(url)) {
        errors.push({
          field: `${field}.${systemId}`,
          reason: 'must be an absolute https:// URL with no embedded credentials'
        });
      }
    }
  }

  return errors;
}

// Throwing form of `validateDrmStackConfig`, for the write path. The message
// lists FIELD NAMES and reasons only — never a submitted value, so a body that
// put a credential in the wrong field cannot echo it into a log line.
export class DrmConfigValidationFailure extends Error {
  readonly errors: DrmConfigValidationError[];
  constructor(errors: DrmConfigValidationError[]) {
    super(
      `invalid DRM configuration: ${errors
        .map((e) => `${e.field} ${e.reason}`)
        .join('; ')}`
    );
    this.name = 'DrmConfigValidationFailure';
    this.errors = errors;
  }
}

export function assertValidDrmStackConfig(
  candidate: unknown
): asserts candidate is DrmStackConfig {
  const errors = validateDrmStackConfig(candidate);
  if (errors.length > 0) throw new DrmConfigValidationFailure(errors);
}

// Project a (validated) candidate down to the allowlisted coordinates, dropping
// derived read-view fields (`credentials`) and anything else not in
// `DRM_STACK_CONFIG_FIELD_NAMES`.
//
// Validation REJECTS an unknown field, so in the normal flow there is nothing
// left to drop; this is the structural guarantee behind that promise — the only
// value that can reach `storeStackConfig` or a response body is one of the
// twelve known coordinates, even on a path that skipped validation or that
// re-reads a block written by an older build. `undefined` members are preserved
// as absent rather than as explicit `undefined`, so a projected block
// `JSON.stringify`s to the same bytes as the block it came from.
export function projectDrmStackConfig(config: DrmStackConfig): DrmStackConfig {
  const source = config as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const name of DRM_STACK_CONFIG_FIELD_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(source, name)) continue;
    if (source[name] === undefined) continue;
    projected[name] = source[name];
  }
  return projected as unknown as DrmStackConfig;
}

// ---------------------------------------------------------------------------
// The shared DRM_ENABLED gate (ADR-008 D9, §9)
// ---------------------------------------------------------------------------

// The uniform 501 body every DRM route returns while the flag is off (ADR-008
// §9 "every route is `501 not_configured` while `DRM_ENABLED=false`"). Mirrors
// the `notConfiguredPayload` shape of routes/export-destinations.ts:278-281 and
// routes/storage.ts:591.
export const DRM_NOT_CONFIGURED_STATUS = 501 as const;
export const DRM_NOT_CONFIGURED_PAYLOAD = Object.freeze({
  error: 'not_configured' as const,
  message: 'DRM is not configured on this deployment'
});

// The minimal slice of a Fastify reply the gate needs, so the gate (and its
// tests) do not need a server. Structurally satisfied by `FastifyReply`.
export type DrmGateReply = {
  code(statusCode: number): { send(payload: unknown): unknown };
};

// Shared gate for every DRM route. Returns `true` when the request was REFUSED
// (the 501 has been sent and the handler must return immediately), `false` when
// DRM is on and the handler may proceed.
//
// Deliberately takes NO parameter store and performs NO I/O: the flag is a
// process env read (`drmEnabled()`, read at call time so it is never cached),
// so a flag-off deployment answers without touching the parameter store, the
// network, or the key provider. That is what makes the kill switch total rather
// than merely cosmetic.
//
//   if (drmGateClosed(reply)) return;
export function drmGateClosed(reply: DrmGateReply): boolean {
  if (drmEnabled()) return false;
  reply.code(DRM_NOT_CONFIGURED_STATUS).send(DRM_NOT_CONFIGURED_PAYLOAD);
  return true;
}

// ---------------------------------------------------------------------------
// Credential STATUS reader (ADR-008 §9, D5)
// ---------------------------------------------------------------------------

// Which env vars back each auth mode, verbatim from ADR-008 §5.2's table and
// built from the constants cpix-provider.ts already exports. ALL listed vars
// must be present for a mode to read `configured` — a half-configured mode
// (a username with no password) is `missing`, because it cannot authenticate.
export const DRM_CREDENTIAL_ENV_VARS: Readonly<
  Record<CpixAuthMode, readonly string[]>
> = Object.freeze({
  basic: Object.freeze([ENV_USERNAME, ENV_PASSWORD]),
  bearer: Object.freeze([ENV_TOKEN]),
  mtls: Object.freeze([ENV_CLIENT_CERT, ENV_CLIENT_KEY])
});

// Report whether the provider credential for `authMode` is present — and
// NOTHING else (ADR-008 §9: "credential presence reported as `credentials:
// "configured" | "missing"`, never values").
//
// The return type is a two-value string union, so there is structurally nowhere
// for a secret to leak: this function never returns, logs, stores, or embeds a
// credential value, and it does not report WHICH of a mode's vars is missing
// (that would narrow the value for a probing caller without helping an
// operator, who can read the mode's documented var list).
//
// `env` defaults to `process.env` and is read at CALL time, never cached, so an
// operator restart (and a test) sees the current environment rather than one
// captured at module load — the same convention as `drmEnabled()`
// (types/drm.ts) and `CpixKeyProvider`'s `options.env` (cpix-provider.ts:250).
//
// A value that is present but empty/whitespace-only counts as MISSING: an empty
// `DRM_KEY_PROVIDER_TOKEN` is an unset credential, not a usable one.
export function readDrmCredentialStatus(
  authMode: CpixAuthMode,
  env: NodeJS.ProcessEnv = process.env
): DrmCredentialStatus {
  const required = DRM_CREDENTIAL_ENV_VARS[authMode];
  // An unknown mode cannot be authenticated, so it is `missing` rather than a
  // throw: this function is on a read path that must never fail a response.
  if (required === undefined) return 'missing';
  for (const name of required) {
    const value = env[name];
    if (typeof value !== 'string' || value.trim().length === 0) return 'missing';
  }
  return 'configured';
}

// The operator-facing view of a stack's DRM configuration: the non-secret block
// plus the credential STATUS (ADR-008 §9 `GET /api/v1/drm/config`). This is the
// shape a route serialises, which is why it carries a status string and no
// credential field of any kind.
export type DrmConfigView = DrmStackConfig & {
  credentials: DrmCredentialStatus;
};

// Build the response view for a stored config. `authMode` defaults to `basic`
// (ADR-008 §5.2's example value) when a config omits it, so the reported status
// always refers to a concrete mode.
//
// The stored block is PROJECTED rather than spread: only the allowlisted
// coordinates are serialised, so a block that somehow acquired an extra key
// (an older build, a hand-edited parameter-store value) cannot echo it back
// into a response — the view carries the twelve coordinates and the status
// string, and nothing else.
export function toDrmConfigView(
  config: DrmStackConfig,
  env: NodeJS.ProcessEnv = process.env
): DrmConfigView {
  return {
    ...projectDrmStackConfig(config),
    credentials: readDrmCredentialStatus(config.authMode ?? 'basic', env)
  };
}

// ---------------------------------------------------------------------------
// Gated parameter-store read / write (ADR-008 D5, D6, D9)
// ---------------------------------------------------------------------------

// Read one stack's DRM block.
//
// FLAG-OFF SHORT-CIRCUIT (D9): with `DRM_ENABLED` off this returns `undefined`
// WITHOUT calling the parameter store at all — no `loadStackConfig`, no HTTP,
// no OSC token mint. The kill switch is checked before any I/O, so turning DRM
// off cannot be observed as a change in parameter-store traffic and cannot fail
// on a deployment that has no DRM config stored.
//
// Scoping follows D6: per stack, using the workspace+name scoping
// `StackConfig` already has (param-store.ts:`stackConfigKey`). No DRM-specific
// key and no `workspaceId` inside the block.
export async function loadDrmStackConfig(
  paramStore: ParamStore,
  workspaceId: string,
  stackName: string
): Promise<DrmStackConfig | undefined> {
  if (!drmEnabled()) return undefined;
  const config = await paramStore.loadStackConfig(workspaceId, stackName);
  return config?.drm;
}

// Persist one stack's DRM block, preserving every other coordinate.
//
// FLAG-OFF SHORT-CIRCUIT (D9): refuses before touching the parameter store, so
// a flag-off deployment cannot write a DRM block it would then refuse to read.
// Throws rather than silently no-opping — a write the caller believes succeeded
// but which was dropped is worse than an error.
//
// READ-MODIFY-WRITE: `storeStackConfig` persists the WHOLE `StackConfig`
// (param-store.ts:745-747 `JSON.stringify(stackConfig)`), so the existing
// config is loaded and spread rather than replaced — otherwise writing a DRM
// block would delete `couchdbUrl`, `services[]` and the rest. A stack with no
// stored config is an error for the same reason: there is nothing to merge into
// and inventing one would persist a config with no services.
export async function storeDrmStackConfig(
  paramStore: ParamStore,
  workspaceId: string,
  stackName: string,
  drm: DrmStackConfig
): Promise<void> {
  if (!drmEnabled()) {
    throw new Error(
      'refusing to store DRM configuration: DRM is not configured on this deployment'
    );
  }
  assertValidDrmStackConfig(drm);
  // Validation already rejected any unlisted key, so this projection normally
  // changes nothing — except for the derived read-view fields a GET→PUT
  // round trip legitimately carries (`credentials`), which are dropped here
  // because they are not stored state. What reaches `storeStackConfig` is
  // therefore exactly the allowlisted coordinates.
  const sanitised = projectDrmStackConfig(drm);
  const existing = await paramStore.loadStackConfig(workspaceId, stackName);
  if (!existing) {
    throw new Error(
      `refusing to store DRM configuration: no stack config for stack "${stackName}"`
    );
  }
  const updated: StackConfig = { ...existing, drm: sanitised };
  await paramStore.storeStackConfig(workspaceId, stackName, updated);
}
