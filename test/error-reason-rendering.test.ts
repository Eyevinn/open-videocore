// @vitest-environment happy-dom
//
// DOM/unit tests for app-styled error rendering driven by the API's structured
// error `reason` (issue #920), and for the last operator path that still used a
// native alert() — the jobs table's row cancel button.
//
// Verified contract sources (CLAUDE.md rule 7 — read in the live tree, not assumed):
//   - Shared refusal envelope. Both routers declare the SAME closed enum:
//       src/routes/assets.ts:570      deleteBlockedSchema
//       src/routes/collections.ts:65  deleteBlockedSchema
//         { error: 'delete_blocked', message?: string,
//           reason: 'referenced_by_job'|'member_of_collection'|'delete_protected',
//           blockedBy: { jobIds: string[], collectionIds: string[] } }
//     Emitted at src/routes/assets.ts:2695 / :2707 / :2720 and
//     src/routes/collections.ts:262 / :275.
//   - `reason` is OPTIONAL on the generic envelope — errorSchema,
//     src/routes/collections.ts:43-47 `{ error, message?, reason? }` — so a body
//     may carry none, and z.string() means it need not be a value this client knows.
//   - The server `message` behind those reasons is developer-facing:
//     `collection <id> is in use (N member asset(s))` (CollectionInUseError,
//     src/data/collection-repo.ts:160) and `asset <id> is protected from deletion
//     by an explicit lock` (DeleteProtectedError, src/data/asset-repo.ts:830).
//     Those are the internal strings this issue stops showing.
//   - apiFetch, public/app.js:244-283: on !res.ok it throws an Error whose
//     `message` is body.message -> body.error -> 'HTTP <status>' (:260-269) and
//     attaches `status` and the parsed `body` (:271-274). The `body` is what the
//     reason is read from.
//   - DELETE /api/v1/jobs/{id} answers 200 (the cancelled job) | 404
//     `{ error: 'not_found' }` — src/routes/jobs.ts:153-164. No `reason`, so the
//     jobs path exercises the fallback arm.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_FAILURE_REASON_COPY,
  humanizeErrorReason,
  reportActionFailure,
} from '../public/app.js';
import { createJobsTable } from '../public/jobs-table.js';

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function dialog() {
  return document.querySelector('.error-dialog') as HTMLElement | null;
}

function apiError(status: number, body: unknown) {
  // Shaped exactly like an apiFetch rejection (public/app.js:270-275).
  const b = body as { message?: string; error?: string };
  const err = new Error(b?.message || b?.error || 'HTTP ' + status) as Error & {
    status: number;
    body: unknown;
  };
  err.status = status;
  err.body = body;
  return err;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
  document.body.innerHTML = '';
});

// ─── The mapping (issue #920 AC3) ──────────────────────────────────────────────

describe('humanizeErrorReason maps the declared reason enum', () => {
  it('covers every value of the shared delete_blocked enum', () => {
    // The enum is closed by src/routes/collections.ts:65 — if the server adds a
    // member, this assertion is where the client notices.
    expect(Object.keys(ACTION_FAILURE_REASON_COPY).sort()).toEqual([
      'delete_protected',
      'member_of_collection',
      'referenced_by_job',
    ]);
  });

  it('humanizes a reason-bearing refusal instead of the internal message', () => {
    const err = apiError(409, {
      error: 'delete_blocked',
      message: 'collection 01J8ZQF7 is in use (2 member asset(s))',
      reason: 'member_of_collection',
      blockedBy: { jobIds: [], collectionIds: [] },
    });

    const text = humanizeErrorReason(err);
    expect(text).toBe(ACTION_FAILURE_REASON_COPY.member_of_collection);
    // The developer-facing sentence, and the opaque id in it, never reach the UI.
    expect(text).not.toContain('01J8ZQF7');
    expect(text).not.toContain('member asset(s)');
  });

  it('returns null for a body with no reason, an unknown reason, or no body', () => {
    // Real shapes: the plain envelope (src/routes/collections.ts:43-47) and the
    // 404 from DELETE /api/v1/jobs/{id} (src/routes/jobs.ts:164).
    expect(humanizeErrorReason(apiError(404, { error: 'not_found' }))).toBeNull();
    // `reason` is z.string(), so an unrecognised value is contract-legal.
    expect(
      humanizeErrorReason(apiError(400, { error: 'bad_request', reason: 'brand_new_reason' }))
    ).toBeNull();
    // A network failure never reaches a body at all.
    expect(humanizeErrorReason(new Error('Failed to fetch'))).toBeNull();
  });

  it('does not resolve a reason through the prototype chain', () => {
    // `reason` is server-controlled; a value like `constructor` must not find an
    // inherited property and render something nonsensical.
    expect(humanizeErrorReason(apiError(400, { error: 'x', reason: 'constructor' }))).toBeNull();
    expect(humanizeErrorReason(apiError(400, { error: 'x', reason: 'toString' }))).toBeNull();
  });
});

// ─── The rendering (issue #920 AC2) ────────────────────────────────────────────

describe('reportActionFailure renders in app styling, never a native alert', () => {
  it('shows the humanized reason, the action, and the caller detail', () => {
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);

    reportActionFailure(
      apiError(409, {
        error: 'delete_blocked',
        message: 'asset 01J8ZQF7 is protected from deletion by an explicit lock',
        reason: 'delete_protected',
        blockedBy: { jobIds: [], collectionIds: [] },
      }),
      { action: 'Archive asset', detail: '"Rushes 01" was not archived. Nothing has changed.' }
    );

    expect(alertSpy).not.toHaveBeenCalled();

    const el = dialog();
    expect(el).toBeTruthy();
    // App styling + the announced-on-open role errorToast established (#918).
    expect(el!.classList.contains('modal-body')).toBe(true);
    expect(el!.querySelector('.msg-error')!.getAttribute('role')).toBe('alert');
    expect(el!.querySelector('.msg-error')!.textContent)
      .toBe(ACTION_FAILURE_REASON_COPY.delete_protected);
    expect(el!.querySelector('.error-action')!.textContent).toBe('Archive asset failed.');
    expect(el!.querySelector('.error-detail')!.textContent)
      .toBe('"Rushes 01" was not archived. Nothing has changed.');
  });

  it('falls back to the server message when no reason is carried', () => {
    reportActionFailure(apiError(501, {
      error: 'not_configured',
      message: 'technical metadata extraction is not configured',
    }), { action: 'Re-drive metadata extraction' });

    expect(dialog()!.querySelector('.msg-error')!.textContent)
      .toBe('technical metadata extraction is not configured');
  });

  it('shows the status line when the body carries neither reason nor message', () => {
    // apiFetch's last resort is 'HTTP <status>' (public/app.js:260, :268).
    reportActionFailure(apiError(500, {}), { action: 'Delete object' });
    expect(dialog()!.querySelector('.msg-error')!.textContent).toBe('HTTP 500');
  });

  it('falls back to a generic app-styled sentence when there is no text at all', () => {
    // e.g. a rejection with no message; errorToast's empty guard (app.js:1260-1262).
    reportActionFailure(new Error(''), { action: 'Delete object' });
    const text = dialog()!.querySelector('.msg-error')!.textContent || '';
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toBe('The action failed, and the server did not say why.');
  });

  it('escapes rather than parses server text', () => {
    reportActionFailure(apiError(500, { message: '<img src=x onerror=alert(1)>' }), {});
    const el = dialog()!.querySelector('.msg-error') as HTMLElement;
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

// ─── The last alert() site: the jobs table row cancel (issue #920 AC1) ─────────

describe('jobs table reports a failed cancel through the injected handler', () => {
  const JOBS = [
    {
      id: 'job-1',
      type: 'transcode',
      status: 'running',
      assetId: 'asset-a',
      progress: 10,
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T10:05:00.000Z',
    },
  ];

  async function mountAndCancel(deps: Record<string, unknown>) {
    const apiFetch = vi.fn().mockResolvedValue({ items: JOBS, total: 1 });
    const table = createJobsTable({ apiFetch, win: null, ...deps });
    document.body.appendChild(table.el);
    // The table does not self-load; the consumer drives the first fetch
    // (public/jobs-table.js `refresh: (silent) => fetchWorkingSet(silent)`).
    await table.refresh();
    await flush();
    const btn = table.el.querySelector('.job-cancel-btn') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    await flush();
    return { table, btn };
  }

  it('calls onCancelError with the error and the job id, and never alerts', async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    const onCancelError = vi.fn();
    // DELETE /api/v1/jobs/{id} 404 (src/routes/jobs.ts:164).
    const err = apiError(404, { error: 'not_found' });

    const { btn } = await mountAndCancel({
      onCancel: vi.fn().mockRejectedValue(err),
      onCancelError,
    });

    expect(alertSpy).not.toHaveBeenCalled();
    expect(onCancelError).toHaveBeenCalledTimes(1);
    expect(onCancelError.mock.calls[0][0]).toBe(err);
    expect(onCancelError.mock.calls[0][1]).toBe('job-1');
    // The button is re-enabled so the operator can retry.
    expect(btn.disabled).toBe(false);
  });

  it('falls back to the table status line, not an alert, with no handler', async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);

    const { table } = await mountAndCancel({
      onCancel: vi.fn().mockRejectedValue(apiError(404, { error: 'not_found' })),
    });

    expect(alertSpy).not.toHaveBeenCalled();
    expect(table.el.textContent).toContain('Failed to cancel job');
  });
});
