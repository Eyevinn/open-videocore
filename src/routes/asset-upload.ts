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
import { z } from 'zod';
import { InvalidStateTransitionError, type AssetRepository } from '../data/asset-repo.js';
import { WorkspaceAccessError } from '../data/guard.js';
import { uploadUrlTtlSeconds, SourceTooLargeError, type CompletedPart, type WorkspaceStorage } from '../data/storage.js';

// Factory so production wires a real MinIO-backed WorkspaceStorage per request
// (bound to the caller's workspace) while tests inject a fake. Mirrors the
// repository-injection pattern used by the assets router.
export type StorageFactory = (workspaceId: string) => WorkspaceStorage;

export type AssetUploadRouterOptions = {
  repository: AssetRepository;
  storageFor: StorageFactory;
  // Fire-and-forget technical metadata extraction (issue #6). When provided,
  // upload-complete kicks off an ffprobe extraction against the freshly stored
  // object. Detached and non-blocking; never throws. Absent in deployments
  // without an ffprobe runner, in which case upload-complete behaves as before.
  onObjectStored?: (workspaceId: string, assetId: string, objectKey: string) => void;
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
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { repository: repo, storageFor } = opts;

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof WorkspaceAccessError) {
      return reply.code(err.statusCode).send({ error: 'forbidden', message: err.message });
    }
    if (err instanceof InvalidStateTransitionError) {
      return reply.code(422).send({ error: 'invalid_state_transition', message: err.message });
    }
    throw err;
  });

  const guarded = { onRequest: app.authenticate };

  // Look the asset up in the caller's workspace. Returns undefined (-> 404) for
  // a missing or foreign asset so existence is never leaked.
  async function loadAsset(workspaceId: string, id: string) {
    return repo.get(workspaceId, id);
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
      ...guarded,
      bodyLimit: 10 * 1024 * 1024 * 1024, // 10 GiB — body is streamed, not buffered
      schema: { params: idParams, response: { 200: assetStatusResponse, 404: errorSchema, 413: errorSchema } }
    },
    async (request, reply) => {
      const asset = await loadAsset(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const storage = storageFor(request.workspaceId);
      const objectKey = sourceObjectKey(asset.id);
      const contentLength = request.headers['content-length']
        ? Number(request.headers['content-length'])
        : undefined;

      const maxBytes = 10 * 1024 * 1024 * 1024; // 10 GiB cap
      try {
        await storage.putStream(objectKey, request.raw, {
          maxBytes,
          totalBytes: contentLength
        });
      } catch (err) {
        if (err instanceof SourceTooLargeError) {
          return reply.code(413).send({ error: 'payload_too_large', message: err.message });
        }
        throw err;
      }

      await repo.update(request.workspaceId, asset.id, { objectKey, status: 'processing' });
      opts.onObjectStored?.(request.workspaceId, asset.id, objectKey);
      return reply.code(200).send({ id: asset.id, status: 'processing' });
    }
  );

  // --- Single-part: presigned PUT URL (kept for server-to-server use) ----
  app.post(
    '/:id/upload-url',
    { ...guarded, schema: { params: idParams, response: { 200: urlResponse, 404: errorSchema } } },
    async (request, reply) => {
      const asset = await loadAsset(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const ttl = uploadUrlTtlSeconds();
      const storage = storageFor(request.workspaceId);
      const objectKey = sourceObjectKey(asset.id);
      const url = await storage.presignedPut(objectKey, ttl);
      return reply.code(200).send({ url, objectKey, method: 'PUT', expiresInSeconds: ttl });
    }
  );

  // --- Multipart: initiate ------------------------------------------------
  app.post(
    '/:id/multipart/initiate',
    {
      ...guarded,
      schema: { params: idParams, response: { 200: initiateResponse, 404: errorSchema } }
    },
    async (request, reply) => {
      const asset = await loadAsset(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const storage = storageFor(request.workspaceId);
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
      ...guarded,
      schema: {
        params: multipartParams,
        querystring: z.object({ partNumber: partNumberSchema }),
        response: { 200: partUrlResponse, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await loadAsset(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const ttl = uploadUrlTtlSeconds();
      const storage = storageFor(request.workspaceId);
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
      ...guarded,
      schema: {
        params: multipartParams,
        body: completeBody,
        response: { 200: assetStatusResponse, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await loadAsset(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const storage = storageFor(request.workspaceId);
      const objectKey = sourceObjectKey(asset.id);
      const parts: CompletedPart[] = request.body.parts;
      await storage.completeMultipartUpload(objectKey, request.params.uploadId, parts);
      // Persist the object key on the asset; the explicit upload-complete call
      // performs the lifecycle transition.
      await repo.update(request.workspaceId, asset.id, { objectKey });
      return reply.code(200).send({ id: asset.id, status: asset.status });
    }
  );

  // --- Multipart: abort / cleanup ----------------------------------------
  app.delete(
    '/:id/multipart/:uploadId',
    {
      ...guarded,
      schema: { params: multipartParams, response: { 204: z.null(), 404: errorSchema } }
    },
    async (request, reply) => {
      const asset = await loadAsset(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const storage = storageFor(request.workspaceId);
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
      ...guarded,
      schema: { params: idParams, response: { 200: assetStatusResponse, 404: errorSchema } }
    },
    async (request, reply) => {
      const existing = await loadAsset(request.workspaceId, request.params.id);
      if (!existing) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const updated = await repo.update(request.workspaceId, request.params.id, {
        status: 'processing'
      });
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // Trigger technical metadata extraction against the stored object
      // (issue #6). Fire-and-forget; does not affect this response.
      const objectKey = existing.objectKey ?? sourceObjectKey(updated.id);
      opts.onObjectStored?.(request.workspaceId, updated.id, objectKey);
      return reply.code(200).send({ id: updated.id, status: updated.status });
    }
  );
};
