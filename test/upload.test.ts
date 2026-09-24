// @vitest-environment happy-dom
//
// Unit tests for the size-based upload routing module (issue #747).
//
// public/upload.js picks the browser->storage transport by file size so large
// files bypass the API proxy's body limit. These tests exercise that routing
// and the multipart driver by importing the module directly, following the
// happy-dom convention used by test/assets-table.test.ts and
// test/jobs-table.test.ts (both import from public/*.js and inject a fake
// apiFetch so no live server is required).
//
// ─── Contract grounding (verified against src/routes/asset-upload.ts) ─────────
// The routes the module calls, and the response/body shapes it depends on, are
// declared by the real router (symbols cited, not line numbers, per the
// contract-first rule):
//   - POST   /:id/upload-url            -> `urlResponse` { url, objectKey, method, expiresInSeconds }
//                                          (src/routes/asset-upload.ts `urlResponse`)
//   - POST   /:id/multipart/initiate    -> `initiateResponse` { uploadId, objectKey, expiresInSeconds }
//                                          (src/routes/asset-upload.ts `initiateResponse`)
//   - GET    /:id/multipart/:uploadId/part-url?partNumber=N
//                                        -> `partUrlResponse` { url, partNumber, expiresInSeconds }
//                                          (src/routes/asset-upload.ts `partUrlResponse`;
//                                           `partNumberSchema` = int 1..10000)
//   - POST   /:id/multipart/:uploadId/complete  { parts: [{ partNumber, etag }] }
//                                          (src/routes/asset-upload.ts `completeBody`)
//   - DELETE /:id/multipart/:uploadId    aborts/cleans up a session
//                                          (src/routes/asset-upload.ts `multipartParams`)
//   - POST   /:id/upload-complete        transitions uploading -> processing
// The stream tier PUTs to /:id/upload via the global `fetch`; every other route
// goes through the injected `apiFetch`. Both are stubbed here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chooseUploadStrategy,
  uploadAssetFile,
  causeFromResponse,
  UPLOAD_FAILURE_CAUSE,
  STREAM_MAX_BYTES,
  MULTIPART_MIN_BYTES,
  MULTIPART_PART_BYTES,
} from '../public/upload.js';

// ─── fakes ────────────────────────────────────────────────────────────────────

// A File-shaped stand-in. uploadMultipart only reads size/type and calls
// slice(start,end); the returned chunk is opaque (it is handed to the stubbed
// XHR), so a plain marker object is enough and we never allocate real bytes.
function makeFakeFile(size: number, type = 'video/mp4') {
  return {
    size,
    type,
    slice: (start: number, end: number) => ({ start, end }) as unknown as Blob,
  } as unknown as File;
}

type ApiCall = { path: string; options: { method?: string; body?: string } };

// Records apiFetch calls and answers each route with a canned envelope matching
// the verified response schema. Storage PUT/GET-part etags come from the XHR
// stub, not from here.
function fakeApiFetch() {
  const calls: ApiCall[] = [];
  const apiFetch = vi.fn(async (path: string, options: { method?: string; body?: string } = {}) => {
    calls.push({ path, options });
    if (options.method === 'DELETE') return null; // abort/cleanup (204)
    if (path.endsWith('/multipart/initiate')) {
      return { uploadId: 'up-abc', objectKey: 'k/obj', expiresInSeconds: 900 };
    }
    if (path.includes('/part-url?partNumber=')) {
      const n = Number(path.split('partNumber=')[1]);
      return { url: 'https://minio.example/part/' + n, partNumber: n, expiresInSeconds: 900 };
    }
    if (path.endsWith('/upload-url')) {
      return {
        url: 'https://minio.example/presigned',
        objectKey: 'k/obj',
        method: 'PUT',
        expiresInSeconds: 900,
      };
    }
    if (path.endsWith('/multipart/up-abc/complete')) return {};
    if (path.endsWith('/upload-complete')) return { id: 'asset-1', status: 'processing' };
    throw new Error('unexpected apiFetch path: ' + path);
  });
  return { apiFetch, calls };
}

// Install a stubbed XMLHttpRequest whose behaviour per storage-PUT is decided by
// `responder(url)`. `putToStorage` reads the ETag response header on load, so we
// echo an etag string back; returning etag:'' models a MinIO instance that does
// not CORS-expose the ETag header. Returns the recorded PUT urls + a restore fn.
type XhrOutcome = { status: number; etag?: string } | { networkError: true };
function installStubbedXHR(responder: (url: string) => XhrOutcome) {
  const puts: string[] = [];
  class StubbedXHR {
    private method = '';
    private url = '';
    private etag = '';
    status = 0;
    upload = { addEventListener: () => {} };
    private listeners: Record<string, Array<() => void>> = {};
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader() {}
    addEventListener(type: string, cb: () => void) {
      (this.listeners[type] ||= []).push(cb);
    }
    getResponseHeader(name: string) {
      return name.toLowerCase() === 'etag' ? this.etag || null : null;
    }
    send() {
      puts.push(this.url);
      const out = responder(this.url);
      setTimeout(() => {
        if ('networkError' in out) {
          (this.listeners['error'] || []).forEach((f) => f.call(this));
          return;
        }
        this.status = out.status;
        this.etag = out.etag ?? '';
        (this.listeners['load'] || []).forEach((f) => f.call(this));
      }, 0);
    }
  }
  const prev = globalThis.XMLHttpRequest;
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = StubbedXHR;
  return { puts, restore: () => ((globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = prev) };
}

const MiB = 1024 * 1024;
const deps = (apiFetch: unknown) => ({
  apiFetch,
  apiBase: 'http://api.test/api/v1',
  stackName: 'stack-1',
});

let restoreXHR: (() => void) | null = null;
afterEach(() => {
  if (restoreXHR) restoreXHR();
  restoreXHR = null;
  vi.restoreAllMocks();
});

// ─── chooseUploadStrategy: threshold table ────────────────────────────────────

describe('chooseUploadStrategy thresholds', () => {
  it('exposes contract-safe threshold constants (part >> 5 MiB S3/MinIO min)', () => {
    expect(STREAM_MAX_BYTES).toBe(32 * MiB);
    expect(MULTIPART_MIN_BYTES).toBe(128 * MiB);
    expect(MULTIPART_PART_BYTES).toBe(16 * MiB);
    expect(MULTIPART_PART_BYTES).toBeGreaterThan(5 * MiB); // S3/MinIO part minimum
    expect(STREAM_MAX_BYTES).toBeLessThan(MULTIPART_MIN_BYTES);
  });

  // At and around BOTH boundaries (32 MiB stream/presigned, 128 MiB presigned/multipart).
  it.each([
    [0, 'stream'],
    [1, 'stream'],
    [STREAM_MAX_BYTES - 1, 'stream'],
    [STREAM_MAX_BYTES, 'stream'], // inclusive upper edge of stream (`> STREAM_MAX_BYTES`)
    [STREAM_MAX_BYTES + 1, 'presigned'],
    [MULTIPART_MIN_BYTES - 1, 'presigned'],
    [MULTIPART_MIN_BYTES, 'multipart'], // inclusive lower edge of multipart (`>= MULTIPART_MIN_BYTES`)
    [MULTIPART_MIN_BYTES + 1, 'multipart'],
  ] as const)('size %d bytes -> %s', (size, strategy) => {
    expect(chooseUploadStrategy(size)).toBe(strategy);
  });
});

// ─── uploadAssetFile: multipart (large file) ─────────────────────────────────

describe('uploadAssetFile multipart tier (>= 128 MiB)', () => {
  it('drives initiate -> N part-url GETs -> complete{parts} -> upload-complete', async () => {
    const size = 160 * MiB; // 160/16 => exactly 10 parts, no remainder
    const expectedParts = Math.ceil(size / MULTIPART_PART_BYTES);
    expect(expectedParts).toBe(10);

    // Each storage PUT succeeds and echoes an etag keyed to the part number.
    const xhr = installStubbedXHR((url) => ({ status: 200, etag: '"pt-' + url.split('/').pop() + '"' }));
    restoreXHR = xhr.restore;

    const { apiFetch, calls } = fakeApiFetch();
    const used = await uploadAssetFile('asset-1', makeFakeFile(size), deps(apiFetch));
    expect(used).toBe('multipart');

    // 1) exactly one initiate.
    const initiate = calls.filter((c) => c.path.endsWith('/multipart/initiate'));
    expect(initiate).toHaveLength(1);
    expect(initiate[0].options.method).toBe('POST');

    // 2) N part-url GETs, numbered 1..N against the returned uploadId.
    const partUrls = calls.filter((c) => c.path.includes('/part-url?partNumber='));
    expect(partUrls).toHaveLength(expectedParts);
    expect(partUrls.map((c) => Number(c.path.split('partNumber=')[1]))).toEqual(
      Array.from({ length: expectedParts }, (_v, i) => i + 1)
    );
    for (const c of partUrls) {
      expect(c.path).toContain('/assets/asset-1/multipart/up-abc/part-url');
    }

    // 3) N storage PUTs went straight to the presigned MinIO urls (off the proxy).
    expect(xhr.puts).toHaveLength(expectedParts);
    expect(xhr.puts[0]).toBe('https://minio.example/part/1');

    // 4) complete carries the collected {partNumber, etag} pairs in order.
    const complete = calls.find((c) => c.path.endsWith('/multipart/up-abc/complete'))!;
    expect(complete.options.method).toBe('POST');
    expect(JSON.parse(complete.options.body!)).toEqual({
      parts: Array.from({ length: expectedParts }, (_v, i) => ({
        partNumber: i + 1,
        etag: '"pt-' + (i + 1) + '"',
      })),
    });

    // 5) finalize transitions the asset server-side.
    const finalize = calls.find((c) => c.path.endsWith('/upload-complete'))!;
    expect(finalize.options.method).toBe('POST');
    // No abort on a clean run.
    expect(calls.some((c) => c.options.method === 'DELETE')).toBe(false);
  });

  it('handles a trailing partial part (Math.ceil, not floor)', async () => {
    const size = 130 * MiB; // 130/16 = 8.125 => 9 parts, last one partial
    const expectedParts = Math.ceil(size / MULTIPART_PART_BYTES);
    expect(expectedParts).toBe(9);
    const xhr = installStubbedXHR(() => ({ status: 200, etag: '"e"' }));
    restoreXHR = xhr.restore;
    const { apiFetch, calls } = fakeApiFetch();
    await uploadAssetFile('asset-1', makeFakeFile(size), deps(apiFetch));
    expect(calls.filter((c) => c.path.includes('/part-url?partNumber=')).length).toBe(expectedParts);
  });

  it('aborts (best-effort DELETE) and rethrows when a mid-upload part PUT fails', async () => {
    const size = 160 * MiB; // 10 parts; fail on part 3
    const xhr = installStubbedXHR((url) =>
      url.endsWith('/3') ? { networkError: true } : { status: 200, etag: '"ok"' }
    );
    restoreXHR = xhr.restore;
    const { apiFetch, calls } = fakeApiFetch();

    await expect(uploadAssetFile('asset-1', makeFakeFile(size), deps(apiFetch))).rejects.toThrow(
      /Storage PUT failed/
    );

    // The session was aborted with a DELETE on the uploadId (best-effort cleanup).
    const abort = calls.find((c) => c.options.method === 'DELETE');
    expect(abort).toBeTruthy();
    expect(abort!.path).toBe('/assets/asset-1/multipart/up-abc');
    // Never completed, never finalized after the failure.
    expect(calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
    expect(calls.some((c) => c.path.endsWith('/upload-complete'))).toBe(false);
    // We stopped issuing part PUTs at the failing part (1,2,3), not all 10.
    expect(xhr.puts).toHaveLength(3);
  });

  it('throws (and aborts) when storage does not CORS-expose an ETag', async () => {
    const size = 160 * MiB;
    // 200 OK but no ETag header => putToStorage resolves '' => uploadMultipart throws.
    const xhr = installStubbedXHR(() => ({ status: 200, etag: '' }));
    restoreXHR = xhr.restore;
    const { apiFetch, calls } = fakeApiFetch();

    await expect(uploadAssetFile('asset-1', makeFakeFile(size), deps(apiFetch))).rejects.toThrow(
      /did not return an ETag/
    );
    // ETag-missing is discovered on the first part, before any complete.
    expect(calls.some((c) => c.options.method === 'DELETE')).toBe(true);
    expect(calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
  });
});

// ─── uploadAssetFile: presigned single-part (medium file) ────────────────────

describe('uploadAssetFile presigned tier (32..128 MiB)', () => {
  it('POSTs upload-url, PUTs the whole file to storage, then upload-complete', async () => {
    const size = 64 * MiB; // between the thresholds
    const xhr = installStubbedXHR(() => ({ status: 200, etag: '"whole"' }));
    restoreXHR = xhr.restore;
    const { apiFetch, calls } = fakeApiFetch();

    const used = await uploadAssetFile('asset-1', makeFakeFile(size), deps(apiFetch));
    expect(used).toBe('presigned');

    expect(calls.find((c) => c.path.endsWith('/upload-url'))!.options.method).toBe('POST');
    // Exactly one storage PUT — the whole payload, off the proxy — and no multipart routes.
    expect(xhr.puts).toEqual(['https://minio.example/presigned']);
    expect(calls.some((c) => c.path.includes('/multipart/'))).toBe(false);
    expect(calls.find((c) => c.path.endsWith('/upload-complete'))!.options.method).toBe('POST');
  });
});

// ─── uploadAssetFile: stream (small file) — AC3 regression guard ─────────────

describe('uploadAssetFile stream tier (<= 32 MiB) — AC3 regression guard', () => {
  it('keeps the existing proxied PUT /:id/upload path and never touches storage/apiFetch', async () => {
    const size = 10 * MiB; // small file: unchanged behaviour
    const file = makeFakeFile(size, 'video/mp4');

    // The stream tier uses the global fetch, not apiFetch or XHR.
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const xhr = installStubbedXHR(() => ({ status: 200, etag: '"x"' }));
    restoreXHR = xhr.restore;
    const { apiFetch, calls } = fakeApiFetch();

    const used = await uploadAssetFile('asset-1', file, deps(apiFetch));
    expect(used).toBe('stream');

    // The one and only request is the streamed proxy PUT to /:id/upload.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/assets/asset-1/upload');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(file);
    expect((init.headers as Record<string, string>)['X-Stack-Name']).toBe('stack-1');

    // No presigned/multipart routing and no direct-to-storage PUT occurred.
    expect(calls).toHaveLength(0);
    expect(xhr.puts).toHaveLength(0);
  });

  it('surfaces a server error body on a failed streamed upload', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 413,
      json: async () => ({ message: 'Payload Too Large' }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = fakeApiFetch();
    await expect(uploadAssetFile('asset-1', makeFakeFile(8 * MiB), deps(apiFetch))).rejects.toThrow(
      /Payload Too Large/
    );
  });
});

// ─── failure causes (issue #771) ─────────────────────────────────────────────
//
// Every rejection out of uploadAssetFile carries a machine-readable
// `failureCause` from UPLOAD_FAILURE_CAUSE, mirroring the API's `cause` field
// (src/routes/upload-failure-cause.ts `uploadFailureCauseSchema` /
// `uploadErrorSchema`). The client has to classify as well as the server
// because two of the three required causes can never be seen server-side on
// these tiers: a proxy answers the oversize 413 itself (the #747 failure), and
// the presigned/multipart tiers PUT browser -> object storage, so a dropped
// connection or an S3 rejection never reaches the API at all.

describe('causeFromResponse (issue #771)', () => {
  it("prefers the API's own cause field when the structured envelope is present", () => {
    expect(
      causeFromResponse(502, { error: 'storage_error', cause: 'storage_backend_error' }, 'api')
    ).toBe(UPLOAD_FAILURE_CAUSE.STORAGE_BACKEND_ERROR);
  });

  it('maps a bodiless 413 — the proxy answering instead of the API — to the body-size cause', () => {
    // This is the #747 failure mode: the proxy in front of the API rejects the
    // request body itself, so there is no JSON envelope to read.
    expect(causeFromResponse(413, undefined, 'api')).toBe(
      UPLOAD_FAILURE_CAUSE.BODY_SIZE_LIMIT_EXCEEDED
    );
  });

  it('maps an error status from object storage itself to storage_backend_error', () => {
    expect(causeFromResponse(403, undefined, 'storage')).toBe(
      UPLOAD_FAILURE_CAUSE.STORAGE_BACKEND_ERROR
    );
  });

  it.each([
    [404, UPLOAD_FAILURE_CAUSE.ASSET_NOT_FOUND],
    [409, UPLOAD_FAILURE_CAUSE.QUOTA_EXCEEDED],
    [415, UPLOAD_FAILURE_CAUSE.UNSUPPORTED_MEDIA_TYPE],
    [422, UPLOAD_FAILURE_CAUSE.INVALID_ASSET_STATE],
    [400, UPLOAD_FAILURE_CAUSE.INVALID_REQUEST],
    [403, UPLOAD_FAILURE_CAUSE.NOT_AUTHORIZED],
    [501, UPLOAD_FAILURE_CAUSE.STORAGE_NOT_CONFIGURED],
    [504, UPLOAD_FAILURE_CAUSE.NETWORK_ERROR],
    [418, UPLOAD_FAILURE_CAUSE.UNKNOWN],
  ])('falls back to the status when the API sent no cause: %d', (status, expected) => {
    expect(causeFromResponse(status, undefined, 'api')).toBe(expected);
  });

  it('ignores a cause value it does not recognise (forward compatibility)', () => {
    expect(causeFromResponse(404, { cause: 'invented_later' }, 'api')).toBe(
      UPLOAD_FAILURE_CAUSE.ASSET_NOT_FOUND
    );
  });
});

describe('uploadAssetFile failure causes (issue #771)', () => {
  it('stream tier: a proxy 413 with no JSON body -> body_size_limit_exceeded', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 413,
      // A proxy answers with HTML, so json() rejects.
      json: async () => {
        throw new Error('not json');
      },
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = fakeApiFetch();
    await expect(
      uploadAssetFile('asset-1', makeFakeFile(8 * MiB), deps(apiFetch))
    ).rejects.toMatchObject({
      failureCause: UPLOAD_FAILURE_CAUSE.BODY_SIZE_LIMIT_EXCEEDED,
      status: 413,
    });
  });

  it("stream tier: the API's structured 413 envelope -> body_size_limit_exceeded", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 413,
      json: async () => ({
        error: 'payload_too_large',
        cause: 'body_size_limit_exceeded',
        message: 'source exceeds maximum allowed size of 1024 bytes',
      }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = fakeApiFetch();
    await expect(
      uploadAssetFile('asset-1', makeFakeFile(8 * MiB), deps(apiFetch))
    ).rejects.toMatchObject({
      failureCause: UPLOAD_FAILURE_CAUSE.BODY_SIZE_LIMIT_EXCEEDED,
      message: 'source exceeds maximum allowed size of 1024 bytes',
    });
  });

  it('stream tier: fetch itself rejecting -> network_error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = fakeApiFetch();
    await expect(
      uploadAssetFile('asset-1', makeFakeFile(8 * MiB), deps(apiFetch))
    ).rejects.toMatchObject({ failureCause: UPLOAD_FAILURE_CAUSE.NETWORK_ERROR });
  });

  it('stream tier: the API reporting an unreachable store -> storage_backend_error', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({
        error: 'storage_error',
        cause: 'storage_backend_error',
        message: 'the storage backend rejected or failed the upload during putStream',
        code: 'AccessDenied',
      }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = fakeApiFetch();
    await expect(
      uploadAssetFile('asset-1', makeFakeFile(8 * MiB), deps(apiFetch))
    ).rejects.toMatchObject({
      failureCause: UPLOAD_FAILURE_CAUSE.STORAGE_BACKEND_ERROR,
      code: 'AccessDenied',
    });
  });

  it('presigned tier: a dropped browser -> storage PUT -> network_error, and no finalize', async () => {
    const xhr = installStubbedXHR(() => ({ networkError: true }) as XhrOutcome);
    restoreXHR = xhr.restore;
    const { apiFetch, calls } = fakeApiFetch();
    await expect(
      uploadAssetFile('asset-1', makeFakeFile(64 * MiB), deps(apiFetch))
    ).rejects.toMatchObject({ failureCause: UPLOAD_FAILURE_CAUSE.NETWORK_ERROR });
    // The upload never completed, so the asset must not be finalized.
    expect(calls.some((c) => c.path.endsWith('/upload-complete'))).toBe(false);
  });

  it('multipart tier: object storage refusing a part -> storage_backend_error + abort', async () => {
    const xhr = installStubbedXHR(() => ({ status: 403 }));
    restoreXHR = xhr.restore;
    const { apiFetch, calls } = fakeApiFetch();
    await expect(
      uploadAssetFile('asset-1', makeFakeFile(160 * MiB), deps(apiFetch))
    ).rejects.toMatchObject({
      failureCause: UPLOAD_FAILURE_CAUSE.STORAGE_BACKEND_ERROR,
      status: 403,
    });
    // #748's best-effort abort still runs.
    expect(calls.some((c) => c.options.method === 'DELETE')).toBe(true);
  });

  it('multipart tier: a CORS-hidden ETag -> storage_backend_error', async () => {
    const xhr = installStubbedXHR(() => ({ status: 200, etag: '' }));
    restoreXHR = xhr.restore;
    const { apiFetch } = fakeApiFetch();
    await expect(
      uploadAssetFile('asset-1', makeFakeFile(160 * MiB), deps(apiFetch))
    ).rejects.toMatchObject({ failureCause: UPLOAD_FAILURE_CAUSE.STORAGE_BACKEND_ERROR });
  });

  it("multipart tier: an API route failure is tagged from the API's own envelope", async () => {
    // apiFetch (public/app.js) throws an Error carrying `status` + parsed `body`.
    const apiFetch = vi.fn(async (path: string) => {
      if (path.endsWith('/multipart/initiate')) {
        const err = new Error('the storage backend could not be reached') as Error & {
          status?: number;
          body?: unknown;
        };
        err.status = 502;
        err.body = { error: 'storage_unreachable', cause: 'network_error' };
        throw err;
      }
      throw new Error('unexpected apiFetch path: ' + path);
    });
    await expect(
      uploadAssetFile('asset-1', makeFakeFile(160 * MiB), deps(apiFetch))
    ).rejects.toMatchObject({ failureCause: UPLOAD_FAILURE_CAUSE.NETWORK_ERROR });
  });
});
