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
import { optionalServicesRouter } from './routes/optional-services.js';
import { OperationStore } from './services/operation-store.js';
import { ensureParameterStore, paramStoreFromEnv, type StackConfig } from './services/param-store.js';
import { PACKAGER_SERVICE_ID } from './services/stack.js';
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
import { ResolverHealthSignal } from './services/resolver-health.js';
import {
  PerWorkspaceAssetRepository,
  PerWorkspaceJobRepository,
  PerWorkspaceSearchRepository,
  PerWorkspaceWebhookRepository,
  PerWorkspaceCollectionRepository,
  PerWorkspaceProfileRepository
} from './data/per-workspace-repos.js';
import type { AssetRepository } from './data/asset-repo.js';
import { withTamsReadyIndexing, isTamsConfigured, type AssetIndexer } from './tams/tams-ready-hook.js';
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
import { checkProfilesIndexReachable } from './services/profiles-reachability.js';
import { PerWorkspacePipelineRepository } from './data/per-workspace-repos.js';
import { InMemoryCommentRepository } from './data/comment-repo.js';
import { adminRouter } from './routes/admin.js';
import { scalerRouter } from './routes/scaler.js';
import { retentionRouter, archiveRetentionMsFromEnv } from './routes/retention.js';
import { logsRouter } from './routes/logs.js';
import { LogStore } from './services/log-store.js';
import {
  ArchivedAssetPurgeLoop,
  archivePurgeIntervalMsFromEnv
} from './pipeline/archived-asset-purge-loop.js';
import type { PurgeStorage } from './pipeline/archived-asset-purge-sweep.js';
import { WatchFolderService, watchFolderEnabled } from './pipeline/watch-folder.js';
import { startEncoreCallbackPoller } from './pipeline/encore-callback-poller.js';
import {
  reconcileFailedTranscodes,
  settleFailedTranscode
} from './pipeline/failed-transcode-reconciler.js';
import { reconcileStalledPackages } from './pipeline/stalled-package-reconciler.js';
import { PackagingService, packagingPublicBaseUrl } from './pipeline/packaging.js';
import {
  PackagerEnsureSingleFlight,
  packagerOscApiFromContext
} from './services/packager-provisioning.js';
import { makeOscPackagerQueue } from './pipeline/osc-packager-queue.js';
import {
  resolvePublicBaseUrl,
  resolveEncoreProfilesUrl,
  resolveEncoreProfilesUrlFromParamStore
} from './services/public-base-url.js';
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

// maxParamLength defaults to 100 in Fastify, but object-storage multipart
// upload IDs are longer (~132 chars), so a real uploadId path parameter would
// otherwise fail to match the /:id/multipart/:uploadId/... routes (404). Raise
// the cap so the part-url / complete / abort routes accept real upload IDs.
const app = Fastify({ logger: true, maxParamLength: 500 });

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

// Route inventory for the spec/route parity check (issue #480). The onRoute
// hook fires synchronously for every route as it is registered — added here,
// before any router, so it captures the complete surface. It is a pure
// read-only collector with no request-path effect; the collected list is only
// consumed when OPENAPI_ROUTE_DUMP points at a file (see after app.listen).
const registeredRoutes: Array<{ method: string | string[]; url: string }> = [];
app.addHook('onRoute', (routeOptions) => {
  registeredRoutes.push({ method: routeOptions.method, url: routeOptions.url });
});

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
      { name: 'optional-services', description: 'Per-optional-service (auto-subtitles, scene-detect) provision, deprovision, and status' },
      { name: 'storage', description: 'Bucket and object-storage management' },
      { name: 'admin', description: 'Operational status and background service control' },
      { name: 'logs', description: 'Cursor-paged operational log stream' },
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

// Aggregate degraded-resolution signal for the stack resolver (issue #422).
// Created before the health endpoints and the resolver so both share one
// instance: the resolver writes it on every degraded fallback and /health reads
// it, giving operators a queryable/alertable signal that an instance is serving
// no-storage or stale last-known-good connections — without reading logs.
const resolverHealth = new ResolverHealthSignal();

// Health endpoints are intentionally unauthenticated for liveness probing. The
// `resolver` field (issue #422) reports the aggregate degraded-resolution state
// so a degraded-but-not-crashed instance is alertable from /health alone.
app.get('/health', async () => ({
  status: 'ok',
  service: 'open-videocore-api',
  resolver: resolverHealth.snapshot()
}));
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
  () => oscContext.getServiceAccessToken('eyevinn-app-config-svc'),
  // Diagnostic logger (issue #415): emits the exact StackConfig key written vs.
  // read so a persistence/read-back failure is attributable to one path.
  app.log
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
// OPTIONAL, opt-in pipeline steps are activated from the STACK RECORD, not
// boot-time env vars (issue #217). The resolver reads the ACTIVE stack's
// StackConfig.autoSubtitlesInstanceName / sceneDetectInstanceName at resolve
// time and, when present, builds the corresponding generator via these
// builders — so a freshly provisioned optional service is picked up on the next
// pipeline run with NO API restart. When object storage is unavailable the
// builders are omitted and the steps stay disabled (graceful skip). The
// runner-tuning knobs (AUTO_SUBTITLES_WRITES_S3, SCENE_DETECT_PATH) are NOT
// activation switches and remain here.
const storageBackedForOptionalSteps = Boolean(process.env['MINIO_URL']) || Boolean(paramStore);
const optionalStepBuilders = storageBackedForOptionalSteps
  ? {
      subtitleGenerator: (instanceName: string): SubtitleGenerator =>
        makeOscSubtitleGenerator({
          context: oscContext,
          getInstance,
          instanceName,
          writesToS3: process.env['AUTO_SUBTITLES_WRITES_S3'] === 'true'
        }),
      sceneDetector: (instanceName: string): SceneDetector =>
        makeOscSceneDetector({
          context: oscContext,
          getInstance,
          instanceName,
          path: process.env['SCENE_DETECT_PATH']
        })
    }
  : {};

const stackResolver = new WorkspaceStackResolver({
  paramStore,
  oscContext,
  minioPassword: process.env['MINIO_ROOT_PASSWORD'] ?? '',
  couchPassword: process.env['COUCHDB_ADMIN_PASSWORD'] ?? '',
  optionalSteps: optionalStepBuilders,
  // Aggregate degraded-resolution signal (issue #422): the resolver emits on
  // every no-storage / stale fallback so /health reports a degraded-but-not-
  // crashed instance without reading logs.
  resolverHealth,
  // Diagnostic/observability logger. Read-path diagnostics (issue #415): logs
  // the (namespace, stack name) the resolver reads with so a read-back miss
  // correlates with the write key. Also surfaces transient parameter-store
  // refresh failures instead of swallowing them (issue #419) so a subsequent
  // 501 from the storage routes is traceable.
  log: app.log
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

// In-memory operational log store backing GET /api/v1/logs (issue #473). There
// is no persistent log store today; this is the minimal append-only, sequence-
// keyed source that satisfies cursor paging + the log record shape, modelled on
// operationStore above. Registered by reference so future producers can append
// to the same instance the router reads.
const logStore = new LogStore();

await app.register(provisionRouter, {
  prefix: '/api/v1/provision',
  osc: oscContext,
  paramStore,
  operationStore,
  publicBaseUrl: resolvePublicBaseUrl(),
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

// Per-optional-service provision/deprovision/status endpoints (issue #195).
// Shared contract for the #187 (auto-subtitles) and #188 (scene-detect)
// provision cards. Reuses the SAME OperationStore as the whole-stack provision
// route so 202 operations poll the same GET /api/v1/provision/operations/:id.
// Status reports the AUTO_SUBTITLES_INSTANCE_NAME / SCENE_DETECT_INSTANCE_NAME
// env vars via the optional-services registry. NOTE: as of issue #217 the
// PIPELINE steps are activated from the stack record (StackConfig), not these
// env vars — so the card's env-var view reflects the deployment's intended
// configuration, while the runtime step activation follows what was actually
// provisioned into the active stack.
await app.register(optionalServicesRouter, {
  prefix: '/api/v1/optional-services',
  osc: oscContext,
  operationStore
});

// Workspace-scoped resource repositories. These hold NO connection of their
// own: each delegates to the concrete repository in the stack resolved for the
// request's workspace (CouchDB-backed when a stack is provisioned, in-memory
// otherwise — WorkspaceStackResolver decides). The router option interfaces and
// route handlers are unchanged; only the backing connection is now resolved
// lazily per workspace at request time instead of as a startup singleton.
// Base asset repository. Wrapped below by the TAMS "ready" indexing decorator
// so no other wiring changes are needed.
const baseAssetRepository = new PerWorkspaceAssetRepository(stackResolver);

// TAMS "ready"-transition indexing trigger (issue #172, epic #116). SINGLE
// chokepoint: `withTamsReadyIndexing` decorates the asset repository so every
// `update()` that transitions an asset INTO `ready` fires the injected indexer
// once — covering all four pipeline call sites (metadata-extractor, transcode,
// clip, rewrap) without editing any of them (see src/tams/tams-ready-hook.ts
// for the trigger-mechanism justification: an inline transition hook, since the
// ADR-005 CouchDB `_changes` projector does not exist — issue #168).
//
// Decoupling: the concrete single-asset index-write path (#170) and the shared
// config gate (#171) are not yet on main, so we import NEITHER here. The indexer
// is INJECTED. Until #170 lands there is no concrete indexer to inject, so
// `tamsIndexer` is undefined and the repository is left unwrapped (indexing is a
// no-op). When #170 provides `(asset) => Promise<void>`, assign it here and the
// decorator activates. The config gate is the inline ADR-009 `TAMS_STORE_URL`
// check inside the hook; #171 will supply the shared gate.
const tamsIndexer: AssetIndexer | undefined = undefined;
const assetRepository: AssetRepository = tamsIndexer
  ? withTamsReadyIndexing(baseAssetRepository, { indexer: tamsIndexer, log: app.log })
  : baseAssetRepository;
if (tamsIndexer && !isTamsConfigured()) {
  app.log.info('TAMS_STORE_URL not set — TAMS ready-transition indexing disabled (config-gated)');
}

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
// re-encode), writing the new child asset back to MinIO. Like the thumbnail
// extractor it is a factory so the route can supply the workspace's MinIO
// credentials (resolved from the stack config) at request time: the output goes
// to `s3://bucket/key` via the ffmpeg-s3 native S3 writer, so the runner needs
// the MinIO credentials + bucket in the job body. A presigned PUT URL does NOT
// work with ffmpeg's output muxer (issue #316). When object storage is missing
// POST /:id/export responds 501.
const rewrapRunner = storageAvailable
  ? (s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string }): RewrapRunner =>
      makeOscRewrapRunner({
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

const clipRunner: ClipRunner | undefined = storageAvailable
  ? makeOscClipRunner({
      context: oscContext,
      createJob,
      getJob,
      getLogsForInstance,
      removeJob
    })
  : undefined;

// Auto-subtitles (issue #114) and scene detection (issue #115) are OPTIONAL,
// opt-in pipeline steps. As of issue #217 their activation is derived from the
// STACK RECORD (StackConfig.autoSubtitlesInstanceName / sceneDetectInstanceName)
// rather than boot-time env vars: the stack resolver builds the per-stack
// generator (via optionalStepBuilders above) at resolve time and exposes it on
// request.connections, so the assets router reads it live per pipeline run. A
// freshly provisioned optional service is therefore picked up on the next run
// with NO restart; when the record carries no instance name the step stays
// disabled and skips gracefully (fire-and-forget, never throws).

// ABR transcoding via auto-scaling Encore pool (ADR-006). The scaler exposes
// the same EncoreClient interface as the old static client but manages a
// per-workspace pool of Encore OSC instances. Set ENCORE_MAX_INSTANCES=1 to
// cap the pool at a single instance (equivalent to the previous static behaviour).
// Requires a Redis connection (resolved from the parameter store after provisioning).
// When Redis is unavailable transcoding degrades to 501.
const encoreMaxInstances = parseInt(process.env['ENCORE_MAX_INSTANCES'] || '3', 10);
const encoreIdleTimeoutMs = parseInt(process.env['ENCORE_IDLE_TIMEOUT_MS'] || String(5 * 60 * 1000), 10);
// Bounded wait (issue #463) for the outbound TLS-trust probe to a freshly
// spawned instance's per-instance callback-listener ingress before that instance
// is eligible for its FIRST job. Closes the race between the ingress certificate
// becoming ready/trusted and the instance beginning to process (and fail) its
// first job. On timeout the instance is quarantined from job assignment rather
// than dispatched to. Defaults to 60s; override via ENCORE_CALLBACK_TRUST_TIMEOUT_MS.
const encoreCallbackTrustTimeoutMs = parseInt(process.env['ENCORE_CALLBACK_TRUST_TIMEOUT_MS'] || String(60 * 1000), 10);
// Bounded timeout (issue #273) for the failed-transcode reconciliation sweep: a
// transcode still non-terminal after this long whose Encore record has been
// garbage-collected (getJobStatus -> 404/undefined) is declared failed rather
// than left running forever. Defaults to 30 minutes.
const encoreStallTimeoutMs = parseInt(process.env['ENCORE_STALL_TIMEOUT_MS'] || String(30 * 60 * 1000), 10);
// Bounded timeout (issue #336) for the stalled-package reconciliation sweep: a
// pipeline `package` step still `running` after this long — because no packager
// instance consumed the queued job, the packager stalled, or its completion
// callback was never delivered — is declared failed with a diagnostic message
// rather than left running forever (observed 22 min / 7 min stuck runs). The
// packager callback settles a healthy job long before this fires. Defaults to
// 15 minutes; override via PACKAGE_STALL_TIMEOUT_MS.
const packageStallTimeoutMs = parseInt(process.env['PACKAGE_STALL_TIMEOUT_MS'] || String(15 * 60 * 1000), 10);

// Instance-global archive retention window in ms (issue #325, foundation for
// #323). Read from ARCHIVE_RETENTION_MS at boot; unset/0 = never purge, which is
// behaviourally identical to today's every-deployment default. Held as a live
// mutable var so PATCH /api/v1/retention/config hot-swaps it with no restart,
// mirroring how the scaler config PATCH mutates its live vars.
let archiveRetentionMs = archiveRetentionMsFromEnv();

// The default Encore profile index used to seed the profile store on first
// startup / on bootstrap. Same URL + default as before (issue #84).
const encoreProfilesUrl =
  process.env['ENCORE_PROFILES_URL'] ??
  'https://raw.githubusercontent.com/Eyevinn/encore-test-profiles/refs/heads/main/profiles.yml';

// Publicly-reachable base URL of this API, used to build the `profilesUrl` we
// hand to each Encore instance the scaler spawns so Encore fetches profiles
// from our own GET /api/v1/profiles/index.yml. Resolved via the single
// resolvePublicBaseUrl() seam (issue #219): explicit PUBLIC_BASE_URL override →
// OSC-derived app URL (none available today) → unset. When unset the scaler
// falls back to the remote default index (previous behaviour), so Encore still
// works.
// Precedence (see resolveEncoreProfilesUrl): explicit ENCORE_PROFILES_URL_OVERRIDE
// direct override → derived ${PUBLIC_BASE_URL}/api/v1/profiles/index.yml → remote
// default (encoreProfilesUrl). Either operator-set env var lets an operator point
// Encore at the local profile store; #283 confirmed OSC exposes no runtime self-URL,
// so an explicit value is the only lever.
const publicBaseUrl = resolvePublicBaseUrl();
// Tier 3 (issue #315): resolve an operator-supplied full profiles-index URL from
// the provisioned stack record at boot, where the parameter store is already
// awaited (see paramStore above). Undefined when there is no store, no stack, or
// the field is unset — in which case resolveEncoreProfilesUrl falls through to
// the remote default, byte-identical to pre-#315 behaviour.
const paramStoreProfilesUrl =
  publicBaseUrl || process.env['ENCORE_PROFILES_URL_OVERRIDE']
    ? undefined // env-var seams (tier 1/2) win; skip the param-store read entirely
    : await resolveEncoreProfilesUrlFromParamStore({
        paramStore,
        namespace: STACK_CONFIG_NAMESPACE,
        onError: (err) =>
          app.log.warn(
            { err },
            'profiles URL: failed to resolve from parameter store; falling back to remote default index'
          )
      });
const encoreScalerProfilesUrl = resolveEncoreProfilesUrl(
  encoreProfilesUrl,
  paramStoreProfilesUrl
);
if (
  !publicBaseUrl &&
  !process.env['ENCORE_PROFILES_URL_OVERRIDE'] &&
  !paramStoreProfilesUrl
) {
  app.log.warn('profiles URL unresolved to local store (neither PUBLIC_BASE_URL nor ENCORE_PROFILES_URL_OVERRIDE set, no parameter-store value / no OSC-derived app URL) — Encore instances will fetch profiles from the remote default index instead of the local profile store');
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

  // Best-effort probe (issue #336): does a packager instance currently exist for
  // this stack? The packager instance shares the stack name (like every
  // STACK_SERVICES instance — see services/packager-provisioning.ts), so a
  // getInstance(name = stackName) is the ground-truth existence check. Used ONLY
  // to shape the stalled-package diagnostic (present=true => "no completion
  // signal"; present=false => "no packager instance"). Any failure surfaces as a
  // thrown probe, which the reconciler catches and renders as present=unknown —
  // it never gates the bounded timeout.
  const probePackagerPresent = async (): Promise<boolean> => {
    if (!paramStore) {
      throw new Error('parameter store unavailable; cannot resolve stack name');
    }
    const names = await paramStore.listStackNames(STACK_CONFIG_NAMESPACE);
    if (names.length === 0) {
      throw new Error('no provisioned stack; cannot resolve packager instance');
    }
    const stackName = names[0]!;
    const packagerApi = packagerOscApiFromContext(oscContext);
    const sat = await packagerApi.getServiceAccessToken(PACKAGER_SERVICE_ID);
    const instance = await packagerApi.getInstance(
      PACKAGER_SERVICE_ID,
      stackName,
      sat
    );
    return instance !== undefined && instance !== null;
  };

  scalerRegistry = new WorkspaceEncoreScalerRegistry({
    redis,
    redisUrl,
    minInstances: parseInt(process.env['ENCORE_MIN_INSTANCES'] || '0', 10),
    oscContext,
    maxInstances: encoreMaxInstances,
    idleTimeoutMs: encoreIdleTimeoutMs,
    // Gate first-job dispatch on confirmed outbound callback-listener TLS trust
    // (issue #463): bounded wait before a freshly spawned instance is eligible.
    callbackTrustTimeoutMs: encoreCallbackTrustTimeoutMs,
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
    },
    // Durably capture each Encore dispatch on the Job record (ADR-012, #380).
    // The scaler already records the attempt count in the TTL'd Valkey key and
    // clears it on re-dispatch/settle; this appends the same attempt to the
    // CouchDB-backed encodeAttemptLog so the history survives after the Valkey
    // key expires (#374 reads attempts after the job finishes). The scaler owns
    // no repositories, so we resolve the job here by its encoreJobId. Best-
    // effort: the scaler swallows failures so a durable-write hiccup never
    // re-queues an already-dispatched job.
    onEncodeDispatched: async (encoreJobId: string, attempt: number) => {
      const found = await jobRepository.findByEncoreJobId(encoreJobId);
      if (!found) return;
      await jobRepository.appendEncodeAttempt(found.job.id, { index: attempt });
    },
    // Once per tick, reconcile transcode jobs stuck non-terminal against Encore's
    // terminal FAILED / garbage-collected (404) outcomes (issue #273). A failed
    // Encore job never produces a completion message (the callback listener only
    // enqueues SUCCESSFUL jobs), so without this the VideoCore job stays
    // `running` and its asset `processing` forever. The scaler owns no repos, so
    // we supply the repo-driven sweep here; `scalerRegistry` is the EncoreClient
    // whose getJobStatus() polls Encore. Best-effort: errors are swallowed inside
    // the sweep so a reconcile failure never breaks the tick.
    reconcileFailedTranscodes: async () => {
      await reconcileFailedTranscodes({
        jobs: jobRepository,
        assets: assetRepository,
        pipeline: pipelineRepository,
        // scalerRegistry implements EncoreClient; getJobStatus() decodes the
        // workspace from the encore job id and polls the right instance. It is
        // assigned below (encore = scalerRegistry) before any tick fires.
        encore: scalerRegistry!,
        stallTimeoutMs: encoreStallTimeoutMs,
        logger: {
          info: (...a: unknown[]) => app.log.info(a),
          warn: (...a: unknown[]) => app.log.warn(a)
        }
      });
      // Bound the `package` pipeline step (issue #336) on the same tick: a
      // `package` step still `running` past packageStallTimeoutMs is failed with
      // a diagnostic distinguishing "no packager instance" from "no completion
      // signal". The packager step is advanced ONLY by the packager completion
      // callback, so without this bound a missing packager / lost callback /
      // stalled packager job leaves it running forever. Best-effort: the sweep
      // swallows per-execution errors and never throws into the tick.
      await reconcileStalledPackages({
        pipeline: pipelineRepository,
        // Best-effort presence probe used ONLY to shape the diagnostic message.
        // It resolves the stack name (the packager instance shares it) and asks
        // OSC whether a packager instance exists. Any failure -> undefined, and
        // the message degrades to present=unknown rather than mis-attributing a
        // cause. Never gates the timeout.
        packagerPresent: probePackagerPresent,
        stallTimeoutMs: packageStallTimeoutMs,
        logger: {
          info: (...a: unknown[]) => app.log.info(a),
          warn: (...a: unknown[]) => app.log.warn(a)
        }
      });
    },
    // When the scaler's reconcile() detects that tracked jobs have silently
    // vanished from an Encore instance's live QUEUED/IN_PROGRESS set with no
    // completion callback (issue #449, ADR-016 Direction 2 — reconcile-driven
    // terminal settle), it raises the ids here. The scaler owns no repositories,
    // so main.ts performs the terminal write: resolve each id to its Job (by the
    // encoreJobId / externalId it was submitted with, as onDispatched does) and
    // route it through the SAME idempotent settle path the #273 sweep uses
    // (completeTranscode({ success: false }) + pipeline-lock release). Reusing
    // settleFailedTranscode guarantees identical asset/pipeline side-effects and
    // first-terminal-write-wins idempotency, so a late SUCCESSFUL callback cannot
    // clobber the settle. Best-effort per id: one job's failure never blocks the
    // rest, and the scaler already swallows a thrown hook.
    // #515: when the scaler classifies a job 'interrupted_by_scaledown' at the
    // drain boundary (#514) and re-enqueues it for auto-retry, annotate the
    // caller-facing Job record with the distinguishable, recoverable reason so a
    // Media Developer can tell an interruption apart from a genuine media
    // failure. This is an ADDITIVE annotation ONLY: the job stays `running`
    // (it is being auto-retried), so the status enum is untouched and existing
    // consumers are unaffected. The scaler owns no repositories, so we resolve
    // the job here by its encoreJobId (externalId), exactly as onDispatched does.
    // Best-effort: the scaler swallows a thrown hook so a repo hiccup never
    // blocks the re-enqueue that already succeeded.
    onJobInterrupted: async (encoreJobId: string, reason: 'interrupted_by_scaledown') => {
      const found = await jobRepository.findByEncoreJobId(encoreJobId);
      if (!found) return;
      await jobRepository.update(found.job.id, {
        interrupted: true,
        interruptionReason: reason
      });
    },
    onJobsDropped: async (encoreJobIds: string[]) => {
      for (const encoreJobId of encoreJobIds) {
        try {
          const found = await jobRepository.findByEncoreJobId(encoreJobId);
          if (!found) continue;
          await settleFailedTranscode(
            {
              jobs: jobRepository,
              assets: assetRepository,
              pipeline: pipelineRepository,
              logger: {
                info: (...a: unknown[]) => app.log.info(a),
                warn: (...a: unknown[]) => app.log.warn(a)
              }
            },
            found.job,
            'dropped by Encore: gone from active set with no completion'
          );
        } catch (err) {
          app.log.warn({ err, encoreJobId }, 'encore-scaler: onJobsDropped settle failed');
        }
      }
    }
  });
  encore = scalerRegistry;

  // HLS/DASH packaging (issue #9). The eyevinn-encore-packager consumes a Valkey
  // queue and writes CMAF output to the packaged MinIO bucket; we enqueue jobs
  // and receive a completion callback.
  packaging = new PackagingService({
    assets: assetRepository,
    queue: makeOscPackagerQueue(redis, undefined, app.log),
    publicBaseUrl: packagingPublicBaseUrl()
  });

  // On-demand packager provisioning (epic #226, issue #244). The packager is no
  // longer provisioned at stack-provision time (issue #243): this closure is
  // invoked the first time a pipeline reaches a `package` step (assets router
  // `ensurePackaging`). It resolves the stack's coordinates from the parameter
  // store, then provisions + wires the packager to THIS activated stack Valkey
  // (`redisUrl`) and packaged-output storage if absent, waiting for readiness
  // before returning so the packaging job is only enqueued once the packager is
  // live. It is idempotent (reconciles against OSC ground truth via getInstance)
  // and reuses the running instance on subsequent executions. Issue #245 wraps
  // this in a per-stack single-flight guard for concurrent first executions.
  //
  // Requires the MinIO root password (packager S3 secret) and the OSC PAT
  // (packager fetches Encore job data). When either is missing this is a no-op
  // (undefined), so packaging degrades to the pre-#244 behaviour rather than
  // failing the pipeline.
  // Hold the ensure closure in a local so the SAME reference can be handed both to
  // the assets router (manual package-start path) and to the callback poller (the
  // automatic transcode->package handoff, #496). deactivateScaler() clears
  // assetRouterOptions.ensurePackaging on teardown, so the poller must NOT read
  // that field at call time — it would go stale independently. Since the poller's
  // lifecycle is bound to this same activation (started below, stopped in
  // deactivateScaler), capturing the closure directly keeps it valid for exactly
  // as long as the poller runs.
  let ensurePackaging: (() => Promise<void>) | undefined;
  const packagerMinioPassword = process.env['MINIO_ROOT_PASSWORD'];
  const packagerPat = oscContext.getPersonalAccessToken();
  if (packagerMinioPassword && packagerPat) {
    const packagerApi = packagerOscApiFromContext(oscContext);
    // Per-stack single-flight guard (issue #245): N concurrent first-execution
    // requests collapse onto one ensure run per stack, so exactly one packager
    // is provisioned. Combined with the ground-truth reconciliation inside
    // ensurePackagerProvisioned (getInstance check + "already taken" tolerance),
    // a restart mid-provision self-heals without orphaning/duplicating. One
    // guard per activation; cleared implicitly when the scaler deactivates and
    // the ensurePackaging closure is dropped.
    const packagerEnsureGuard = new PackagerEnsureSingleFlight();
    ensurePackaging = async () => {
      // Resolve the stack (name + MinIO endpoint + packaged bucket) whose Valkey
      // this activation is bound to. Mirrors resolveStackRedisUrl: the first
      // provisioned stack for the namespace is the default.
      //
      // Issue #335: this resolution used to swallow failures — a param-store
      // error was warn-logged, and an unresolvable stack returned silently — so
      // the packager was never created, no error surfaced, and packaging hung
      // invisibly. It now FAILS LOUDLY: a param-store error and unresolvable
      // coordinates both throw, so the package step transitions to `failed` with
      // a message identifying the cause instead of no-op'ing.
      if (!paramStore) {
        throw new Error(
          'on-demand packager: parameter store is not configured, cannot resolve stack coordinates for provisioning'
        );
      }
      let stackName: string | undefined;
      let minioEndpoint: string | undefined;
      let packagedBucket = outputBucket;
      let stackCfg: StackConfig | undefined;
      try {
        const names = await paramStore.listStackNames(STACK_CONFIG_NAMESPACE);
        if (names.length > 0) {
          stackName = names[0];
          stackCfg = await paramStore.loadStackConfig(
            STACK_CONFIG_NAMESPACE,
            names[0]!
          );
          if (stackCfg?.minioEndpoint) minioEndpoint = stackCfg.minioEndpoint;
          if (stackCfg?.packagedBucket) packagedBucket = stackCfg.packagedBucket;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error(
          { err },
          'on-demand packager: failed to resolve stack coordinates'
        );
        throw new Error(
          `on-demand packager: failed to resolve stack coordinates: ${message}`
        );
      }
      if (!stackName || !minioEndpoint) {
        // No resolvable stack coordinates — cannot provision the packager onto a
        // known stack. Fail loudly (issue #335) rather than silently skipping,
        // which left packaging jobs on a queue with no consumer.
        app.log.error(
          { stackName },
          'on-demand packager: stack coordinates unavailable, cannot provision'
        );
        throw new Error(
          'on-demand packager: stack coordinates unavailable (no provisioned stack or missing MinIO endpoint), cannot provision packager'
        );
      }
      const resolvedStackName = stackName;
      const result = await packagerEnsureGuard.run({
        osc: packagerApi,
        coords: {
          stackName: resolvedStackName,
          redisUrl,
          minioEndpoint,
          packagedBucket,
          publicBaseUrl
        },
        secrets: {
          minioRootPassword: packagerMinioPassword,
          oscPersonalAccessToken: packagerPat
        },
        log: app.log,
        // Record the created packager in the stack's service inventory (issue
        // #335 acceptance). The packager shares the stack name and is NOT part of
        // STACK_SERVICES, so it was previously absent from services[]. We append
        // it (idempotently) so the inventory reflects reality and deprovision can
        // see it. Best-effort ground-truth read-modify-write against the stored
        // config; a failure here rethrows into the ensure step (fail loud).
        recordInInventory: async (instanceName) => {
          const current = await paramStore.loadStackConfig(
            STACK_CONFIG_NAMESPACE,
            resolvedStackName
          );
          if (!current) {
            app.log.warn(
              { stackName: resolvedStackName },
              'on-demand packager: stack config missing, cannot record packager in inventory'
            );
            return;
          }
          const already = current.services.some(
            (s) =>
              s.serviceId === PACKAGER_SERVICE_ID &&
              s.instanceName === instanceName
          );
          if (already) return;
          const updated: StackConfig = {
            ...current,
            services: [
              ...current.services,
              { serviceId: PACKAGER_SERVICE_ID, instanceName }
            ]
          };
          await paramStore.storeStackConfig(
            STACK_CONFIG_NAMESPACE,
            resolvedStackName,
            updated
          );
          app.log.info(
            { stackName: resolvedStackName, serviceId: PACKAGER_SERVICE_ID },
            'on-demand packager: recorded instance in stack inventory'
          );
        }
      });
      if (result.status === 'created') {
        app.log.info({ stackName: resolvedStackName }, 'on-demand packager provisioned');
      }
    };
    // Manual package-start path (src/routes/assets.ts:1484) reads this off opts.
    assetRouterOptions.ensurePackaging = ensurePackaging;
  }

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
    // #464: bounds for the independent job-status reconciliation sweep. All keep
    // the poller's own defaults (30s interval, page size 100, no instance cap)
    // when the env var is unset, so behaviour is unchanged out of the box.
    sweepIntervalMs: process.env['ENCORE_SWEEP_INTERVAL_MS']
      ? parseInt(process.env['ENCORE_SWEEP_INTERVAL_MS'], 10)
      : undefined,
    sweepPageSize: process.env['ENCORE_SWEEP_PAGE_SIZE']
      ? parseInt(process.env['ENCORE_SWEEP_PAGE_SIZE'], 10)
      : undefined,
    sweepMaxInstances: process.env['ENCORE_SWEEP_MAX_INSTANCES']
      ? parseInt(process.env['ENCORE_SWEEP_MAX_INSTANCES'], 10)
      : undefined,
    // On-demand packager provisioning for the automatic transcode->package handoff
    // (#496). The SAME closure the assets router uses for the manual package-start
    // path — captured directly (not read off assetRouterOptions, which
    // deactivateScaler clears independently). undefined when the packager secrets
    // are absent, exactly as for the manual path, so the handoff is a no-op then.
    ensurePackaging,
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
  assetRouterOptions.ensurePackaging = undefined;
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
  packaging,
  packagingRedis: sharedRedis,
  pipelineRepository,
  commentRepository,
  // Profile store for per-profile profileParams key validation (issue #290)
  // and for validating a named transcode profile so a GPU-only (NVENC/CUDA)
  // profile that cannot run on this platform is rejected 422 before submission
  // (issue #286).
  profileRepository
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
  pipelineRepository,
  // Post-package relocation (issue #208, ADR-011). Resolve the stack's MinIO
  // client + packaged/staging bucket at callback time so a packaging success can
  // server-side-copy this execution's output to a per-execution
  // `destinationBucket` override. Reuses the resolver-built MinioClient
  // (workspace-stack.ts) — no new client construction here. Returns undefined
  // when the resolved stack has no storage configured (no override relocation is
  // then possible; executions without an override are unaffected regardless).
  resolveRelocation: async () => {
    const conns = await stackResolver.resolve();
    if (!conns.storageClient) return undefined;
    return { client: conns.storageClient, packagedBucket: conns.packagedBucket };
  }
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

// Registered UNCONDITIONALLY (mirroring assetsRouter above, main.ts:1184) so
// the upload/multipart routes always enter the route tree and therefore the
// generated OpenAPI spec (issue #479). When object storage is not wired,
// storageFor is undefined and every storage-backed handler responds 501
// not_configured rather than the whole router silently disappearing.
await app.register(assetUploadRouter, {
  prefix: '/api/v1/assets',
  repository: assetRepository,
  storageFor: storageAvailable ? storageFor : undefined,
  onObjectStored
});

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

// Archive retention config (issue #325, foundation for #323). Instance-global,
// hot-reloadable retention window read from ARCHIVE_RETENTION_MS at boot (unset/0
// = never purge, identical to today). Registered by reference and mirrors the
// scaler config mechanism: PATCH /api/v1/retention/config hot-swaps the window
// via a live mutable var + onConfigChange, no restart required.
const retentionRouterOptions: Parameters<typeof retentionRouter>[1] & { prefix: string } = {
  prefix: '/api/v1/retention',
  retentionMs: archiveRetentionMsFromEnv(),
  onConfigChange: (cfg) => {
    archiveRetentionMs = cfg.retentionMs;
  }
};
await app.register(retentionRouter, retentionRouterOptions);

// Operational logs listing (issue #473). Cursor/sequence-paged, newest-first,
// append-only log stream over the in-memory logStore. Offset paging is
// deliberately excluded (#371): only a bounded `limit` + opaque `cursor`, so
// appended entries never shift an in-flight page.
await app.register(logsRouter, { prefix: '/api/v1/logs', logStore });

// Archived-asset retention purge sweep (issue #327, part of #323). An
// INDEPENDENT unref'd, overlap-guarded interval — NOT folded into the Encore
// scaler tick — that purges archived assets past the retention window and
// replaces each with a tombstone. Wired here alongside startEncoreCallbackPoller
// (started inside activateScaler above). It reads the LIVE `archiveRetentionMs`
// each tick, so it honours PATCH /api/v1/retention/config and is skipped
// entirely while retention is unset (0/disabled). All sweep deps are resolved
// per tick from the (default) stack connections so the sweep targets the same
// concrete repo + buckets the request path uses.
//
// purgeToTombstone is NOT on the AssetRepository interface (it is a concrete
// method on CouchAssetRepository / InMemoryAssetRepository), so the sweep's
// `purge` callback resolves the concrete `.assets` repo and invokes it directly.
const archivedAssetPurgeLoop = new ArchivedAssetPurgeLoop({
  retentionMs: () => archiveRetentionMs,
  logger: {
    info: (...a: unknown[]) => app.log.info(a),
    warn: (...a: unknown[]) => app.log.warn(a),
    error: (...a: unknown[]) => app.log.error(a)
  },
  sweepDeps: {
    assets: assetRepository,
    // Resolve the concrete repo and call its purgeToTombstone (doc-replace to a
    // tombstone). Present on both concrete implementations; typed loosely here
    // because it is not on the shared AssetRepository interface.
    purge: async (assetId: string) => {
      const conns = await stackResolver.resolve();
      const concrete = conns.assets as unknown as {
        purgeToTombstone?: (id: string) => Promise<string | undefined> | boolean;
      };
      if (typeof concrete.purgeToTombstone !== 'function') {
        throw new Error('resolved asset repository does not support purgeToTombstone');
      }
      return concrete.purgeToTombstone(assetId);
    },
    // Build a WorkspaceStorage per target bucket from the resolved stack's MinIO
    // client (mirrors GET /:id/files). Returns undefined when object storage is
    // not configured — the sweep then records the tombstone without object
    // removal, and a later tick reclaims stragglers once storage is available.
    storageForBucket: (bucket: string): PurgeStorage | undefined => {
      const conns = stackResolver.resolveCached();
      if (!conns?.storageClient) return undefined;
      return new WorkspaceStorage(conns.storageClient, bucket);
    },
    sourceBucket
  }
});
archivedAssetPurgeLoop.start(archivePurgeIntervalMsFromEnv());

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

// Spec/route parity check support (issue #480). When OPENAPI_ROUTE_DUMP is set,
// the app has now finished registering every router (onRoute has fired for all
// of them). Write the captured route inventory to that path and exit cleanly,
// BEFORE the background loops below spin up — those need live OSC connectivity
// that the parity check does not. This makes the enumeration reuse the real
// boot path (identical to generate-openapi.sh) rather than a hand-maintained
// route list that could itself drift.
const routeDumpPath = process.env['OPENAPI_ROUTE_DUMP'];
if (routeDumpPath) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(routeDumpPath, JSON.stringify(registeredRoutes, null, 2));
  app.log.info({ routeDumpPath, count: registeredRoutes.length }, 'openapi route dump written; exiting');
  await app.close();
  process.exit(0);
}

// Boot-time reachability self-check for the local Encore profiles index (#284).
// The server is now listening and every router (incl. profilesRouter) is
// registered, so the derived profiles URL — encoreScalerProfilesUrl — is fully
// known and serveable. When it points at THIS app's own local
// /api/v1/profiles/index.yml (i.e. publicBaseUrl resolved), fetch it exactly as
// Encore would: an UNAUTHENTICATED GET, no bearer token. A 401/403 (the OSC
// login wall still gating the path) or any unreachable result is logged as a
// HARD ERROR, so a silent fallback to the remote default index — which would
// quietly disable operator-managed profiles — is surfaced loudly. Non-fatal:
// it never throws and the server keeps running. This is the mechanism that
// confirms, at boot, whether OSC's 2026-07-08 promise to make /api/v1/profiles
// publicly accessible for the app actually took effect (this environment cannot
// reach live OSC to confirm it ahead of time).
void checkProfilesIndexReachable({
  profilesIndexUrl: encoreScalerProfilesUrl,
  usingLocalIndex: Boolean(publicBaseUrl),
  log: app.log
}).catch((err) => app.log.error({ err }, 'profiles-index reachability check errored unexpectedly'));

// Start watch-folder ingest only after the server is listening and every router
// is registered, so a detected object can flow through the full pipeline. The
// service silently no-ops when not configured/enabled.
watchFolder?.start();
