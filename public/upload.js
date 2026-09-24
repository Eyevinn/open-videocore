/**
 * Size-based upload routing for the ops UI (issue #747).
 *
 * The ops UI historically streamed every file through the proxied route
 * `PUT /api/v1/assets/:id/upload` (src/routes/asset-upload.ts:167). On an
 * OSC-deployed instance a proxy layer in front of the API enforces a request
 * body limit far below the route's declared 10 GiB `bodyLimit`, so large files
 * fail with HTTP 413 long before reaching MinIO.
 *
 * This module picks the upload path by file size, using only routes already
 * implemented by src/routes/asset-upload.ts (contracts verified against that
 * file and openapi.json — see citations inline):
 *
 *   stream    (small):   PUT  /assets/:id/upload
 *                        streamed body, status -> processing server-side
 *   presigned (medium):  POST /assets/:id/upload-url        -> presigned PUT URL
 *                        PUT  <presigned url>  (browser -> MinIO, off the proxy)
 *                        POST /assets/:id/upload-complete    -> status -> processing
 *   multipart (large):   POST /assets/:id/multipart/initiate                 -> uploadId
 *                        GET  /assets/:id/multipart/:uploadId/part-url?partNumber=N -> part URL
 *                        PUT  <part url>       (browser -> MinIO, one PUT per part)
 *                        POST /assets/:id/multipart/:uploadId/complete { parts }
 *                        POST /assets/:id/upload-complete    -> status -> processing
 *
 * The presigned and multipart paths PUT bytes straight to MinIO, so no single
 * request carries the whole payload through the API proxy. Multipart part size
 * is well above the S3/MinIO 5 MiB minimum and well below any plausible proxy
 * `client_max_body_size`.
 */

// Files at or below this size keep the original streamed proxy upload so
// existing small-file behaviour is unaffected (acceptance criterion 3). Kept
// conservatively small so it stays under any plausible proxy body limit.
export const STREAM_MAX_BYTES = 32 * 1024 * 1024; // 32 MiB

// Files at or above this size use multipart (many part PUTs). Between the two
// thresholds a single presigned PUT is used (still off the proxy).
export const MULTIPART_MIN_BYTES = 128 * 1024 * 1024; // 128 MiB

// One multipart part. 16 MiB is >> the 5 MiB S3/MinIO minimum and << any
// plausible proxy limit; 10000-part cap => ~160 GiB ceiling.
export const MULTIPART_PART_BYTES = 16 * 1024 * 1024; // 16 MiB

/**
 * @param {number} sizeBytes
 * @returns {'stream'|'presigned'|'multipart'}
 */
export function chooseUploadStrategy(sizeBytes) {
  if (sizeBytes >= MULTIPART_MIN_BYTES) return 'multipart';
  if (sizeBytes > STREAM_MAX_BYTES) return 'presigned';
  return 'stream';
}

// PUT a Blob/File directly to a presigned MinIO URL via XHR so we get upload
// progress events and can read the ETag response header (needed to complete a
// multipart upload). Resolves with the raw ETag header value (may be quoted;
// S3/MinIO echo the value back on complete, so it is passed through verbatim).
function putToStorage(url, blob, contentType, onProgress) {
  return new Promise(function (resolve, reject) {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    if (onProgress && xhr.upload) {
      xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      });
    }
    xhr.addEventListener('load', function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        // ETag is only readable cross-origin when MinIO sets
        // Access-Control-Expose-Headers: ETag (see osc-feedback log).
        resolve(xhr.getResponseHeader('ETag') || '');
      } else {
        reject(new Error('Storage PUT failed: HTTP ' + xhr.status));
      }
    });
    xhr.addEventListener('error', function () {
      reject(new Error('Storage PUT failed: network error'));
    });
    xhr.addEventListener('abort', function () {
      reject(new Error('Storage PUT aborted'));
    });
    xhr.send(blob);
  });
}

// --- stream: existing proxied PUT (small files, behaviour preserved) --------
// PUT /api/v1/assets/:id/upload — src/routes/asset-upload.ts:167. 200 body
// { id, status } (assetStatusResponse, asset-upload.ts:111-114). The handler
// itself transitions uploading -> processing, so no upload-complete call.
async function uploadStreamed(assetId, file, deps) {
  const res = await fetch(
    deps.apiBase + '/assets/' + encodeURIComponent(assetId) + '/upload',
    {
      method: 'PUT',
      body: file,
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'Content-Length': String(file.size),
        ...(deps.stackName ? { 'X-Stack-Name': deps.stackName } : {}),
        // This raw PUT bypasses apiFetch, so present the same UI-scoped bearer
        // the caller spreads on gated calls (issue #740). The presigned/multipart
        // tiers PUT to object storage instead and carry no bearer.
        ...(deps.authHeader || {}),
      },
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(function () { return {}; });
    throw new Error(err.message || err.error || 'Upload failed: HTTP ' + res.status);
  }
  deps.onProgress && deps.onProgress(file.size, file.size);
}

// --- presigned single-part (medium files) -----------------------------------
// POST /assets/:id/upload-url -> { url, objectKey, method, expiresInSeconds }
//   (urlResponse, asset-upload.ts:90-95; openapi "/api/v1/assets/{id}/upload-url").
// then PUT the whole file to that URL (browser -> MinIO, off the proxy), then
// POST /assets/:id/upload-complete to transition uploading -> processing
//   (asset-upload.ts:353-421).
async function uploadPresigned(assetId, file, deps) {
  const presign = await deps.apiFetch(
    '/assets/' + encodeURIComponent(assetId) + '/upload-url',
    { method: 'POST' }
  );
  await putToStorage(
    presign.url,
    file,
    file.type || 'application/octet-stream',
    deps.onProgress
  );
  await deps.apiFetch(
    '/assets/' + encodeURIComponent(assetId) + '/upload-complete',
    { method: 'POST' }
  );
}

// --- multipart (large files) -------------------------------------------------
// POST /assets/:id/multipart/initiate -> { uploadId, objectKey, expiresInSeconds }
//   (initiateResponse, asset-upload.ts:97-101).
// GET  /assets/:id/multipart/:uploadId/part-url?partNumber=N -> { url, partNumber, expiresInSeconds }
//   (partUrlResponse, asset-upload.ts:103-107; partNumber 1..10000, asset-upload.ts:73).
// POST /assets/:id/multipart/:uploadId/complete { parts: [{ partNumber, etag }] }
//   (completeBody, asset-upload.ts:78-88).
// DELETE /assets/:id/multipart/:uploadId aborts on failure (asset-upload.ts:328).
// then POST /assets/:id/upload-complete -> status -> processing.
async function uploadMultipart(assetId, file, deps) {
  const idEnc = encodeURIComponent(assetId);
  const init = await deps.apiFetch('/assets/' + idEnc + '/multipart/initiate', {
    method: 'POST',
  });
  const uploadId = init.uploadId;
  // Surface the session id so the caller can wire its own best-effort abort/
  // cleanup (issue #748); this path still aborts internally below on failure.
  deps.onMultipartInit && deps.onMultipartInit(uploadId);
  const uploadIdEnc = encodeURIComponent(uploadId);
  const partCount = Math.ceil(file.size / MULTIPART_PART_BYTES);
  const parts = [];
  let uploadedBytes = 0;
  try {
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const start = (partNumber - 1) * MULTIPART_PART_BYTES;
      const end = Math.min(start + MULTIPART_PART_BYTES, file.size);
      const chunk = file.slice(start, end);
      const partInfo = await deps.apiFetch(
        '/assets/' + idEnc + '/multipart/' + uploadIdEnc +
          '/part-url?partNumber=' + partNumber
      );
      const chunkBase = uploadedBytes;
      const etag = await putToStorage(
        partInfo.url,
        chunk,
        file.type || 'application/octet-stream',
        function (loaded) {
          if (deps.onProgress) deps.onProgress(chunkBase + loaded, file.size);
        }
      );
      if (!etag) {
        throw new Error(
          'Storage did not return an ETag for part ' + partNumber +
            ' (MinIO must expose the ETag header via CORS to complete multipart uploads)'
        );
      }
      parts.push({ partNumber: partNumber, etag: etag });
      uploadedBytes = end;
    }
    await deps.apiFetch(
      '/assets/' + idEnc + '/multipart/' + uploadIdEnc + '/complete',
      { method: 'POST', body: JSON.stringify({ parts: parts }) }
    );
  } catch (err) {
    // Best-effort abort so an abandoned multipart session does not leak staged
    // part data in MinIO (asset-upload.ts:328 DELETE /:id/multipart/:uploadId).
    try {
      await deps.apiFetch(
        '/assets/' + idEnc + '/multipart/' + uploadIdEnc,
        { method: 'DELETE' }
      );
    } catch (_) { /* best-effort */ }
    throw err;
  }
  await deps.apiFetch('/assets/' + idEnc + '/upload-complete', { method: 'POST' });
}

/**
 * Upload a file's bytes for an already-created asset, picking the transport by
 * size. `deps` supplies the UI's request plumbing so this module stays free of
 * app-global state (and reusable):
 *   - apiFetch(path, options): the ops UI JSON fetch helper (returns parsed JSON,
 *     throws on non-2xx). Used for every /api/v1 route call.
 *   - apiBase: absolute API base (e.g. origin + '/api/v1') for the raw streamed PUT.
 *   - stackName: active OSC stack name, forwarded as X-Stack-Name on the stream path.
 *   - authHeader: optional header object (e.g. { Authorization: 'Bearer …' }) spread
 *     onto the streamed proxy PUT, which bypasses apiFetch (issue #740).
 *   - onMultipartInit(uploadId): optional hook fired once the multipart session is
 *     initiated, so the caller can wire its own abort/cleanup (issue #748).
 *   - onProgress(loaded, total): optional cumulative byte-progress callback.
 *
 * @param {string} assetId
 * @param {File} file
 * @param {{apiFetch: Function, apiBase: string, stackName?: string, authHeader?: object, onMultipartInit?: Function, onProgress?: Function}} deps
 * @returns {Promise<string>} the strategy used ('stream'|'presigned'|'multipart')
 */
export async function uploadAssetFile(assetId, file, deps) {
  const strategy = chooseUploadStrategy(file.size);
  if (strategy === 'multipart') {
    await uploadMultipart(assetId, file, deps);
  } else if (strategy === 'presigned') {
    await uploadPresigned(assetId, file, deps);
  } else {
    await uploadStreamed(assetId, file, deps);
  }
  return strategy;
}
