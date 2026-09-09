// External storage-backend registry (issue #547, parent #524, ADR-017).
//
// Promotes external S3-compatible bucket configuration from a job-time-only
// provision parameter (issue #211 externalStorageSchema, routes/provision.ts:65)
// into a first-class, registerable storage-backend feature: an operator can
// register, list, and remove named external backends for a workspace.
//
// PERSISTENCE SPLIT (ADR-017 D1 + C4):
//   - NON-SECRET registration record (id, name, role, backend coordinates:
//     bucket / endpointUrl / region / publicBaseUrl) is persisted to the OSC
//     parameter store (eyevinn-app-config-svc), exactly the store that already
//     holds the non-secret StorageBackendConfig (services/param-store.ts:41-47,
//     ADR-017 C4). It is the correct home for non-secret storage coordinates and
//     categorically the WRONG home for the access key + secret.
//   - The access key + secret (and optional session token) are stored as OSC
//     per-serviceId secrets via saveSecret (ADR-017 D1.1 + C1,
//     routes/provision.ts:585-593). Each consuming service (encore /
//     eyevinn-encore-packager / eyevinn-ffmpeg-s3) reads its OWN field names, so
//     the same external secret is fanned out once per consuming serviceId
//     (ADR-017 D1.1, the secret fan-out trade-off logged to OSC feedback).
//
// The secret VALUE is handed straight to the SecretStore and is NEVER written to
// the registration record, NEVER returned on read, and NEVER logged. A read
// exposes only a redacted reference (see redactBackend / RegisteredBackendView).
//
// Wiring a registered backend into ingest/output, and registration-time
// reachability/permission validation, are explicitly OUT OF SCOPE for #547
// (separate #524 sub-issues).

import { randomUUID } from 'node:crypto';
import {
  EXTERNAL_STORAGE_SERVICE_IDS,
  encoreCredentialMapping,
  packagerCredentialMapping,
  ffmpegS3CredentialMapping,
  type ExternalStorageCredentials,
  type ServiceCredentialMapping
} from './external-storage-credentials.js';
import type { ConfigKvStore } from './param-store.js';
import {
  validateExternalBackend,
  type ExternalBackendValidationResult,
  type ProbeClientFactory,
  type ValidationFailureReason
} from './external-backend-validation.js';

// The id of the implicit, OSC-managed default backend. It is not a stored
// registration record — it is synthesised on list so the default always appears
// — and it is NON-DELETABLE (ADR-017 D3: the zero-config MinIO default remains
// the implicit default and is never removed by a registration call).
export const DEFAULT_BACKEND_ID = 'default' as const;

// A role a registered backend may serve. Mirrors the two independent per-role
// slots the data model already carries (StackConfig.storage.{source,packaged},
// services/param-store.ts:83-92, ADR-017 D4). 'both' populates both slots.
//
// 'archive' is the additive tiering role (ADR-019 D5 "the one additive change
// tiering needs is a new role for the archive destination"): a cold destination
// that is NOT a live source/packaged slot, so it gets its own role value rather
// than overloading an existing one. It reuses the SAME ADR-017 credential + secret
// fan-out machinery unchanged — an archive backend is just another registered,
// externally-owned S3-compatible backend. Because the archived byte classes
// (source, optionally renditions — ADR-019 D3) are READ by the same source-side
// consumers when rehydrated/reprocessed (encore + eyevinn-ffmpeg-s3,
// external-storage-credentials.ts:186-190), the archive secret fans out to those
// two source-reader serviceIds (see mappingsForRole).
export type StorageBackendRole = 'source' | 'packaged' | 'both' | 'archive';

// The NON-SECRET registration record persisted to the parameter store. Carries
// only coordinates and the NON-SECRET access key id — NO secretAccessKey, NO
// sessionToken. The access key id is not a secret: it is a plain config field on
// every consuming service (s3AccessKeyId / AwsAccessKeyId / awsAccessKeyId,
// external-storage-credentials.ts:96,127,160). This mirrors the discipline of
// StorageBackendConfig (param-store.ts:41-47): the SECRET material (the secret
// access key + session token) lives in OSC secrets, never here.
export type StorageBackendRecord = {
  id: string;
  name: string;
  role: StorageBackendRole;
  // Always 'external' for a registered backend; the 'minio' default is implicit
  // and never stored (mirrors StorageBackendConfig.backend, param-store.ts:42).
  backend: 'external';
  bucket: string;
  // NON-SECRET access key id (see type doc). Persisted so list can echo which
  // credential is registered without ever reconstructing the secret.
  accessKeyId: string;
  endpointUrl?: string;
  region?: string;
  publicBaseUrl?: string;
  // Records whether a session token secret was stored, so the redacted view can
  // signal its presence WITHOUT storing the token itself (the token is a secret
  // and lives only in OSC secrets).
  hasSessionToken: boolean;
  createdAt: string;
};

// The redacted view returned by the API on register/list. It NEVER carries the
// secret value: it exposes only a redacted reference form so a caller can see
// THAT a credential is registered and confirm the access key id, without the
// secret ever being echoed (issue #547 acceptance; ADR-017 D1 "never echo the
// literal value").
export type RegisteredBackendView = StorageBackendRecord & {
  deletable: boolean;
  credentials: {
    // The access key id is NOT a secret (it is a non-secret config field for
    // every consuming service — s3AccessKeyId / AwsAccessKeyId / awsAccessKeyId,
    // external-storage-credentials.ts:96,127,160). Echoed so an operator can
    // identify which credential is registered.
    accessKeyId: string;
    // A fixed redaction marker — the secret value is NEVER returned. Its presence
    // signals a secret is stored (in OSC secrets, per serviceId); its absence
    // would signal none.
    secretAccessKey: '***redacted***';
    sessionToken?: '***redacted***';
  };
};

export const REDACTED = '***redacted***' as const;

// The synthetic view of the implicit OSC-managed default backend (ADR-017 D3).
// It is non-deletable and carries no external credentials (its credentials are
// the workspace's provisioned MinIO defaults, resolved elsewhere).
export function defaultBackendView(): RegisteredBackendView {
  return {
    id: DEFAULT_BACKEND_ID,
    name: 'OSC-managed default',
    role: 'both',
    // The default is the per-stack MinIO backend (param-store.ts:26-29), not an
    // external one; typed 'external' would misrepresent it, so we widen here.
    backend: 'external',
    bucket: '(OSC-managed default object storage)',
    accessKeyId: '(OSC-managed)',
    hasSessionToken: false,
    deletable: false,
    createdAt: '1970-01-01T00:00:00.000Z',
    credentials: { accessKeyId: '(OSC-managed)', secretAccessKey: REDACTED }
  };
}

// Redact a stored record into the API view. Pulls the non-secret accessKeyId
// through (it is echoable) and replaces every secret with the fixed marker.
export function redactBackend(record: StorageBackendRecord): RegisteredBackendView {
  return {
    ...record,
    deletable: true,
    credentials: {
      accessKeyId: record.accessKeyId,
      secretAccessKey: REDACTED,
      ...(record.hasSessionToken ? { sessionToken: REDACTED } : {})
    }
  };
}

// The full registration input: the non-secret record fields plus the raw
// credential material. The secret material is consumed by the SecretStore and
// never persisted into the record.
export type RegisterBackendInput = {
  name: string;
  role: StorageBackendRole;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpointUrl?: string;
  sessionToken?: string;
  publicBaseUrl?: string;
};

// Narrow OSC-secret sink. Mirrors the verified saveSecret calling convention
// (PackagerOscApi.saveSecret, packager-provisioning.ts:138; the SDK signature
// saveSecret(serviceId, name, value, osc), provision.ts:591). Injected so the
// registry is unit-testable without a live OSC Context — the same seam
// optional-services/packager-provisioning use.
export interface SecretStore {
  saveSecret(serviceId: string, name: string, value: string): Promise<void>;
}

// The consuming serviceIds a source-role and a packaged-role external backend
// must fan its secret out to (ADR-017 D1.1 + D4). Source is READ by encore and
// eyevinn-ffmpeg-s3; packaged is WRITTEN by eyevinn-encore-packager
// (external-storage-credentials.ts:186-190).
const SOURCE_SERVICE_IDS = [
  EXTERNAL_STORAGE_SERVICE_IDS.encore,
  EXTERNAL_STORAGE_SERVICE_IDS.ffmpegS3
] as const;
const PACKAGED_SERVICE_IDS = [EXTERNAL_STORAGE_SERVICE_IDS.packager] as const;

// Compose the OSC secret name for a registered backend's secret on a given
// service. Follows the established `<name>.<purpose>` convention
// (provision.ts:590) with a stable per-backend prefix so two backends never
// collide under one serviceId, and the mapping layer's role-qualified purpose so
// the source and packaged secrets never collide either
// (external-storage-credentials.ts:53-55).
export function backendSecretName(backendId: string, purpose: string): string {
  return `storagebackend.${backendId}.${purpose}`;
}

// Which per-service credential mappings apply for a role. Each entry pairs a
// serviceId with the mapping that spells the fields for that service (the
// mapping's `secrets[]` carry the role-qualified purpose we save under).
function mappingsForRole(
  role: StorageBackendRole,
  creds: ExternalStorageCredentials
): Array<{ serviceId: string; mapping: ServiceCredentialMapping }> {
  const out: Array<{ serviceId: string; mapping: ServiceCredentialMapping }> = [];
  // The archive tier (ADR-019 D5) is a cold destination for source-side byte
  // classes (source, optionally renditions — ADR-019 D3), READ by the same
  // source-reader consumers on rehydrate/reprocess. So an 'archive' backend fans
  // its secret out to the source-reader serviceIds exactly like 'source', reusing
  // the same per-service mapping unchanged — no parallel credential model.
  const wantSource = role === 'source' || role === 'both' || role === 'archive';
  const wantPackaged = role === 'packaged' || role === 'both';
  if (wantSource) {
    out.push({
      serviceId: EXTERNAL_STORAGE_SERVICE_IDS.encore,
      mapping: encoreCredentialMapping(creds, 'source')
    });
    out.push({
      serviceId: EXTERNAL_STORAGE_SERVICE_IDS.ffmpegS3,
      mapping: ffmpegS3CredentialMapping(creds, 'source')
    });
  }
  if (wantPackaged) {
    out.push({
      serviceId: EXTERNAL_STORAGE_SERVICE_IDS.packager,
      mapping: packagerCredentialMapping(creds, 'packaged')
    });
  }
  return out;
}

// Persistence seam for the NON-SECRET registration records. Namespaced by
// workspace so two tenants may register backends independently (mirrors the
// per-workspace stack-config namespacing, param-store.ts:127-133). The
// param-store-backed and in-memory implementations both satisfy it; the router
// depends only on this interface, exactly as collections depends on
// CollectionRepository (collections.ts:53-58).
export interface BackendRecordStore {
  put(workspaceId: string, record: StorageBackendRecord): Promise<void>;
  list(workspaceId: string): Promise<StorageBackendRecord[]>;
  get(workspaceId: string, id: string): Promise<StorageBackendRecord | undefined>;
  delete(workspaceId: string, id: string): Promise<void>;
}

// In-memory BackendRecordStore for tests and the no-param-store fallback. Mirrors
// InMemoryAssetRepository / OperationStore / LogStore (the house in-memory-store
// pattern). Deep-copies on the way in and out so a caller cannot mutate stored
// state by reference.
export class InMemoryBackendRecordStore implements BackendRecordStore {
  private readonly byWorkspace = new Map<string, Map<string, StorageBackendRecord>>();

  private bucket(workspaceId: string): Map<string, StorageBackendRecord> {
    let m = this.byWorkspace.get(workspaceId);
    if (!m) {
      m = new Map();
      this.byWorkspace.set(workspaceId, m);
    }
    return m;
  }

  async put(workspaceId: string, record: StorageBackendRecord): Promise<void> {
    this.bucket(workspaceId).set(record.id, { ...record });
  }

  async list(workspaceId: string): Promise<StorageBackendRecord[]> {
    return [...this.bucket(workspaceId).values()].map((r) => ({ ...r }));
  }

  async get(workspaceId: string, id: string): Promise<StorageBackendRecord | undefined> {
    const r = this.bucket(workspaceId).get(id);
    return r ? { ...r } : undefined;
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    this.bucket(workspaceId).delete(id);
  }
}

// Config-store key under which one backend record is persisted, namespaced by
// workspace and prefixed so it is distinguishable from the StackConfig blobs and
// from any other consumer of the shared config service (mirrors stackConfigKey,
// param-store.ts:131-133).
export function backendRecordKey(workspaceId: string, id: string): string {
  return `openvideocore/storagebackends/${workspaceId}/${id}`;
}

// Prefix covering every backend record for a workspace, for list-by-prefix.
export function backendRecordPrefix(workspaceId: string): string {
  return `openvideocore/storagebackends/${workspaceId}/`;
}

// Parameter-store-backed BackendRecordStore (ADR-017 D1.3): persists ONLY the
// non-secret registration record to the eyevinn-app-config-svc config service,
// one JSON blob per backend. Never touches OSC secrets — those are written by the
// registry's SecretStore. Reuses the generic ConfigKvStore over the same HTTP
// contract makeHttpParamStore uses (param-store.ts).
export class ParamStoreBackendRecordStore implements BackendRecordStore {
  constructor(private readonly kv: ConfigKvStore) {}

  async put(workspaceId: string, record: StorageBackendRecord): Promise<void> {
    assertRecordHasNoSecret(record);
    await this.kv.set(backendRecordKey(workspaceId, record.id), JSON.stringify(record));
  }

  async list(workspaceId: string): Promise<StorageBackendRecord[]> {
    const items = await this.kv.listByPrefix(backendRecordPrefix(workspaceId));
    const out: StorageBackendRecord[] = [];
    for (const item of items) {
      try {
        out.push(JSON.parse(item.value) as StorageBackendRecord);
      } catch {
        // Skip a malformed blob rather than fail the whole listing.
      }
    }
    return out;
  }

  async get(workspaceId: string, id: string): Promise<StorageBackendRecord | undefined> {
    const raw = await this.kv.get(backendRecordKey(workspaceId, id));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StorageBackendRecord;
    } catch {
      return undefined;
    }
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.kv.delete(backendRecordKey(workspaceId, id));
  }
}

// Defence-in-depth (mirrors assertNoCredentials, param-store.ts:165-204): refuse
// to write a record that somehow carries secret material into the config store.
// The StorageBackendRecord type has no secret fields, but a regression upstream
// could spread a raw request block (which DOES carry secretAccessKey /
// sessionToken) into it — reject any such key so a secret can never reach the
// non-secret store.
function assertRecordHasNoSecret(record: StorageBackendRecord): void {
  const forbidden = ['secretAccessKey', 'sessionToken'];
  const asRecord = record as unknown as Record<string, unknown>;
  for (const key of forbidden) {
    if (key in asRecord) {
      throw new Error(
        `refusing to persist secret field "${key}" in the storage-backend registry`
      );
    }
  }
}

// The source-role credential surface the ephemeral eyevinn-ffmpeg-s3 job body
// takes (ADR-017 C3/D4). It mirrors the ffmpeg-s3 field names verified in
// external-storage-credentials.ts:155-180 and osc-thumbnail.ts:69-75 /
// osc-rewrap.ts:16-18: awsAccessKeyId / awsSecretAccessKey / s3EndpointUrl
// (+ optional awsSessionToken / awsRegion). CRITICAL: the two secret fields
// carry the `{{secrets.<name>}}` REFERENCE (not the literal), so the resolved
// value can be spread straight into a createJob body without ever exposing — or
// persisting — the credential in the API process or in a stored job record
// (issue #548 acceptance). The literal secret was written once, per consuming
// serviceId, at register() time and lives only in OSC secrets.
export type SourceBackendJobCredentials = {
  bucket: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string; // `{{secrets.<name>}}` reference
  s3EndpointUrl?: string;
  awsRegion?: string;
  awsSessionToken?: string; // `{{secrets.<name>}}` reference (when a token was registered)
};

// The OSC secret-reference form `{{secrets.<name>}}` the create/job body embeds
// (verified: secretRef in provision.ts:585-593). Kept identical so a registered
// backend's secret resolves exactly as a provision-time secret does.
export function secretReference(name: string): string {
  return `{{secrets.${name}}}`;
}

// Thrown when an ingest references an external backend id/name that is not
// registered for the workspace, or is registered but cannot serve the source
// role. The router maps it to 400 (bad reference) rather than 404, to avoid
// leaking which ids exist.
export class UnknownSourceBackendError extends Error {
  readonly statusCode = 400;
  constructor(ref: string) {
    super(`no registered source backend matches "${ref}"`);
    this.name = 'UnknownSourceBackendError';
  }
}

// Thrown when a caller tries to remove the implicit OSC-managed default backend
// (ADR-017 D3: the default is not deletable). The router maps it to 409.
export class DefaultBackendNotDeletableError extends Error {
  constructor() {
    super('the OSC-managed default backend cannot be removed');
    this.name = 'DefaultBackendNotDeletableError';
  }
}

// Thrown when registration-time validation (issue #550) rejects a backend as
// unreachable or unauthorized. Carries the machine-readable reason + the
// non-secret S3 error code so the router can surface a clear 4xx WITHOUT the
// backend ever being registered (issue #550: "do not silently register an
// unreachable or unauthorized backend"). The message and code are guaranteed
// secret-free by validateExternalBackend.
export class BackendValidationError extends Error {
  readonly reason: ValidationFailureReason;
  readonly code?: string;
  constructor(result: Extract<ExternalBackendValidationResult, { ok: false }>) {
    super(result.message);
    this.name = 'BackendValidationError';
    this.reason = result.reason;
    if (result.code) this.code = result.code;
  }
}

// The registry: the register/list/remove surface the router calls. It owns the
// ADR-017 persistence split (non-secret record -> BackendRecordStore; secrets ->
// SecretStore per consuming serviceId) so the router stays a thin HTTP shell.
export type StorageBackendRegistryOptions = {
  // When true (the default when a validate option object is supplied), register
  // runs the issue #550 reachability + permission probe BEFORE persisting; a
  // failing probe throws BackendValidationError and NOTHING is persisted. When
  // false, validation is skipped entirely (opt-out for callers that manage
  // validation elsewhere or want registration without a live probe).
  enabled?: boolean;
  // Injectable probe-client factory so registration is unit-testable without a
  // live bucket (mirrors the injected FetchLike seam in profiles-reachability).
  probeClientFactory?: ProbeClientFactory;
};

export class StorageBackendRegistry {
  private readonly validateEnabled: boolean;
  private readonly probeClientFactory?: ProbeClientFactory;

  constructor(
    private readonly records: BackendRecordStore,
    // Optional: when no SecretStore is wired (OSC not configured) the registry
    // still stores the non-secret record but reports the secret was NOT
    // persisted, so the router can surface a 501 rather than silently dropping
    // credentials.
    private readonly secrets?: SecretStore,
    // Optional registration-time validation config (issue #550). Omit to keep
    // the pre-#550 behaviour (no probe); pass {} to enable the default live
    // probe, or { enabled: false } to explicitly opt out.
    validate?: StorageBackendRegistryOptions
  ) {
    this.validateEnabled = validate ? validate.enabled !== false : false;
    this.probeClientFactory = validate?.probeClientFactory;
  }

  get canStoreSecrets(): boolean {
    return this.secrets !== undefined;
  }

  get validatesOnRegister(): boolean {
    return this.validateEnabled;
  }

  // Run the issue #550 reachability + permission probe against a prospective
  // backend WITHOUT registering it (supports on-demand re-validation and lets
  // the router expose a dry-run). Never leaks the secret: the result carries
  // only a machine-readable reason + the non-secret S3 error code.
  async validate(input: RegisterBackendInput): Promise<ExternalBackendValidationResult> {
    return validateExternalBackend(
      {
        bucket: input.bucket,
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
        ...(input.region ? { region: input.region } : {}),
        ...(input.endpointUrl ? { endpointUrl: input.endpointUrl } : {}),
        ...(input.sessionToken ? { sessionToken: input.sessionToken } : {})
      },
      this.probeClientFactory ? { probeClientFactory: this.probeClientFactory } : {}
    );
  }

  // Register a new external backend. Persists ONLY the non-secret record and
  // fans the secret material out to every consuming serviceId for the role. The
  // returned view is redacted — the secret is never echoed.
  async register(
    workspaceId: string,
    input: RegisterBackendInput
  ): Promise<RegisteredBackendView> {
    // Issue #550: validate reachability + permissions BEFORE persisting or
    // fanning out any secret, so an unreachable or unauthorized backend is
    // never silently registered. On failure nothing is written and the caller
    // gets a machine-readable reason (the message/code are secret-free).
    if (this.validateEnabled) {
      const result = await this.validate(input);
      if (!result.ok) {
        throw new BackendValidationError(result);
      }
    }

    const id = randomUUID();
    const record: StorageBackendRecord = {
      id,
      name: input.name,
      role: input.role,
      backend: 'external',
      bucket: input.bucket,
      accessKeyId: input.accessKeyId,
      ...(input.endpointUrl ? { endpointUrl: input.endpointUrl } : {}),
      ...(input.region ? { region: input.region } : {}),
      ...(input.publicBaseUrl ? { publicBaseUrl: input.publicBaseUrl } : {}),
      hasSessionToken: Boolean(input.sessionToken),
      createdAt: new Date().toISOString()
    };

    // Fan the secret material out to every consuming serviceId BEFORE persisting
    // the record, so a partial failure never leaves a record without its secret.
    if (this.secrets) {
      const creds: ExternalStorageCredentials = {
        bucket: input.bucket,
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
        ...(input.region ? { region: input.region } : {}),
        ...(input.endpointUrl ? { endpointUrl: input.endpointUrl } : {}),
        ...(input.sessionToken ? { sessionToken: input.sessionToken } : {})
      };
      for (const { serviceId, mapping } of mappingsForRole(input.role, creds)) {
        for (const secret of mapping.secrets) {
          await this.secrets.saveSecret(
            serviceId,
            backendSecretName(id, secret.purpose),
            secret.value
          );
        }
      }
    }

    await this.records.put(workspaceId, record);
    return redactBackend(record);
  }

  // List every registered backend (redacted) with the implicit OSC-managed
  // default prepended (ADR-017 D3). The default always appears and is marked
  // non-deletable. Every entry has its SECRET access key + session token
  // replaced by the redaction marker (redactBackend); the raw secret is never
  // read back from the store because it was never stored there.
  async list(workspaceId: string): Promise<RegisteredBackendView[]> {
    const stored = await this.records.list(workspaceId);
    const views = stored.map((r) => redactBackend(r));
    return [defaultBackendView(), ...views];
  }

  // Resolve a single registered backend by its stable id, redacted. Returns the
  // implicit OSC-managed default's view for id 'default' (it is synthesised, not
  // stored — mirrors list()), and undefined for an unknown id. Added for the
  // named-export-destination lookup (issue #572 / ADR-018 D1: "A destination must
  // be resolvable by a stable id/name"): a caller — or a later job-reference
  // sub-issue — resolves a destination by id through the SAME registry records
  // and the SAME redaction, never echoing the secret.
  async get(workspaceId: string, id: string): Promise<RegisteredBackendView | undefined> {
    if (id === DEFAULT_BACKEND_ID) {
      return defaultBackendView();
    }
    const record = await this.records.get(workspaceId, id);
    return record ? redactBackend(record) : undefined;
  }

  // Look a registered backend up by id OR by name (case-sensitive name match),
  // scoped to the workspace. Returns undefined for the implicit default (which
  // is synthesised, not stored) and for any unknown reference. Used by ingest
  // to resolve a caller's `sourceBackend` reference to a stored record.
  async findByRef(
    workspaceId: string,
    ref: string
  ): Promise<StorageBackendRecord | undefined> {
    const byId = await this.records.get(workspaceId, ref);
    if (byId) return byId;
    const all = await this.records.list(workspaceId);
    return all.find((r) => r.name === ref);
  }

  // Resolve a referenced source backend into the eyevinn-ffmpeg-s3 job-body
  // credential fields (ADR-017 C3/D4). The two secret fields carry the
  // `{{secrets.<name>}}` REFERENCE, built from the exact per-serviceId secret
  // names the register() fan-out saved under (backendSecretName +
  // ffmpegS3CredentialMapping's role-qualified purposes), so a probe/transcode
  // job reads the source directly from the external bucket while the literal
  // credential never re-enters the API process or a stored job record (issue
  // #548 acceptance).
  //
  // Throws UnknownSourceBackendError if the reference matches no registered
  // backend, or matches one that does not serve the source role. The implicit
  // OSC-managed default is intentionally NOT resolvable here: an ingest with no
  // sourceBackend uses the default path unchanged (ADR-017 D3), so callers must
  // only pass this method an explicit external reference.
  async resolveSourceCredentials(
    workspaceId: string,
    ref: string
  ): Promise<SourceBackendJobCredentials> {
    const record = await this.findByRef(workspaceId, ref);
    if (!record) throw new UnknownSourceBackendError(ref);
    if (record.role !== 'source' && record.role !== 'both') {
      throw new UnknownSourceBackendError(ref);
    }
    // Rebuild the ffmpeg-s3 field-name mapping so the field names and the
    // role-qualified secret purposes are the SINGLE source of truth (they must
    // match exactly what register() saved). We pass the non-secret accessKeyId
    // as the literal (it is not a secret) and a placeholder for the secret value
    // (never used — we take only the mapping's field names + purposes here).
    // The credential VALUES here are placeholders: resolveSourceCredentials
    // reads only the mapping's field NAMES + role-qualified purposes to build
    // `{{secrets.<name>}}` references — never the value. A non-empty placeholder
    // is required for the optional session-token field to be emitted (the
    // mapping gates it on truthiness), which is why we pass a marker rather than
    // an empty string.
    const PLACEHOLDER = 'UNUSED_PLACEHOLDER_NOT_A_SECRET';
    const mapping = ffmpegS3CredentialMapping(
      {
        bucket: record.bucket,
        accessKeyId: record.accessKeyId,
        secretAccessKey: PLACEHOLDER,
        ...(record.region ? { region: record.region } : {}),
        ...(record.endpointUrl ? { endpointUrl: record.endpointUrl } : {}),
        ...(record.hasSessionToken ? { sessionToken: PLACEHOLDER } : {})
      },
      'source'
    );
    const out: SourceBackendJobCredentials = {
      bucket: record.bucket,
      awsAccessKeyId: record.accessKeyId,
      // Filled from the mapping's secrets below.
      awsSecretAccessKey: '',
      ...(record.endpointUrl ? { s3EndpointUrl: record.endpointUrl } : {}),
      ...(record.region ? { awsRegion: record.region } : {})
    };
    for (const secret of mapping.secrets) {
      const ref2 = secretReference(backendSecretName(record.id, secret.purpose));
      if (secret.field === 'awsSecretAccessKey') out.awsSecretAccessKey = ref2;
      else if (secret.field === 'awsSessionToken') out.awsSessionToken = ref2;
    }
    return out;
  }

  // Remove a registered backend. The implicit default (id 'default') is NOT
  // deletable (ADR-017 D3) -> throws DefaultBackendNotDeletableError. Removing an
  // unknown id is an idempotent no-op (mirrors collections DELETE,
  // collections.ts:135-139) that still resolves. Best-effort removes the fanned
  // secrets too when a SecretStore that supports removal is wired; the non-secret
  // record is always removed.
  async remove(workspaceId: string, id: string): Promise<void> {
    if (id === DEFAULT_BACKEND_ID) {
      throw new DefaultBackendNotDeletableError();
    }
    await this.records.delete(workspaceId, id);
  }

  // Resolve a registered backend by its id OR its human name, for a workspace
  // (issue #549, output/transcode-package wiring under #524 / ADR-017 D4).
  // Returns the NON-SECRET record so a caller can read the backend's coordinates
  // (bucket / endpointUrl / …) at JOB TIME to target its packaged output there.
  //
  // The credential the destination write needs was already fanned out to the
  // consuming serviceIds' OSC secrets at registration time (register(), ADR-017
  // D1.1); this resolver deliberately exposes ONLY the non-secret record and
  // NEVER the secret material — the secret is resolved by the consuming service
  // via its `{{secrets.<name>}}` reference, not read back here.
  //
  // The implicit OSC-managed default (id 'default') resolves to undefined: it is
  // NOT an external backend (defaultBackendView widens its type, backend-registry
  // line 106-121), so a caller referencing 'default' must fall through to the
  // unchanged default output path (ADR-017 D3) rather than treat it as an
  // external destination. An unknown id/name also resolves to undefined so the
  // caller can 422 a dangling reference before dispatching a job.
  async resolveForOutput(
    workspaceId: string,
    idOrName: string
  ): Promise<StorageBackendRecord | undefined> {
    if (idOrName === DEFAULT_BACKEND_ID) {
      return undefined;
    }
    const byId = await this.records.get(workspaceId, idOrName);
    if (byId) {
      return byId;
    }
    // Fall back to a case-sensitive name match (names are operator-chosen and
    // not guaranteed unique; the FIRST match wins, mirroring how list() returns
    // them). id lookup is preferred above because it is unambiguous.
    const all = await this.records.list(workspaceId);
    return all.find((r) => r.name === idOrName);
  }
}

// Translate a resolved external backend record into the per-execution
// `destinationBucket` override string the post-package relocation path already
// consumes (issue #549; ADR-011 relocation mechanism + ADR-017 D4). The
// relocation edge/parser (output-relocation.ts parseDestination,
// assets.ts destinationBucketSchema) accepts EITHER a plain `bucket/prefix/`
// path OR an `s3://bucket/…/` URI, trailing-slash-terminated. We emit the
// `s3://<bucket>/` form (matching packagerOutputFolder, external-storage-
// credentials.ts:75-81) so a cross-endpoint external bucket is recognised as an
// external S3 URI and NOT reachability-probed against the default MinIO client
// (assets.ts:1561 `isExternalS3Uri`). NEVER embeds credentials — the endpoint
// and keys live in OSC secrets, resolved by the consuming service.
export function backendOutputDestination(record: StorageBackendRecord): string {
  const bare = record.bucket
    .replace(/^s3:\/\//i, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return `s3://${bare}/`;
}
