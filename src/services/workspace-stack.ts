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
import { isReadyStack, type ParamStore, type StackConfig } from './param-store.js';
import { couchServer, StackCouch } from '../data/couchdb.js';
import { WorkspaceStorage } from '../data/storage.js';
import { CouchAssetRepository } from '../data/couch-asset-repo.js';
import { CouchJobRepository } from '../data/couch-job-repo.js';
import { CouchSearchRepository } from '../data/couch-search-repo.js';
import { CouchWebhookRepository } from '../data/couch-webhook-repo.js';
import { CouchCollectionRepository } from '../data/couch-collection-repo.js';
import { CouchProfileRepository } from '../data/couch-profile-repo.js';
import { CouchPipelineRepository } from '../data/couch-pipeline-repo.js';
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
import type { ProfileRepository } from '../data/profile-repo.js';
import type { StorageFactory } from '../routes/asset-upload.js';
import { makeHttpEncoreClient, type EncoreClient } from '../pipeline/encore-client.js';
import type { SubtitleGenerator } from '../pipeline/subtitle-generator.js';
import type { SceneDetector } from '../pipeline/scene-detector.js';
import type { Context } from '@osaas/client-core';

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

export type WorkspaceConnections = {
  assets: AssetRepository;
  jobs: JobRepository;
  search: SearchRepository;
  webhooks: WebhookRepository;
  collections: CollectionRepository;
  profiles: ProfileRepository;
  pipelines: PipelineRepository;
  storageFor: StorageFactory | undefined;
  storageClient: MinioClient | undefined;
  encore: EncoreClient | undefined;
  sourceBucket: string;
  packagedBucket: string;
  s3Config: { endpoint: string; accessKey: string; secretKey: string } | undefined;
  // OPTIONAL, opt-in pipeline-step generators activated from the stack record
  // (issue #217), not boot-time env vars. Present only when the ACTIVE stack's
  // StackConfig carries the instance name AND a builder was supplied (object
  // storage available). Absent (undefined) => the OPTIONAL `subtitles` /
  // `scene-detect` step skips gracefully — fire-and-forget, never throws.
  subtitleGenerator: SubtitleGenerator | undefined;
  sceneDetector: SceneDetector | undefined;
};

type CacheEntry = { connections: WorkspaceConnections; expiresAt: number };

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
    /^(https?:\/\/)/, `$1admin:${couchPassword}@`
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
  const search = new CouchSearchRepository(wc);
  const webhooks = new CouchWebhookRepository(wc);
  const collections = new CouchCollectionRepository(wc);
  const profiles = new CouchProfileRepository(wc);
  const pipelines = new CouchPipelineRepository(wc);

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
    profiles,
    pipelines,
    storageFor,
    storageClient: minioClient,
    encore,
    sourceBucket: config.sourceBucket,
    packagedBucket: config.packagedBucket,
    s3Config: { endpoint: config.minioEndpoint, accessKey: 'admin', secretKey: minioPassword },
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
  let profiles: ProfileRepository;
  let pipelines: PipelineRepository;

  if (couchUrl) {
    const dbName = process.env['COUCHDB_ASSETS_DB'] ?? 'assets';
    const server = couchServer(couchUrl);
    const wc = () => new StackCouch(server, dbName);
    assets = new CouchAssetRepository(wc);
    jobs = new CouchJobRepository(wc);
    search = new CouchSearchRepository(wc);
    webhooks = new CouchWebhookRepository(wc);
    collections = new CouchCollectionRepository(wc);
    profiles = new CouchProfileRepository(wc);
    pipelines = new CouchPipelineRepository(wc);
  } else {
    const mem = new InMemoryAssetRepository();
    assets = mem;
    jobs = new InMemoryJobRepository();
    search = new InMemorySearchRepository(mem);
    webhooks = new InMemoryWebhookRepository();
    collections = new InMemoryCollectionRepository();
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
    assets, jobs, search, webhooks, collections, profiles, pipelines,
    storageFor, storageClient, encore,
    sourceBucket, packagedBucket,
    s3Config: minioUrl ? { endpoint: minioUrl, accessKey: process.env['MINIO_ACCESS_KEY'] ?? 'admin', secretKey: process.env['MINIO_SECRET_KEY'] ?? process.env['MINIO_ROOT_PASSWORD'] ?? '' } : undefined,
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
  const search = new InMemorySearchRepository(assets);
  const webhooks = new InMemoryWebhookRepository();
  const collections = new InMemoryCollectionRepository();
  const profiles = new InMemoryProfileRepository();
  const pipelines = new InMemoryPipelineRepository();
  return {
    assets, jobs, search, webhooks, collections, profiles, pipelines,
    storageFor: undefined, storageClient: undefined,
    encore: undefined,
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    s3Config: undefined,
    subtitleGenerator: undefined,
    sceneDetector: undefined
  };
}

export const STACK_CONFIG_NAMESPACE = "default";

export class WorkspaceStackResolver {
  private cache = new Map<string, CacheEntry>();
  private paramStore: ParamStore | undefined;
  private oscContext: Context;
  private minioPassword: string;
  private couchPassword: string;
  private optionalSteps: OptionalStepBuilders;

  constructor(opts: {
    paramStore: ParamStore | undefined;
    oscContext: Context;
    minioPassword: string;
    couchPassword: string;
    // Builders that activate the OPTIONAL subtitles/scene-detect steps from the
    // stack record (issue #217). Optional so callers/tests that don't wire the
    // optional services get the graceful-skip behaviour (steps disabled).
    optionalSteps?: OptionalStepBuilders;
  }) {
    this.paramStore = opts.paramStore;
    this.oscContext = opts.oscContext;
    this.minioPassword = opts.minioPassword;
    this.couchPassword = opts.couchPassword;
    this.optionalSteps = opts.optionalSteps ?? {};
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
      this.cache.set(cacheKey, { connections: envConnections, expiresAt: Date.now() + CACHE_TTL_MS });
      return envConnections;
    }

    const ps = this.paramStore;
    if (!ps) return buildInMemoryConnections();

    // Resolve the stack config: an explicit stack name addresses that stack
    // directly; otherwise use the first provisioned stack as the workspace
    // default.
    let config: StackConfig | undefined;
    try {
      if (stackName) {
        config = await ps.loadStackConfig(STACK_CONFIG_NAMESPACE, stackName);
        // If the requested stack name isn't found, fall back to the default
        // (first provisioned) stack rather than degrading to in-memory
        // connections. This prevents stale UI stack selections from breaking
        // all storage/asset operations.
        if (!config) {
          const names = await ps.listStackNames(STACK_CONFIG_NAMESPACE);
          if (names.length > 0) {
            config = await ps.loadStackConfig(STACK_CONFIG_NAMESPACE, names[0]);
          }
        }
      } else {
        const names = await ps.listStackNames(STACK_CONFIG_NAMESPACE);
        if (names.length > 0) {
          config = await ps.loadStackConfig(STACK_CONFIG_NAMESPACE, names[0]);
        }
      }
    } catch {
      // Fall through to in-memory
    }

    // A partially-provisioned/failed stack must never be treated as a live,
    // connectable stack (issue #106): only 'ready' (or legacy status-less)
    // configs are connected. Non-ready configs still exist in the store so the
    // deprovision route can read services[] and clean up, but the resolver skips
    // them here. buildConnectionsFromStack also returns null for empty/invalid
    // coordinates (issue #105 defence-in-depth). In every skip case we fall back
    // to no-op in-memory connections so /health and infra routes stay up.
    const connections =
      (config && isReadyStack(config)
        ? buildConnectionsFromStack(config, this.minioPassword, this.couchPassword, this.oscContext, this.optionalSteps)
        : null) ?? buildInMemoryConnections();

    this.cache.set(cacheKey, { connections, expiresAt: Date.now() + CACHE_TTL_MS });
    return connections;
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
  invalidate(): void {
    this.cache.clear();
  }
}
