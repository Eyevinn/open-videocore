// @vitest-environment happy-dom
//
// The ops UI must tell the operator WHY an upload failed, not just which HTTP
// status came back (issue #772). Before this, a failed upload rendered
// "Error: Upload failed: HTTP 413" — the status only.
//
// public/app.js now renders `describeUploadFailure(err)` (public/upload.js) in
// the upload modal's catch block, and this file pins that mapping.
//
// ─── Contract grounding (CLAUDE.md rule 7) ───────────────────────────────────
// The failure-cause contract shipped in #771 and is read here from source, not
// assumed:
//   - src/routes/upload-failure-cause.ts `uploadFailureCauseSchema` — the enum
//     of cause codes. Imported below so the parity test fails if the API grows
//     a cause the UI has no sentence for.
//   - src/routes/upload-failure-cause.ts `uploadErrorSchema` — the error body
//     every upload route returns: { error, cause, message?, code? }. `cause` is
//     the machine-readable field the UI branches on.
//   - public/upload.js `causeFromResponse` / `uploadAssetFile` — the client
//     mirror: every rejection carries `failureCause`, including the failures the
//     API can never classify (a proxy answering the oversize 413 itself, and
//     the browser -> object storage PUTs of the presigned/multipart tiers).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { uploadFailureCauseSchema } from '../src/routes/upload-failure-cause.js';
import {
  UPLOAD_FAILURE_CAUSE,
  UPLOAD_FAILURE_MESSAGE,
  describeUploadFailure,
  resolveFailureCause,
  uploadAssetFile,
} from '../public/upload.js';

const SERVER_CAUSES = uploadFailureCauseSchema.options as readonly string[];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cause -> message coverage', () => {
  it('has a human sentence for every cause the API can return', () => {
    for (const cause of SERVER_CAUSES) {
      expect(UPLOAD_FAILURE_MESSAGE[cause], `missing UI message for cause "${cause}"`).toBeTypeOf(
        'string'
      );
    }
  });

  it('defines no message for a cause the API does not have', () => {
    expect(Object.keys(UPLOAD_FAILURE_MESSAGE).sort()).toEqual([...SERVER_CAUSES].sort());
  });

  it('never renders a bare status or a raw snake_case code at the user', () => {
    for (const cause of SERVER_CAUSES) {
      const shown = describeUploadFailure({ failureCause: cause, status: 500 });
      expect(shown).toMatch(/^Upload failed: /);
      expect(shown).not.toMatch(/HTTP \d/);
      expect(shown).not.toContain(cause);
    }
  });

  it('identifies each cause distinctly', () => {
    const sentences = SERVER_CAUSES.map((c) => UPLOAD_FAILURE_MESSAGE[c]);
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});

describe('describeUploadFailure', () => {
  it('leads with the cause for the size limit, not the 413', () => {
    const shown = describeUploadFailure({
      failureCause: UPLOAD_FAILURE_CAUSE.BODY_SIZE_LIMIT_EXCEEDED,
      status: 413,
      message: 'source exceeds maximum allowed size of 10737418240 bytes',
    });
    expect(shown).toContain('exceeds the upload size limit');
    expect(shown.indexOf('exceeds the upload size limit')).toBeLessThan(
      shown.indexOf('Details:')
    );
    // The API's own message is kept as trailing detail.
    expect(shown).toContain('source exceeds maximum allowed size of 10737418240 bytes');
  });

  it('tells the operator a network failure is worth retrying', () => {
    const shown = describeUploadFailure({
      failureCause: UPLOAD_FAILURE_CAUSE.NETWORK_ERROR,
    });
    expect(shown).toMatch(/network/i);
    expect(shown).toMatch(/retry/i);
  });

  it('names the storage backend when it refused the write', () => {
    const shown = describeUploadFailure({
      failureCause: UPLOAD_FAILURE_CAUSE.STORAGE_BACKEND_ERROR,
      status: 502,
      // `code` carries the S3 code; it must stay out of the user-facing text
      // (docs/guides/upload-failure-causes.md).
      code: 'AccessDenied',
    });
    expect(shown).toMatch(/storage/i);
    expect(shown).not.toContain('AccessDenied');
  });

  it('drops a message that only restates the transport status', () => {
    expect(
      describeUploadFailure({
        failureCause: UPLOAD_FAILURE_CAUSE.BODY_SIZE_LIMIT_EXCEEDED,
        status: 413,
        message: 'Upload failed: HTTP 413',
      })
    ).not.toMatch(/HTTP 413/);
    expect(
      describeUploadFailure({
        failureCause: UPLOAD_FAILURE_CAUSE.STORAGE_BACKEND_ERROR,
        message: 'Storage PUT failed: HTTP 403',
      })
    ).not.toMatch(/HTTP 403/);
  });

  it('falls back to the status when an error carries no structured cause', () => {
    // The `POST /assets` create call in the upload modal throws the ops UI's
    // apiFetch Error: { message, status, body } and no `failureCause`.
    const shown = describeUploadFailure({
      message: 'not_found',
      status: 404,
      body: { error: 'not_found' },
    });
    expect(shown).toContain(UPLOAD_FAILURE_MESSAGE[UPLOAD_FAILURE_CAUSE.ASSET_NOT_FOUND]);
  });

  it('falls back to the generic sentence when nothing structured is present', () => {
    const shown = describeUploadFailure(new Error('boom'));
    expect(shown).toContain(UPLOAD_FAILURE_MESSAGE[UPLOAD_FAILURE_CAUSE.UNKNOWN]);
    expect(shown).toContain('boom');
  });

  it('treats a cause value it does not recognise as unidentified (forward compatibility)', () => {
    const shown = describeUploadFailure({ failureCause: 'invented_later' });
    expect(shown).toContain(UPLOAD_FAILURE_MESSAGE[UPLOAD_FAILURE_CAUSE.UNKNOWN]);
    expect(shown).not.toContain('invented_later');
  });

  it('does not crash on a non-Error rejection', () => {
    expect(describeUploadFailure('kaboom')).toBe(
      'Upload failed: ' + UPLOAD_FAILURE_MESSAGE[UPLOAD_FAILURE_CAUSE.UNKNOWN] + '. Details: kaboom'
    );
    expect(describeUploadFailure(undefined)).toBe(
      'Upload failed: ' + UPLOAD_FAILURE_MESSAGE[UPLOAD_FAILURE_CAUSE.UNKNOWN] + '.'
    );
    expect(describeUploadFailure(null)).toMatch(/^Upload failed: /);
  });
});

describe('resolveFailureCause', () => {
  it('prefers the error’s own failureCause over its status', () => {
    expect(
      resolveFailureCause({ failureCause: UPLOAD_FAILURE_CAUSE.QUOTA_EXCEEDED, status: 500 })
    ).toBe(UPLOAD_FAILURE_CAUSE.QUOTA_EXCEEDED);
  });

  it('returns undefined when there is nothing to go on', () => {
    expect(resolveFailureCause(new Error('boom'))).toBeUndefined();
    expect(resolveFailureCause('boom')).toBeUndefined();
  });
});

// ─── end to end through the real upload driver ───────────────────────────────
//
// The failure #747/#771 were written for: a proxy in front of the API enforces
// its own request-body limit, answers 413 with an HTML body, and the API never
// sees the request. Driving uploadAssetFile proves the UI string produced from
// that rejection names the cause rather than the status.

function makeFakeFile(size: number) {
  return {
    size,
    type: 'video/mp4',
    slice: (start: number, end: number) => ({ start, end }) as unknown as Blob,
  } as unknown as File;
}

const deps = {
  apiFetch: async () => ({}),
  apiBase: 'http://api.test/api/v1',
  stackName: 'stack-1',
};

describe('upload failures rendered from the real driver', () => {
  it('a proxy 413 with no JSON body renders as the size limit, not HTTP 413', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 413,
            json: async () => {
              throw new Error('not json');
            },
          }) as unknown as Response
      )
    );
    const err = await uploadAssetFile('asset-1', makeFakeFile(8 * 1024 * 1024), deps).catch(
      (e: unknown) => e
    );
    const shown = describeUploadFailure(err);
    expect(shown).toContain('exceeds the upload size limit');
    expect(shown).not.toMatch(/HTTP 413/);
  });

  it("the API's structured envelope renders its cause plus the API message", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 502,
            json: async () => ({
              error: 'storage_error',
              cause: 'storage_backend_error',
              message: 'the storage backend rejected or failed the upload during putStream',
              code: 'NoSuchBucket',
            }),
          }) as unknown as Response
      )
    );
    const err = await uploadAssetFile('asset-1', makeFakeFile(8 * 1024 * 1024), deps).catch(
      (e: unknown) => e
    );
    const shown = describeUploadFailure(err);
    expect(shown).toContain(UPLOAD_FAILURE_MESSAGE[UPLOAD_FAILURE_CAUSE.STORAGE_BACKEND_ERROR]);
    expect(shown).toContain('during putStream');
    expect(shown).not.toContain('NoSuchBucket');
  });

  it('a fetch that never connects renders as a retryable network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    const err = await uploadAssetFile('asset-1', makeFakeFile(8 * 1024 * 1024), deps).catch(
      (e: unknown) => e
    );
    const shown = describeUploadFailure(err);
    expect(shown).toContain(UPLOAD_FAILURE_MESSAGE[UPLOAD_FAILURE_CAUSE.NETWORK_ERROR]);
  });
});
