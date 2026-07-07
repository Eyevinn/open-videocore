import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { Context, createInstance, getInstance, waitForInstanceReady, getPortsForInstance } from '@osaas/client-core';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';
import { provisionRouter } from './routes/provision.js';
import { OperationStore } from './services/operation-store.js';
import { ensureParameterStore, paramStoreFromEnv } from './services/param-store.js';
import { assetsRouter } from './routes/assets.js';
import { assetUploadRouter, type StorageFactory } from './routes/asset-upload.js';
import { jobsRouter } from './routes/jobs.js';
import { searchRouter } from './routes/search.js';
import { WebhookDispatcher } from './services/webhook-dispatcher.js';
import { webhooksRouter } from './routes/webhooks.js';
import { collectionsRouter } from './routes/collections.js';
import { storageRouter } from './routes/storage.js';
import { WorkspaceStorage } from './data/storage.js';
import { makeS3Reader } from './pipeline/source.js';
import { WorkspaceStackResolver, type WorkspaceConnections } from './services/workspace-stack.js';
import {
  PerWorkspaceAssetRepository,
  PerWorkspaceJobRepository,
  PerWorkspaceSearchRepository,
  PerWorkspaceWebhookRepository,
  PerWorkspaceCollectionRepository
} from './data/per-workspace-repos.js';
import { makeOscProbeRunner } from './pipeline/osc-ffprobe.js';
import { extractTechnicalMetadata, type ProbeRunner } from './pipeline/metadata-extractor.js';
import { makeOscThumbnailExtractor } from './pipeline/osc-thumbnail.js';
import type { FrameExtractor } from './pipeline/thumbnail.js';
import { makeOscRewrapRunner } from './pipeline/osc-rewrap.js';
import type { RewrapRunner } from './pipeline/rewrap.js';
import { makeOscClipRunner } from './pipeline/osc-clip.js';
import type { ClipRunner } from './pipeline/clip.js';
import { internalRouter } from './routes/internal.js';
import { encoreCompatRouter } from './routes/encore-compat.js';
import { profilesRouter } from './routes/profiles.js';
import { InMemoryPipelineRepository } from './data/pipeline-repo.js';
import { adminRouter } from './routes/admin.js';
import { scalerRouter } from './routes/scaler.js';
import { WatchFolderService, watchFolderEnabled } from './pipeline/watch-folder.js';
import { startEncoreCallbackPoller } from './pipeline/encore-callback-poller.js';
import { PackagingService, packagingPublicBaseUrl } from './pipeline/packaging.js';
import { makeOscPackagerQueue } from './pipeline/osc-packager-queue.js';
import type { EncoreClient } from './pipeline/encore-client.js';
import { Redis as IORedis } from 'ioredis';
import { WorkspaceEncoreScalerRegistry } from './encore-scaler/workspace-registry.js';
import {
  createJob,
  getJob,
  getLogsForInstance,
  removeJob,
} from '@osaas/client-core';

declare module 'fastify' {
  interface FastifyRequest {
    // Backing-service connections for the resolved stack, set by the global
    // preHandler hook. Null on unauthenticated routes.
    connections: WorkspaceConnections | null;
  }
}

const app = Fastify({ logger: true });

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

// Pass binary/media upload bodies through as a stream for PUT /:id/upload.
// Registered before plugins so child scopes inherit these parsers.
// The route handler reads request.body as a Readable and pipes it to MinIO.
for (const ct of [
  'application/octet-stream',
  'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
  'video/webm', 'video/mpeg', 'video/ogg', 'video/3gpp',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]) {
  app.addContentTypeParser(ct, (_req, payload, done) => {
    done(null, payload);
  });
}

await app.register(fastifySwagger, {
  openapi: {
    info: {
      title: 'open-videocore API',
      description: 'OSC-native media asset management — ingest, transcode, package, search, and deliver video assets.',
      version: '1.0.0'
    },
    tags: [
      { name: 'assets', description: 'Asset lifecycle, metadata, tracks, thumbnails, clip, export' },
      { name: 'jobs', description: 'Background job status' },
      { name: 'search', description: 'Full-text and metadata search' },
      { name: 'collections', description: 'Named asset groups' },
      { name: 'webhooks', description: 'Event notification registrations' },
      { name: 'provision', description: 'OSC stack provisioning and teardown' },
      { name: 'storage', description: 'Bucket and object-storage management' },
      { name: 'admin', description: 'Operational status and background service control' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'OSC access token (injected by the OSC login wall in production)' }
      }
    },
    security: [{ bearerAuth: [] }]
  },
  transform: jsonSchemaTransform
});

await app.register(fastifySwaggerUi, {
  routePrefix: '/api-docs',
  uiConfig: { docExpansion: 'list', deepLinking: true },
  staticCSP: false
});

await app.register(cors);
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: null
    }
  }
});

// OSC context — reads OSC_ACCESS_TOKEN from environment.
// On OSC this is injected at runtime; locally set it in .env.
const oscContext = new Context();

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
      createInstance: (serviceId, sat, body) => createInstance(oscContext, serviceId, sat, body),
      waitForInstanceReady: (serviceId, name) => waitForInstanceReady(serviceId, name, oscContext),
      getPortsForInstance: (serviceId, name, sat) => getPortsForInstance(oscContext, serviceId, name, sat)
    },
    log: app.log
  });
}

// Per-workspace backing-service resolver (replaces the global singleton
// connection config). Each request's connections are resolved at request time
// from the parameter store (or an explicit env-var override for local dev),
// keyed by the caller's workspace and an optional X-Stack-Name header. The
// resolver caches results and is invalidated after a provision/teardown.
const stackResolver = new WorkspaceStackResolver({
  paramStore,
  oscContext,
  minioPassword: process.env['MINIO_ROOT_PASSWORD'] ?? '',
  couchPassword: process.env['COUCHDB_ADMIN_PASSWORD'] ?? ''
});

// Resolve per-request connections. Auth is handled by the OSC SAT gate upstream;
// the app trusts every request that reaches it.
app.decorateRequest('connections', null);
app.addHook('preHandler', async (request) => {
  const stackHeader = request.headers['x-stack-name'];
  const stackName = typeof stackHeader === 'string' && stackHeader.length > 0 ? stackHeader : undefined;
  request.connections = await stackResolver.resolve(stackName);
});

const operationStore = new OperationStore();

await app.register(provisionRouter, {
  prefix: '/api/v1/provision',
  osc: oscContext,
  paramStore,
  operationStore,
  // Invalidate the resolver cache after a successful provision/teardown so the
  // new (or removed) stack is picked up on the next request without a restart.
  onStackChange: () => stackResolver.invalidate()
});

// Workspace-scoped resource repositories. These hold NO connection of their
// own: each delegates to the concrete repository in the stack resolved for the
// request's workspace (CouchDB-backed when a stack is provisioned, in-memory
// otherwise — WorkspaceStackResolver decides). The router option interfaces and
// route handlers are unchanged; only the backing connection is now resolved
// lazily per workspace at request time instead of as a startup singleton.
const assetRepository = new PerWorkspaceAssetRepository(stackResolver);
const jobRepository = new PerWorkspaceJobRepository(stackResolver);
const searchRepository = new PerWorkspaceSearchRepository(stackResolver);
const webhookRepository = new PerWorkspaceWebhookRepository(stackResolver);
const collectionRepository = new PerWorkspaceCollectionRepository(stackResolver);

// Synchronous, per-workspace object-storage factory (issue #4). Reads the
// connections already warmed into the resolver cache by the global preHandler
// hook, so it can stay the sync StorageFactory the asset routers expect. When
// the resolved stack has no object storage (in-memory fallback) it throws — the
// routes only call this when the asset has an objectKey, and upload routes are
// gated by `storageAvailable` below.
const storageFor: StorageFactory = (): WorkspaceStorage => {
  const conns = stackResolver.resolveCached();
  if (!conns?.storageFor) {
    throw new Error('object storage is not configured for this stack');
  }
  return conns.storageFor();
};

// Whether any object storage is reachable at all (explicit env override OR a
// provisioned stack). Upload/URL-pull routes and the watch-folder are only
// wired when true. A bare local run with no COUCHDB_URL/MINIO_URL leaves this
// false and those routes degrade to 501 / are skipped.
const storageAvailable = Boolean(process.env['MINIO_URL']) || Boolean(paramStore);
if (!storageAvailable) {
  app.log.warn('no MINIO_URL and no parameter store — upload + URL-pull routes disabled');
}

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
const probe: ProbeRunner | undefined = storageAvailable
  ? makeOscProbeRunner({
      context: oscContext,
      createJob,
      getJob,
      getLogsForInstance,
      removeJob
    })
  : undefined;

// Thumbnail / poster-frame extraction (issue #7) reuses the OSC
// eyevinn-ffmpeg-s3 ephemeral job to seek + emit JPEG frames, writing each back
// to MinIO via a presigned PUT URL. Like the probe runner it needs both an OSC
// context and object storage; when either is missing the thumbnail routes
// respond 501.
// Thumbnail extractor: a factory so the route can supply the workspace's MinIO
// credentials (resolved from the stack config) at request time. The route
// unwraps it if s3Config is available, otherwise falls back to a direct call
// which uses env-var credentials (local dev / env-override path).
const thumbnailExtractor = storageAvailable
  ? (_s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string }): FrameExtractor =>
      // Output goes to the presigned PUT URL on each FrameTarget, so the runner
      // no longer needs standing S3 credentials in the job body.
      makeOscThumbnailExtractor({
        context: oscContext,
        createJob,
        getJob,
        getLogsForInstance,
        removeJob
      })
  : undefined;

// Export / re-wrap (issue #19) reuses the OSC eyevinn-ffmpeg-s3 ephemeral job to
// remux a stored object into a different container with `-c copy` (no
// re-encode), writing the new child asset back to MinIO via a presigned PUT
// URL. Like the thumbnail runner it needs both an OSC context and object
// storage; when either is missing POST /:id/export responds 501.
const rewrapRunner: RewrapRunner | undefined = storageAvailable
  ? makeOscRewrapRunner({
      context: oscContext,
      createJob,
      getJob,
      getLogsForInstance,
      removeJob
    })
  : undefined;

const clipRunner: ClipRunner | undefined = storageAvailable
  ? makeOscClipRunner({
      context: oscContext,
      createJob,
      getJob,
      getLogsForInstance,
      removeJob
    })
  : undefined;

// ABR transcoding via auto-scaling Encore pool (ADR-006). The scaler exposes
// the same EncoreClient interface as the old static client but manages a
// per-workspace pool of Encore OSC instances. Set ENCORE_MAX_INSTANCES=1 to
// cap the pool at a single instance (equivalent to the previous static behaviour).
// Requires REDIS_URL (same Valkey used for HLS/DASH packaging). When Redis is
// unavailable transcoding degrades to 501.
const encoreMaxInstances = parseInt(process.env['ENCORE_MAX_INSTANCES'] ?? '3', 10);
const encoreIdleTimeoutMs = parseInt(process.env['ENCORE_IDLE_TIMEOUT_MS'] ?? String(5 * 60 * 1000), 10);

let encore: EncoreClient | undefined;
let sharedRedis: IORedis | undefined;

if (storageAvailable && process.env['REDIS_URL']) {
  sharedRedis = new IORedis(process.env['REDIS_URL'], { lazyConnect: true, maxRetriesPerRequest: null });
  // ENCORE_S3_ENDPOINT et al. allow the operator to pass MinIO credentials to
  // every Encore instance the scaler spawns. Without these Encore resolves
  // s3:// URIs against AWS S3 and fails with 404.
  const encoreS3Endpoint = process.env['ENCORE_S3_ENDPOINT'];
  const encoreS3AccessKey = process.env['ENCORE_S3_ACCESS_KEY'] ?? process.env['MINIO_ACCESS_KEY'] ?? 'admin';
  const encoreS3SecretKey = process.env['ENCORE_S3_SECRET_KEY'] ?? process.env['MINIO_SECRET_KEY'] ?? process.env['MINIO_ROOT_PASSWORD'];
  encore = new WorkspaceEncoreScalerRegistry({
    redis: sharedRedis,
    oscContext,
    maxInstances: encoreMaxInstances,
    idleTimeoutMs: encoreIdleTimeoutMs,
    s3Config: encoreS3Endpoint && encoreS3SecretKey ? {
      endpoint: encoreS3Endpoint,
      accessKeyId: encoreS3AccessKey,
      secretAccessKey: encoreS3SecretKey
    } : undefined,
    // When the scaler dispatches a queued job to an Encore instance, advance the
    // Job record queued->running and the source asset to `processing`. The
    // scaler has no repositories of its own, so we resolve the job here by the
    // encoreJobId (our externalId) it was submitted with.
    onDispatched: async (encoreJobId: string) => {
      const found = await jobRepository.findByEncoreJobId(encoreJobId);
      if (!found) return;
      const { job } = found;
      if (job.status === 'queued' || job.status === 'pending') {
        await jobRepository.update(job.id, { status: 'running' });
      }
      if (job.assetId) {
        await assetRepository.update(job.assetId, { status: 'processing' });
      }
    }
  });
  if (!encoreS3Endpoint) {
    app.log.warn('ENCORE_S3_ENDPOINT not set — Encore instances will not be able to read from MinIO; set ENCORE_S3_ENDPOINT to the MinIO URL');
  }
  // Start loops for any workspaces that had pool entries from a previous run.
  // This triggers reconcile() on the first tick, correcting stale activeJobs counts
  // left by jobs that completed while the server was down.
  void (encore as import('./encore-scaler/workspace-registry.js').WorkspaceEncoreScalerRegistry)
    .resumeExistingWorkspaces()
    .catch((err) => app.log.warn({ err }, 'encore-scaler: failed to resume existing workspaces'));
} else if (storageAvailable) {
  app.log.warn('REDIS_URL not set — Encore auto-scaler disabled, transcoding unavailable');
}

// Bucket names are stack-invariant (created at provision time, see provision.ts)
// so a static default is correct for every workspace.
const sourceBucket = process.env['MINIO_SOURCE_BUCKET'] ?? 'openvideocore-source';
const outputBucket = process.env['MINIO_PACKAGED_BUCKET'] ?? 'openvideocore-packaged';

// S3 reader for URL-pull ingest of s3:// sources (issue #5). This reads the
// source object via a MinIO client. With per-workspace stacks the worker runs
// detached and the global pullDeps cannot carry a per-request workspace, so we
// bind it only for the explicit env-override (single global MinIO) path. In the
// provisioned multi-stack case s3:// pull is unsupported (http/https pull still
// works); this is tracked for follow-up route plumbing.
const envMinioClient = process.env['MINIO_URL']
  ? (await stackResolver.resolve()).storageClient
  : undefined;
const pullDeps = envMinioClient ? { openS3: makeS3Reader(envMinioClient) } : undefined;

// HLS/DASH packaging (issue #9). The eyevinn-encore-packager consumes a Valkey
// queue and writes CMAF output to the packaged MinIO bucket; we enqueue jobs and
// receive a completion callback. Wiring is enabled only when REDIS_URL is set
// (the Valkey queue is the load-bearing dependency); otherwise the packaging
// trigger and the packager-callback route respond as not-configured.
function buildPackaging(): PackagingService | undefined {
  if (!sharedRedis) {
    app.log.warn('REDIS_URL not set — HLS/DASH packaging disabled');
    return undefined;
  }
  return new PackagingService({
    assets: assetRepository,
    queue: makeOscPackagerQueue(sharedRedis),
    publicBaseUrl: packagingPublicBaseUrl()
  });
}

const packaging = buildPackaging();

// PipelineExecution tracking (PipelineExecution feature). In-memory: executions
// are ephemeral orchestration state advanced by OSC completion callbacks. Shared
// between the assets router (creates executions) and the internal router
// (advances them from transcode/package callbacks).
const pipelineRepository = new InMemoryPipelineRepository();

// Encore completion callback poller (background). The eyevinn-encore-callback-
// listener receives Encore's completion webhook in the cloud and writes a
// message to a Redis sorted set; POST /api/v1/internal/encore-callback is only
// reachable when this API is deployed publicly. This poller drains that same
// sorted set and runs the identical completion + pipeline-advancement logic, so
// transcode completions are applied even when the callback route is unreachable
// (e.g. local runs). Only started when the shared Redis (same REDIS_URL the
// listener writes to) is configured.
let stopEncoreCallbackPoller: (() => void) | undefined;
if (sharedRedis) {
  stopEncoreCallbackPoller = startEncoreCallbackPoller({
    redis: sharedRedis,
    jobRepository,
    assetRepository,
    pipelineRepository,
    packaging,
    oscContext,
    queueKey: process.env['ENCORE_CALLBACK_QUEUE_KEY'],
    logger: app.log
  });
  app.addHook('onClose', async () => {
    stopEncoreCallbackPoller?.();
  });
}

// Encore transcoding profile catalogue (public metadata). Unauthenticated by
// design — it exposes only the list of available profile names for a UI picker,
// no workspace data. The index URL is the Encore instance's `profilesUrl`,
// configurable via ENCORE_PROFILES_URL; defaults to the Eyevinn test profiles.
const encoreProfilesUrl =
  process.env['ENCORE_PROFILES_URL'] ??
  'https://raw.githubusercontent.com/Eyevinn/encore-test-profiles/refs/heads/main/profiles.yml';
await app.register(profilesRouter, {
  prefix: '/api/v1/profiles',
  profilesUrl: encoreProfilesUrl
});

// Assets router also owns POST /ingest-url (issue #5) and POST /:id/transcode
// (issue #8). It shares the same job repository so a job created here is
// readable by the jobs router. The per-workspace storage factory + S3 reader
// resolve the caller's stack at request time.
await app.register(assetsRouter, {
  prefix: '/api/v1/assets',
  repository: assetRepository,
  jobRepository,
  storageFor: storageAvailable ? storageFor : undefined,
  pullDeps,
  probe,
  encore,
  sourceBucket,
  outputBucket,
  thumbnailExtractor,
  thumbnailPublicBaseUrl: process.env['THUMBNAIL_PUBLIC_BASE_URL'],
  rewrapRunner,
  clipRunner,
  packaging,
  packagingRedis: sharedRedis,
  pipelineRepository
});

await app.register(jobsRouter, { prefix: '/api/v1/jobs', repository: jobRepository, redis: sharedRedis });

// Encore-compatible transcode submission (migration surface). Lets integrators
// who POST directly to an Encore OSC instance repoint at this API with only a
// base-URL swap — same payloads. Unauthenticated by design (matches Encore's
// own submit API; OSC terminates auth at the edge). Shares the same deps as the
// assets router so a job submitted here is observable everywhere else.
await app.register(encoreCompatRouter, {
  prefix: '/api/v1/encore',
  repository: assetRepository,
  jobRepository,
  encore,
  sourceBucket,
  outputBucket
});

// Internal OSC callbacks. Unauthenticated by design — see routes/internal.ts.
// Hosts both the issue #9 packager-callback and the issue #8 encore-callback
// (transcode completion), which resolves its workspace + job from the embedded
// encoreJobId and creates ready child assets for each rendition.
await app.register(internalRouter, {
  prefix: '/api/v1/internal',
  packaging,
  jobRepository,
  repository: assetRepository,
  webhookDispatcher,
  redis: sharedRedis,
  pipelineRepository
});

// On object storage (upload-complete OR watch-folder ingest), fire-and-forget
// ffprobe extraction (issue #6). Shared by the upload route and the
// watch-folder service so a direct-bucket drop gets the same treatment as an
// API upload. Undefined when no probe runner is configured.
// The upload route resolves the caller's workspace before invoking this, so the
// resolver cache is warm and the sync storageFor() can read it.
const onObjectStored =
  storageAvailable && probe
    ? (assetId: string, objectKey: string, storage?: WorkspaceStorage) =>
        void extractTechnicalMetadata(
          { assetId, objectKey },
          { assets: assetRepository, storage: storage ?? storageFor(), probe }
        )
    : undefined;

if (storageAvailable) {
  await app.register(assetUploadRouter, {
    prefix: '/api/v1/assets',
    repository: assetRepository,
    storageFor,
    onObjectStored
  });
}

// Watch-folder ingest (issue #16). Opt-in via WATCH_FOLDER_ENABLED=true. It is
// a global background service watching a single source bucket, so it needs a
// concrete MinIO client up front — only available via the explicit env override
// (single global MinIO). In the provisioned multi-stack model there is no single
// bucket to watch, so the watch-folder is skipped (the API upload + URL-pull
// paths still cover ingest).
const watchFolder =
  envMinioClient && watchFolderEnabled()
    ? new WatchFolderService({
        client: envMinioClient,
        bucket: sourceBucket,
        repository: assetRepository,
        log: app.log,
        onObjectStored
      })
    : undefined;

// Operational status (issue #16). Unauthenticated; reports background service
// state without exposing workspace data.
await app.register(adminRouter, { prefix: '/api/v1/admin', watchFolder });

// Encore auto-scaler status (ADR-006). Unauthenticated read-only introspection
// of the per-workspace scaler pool for the ops UI. `sharedRedis` is undefined
// when the scaler is off (no REDIS_URL); the endpoint then reports
// scalerActive:false with an empty workspace list.
await app.register(scalerRouter, {
  prefix: '/api/v1/scaler',
  redis: sharedRedis,
  maxInstances: encoreMaxInstances,
  minInstances: 0,
  onConfigChange: (cfg) => {
    if (encore instanceof WorkspaceEncoreScalerRegistry) {
      encore.setMaxInstances(cfg.maxInstances);
    }
  }
});
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

// Bucket / object-storage management. Workspace-scoped; behind `authenticate`.
// Lets an operator browse and prune the objects stored in the workspace's
// source + packaged buckets. Resolves storage from the request's stack at
// request time and degrades to 501 when no object storage is configured.
await app.register(storageRouter, { prefix: '/api/v1/storage', stackResolver, watchFolder });

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
