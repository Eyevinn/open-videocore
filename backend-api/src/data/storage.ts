// Workspace-scoped object storage (MinIO).
//
// Partitioning strategy: a shared bucket with a per-workspace key prefix
// `<workspaceId>/`. Every object key handled by route logic is forced under the
// caller's prefix, and listings are bounded to that prefix, so one workspace
// can neither read, write, nor enumerate another workspace's objects.
//
// A shared-bucket-with-prefix model is preferred over a bucket-per-workspace
// model because it avoids per-tenant provisioning on OSC: the source and
// packaged buckets are created once at provision time and reused for all
// workspaces (see ADR-001 / provision route).

import type { Client as MinioClient } from 'minio';
import { PassThrough, type Readable } from 'node:stream';
import { assertValidWorkspaceId, objectPrefix } from './guard.js';

// Raised when a streamed source exceeds the configured byte cap. The route maps
// this to 413 and the URL-pull worker records it as a job failure (issue #5).
export class SourceTooLargeError extends Error {
  readonly statusCode = 413;
  constructor(maxBytes: number) {
    super(`source exceeds maximum allowed size of ${maxBytes} bytes`);
    this.name = 'SourceTooLargeError';
  }
}

// Default lifetime for any presigned URL we hand back to a client. Direct
// client-side uploads (issue #4) use a short TTL so a leaked URL has a small
// blast radius. Override per call or globally via UPLOAD_URL_TTL_SECONDS.
export const DEFAULT_UPLOAD_TTL_SECONDS = 15 * 60; // 15 minutes

// Resolve the configured presigned-URL TTL (12-factor: config via env). Falls
// back to the 15-minute default when unset or invalid.
export function uploadUrlTtlSeconds(): number {
  const raw = process.env['UPLOAD_URL_TTL_SECONDS'];
  if (!raw) {
    return DEFAULT_UPLOAD_TTL_SECONDS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_UPLOAD_TTL_SECONDS;
  }
  return parsed;
}

// Default lifetime for a delivery / playback URL handed back to a client
// (issue #14). Longer than the upload TTL because playback sessions are longer
// lived than an upload handshake. Override globally via DELIVERY_URL_TTL_SECONDS.
export const DEFAULT_DELIVERY_TTL_SECONDS = 60 * 60; // 1 hour

// Resolve the configured delivery-URL TTL (12-factor: config via env). Falls
// back to the 1-hour default when unset or invalid.
export function deliveryUrlTtlSeconds(): number {
  const raw = process.env['DELIVERY_URL_TTL_SECONDS'];
  if (!raw) {
    return DEFAULT_DELIVERY_TTL_SECONDS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DELIVERY_TTL_SECONDS;
  }
  return parsed;
}

// One part of a multipart upload, as reported by the client on completion.
export type CompletedPart = {
  partNumber: number;
  etag: string;
};

export class WorkspaceStorage {
  private readonly prefix: string;

  constructor(
    private readonly workspaceId: string,
    private readonly client: MinioClient,
    private readonly bucket: string
  ) {
    assertValidWorkspaceId(workspaceId);
    this.prefix = objectPrefix(workspaceId);
  }

  // Resolve a caller-supplied local key to its fully namespaced object key.
  // Reject inputs that try to escape the prefix (absolute keys, traversal).
  private scopedKey(localKey: string): string {
    const normalized = localKey.replace(/^\/+/, '');
    if (normalized.includes('..')) {
      throw new Error('invalid object key');
    }
    return `${this.prefix}${normalized}`;
  }

  // A presigned PUT URL for direct upload, scoped to this workspace's prefix.
  async presignedPut(
    localKey: string,
    expirySeconds: number = uploadUrlTtlSeconds()
  ): Promise<string> {
    return this.client.presignedPutObject(this.bucket, this.scopedKey(localKey), expirySeconds);
  }

  // A presigned GET URL, scoped to this workspace's prefix.
  async presignedGet(localKey: string, expirySeconds = 3600): Promise<string> {
    return this.client.presignedGetObject(this.bucket, this.scopedKey(localKey), expirySeconds);
  }

  async statObject(localKey: string): Promise<{ size: number; etag: string } | undefined> {
    try {
      const stat = await this.client.statObject(this.bucket, this.scopedKey(localKey));
      return { size: stat.size, etag: stat.etag };
    } catch (err) {
      if ((err as { code?: string }).code === 'NotFound') {
        return undefined;
      }
      throw err;
    }
  }

  async removeObject(localKey: string): Promise<void> {
    await this.client.removeObject(this.bucket, this.scopedKey(localKey));
  }

  // Stream an object directly — bypasses presigned URLs for environments where
  // they are blocked (e.g. OSC MinIO reverse proxy).
  async getObject(localKey: string): Promise<import('stream').Readable> {
    return this.client.getObject(this.bucket, this.scopedKey(localKey));
  }

  // -------------------------------------------------------------------------
  // Multipart / chunked upload (issue #4).
  //
  // Flow: initiate -> N x part URLs (presigned PUT, one per partNumber) ->
  // complete (server stitches parts into one object). abort discards an
  // in-progress upload so abandoned multipart sessions do not leak storage.
  // -------------------------------------------------------------------------

  // Begin a multipart upload for an object and return the server-issued
  // uploadId the client threads through subsequent part/complete calls.
  async initiateMultipartUpload(localKey: string): Promise<string> {
    return this.client.initiateNewMultipartUpload(this.bucket, this.scopedKey(localKey), {});
  }

  // A presigned PUT URL for a single part of an in-progress multipart upload.
  // The uploadId + partNumber are signed into the query string, so the client
  // PUTs the chunk directly to MinIO without proxying bytes through the API.
  async presignedUploadPart(
    localKey: string,
    uploadId: string,
    partNumber: number,
    expirySeconds: number = uploadUrlTtlSeconds()
  ): Promise<string> {
    return this.client.presignedUrl('PUT', this.bucket, this.scopedKey(localKey), expirySeconds, {
      uploadId,
      partNumber: String(partNumber)
    });
  }

  // Stitch the uploaded parts into the final object. Parts are sent to MinIO in
  // ascending partNumber order, as required by the S3 multipart contract.
  async completeMultipartUpload(
    localKey: string,
    uploadId: string,
    parts: CompletedPart[]
  ): Promise<{ etag: string }> {
    const etags = [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({ part: p.partNumber, etag: p.etag }));
    const result = await this.client.completeMultipartUpload(
      this.bucket,
      this.scopedKey(localKey),
      uploadId,
      etags
    );
    return { etag: result.etag };
  }

  // Abort an in-progress multipart upload, reclaiming any staged part data.
  async abortMultipartUpload(localKey: string, uploadId: string): Promise<void> {
    await this.client.abortMultipartUpload(this.bucket, this.scopedKey(localKey), uploadId);
  }

  // Stream a source into MinIO without buffering the whole payload in memory
  // (issue #5 URL-pull ingest). Bytes flow source -> PassThrough -> MinIO
  // putObject. A byte counter on the PassThrough enforces maxBytes: if the
  // source exceeds the cap mid-stream we destroy the pipe with
  // SourceTooLargeError so a lying/absent Content-Length cannot blow past the
  // limit. An optional onProgress callback receives cumulative bytes for job
  // progress events.
  async putStream(
    localKey: string,
    source: Readable,
    opts: {
      maxBytes: number;
      totalBytes?: number;
      onProgress?: (bytesTransferred: number, totalBytes?: number) => void;
    }
  ): Promise<{ etag: string; bytesTransferred: number }> {
    const key = this.scopedKey(localKey);
    const pass = new PassThrough();
    let transferred = 0;
    let aborted = false;

    source.on('data', (chunk: Buffer) => {
      if (aborted) return;
      transferred += chunk.length;
      if (transferred > opts.maxBytes) {
        aborted = true;
        const err = new SourceTooLargeError(opts.maxBytes);
        source.destroy(err);
        pass.destroy(err);
        return;
      }
      opts.onProgress?.(transferred, opts.totalBytes);
    });
    // Forward source errors to the pipe so putObject rejects.
    source.on('error', (err) => {
      if (!aborted) pass.destroy(err);
    });
    source.pipe(pass);

    const result = await this.client.putObject(this.bucket, key, pass, opts.totalBytes);
    return { etag: result.etag, bytesTransferred: transferred };
  }

  // List object keys for this workspace only, returned WITHOUT the workspace
  // prefix so callers see workspace-local keys.
  async list(): Promise<string[]> {
    const keys: string[] = [];
    const stream = this.client.listObjectsV2(this.bucket, this.prefix, true);
    return await new Promise<string[]>((resolve, reject) => {
      stream.on('data', (obj) => {
        if (obj.name && obj.name.startsWith(this.prefix)) {
          keys.push(obj.name.slice(this.prefix.length));
        }
      });
      stream.on('end', () => resolve(keys));
      stream.on('error', reject);
    });
  }
}
