// Workspace-scoped bucket / object-storage management router.
//
// Lets an operator browse and prune the objects a workspace has stored in its
// two MinIO buckets (the shared `source` and `packaged` buckets, see ADR-001 /
// provision). Every route is behind `authenticate`, so each handler runs with a
// validated request.workspaceId and the per-request `request.connections`
// resolved by the global preHandler hook.
//
// Isolation: objects live under a hard `<workspaceId>/` key prefix inside the
// shared buckets (see data/storage.ts + guard.objectPrefix). This router forces
// every listing under the caller's prefix and strips it from the keys handed
// back, so a workspace can neither enumerate nor delete another workspace's
// objects. Bucket names are validated against the workspace's own configured
// source + packaged buckets (403 otherwise) — there is no way to address an
// arbitrary bucket.
//
// Graceful degradation: when the resolved stack has no object storage (the
// in-memory fallback, no MinIO) every route responds 501.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { BucketItem } from 'minio';
import { z } from 'zod';
import { objectPrefix } from '../data/guard.js';
import type { WorkspaceStackResolver } from '../services/workspace-stack.js';
import type { WatchFolderService } from '../pipeline/watch-folder.js';

// Hard cap on objects returned by a single listing call. Bounds the response
// size regardless of how many objects a prefix holds.
const MAX_OBJECTS = 200;

export type StorageRouterOptions = {
  stackResolver: WorkspaceStackResolver;
  // The global watch-folder service, when configured + enabled. Absent when
  // MinIO is not configured or WATCH_FOLDER_ENABLED is not 'true'; the
  // per-bucket watch-folder routes then report enabled:false / respond 501.
  watchFolder?: WatchFolderService;
};

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

const bucketSchema = z.object({
  name: z.string(),
  role: z.enum(['source', 'packaged'])
});

const bucketsSchema = z.array(bucketSchema);

// Create-bucket request + response. Bucket names follow the S3/MinIO naming
// rules the route enforces: 3-63 chars, lowercase-friendly alphanumeric plus
// hyphens. Created buckets carry the `custom` role (not the workspace's
// stack-managed source/packaged buckets).
const createBucketSchema = z.object({
  name: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-zA-Z0-9-]+$/, 'name must be alphanumeric characters and hyphens only')
});

const createdBucketSchema = z.object({
  name: z.string(),
  role: z.literal('custom')
});

// Per-bucket watch-folder status. `enabled` is true only when the watch-folder
// service is configured AND currently pointed at this bucket.
const watchFolderBucketSchema = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  bucket: z.string()
});

const objectSchema = z.object({
  key: z.string(),
  size: z.number(),
  lastModified: z.string().optional(),
  isPrefix: z.boolean()
});

const objectListSchema = z.object({
  objects: z.array(objectSchema),
  prefix: z.string(),
  bucket: z.string()
});

const listQuerySchema = z.object({
  prefix: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_OBJECTS).optional()
});

export const storageRouter: FastifyPluginAsync<StorageRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { stackResolver, watchFolder } = opts;

  const guarded = { onRequest: app.authenticate };

  // List the two configured buckets for the caller's workspace.
  //   200 — [{ name, role }, ...]
  //   501 — object storage not configured on this workspace's stack
  app.get(
    '/buckets',
    { ...guarded, schema: { response: { 200: bucketsSchema, 501: errorSchema } } },
    async (request, reply) => {
      const conns = request.connections;
      if (!conns?.storageClient) {
        return reply
          .code(501)
          .send({ error: 'not_configured', message: 'object storage is not configured' });
      }
      return reply.code(200).send([
        { name: conns.sourceBucket, role: 'source' as const },
        { name: conns.packagedBucket, role: 'packaged' as const }
      ]);
    }
  );

  // Create a new bucket on the workspace's object-storage backend.
  //   201 — { name, role: 'custom' }
  //   409 — a bucket with that name already exists
  //   501 — object storage not configured
  app.post(
    '/buckets',
    {
      ...guarded,
      schema: {
        body: createBucketSchema,
        response: { 201: createdBucketSchema, 409: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      const conns = request.connections;
      if (!conns?.storageClient) {
        return reply
          .code(501)
          .send({ error: 'not_configured', message: 'object storage is not configured' });
      }
      const { name } = request.body;
      try {
        await conns.storageClient.makeBucket(name, '');
      } catch (err) {
        // MinIO signals an existing bucket via BucketAlreadyOwnedByYou /
        // BucketAlreadyExists. Map both to 409 rather than a 500.
        if (isBucketExistsError(err)) {
          return reply
            .code(409)
            .send({ error: 'conflict', message: 'a bucket with that name already exists' });
        }
        throw err;
      }
      return reply.code(201).send({ name, role: 'custom' as const });
    }
  );

  // Read whether the watch-folder service is active on a given bucket.
  //   200 — { enabled, running, bucket }
  // `enabled` is true only when the watch-folder is configured AND currently
  // pointed at this bucket; `running` reflects the live service state.
  app.get(
    '/buckets/:bucket/watch-folder',
    {
      ...guarded,
      schema: {
        params: z.object({ bucket: z.string().min(1).max(256) }),
        response: { 200: watchFolderBucketSchema }
      }
    },
    async (request, reply) => {
      const { bucket } = request.params;
      const onThisBucket = watchFolder !== undefined && watchFolder.currentBucket() === bucket;
      return reply.code(200).send({
        enabled: onThisBucket,
        running: onThisBucket && watchFolder.isRunning(),
        bucket
      });
    }
  );

  // Toggle the watch-folder on a bucket.
  //   - running on this bucket  -> stop it
  //   - not running on this bucket -> point it at this bucket and start it
  //   200 — { enabled, running, bucket }
  //   501 — watch-folder service not configured
  app.post(
    '/buckets/:bucket/watch-folder/toggle',
    {
      ...guarded,
      schema: {
        params: z.object({ bucket: z.string().min(1).max(256) }),
        response: { 200: watchFolderBucketSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      if (!watchFolder) {
        return reply
          .code(501)
          .send({ error: 'not_configured', message: 'watch-folder service is not configured' });
      }
      const { bucket } = request.params;
      const runningHere = watchFolder.currentBucket() === bucket && watchFolder.isRunning();
      if (runningHere) {
        watchFolder.stop();
      } else {
        watchFolder.setBucket(bucket);
        watchFolder.start();
      }
      const onThisBucket = watchFolder.currentBucket() === bucket;
      return reply.code(200).send({
        enabled: onThisBucket,
        running: onThisBucket && watchFolder.isRunning(),
        bucket
      });
    }
  );

  // List objects in one of the workspace's buckets, scoped to the workspace's
  // `<workspaceId>/` key prefix. Non-recursive: directory-like CommonPrefixes
  // are returned as `isPrefix` entries so the UI can present a folder tree. The
  // caller-supplied `prefix` is a workspace-local prefix (without the workspace
  // namespace); it is forced under the namespace before hitting MinIO and
  // stripped from the keys handed back.
  //   200 — { objects, prefix, bucket }
  //   403 — bucket name is not one of the workspace's own buckets
  //   501 — object storage not configured
  app.get(
    '/buckets/:bucket/objects',
    {
      ...guarded,
      schema: {
        params: z.object({ bucket: z.string().min(1).max(256) }),
        querystring: listQuerySchema,
        response: { 200: objectListSchema, 403: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      const conns = request.connections;
      if (!conns?.storageClient) {
        return reply
          .code(501)
          .send({ error: 'not_configured', message: 'object storage is not configured' });
      }
      const { bucket } = request.params;
      if (bucket !== conns.sourceBucket && bucket !== conns.packagedBucket) {
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'bucket is not owned by this workspace' });
      }

      const wsPrefix = objectPrefix(request.workspaceId);
      const localPrefix = request.query.prefix ?? '';
      const limit = request.query.limit ?? MAX_OBJECTS;
      // Force the listing under the workspace namespace so a workspace can only
      // ever enumerate its own objects.
      const scopedPrefix = `${wsPrefix}${localPrefix}`;

      const objects = await listBounded(
        conns.storageClient,
        bucket,
        scopedPrefix,
        wsPrefix,
        limit
      );

      return reply.code(200).send({ objects, prefix: localPrefix, bucket });
    }
  );

  // Delete a single object by its workspace-local key. The key is forced under
  // the workspace namespace, so a workspace can only delete its own objects.
  //   204 — deleted
  //   403 — bucket not owned by this workspace, or key escapes the namespace
  //   501 — object storage not configured
  app.delete(
    '/buckets/:bucket/objects/*',
    {
      ...guarded,
      schema: {
        params: z.object({ bucket: z.string().min(1).max(256), '*': z.string().min(1).max(1024) }),
        response: { 204: z.null(), 403: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      const conns = request.connections;
      if (!conns?.storageClient) {
        return reply
          .code(501)
          .send({ error: 'not_configured', message: 'object storage is not configured' });
      }
      const { bucket } = request.params;
      if (bucket !== conns.sourceBucket && bucket !== conns.packagedBucket) {
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'bucket is not owned by this workspace' });
      }

      const localKey = request.params['*'].replace(/^\/+/, '');
      if (localKey.includes('..')) {
        return reply.code(403).send({ error: 'forbidden', message: 'invalid object key' });
      }
      const scopedKey = `${objectPrefix(request.workspaceId)}${localKey}`;
      await conns.storageClient.removeObject(bucket, scopedKey);
      return reply.code(204).send(null);
    }
  );
};

// Whether a thrown error from makeBucket indicates the bucket already exists.
// MinIO surfaces this as a `code` of BucketAlreadyOwnedByYou (owned by the
// caller) or BucketAlreadyExists (owned globally); match either.
function isBucketExistsError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'BucketAlreadyOwnedByYou' || code === 'BucketAlreadyExists';
}

// List up to `limit` objects under `scopedPrefix` non-recursively, returning
// workspace-local keys (the `wsPrefix` namespace stripped). CommonPrefixes are
// surfaced as `isPrefix` entries. Bounds the stream to `limit` results then
// destroys it so a huge bucket cannot stream unbounded.
function listBounded(
  client: import('minio').Client,
  bucket: string,
  scopedPrefix: string,
  wsPrefix: string,
  limit: number
): Promise<Array<z.infer<typeof objectSchema>>> {
  const out: Array<z.infer<typeof objectSchema>> = [];
  const stream = client.listObjectsV2(bucket, scopedPrefix, false);
  return new Promise((resolve, reject) => {
    const finish = () => resolve(out);
    stream.on('data', (item: BucketItem) => {
      if (out.length >= limit) {
        stream.destroy();
        finish();
        return;
      }
      // CommonPrefix entries carry `prefix`; real objects carry `name`.
      const rawKey = item.prefix ?? item.name;
      if (!rawKey || !rawKey.startsWith(wsPrefix)) {
        return;
      }
      out.push({
        key: rawKey.slice(wsPrefix.length),
        size: item.size ?? 0,
        lastModified: item.lastModified ? item.lastModified.toISOString() : undefined,
        isPrefix: Boolean(item.prefix)
      });
    });
    stream.on('end', finish);
    stream.on('error', reject);
  });
}
