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
import { pipelinesRouter } from './routes/pipelines.js';
import { searchRouter } from './routes/search.js';
import { WebhookDispatcher } from './services/webhook-dispatcher.js';
import { webhooksRouter } from './routes/webhooks.js';
import { collectionsRouter } from './routes/collections.js';
import { storageRouter } from './routes/storage.js';
import { WorkspaceStorage } from './data/storage.js';
import { makeS3Reader } from './pipeline/source.js';
import { WorkspaceStackResolver, STACK_CONFIG_NAMESPACE, type WorkspaceConnections } from './services/workspace-stack.js';
import {
  PerWorkspaceAssetRepository,
  PerWorkspaceJobRepository,
  PerWorkspaceSearchRepository,
  PerWorkspaceWebhookRepository,
  PerWorkspaceCollectionRepository,
  PerWorkspaceProfileRepository
} from './data/per-workspace-repos.js';
import { makeOscProbeRunner } from './pipeline/osc-ffprobe.js';
import { extractTechnicalMetadata, type ProbeRunner } from './pipeline/metadata-extractor.js';
import { makeOscSubtitleGenerator } from './pipeline/osc-auto-subtitles.js';
import type { SubtitleGenerator } from './pipeline/subtitle-generator.js';
import { makeOscSceneDetector } from './pipeline/osc-scene-detect.js';
import type { SceneDetector } from './pipeline/scene-detector.js';
import { makeOscThumbnailExtractor } from './pipeline/osc-thumbnail.js';
import { extractThumbnails } from './pipeline/thumbnail.js';
import type { FrameExtractor } from './pipeline/thumbnail.js';
import { makeOscRewrapRunner } from './pipeline/osc-rewrap.js';
import type { RewrapRunner } from './pipeline/rewrap.js';
import { makeOscClipRunner } from './pipeline/osc-clip.js';
import type { ClipRunner } from './pipeline/clip.js';
import { internalRouter } from './routes/internal.js';
import { encoreCompatRouter } from './routes/encore-compat.js';
import { profilesRouter } from './routes/profiles.js';
import { bootstrapProfiles } from './services/profile-bootstrap.js';
import { PerWorkspacePipelineRepository } from './data/per-workspace-repos.js';
import { InMemoryCommentRepository } from './data/comment-repo.js';
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
// via PARAMETER_STORE_INSTANCE_NAME + PARAMETER_STORE_API_KEY; the instance URL
// is resolved from the name via the OSC SDK and cached. When unset the provision
// route still works but skips persistence and GET /:name responds 501.
const paramStore = await paramStoreFromEnv(
  {
    getServiceAccessToken: (serviceId) => oscContext.getServiceAccessToken(serviceId),
    getInstance: (serviceId, name, sat) => getInstance(oscContext, serviceId, name, sat)
  },
  () => oscContext.getServiceAccessToken('eyevinn-app-config-svc')
);
if (!paramStore) {
  app.log.warn(
    'PARAMETER_STORE_API_KEY not set (or config instance unresolved) — provisioned stack coordinates will not be persisted'
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
  try {
    request.connections = await stackResolver.resolve(stackName);
  } catch (err) {
    // A bad or partially-provisioned stack config (e.g. empty couchdbUrl) must
    // not take down every route including health probes. Degrade to no connections
    // so workspace-scoped routes fail with 503, but infrastructure routes stay up.
    app.log.warn({ err }, 'stack resolver failed — connections unavailable for this request');
    request.connections = null;
  }
});

const operationStore = new OperationStore();

await app.register(provisionRouter, {
  prefix: '/api/v1/provision',
  osc: oscContext,
  paramStore,
  operationStore,
  publicBaseUrl: process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, ''),
  // Invalidate the resolver cache after a successful provision/teardown so the
  // new (or removed) stack is picked up on the next request without a restart.
  // Then reconcile the scaler/queue wiring: activate it against the freshly
  // provisioned stack's Valkey (or tear it down on the last deprovision) so
  // transcoding comes online immediately with no restart (#103).
  onStackChange: () => {
    stackResolver.invalidate();
    void reconcileScaler().catch((err) =>
      app.log.warn({ err }, 'encore-scaler: reconcile after stack change failed')
    );
  },
  // Late-bound accessor for the scaler registry. scalerRegistry is a
  // module-level binding created lazily by reconcileScaler() only once a stack
  // exists (and reset to undefined on the last deprovision), which is *after*
  // this register() call runs. This getter reads that outer binding on demand
  // so the DELETE route can reach the current registry for teardown (#123)
  // without depending on registration-time ordering.
  getScalerRegistry: () => scalerRegistry
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
const profileRepository = new PerWorkspaceProfileRepository(stackResolver);

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
  ? (s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string }): FrameExtractor =>
      // Output goes to `s3://bucket/key` via the ffmpeg-s3 native S3 writer, so
      // the runner needs the MinIO credentials + bucket in the job body. A
      // presigned PUT URL does NOT work with the image2 muxer (issue #92).
      makeOscThumbnailExtractor({
        context: oscContext,
        createJob,
        getJob,
        getLogsForInstance,
        removeJob,
        s3Endpoint: s3.endpoint,
        s3AccessKey: s3.accessKey,
        s3SecretKey: s3.secretKey,
        s3Bucket: s3.bucket
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

// Auto-subtitles (issue #114) runs on the long-lived OSC eyevinn-auto-subtitles
// (Whisper) SERVICE, called over HTTP at its instance URL — NOT an ephemeral job
// like the ffprobe/thumbnail/clip runners. It is OPTIONAL and opt-in: the
// service is provisioned separately (it needs an OpenAI key), so the deployment
// supplies the instance name via AUTO_SUBTITLES_INSTANCE_NAME. When that name is
// unset (or object storage is missing) the generator is undefined and the
// `subtitles` pipeline step skips gracefully (never throws — fire-and-forget).
// AUTO_SUBTITLES_WRITES_S3=true tells the runner the service uploads the result
// object to S3 itself (so we skip our own upload path).
const autoSubtitlesInstanceName = process.env['AUTO_SUBTITLES_INSTANCE_NAME'];
const subtitleGenerator: SubtitleGenerator | undefined =
  storageAvailable && autoSubtitlesInstanceName
    ? makeOscSubtitleGenerator({
        context: oscContext,
        getInstance,
        instanceName: autoSubtitlesInstanceName,
        writesToS3: process.env['AUTO_SUBTITLES_WRITES_S3'] === 'true'
      })
    : undefined;
if (storageAvailable && !autoSubtitlesInstanceName) {
  app.log.info('AUTO_SUBTITLES_INSTANCE_NAME not set — optional auto-subtitles pipeline step disabled');
}

// Scene detection (issue #115) runs on the OSC eyevinn-function-scenes media
// FUNCTION, called over HTTP at its instance URL (NOT an ephemeral job). Like
// auto-subtitles it is OPTIONAL and opt-in: the function is provisioned
// separately, so the deployment supplies the instance name via
// SCENE_DETECT_INSTANCE_NAME. When that name is unset (or object storage is
// missing) the detector is undefined and the OPTIONAL `scene-detect` pipeline
// step skips gracefully (never throws — fire-and-forget). SCENE_DETECT_PATH
// overrides the (un-contract-verified) runtime endpoint path (default '/').
const sceneDetectInstanceName = process.env['SCENE_DETECT_INSTANCE_NAME'];
const sceneDetector: SceneDetector | undefined =
  storageAvailable && sceneDetectInstanceName
    ? makeOscSceneDetector({
        context: oscContext,
        getInstance,
        instanceName: sceneDetectInstanceName,
        path: process.env['SCENE_DETECT_PATH']
      })
    : undefined;
if (storageAvailable && !sceneDetectInstanceName) {
  app.log.info('SCENE_DETECT_INSTANCE_NAME not set — optional scene-detect pipeline step disabled');
}

// ABR transcoding via auto-scaling Encore pool (ADR-006). The scaler exposes
// the same EncoreClient interface as the old static client but manages a
// per-workspace pool of Encore OSC instances. Set ENCORE_MAX_INSTANCES=1 to
// cap the pool at a single instance (equivalent to the previous static behaviour).
// Requires a Redis connection (resolved from the parameter store after provisioning).
// When Redis is unavailable transcoding degrades to 501.
const encoreMaxInstances = parseInt(process.env['ENCORE_MAX_INSTANCES'] || '3', 10);
const encoreIdleTimeoutMs = parseInt(process.env['ENCORE_IDLE_TIMEOUT_MS'] || String(5 * 60 * 1000), 10);

// The default Encore profile index used to seed the profile store on first
// startup / on bootstrap. Same URL + default as before (issue #84).
const encoreProfilesUrl =
  process.env['ENCORE_PROFILES_URL'] ??
  'https://raw.githubusercontent.com/Eyevinn/encore-test-profiles/refs/heads/main/profiles.yml';

// Publicly-reachable base URL of this API, used to build the `profilesUrl` we
// hand to each Encore instance the scaler spawns so Encore fetches profiles
// from our own GET /api/v1/profiles/index.yml. When unset the scaler falls back
// to the remote default index (previous behaviour), so Encore still works.
const publicBaseUrl = process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '');
const encoreScalerProfilesUrl = publicBaseUrl
  ? `${publicBaseUrl}/api/v1/profiles/index.yml`
  : encoreProfilesUrl;
if (!publicBaseUrl) {
  app.log.warn('PUBLIC_BASE_URL not set — Encore instances will fetch profiles from the remote default index instead of the local profile store');
}

// Live scaler/queue wiring. These are mutable holders, not startup-time
// constants: when the API boots with no provisioned stack there is no Valkey,
// so the scaler, packaging service, and callback poller all start disabled.
// The moment a stack is provisioned (POST /api/v1/provision writes its redisUrl
// to the parameter store and fires onStackChange), reconcileScaler() activates
// them against that stack's Valkey — no restart required (#103). On deprovision
// the same reconcile tears them back down.
//
// The router option objects registered below (assetRouterOptions,
// jobsRouterOptions, internalRouterOptions, encoreCompatRouterOptions,
// scalerRouterOptions) hold these same connections by reference. Fastify handlers
// read them from `opts` live on each request, so mutating the option objects here
// after (de)activation is picked up without re-registering any plugin.
let encore: EncoreClient | undefined;
let sharedRedis: IORedis | undefined;
let packaging: PackagingService | undefined;
let scalerRegistry: WorkspaceEncoreScalerRegistry | undefined;
let stopEncoreCallbackPoller: (() => void) | undefined;

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

// PipelineExecution tracking (PipelineExecution feature). In-memory: executions
// are ephemeral orchestration state advanced by OSC completion callbacks. Shared
// between the assets router (creates executions) and the internal router
// (advances them from transcode/package callbacks). Declared up front so the
// callback poller (started on scaler activation) can advance executions.
const pipelineRepository = new PerWorkspacePipelineRepository(stackResolver);

// Asset comments (issue #135). In-memory: comments are a simple free-text
// sub-resource for this iteration (mirrors the ephemeral pipeline repo above).
// Shared with the assets router, which owns POST/GET /:id/comments.
const commentRepository = new InMemoryCommentRepository();

// Read the first provisioned stack's Valkey URL from the parameter store, or
// undefined when no stack is provisioned yet. Self-discovered: there is no
// REDIS_URL env var — the URL only exists once POST /api/v1/provision has run.
async function resolveStackRedisUrl(): Promise<string | undefined> {
  if (!paramStore) return undefined;
  try {
    const names = await paramStore.listStackNames(STACK_CONFIG_NAMESPACE);
    if (names.length === 0) return undefined;
    const stackCfg = await paramStore.loadStackConfig(STACK_CONFIG_NAMESPACE, names[0]!);
    return stackCfg?.redisUrl && stackCfg.redisUrl.length > 0 ? stackCfg.redisUrl : undefined;
  } catch (err) {
    app.log.warn({ err }, 'encore-scaler: failed to resolve Redis URL from parameter store');
    return undefined;
  }
}

// Bring the scaler, packaging service, and callback poller up against a stack's
// Valkey. Idempotent: a no-op when already active on the same URL. This is
// invoked at startup (if a stack already exists) and from onStackChange the
// moment a stack is first provisioned (#103).
function activateScaler(redisUrl: string): void {
  if (sharedRedis) return; // already active

  // ENCORE_S3_ENDPOINT et al. allow the operator to pass MinIO credentials to
  // every Encore instance the scaler spawns. Without these Encore resolves
  // s3:// URIs against AWS S3 and fails with 404.
  const encoreS3Endpoint = process.env['ENCORE_S3_ENDPOINT'];
  const encoreS3AccessKey = process.env['ENCORE_S3_ACCESS_KEY'] ?? process.env['MINIO_ACCESS_KEY'] ?? 'admin';
  const encoreS3SecretKey = process.env['ENCORE_S3_SECRET_KEY'] ?? process.env['MINIO_SECRET_KEY'] ?? process.env['MINIO_ROOT_PASSWORD'];

  const redis = new IORedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
  sharedRedis = redis;

  scalerRegistry = new WorkspaceEncoreScalerRegistry({
    redis,
    redisUrl,
    minInstances: parseInt(process.env['ENCORE_MIN_INSTANCES'] || '0', 10),
    oscContext,
    maxInstances: encoreMaxInstances,
    idleTimeoutMs: encoreIdleTimeoutMs,
    // Point each spawned Encore instance at our own public profile index so it
    // loads the operator-managed profiles from CouchDB (issue #84).
    profilesUrl: encoreScalerProfilesUrl,
    // Local-dev fallback only: ENCORE_S3_ENDPOINT is used verbatim for all
    // workspaces when set. On OSC this is unset and resolveS3Config below
    // resolves the MinIO endpoint per workspace from the parameter store.
    s3Config: encoreS3Endpoint && encoreS3SecretKey ? {
      endpoint: encoreS3Endpoint,
      accessKeyId: encoreS3AccessKey,
      secretAccessKey: encoreS3SecretKey
    } : undefined,
    // Resolve each workspace's MinIO endpoint from the parameter store at loop
    // creation time so no static ENCORE_S3_ENDPOINT env var is required on OSC.
    // Mirrors WorkspaceStackResolver: address the stack by workspaceId, falling
    // back to the first provisioned stack for the namespace.
    resolveS3Config: async (workspaceId: string) => {
      if (!paramStore || !encoreS3SecretKey) return undefined;
      try {
        let config = await paramStore.loadStackConfig(STACK_CONFIG_NAMESPACE, workspaceId);
        if (!config) {
          const names = await paramStore.listStackNames(STACK_CONFIG_NAMESPACE);
          if (names.length > 0) {
            config = await paramStore.loadStackConfig(STACK_CONFIG_NAMESPACE, names[0]!);
          }
        }
        if (config?.minioEndpoint) {
          return {
            endpoint: config.minioEndpoint,
            accessKeyId: 'admin',
            secretAccessKey: encoreS3SecretKey
          };
        }
      } catch (err) {
        app.log.warn({ err, workspaceId }, 'encore-scaler: failed to resolve MinIO s3Config from parameter store');
      }
      return undefined;
    },
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
  encore = scalerRegistry;

  // HLS/DASH packaging (issue #9). The eyevinn-encore-packager consumes a Valkey
  // queue and writes CMAF output to the packaged MinIO bucket; we enqueue jobs
  // and receive a completion callback.
  packaging = new PackagingService({
    assets: assetRepository,
    queue: makeOscPackagerQueue(redis),
    publicBaseUrl: packagingPublicBaseUrl()
  });

  // Encore completion callback poller (background). Drains the Valkey sorted set
  // the callback listener writes to and applies transcode completions even when
  // the public callback route is unreachable (e.g. local runs).
  stopEncoreCallbackPoller = startEncoreCallbackPoller({
    redis,
    jobRepository,
    assetRepository,
    pipelineRepository,
    oscContext,
    queueKey: process.env['ENCORE_CALLBACK_QUEUE_KEY'],
    // The eyevinn-encore-packager's input queue (#94). Defaults to
    // "packaging-queue"; overridable so the poller can target a differently
    // named packager queue without a code change.
    packagingQueueKey: process.env['PACKAGING_QUEUE_KEY'],
    logger: app.log
  });

  // Publish the freshly-live connections into the router option objects so every
  // already-registered plugin picks them up on its next request/tick (#103).
  assetRouterOptions.encore = encore;
  assetRouterOptions.packaging = packaging;
  assetRouterOptions.packagingRedis = redis;
  jobsRouterOptions.redis = redis;
  encoreCompatRouterOptions.encore = encore;
  pipelinesRouterOptions.encoreClient = encore;
  internalRouterOptions.packaging = packaging;
  internalRouterOptions.redis = redis;
  scalerRouterOptions.redis = redis;

  // Start loops for any workspaces that had pool entries from a previous run.
  // This triggers reconcile() on the first tick, correcting stale activeJobs
  // counts left by jobs that completed while the server was down.
  void scalerRegistry
    .resumeExistingWorkspaces()
    .catch((err) => app.log.warn({ err }, 'encore-scaler: failed to resume existing workspaces'));

  app.log.info({ redisUrl }, 'encore-scaler: activated against provisioned stack Valkey');
}

// Tear down the scaler, packaging service, and callback poller when the stack
// they were bound to is deprovisioned: stop every scaler loop and poller, close
// the Valkey client, and clear the live wiring from the router option objects so
// transcoding/packaging degrade back to 501 (#103).
async function deactivateScaler(): Promise<void> {
  if (!sharedRedis) return; // already inactive

  stopEncoreCallbackPoller?.();
  stopEncoreCallbackPoller = undefined;

  // Destroy all pooled OSC Encore instances before stopping loops.
  // Without this, instances accumulate across restarts because the Valkey pool
  // can be cleared (Valkey restart, new deployment) while OSC instances keep
  // running — the next server startup finds an empty pool and spawns fresh ones.
  if (scalerRegistry) {
    await scalerRegistry
      .teardownAll((msg, err) => app.log.warn({ err }, msg))
      .catch((err) => app.log.warn({ err }, 'encore-scaler: teardownAll failed'));
  }
  scalerRegistry?.stopAll();
  scalerRegistry = undefined;

  const redis = sharedRedis;
  sharedRedis = undefined;
  encore = undefined;
  packaging = undefined;

  assetRouterOptions.encore = undefined;
  assetRouterOptions.packaging = undefined;
  assetRouterOptions.packagingRedis = undefined;
  jobsRouterOptions.redis = undefined;
  encoreCompatRouterOptions.encore = undefined;
  pipelinesRouterOptions.encoreClient = undefined;
  internalRouterOptions.packaging = undefined;
  internalRouterOptions.redis = undefined;
  scalerRouterOptions.redis = undefined;

  try {
    // The Valkey client is created lazyConnect, so it may never have opened a
    // socket (no transcoding happened before teardown). quit() would reject on a
    // never-connected client; disconnect() closes it cleanly either way and does
    // not wait on the (empty) command queue.
    redis.disconnect();
  } catch (err) {
    app.log.warn({ err }, 'encore-scaler: failed to close Valkey connection on deprovision');
  }

  app.log.info('encore-scaler: deactivated (stack deprovisioned)');
}

// Bring the scaler in line with the current set of provisioned stacks: activate
// against the first stack's Valkey when one exists and we are not yet active;
// deactivate when the last stack is gone. Invoked at startup and after every
// provision/teardown via onStackChange.
async function reconcileScaler(): Promise<void> {
  if (!storageAvailable) return;
  const redisUrl = await resolveStackRedisUrl();
  if (redisUrl && !sharedRedis) {
    activateScaler(redisUrl);
  } else if (!redisUrl && sharedRedis) {
    await deactivateScaler();
  }
}

// Encore transcoding profile catalogue + management (issue #84). Profiles are
// persisted in CouchDB (per-tenant) and surfaced/managed through this router.
// Unauthenticated by design: it exposes profile management + a public
// index.yml that the Encore instances the scaler spawns fetch directly (no
// bearer token). ENCORE_PROFILES_URL is the *bootstrap* seed source (the
// default Encore profile index), configurable and defaulting to the Eyevinn
// test profiles.
await app.register(profilesRouter, {
  prefix: '/api/v1/profiles',
  repository: profileRepository,
  bootstrapIndexUrl: encoreProfilesUrl
});

// Seed profiles from the default Encore index on first startup. Skipped when
// profiles already exist (survives restarts). Best-effort: a fetch failure
// (e.g. offline local run) is logged and does not block boot; operators can
// retry via POST /api/v1/profiles/bootstrap.
void bootstrapProfiles({
  repository: profileRepository,
  indexUrl: encoreProfilesUrl,
  log: app.log
}).catch((err) => app.log.warn({ err }, 'profile bootstrap on startup failed'));

// Assets router also owns POST /ingest-url (issue #5) and POST /:id/transcode
// (issue #8). It shares the same job repository so a job created here is
// readable by the jobs router. The per-workspace storage factory + S3 reader
// resolve the caller's stack at request time.
// The option objects below are held by reference: activateScaler /
// deactivateScaler mutate their `encore` / `packaging` / `redis` /
// `packagingRedis` fields when a stack is provisioned or torn down, and the
// Fastify handlers read those fields from `opts` live on each request. This is
// what lets the scaler and queue services come online (or go offline) without a
// server restart (#103). At startup these fields are undefined; reconcileScaler()
// at the end of boot fills them in if a stack already exists.
const assetRouterOptions: Parameters<typeof assetsRouter>[1] & { prefix: string } = {
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
  rewrapRunner,
  clipRunner,
  subtitleGenerator,
  sceneDetector,
  packaging,
  packagingRedis: sharedRedis,
  pipelineRepository,
  commentRepository
};
await app.register(assetsRouter, assetRouterOptions);

const jobsRouterOptions: Parameters<typeof jobsRouter>[1] & { prefix: string } = {
  prefix: '/api/v1/jobs',
  repository: jobRepository,
  redis: sharedRedis,
  pipelineRepository
};
await app.register(jobsRouter, jobsRouterOptions);

// Cross-asset pipeline execution visibility (issue #161).
const pipelinesRouterOptions: Parameters<typeof pipelinesRouter>[1] & { prefix: string } = {
  prefix: '/api/v1/pipelines',
  pipelineRepository,
  jobRepository,
  assetRepository,
  encoreClient: encore
};
await app.register(pipelinesRouter, pipelinesRouterOptions);

// Encore-compatible transcode submission (migration surface). Lets integrators
// who POST directly to an Encore OSC instance repoint at this API with only a
// base-URL swap — same payloads. Unauthenticated by design (matches Encore's
// own submit API; OSC terminates auth at the edge). Shares the same deps as the
// assets router so a job submitted here is observable everywhere else.
const encoreCompatRouterOptions: Parameters<typeof encoreCompatRouter>[1] & { prefix: string } = {
  prefix: '/api/v1/encore',
  repository: assetRepository,
  jobRepository,
  encore,
  sourceBucket,
  outputBucket
};
await app.register(encoreCompatRouter, encoreCompatRouterOptions);

// Internal OSC callbacks. Unauthenticated by design — see routes/internal.ts.
// Hosts both the issue #9 packager-callback and the issue #8 encore-callback
// (transcode completion), which resolves its workspace + job from the embedded
// encoreJobId and creates ready child assets for each rendition.
const internalRouterOptions: Parameters<typeof internalRouter>[1] & { prefix: string } = {
  prefix: '/api/v1/internal',
  packaging,
  jobRepository,
  repository: assetRepository,
  webhookDispatcher,
  redis: sharedRedis,
  pipelineRepository
};
await app.register(internalRouter, internalRouterOptions);

// On object storage (upload-complete OR watch-folder ingest), fire-and-forget
// ffprobe extraction (issue #6) and thumbnail extraction (issue #7). Shared by
// the upload route and the watch-folder service. The upload route resolves the
// caller's workspace before invoking this, so the resolver cache is warm and
// the sync storageFor() and resolveCached() can be read synchronously.
const onObjectStored =
  storageAvailable
    ? (assetId: string, objectKey: string, storage?: WorkspaceStorage) => {
        const effectiveStorage = storage ?? storageFor();
        if (probe) {
          void extractTechnicalMetadata(
            { assetId, objectKey },
            { assets: assetRepository, storage: effectiveStorage, probe }
          );
        }
        if (thumbnailExtractor) {
          // Read s3Config from the already-warm resolver cache. The upload
          // preHandler called resolve() so resolveCached() is valid here.
          const conns = stackResolver.resolveCached();
          const s3Cfg = conns?.s3Config;
          const bucket = conns?.sourceBucket ?? sourceBucket;
          const extractor = s3Cfg
            ? (thumbnailExtractor as (s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string }) => FrameExtractor)(
                { ...s3Cfg, bucket }
              )
            : undefined;
          if (extractor) {
            void extractThumbnails(
              { assetId, objectKey, timecodes: [1] },
              { assets: assetRepository, storage: effectiveStorage, extractor }
            ).catch(() => { /* failures recorded on asset */ });
          }
        }
      }
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
// of the per-workspace scaler pool for the ops UI. `redis` is undefined when the
// scaler is off; the endpoint then reports scalerActive:false with an empty
// workspace list. The option object is held by reference so activateScaler /
// deactivateScaler flip `redis` on (or off) when a stack is provisioned or torn
// down, and GET /status reports scalerActive:true immediately with no restart (#103).
const scalerRouterOptions: Parameters<typeof scalerRouter>[1] & { prefix: string } = {
  prefix: '/api/v1/scaler',
  redis: sharedRedis,
  maxInstances: encoreMaxInstances,
  minInstances: 0,
  idleTimeoutMs: encoreIdleTimeoutMs,
  onConfigChange: (cfg) => {
    if (scalerRegistry) {
      scalerRegistry.setMaxInstances(cfg.maxInstances);
      scalerRegistry.setIdleTimeoutMs(cfg.idleTimeoutMs);
    }
  }
};
await app.register(scalerRouter, scalerRouterOptions);
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

// Bring the scaler online now if a stack was already provisioned in a previous
// run (self-discovered from the parameter store). When no stack exists yet this
// is a no-op and the scaler stays disabled until the first POST /api/v1/provision
// fires onStackChange -> reconcileScaler() (#103).
await reconcileScaler().catch((err) =>
  app.log.warn({ err }, 'encore-scaler: initial reconcile failed')
);

// Cleanly stop the callback poller and close the Valkey connection on shutdown.
app.addHook('onClose', async () => {
  await deactivateScaler();
});

const port = parseInt(process.env['PORT'] || '3000', 10);
await app.listen({ port, host: '0.0.0.0' });

// Start watch-folder ingest only after the server is listening and every router
// is registered, so a detected object can flow through the full pipeline. The
// service silently no-ops when not configured/enabled.
watchFolder?.start();
