import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { Context, createInstance, getInstance } from '@osaas/client-core';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';
import { provisionRouter } from './routes/provision.js';
import { ensureParameterStore, paramStoreFromEnv } from './services/param-store.js';import { registerAuth } from './auth/middleware.js';
import { assetsRouter } from './routes/assets.js';
import { assetUploadRouter, type StorageFactory } from './routes/asset-upload.js';
import { jobsRouter } from './routes/jobs.js';
import { couchServer, WorkspaceCouch } from './data/couchdb.js';
import { CouchAssetRepository } from './data/couch-asset-repo.js';
import { CouchJobRepository } from './data/couch-job-repo.js';
import { CouchSearchRepository } from './data/couch-search-repo.js';
import { InMemorySearchRepository } from './data/inmemory-search-repo.js';
import type { SearchRepository } from './data/search-repo.js';
import { searchRouter } from './routes/search.js';
import { CouchWebhookRepository } from './data/couch-webhook-repo.js';
import { InMemoryWebhookRepository } from './data/inmemory-webhook-repo.js';
import type { WebhookRepository } from './data/webhook-repo.js';
import { WebhookDispatcher } from './services/webhook-dispatcher.js';
import { webhooksRouter } from './routes/webhooks.js';
import { CouchCollectionRepository } from './data/couch-collection-repo.js';
import { InMemoryCollectionRepository } from './data/inmemory-collection-repo.js';
import type { CollectionRepository } from './data/collection-repo.js';
import { collectionsRouter } from './routes/collections.js';
import { InMemoryAssetRepository, type AssetRepository } from './data/asset-repo.js';
import { InMemoryJobRepository, type JobRepository } from './data/job-repo.js';
import { WorkspaceStorage } from './data/storage.js';
import { makeS3Reader } from './pipeline/source.js';
import { makeOscProbeRunner } from './pipeline/osc-ffprobe.js';
import { extractTechnicalMetadata, type ProbeRunner } from './pipeline/metadata-extractor.js';
import { makeOscThumbnailExtractor } from './pipeline/osc-thumbnail.js';
import type { FrameExtractor } from './pipeline/thumbnail.js';
import { makeOscRewrapRunner } from './pipeline/osc-rewrap.js';
import type { RewrapRunner } from './pipeline/rewrap.js';
import { makeOscClipRunner } from './pipeline/osc-clip.js';
import type { ClipRunner } from './pipeline/clip.js';
import { internalRouter } from './routes/internal.js';
import { adminRouter } from './routes/admin.js';
import { WatchFolderService, watchFolderEnabled } from './pipeline/watch-folder.js';
import { PackagingService, packagingPublicBaseUrl } from './pipeline/packaging.js';
import { makeOscPackagerQueue } from './pipeline/osc-packager-queue.js';
import { makeHttpEncoreClient, type EncoreClient } from './pipeline/encore-client.js';
import { Redis as IORedis } from 'ioredis';
import {
  createJob,
  getLogsForInstance,
  removeJob,
  waitForJobToComplete
} from '@osaas/client-core';
import { Client as MinioClient } from 'minio';

const app = Fastify({ logger: true });

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

await app.register(cors);
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: null
    }
  }
});

// OSC context — reads OSC_ACCESS_TOKEN from environment.
// On OSC this is injected at runtime; locally set it in .env.
const oscContext = new Context();

// Auth: decorate request.workspaceId and register the `authenticate`
// preHandler. Workspace-scoped routers attach it via { onRequest: app.authenticate }.
registerAuth(app);

// Health endpoints are intentionally unauthenticated for liveness probing.
app.get('/health', async () => ({ status: 'ok', service: 'open-videocore-api' }));
app.get('/healthz', async () => ({ status: 'ok' }));

// OSC parameter store (issue #31, ADR-002). Persists provisioned stack
// coordinates so the API can rediscover a named stack at runtime. Configured
// via PARAMETER_STORE_URL + PARAMETER_STORE_API_KEY; when unset the provision
// route still works but skips persistence and GET /:name responds 501.
const paramStore = paramStoreFromEnv(
  () => oscContext.getServiceAccessToken('eyevinn-app-config-svc')
);
if (!paramStore) {
  app.log.warn(
    'PARAMETER_STORE_URL/API_KEY not set — provisioned stack coordinates will not be persisted'
  );
} else {
  await ensureParameterStore({
    osc: {
      getServiceAccessToken: (serviceId) => oscContext.getServiceAccessToken(serviceId),
      getInstance: (serviceId, name, sat) => getInstance(oscContext, serviceId, name, sat),
      createInstance: (serviceId, sat, body) => createInstance(oscContext, serviceId, sat, body)
    },
    log: app.log
  });
}

await app.register(provisionRouter, {
  prefix: '/api/v1/provision',
  osc: oscContext,
  paramStore
});

// Asset persistence. In a live OSC deployment assets are stored in CouchDB
// (partitioned by workspace, issue #20 + #3). Connection details come from the
// environment per 12-factor. If COUCHDB_URL is unset (e.g. a bare local run)
// we fall back to the in-memory repository so the API still boots.
function buildAssetRepository(): AssetRepository {
  const couchUrl = process.env['COUCHDB_URL'];
  if (!couchUrl) {
    app.log.warn('COUCHDB_URL not set — using in-memory asset repository (non-durable)');
    return new InMemoryAssetRepository();
  }
  const dbName = process.env['COUCHDB_ASSETS_DB'] ?? 'assets';
  const server = couchServer(couchUrl);
  return new CouchAssetRepository((workspaceId) => new WorkspaceCouch(workspaceId, server, dbName));
}

// Object storage factory for direct client-side uploads (issue #4). MinIO
// connection details come from the environment per 12-factor. When MINIO_URL
// is unset the upload routes are not registered, so the rest of the API still
// boots in a bare local run.
function buildStorage(): { storageFor: StorageFactory; client: MinioClient } | undefined {
  const minioUrl = process.env['MINIO_URL'];
  const accessKey = process.env['MINIO_ACCESS_KEY'];
  const secretKey = process.env['MINIO_SECRET_KEY'];
  if (!minioUrl || !accessKey || !secretKey) {
    app.log.warn('MINIO_URL/credentials not set — upload + URL-pull routes disabled');
    return undefined;
  }
  const url = new URL(minioUrl);
  const useSSL = url.protocol === 'https:';
  const client = new MinioClient({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : useSSL ? 443 : 80,
    useSSL,
    accessKey,
    secretKey
  });
  const bucket = process.env['MINIO_SOURCE_BUCKET'] ?? 'openvideocore-source';
  return { storageFor: (workspaceId: string) => new WorkspaceStorage(workspaceId, client, bucket), client };
}

// Ingest job persistence (issue #5). CouchDB-backed when configured, otherwise
// in-memory so the API still boots in a bare local run.
function buildJobRepository(): JobRepository {
  const couchUrl = process.env['COUCHDB_URL'];
  if (!couchUrl) {
    app.log.warn('COUCHDB_URL not set — using in-memory job repository (non-durable)');
    return new InMemoryJobRepository();
  }
  const dbName = process.env['COUCHDB_JOBS_DB'] ?? process.env['COUCHDB_ASSETS_DB'] ?? 'assets';
  const server = couchServer(couchUrl);
  return new CouchJobRepository((workspaceId) => new WorkspaceCouch(workspaceId, server, dbName));
}

// Full-text + metadata search (issue #10). CouchDB-backed (Mango /_find,
// partitioned per workspace) when configured; otherwise filters the in-memory
// asset repository so search still works in a bare local run. Free-text degrades
// to substring matching when no CouchDB text index is available.
function buildSearchRepository(assets: AssetRepository): SearchRepository {
  const couchUrl = process.env['COUCHDB_URL'];
  if (!couchUrl) {
    app.log.warn('COUCHDB_URL not set — using in-memory search repository');
    return new InMemorySearchRepository(assets);
  }
  const dbName = process.env['COUCHDB_ASSETS_DB'] ?? 'assets';
  const server = couchServer(couchUrl);
  return new CouchSearchRepository((workspaceId) => new WorkspaceCouch(workspaceId, server, dbName));
}

// Webhook registration persistence (issue #13). CouchDB-backed when configured,
// otherwise in-memory so the API still boots in a bare local run. Registrations
// share the same workspace partition + ownership guards as assets and jobs.
function buildWebhookRepository(): WebhookRepository {
  const couchUrl = process.env['COUCHDB_URL'];
  if (!couchUrl) {
    app.log.warn('COUCHDB_URL not set — using in-memory webhook repository (non-durable)');
    return new InMemoryWebhookRepository();
  }
  const dbName = process.env['COUCHDB_WEBHOOKS_DB'] ?? process.env['COUCHDB_ASSETS_DB'] ?? 'assets';
  const server = couchServer(couchUrl);
  return new CouchWebhookRepository((workspaceId) => new WorkspaceCouch(workspaceId, server, dbName));
}

// Collection persistence (issue #11). CouchDB-backed when configured, otherwise
// in-memory so the API still boots in a bare local run. Collections share the
// same workspace partition + ownership guards as assets and webhooks.
function buildCollectionRepository(): CollectionRepository {
  const couchUrl = process.env['COUCHDB_URL'];
  if (!couchUrl) {
    app.log.warn('COUCHDB_URL not set — using in-memory collection repository (non-durable)');
    return new InMemoryCollectionRepository();
  }
  const dbName = process.env['COUCHDB_COLLECTIONS_DB'] ?? process.env['COUCHDB_ASSETS_DB'] ?? 'assets';
  const server = couchServer(couchUrl);
  return new CouchCollectionRepository((workspaceId) => new WorkspaceCouch(workspaceId, server, dbName));
}

// Workspace-scoped resource routers. All resources are namespaced by the
// workspaceId derived from the caller's OSC token (issue #20).
const assetRepository = buildAssetRepository();
const jobRepository = buildJobRepository();
const searchRepository = buildSearchRepository(assetRepository);
const webhookRepository = buildWebhookRepository();
const collectionRepository = buildCollectionRepository();
const storage = buildStorage();

// Webhook event dispatcher (issue #13). Fired from the internal OSC callbacks
// when assets/jobs reach a terminal state so integrators are notified without
// polling. Delivery is best-effort and fire-and-forget; failures are logged.
const webhookDispatcher = new WebhookDispatcher({
  repository: webhookRepository,
  log: app.log
});

// Technical metadata extraction (issue #6) runs on the OSC eyevinn-ffmpeg-s3
// ephemeral ffprobe job. It needs both an OSC context (to dispatch the job) and
// object storage (to mint the presigned source URL). When either is missing the
// probe runner is undefined and extraction is disabled (routes respond 501).
const probe: ProbeRunner | undefined = storage
  ? makeOscProbeRunner({
      context: oscContext,
      createJob,
      waitForJobToComplete,
      getLogsForInstance,
      removeJob
    })
  : undefined;

// Thumbnail / poster-frame extraction (issue #7) reuses the OSC
// eyevinn-ffmpeg-s3 ephemeral job to seek + emit JPEG frames, writing each back
// to MinIO via a presigned PUT URL. Like the probe runner it needs both an OSC
// context and object storage; when either is missing the thumbnail routes
// respond 501.
const thumbnailExtractor: FrameExtractor | undefined = storage
  ? makeOscThumbnailExtractor({
      context: oscContext,
      createJob,
      waitForJobToComplete,
      getLogsForInstance,
      removeJob
    })
  : undefined;

// Export / re-wrap (issue #19) reuses the OSC eyevinn-ffmpeg-s3 ephemeral job to
// remux a stored object into a different container with `-c copy` (no
// re-encode), writing the new child asset back to MinIO via a presigned PUT
// URL. Like the thumbnail runner it needs both an OSC context and object
// storage; when either is missing POST /:id/export responds 501.
const rewrapRunner: RewrapRunner | undefined = storage
  ? makeOscRewrapRunner({
      context: oscContext,
      createJob,
      waitForJobToComplete,
      getLogsForInstance,
      removeJob
    })
  : undefined;

const clipRunner: ClipRunner | undefined = storage
  ? makeOscClipRunner({
      context: oscContext,
      createJob,
      waitForJobToComplete,
      getLogsForInstance,
      removeJob
    })
  : undefined;

// ABR transcoding (issue #8). Encore is a long-lived OSC instance; we submit
// jobs to its REST API and receive completion via the encore-callback listener.
// Enabled only when ENCORE_URL is set; otherwise POST /:id/transcode responds
// 501. The service access token for Encore is resolved per-submit from the OSC
// context.
function buildEncore(): EncoreClient | undefined {
  const baseUrl = process.env['ENCORE_URL'];
  if (!baseUrl) {
    app.log.warn('ENCORE_URL not set — ABR transcoding disabled');
    return undefined;
  }
  return makeHttpEncoreClient({
    baseUrl,
    getToken: () => oscContext.getServiceAccessToken('encore')
  });
}

const encore = buildEncore();
const sourceBucket = process.env['MINIO_SOURCE_BUCKET'] ?? 'openvideocore-source';
const outputBucket = process.env['MINIO_PACKAGED_BUCKET'] ?? 'openvideocore-packaged';

// Assets router also owns POST /ingest-url (issue #5) and POST /:id/transcode
// (issue #8). It shares the same job repository instance as the jobs router so a
// job created here is readable there. S3 sources are read via the same MinIO
// client (S3-compatible).
await app.register(assetsRouter, {
  prefix: '/api/v1/assets',
  repository: assetRepository,
  jobRepository,
  storageFor: storage?.storageFor,
  pullDeps: storage ? { openS3: makeS3Reader(storage.client) } : undefined,
  probe,
  encore,
  sourceBucket,
  outputBucket,
  thumbnailExtractor,
  thumbnailPublicBaseUrl: process.env['THUMBNAIL_PUBLIC_BASE_URL'],
  rewrapRunner,
  clipRunner
});

await app.register(jobsRouter, { prefix: '/api/v1/jobs', repository: jobRepository });

// HLS/DASH packaging (issue #9). The eyevinn-encore-packager consumes a Valkey
// queue and writes CMAF output to the packaged MinIO bucket; we enqueue jobs and
// receive a completion callback. Wiring is enabled only when REDIS_URL is set
// (the Valkey queue is the load-bearing dependency); otherwise the packaging
// trigger and the packager-callback route respond as not-configured. The
// PackagingService is exposed to issue #8's Encore callback handler via the
// PackagingTrigger interface so the two features stay decoupled.
function buildPackaging(): PackagingService | undefined {
  const redisUrl = process.env['REDIS_URL'];
  if (!redisUrl) {
    app.log.warn('REDIS_URL not set — HLS/DASH packaging disabled');
    return undefined;
  }
  const redis = new IORedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
  return new PackagingService({
    assets: assetRepository,
    queue: makeOscPackagerQueue(redis),
    publicBaseUrl: packagingPublicBaseUrl()
  });
}

const packaging = buildPackaging();

// Internal OSC callbacks. Unauthenticated by design — see routes/internal.ts.
// Hosts both the issue #9 packager-callback and the issue #8 encore-callback
// (transcode completion), which resolves its workspace + job from the embedded
// encoreJobId and creates ready child assets for each rendition.
await app.register(internalRouter, {
  prefix: '/api/v1/internal',
  packaging,
  jobRepository,
  repository: assetRepository,
  webhookDispatcher
});

// On object storage (upload-complete OR watch-folder ingest), fire-and-forget
// ffprobe extraction (issue #6). Shared by the upload route and the
// watch-folder service so a direct-bucket drop gets the same treatment as an
// API upload. Undefined when no probe runner is configured.
const onObjectStored =
  storage && probe
    ? (workspaceId: string, assetId: string, objectKey: string) =>
        void extractTechnicalMetadata(
          { workspaceId, assetId, objectKey },
          { assets: assetRepository, storage: storage.storageFor(workspaceId), probe }
        )
    : undefined;

if (storage) {
  await app.register(assetUploadRouter, {
    prefix: '/api/v1/assets',
    repository: assetRepository,
    storageFor: storage.storageFor,
    onObjectStored
  });
}

// Watch-folder ingest (issue #16). Opt-in via WATCH_FOLDER_ENABLED=true and
// only when MinIO is configured (graceful degradation: silently skipped
// otherwise). Detects objects written directly to the source bucket — bypassing
// the API upload route — and creates asset records for them. Started after all
// routers are registered (see app.listen below).
const watchFolder =
  storage && watchFolderEnabled()
    ? new WatchFolderService({
        client: storage.client,
        bucket: sourceBucket,
        repository: assetRepository,
        log: app.log,
        onObjectStored
      })
    : undefined;

// Operational status (issue #16). Unauthenticated; reports background service
// state without exposing workspace data.
await app.register(adminRouter, { prefix: '/api/v1/admin', watchFolder });
// Full-text + metadata search (issue #10). Workspace-scoped; behind `authenticate`.
await app.register(searchRouter, { prefix: '/api/v1/search', repository: searchRepository });

// Webhook registrations (issue #13). Workspace-scoped; behind `authenticate`.
await app.register(webhooksRouter, { prefix: '/api/v1/webhooks', repository: webhookRepository });

// Collections (issue #11). Workspace-scoped; behind `authenticate`. Shares the
// asset repository to validate membership and resolve assets on GET /:id.
await app.register(collectionsRouter, {
  prefix: '/api/v1/collections',
  repository: collectionRepository,
  assetRepository
});

// Static file serving for the web UI (issue #frontend). Files are served from
// the public/ directory at the /ui/ prefix. The directory is intentionally
// empty until the frontend build populates it; the plugin boots without error
// when no files are present.
await app.register(fastifyStatic, {
  root: join(dirname(fileURLToPath(import.meta.url)), '../public'),
  prefix: '/ui/',
  decorateReply: false
});
app.get('/ui', async (_req, reply) => reply.redirect('/ui/index.html'));

const port = parseInt(process.env['PORT'] ?? '3000', 10);
await app.listen({ port, host: '0.0.0.0' });

// Start watch-folder ingest only after the server is listening and every router
// is registered, so a detected object can flow through the full pipeline. The
// service silently no-ops when not configured/enabled.
watchFolder?.start();
