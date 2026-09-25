// Per-workspace stack connection resolver.
//
// Each workspace provisions their own OSC stack (MinIO, CouchDB, Encore, etc.)
// via POST /api/v1/provision. This service resolves the right connections for
// a workspace by reading their stack config from the parameter store at request
// time and caching the result so the parameter store is not hit on every call.
//
// The first provisioned stack for a workspace is used as the default. Explicit
// env vars (COUCHDB_URL, MINIO_URL, etc.) still win when set — they act as
// overrides for local dev / ops use.

import nano from 'nano';
import { Client as MinioClient } from 'minio';
import {
  isReadyStack,
  type ParamStore,
  type StackConfig,
  type StorageBackendConfig
} from './param-store.js';
import { couchServer, StackCouch } from '../data/couchdb.js';
import { WorkspaceStorage } from '../data/storage.js';
import { CouchAssetRepository } from '../data/couch-asset-repo.js';
import { CouchJobRepository } from '../data/couch-job-repo.js';
import { CouchSearchRepository } from '../data/couch-search-repo.js';
import { CouchWebhookRepository } from '../data/couch-webhook-repo.js';
import { CouchCollectionRepository } from '../data/couch-collection-repo.js';
import { CouchProfileRepository } from '../data/couch-profile-repo.js';
import { CouchPipelineRepository } from '../data/couch-pipeline-repo.js';
import type { AuditEmitter } from '../data/audit-emit.js';
import { InMemoryAssetRepository, type AssetRepository } from '../data/asset-repo.js';
import { InMemoryJobRepository, type JobRepository } from '../data/job-repo.js';
import { InMemorySearchRepository } from '../data/inmemory-search-repo.js';
import { InMemoryWebhookRepository } from '../data/inmemory-webhook-repo.js';
import { InMemoryCollectionRepository } from '../data/inmemory-collection-repo.js';
import { InMemoryProfileRepository } from '../data/inmemory-profile-repo.js';
import { InMemoryPipelineRepository, type PipelineRepository } from '../data/pipeline-repo.js';
import type { SearchRepository } from '../data/search-repo.js';
import type { WebhookRepository } from '../data/webhook-repo.js';
import type { CollectionRepository } from '../data/collection-repo.js';
import {
  CouchAuditRepository,
  InMemoryAuditRepository,
  type AuditRepository,
  type AuditRetentionRepository
} from '../data/audit-repo.js';
import type { ProfileRepository } from '../data/profile-repo.js';
import type { StorageFactory } from '../routes/asset-upload.js';
import { makeHttpEncoreClient, type EncoreClient } from '../pipeline/encore-client.js';
import type { SubtitleGenerator } from '../pipeline/subtitle-generator.js';
import type { SceneDetector } from '../pipeline/scene-detector.js';
import { listSubscriptions, type Context } from '@osaas/client-core';
import type { ResolverHealthSignal } from './resolver-health.js';

// Builders that turn a stored optional-service instance name (from the stack
// record) into the corresponding pipeline-step generator (issue #217). main.ts
// owns the OSC/env-tuning wiring and supplies these; the resolver invokes one
// only when the ACTIVE stack's StackConfig carries the instance name, so a
// freshly provisioned optional service is activated on the next pipeline run
// with NO API restart. When a builder is absent (no object storage) or the name
// is missing from the record, the corresponding generator is left undefined and
// the OPTIONAL step skips gracefully — identical to the previous env-var path.
export type OptionalStepBuilders = {
  subtitleGenerator?: (instanceName: string) => SubtitleGenerator;
  sceneDetector?: (instanceName: string) => SceneDetector;
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

// Minimal logger surface (compatible with Fastify's logger). Injected so the
// read-path diagnostics (issue #415, info/warn) and a transient parameter-store
// refresh failure (issue #419, error) are observable instead of being silently
// swallowed. Defaults to a noop so callers/tests that don't wire a logger keep
// working.
export type StackResolverLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const noopLogger: StackResolverLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

// Maximum staleness bound for the last-known-good fallback (issue #420,
// architect sign-off condition 1). When a param-store refresh THROWS on a
// cache-miss but a prior successful ready-stack resolution exists, keep serving
// that resolution rather than dropping to no-storage — but only while within
// MAX_STALE_MS measured from the ORIGINAL successful resolve time (12x
// CACHE_TTL_MS = 1h). Past this bound we drop to no-storage; we never serve a
// stale ready-stack resolution indefinitely.
const MAX_STALE_MS = 60 * 60 * 1000; // 1h = 12x CACHE_TTL_MS

export type WorkspaceConnections = {
  assets: AssetRepository;
  jobs: JobRepository;
  search: SearchRepository;
  webhooks: WebhookRepository;
  collections: CollectionRepository;
  // Audit store for this stack. Backed by CouchAuditRepository in production and
  // InMemoryAuditRepository on the in-memory/env paths, so it is ALWAYS present
  // (issue #565 read surface merged this from the older Couch-only-optional
  // shape). Exposes the read-only query surface (issue #565, consumed by
  // PerWorkspaceAuditRepository.query), the append-only `record()` write
  // primitive (issue #564, consumed by PerWorkspaceAuditEmitter.record), AND the
  // retention surface (issue #566, listOldestPage/purgeEntry) the audit-retention
  // purge sweep drives per tick. Typed as the intersection so the single field
  // serves all three consumers; both concrete repos satisfy it.
  audit: AuditRepository & AuditEmitter & AuditRetentionRepository;
  profiles: ProfileRepository;
  pipelines: PipelineRepository;
  storageFor: StorageFactory | undefined;
  storageClient: MinioClient | undefined;
  encore: EncoreClient | undefined;
  sourceBucket: string;
  packagedBucket: string;
  s3Config: { endpoint: string; accessKey: string; secretKey: string } | undefined;
  // Per-role storage backend metadata for the resolved stack (issue #211/#213).
  // Carried through so the delivery route can emit backend-appropriate URLs
  // (proxied for 'minio', public/derived object URLs for 'external') without a
  // second parameter-store read per request. Undefined when the stack predates
  // issue #211 (both roles then default to the per-stack MinIO backend) or for
  // the env-override / in-memory connection paths.
  storage:
    | { source: StorageBackendConfig; packaged: StorageBackendConfig }
    | undefined;
  // OPTIONAL, opt-in pipeline-step generators activated from the stack record
  // (issue #217), not boot-time env vars. Present only when the ACTIVE stack's
  // StackConfig carries the instance name AND a builder was supplied (object
  // storage available). Absent (undefined) => the OPTIONAL `subtitles` /
  // `scene-detect` step skips gracefully — fire-and-forget, never throws.
  subtitleGenerator: SubtitleGenerator | undefined;
  sceneDetector: SceneDetector | undefined;
};

// A cached resolution. `fromReadyStack` records whether `connections` were
// built from a real ready-stack config (buildConnectionsFromStack /
// isReadyStack) versus an env-override or no-storage in-memory fallback — only
// the former is eligible for the last-known-good fallback (issue #420,
// architect invariant: last-known-good applies ONLY to a prior entry built from
// a real ready-stack config, never to a cached in-memory fallback).
// `resolvedAt` is the ORIGINAL successful resolve time and is preserved across
// TTL refreshes so MAX_STALE_MS is measured from first success, not last serve.
type CacheEntry = {
  connections: WorkspaceConnections;
  expiresAt: number;
  fromReadyStack: boolean;
  resolvedAt: number;
};

// True if the value is a non-empty, parseable absolute URL. A partially
// provisioned stack can persist empty-string coordinates; feeding those to nano
// (dbScope) or the MinIO client's `new URL(...)` throws an uncaught assertion,
// which — in the global preHandler — would 500 every route including /health.
function isValidUrl(value: string | undefined): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// Build connections for a provisioned stack. Returns null when the stack config
// is incomplete/invalid (empty or non-URL couchdbUrl or minioEndpoint) so the
// resolver can fall back to no-op in-memory connections instead of throwing an
// uncaught assertion out of the global preHandler (issue #105).
function buildConnectionsFromStack(
  config: StackConfig,
  minioPassword: string,
  couchPassword: string,
  oscContext: Context,
  optionalSteps: OptionalStepBuilders
): WorkspaceConnections | null {
  if (!isValidUrl(config.couchdbUrl) || !isValidUrl(config.minioEndpoint)) {
    return null;
  }

  const dbName = process.env['COUCHDB_ASSETS_DB'] ?? 'assets';
  const couchUrl = config.couchdbUrl.replace(/\/$/, '').replace(
    /^(https?:\/\/)/, `$1admin:${encodeURIComponent(couchPassword)}@`
  );
  const server = couchServer(couchUrl);
  const wc = () => new StackCouch(server, dbName);

  const url = new URL(config.minioEndpoint);
  const useSSL = url.protocol === 'https:';
  const minioClient = new MinioClient({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : useSSL ? 443 : 80,
    useSSL,
    accessKey: 'admin',
    secretKey: minioPassword
  });

  const assets = new CouchAssetRepository(wc);
  const jobs = new CouchJobRepository(wc);
  const collections = new CouchCollectionRepository(wc);
  // Search projects both assets and collections (issue #561). The collection
  // repo is passed so collection hits are reconstructed by the same
  // authoritative mapping and surfaced distinctly from asset hits.
  const search = new CouchSearchRepository(wc, collections);
  const webhooks = new CouchWebhookRepository(wc);
  const profiles = new CouchProfileRepository(wc);
  const pipelines = new CouchPipelineRepository(wc);
  // Audit store over the same per-stack CouchDB connection (issue #564).
  const audit = new CouchAuditRepository(wc);

  const storageFor: StorageFactory = () =>
    new WorkspaceStorage(minioClient, config.sourceBucket);

  // The Encore instance URL is no longer stored in the stack config: the
  // auto-scaler manages its own Encore instances (ADR-006). main.ts wires the
  // scaler-backed EncoreClient; the per-stack resolver leaves encore unset.
  const encore = undefined;

  // Activate the OPTIONAL pipeline steps from the stack record (issue #217),
  // NOT from boot-time env vars. When the ACTIVE stack was provisioned with the
  // instance name AND a builder is available (object storage present), construct
  // the generator for this stack; otherwise leave it undefined so the step skips
  // gracefully. Because this runs at resolve time, a freshly provisioned
  // optional service is picked up on the next pipeline run without a restart.
  const subtitleGenerator =
    config.autoSubtitlesInstanceName && optionalSteps.subtitleGenerator
      ? optionalSteps.subtitleGenerator(config.autoSubtitlesInstanceName)
      : undefined;
  const sceneDetector =
    config.sceneDetectInstanceName && optionalSteps.sceneDetector
      ? optionalSteps.sceneDetector(config.sceneDetectInstanceName)
      : undefined;

  return {
    assets,
    jobs,
    search,
    webhooks,
    collections,
    audit,
    profiles,
    pipelines,
    storageFor,
    storageClient: minioClient,
    encore,
    sourceBucket: config.sourceBucket,
    packagedBucket: config.packagedBucket,
    s3Config: { endpoint: config.minioEndpoint, accessKey: 'admin', secretKey: minioPassword },
    // Carry the per-role storage backend metadata (issue #211) so the delivery
    // route can branch on backend type without re-reading the parameter store.
    storage: config.storage,
    subtitleGenerator,
    sceneDetector
  };
}

// Build connections from explicit environment variables (local dev / ops
// override). Returns undefined when no override env vars are set. When either
// COUCHDB_URL or MINIO_URL is present this path wins for ALL workspaces,
// bypassing the parameter store. The env values are used verbatim — COUCHDB_URL
// is expected to already carry any credentials it needs, and MinIO uses the
// MINIO_ACCESS_KEY/MINIO_SECRET_KEY pair.
function buildEnvConnections(oscContext: Context): WorkspaceConnections | undefined {
  const couchUrl = process.env['COUCHDB_URL'];
  const minioUrl = process.env['MINIO_URL'];
  if (!couchUrl && !minioUrl) return undefined;

  const sourceBucket = process.env['MINIO_SOURCE_BUCKET'] ?? 'openvideocore-source';
  const packagedBucket = process.env['MINIO_PACKAGED_BUCKET'] ?? 'openvideocore-packaged';

  let assets: AssetRepository;
  let jobs: JobRepository;
  let search: SearchRepository;
  let webhooks: WebhookRepository;
  let collections: CollectionRepository;
  // Audit store: always present (CouchAuditRepository on the couch env path,
  // InMemoryAuditRepository otherwise). Exposes the #565 query surface, the #564
  // record() write primitive, and the #566 retention surface
  // (listOldestPage/purgeEntry) — so the retention sweep runs on the in-memory
  // env path too, not just Couch.
  let audit: AuditRepository & AuditEmitter & AuditRetentionRepository;
  let profiles: ProfileRepository;
  let pipelines: PipelineRepository;

  if (couchUrl) {
    const dbName = process.env['COUCHDB_ASSETS_DB'] ?? 'assets';
    const server = couchServer(couchUrl);
    const wc = () => new StackCouch(server, dbName);
    assets = new CouchAssetRepository(wc);
    jobs = new CouchJobRepository(wc);
    collections = new CouchCollectionRepository(wc);
    // Search projects assets + collections (issue #561).
    search = new CouchSearchRepository(wc, collections);
    webhooks = new CouchWebhookRepository(wc);
    profiles = new CouchProfileRepository(wc);
    pipelines = new CouchPipelineRepository(wc);
    audit = new CouchAuditRepository(wc);
  } else {
    const mem = new InMemoryAssetRepository();
    assets = mem;
    jobs = new InMemoryJobRepository();
    webhooks = new InMemoryWebhookRepository();
    collections = new InMemoryCollectionRepository();
    audit = new InMemoryAuditRepository();
    // Search projects assets + collections (issue #561).
    search = new InMemorySearchRepository(mem, collections);
    profiles = new InMemoryProfileRepository();
    pipelines = new InMemoryPipelineRepository();
  }

  let storageFor: StorageFactory | undefined;
  let storageClient: MinioClient | undefined;
  if (minioUrl) {
    const accessKey = process.env['MINIO_ACCESS_KEY'] ?? 'admin';
    const secretKey = process.env['MINIO_SECRET_KEY'] ?? '';
    const url = new URL(minioUrl);
    const useSSL = url.protocol === 'https:';
    storageClient = new MinioClient({
      endPoint: url.hostname,
      port: url.port ? Number(url.port) : useSSL ? 443 : 80,
      useSSL,
      accessKey,
      secretKey
    });
    const client = storageClient;
    storageFor = () => new WorkspaceStorage(client, sourceBucket);
  }

  const encoreUrl = process.env['ENCORE_URL'];
  const encore = encoreUrl
    ? makeHttpEncoreClient({
        baseUrl: encoreUrl,
        getToken: () => oscContext.getServiceAccessToken('encore')
      })
    : undefined;

  return {
    assets, jobs, search, webhooks, collections, audit, profiles, pipelines,
    storageFor, storageClient, encore,
    sourceBucket, packagedBucket,
    s3Config: minioUrl ? { endpoint: minioUrl, accessKey: process.env['MINIO_ACCESS_KEY'] ?? 'admin', secretKey: process.env['MINIO_SECRET_KEY'] ?? process.env['MINIO_ROOT_PASSWORD'] ?? '' } : undefined,
    // The env-override path has no parameter-store record, so no per-role
    // backend metadata: delivery keeps its default (proxied) behaviour.
    storage: undefined,
    // The env-override path bypasses the parameter store, so there is no stack
    // record to source optional-step instance names from (issue #217): the
    // OPTIONAL subtitles/scene-detect steps stay disabled here and skip
    // gracefully, exactly as when the name is absent from a record.
    subtitleGenerator: undefined,
    sceneDetector: undefined
  };
}

function buildInMemoryConnections(): WorkspaceConnections {
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const webhooks = new InMemoryWebhookRepository();
  const collections = new InMemoryCollectionRepository();
  const audit = new InMemoryAuditRepository();
  // Search projects assets + collections (issue #561).
  const search = new InMemorySearchRepository(assets, collections);
  const profiles = new InMemoryProfileRepository();
  const pipelines = new InMemoryPipelineRepository();
  return {
    assets, jobs, search, webhooks, collections, audit, profiles, pipelines,
    storageFor: undefined, storageClient: undefined,
    encore: undefined,
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    s3Config: undefined,
    storage: undefined,
    subtitleGenerator: undefined,
    sceneDetector: undefined
  };
}

export const STACK_CONFIG_NAMESPACE = "default";

// Explicit operator-set workspace id (12-factor: config via env). When set and
// well-formed this WINS over every other source and is never persisted — an
// operator who pins the namespace in the deployment's environment gets exactly
// that namespace on every boot, with no OSC round-trip at all. Follows the
// existing OVC_* convention (OVC_TRUST_ROLE_HEADER, src/main.ts:447).
export const WORKSPACE_ID_ENV_VAR = 'OVC_WORKSPACE_ID';

// Fixed key under which the deployment's workspace id is PINNED the first time
// it is confidently derived (normally during provisioning), and read back on
// every later boot. Deliberately NOT namespaced by the workspace id — it is the
// value that yields the namespace — but prefixed with `openvideocore/` like
// every other key this app writes (stackConfigKey, param-store.ts:131) so it is
// distinguishable from any other consumer of the store.
//
// SECURITY (issue #712/#776): the config-service instance this key lives in is
// the deployment's OWN (resolved from PARAMETER_STORE_INSTANCE_NAME against the
// deployment's own authenticated Context, param-store.ts:724-740), so the pin is
// only readable/writable by this deployment. Reading it back is NOT cross-tenant
// probing: it yields this deployment's own id, and the only other namespace ever
// read anywhere remains the literal `default` compatibility shim.
export const WORKSPACE_ID_PIN_KEY = 'openvideocore/_meta/workspace-id';

// Narrow read/write view over the parameter store used ONLY for the workspace-id
// pin and for seeding it from this deployment's existing stack configs.
// Structurally satisfied by ConfigKvStore (param-store.ts:602-608, get/set/
// delete/listByPrefix over the same eyevinn-app-config-svc HTTP contract), so
// main.ts can pass the store it already builds with configKvStoreFromEnv. Kept
// narrow so a caller/test can supply a two- or three-method stub.
export type WorkspaceIdStore = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  // Optional because the seed step degrades gracefully without it: a store that
  // cannot enumerate keys simply skips seeding and falls through to deriving the
  // id from OSC. Signature copied verbatim from ConfigKvStore.listByPrefix
  // (param-store.ts:607 —
  //   listByPrefix(prefix: string): Promise<Array<{ key: string; value: string }>>
  // ), implemented against GET /api/v1/config?limit=N (param-store.ts:684-697).
  listByPrefix?(prefix: string): Promise<Array<{ key: string; value: string }>>;
};

// Shared prefix of every key this app writes to the config service. Both key
// shapes in the store start with it:
//   openvideocore/<workspaceId>/<stackName>          (stackConfigKey, param-store.ts:131-133)
//   openvideocore/storagebackends/<workspaceId>/<id> (storage-backend-registry.ts:321)
const OVC_KEY_PREFIX = 'openvideocore/';

// First key segments after OVC_KEY_PREFIX that are FIXED literals rather than a
// workspace id, and must therefore never be mistaken for one when seeding:
//   `_meta`           — this module's own pin key (WORKSPACE_ID_PIN_KEY)
//   `storagebackends` — the storage-backend registry's key space
//                       (backendRecordKey, storage-backend-registry.ts:321), whose
//                       workspace id is the SECOND segment, not the first.
const RESERVED_KEY_SEGMENTS = new Set(['_meta', 'storagebackends']);

// A workspace id must be usable as a single key segment in
// `openvideocore/<workspaceId>/<name>` (param-store.ts:131) and in the
// listStackNames prefix (param-store.ts:558). A value carrying `/` would break
// both, so it is rejected rather than silently corrupting the key space.
function isUsableWorkspaceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !value.includes('/')
  );
}

// Read a tenant id from the OSC subscription list, or undefined when none can
// be read (list unreachable, empty, or carrying no usable tenantId).
//
// DECLARED contract: @osaas/client-core admin.d.ts:2-5,42 —
//   Subscription = { serviceId: string; tenantId: string }
//   listSubscriptions(context: Context): Promise<Subscription[]>
//
// OBSERVED contract (read-only introspection against a live account,
// 2026-09-24, logged in the agents repo as
// docs/osc-feedback/incoming-no-sdk-accessor-for-own-tenant-identity.md): the
// payload does NOT match the declaration. Of 13 returned
// subscriptions, 10 carried NO `tenantId` field at all despite the type
// declaring it non-optional, and the 3 that did carry it split across TWO
// distinct values that look like the PUBLISHER/owner tenant of the subscribed
// service rather than the subscriber's own identity.
//
// So this helper must be read for exactly what it is: a BEST-EFFORT last-resort
// guess, not an identity lookup. The live API guarantees only that each entry
// MAY carry some tenantId; it does not guarantee that value identifies the
// caller, nor that the set is stable as the caller's subscriptions change. We
// take the lexicographically smallest distinct value so the guess is at least
// independent of list order, but subscribing to a service published by an
// alphabetically-earlier tenant still changes it. That is precisely why
// resolveWorkspaceId consults the pin and this deployment's own existing stack
// configs FIRST, and only reaches this function when the store holds no evidence
// at all.
//
// Returning undefined (rather than the `default` literal) is the point of this
// helper: the caller can distinguish "OSC gave us something" from "OSC gave us
// nothing", and decide separately whether it is safe to pin.
async function readTenantIdFromOsc(osc: Context): Promise<string | undefined> {
  try {
    const subscriptions = await listSubscriptions(osc);
    if (!Array.isArray(subscriptions)) return undefined;
    const tenantIds = subscriptions
      .map((s) => s?.tenantId)
      .filter((id): id is string => isUsableWorkspaceId(id))
      .map((id) => id.trim())
      .sort();
    return tenantIds[0];
  } catch {
    return undefined;
  }
}

// Claim on the deployment's OWN Personal Access Token that names the tenant this
// deployment runs as. See readTenantIdFromCredential for the verified contract.
const PAT_TENANT_CLAIM = 'tenantId';

// Read the tenant id carried by the deployment's OWN credential (issue #804).
//
// This is the AUTHORITATIVE answer to "which tenant is this deployment?", and it
// is the source readTenantIdFromOsc above was standing in for. The subscription
// list describes services this deployment is subscribed TO — published by other
// tenants — so it never identified the caller; the PAT does, because it IS the
// caller.
//
// CONTRACT VERIFIED (read-only introspection of this deployment's live
// OSC_ACCESS_TOKEN, 2026-09-24):
//   - Accessor: `Context.getPersonalAccessToken(): string | undefined`
//     — @osaas/client-core lib/context.d.ts:23.
//   - Shape: a three-segment `{"alg":"HS256","typ":"JWT"}` token whose payload
//     carries exactly the claims
//       iss ("token.osaas.eyevinn.se"), iat, exp, patId, userId, tenantId
//     with `tenantId` a plain single-segment slug (no `/`), directly usable as
//     the `<workspaceId>` segment of `openvideocore/<workspaceId>/<name>`
//     (stackConfigKey, param-store.ts:131).
//   - Authority: the SDK sends this exact token as the `x-pat-jwt: Bearer <pat>`
//     header on every catalog call (@osaas/client-core lib/admin.js,
//     listSubscriptions/removeSubscription/listReservedNodes), so the tenant OSC
//     attributes this deployment's own reads and writes to IS this claim.
//   - Divergence reproduced on the same live credential: listSubscriptions
//     returned 13 entries, only 5 carrying a tenantId, spanning TWO distinct
//     publisher tenants, and the lexicographically smallest of those is NOT the
//     PAT's tenantId. That is exactly the wrong-namespace derivation #804 reports.
//
// The signature is deliberately NOT verified. This is not an authorisation
// decision and the value is never trusted as a permission: we are reading our
// OWN credential's self-description purely to name the key space we write under.
// A forged token would be rejected by OSC on the very next call anyway, and the
// only consequence here would be this deployment addressing a namespace of its
// own that no other deployment can reach.
//
// Returns undefined (never a literal default) when there is no PAT, the token is
// not a decodable three-segment JWT, or the claim is missing/unusable — so the
// caller can distinguish "the credential told us" from "it did not" and fall
// back deliberately.
export function readTenantIdFromCredential(osc: Context): string | undefined {
  // Tolerate a Context-shaped stub without the accessor (tests, offline runs).
  const accessor = (
    osc as unknown as { getPersonalAccessToken?: () => string | undefined } | undefined
  )?.getPersonalAccessToken;
  if (typeof accessor !== 'function') return undefined;

  let pat: string | undefined;
  try {
    pat = accessor.call(osc);
  } catch {
    return undefined;
  }
  if (typeof pat !== 'string' || pat.length === 0) return undefined;

  const segments = pat.split('.');
  if (segments.length !== 3) return undefined;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof claims !== 'object' || claims === null) return undefined;

  const tenantId = (claims as Record<string, unknown>)[PAT_TENANT_CLAIM];
  return isUsableWorkspaceId(tenantId) ? tenantId.trim() : undefined;
}

// Derive the deployment's workspace (tenant) id from the OSC Context alone.
//
// RETAINED as the last-resort derivation step of resolveWorkspaceId below and as
// the pre-existing public helper.
//
// Order (issue #804): the deployment's OWN credential first — it is the only
// source that actually identifies this deployment — then the best-effort
// subscription guess, then the literal `default`. Before #804 this function
// started at the subscription guess, which on a live account resolves to a
// PUBLISHER of a subscribed service rather than the deployment's own tenant; PR
// #777 then persisted that guess, freezing a namespace the deployment does not
// own.
//
// Still prefer resolveWorkspaceId: it pins the namespace, validates the pin
// against this same credential before honouring or persisting it, and on an
// existing deployment seeds from the stack configs already in this deployment's
// own store.
//
// FOLLOW-UP (carried forward from the #776 review; #804 cleared src/main.ts but
// not these). Three route modules still address the parameter store with the
// literal STACK_CONFIG_NAMESPACE rather than the resolved namespace:
//   - src/routes/storage.ts:260
//   - src/routes/export-destinations.ts:187
//   - src/routes/assets.ts:1942, :2410
// These are all ADR-017 storage-backend registry records, and every one of those
// call sites — registration on the /storage/backends surface and lookup from the
// export/probe paths — passes the SAME constant, so they round-trip correctly
// today and are deliberately out of #804's scope. They are recorded here because this is
// the only in-code note of the divergence: if any one of them is ever converted
// to the resolved namespace on its own, it will strand the records the others
// wrote, which is the #733 failure mode.
export async function deriveWorkspaceId(osc: Context): Promise<string> {
  return (
    readTenantIdFromCredential(osc) ??
    (await readTenantIdFromOsc(osc)) ??
    STACK_CONFIG_NAMESPACE
  );
}

// True when a parsed store value looks like a persisted StackConfig
// (param-store.ts:52-95: minioEndpoint / couchdbUrl / redisUrl are required
// strings; storeStackConfig persists JSON.stringify(stackConfig),
// param-store.ts:446). Used as EVIDENCE that a namespace belongs to this
// deployment, so an unrelated record that happens to sit under the shared
// `openvideocore/` prefix cannot seed the pin.
function looksLikeStackConfig(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const c = parsed as Record<string, unknown>;
  return (
    typeof c['minioEndpoint'] === 'string' &&
    typeof c['couchdbUrl'] === 'string' &&
    typeof c['redisUrl'] === 'string'
  );
}

// Recover the workspace id this deployment ALREADY writes its stacks under, by
// reading its own config-service instance (issue #776 review).
//
// This is the only trustworthy source of the id once OSC's subscription list is
// known not to identify the caller (see readTenantIdFromOsc). If a previous boot
// wrote `openvideocore/<ns>/<stack>` into THIS store, then `<ns>` is by
// construction the namespace this deployment's read side must use — regardless
// of what any derivation would produce today.
//
// NOT cross-tenant probing: the instance is the deployment's own (resolved from
// PARAMETER_STORE_INSTANCE_NAME against its own authenticated Context,
// param-store.ts:706-740) and every key read here was written by this
// deployment. Nothing outside this store is consulted.
//
// Conservative by design. A key only counts as evidence when:
//   - it has the exact stack-config shape `openvideocore/<ns>/<name>`
//     (stackConfigKey, param-store.ts:131-133) — exactly two segments after the
//     shared prefix, which also excludes the four-segment storage-backend keys;
//   - its first segment is not a reserved literal (RESERVED_KEY_SEGMENTS);
//   - its value parses as a StackConfig (looksLikeStackConfig).
//
// Outcomes:
//   'seeded'    exactly one candidate namespace, ignoring the literal `default`
//               when a tenant-scoped one is also present: `default` entries are
//               either pre-#712 writes or the copy the #751 read fallback makes,
//               so they never override a deployment's own tenant-scoped id. A
//               store holding ONLY `default` entries seeds `default`, which is
//               that deployment's real namespace.
//   'ambiguous' several tenant-scoped namespaces — a history this code cannot
//               disambiguate. The caller must NOT pin; an operator resolves it
//               with OVC_WORKSPACE_ID.
//   'unknown'   the list call threw. Same treatment as 'ambiguous': serve
//               something for this resolve, pin nothing, retry next time.
//   'none'      the store is enumerable and holds no stack config (a genuinely
//               fresh deployment), or cannot enumerate at all (a caller that
//               supplied a get/set-only store). Pinning a derived value is safe
//               here because there is no existing config to strand.
type StoredNamespaceEvidence =
  | { kind: 'seeded'; workspaceId: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'unknown' }
  | { kind: 'none' };

async function seedWorkspaceIdFromStoredStacks(
  store: WorkspaceIdStore,
  log: StackResolverLogger
): Promise<StoredNamespaceEvidence> {
  if (typeof store.listByPrefix !== 'function') return { kind: 'none' };
  let entries: Array<{ key: string; value: string }>;
  try {
    entries = await store.listByPrefix(OVC_KEY_PREFIX);
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? { message: err.message } : String(err),
        prefix: OVC_KEY_PREFIX
      },
      'workspace id: could not list this deployment\'s existing stack configs; resolving without pinning'
    );
    return { kind: 'unknown' };
  }
  if (!Array.isArray(entries)) return { kind: 'unknown' };

  const namespaces = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string' || typeof entry.value !== 'string') {
      continue;
    }
    if (!entry.key.startsWith(OVC_KEY_PREFIX)) continue;
    const segments = entry.key.slice(OVC_KEY_PREFIX.length).split('/');
    if (segments.length !== 2) continue;
    const ns = segments[0];
    if (!isUsableWorkspaceId(ns) || RESERVED_KEY_SEGMENTS.has(ns)) continue;
    if (!looksLikeStackConfig(entry.value)) continue;
    namespaces.add(ns);
  }

  const tenantScoped = [...namespaces]
    .filter((ns) => ns !== STACK_CONFIG_NAMESPACE)
    .sort();
  if (tenantScoped.length === 1) {
    return { kind: 'seeded', workspaceId: tenantScoped[0]! };
  }
  if (tenantScoped.length > 1) {
    log.warn(
      { namespaces: tenantScoped, prefix: OVC_KEY_PREFIX },
      `workspace id: this store holds stack configs under several namespaces; refusing to pin from ambiguous evidence — set ${WORKSPACE_ID_ENV_VAR} to resolve it`
    );
    return { kind: 'ambiguous', candidates: tenantScoped };
  }
  if (namespaces.has(STACK_CONFIG_NAMESPACE)) {
    return { kind: 'seeded', workspaceId: STACK_CONFIG_NAMESPACE };
  }
  return { kind: 'none' };
}

// Where a resolved workspace id came from. Surfaced on the diagnostic log line
// so an operator can tell a pinned (deterministic) resolution from a seeded,
// derived or fallback one without reading code.
//
// 'credential' (issue #804) is the tenant read from the deployment's OWN PAT —
// the authoritative identity. 'derived' remains the best-effort subscription
// guess, which since #804 is served but NEVER pinned when a credential tenant
// was available.
export type WorkspaceIdSource =
  | 'env'
  | 'pinned'
  | 'seeded'
  | 'credential'
  | 'derived'
  | 'fallback';

export type WorkspaceIdResolution = {
  workspaceId: string;
  source: WorkspaceIdSource;
  // True when the value is guaranteed to repeat on the next boot with no config
  // change: an explicit env var, a value read back from the pin, or a value the
  // pin write for THIS resolve actually persisted.
  //
  // False when the value is served for this resolve only and nothing durable
  // backs it: the `default` fallback, and — importantly — a seeded/derived value
  // whose pin write THREW (the write is best-effort, workspace-stack.ts pinOnce).
  // Reporting true there would advertise and memoise a value the next boot has no
  // record of (issue #776 review, finding 2).
  deterministic: boolean;
};

export type ResolveWorkspaceIdOptions = {
  // Pin store. When omitted, resolution degrades to the pre-#776 derive-only
  // behaviour (env var still wins) — used by callers/tests that have no store.
  store?: WorkspaceIdStore;
  log?: StackResolverLogger;
};

// Resolve the deployment's parameter-store namespace DETERMINISTICALLY.
//
// This is the SINGLE source of truth for the namespace and is called by BOTH
// sides of the read/write contract so their keys provably agree:
//   - the provision/deprovision routes (write side, src/routes/provision.ts)
//     namespace every storeStackConfig/loadStackConfig/listStackNames by this id;
//   - the runtime resolver below (read side) resolves the same namespace before
//     every listStackNames/loadStackConfig.
//
// Resolution order — each step is stable across boots of the SAME deployment:
//   1. `OVC_WORKSPACE_ID` env var (explicit operator config, 12-factor). Never
//      persisted; it is already deterministic by construction.
//   2. The PINNED value read back from the deployment's own parameter store
//      (WORKSPACE_ID_PIN_KEY). Written once and read back on every boot
//      thereafter. This is what makes the namespace independent of the OSC
//      subscription set (issue #776 cause): the pin does not change when service
//      instances are created or destroyed between boots.
//
//      VALIDATED since issue #804: a pin that disagrees with the tenant on this
//      deployment's own credential is no longer honoured unconditionally. #777
//      persisted whatever the (wrong) subscription-based derivation produced, so
//      an existing stack can be carrying a frozen namespace it does not own. See
//      reconcilePinAgainstCredential for the exact policy — in short, a wrong pin
//      with nothing stored under it is CORRECTED to the credential tenant, and a
//      wrong pin that real stack configs do live under is kept (correcting it
//      would strand them) but reported at warn with the OVC_WORKSPACE_ID
//      remediation.
//   3. SEED from this deployment's OWN existing stack configs
//      (seedWorkspaceIdFromStoredStacks) when no pin exists yet. This step is
//      what makes the pin safe to introduce on an UPGRADE path: a deployment
//      already running post-#712 has its stack configs under some namespace X,
//      and X — not whatever OSC would produce today — is the namespace its read
//      side must keep using. Without this step the first boot after upgrading
//      could derive a different Y, pin Y, and be permanently unable to resolve
//      its own stack (issue #776 review, finding 1). Pinned best-effort.
//   4. The tenant id on this deployment's OWN credential
//      (readTenantIdFromCredential, issue #804) when step 3 found no stack config
//      to seed from. This is the authoritative identity — the PAT IS the caller —
//      so on a fresh deployment it is what gets pinned, and the persisted
//      workspace id therefore matches the tenant the deployment runs as.
//   5. A tenant id guessed from the OSC subscription list (readTenantIdFromOsc)
//      when the credential could not be read at all. Read its header: the live
//      payload does NOT identify the caller, which is why it now sits below the
//      credential. It is PINNED only when the store is known to hold no stack
//      config (a fresh deployment, where any self-consistent namespace is correct
//      because nothing has been written yet) AND no credential tenant was
//      available to prefer; when the stored evidence was ambiguous or could not be
//      read, the guess is served for this resolve and NOT pinned.
//   6. STACK_CONFIG_NAMESPACE (`default`) when nothing above produced a value.
//      This branch deliberately does NOT pin: pinning a `default` we only chose
//      because reads failed would permanently strand a deployment whose stacks
//      live under a tenant-scoped key — the exact direction-2 failure issue #776
//      reports, which the #751 read fallback does not cover. Leaving the pin
//      unset lets the next healthy boot seed/derive the real id instead.
//
// Every store read/write here is best-effort: a failure is logged and falls
// through to the next step, so a parameter-store blip can never make the
// namespace unresolvable. A failed pin WRITE additionally clears `deterministic`
// so the caller neither memoises nor advertises a value nothing persisted.
export async function resolveWorkspaceId(
  osc: Context,
  opts: ResolveWorkspaceIdOptions = {}
): Promise<WorkspaceIdResolution> {
  const log = opts.log ?? noopLogger;

  // Best-effort pin write. Returns TRUE only when the value actually reached the
  // store, which is what `deterministic` reports (issue #776 review, finding 2):
  // a throw here means the next boot finds nothing pinned, so this resolve must
  // not claim stability it does not have.
  async function pinOnce(
    store: WorkspaceIdStore | undefined,
    value: string,
    how: WorkspaceIdSource
  ): Promise<boolean> {
    if (!store) return false;
    try {
      await store.set(WORKSPACE_ID_PIN_KEY, value);
      log.info(
        { key: WORKSPACE_ID_PIN_KEY, workspaceId: value, source: how },
        'workspace id: pinned; later boots read it back instead of re-resolving it'
      );
      return true;
    } catch (err) {
      // Non-fatal: serve the value now and retry the pin on the next resolve.
      log.warn(
        {
          err: err instanceof Error ? { message: err.message } : String(err),
          key: WORKSPACE_ID_PIN_KEY,
          workspaceId: value,
          source: how
        },
        'workspace id: pin write failed; serving the resolved id without pinning it and will retry on the next resolve'
      );
      return false;
    }
  }

  // 1. Explicit operator config wins outright and costs no round-trip.
  const configured = process.env[WORKSPACE_ID_ENV_VAR];
  if (configured !== undefined && configured.trim().length > 0) {
    if (isUsableWorkspaceId(configured)) {
      return { workspaceId: configured.trim(), source: 'env', deterministic: true };
    }
    log.warn(
      { env: WORKSPACE_ID_ENV_VAR },
      'ignoring configured workspace id: it must not contain "/" (it is a single parameter-store key segment)'
    );
  }

  // The tenant on this deployment's OWN credential (issue #804). Authoritative
  // when present; undefined only when the PAT is absent or undecodable (offline
  // runs, Context stubs in tests), in which case every step below behaves exactly
  // as it did before #804.
  const credentialTenantId = readTenantIdFromCredential(osc);

  const store = opts.store;

  // 2. Read back the pin written at provisioning time, VALIDATING it against the
  // credential before honouring it (issue #804).
  if (store) {
    let pinned: string | undefined;
    let pinReadFailed = false;
    try {
      pinned = await store.get(WORKSPACE_ID_PIN_KEY);
    } catch (err) {
      pinReadFailed = true;
      log.warn(
        {
          err: err instanceof Error ? { message: err.message } : String(err),
          key: WORKSPACE_ID_PIN_KEY
        },
        'workspace id: pin read failed; falling back to deriving it from OSC'
      );
    }
    if (!pinReadFailed && isUsableWorkspaceId(pinned)) {
      const value = pinned.trim();
      // No credential to check against, or the pin already names the tenant this
      // deployment runs as: honour it unchanged (the #776 contract).
      if (!credentialTenantId || value === credentialTenantId) {
        return { workspaceId: value, source: 'pinned', deterministic: true };
      }
      return reconcilePinAgainstCredential({
        store,
        log,
        pinOnce,
        pinnedWorkspaceId: value,
        credentialTenantId
      });
    }
  }

  // 3. No pin yet: seed it from the namespace this deployment's OWN stack
  // configs already live under, BEFORE considering any derived value. On an
  // upgrade path this is the only correct answer — see the header note and
  // seedWorkspaceIdFromStoredStacks.
  const evidence = store
    ? await seedWorkspaceIdFromStoredStacks(store, log)
    : ({ kind: 'none' } as StoredNamespaceEvidence);
  if (evidence.kind === 'seeded') {
    // The seeded namespace is where this deployment's data demonstrably lives, so
    // it wins even over the credential: re-pointing the namespace would strand
    // every existing stack config. Report the disagreement loudly instead
    // (issue #804) so an operator can migrate deliberately.
    if (credentialTenantId && evidence.workspaceId !== credentialTenantId) {
      log.warn(
        {
          workspaceId: evidence.workspaceId,
          credentialTenantId,
          key: WORKSPACE_ID_PIN_KEY,
          remediation: WORKSPACE_ID_ENV_VAR
        },
        `workspace id: this deployment's stack configs live under a namespace that is NOT the tenant on its own credential; keeping the namespace that holds the data so nothing is stranded — set ${WORKSPACE_ID_ENV_VAR} to move it deliberately`
      );
    }
    const pinned = await pinOnce(store, evidence.workspaceId, 'seeded');
    return {
      workspaceId: evidence.workspaceId,
      source: 'seeded',
      deterministic: pinned
    };
  }

  // 4. No existing stack config to seed from. The deployment's own credential is
  // the authoritative identity (issue #804), so it is preferred over the
  // subscription guess and is what a fresh deployment pins — which is what makes
  // the persisted workspace id match the tenant the deployment runs as.
  //
  // It is pinned ONLY when the store is known to hold no stack config at all
  // (`none`) — a genuinely fresh deployment, where any self-consistent namespace
  // is correct because nothing has been written yet. When the evidence was
  // ambiguous or could not be read (`ambiguous` / `unknown`) the value is served
  // for this resolve but NOT pinned (issue #776 review, finding 1).
  if (credentialTenantId) {
    const pinned =
      evidence.kind === 'none'
        ? await pinOnce(store, credentialTenantId, 'credential')
        : false;
    return {
      workspaceId: credentialTenantId,
      source: 'credential',
      deterministic: pinned
    };
  }

  // 5. The credential could not be read at all. Fall back to the best-effort
  // subscription guess, unchanged from #776 — including its pin-on-fresh-store
  // behaviour, which stays the only durable answer available in that state.
  const tenantId = await readTenantIdFromOsc(osc);
  if (tenantId) {
    const pinned =
      evidence.kind === 'none' ? await pinOnce(store, tenantId, 'derived') : false;
    return { workspaceId: tenantId, source: 'derived', deterministic: pinned };
  }

  // 6. Nothing to pin at all. Serve `default` for this resolve WITHOUT pinning
  // it (see the header note).
  return {
    workspaceId: STACK_CONFIG_NAMESPACE,
    source: 'fallback',
    deterministic: false
  };
}

// Decide what to do with a PINNED workspace id that disagrees with the tenant on
// this deployment's own credential (issue #804).
//
// PR #777 persisted whatever the pre-#804 derivation produced, with no
// validation. On a live account that derivation reads the PUBLISHER tenant of a
// subscribed service rather than the caller, so deployments exist today whose
// `_meta/workspace-id` names a tenant they do not own — permanently, because the
// pin is read back on every later boot.
//
// The correction must never strand data. `openvideocore/<ns>/<name>` is the only
// place stack coordinates live and there is no cross-namespace read (the #712
// isolation constraint; the #733/#751 fallback covers the literal `default`
// ONLY), so silently re-pointing the namespace of a deployment whose configs sit
// under the wrong value would make its stack unresolvable. Policy:
//
//   - the store holds NO stack config at all ('none'): nothing to strand, so the
//     pin is CORRECTED to the credential tenant. This is the fresh-stack case
//     #804 reports — provisioned, wrong namespace frozen at provision time.
//   - stack configs DO live under the pinned namespace: keep it. The data is
//     reachable there and moving it is an operator decision, not something a boot
//     should do. Reported at warn with the OVC_WORKSPACE_ID remediation, which
//     wins outright over the pin (step 1) and is the supported correction lever.
//   - stack configs live under exactly one OTHER namespace ('seeded' elsewhere):
//     the pin is stranding them right now, so it is corrected to the namespace
//     that actually holds the data.
//   - the evidence is ambiguous or unreadable: change nothing and keep serving the
//     pin, so a transient store failure can never re-point a working deployment.
//
// A correcting write that THROWS clears `deterministic`, exactly as pinOnce
// reports elsewhere, so nothing memoises a value the store did not accept.
async function reconcilePinAgainstCredential(args: {
  store: WorkspaceIdStore;
  log: StackResolverLogger;
  pinOnce: (
    store: WorkspaceIdStore | undefined,
    value: string,
    how: WorkspaceIdSource
  ) => Promise<boolean>;
  pinnedWorkspaceId: string;
  credentialTenantId: string;
}): Promise<WorkspaceIdResolution> {
  const { store, log, pinOnce, pinnedWorkspaceId, credentialTenantId } = args;
  const evidence = await seedWorkspaceIdFromStoredStacks(store, log);

  // `source` names where the corrected value came FROM, not merely that a
  // correction happened: correcting to the credential tenant is 'credential',
  // while correcting to the namespace the stack configs actually live under is
  // 'seeded' — by construction that value is NOT the credential tenant, so
  // labelling it 'credential' would mis-report both the log line and the
  // returned WorkspaceIdResolution.
  const correctTo = async (
    target: string,
    source: Extract<WorkspaceIdSource, 'credential' | 'seeded'>
  ): Promise<WorkspaceIdResolution> => {
    log.warn(
      {
        key: WORKSPACE_ID_PIN_KEY,
        pinnedWorkspaceId,
        credentialTenantId,
        correctedTo: target,
        correctedFrom: source,
        evidence: evidence.kind
      },
      'workspace id: the pinned namespace does not match the tenant on this deployment\'s own credential and no stack config is stranded by changing it; correcting the pin'
    );
    const written = await pinOnce(store, target, source);
    return {
      workspaceId: target,
      source,
      deterministic: written
    };
  };

  // Nothing stored anywhere: safe to correct outright.
  if (evidence.kind === 'none') return correctTo(credentialTenantId, 'credential');

  // Exactly one namespace holds stack configs.
  if (evidence.kind === 'seeded') {
    if (evidence.workspaceId === pinnedWorkspaceId) {
      log.warn(
        {
          key: WORKSPACE_ID_PIN_KEY,
          pinnedWorkspaceId,
          credentialTenantId,
          remediation: WORKSPACE_ID_ENV_VAR
        },
        `workspace id: the pinned namespace "${pinnedWorkspaceId}" does not match this deployment's credential tenant "${credentialTenantId}", but its stack configs live under the pinned namespace; keeping it so nothing is stranded — set ${WORKSPACE_ID_ENV_VAR} to move it deliberately`
      );
      return {
        workspaceId: pinnedWorkspaceId,
        source: 'pinned',
        deterministic: true
      };
    }
    // The pin points at a namespace that holds nothing while the data sits
    // elsewhere: the pin is actively stranding it. Correct to where the data is.
    // That target is the SEEDED namespace, not the credential tenant.
    return correctTo(evidence.workspaceId, 'seeded');
  }

  // 'ambiguous' / 'unknown': never re-point on evidence we cannot trust.
  log.warn(
    {
      key: WORKSPACE_ID_PIN_KEY,
      pinnedWorkspaceId,
      credentialTenantId,
      evidence: evidence.kind,
      remediation: WORKSPACE_ID_ENV_VAR
    },
    `workspace id: the pinned namespace does not match this deployment's credential tenant, and the stored evidence is ${evidence.kind}; keeping the pin unchanged — set ${WORKSPACE_ID_ENV_VAR} to resolve it`
  );
  return { workspaceId: pinnedWorkspaceId, source: 'pinned', deterministic: true };
}

export class WorkspaceStackResolver {
  private cache = new Map<string, CacheEntry>();
  private paramStore: ParamStore | undefined;
  private oscContext: Context;
  private minioPassword: string;
  private couchPassword: string;
  private optionalSteps: OptionalStepBuilders;
  // Aggregate degraded-resolution signal (issue #422). When supplied the
  // resolver emits on every degraded fallback (no-storage / stale
  // last-known-good) so an operator can detect a degraded-but-not-crashed
  // instance via /health without logs.
  private resolverHealth: ResolverHealthSignal | undefined;
  // Pin store for the deterministic workspace id (issue #776). Optional: when
  // omitted the resolver degrades to derive-only namespace resolution, which is
  // what every existing caller/test that wires no store already got.
  private workspaceIdStore: WorkspaceIdStore | undefined;
  // Memoised namespace for this process. Only a DETERMINISTIC resolution (env /
  // pinned / seeded-or-derived AND successfully pinned) is memoised: the
  // `default` fallback — and any resolution whose pin write threw — is
  // deliberately NOT cached, so a boot that started before the pin existed
  // re-resolves and picks the pin up instead of staying stuck on a value nothing
  // persisted for the life of the process. Cleared by
  // invalidate() so a provision that establishes the pin is seen immediately.
  private namespaceMemo: string | undefined;
  // Diagnostic/observability logger. `info`/`warn` carry the read-path
  // diagnostics (issue #415: (namespace, stack name) correlation on each
  // resolve); `error` surfaces a transient parameter-store refresh failure
  // instead of silently swallowing it (issue #419). Defaults to a noop so
  // existing callers/tests are unaffected.
  private log: StackResolverLogger;

  constructor(opts: {
    paramStore: ParamStore | undefined;
    oscContext: Context;
    minioPassword: string;
    couchPassword: string;
    // Builders that activate the OPTIONAL subtitles/scene-detect steps from the
    // stack record (issue #217). Optional so callers/tests that don't wire the
    // optional services get the graceful-skip behaviour (steps disabled).
    optionalSteps?: OptionalStepBuilders;
    // Aggregate degraded-resolution signal (issue #422). Optional so existing
    // callers/tests are unaffected; when supplied the resolver emits on every
    // degraded fallback (no-storage / stale last-known-good) so an operator can
    // detect a degraded-but-not-crashed instance via /health without logs.
    resolverHealth?: ResolverHealthSignal;
    // Pin store backing the deterministic workspace id (issue #776). The SAME
    // store the provision route is given, so the namespace the resolver READS
    // under is the one provisioning PINNED. Optional: without it the resolver
    // falls back to deriving the namespace from OSC on every resolve (pre-#776
    // behaviour), which is not stable across boots.
    workspaceIdStore?: WorkspaceIdStore;
    // Injected logger so read-path diagnostics (issue #415) and transient
    // parameter-store refresh failures (issue #419) are observable. Optional;
    // defaults to a noop for callers/tests that don't wire one.
    log?: StackResolverLogger;
  }) {
    this.paramStore = opts.paramStore;
    this.oscContext = opts.oscContext;
    this.minioPassword = opts.minioPassword;
    this.couchPassword = opts.couchPassword;
    this.optionalSteps = opts.optionalSteps ?? {};
    this.resolverHealth = opts.resolverHealth;
    this.workspaceIdStore = opts.workspaceIdStore;
    this.log = opts.log ?? noopLogger;
  }

  // Resolve the parameter-store namespace for this deployment (issue #776).
  //
  // Delegates to the shared resolveWorkspaceId — the SAME function the provision
  // route writes under — so the resolver's read key provably equals the provision
  // write key. The result is memoised for the life of the process ONLY when it is
  // deterministic (env / pinned / seeded-or-derived AND successfully pinned); a
  // non-deterministic resolution is re-resolved every time so the process picks
  // up the pin as soon as one actually exists.
  //
  // PUBLIC since issue #804 so main.ts's remaining parameter-store consumers can
  // address the SAME namespace this resolver reads under instead of the literal
  // STACK_CONFIG_NAMESPACE. Prefer the namespace-aware helpers below
  // (listStackNames / loadStackConfig / storeStackConfig), which also apply the
  // #733/#751 legacy fallback; reach for the raw namespace only when an external
  // signature demands the string itself.
  async resolveNamespace(): Promise<string> {
    if (this.namespaceMemo !== undefined) return this.namespaceMemo;
    const resolution = await resolveWorkspaceId(this.oscContext, {
      ...(this.workspaceIdStore ? { store: this.workspaceIdStore } : {}),
      log: this.log
    });
    if (resolution.deterministic) {
      this.namespaceMemo = resolution.workspaceId;
    }
    return resolution.workspaceId;
  }

  // Read a stack config for the derived namespace, with a one-shot read-side
  // compatibility fallback to the literal `default` namespace for stacks
  // provisioned before the tenant-scoped namespace landed (issue #712/#733).
  //
  // Order:
  //   1. Read `loadStackConfig(namespace, name)` — the tenant-scoped key. A hit
  //      returns immediately, so a stack provisioned AFTER #712 takes NO fallback
  //      read on its hit path (issue #733 acceptance criterion).
  //   2. On a miss, and only when the derived namespace is NOT already the literal
  //      `default`, retry ONCE under `default`. This is the sole legacy namespace;
  //      we never read another tenant's namespace and never scan across namespaces
  //      (issue #733 security constraint — anything broader reintroduces the
  //      cross-workspace leakage #712 closed).
  //   3. On a legacy hit, migrate-on-read: write the config to the tenant-scoped
  //      key and log at info, so the fallback is taken at most once per stack. The
  //      migrate is best-effort — if the write throws, we still serve the resolved
  //      config for this request and the next resolve retries the migrate.
  private async loadStackConfigWithLegacyFallback(
    ps: ParamStore,
    namespace: string,
    name: string
  ): Promise<StackConfig | undefined> {
    const direct = await ps.loadStackConfig(namespace, name);
    if (direct) return direct;
    // A deployment whose OWN namespace IS the literal `default` has already had
    // it read above, so there is nothing to fall back to and no second read is
    // issued. This guard is deliberately NOT widened (issue #776): the failure it
    // used to expose — a tenant-scoped stack booting under a spuriously-derived
    // `default` and finding nothing — is closed at the cause by the pinned,
    // deterministic namespace (resolveWorkspaceId), not by reading a namespace
    // this deployment does not own. Widening it would mean probing namespaces
    // across tenants, which is the isolation risk #712 closed.
    if (namespace === STACK_CONFIG_NAMESPACE) return undefined;
    const legacy = await ps.loadStackConfig(STACK_CONFIG_NAMESPACE, name);
    if (!legacy) return undefined;
    try {
      await ps.storeStackConfig(namespace, name, legacy);
      this.log.info(
        { op: 'migrateStackConfig', from: STACK_CONFIG_NAMESPACE, to: namespace, name },
        'migrated legacy default-namespaced stack config to tenant-scoped key'
      );
    } catch (err) {
      // A failed migrate is non-fatal: serve the legacy config this request and
      // let the next resolve retry the write. Never fail the resolve on it.
      this.log.warn(
        {
          err: err instanceof Error ? { message: err.message } : String(err),
          from: STACK_CONFIG_NAMESPACE,
          to: namespace,
          name
        },
        'resolved legacy default-namespaced stack config but migrate-on-read write failed; will retry next resolve'
      );
    }
    return legacy;
  }

  // List stack names for the derived namespace, with the same one-shot fallback
  // to the literal `default` namespace (issue #733). Without this, a pre-#712
  // stack whose names live only under `default/` stays invisible to the resolver's
  // "first listed stack" path even when its config could be read directly. Falls
  // back ONLY when the tenant-scoped listing is empty and the namespace is not
  // already `default`; never scans other namespaces (issue #733 security
  // constraint). Migration of the individual config happens on the subsequent
  // load via loadStackConfigWithLegacyFallback.
  private async listStackNamesWithLegacyFallback(
    ps: ParamStore,
    namespace: string
  ): Promise<string[]> {
    const direct = await ps.listStackNames(namespace);
    if (direct.length > 0) return direct;
    if (namespace === STACK_CONFIG_NAMESPACE) return direct;
    return ps.listStackNames(STACK_CONFIG_NAMESPACE);
  }

  // Resolve the backing-service connections for a workspace. When `stackName`
  // is given (from the X-Stack-Name request header) the named stack is used
  // instead of the workspace's default (first provisioned) stack — letting a
  // client switch between multiple provisioned stacks. The explicit env-var
  // override, when active, wins regardless of stackName.
  async resolve(stackName?: string): Promise<WorkspaceConnections> {
    const cacheKey = stackName ?? '';
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.connections;

    // Explicit env-var override (local dev / ops). When COUCHDB_URL or MINIO_URL
    // is set we build connections from the environment for ALL workspaces,
    // bypassing the parameter store entirely.
    const envConnections = buildEnvConnections(this.oscContext);
    if (envConnections) {
      // Explicit env override is an intended, healthy configuration — not a
      // degraded fallback. Clear any prior degraded gauge (issue #422).
      this.resolverHealth?.markHealthy();
      // Env-override is not a ready-stack resolution: it is never eligible for
      // the last-known-good fallback (invariant: env-override path unchanged).
      this.cache.set(cacheKey, {
        connections: envConnections,
        expiresAt: Date.now() + CACHE_TTL_MS,
        fromReadyStack: false,
        resolvedAt: Date.now()
      });
      return envConnections;
    }

    const ps = this.paramStore;
    if (!ps) {
      // No parameter store configured: the resolver serves no-op in-memory
      // (no-storage) connections. Signal this degraded state (issue #422).
      this.resolverHealth?.markNoStorageFallback();
      return buildInMemoryConnections();
    }

    // Resolve the parameter-store namespace via the SAME resolveWorkspaceId the
    // provision route writes under (issue #712/#776), so the resolver read key
    // provably equals the provision write key for this deployment AND does not
    // change between boots when the tenant's subscription set does. Falls back to
    // STACK_CONFIG_NAMESPACE identically on both sides when there is no pin and
    // the OSC subscription list is unreachable/empty (test/offline environments).
    const namespace = await this.resolveNamespace();

    // Resolve the stack config: an explicit stack name addresses that stack
    // directly; otherwise use the first provisioned stack as the workspace
    // default.
    let config: StackConfig | undefined;
    try {
      if (stackName) {
        // READ-PATH diagnostic (issue #415): the resolver reads by the
        // X-Stack-Name-derived name under the derived namespace. This is the
        // (namespace, name) pair whose derived key must equal the key the
        // provision route wrote; the param-store client logs the concrete key.
        this.log?.info?.(
          { source: 'x-stack-name', namespace, stackName },
          'resolver reading stack config by requested name'
        );
        config = await this.loadStackConfigWithLegacyFallback(ps, namespace, stackName);
        // If the requested stack name isn't found, fall back to the default
        // (first provisioned) stack rather than degrading to in-memory
        // connections. This prevents stale UI stack selections from breaking
        // all storage/asset operations.
        if (!config) {
          const names = await this.listStackNamesWithLegacyFallback(ps, namespace);
          this.log?.info?.(
            { namespace, requested: stackName, listed: names },
            'requested stack not found; falling back to first listed stack'
          );
          if (names.length > 0) {
            config = await this.loadStackConfigWithLegacyFallback(ps, namespace, names[0]);
          }
        }
      } else {
        // READ-PATH diagnostic (issue #415): no X-Stack-Name header, so the
        // resolver uses the FIRST listed stack as the default. If the list is
        // empty here but the provision route logged a successful write, the
        // write key and the list prefix disagree — a read-side namespace/key bug.
        const names = await this.listStackNamesWithLegacyFallback(ps, namespace);
        this.log?.info?.(
          { source: 'default', namespace, listed: names },
          'resolver reading default stack config (no X-Stack-Name)'
        );
        if (names.length > 0) {
          config = await this.loadStackConfigWithLegacyFallback(ps, namespace, names[0]);
        }
      }
    } catch (err) {
      // A THROWN refresh error means we couldn't refresh — NOT that the stack
      // ceased to exist (issue #420, architect sign-off). We must no longer
      // swallow it silently (issue #419): log the real error with message +
      // stack, the stack identifier, the read namespace (issue #415
      // correlation), and the outcome, so a subsequent 501 from
      // GET /api/v1/storage/buckets is traceable — whether we serve
      // last-known-good or fall through to no-storage.
      const servingLastKnownGood =
        !!cached &&
        cached.fromReadyStack &&
        Date.now() - cached.resolvedAt < MAX_STALE_MS;
      this.log.error(
        {
          err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
          namespace,
          stackName: stackName ?? '(workspace default)',
          fallback: servingLastKnownGood
            ? 'last-known-good (stale ready-stack resolution)'
            : 'in-memory (no object storage)'
        },
        'stack resolver: parameter-store refresh failed; serving fallback resolution'
      );
      // If a prior successful ready-stack resolution is still in cache and
      // within the MAX_STALE_MS bound (measured from its ORIGINAL resolve time),
      // serve that last-known-good resolution rather than dropping to
      // no-storage — a previously-healthy instance must not return 501 for all
      // storage ops on a single failed refresh. Only a THROWN error takes this
      // path: a successful load returning `undefined` (genuine 404 /
      // never-persisted #413) falls through below and drops to no-storage — we
      // never fabricate a stack. Ordering (architect condition 2):
      // last-known-good is the post-failure path only; any future retry (#421)
      // runs before we get here.
      if (servingLastKnownGood && cached) {
        // Serving stale-but-good ready-stack connections is a degraded (but not
        // crashed) state: signal it so /health surfaces the stale fallback
        // (issue #422).
        this.resolverHealth?.markStaleLastKnownGood();
        // Serve stale-but-good WITHOUT extending expiresAt or resetting
        // resolvedAt: the entry stays past-TTL so the next request re-attempts a
        // fresh refresh, and MAX_STALE_MS keeps counting from first success so
        // we never serve indefinitely.
        return cached.connections;
      }
      // No eligible last-known-good (first-resolve-at-boot, an in-memory/
      // env-override prior entry, or past MAX_STALE_MS): fall through to
      // no-storage, unchanged from prior behaviour.
    }

    // A partially-provisioned/failed stack must never be treated as a live,
    // connectable stack (issue #106): only 'ready' (or legacy status-less)
    // configs are connected. Non-ready configs still exist in the store so the
    // deprovision route can read services[] and clean up, but the resolver skips
    // them here. buildConnectionsFromStack also returns null for empty/invalid
    // coordinates (issue #105 defence-in-depth). In every skip case we fall back
    // to no-op in-memory connections so /health and infra routes stay up.
    const built =
      config && isReadyStack(config)
        ? buildConnectionsFromStack(config, this.minioPassword, this.couchPassword, this.oscContext, this.optionalSteps)
        : null;

    // Emit the aggregate degraded-resolution signal (issue #422): a null build
    // here means we could not connect a ready stack and are dropping to the
    // no-op in-memory (no-storage) fallback. A live build is healthy and clears
    // any prior degraded gauge.
    if (built) {
      this.resolverHealth?.markHealthy();
    } else {
      this.resolverHealth?.markNoStorageFallback();
    }

    const connections = built ?? buildInMemoryConnections();

    // Only a resolution built from a real ready-stack config is eligible to be
    // served as last-known-good on a later failed refresh (issue #420
    // invariant). A no-storage in-memory fallback is not.
    this.cache.set(cacheKey, {
      connections,
      expiresAt: Date.now() + CACHE_TTL_MS,
      fromReadyStack: built !== null,
      resolvedAt: Date.now()
    });
    return connections;
  }

  // Resolve the EFFECTIVE stack identity a request routes to (issue #615).
  //
  // This is the single source of truth for "which stack does this request
  // belong to", used to KEY the transcode/scaler coordinates (Encore pool,
  // Valkey queue, MinIO S3 endpoint) so they are resolved per request rather
  // than pinned to whichever stack was provisioned first in the process.
  //
  // Resolution mirrors resolve(): an explicit `requestedStackName` (from the
  // X-Stack-Name header) addresses that stack directly when a config exists for
  // it; otherwise (no header, or the requested name has no stored config) the
  // FIRST provisioned stack for the namespace is the workspace default. Returns
  // `undefined` only when no stack is provisioned at all (or the parameter store
  // is unconfigured) — callers then fall back to the fixed deployment context.
  //
  // CRITICAL (issue #615): a requested name that HAS a stored config is returned
  // verbatim and is NEVER silently rewritten to the first-listed stack, so two
  // healthy stacks in one workspace can never share a mis-resolved client.
  async resolveStackName(requestedStackName?: string): Promise<string | undefined> {
    const ps = this.paramStore;
    if (!ps) return undefined;
    // Resolve the namespace via the SAME resolveWorkspaceId the provision route
    // writes under (issue #712/#776) so this read key equals the provision write
    // key, on this boot and every later one.
    const namespace = await this.resolveNamespace();
    try {
      if (requestedStackName) {
        const config = await this.loadStackConfigWithLegacyFallback(
          ps,
          namespace,
          requestedStackName
        );
        // A requested name that resolves to a real config wins verbatim; the
        // request routes to exactly the stack it named regardless of provision
        // order. The legacy fallback also covers a pre-#712 stack whose config
        // exists only under `default` (issue #733) — after migrate-on-read it is
        // a direct hit next time. Only when the requested name has NO stored
        // config (even under the legacy namespace) do we fall through to the
        // workspace default (a stale UI selection must not break routing),
        // matching resolve()'s fallback semantics.
        if (config) return requestedStackName;
      }
      const names = await this.listStackNamesWithLegacyFallback(ps, namespace);
      return names.length > 0 ? names[0] : undefined;
    } catch (err) {
      // A parameter-store read failure is not authority to invent a stack: log
      // and return undefined so the caller uses the fixed deployment context
      // (unchanged pre-#615 behaviour) rather than a fabricated name.
      this.log.error(
        {
          err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
          namespace,
          requestedStackName: requestedStackName ?? '(workspace default)'
        },
        'stack resolver: failed to resolve effective stack name'
      );
      return undefined;
    }
  }

  // Resolve the RAW StackConfig a consumer routes to (issue #780).
  //
  // resolve() builds live connections and resolveStackName() returns an
  // identity; neither exposes the stored record itself, so a consumer that
  // needs a plain field off the config (the scaler needs `redisUrl`) had no
  // namespace-aware way to read it and open-coded
  // `loadStackConfig(STACK_CONFIG_NAMESPACE, ...)` — the literal `default` —
  // which resolves nothing on any deployment whose derived namespace is a real
  // tenant id (issue #712), silently disabling the scaler.
  //
  // Resolution is IDENTICAL to resolveStackName() above — the same
  // deriveWorkspaceId namespace and the same one-shot legacy fallback helpers
  // (loadStackConfigWithLegacyFallback / listStackNamesWithLegacyFallback,
  // issue #733) — so the two paths cannot drift apart again: an explicit
  // `stackName` addresses that stack, otherwise the first provisioned stack for
  // the namespace is the workspace default.
  //
  // Returns undefined when no parameter store is configured or no stack is
  // provisioned. A parameter-store failure THROWS (unlike resolveStackName,
  // which degrades to the fixed deployment context) so the caller can tell
  // "read failed" apart from "no stack provisioned" and log accordingly.
  async resolveStackConfig(stackName?: string): Promise<StackConfig | undefined> {
    const ps = this.paramStore;
    if (!ps) return undefined;
    // Issue #804: this called the bare deriveWorkspaceId while resolve() /
    // resolveStackName() went through resolveNamespace() — so the scaler's config
    // read could address a DIFFERENT namespace from the rest of the resolver
    // (deriveWorkspaceId consults neither the pin nor the seed). Both paths now
    // share resolveNamespace(), which is the whole point of routing through here.
    const namespace = await this.resolveNamespace();
    if (stackName) {
      const requested = await this.loadStackConfigWithLegacyFallback(ps, namespace, stackName);
      // A requested name that has a stored config wins verbatim; only a name
      // with no config at all falls through to the workspace default, matching
      // resolve()/resolveStackName() semantics.
      if (requested) return requested;
    }
    const names = await this.listStackNamesWithLegacyFallback(ps, namespace);
    if (names.length === 0) return undefined;
    return this.loadStackConfigWithLegacyFallback(ps, namespace, names[0]!);
  }

  // ---------------------------------------------------------------------------
  // Namespace-aware parameter-store view (issue #804).
  //
  // Every remaining consumer in src/main.ts used to call
  // `paramStore.listStackNames(STACK_CONFIG_NAMESPACE)` /
  // `paramStore.loadStackConfig(STACK_CONFIG_NAMESPACE, name)` directly — the
  // LITERAL `default`. On any deployment whose namespace is a real tenant id that
  // resolves nothing, which is what broke transcoding: resolveS3Config found no
  // config, returned undefined, and the spawned Encore instance was given no
  // s3Endpoint at all (instance-pool.ts:164-169), so it resolved `s3://` inputs
  // against AWS and 404'd.
  //
  // These three methods are the supported way for those consumers to reach the
  // store. They resolve the namespace through the SAME resolveNamespace() the
  // read path uses and apply the SAME #733/#751 legacy fallback helpers, so a
  // consumer can no longer drift onto its own namespace policy.
  //
  // All three return/throw exactly what the underlying ParamStore does
  // (param-store.ts:108-125); they return undefined / [] when no store is
  // configured, matching resolveStackConfig()'s existing shape.
  // ---------------------------------------------------------------------------

  // List the provisioned stack names for this deployment's namespace, with the
  // one-shot `default` legacy fallback.
  async listStackNames(): Promise<string[]> {
    const ps = this.paramStore;
    if (!ps) return [];
    const namespace = await this.resolveNamespace();
    return this.listStackNamesWithLegacyFallback(ps, namespace);
  }

  // Read one named stack's config from this deployment's namespace, with the
  // one-shot `default` legacy fallback (and its migrate-on-read).
  async loadStackConfig(name: string): Promise<StackConfig | undefined> {
    const ps = this.paramStore;
    if (!ps) return undefined;
    const namespace = await this.resolveNamespace();
    return this.loadStackConfigWithLegacyFallback(ps, namespace, name);
  }

  // Write one named stack's config under this deployment's namespace. No legacy
  // fallback applies to a WRITE: a write must always land on the namespace this
  // deployment reads under, never on the `default` compatibility shim.
  async storeStackConfig(name: string, config: StackConfig): Promise<void> {
    const ps = this.paramStore;
    if (!ps) {
      throw new Error(
        'cannot persist stack config: no parameter store is configured for this deployment'
      );
    }
    const namespace = await this.resolveNamespace();
    await ps.storeStackConfig(namespace, name, config);
  }

  // Synchronous read of already-resolved connections from cache. Returns
  // undefined when nothing is cached (or the entry expired). The global
  // preHandler hook warms the cache with `resolve()` before any handler runs,
  // so a handler-time synchronous factory (e.g. the sync StorageFactory the
  // asset routers expect) can read the connections without re-awaiting.
  resolveCached(stackName?: string): WorkspaceConnections | undefined {
    const cacheKey = stackName ?? "";
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.connections;
    return undefined;
  }

  // Invalidate all cached connections for a workspace (default + every named
  // stack), so a freshly provisioned/torn-down stack is picked up immediately.
  // Also drops the memoised namespace (issue #776): a first provision is what
  // normally PINS the workspace id, so a process that resolved before the pin
  // existed must re-resolve here rather than keep serving the pre-pin namespace.
  invalidate(): void {
    this.cache.clear();
    this.namespaceMemo = undefined;
  }
}
