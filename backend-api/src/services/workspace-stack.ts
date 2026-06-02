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
import type { ParamStore, StackConfig } from './param-store.js';
import { couchServer, WorkspaceCouch } from '../data/couchdb.js';
import { WorkspaceStorage } from '../data/storage.js';
import { CouchAssetRepository } from '../data/couch-asset-repo.js';
import { CouchJobRepository } from '../data/couch-job-repo.js';
import { CouchSearchRepository } from '../data/couch-search-repo.js';
import { CouchWebhookRepository } from '../data/couch-webhook-repo.js';
import { CouchCollectionRepository } from '../data/couch-collection-repo.js';
import { InMemoryAssetRepository, type AssetRepository } from '../data/asset-repo.js';
import { InMemoryJobRepository, type JobRepository } from '../data/job-repo.js';
import { InMemorySearchRepository } from '../data/inmemory-search-repo.js';
import { InMemoryWebhookRepository } from '../data/inmemory-webhook-repo.js';
import { InMemoryCollectionRepository } from '../data/inmemory-collection-repo.js';
import type { SearchRepository } from '../data/search-repo.js';
import type { WebhookRepository } from '../data/webhook-repo.js';
import type { CollectionRepository } from '../data/collection-repo.js';
import type { StorageFactory } from '../routes/asset-upload.js';
import { makeHttpEncoreClient, type EncoreClient } from '../pipeline/encore-client.js';
import type { Context } from '@osaas/client-core';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

export type WorkspaceConnections = {
  assets: AssetRepository;
  jobs: JobRepository;
  search: SearchRepository;
  webhooks: WebhookRepository;
  collections: CollectionRepository;
  storageFor: StorageFactory | undefined;
  storageClient: MinioClient | undefined;
  encore: EncoreClient | undefined;
  encoreCallbackUrl: string | undefined;
  sourceBucket: string;
  packagedBucket: string;
  s3Config: { endpoint: string; accessKey: string; secretKey: string } | undefined;
};

type CacheEntry = { connections: WorkspaceConnections; expiresAt: number };

function buildConnectionsFromStack(
  config: StackConfig,
  workspaceId: string,
  minioPassword: string,
  couchPassword: string,
  oscContext: Context
): WorkspaceConnections {
  const dbName = process.env['COUCHDB_ASSETS_DB'] ?? 'assets';
  const couchUrl = config.couchdbUrl.replace(/\/$/, '').replace(
    /^(https?:\/\/)/, `$1admin:${couchPassword}@`
  );
  const server = couchServer(couchUrl);
  const wc = (wid: string) => new WorkspaceCouch(wid, server, dbName);

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

  const storageFor: StorageFactory = (wid: string) =>
    new WorkspaceStorage(wid, minioClient, config.sourceBucket);

  const encore = config.encoreUrl
    ? makeHttpEncoreClient({
        baseUrl: config.encoreUrl,
        getToken: () => oscContext.getServiceAccessToken('encore')
      })
    : undefined;

  return {
    assets,
    jobs,
    search,
    webhooks,
    collections,
    storageFor,
    storageClient: minioClient,
    encore,
    encoreCallbackUrl: config.encoreCallbackUrl || undefined,
    sourceBucket: config.sourceBucket,
    packagedBucket: config.packagedBucket,
    s3Config: { endpoint: config.minioEndpoint, accessKey: 'admin', secretKey: minioPassword }
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

  if (couchUrl) {
    const dbName = process.env['COUCHDB_ASSETS_DB'] ?? 'assets';
    const server = couchServer(couchUrl);
    const wc = (wid: string) => new WorkspaceCouch(wid, server, dbName);
    assets = new CouchAssetRepository(wc);
    jobs = new CouchJobRepository(wc);
    search = new CouchSearchRepository(wc);
    webhooks = new CouchWebhookRepository(wc);
    collections = new CouchCollectionRepository(wc);
  } else {
    const mem = new InMemoryAssetRepository();
    assets = mem;
    jobs = new InMemoryJobRepository();
    search = new InMemorySearchRepository(mem);
    webhooks = new InMemoryWebhookRepository();
    collections = new InMemoryCollectionRepository();
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
    storageFor = (wid: string) => new WorkspaceStorage(wid, client, sourceBucket);
  }

  const encoreUrl = process.env['ENCORE_URL'];
  const encore = encoreUrl
    ? makeHttpEncoreClient({
        baseUrl: encoreUrl,
        getToken: () => oscContext.getServiceAccessToken('encore')
      })
    : undefined;

  return {
    assets, jobs, search, webhooks, collections,
    storageFor, storageClient, encore,
    encoreCallbackUrl: undefined,
    sourceBucket, packagedBucket,
    s3Config: minioUrl ? { endpoint: minioUrl, accessKey: process.env['MINIO_ACCESS_KEY'] ?? 'admin', secretKey: process.env['MINIO_SECRET_KEY'] ?? process.env['MINIO_ROOT_PASSWORD'] ?? '' } : undefined
  };
}

function buildInMemoryConnections(): WorkspaceConnections {
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const search = new InMemorySearchRepository(assets);
  const webhooks = new InMemoryWebhookRepository();
  const collections = new InMemoryCollectionRepository();
  return {
    assets, jobs, search, webhooks, collections,
    storageFor: undefined, storageClient: undefined,
    encore: undefined,
    encoreCallbackUrl: undefined,
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    s3Config: undefined
  };
}

export class WorkspaceStackResolver {
  private cache = new Map<string, CacheEntry>();
  private paramStore: ParamStore | undefined;
  private oscContext: Context;
  private minioPassword: string;
  private couchPassword: string;

  constructor(opts: {
    paramStore: ParamStore | undefined;
    oscContext: Context;
    minioPassword: string;
    couchPassword: string;
  }) {
    this.paramStore = opts.paramStore;
    this.oscContext = opts.oscContext;
    this.minioPassword = opts.minioPassword;
    this.couchPassword = opts.couchPassword;
  }

  // Resolve the backing-service connections for a workspace. When `stackName`
  // is given (from the X-Stack-Name request header) the named stack is used
  // instead of the workspace's default (first provisioned) stack — letting a
  // client switch between multiple provisioned stacks. The explicit env-var
  // override, when active, wins regardless of stackName.
  async resolve(workspaceId: string, stackName?: string): Promise<WorkspaceConnections> {
    const cacheKey = stackName ? `${workspaceId} ${stackName}` : workspaceId;
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
        config = await ps.loadStackConfig(workspaceId, stackName);
      } else {
        const names = await ps.listStackNames(workspaceId);
        if (names.length > 0) {
          config = await ps.loadStackConfig(workspaceId, names[0]);
        }
      }
    } catch {
      // Fall through to in-memory
    }

    const connections = config
      ? buildConnectionsFromStack(config, workspaceId, this.minioPassword, this.couchPassword, this.oscContext)
      : buildInMemoryConnections();

    this.cache.set(cacheKey, { connections, expiresAt: Date.now() + CACHE_TTL_MS });
    return connections;
  }

  // Synchronous read of already-resolved connections from cache. Returns
  // undefined when nothing is cached (or the entry expired). The global
  // preHandler hook warms the cache with `resolve()` before any handler runs,
  // so a handler-time synchronous factory (e.g. the sync StorageFactory the
  // asset routers expect) can read the connections without re-awaiting.
  resolveCached(workspaceId: string, stackName?: string): WorkspaceConnections | undefined {
    const cacheKey = stackName ? `${workspaceId} ${stackName}` : workspaceId;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.connections;
    return undefined;
  }

  // Invalidate all cached connections for a workspace (default + every named
  // stack), so a freshly provisioned/torn-down stack is picked up immediately.
  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
    const prefix = `${workspaceId} `;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }
}
