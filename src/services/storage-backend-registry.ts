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

// The id of the implicit, OSC-managed default backend. It is not a stored
// registration record — it is synthesised on list so the default always appears
// — and it is NON-DELETABLE (ADR-017 D3: the zero-config MinIO default remains
// the implicit default and is never removed by a registration call).
export const DEFAULT_BACKEND_ID = 'default' as const;

// A role a registered backend may serve. Mirrors the two independent per-role
// slots the data model already carries (StackConfig.storage.{source,packaged},
// services/param-store.ts:83-92, ADR-017 D4). 'both' populates both slots.
export type StorageBackendRole = 'source' | 'packaged' | 'both';

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
  const wantSource = role === 'source' || role === 'both';
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

// Thrown when a caller tries to remove the implicit OSC-managed default backend
// (ADR-017 D3: the default is not deletable). The router maps it to 409.
export class DefaultBackendNotDeletableError extends Error {
  constructor() {
    super('the OSC-managed default backend cannot be removed');
    this.name = 'DefaultBackendNotDeletableError';
  }
}

// The registry: the register/list/remove surface the router calls. It owns the
// ADR-017 persistence split (non-secret record -> BackendRecordStore; secrets ->
// SecretStore per consuming serviceId) so the router stays a thin HTTP shell.
export class StorageBackendRegistry {
  constructor(
    private readonly records: BackendRecordStore,
    // Optional: when no SecretStore is wired (OSC not configured) the registry
    // still stores the non-secret record but reports the secret was NOT
    // persisted, so the router can surface a 501 rather than silently dropping
    // credentials.
    private readonly secrets?: SecretStore
  ) {}

  get canStoreSecrets(): boolean {
    return this.secrets !== undefined;
  }

  // Register a new external backend. Persists ONLY the non-secret record and
  // fans the secret material out to every consuming serviceId for the role. The
  // returned view is redacted — the secret is never echoed.
  async register(
    workspaceId: string,
    input: RegisterBackendInput
  ): Promise<RegisteredBackendView> {
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
}
