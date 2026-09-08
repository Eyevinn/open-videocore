// Direct client-side upload routes (issue #4).
//
// These routes let a client push asset bytes straight to MinIO via presigned
// URLs, without the bytes ever transiting the API process. Two paths:
//
//   single-part:  POST /:id/upload-url            -> one presigned PUT URL
//   multipart:    POST /:id/multipart/initiate     -> uploadId
//                 GET  /:id/multipart/:uploadId/part-url?partNumber=N
//                 POST /:id/multipart/:uploadId/complete  (parts -> object)
//                 DELETE /:id/multipart/:uploadId          (abort/cleanup)
//
// Completion is an EXPLICIT client call (not a bucket-event webhook): once the
// object exists the client POSTs /:id/upload-complete, which transitions the
// asset uploading -> processing through the shared state machine. This keeps
// us off MinIO bucket-notification configuration on OSC (see ADR-001).
//
// Every route is behind `authenticate`, so request.workspaceId is validated.
// The asset is looked up through the workspace-scoped repository first; an
// asset in another workspace (or a non-existent one) resolves to 404 and never
// leaks existence. Object keys are derived server-side from the asset id and
// forced under the workspace prefix by WorkspaceStorage, so a caller cannot
// target another workspace's keyspace.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { InvalidStateTransitionError, type AssetRepository } from '../data/asset-repo.js';
import { WorkspaceAccessError } from '../data/guard.js';
import { uploadUrlTtlSeconds, SourceTooLargeError, type CompletedPart, type WorkspaceStorage } from '../data/storage.js';
import { QuotaExceededError, type StorageQuotaGuard } from '../data/storage-quota.js';

// Factory so production wires a real MinIO-backed WorkspaceStorage per request
// (bound to the caller's workspace) while tests inject a fake. Mirrors the
// repository-injection pattern used by the assets router.
export type StorageFactory = () => WorkspaceStorage;

export type AssetUploadRouterOptions = {
  repository: AssetRepository;
  // Per-request MinIO wrapper factory. When undefined (no object storage wired
  // on this deployment) the router is still registered — so its routes appear
  // in the route tree and the generated OpenAPI spec (issue #479) — but every
  // storage-backed handler responds 501 not_configured. Mirrors the assets
  // router's optional-storage degradation (routes/assets.ts:595).
  storageFor?: StorageFactory;
  // Fire-and-forget technical metadata extraction (issue #6). When provided,
  // upload-complete kicks off an ffprobe extraction against the freshly stored
  // object. Detached and non-blocking; never throws. Absent in deployments
  // without an ffprobe runner, in which case upload-complete behaves as before.
  // The storage instance is passed so the callback uses the already-resolved
  // workspace storage (which carries the correct stack) rather than trying to
  // re-resolve it from the cache, which may not have a bare-workspaceId entry
  // when the request came in with an X-Stack-Name header.
  onObjectStored?: (assetId: string, objectKey: string, storage?: WorkspaceStorage) => void;
  // Operator-configured total storage cap (issue #579, ADR-020). When provided,
  // direct-upload ingest is admitted through the running-total counter: the
  // proxied PUT reserves headroom (Content-Length hint) before accepting bytes
  // and commits the TRUE size on success; the explicit upload-complete finalize
  // (single-part presigned + multipart) admits post-hoc against the committed
  // object's real size (statObject). An over-cap ingest is rejected 409
  // quota_exceeded. Absent => no cap, behaviour unchanged (opt-in).
  quota?: StorageQuotaGuard;
};

// Deterministic object key for an asset's source payload. Workspace scoping is
// applied by WorkspaceStorage on top of this; here we only namespace by asset.
export function sourceObjectKey(assetId: string): string {
  return `sources/${assetId}`;
}

// S3/MinIO multipart part numbers are 1..10000.
const partNumberSchema = z.coerce.number().int().min(1).max(10000);

const idParams = z.object({ id: z.string().min(1) });
const multipartParams = z.object({ id: z.string().min(1), uploadId: z.string().min(1) });

const completeBody = z.object({
  parts: z
    .array(
      z.object({
        partNumber: partNumberSchema,
        etag: z.string().min(1)
      })
    )
    .min(1)
    .max(10000)
});

const urlResponse = z.object({
  url: z.string(),
  objectKey: z.string(),
  method: z.string(),
  expiresInSeconds: z.number()
});

const initiateResponse = z.object({
  uploadId: z.string(),
  objectKey: z.string(),
  expiresInSeconds: z.number()
});

const partUrlResponse = z.object({
  url: z.string(),
  partNumber: z.number(),
  expiresInSeconds: z.number()
});

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

const assetStatusResponse = z.object({
  id: z.string(),
  status: z.string()
});

export const assetUploadRouter: FastifyPluginAsync<AssetUploadRouterOptions> = async (
  fastify,
  opts
) => {
  // Pass any non-JSON body through as a stream so PUT /:id/upload can pipe it
  // to MinIO. Scoped to this plugin — does not affect other routers.
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { repository: repo, storageFor, quota } = opts;

  // Uniform 501 for storage-backed handlers when no object storage is wired.
  // The routes are always registered (so they appear in the spec, issue #479);
  // this keeps runtime behaviour clean when storage is absent instead of the
  // whole router silently disappearing.
  const notConfigured = 'object storage is not configured';

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof WorkspaceAccessError) {
      return reply.code(err.statusCode).send({ error: 'forbidden', message: err.message });
    }
    if (err instanceof InvalidStateTransitionError) {
      return reply.code(422).send({ error: 'invalid_state_transition', message: err.message });
    }
    // Total storage cap exceeded (issue #579). Machine-readable 409 quota_exceeded.
    if (err instanceof QuotaExceededError) {
      return reply.code(err.statusCode).send({ error: err.reason, message: err.message });
    }
    throw err;
  });


  // Look the asset up. Returns undefined (-> 404) for a missing asset.
  async function loadAsset(id: string) {
    return repo.get(id);
  }

    // --- Proxied upload: PUT /:id/upload -----------------------------------
  // The client streams the file body directly to the API; the API pipes it
  // to MinIO. This avoids exposing MinIO presigned URLs to the browser and
  // means no S3 CORS configuration is required on the bucket.
  //
  // The Content-Length header is forwarded to MinIO so it can pre-allocate
  // the multipart threshold correctly. When the browser omits Content-Length
  // (e.g. chunked transfer) MinIO still accepts the stream but may buffer.
  app.put(
    '/:id/upload',
    {
      
      bodyLimit: 10 * 1024 * 1024 * 1024, // 10 GiB — body is streamed, not buffered
      schema: { params: idParams, response: { 200: assetStatusResponse, 404: errorSchema, 409: errorSchema, 413: errorSchema, 501: errorSchema } }
    },
    async (request, reply) => {
      if (!storageFor) {
        return reply.code(501).send({ error: 'not_configured', message: notConfigured });
      }
      const asset = await loadAsset(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const storage = storageFor();
      const objectKey = sourceObjectKey(asset.id);
      const contentLength = request.headers['content-length']
        ? Number(request.headers['content-length'])
        : undefined;

      // Reserve quota headroom BEFORE accepting bytes (issue #579). The
      // Content-Length hint sizes the reservation; when absent we reserve 0 and
      // rely on the commit-time true size (+ reconciliation). A reservation that
      // would breach the cap throws QuotaExceededError -> 409 quota_exceeded
      // (handled above) before a single byte is written.
      const reservation = quota ? await quota.admit(contentLength ?? 0) : undefined;

      const maxBytes = 10 * 1024 * 1024 * 1024; // 10 GiB cap
      let bytesTransferred = 0;
      try {
        ({ bytesTransferred } = await storage.putStream(objectKey, request.body as Readable, {
          maxBytes,
          totalBytes: contentLength
        }));
      } catch (err) {
        // Release the reservation so an abandoned upload does not hold headroom.
        await reservation?.release();
        if (err instanceof SourceTooLargeError) {
          return reply.code(413).send({ error: 'payload_too_large', message: err.message });
        }
        throw err;
      }

      // Commit the TRUE transferred size to the running total (issue #579).
      await reservation?.commit(bytesTransferred);
      await repo.update(asset.id, { objectKey, status: 'processing' });
      opts.onObjectStored?.(asset.id, objectKey, storage);
      return reply.code(200).send({ id: asset.id, status: 'processing' });
    }
  );

  // --- Single-part: presigned PUT URL (kept for server-to-server use) ----
  app.post(
    '/:id/upload-url',
    {  schema: { params: idParams, response: { 200: urlResponse, 404: errorSchema, 501: errorSchema } } },
    async (request, reply) => {
      if (!storageFor) {
        return reply.code(501).send({ error: 'not_configured', message: notConfigured });
      }
      const asset = await loadAsset(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const ttl = uploadUrlTtlSeconds();
      const storage = storageFor();
      const objectKey = sourceObjectKey(asset.id);
      const url = await storage.presignedPut(objectKey, ttl);
      return reply.code(200).send({ url, objectKey, method: 'PUT', expiresInSeconds: ttl });
    }
  );

  // --- Multipart: initiate ------------------------------------------------
  app.post(
    '/:id/multipart/initiate',
    {
      
      schema: { params: idParams, response: { 200: initiateResponse, 404: errorSchema, 501: errorSchema } }
    },
    async (request, reply) => {
      if (!storageFor) {
        return reply.code(501).send({ error: 'not_configured', message: notConfigured });
      }
      const asset = await loadAsset(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const storage = storageFor();
      const objectKey = sourceObjectKey(asset.id);
      const uploadId = await storage.initiateMultipartUpload(objectKey);
      return reply
        .code(200)
        .send({ uploadId, objectKey, expiresInSeconds: uploadUrlTtlSeconds() });
    }
  );

  // --- Multipart: per-part presigned PUT URL ------------------------------
  app.get(
    '/:id/multipart/:uploadId/part-url',
    {
      
      schema: {
        params: multipartParams,
        querystring: z.object({ partNumber: partNumberSchema }),
        response: { 200: partUrlResponse, 404: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      if (!storageFor) {
        return reply.code(501).send({ error: 'not_configured', message: notConfigured });
      }
      const asset = await loadAsset(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const ttl = uploadUrlTtlSeconds();
      const storage = storageFor();
      const objectKey = sourceObjectKey(asset.id);
      const url = await storage.presignedUploadPart(
        objectKey,
        request.params.uploadId,
        request.query.partNumber,
        ttl
      );
      return reply
        .code(200)
        .send({ url, partNumber: request.query.partNumber, expiresInSeconds: ttl });
    }
  );

  // --- Multipart: complete ------------------------------------------------
  app.post(
    '/:id/multipart/:uploadId/complete',
    {
      
      schema: {
        params: multipartParams,
        body: completeBody,
        response: { 200: assetStatusResponse, 404: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      if (!storageFor) {
        return reply.code(501).send({ error: 'not_configured', message: notConfigured });
      }
      const asset = await loadAsset(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const storage = storageFor();
      const objectKey = sourceObjectKey(asset.id);
      const parts: CompletedPart[] = request.body.parts;
      await storage.completeMultipartUpload(objectKey, request.params.uploadId, parts);
      // Persist the object key on the asset; the explicit upload-complete call
      // performs the lifecycle transition.
      await repo.update(asset.id, { objectKey });
      return reply.code(200).send({ id: asset.id, status: asset.status });
    }
  );

  // --- Multipart: abort / cleanup ----------------------------------------
  app.delete(
    '/:id/multipart/:uploadId',
    {
      
      schema: { params: multipartParams, response: { 204: z.null(), 404: errorSchema, 501: errorSchema } }
    },
    async (request, reply) => {
      if (!storageFor) {
        return reply.code(501).send({ error: 'not_configured', message: notConfigured });
      }
      const asset = await loadAsset(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const storage = storageFor();
      const objectKey = sourceObjectKey(asset.id);
      await storage.abortMultipartUpload(objectKey, request.params.uploadId);
      return reply.code(204).send(null);
    }
  );

  // --- Upload completion: uploading -> processing -------------------------
  // Explicit client signal that bytes are in MinIO. Transitions the asset
  // through the shared state machine (InvalidStateTransitionError -> 422 via
  // the assets router's error handler, which also wraps this sub-router).
  app.post(
    '/:id/upload-complete',
    {
      
      schema: { params: idParams, response: { 200: assetStatusResponse, 404: errorSchema, 409: errorSchema, 501: errorSchema } }
    },
    async (request, reply) => {
      if (!storageFor) {
        return reply.code(501).send({ error: 'not_configured', message: notConfigured });
      }
      const existing = await loadAsset(request.params.id);
      if (!existing) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // The single-part presigned flow (POST /:id/upload-url) stores the source
      // object at sourceObjectKey(asset.id) but never records that key on the
      // asset — unlike the proxied PUT /:id/upload path (which writes objectKey
      // at asset-upload.ts:179) and the multipart complete path (which writes it
      // at asset-upload.ts:288). Without objectKey the downstream processing
      // operations (transcode/package/thumbnails/clip/export) resolve the source
      // via asset.objectKey and 409 `no_object` (assets.ts:2733). Persist the
      // finalized source key here alongside the lifecycle transition so the
      // single-part finalize path reaches parity with the multipart one. Keep an
      // already-recorded objectKey (e.g. from PUT /:id/upload) rather than
      // clobbering it. The `objectKey` field is the write contract verified in
      // UpdateAssetInput (asset-repo.ts:527, field at :530).
      const objectKey = existing.objectKey ?? sourceObjectKey(existing.id);
      const storage = storageFor();

      // Total-storage-cap enforcement at upload COMPLETION (issue #579). The
      // presigned single-part and multipart flows write bytes straight to MinIO
      // without transiting this process, so the reservation cannot size them up
      // front — we admit them post-hoc here, at the one point the object exists
      // and its TRUE size is knowable (statObject). If admitting the real size
      // would breach the cap we reject 409 quota_exceeded AND delete the
      // over-cap object so it never counts against the deployment, leaving the
      // asset un-finalized (still `uploading`). No cap configured => skip.
      if (quota) {
        const stat = await storage.statObject(objectKey);
        const size = stat?.size ?? 0;
        let reservation;
        try {
          reservation = await quota.admit(size);
        } catch (err) {
          if (err instanceof QuotaExceededError) {
            // The bytes are already in MinIO but were never admitted — delete
            // the over-cap object so it does not count against the deployment,
            // then surface the 409 (the asset stays un-finalized / `uploading`).
            await storage.removeObject(objectKey).catch(() => { /* best-effort */ });
          }
          throw err;
        }
        // admit() succeeded; commit the real size to the running total.
        await reservation.commit(size);
      }

      const updated = await repo.update(request.params.id, {
        objectKey,
        status: 'processing'
      });
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // Trigger technical metadata extraction against the stored object
      // (issue #6). Fire-and-forget; does not affect this response.
      opts.onObjectStored?.(updated.id, objectKey, storage);
      return reply.code(200).send({ id: updated.id, status: updated.status });
    }
  );
};
