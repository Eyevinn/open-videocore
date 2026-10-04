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
  CONFIG_LIST_PAGE_LIMIT,
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
// Operational log store (issue #996): durable CouchLogStore on the Couch paths,
// in-memory LogStore on the no-Couch paths — the same Couch/in-memory pairing
// `audit` uses above.
import { CouchLogStore } from '../data/couch-log-repo.js';
import {
  LogStore,
  type LogReader,
  type LogRetentionStore,
  type LogSink
} from './log-store.js';
import type { ProfileRepository } from '../data/profile-repo.js';
import type { StorageFactory } from '../routes/asset-upload.js';
import { makeHttpEncoreClient, type EncoreClient } from '../pipeline/encore-client.js';
import type { SubtitleGenerator } from '../pipeline/subtitle-generator.js';
import type { SceneDetector } from '../pipeline/scene-detector.js';
import type { Context } from '@osaas/client-core';
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

// Process-wide in-memory operational log store for the NO-COUCH paths only
// (issue #996). Deliberately a module singleton rather than one per built
// connection set: the resolver rebuilds connections on every cache miss (and the
// no-parameter-store branch rebuilds on EVERY resolve), so a per-resolution store
// would discard records that the pre-#996 wiring — one global `new LogStore()`
// in main.ts, held for the process lifetime — kept. Couch-backed paths never
// touch this; they get a durable CouchLogStore.
const fallbackLogStore = new LogStore();

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
  // Operational log store for this stack (issue #996). Backed by CouchLogStore
  // on every Couch-backed path, so records written by the pipeline producer
  // survive a restart and are still returned by GET /api/v1/logs; the in-memory
  // LogStore backs the no-Couch dev/test paths. ALWAYS present, like `audit`.
  // Carries the `append()` write primitive the pipeline producer uses
  // (src/services/pipeline-log.ts), the `list()` read the logs router uses
  // (src/routes/logs.ts), AND the retention surface (issue #1067,
  // listOldestPage/purgeEntry) the log-retention purge sweep drives per tick —
  // the same three-way intersection `audit` above carries. Typed as the
  // intersection so the single field serves all three consumers; both concrete
  // stores satisfy it.
  logs: LogSink & LogReader & LogRetentionStore;
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
  // The stack identity these connections were built from (issue #1058): the
  // parameter-store stack name, i.e. the same identity `resolveStackName()`
  // returns for the transcode control plane. Undefined on the env-override and
  // in-memory fallback paths, which are not stack records. Callers compare this
  // against the control plane's resolved stack to detect a data-plane /
  // control-plane split; they MUST NOT compare endpoint hostnames, which
  // legitimately differ for the same stack (in-cluster vs public ingress,
  // issue #991).
  stackName: string | undefined;
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
  optionalSteps: OptionalStepBuilders,
  // The parameter-store name this config was loaded under (issue #1058).
  // Carried onto the connections as their stack identity.
  stackName: string | undefined,
  // Where the durable log store reports its own failures (#996 review finding
  // 2). Optional so the existing callers/tests are unaffected.
  log?: StackResolverLogger
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
  // Operational log store over the SAME per-stack CouchDB connection (issue
  // #996), so log records land in the stack the request resolved to and survive
  // a restart of this process.
  // `log` so a failed overflow eviction or an over-cap read window is reported
  // instead of swallowed (#996 review finding 2).
  const logs = new CouchLogStore(wc, { log });

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
    logs,
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
    sceneDetector,
    stackName
  };
}

// True when the explicit env-var override builder (`buildEnvConnections`) is the
// active source of WorkspaceConnections — i.e. when COUCHDB_URL or MINIO_URL is
// set, in which case `resolve()` returns env-built connections for ALL
// workspaces and never consults the parameter store. This predicate MUST stay in
// lockstep with `buildEnvConnections`'s own `if (!couchUrl && !minioUrl)` guard
// below; it exists so callers can tell "this endpoint came from a provisioned
// stack record" from "this endpoint is a local/ops override", which the
// WorkspaceConnections shape itself does not distinguish (`s3Config.endpoint` is
// populated from `StackConfig.minioEndpoint` on one path and verbatim from
// MINIO_URL on the other).
export function envOverrideConnectionsActive(): boolean {
  return Boolean(process.env['COUCHDB_URL']) || Boolean(process.env['MINIO_URL']);
}

// The MinIO endpoint of a PROVISIONED stack (`StackConfig.minioEndpoint`, carried
// on `s3Config.endpoint` by `buildConnectionsFromStack`), or undefined when the
// resolved connections did not come from a stack record — the env-override path
// (MINIO_URL, used verbatim) and the no-storage in-memory path (`s3Config:
// undefined`).
//
// Consumed by the delivery/files routes to derive the packaged bucket's PUBLIC
// origin (issue #859). That derivation is deliberately restricted to
// stack-resolved connections: the anonymous-read bucket policy that makes the
// derived URL fetchable is applied only when THIS codebase provisions the stack
// (routes/provision.ts, issue #199). A local or ops-override MinIO gets no such
// policy from us, so deriving a public origin there would advertise a URL that
// very likely 403s in place of the working authorized proxy URL.
export function stackResolvedMinioEndpoint(
  connections: { s3Config?: { endpoint: string } | undefined } | null | undefined
): string | undefined {
  if (envOverrideConnectionsActive()) return undefined;
  return connections?.s3Config?.endpoint;
}

// Build connections from explicit environment variables (local dev / ops
// override). Returns undefined when no override env vars are set. When either
// COUCHDB_URL or MINIO_URL is present this path wins for ALL workspaces,
// bypassing the parameter store. The env values are used verbatim — COUCHDB_URL
// is expected to already carry any credentials it needs, and MinIO uses the
// MINIO_ACCESS_KEY/MINIO_SECRET_KEY pair.
function buildEnvConnections(
  oscContext: Context,
  // Where the durable log store reports its own failures (#996 review finding
  // 2). Optional so the existing callers/tests are unaffected.
  log?: StackResolverLogger
): WorkspaceConnections | undefined {
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
  // Operational log store (issue #996): durable on the Couch env path so
  // GET /api/v1/logs survives a restart there too, in-memory when no COUCHDB_URL
  // is configured.
  let logs: LogSink & LogReader & LogRetentionStore;
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
    // `log` so a failed overflow eviction or an over-cap read window is reported
    // instead of swallowed (#996 review finding 2).
    logs = new CouchLogStore(wc, { log });
  } else {
    const mem = new InMemoryAssetRepository();
    assets = mem;
    jobs = new InMemoryJobRepository();
    webhooks = new InMemoryWebhookRepository();
    collections = new InMemoryCollectionRepository();
    audit = new InMemoryAuditRepository();
    // No COUCHDB_URL on the env-override path: nothing to persist to, so the
    // process-local store (shared for the process, see fallbackLogStore).
    logs = fallbackLogStore;
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
    assets, jobs, search, webhooks, collections, audit, logs, profiles, pipelines,
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
    sceneDetector: undefined,
    // Not a stack record: the env override is one global set of coordinates, so
    // there is no stack identity to compare against (issue #1058).
    stackName: undefined
  };
}

function buildInMemoryConnections(): WorkspaceConnections {
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const webhooks = new InMemoryWebhookRepository();
  const collections = new InMemoryCollectionRepository();
  const audit = new InMemoryAuditRepository();
  // No stack => no durable store: the process-local log store (issue #996),
  // shared across rebuilds (see fallbackLogStore). The no-storage fallback
  // persists nothing else either.
  const logs = fallbackLogStore;
  // Search projects assets + collections (issue #561).
  const search = new InMemorySearchRepository(assets, collections);
  const profiles = new InMemoryProfileRepository();
  const pipelines = new InMemoryPipelineRepository();
  return {
    assets, jobs, search, webhooks, collections, audit, logs, profiles, pipelines,
    storageFor: undefined, storageClient: undefined,
    encore: undefined,
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    s3Config: undefined,
    storage: undefined,
    subtitleGenerator: undefined,
    sceneDetector: undefined,
    // No stack record behind the no-storage fallback (issue #1058).
    stackName: undefined
  };
}

// The parameter-store namespace segment, for every read and every write.
//
// `openvideocore/<namespace>/<stackName>` (stackConfigKey, param-store.ts:131-133)
// has THREE segments, and the middle one is a CONSTANT — not a derived tenant id
// (issue #804).
//
// Why it cannot be anything else. The store is a single eyevinn-app-config-svc
// instance per deployment (DEFAULT_PARAM_STORE_INSTANCE_NAME = 'ovcconfig',
// param-store.ts:704), resolved through the deployment's OWN authenticated
// Context (param-store.ts:759). One deployment therefore sees exactly one store,
// and one deployment serves exactly one tenant:
//   - ADR-018 "Interaction with structural per-deployment tenant isolation":
//     "One deployed stack == one tenant's workspace ... DEPLOYMENT_CONTEXT =
//     'default' remains a fixed deployment-wide constant, not a request-derived
//     identifier."
//   - ADR-020 Decision 1: "One deployed open-videocore instance is one tenant",
//     and #579/#580 "MUST NOT introduce a per-request tenant/workspace
//     dimension".
// So `<namespace>` can only ever hold ONE value inside any given store. It
// cannot discriminate between tenants, now or ever, and deriving it correctly
// would be machinery for a distinction that cannot exist.
//
// Many stacks in one store still do not collide: stacks are keyed by NAME in the
// last segment, which is already the discriminator. Collapsing the middle
// segment to this constant leaves stack separation intact.
export const STACK_CONFIG_NAMESPACE = "default";

// Shared prefix of every key this app writes to the config service. Both key
// shapes in the store start with it:
//   openvideocore/<namespace>/<stackName>          (stackConfigKey, param-store.ts:131-133)
//   openvideocore/storagebackends/<workspaceId>/<id> (storage-backend-registry.ts:321)
const OVC_KEY_PREFIX = 'openvideocore/';

// First key segments after OVC_KEY_PREFIX that are FIXED literals rather than a
// namespace, and must therefore never be mistaken for a stale one when scanning:
//   `_meta`           — reserved for this app's own metadata keys
//   `storagebackends` — the storage-backend registry's key space
//                       (backendRecordKey, storage-backend-registry.ts:321), whose
//                       workspace id is the SECOND segment, not the first.
const RESERVED_KEY_SEGMENTS = new Set(['_meta', 'storagebackends']);

// Narrow read view over the parameter store, used ONLY by the one-shot
// stale-namespace migration below. Structurally satisfied by ConfigKvStore
// (param-store.ts:602-608) over the same eyevinn-app-config-svc HTTP contract,
// so main.ts can pass the store it already builds with configKvStoreFromEnv.
// Kept to the single method the migration needs so a caller/test can supply a
// one-method stub.
//
// `listByPrefix` signature copied verbatim from ConfigKvStore.listByPrefix
// (param-store.ts:607 —
//   listByPrefix(prefix: string): Promise<Array<{ key: string; value: string }>>
// ), implemented against GET /api/v1/config?limit=N (param-store.ts).
//
// BOUNDED. That implementation fetches ONE page of at most
// CONFIG_LIST_PAGE_LIMIT entries — the service's schema maximum for `limit` —
// and filters client-side, so a scan through this seam is a subset of the key
// space, never a proof of absence. See the truncation check in
// scanStaleNamespacedStacks.
export type StackConfigKeyScanner = {
  listByPrefix(prefix: string): Promise<Array<{ key: string; value: string }>>;
};

// True when a parsed store value looks like a persisted StackConfig
// (param-store.ts:52-95: minioEndpoint / couchdbUrl / redisUrl are required
// strings; storeStackConfig persists JSON.stringify(stackConfig),
// param-store.ts:446). Used so an unrelated record that happens to sit under the
// shared `openvideocore/` prefix cannot be mistaken for a stack config.
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

// One stack config found under a NON-`default` namespace segment in this
// deployment's own store.
type StaleNamespacedStack = { namespace: string; stackName: string };

// ---------------------------------------------------------------------------
// ONE-SHOT MIGRATION — REMOVAL CONDITION
//
// Everything from here to the end of `migrateStaleNamespacedStack` exists ONLY
// to converge deployments that were provisioned BEFORE issue #804, when
// provision.ts wrote stack configs under a derived namespace while main.ts read
// them under the `default` constant.
//
// REMOVE THIS BLOCK (and its tests) once no deployment in the field still holds
// a stack config under a non-`default` namespace segment. Concretely, the
// condition is:
//
//   (a) every deployment running a pre-#804 build has been restarted at least
//       once on a post-#804 build with its parameter store reachable — one boot
//       is enough, because the migration rewrites under `default` and the stale
//       key is thereafter never read; AND
//   (b) a scan of the fleet's config-service instances for keys matching
//       `openvideocore/<ns>/<name>` with `ns !== 'default'` returns nothing.
//
// CAVEAT ON (b): criterion (b) is itself subject to list truncation. The config
// service caps `limit` at CONFIG_LIST_PAGE_LIMIT (param-store.ts) and this
// client fetches a single page, so "the scan returned nothing" is only
// authoritative for a store whose key count fits in one page.
// scanStaleNamespacedStacks warns when a page comes back full; treat (b) as
// UNSATISFIED for any store that logged that warning, and enumerate that store
// exhaustively (paginating with `offset`, or inspecting it directly) before
// counting it as clean. Do not remove this block on the strength of an empty
// scan that may have been cut off.
//
// This is BOUNDED by construction, not open-ended: ADR-018/ADR-020 fix one
// deployment to one tenant and one store, so each affected store contains
// exactly ONE stale namespace value — never an unbounded set. If a store somehow
// contains several, this code refuses to guess and reports a genuine miss.
//
// Do not "improve" this into a general cross-namespace resolver. Reading a
// namespace this deployment does not own is the isolation risk #712 closed, and
// a vague, unbounded migration bridge is how this class of bug survived three
// prior PRs (#712, #733/#751, #776/#777).
// ---------------------------------------------------------------------------

// Scan this deployment's OWN store for stack configs sitting under a namespace
// segment other than `default`.
//
// NOT cross-tenant probing: the instance is the deployment's own (resolved from
// PARAMETER_STORE_INSTANCE_NAME against its own authenticated Context,
// param-store.ts:747-765) and every key returned was written by this deployment.
// Nothing outside this store is consulted.
//
// Conservative by design. A key only counts when:
//   - it has the exact stack-config shape `openvideocore/<ns>/<name>` — exactly
//     two segments after the shared prefix, which also excludes the
//     four-segment storage-backend keys;
//   - `<ns>` is a non-empty, non-reserved literal other than `default`;
//   - its value parses as a StackConfig (looksLikeStackConfig).
//
// Returns [] on any failure: the migration is best-effort and a store blip must
// degrade to "genuine miss", never to a throw on the read path.
async function scanStaleNamespacedStacks(
  scanner: StackConfigKeyScanner,
  log: StackResolverLogger
): Promise<StaleNamespacedStack[]> {
  let entries: Array<{ key: string; value: string }>;
  try {
    entries = await scanner.listByPrefix(OVC_KEY_PREFIX);
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? { message: err.message } : String(err),
        prefix: OVC_KEY_PREFIX
      },
      'stale-namespace migration: could not list this deployment\'s config keys; treating as a genuine miss'
    );
    return [];
  }
  if (!Array.isArray(entries)) return [];

  // TRUNCATION CHECK (review follow-up on #804).
  //
  // listByPrefix reads ONE page of at most CONFIG_LIST_PAGE_LIMIT entries and
  // filters by prefix client-side (param-store.ts). The config service caps
  // `limit` at that value by schema and this client does not paginate, so a
  // store holding more keys than one page cannot be fully enumerated here.
  //
  // `entries` is already prefix-filtered, so its length is <= the page size.
  // That makes `length === CONFIG_LIST_PAGE_LIMIT` a SUFFICIENT but not
  // NECESSARY signal: reaching the cap proves the page was full (and therefore
  // that keys may have been cut off), while a shorter result does not prove the
  // page was short. The check is deliberately one-directional — it can
  // under-warn, but it never warns about a scan that was actually complete.
  //
  // Why this matters: every conclusion this migration draws from an EMPTY or
  // PARTIAL scan ("nothing stale to adopt") is only as authoritative as the
  // scan. Without this warning, a deployment whose stale key sits past the page
  // boundary would never converge and would look identical in the logs to one
  // with nothing to migrate. With it, a non-converging deployment is
  // diagnosable from logs alone.
  if (entries.length >= CONFIG_LIST_PAGE_LIMIT) {
    log.warn(
      {
        prefix: OVC_KEY_PREFIX,
        returned: entries.length,
        pageLimit: CONFIG_LIST_PAGE_LIMIT
      },
      'stale-namespace migration: config-key scan filled the config service\'s maximum page ' +
        'size, so it may be TRUNCATED and this migration result is NOT authoritative — a ' +
        'reported "nothing to migrate" may simply be a stale key past the page boundary. ' +
        'If a stack is still unresolvable, enumerate the store manually before concluding ' +
        'the migration is complete.'
    );
  }

  const found: StaleNamespacedStack[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string' || typeof entry.value !== 'string') {
      continue;
    }
    if (!entry.key.startsWith(OVC_KEY_PREFIX)) continue;
    const segments = entry.key.slice(OVC_KEY_PREFIX.length).split('/');
    if (segments.length !== 2) continue;
    const namespace = segments[0]!;
    const stackName = segments[1]!;
    if (namespace.length === 0 || stackName.length === 0) continue;
    if (namespace === STACK_CONFIG_NAMESPACE) continue;
    if (RESERVED_KEY_SEGMENTS.has(namespace)) continue;
    if (!looksLikeStackConfig(entry.value)) continue;
    found.push({ namespace, stackName });
  }
  return found;
}

// Adopt a pre-#804 stack config and rewrite it under `default`.
//
// Called only after a `default` read MISSED. Returns the adopted config, or
// undefined when there is nothing unambiguous to adopt.
//
// `stackName` narrows the scan to one stack name when the caller is looking for
// a specific stack; when omitted, any single stale stack qualifies (the
// "list the workspace's stacks" path).
//
// Refuses to guess. Zero matches, or MORE than one distinct stale namespace,
// both behave as a genuine miss — an ambiguous store is a history this code
// cannot disambiguate, and picking one would strand the other.
//
// The rewrite is best-effort: if the write throws we still serve the adopted
// config for this call and the next miss retries it.
async function migrateStaleNamespacedStack(
  ps: ParamStore,
  scanner: StackConfigKeyScanner | undefined,
  log: StackResolverLogger,
  stackName?: string
): Promise<{ name: string; config: StackConfig } | undefined> {
  if (!scanner) return undefined;
  const candidates = await scanStaleNamespacedStacks(scanner, log);
  const matching = stackName
    ? candidates.filter((c) => c.stackName === stackName)
    : candidates;
  if (matching.length === 0) return undefined;

  const namespaces = new Set(matching.map((c) => c.namespace));
  if (namespaces.size > 1) {
    log.warn(
      { namespaces: [...namespaces].sort(), stackName: stackName ?? '(any)' },
      'stale-namespace migration: this store holds stack configs under several non-default namespaces; refusing to guess which one to adopt'
    );
    return undefined;
  }
  const staleNamespace = matching[0]!.namespace;
  // With a single stale namespace, an unnamed scan may still see several stacks
  // in it. Adopt the first by name so the choice is order-independent, and let
  // subsequent calls migrate the rest.
  const names = [...new Set(matching.map((c) => c.stackName))].sort();
  const name = stackName ?? names[0]!;

  const config = await ps.loadStackConfig(staleNamespace, name);
  if (!config) return undefined;

  try {
    await ps.storeStackConfig(STACK_CONFIG_NAMESPACE, name, config);
    log.info(
      {
        op: 'migrateStackConfig',
        from: staleNamespace,
        to: STACK_CONFIG_NAMESPACE,
        name
      },
      'migrated a pre-#804 stack config from its stale namespace segment to the constant namespace'
    );
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? { message: err.message } : String(err),
        from: staleNamespace,
        to: STACK_CONFIG_NAMESPACE,
        name
      },
      'adopted a pre-#804 stack config but the rewrite under the constant namespace failed; will retry on the next miss'
    );
  }
  return { name, config };
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
  // Key scanner backing the one-shot pre-#804 stale-namespace migration.
  // Optional: without it a `default` miss is simply a miss, which is the correct
  // behaviour for every deployment provisioned after #804.
  private staleNamespaceScanner: StackConfigKeyScanner | undefined;
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
    // Key scanner over this deployment's OWN config-service instance, used ONLY
    // by the bounded one-shot migration of pre-#804 stack configs written under
    // a derived namespace segment (see the REMOVAL CONDITION block above).
    // Optional: omit it and a `default` miss stays a plain miss.
    staleNamespaceScanner?: StackConfigKeyScanner;
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
    this.staleNamespaceScanner = opts.staleNamespaceScanner;
    this.log = opts.log ?? noopLogger;
  }

  // Read a stack config under the CONSTANT namespace (issue #804), with a
  // bounded one-shot fallback that adopts a pre-#804 config still sitting under
  // a derived namespace segment and rewrites it under the constant.
  //
  // Order:
  //   1. `loadStackConfig(STACK_CONFIG_NAMESPACE, name)`. A hit returns
  //      immediately — every stack provisioned on a post-#804 build takes NO
  //      fallback read at all.
  //   2. On a miss, the one-shot migration: scan THIS deployment's own store for
  //      a config for `name` under a single non-`default` namespace, adopt it,
  //      and rewrite it under the constant. Zero matches, or more than one stale
  //      namespace, behave as a genuine miss — see the REMOVAL CONDITION block.
  private async loadStackConfigWithMigration(
    ps: ParamStore,
    name: string
  ): Promise<StackConfig | undefined> {
    const direct = await ps.loadStackConfig(STACK_CONFIG_NAMESPACE, name);
    if (direct) return direct;
    const migrated = await migrateStaleNamespacedStack(
      ps,
      this.staleNamespaceScanner,
      this.log,
      name
    );
    return migrated?.config;
  }

  // List stack names under the CONSTANT namespace, with the same bounded
  // one-shot fallback (issue #804). Without this, a pre-#804 stack stays
  // invisible to the resolver's "first listed stack" path. The subsequent
  // per-name load goes through loadStackConfigWithMigration, which is what
  // performs the rewrite.
  private async listStackNamesWithMigration(ps: ParamStore): Promise<string[]> {
    const direct = await ps.listStackNames(STACK_CONFIG_NAMESPACE);
    if (direct.length > 0) return direct;
    const migrated = await migrateStaleNamespacedStack(
      ps,
      this.staleNamespaceScanner,
      this.log
    );
    return migrated ? [migrated.name] : direct;
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
    const envConnections = buildEnvConnections(this.oscContext, this.log);
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

    // The parameter-store namespace is the CONSTANT both sides use (issue #804).
    // The provision route WRITES under STACK_CONFIG_NAMESPACE and this resolver
    // READS under it, so the two keys are identical by construction rather than
    // by two derivations agreeing. Bound to a local only so the diagnostic log
    // lines below keep reporting the namespace they read with (issue #415).
    const namespace = STACK_CONFIG_NAMESPACE;

    // Resolve the stack config: an explicit stack name addresses that stack
    // directly; otherwise use the first provisioned stack as the workspace
    // default.
    let config: StackConfig | undefined;
    // The name the config was actually loaded under (issue #1058). Carried onto
    // the built connections so the data plane's stack identity is observable
    // and comparable with the control plane's (resolveStackName).
    let resolvedName: string | undefined;
    try {
      if (stackName) {
        // READ-PATH diagnostic (issue #415): the resolver reads by the
        // X-Stack-Name-derived name under the constant namespace. This is the
        // (namespace, name) pair whose key must equal the key the provision
        // route wrote; the param-store client logs the concrete key.
        this.log?.info?.(
          { source: 'x-stack-name', namespace, stackName },
          'resolver reading stack config by requested name'
        );
        config = await this.loadStackConfigWithMigration(ps, stackName);
        if (config) resolvedName = stackName;
        // If the requested stack name isn't found, fall back to the default
        // (first provisioned) stack rather than degrading to in-memory
        // connections. This prevents stale UI stack selections from breaking
        // all storage/asset operations.
        if (!config) {
          const names = await this.listStackNamesWithMigration(ps);
          this.log?.info?.(
            { namespace, requested: stackName, listed: names },
            'requested stack not found; falling back to first listed stack'
          );
          if (names.length > 0) {
            config = await this.loadStackConfigWithMigration(ps, names[0]!);
            if (config) resolvedName = names[0]!;
          }
        }
      } else {
        // READ-PATH diagnostic (issue #415): no X-Stack-Name header, so the
        // resolver uses the FIRST listed stack as the default. If the list is
        // empty here but the provision route logged a successful write, the
        // write key and the list prefix disagree — a read-side namespace/key bug.
        const names = await this.listStackNamesWithMigration(ps);
        this.log?.info?.(
          { source: 'default', namespace, listed: names },
          'resolver reading default stack config (no X-Stack-Name)'
        );
        if (names.length > 0) {
          config = await this.loadStackConfigWithMigration(ps, names[0]!);
          if (config) resolvedName = names[0]!;
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
        ? buildConnectionsFromStack(config, this.minioPassword, this.couchPassword, this.oscContext, this.optionalSteps, resolvedName, this.log)
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
    // Same CONSTANT namespace the provision route writes under (issue #804), so
    // this read key equals the write key by construction. Bound to a local only
    // so the error log below keeps reporting the namespace it read with.
    const namespace = STACK_CONFIG_NAMESPACE;
    try {
      if (requestedStackName) {
        const config = await this.loadStackConfigWithMigration(
          ps,
          requestedStackName
        );
        // A requested name that resolves to a real config wins verbatim; the
        // request routes to exactly the stack it named regardless of provision
        // order. The legacy fallback also covers a pre-#712 stack whose config
        // exists only under `default` (issue #733) — after migrate-on-read it is
        // a direct hit next time. Only when the requested name has NO stored
        // config (even under a stale pre-#804 namespace) do we fall through to the
        // workspace default (a stale UI selection must not break routing),
        // matching resolve()'s fallback semantics.
        if (config) return requestedStackName;
      }
      const names = await this.listStackNamesWithMigration(ps);
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
  // Resolution is IDENTICAL to resolveStackName() above — the same constant
  // namespace and the same one-shot migration helpers
  // (loadStackConfigWithMigration / listStackNamesWithMigration, issue #804) —
  // so the two paths cannot drift apart again: an explicit
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
    if (stackName) {
      const requested = await this.loadStackConfigWithMigration(ps, stackName);
      // A requested name that has a stored config wins verbatim; only a name
      // with no config at all falls through to the workspace default, matching
      // resolve()/resolveStackName() semantics.
      if (requested) return requested;
    }
    const names = await this.listStackNamesWithMigration(ps);
    if (names.length === 0) return undefined;
    return this.loadStackConfigWithMigration(ps, names[0]!);
  }

  // The provisioned stack names, in parameter-store listing order (issue #1058).
  //
  // Exposes the SAME listing the resolution paths use — including the bounded
  // one-shot migration fallback for a pre-#804 stack — so a caller that must run
  // once per stack (the scaler-tick reconcilers, the stack-less packager
  // callbacks) enumerates exactly the stacks `resolve()` can address. Empty when
  // no parameter store is configured (env-override / bare local run), in which
  // case callers fall back to the single default resolution.
  //
  // A read failure is logged and reported as "no stacks" rather than thrown: the
  // callers are best-effort sweeps and unauthenticated callbacks, and a
  // parameter-store blip must not break a tick or fail a callback.
  async listStackNames(): Promise<string[]> {
    const ps = this.paramStore;
    if (!ps) return [];
    try {
      return await this.listStackNamesWithMigration(ps);
    } catch (err) {
      this.log.error(
        {
          err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
          namespace: STACK_CONFIG_NAMESPACE
        },
        'stack resolver: failed to list stack names'
      );
      return [];
    }
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
  // There is no namespace memo to clear (issue #804): the namespace is a
  // compile-time constant, so there is nothing that could go stale.
  invalidate(): void {
    this.cache.clear();
  }
}
