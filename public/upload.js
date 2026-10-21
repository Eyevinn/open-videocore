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

// ─── Failure causes (issue #771) ────────────────────────────────────────────
//
// Mirror of the server-side enum `uploadFailureCauseSchema`
// (src/routes/upload-failure-cause.ts) — the API returns one of these in the
// `cause` field of every upload error body. Duplicated here (not imported)
// because this module is plain browser JS and the enum is the CONTRACT, not an
// implementation detail; keep the two lists in step.
//
// Two of the three required causes can NEVER be classified by the server on the
// paths this module drives, which is why the client classifies too:
//   - a proxy in front of the API rejects an oversize body itself, so the 413
//     comes back with the proxy's own (usually HTML) body and never reaches the
//     API process — that is exactly the failure #747/#758 worked around;
//   - the presigned and multipart tiers PUT bytes browser -> object storage, so
//     a connection drop or an S3-level rejection on those PUTs is never seen by
//     the API at all.
// Every Error this module throws therefore carries a `failureCause` property
// holding one of these codes, so the UI (issue #772) has a single field to
// branch on regardless of which tier failed.
export const UPLOAD_FAILURE_CAUSE = {
  BODY_SIZE_LIMIT_EXCEEDED: 'body_size_limit_exceeded',
  NETWORK_ERROR: 'network_error',
  STORAGE_BACKEND_ERROR: 'storage_backend_error',
  STORAGE_NOT_CONFIGURED: 'storage_not_configured',
  QUOTA_EXCEEDED: 'quota_exceeded',
  ASSET_NOT_FOUND: 'asset_not_found',
  INVALID_ASSET_STATE: 'invalid_asset_state',
  NOT_AUTHORIZED: 'not_authorized',
  INVALID_REQUEST: 'invalid_request',
  UNSUPPORTED_MEDIA_TYPE: 'unsupported_media_type',
  UNKNOWN: 'unknown',
};

const KNOWN_CAUSES = Object.keys(UPLOAD_FAILURE_CAUSE).map(function (k) {
  return UPLOAD_FAILURE_CAUSE[k];
});

// ─── Human-readable cause text (issue #772) ─────────────────────────────────
//
// One sentence per cause, written for the person driving the ops UI: it names
// WHAT went wrong and, where a retry is worth attempting, says so. Never a bare
// HTTP status — that is the whole point of #772.
//
// Wording follows docs/guides/upload-failure-causes.md ("Notes for #772"):
//   - `network_error` is the only routinely retryable cause;
//   - `invalid_request` / `unsupported_media_type` are caller mistakes, so they
//     are never offered a bare "retry";
//   - the underlying S3/errno `code` is deliberately NOT shown here — it stays
//     on the Error for the diagnostics view.
export const UPLOAD_FAILURE_MESSAGE = {
  body_size_limit_exceeded:
    'the file exceeds the upload size limit enforced on this deployment',
  network_error: 'the network connection failed during the transfer — please retry',
  storage_backend_error: 'the storage backend rejected the upload — please try again',
  storage_not_configured:
    'no object storage is configured on this deployment, so uploads cannot be stored',
  quota_exceeded:
    'the deployment storage quota would be exceeded — free up space or raise the cap',
  asset_not_found: 'the asset no longer exists in this workspace',
  invalid_asset_state: 'the asset is not in a state that accepts this upload step',
  not_authorized: 'you are not authorised to upload to this asset',
  invalid_request:
    'the upload request was rejected as invalid — retrying it unchanged cannot succeed',
  unsupported_media_type: 'this file type cannot be accepted by the ingest API',
  unknown: 'the cause could not be identified',
};

// Messages that carry nothing but the transport status ("Upload failed: HTTP
// 413", "HTTP 502"). They are what #772 exists to replace, so they are dropped
// from the detail suffix rather than re-appended after the cause sentence.
const BARE_STATUS_MESSAGE = /^\s*(?:[\w .]*failed:\s*)?http\s+\d{3}\s*$/i;

/**
 * Resolve the failure cause of an error thrown out of the upload flow.
 *
 * Order: the `failureCause` every rejection from this module carries; then, for
 * an error that came from somewhere else in the flow (e.g. the `POST /assets`
 * create call, which throws the ops UI's apiFetch Error), the HTTP status; then
 * undefined, meaning "no structured cause available".
 *
 * An unrecognised `failureCause` string is treated as absent, so a cause code
 * added to the API later degrades to the status/unknown branch instead of
 * rendering a raw snake_case token at the user.
 *
 * @returns {string|undefined} one of UPLOAD_FAILURE_CAUSE, or undefined
 */
export function resolveFailureCause(err) {
  if (!err || typeof err !== 'object') return undefined;
  if (typeof err.failureCause === 'string' && KNOWN_CAUSES.indexOf(err.failureCause) >= 0) {
    return err.failureCause;
  }
  if (err.status !== undefined) return causeFromResponse(err.status, err.body, 'api');
  return undefined;
}

/**
 * Turn any error thrown out of the upload flow into the string the UI shows.
 *
 * Always leads with the identified CAUSE (acceptance criterion of #772), with
 * the API's own `message` kept as a trailing detail when it adds information —
 * `message` is generated by the API and never echoes credential or endpoint
 * detail (docs/guides/upload-failure-causes.md).
 *
 * Falls back safely when nothing structured is available: an error with no
 * `failureCause` and no `status` (a thrown string, a UI bug, an aborted
 * promise) yields the `unknown` sentence plus whatever message it carried,
 * never a crash and never a claim about a cause we did not identify.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeUploadFailure(err) {
  const cause = resolveFailureCause(err);
  const headline =
    'Upload failed: ' +
    (UPLOAD_FAILURE_MESSAGE[cause] || UPLOAD_FAILURE_MESSAGE[UPLOAD_FAILURE_CAUSE.UNKNOWN]);
  const raw =
    err && typeof err === 'object'
      ? typeof err.message === 'string'
        ? err.message
        : ''
      : typeof err === 'string'
        ? err
        : '';
  const detail = raw.trim();
  if (!detail || BARE_STATUS_MESSAGE.test(detail)) return headline + '.';
  return headline + '. Details: ' + detail;
}

// Build an Error carrying a machine-readable failure cause.
export function uploadError(message, cause, extra) {
  const err = new Error(message);
  err.failureCause = KNOWN_CAUSES.indexOf(cause) >= 0 ? cause : UPLOAD_FAILURE_CAUSE.UNKNOWN;
  if (extra && extra.status !== undefined) err.status = extra.status;
  if (extra && extra.code !== undefined) err.code = extra.code;
  return err;
}

/**
 * Derive the failure cause for a non-2xx HTTP response.
 *
 * Preference order:
 *   1. the API's own `cause` field, when the body is the structured upload
 *      error envelope (src/routes/upload-failure-cause.ts `uploadErrorSchema`);
 *   2. the status, for responses that did NOT come from the API — the proxy's
 *      413 (body limit) and object storage's own S3 error statuses;
 *   3. `unknown`, so the caller always has a defined branch.
 *
 * @param {number} status HTTP status
 * @param {object|undefined} body parsed JSON body, when there was one
 * @param {'api'|'storage'} origin who answered: the API (possibly via a proxy
 *   that may have answered instead) or object storage directly
 */
export function causeFromResponse(status, body, origin) {
  const declared = body && typeof body.cause === 'string' ? body.cause : undefined;
  if (declared && KNOWN_CAUSES.indexOf(declared) >= 0) return declared;
  // 413 with no structured body: the proxy in front of the API answered, not
  // the API. Same meaning, so the same code.
  if (status === 413) return UPLOAD_FAILURE_CAUSE.BODY_SIZE_LIMIT_EXCEEDED;
  if (origin === 'storage') {
    // Object storage answered with an error status: it was reachable and
    // refused/failed the write (expired signature, bad part, denied).
    return UPLOAD_FAILURE_CAUSE.STORAGE_BACKEND_ERROR;
  }
  if (status === 404) return UPLOAD_FAILURE_CAUSE.ASSET_NOT_FOUND;
  if (status === 409) return UPLOAD_FAILURE_CAUSE.QUOTA_EXCEEDED;
  if (status === 415) return UPLOAD_FAILURE_CAUSE.UNSUPPORTED_MEDIA_TYPE;
  if (status === 422) return UPLOAD_FAILURE_CAUSE.INVALID_ASSET_STATE;
  if (status === 400) return UPLOAD_FAILURE_CAUSE.INVALID_REQUEST;
  // 401 is the app-wide authentication gate (src/auth/middleware.ts
  // registerAuth), which answers before the upload router and so carries no
  // `cause` of its own; it means the same thing as the router's 403.
  if (status === 401 || status === 403) return UPLOAD_FAILURE_CAUSE.NOT_AUTHORIZED;
  if (status === 501) return UPLOAD_FAILURE_CAUSE.STORAGE_NOT_CONFIGURED;
  // 502/503/504 from a proxy that could not reach the API is a connection
  // failure from the caller's point of view.
  if (status === 502 || status === 503 || status === 504) {
    return UPLOAD_FAILURE_CAUSE.NETWORK_ERROR;
  }
  return UPLOAD_FAILURE_CAUSE.UNKNOWN;
}

// Attach a cause to an error thrown by the injected apiFetch. The ops UI's
// apiFetch exposes `status` and the parsed `body` on the Error it throws
// (public/app.js apiFetch), so the API's structured `cause` is readable here;
// a rejection with neither (fetch itself failing) is a network error.
function withApiFailureCause(err) {
  if (err && err.failureCause) return err;
  if (err && typeof err === 'object') {
    err.failureCause =
      err.status === undefined
        ? UPLOAD_FAILURE_CAUSE.NETWORK_ERROR
        : causeFromResponse(err.status, err.body, 'api');
    return err;
  }
  return uploadError(String(err), UPLOAD_FAILURE_CAUSE.UNKNOWN);
}

// Run an API call through the injected apiFetch, tagging any failure with a
// cause so every rejection out of this module carries one.
async function viaApi(fn) {
  try {
    return await fn();
  } catch (err) {
    throw withApiFailureCause(err);
  }
}

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
        // Object storage answered with an error status (#771): it was reached,
        // so this is a storage-backend failure — unless it rejected the part on
        // size, which keeps the body-limit meaning.
        reject(
          uploadError(
            'Storage PUT failed: HTTP ' + xhr.status,
            causeFromResponse(xhr.status, undefined, 'storage'),
            { status: xhr.status }
          )
        );
      }
    });
    xhr.addEventListener('error', function () {
      // XHR reports transport failures (DNS, TLS, refused, dropped, CORS
      // preflight failure) with no status at all — a connection error.
      reject(
        uploadError('Storage PUT failed: network error', UPLOAD_FAILURE_CAUSE.NETWORK_ERROR)
      );
    });
    xhr.addEventListener('abort', function () {
      reject(uploadError('Storage PUT aborted', UPLOAD_FAILURE_CAUSE.NETWORK_ERROR));
    });
    xhr.send(blob);
  });
}

// --- stream: existing proxied PUT (small files, behaviour preserved) --------
// PUT /api/v1/assets/:id/upload — src/routes/asset-upload.ts:167. 200 body
// { id, status } (assetStatusResponse, asset-upload.ts:111-114). The handler
// itself transitions uploading -> processing, so no upload-complete call.
async function uploadStreamed(assetId, file, deps) {
  let res;
  try {
    res = await fetch(
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
  } catch (err) {
    // fetch() itself rejected: the connection never completed (#771).
    throw uploadError(
      'Upload failed: ' + ((err && err.message) || 'network error'),
      UPLOAD_FAILURE_CAUSE.NETWORK_ERROR
    );
  }
  if (!res.ok) {
    // Prefer the API's structured body. A proxy that enforces its own
    // request-body limit answers 413 here INSTEAD of the API, with a non-JSON
    // body — causeFromResponse maps that to body_size_limit_exceeded too, so
    // the UI sees one code for "too big" whoever rejected it.
    const body = await res.json().catch(function () { return undefined; });
    throw uploadError(
      (body && (body.message || body.error)) || 'Upload failed: HTTP ' + res.status,
      causeFromResponse(res.status, body, 'api'),
      { status: res.status, code: body && body.code }
    );
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
  const presign = await viaApi(function () {
    return deps.apiFetch('/assets/' + encodeURIComponent(assetId) + '/upload-url', {
      method: 'POST',
    });
  });
  await putToStorage(
    presign.url,
    file,
    file.type || 'application/octet-stream',
    deps.onProgress
  );
  await viaApi(function () {
    return deps.apiFetch('/assets/' + encodeURIComponent(assetId) + '/upload-complete', {
      method: 'POST',
    });
  });
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
  const init = await viaApi(function () {
    return deps.apiFetch('/assets/' + idEnc + '/multipart/initiate', { method: 'POST' });
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
      const partInfo = await viaApi(function () {
        return deps.apiFetch(
          '/assets/' + idEnc + '/multipart/' + uploadIdEnc +
            '/part-url?partNumber=' + partNumber
        );
      });
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
        // The part landed but the ETag header was not exposed cross-origin, so
        // the session can never be completed: a storage-side (CORS) failure.
        throw uploadError(
          'Storage did not return an ETag for part ' + partNumber +
            ' (MinIO must expose the ETag header via CORS to complete multipart uploads)',
          UPLOAD_FAILURE_CAUSE.STORAGE_BACKEND_ERROR
        );
      }
      parts.push({ partNumber: partNumber, etag: etag });
      uploadedBytes = end;
    }
    await viaApi(function () {
      return deps.apiFetch('/assets/' + idEnc + '/multipart/' + uploadIdEnc + '/complete', {
        method: 'POST',
        body: JSON.stringify({ parts: parts }),
      });
    });
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
  await viaApi(function () {
    return deps.apiFetch('/assets/' + idEnc + '/upload-complete', { method: 'POST' });
  });
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
 * On failure the rejected Error carries a machine-readable `failureCause` — one
 * of UPLOAD_FAILURE_CAUSE — mirroring the API's `cause` field
 * (src/routes/upload-failure-cause.ts). See docs/guides/upload-failure-causes.md.
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
