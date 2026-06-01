import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Context } from '@osaas/client-core';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';
import { provisionRouter } from './routes/provision.js';
import { registerAuth } from './auth/middleware.js';
import { assetsRouter } from './routes/assets.js';
import { assetUploadRouter, type StorageFactory } from './routes/asset-upload.js';
import { jobsRouter } from './routes/jobs.js';
import { couchServer, WorkspaceCouch } from './data/couchdb.js';
import { CouchAssetRepository } from './data/couch-asset-repo.js';
import { CouchJobRepository } from './data/couch-job-repo.js';
import { InMemoryAssetRepository, type AssetRepository } from './data/asset-repo.js';
import { InMemoryJobRepository, type JobRepository } from './data/job-repo.js';
import { WorkspaceStorage } from './data/storage.js';
import { makeS3Reader } from './pipeline/source.js';
import { makeOscProbeRunner } from './pipeline/osc-ffprobe.js';
import { extractTechnicalMetadata, type ProbeRunner } from './pipeline/metadata-extractor.js';
import { internalRouter } from './routes/internal.js';
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
await app.register(helmet);

// OSC context — reads OSC_ACCESS_TOKEN from environment.
// On OSC this is injected at runtime; locally set it in .env.
const oscContext = new Context();

// Auth: decorate request.workspaceId and register the `authenticate`
// preHandler. Workspace-scoped routers attach it via { onRequest: app.authenticate }.
registerAuth(app);

// Health endpoints are intentionally unauthenticated for liveness probing.
app.get('/health', async () => ({ status: 'ok', service: 'open-videocore-api' }));
app.get('/healthz', async () => ({ status: 'ok' }));

await app.register(provisionRouter, { prefix: '/api/v1/provision', osc: oscContext });

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

// Workspace-scoped resource routers. All resources are namespaced by the
// workspaceId derived from the caller's OSC token (issue #20).
const assetRepository = buildAssetRepository();
const jobRepository = buildJobRepository();
const storage = buildStorage();

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
  outputBucket
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
  repository: assetRepository
});

if (storage) {
  await app.register(assetUploadRouter, {
    prefix: '/api/v1/assets',
    repository: assetRepository,
    storageFor: storage.storageFor,
    // On upload completion, fire-and-forget ffprobe extraction (issue #6).
    onObjectStored: probe
      ? (workspaceId, assetId, objectKey) =>
          void extractTechnicalMetadata(
            { workspaceId, assetId, objectKey },
            { assets: assetRepository, storage: storage.storageFor(workspaceId), probe }
          )
      : undefined
  });
}
// TODO: register further routers here as surfaces are implemented, passing oscContext
// await app.register(searchRouter,    { prefix: '/api/v1/search' });

const port = parseInt(process.env['PORT'] ?? '3000', 10);
await app.listen({ port, host: '0.0.0.0' });
