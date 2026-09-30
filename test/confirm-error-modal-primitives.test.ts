// @vitest-environment happy-dom
//
// DOM/unit tests for the two reusable dialog primitives of issue #952: the
// positional confirmModal(subjectName, message, onConfirm) form and
// errorModal(title, reason). Both are required to be built ON the existing
// openModal rather than hand-rolling a backdrop, so every call site that needs a
// confirmation or an error display shares one styling and one behaviour.
//
// Scope note: this UI already had the richer primitives these signatures are the
// terse face of — confirmModal(spec) (issue #919, public/app.js) and errorToast()
// + reportActionFailure() (issues #918/#920). #952 adds the two documented
// signatures on top of them instead of a second dialog implementation, so these
// tests assert the delegation as much as the rendering. The spec-form coverage
// stays in test/confirm-modal-destructive.test.ts and test/error-toast.test.ts.
//
// Verified contract sources (CLAUDE.md rule 7 — read in the live tree, not assumed):
//   - openModal(title, buildBody, opts) -> close fn, public/app.js:964-1012. It
//     appends `.modal-backdrop > .modal-dialog[role=dialog][aria-modal=true]`
//     with a `.modal-header` (h3 + `.modal-close-btn`) and a `.modal-body`, calls
//     buildBody(bodyEl, close), and closes idempotently via the × button, Escape,
//     a backdrop click, or the returned close(). `opts.onClose` fires exactly
//     once on whichever route removed it (public/app.js:991-1007).
//   - confirmModal(spec) -> Promise<boolean>, public/app.js:1070 onwards: body
//     marked `.confirm-dialog`, question in `.confirm-question`, impact lists in
//     `.confirm-affected` / `.confirm-unaffected`, controls `.confirm-cancel` and
//     `.confirm-accept` inside `.modal-actions`.
//   - errorToast(message, opts) -> close fn, public/app.js onwards: body marked
//     `.error-dialog`, message in `.msg.msg-error[role=alert]`, optional
//     `.error-action` / `.error-detail`, dismiss control `.error-dismiss`. A blank
//     message falls back to 'The action failed, and the server did not say why.'
//   - The structured refusal envelope. Both routers declare the SAME closed enum:
//       src/routes/assets.ts:570      deleteBlockedSchema
//       src/routes/collections.ts:65  deleteBlockedSchema
//         { error: 'delete_blocked', message?: string,
//           reason: 'referenced_by_job'|'member_of_collection'|'delete_protected',
//           blockedBy: { jobIds: string[], collectionIds: string[] } }
//     and `reason` is only `z.string().optional()` on the generic envelope
//     (errorSchema, src/routes/collections.ts:43-47), so a body may carry no
//     reason or one this client has no copy for.
//   - apiFetch, public/app.js:244-283: on !res.ok it throws an Error whose
//     `message` is body.message -> body.error -> 'HTTP <status>' (:260-269) and
//     attaches `status` and the parsed `body` (:271-274). That rejection is what
//     a call site actually holds when it calls errorModal.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACTION_FAILURE_REASON_COPY,
  confirmModal,
  errorModal,
  resolveFailureText,
} from '../public/app.js';

// Read from the repo root (vitest runs with cwd = project root). `import.meta.url`
// is not a file: URL under the happy-dom environment, so it cannot be used here.
const APP_JS = readFileSync(resolve(process.cwd(), 'public/app.js'), 'utf8');

function confirmBody() {
  return document.querySelector('.confirm-dialog') as HTMLElement | null;
}

function errorBody() {
  return document.querySelector('.error-dialog') as HTMLElement | null;
}

function heading() {
  return (document.querySelector('.modal-header h3') as HTMLElement | null)?.textContent || '';
}

function click(selector: string) {
  (document.querySelector(selector) as HTMLElement).click();
}

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
}

// Shaped exactly like an apiFetch rejection (public/app.js:270-275).
function apiError(status: number, body: Record<string, unknown>) {
  const err = new Error(
    (body.message as string) || (body.error as string) || 'HTTP ' + status
  ) as Error & { status: number; body: unknown };
  err.status = status;
  err.body = body;
  return err;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
  document.body.innerHTML = '';
});

// ─── confirmModal positional form is built on openModal ────────────────────────

describe('confirmModal(subjectName, message, onConfirm) is built on openModal (#952)', () => {
  it('renders the same openModal chrome as every other dialog in the UI', () => {
    void confirmModal('Summer campaign rushes', 'Delete this asset?');

    expect(document.querySelectorAll('.modal-backdrop').length).toBe(1);

    const dlg = document.querySelector('.modal-dialog') as HTMLElement;
    expect(dlg).toBeTruthy();
    expect(dlg.getAttribute('role')).toBe('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.querySelector('.modal-close-btn')).toBeTruthy();

    // The shared confirmation body, not a second bespoke one.
    const body = confirmBody()!;
    expect(body.classList.contains('modal-body')).toBe(true);
  });

  it('delegates to the existing spec form rather than duplicating the markup', () => {
    // Source scan: the positional branch must normalise onto confirmModal's own
    // spec form. Pins the AC that these are primitives built ON openModal.
    const fn = APP_JS.slice(APP_JS.indexOf('function confirmModal('));
    const positional = fn.slice(0, fn.indexOf('const s = spec || {};'));
    expect(positional).toContain("typeof spec === 'string'");
    expect(positional).toContain('return confirmModal(normalised)');
    expect(positional).not.toContain('modal-backdrop');
  });

  it('shows the message as the question and names the subject', () => {
    void confirmModal('Summer campaign rushes', 'Delete "Summer campaign rushes" for good?');

    const question = confirmBody()!.querySelector('.confirm-question') as HTMLElement;
    expect(question.textContent).toBe('Delete "Summer campaign rushes" for good?');
  });

  it('falls back to a generated question naming the subject when the message is blank', () => {
    void confirmModal('Summer campaign rushes', '   ');

    const question = confirmBody()!.querySelector('.confirm-question') as HTMLElement;
    expect(question.textContent).toContain('Summer campaign rushes');
    expect(question.textContent).toContain('?');
  });

  it('omits both impact lists rather than rendering headings over nothing', () => {
    void confirmModal('Summer campaign rushes', 'Delete this asset?');

    const body = confirmBody()!;
    expect(body.querySelector('.confirm-affected')).toBeNull();
    expect(body.querySelector('.confirm-unaffected')).toBeNull();
  });

  it('writes the subject with textContent, never as HTML', () => {
    void confirmModal('<img src=x onerror=alert(1)>', '<b>Delete</b> it?');

    const body = confirmBody()!;
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('b')).toBeNull();
    expect(body.textContent).toContain('<b>Delete</b> it?');
  });
});

describe('confirmModal positional resolution contract (#952)', () => {
  it('resolves true and invokes onConfirm exactly once when confirmed', async () => {
    const onConfirm = vi.fn();
    const p = confirmModal('Summer campaign rushes', 'Delete this asset?', onConfirm);

    click('.confirm-accept');

    await expect(p).resolves.toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // The dialog is gone before the caller's continuation runs.
    expect(document.querySelector('.modal-backdrop')).toBeNull();
  });

  it('resolves false and never invokes onConfirm when cancelled', async () => {
    const onConfirm = vi.fn();
    const p = confirmModal('Summer campaign rushes', 'Delete this asset?', onConfirm);

    click('.confirm-cancel');

    await expect(p).resolves.toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it.each([
    ['Escape', () => pressEscape()],
    ['the × button', () => click('.modal-close-btn')],
    [
      'a backdrop click',
      () => (document.querySelector('.modal-backdrop') as HTMLElement).click(),
    ],
  ])('treats %s as a dismissal: false, and onConfirm is not invoked', async (_label, dismiss) => {
    const onConfirm = vi.fn();
    const p = confirmModal('Summer campaign rushes', 'Delete this asset?', onConfirm);

    dismiss();

    await expect(p).resolves.toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('works without an onConfirm callback', async () => {
    const p = confirmModal('Summer campaign rushes', 'Delete this asset?');
    click('.confirm-accept');
    await expect(p).resolves.toBe(true);
  });

  it('opens exactly ONE dialog per call', () => {
    void confirmModal('Summer campaign rushes', 'Delete this asset?');
    expect(document.querySelectorAll('.modal-backdrop').length).toBe(1);
    expect(document.querySelectorAll('.confirm-dialog').length).toBe(1);
  });

  it('leaves the spec form untouched: both impact lists still render', () => {
    void confirmModal({
      title: 'Delete collection',
      subject: 'Summer campaign rushes',
      affected: ['The collection record is deleted.'],
      unaffected: ['No assets are deleted.'],
    });

    const body = confirmBody()!;
    expect(body.querySelector('.confirm-affected')!.textContent).toContain('What this affects');
    expect(body.querySelector('.confirm-unaffected')!.textContent).toContain(
      'What this does not affect'
    );
  });
});

// ─── errorModal is built on openModal ──────────────────────────────────────────

describe('errorModal(title, reason) is built on openModal (#952)', () => {
  it('renders through openModal, in the app\'s own error styling', () => {
    errorModal('Delete collection failed', 'Bucket is not reachable.');

    expect(document.querySelectorAll('.modal-backdrop').length).toBe(1);

    const dlg = document.querySelector('.modal-dialog') as HTMLElement;
    expect(dlg.getAttribute('role')).toBe('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');

    // Same class pair showMsg() applies inline, so a failure looks identical
    // whether it lands inline or in this dialog. role=alert so it is announced.
    const msg = errorBody()!.querySelector('.msg.msg-error') as HTMLElement;
    expect(msg.getAttribute('role')).toBe('alert');
    expect(msg.textContent).toBe('Bucket is not reachable.');
  });

  it('delegates to the shared failure dialog rather than duplicating it', () => {
    const fn = APP_JS.slice(APP_JS.indexOf('function errorModal('));
    const bodyText = fn.slice(0, fn.indexOf('\n}\n'));
    expect(bodyText).toContain('errorToast(');
    expect(bodyText).not.toContain('modal-backdrop');
  });

  it('uses the title as the dialog heading', () => {
    errorModal('Delete collection failed', 'Bucket is not reachable.');
    expect(heading()).toBe('Delete collection failed');
  });

  it('falls back to the shared default heading when the title is blank', () => {
    errorModal('   ', 'Bucket is not reachable.');
    expect(heading().length).toBeGreaterThan(0);
    expect(heading().trim()).not.toBe('');
  });

  it('returns a close handle so a caller can dismiss it programmatically', () => {
    const close = errorModal('Delete collection failed', 'Bucket is not reachable.');
    expect(document.querySelector('.modal-backdrop')).toBeTruthy();
    close();
    expect(document.querySelector('.modal-backdrop')).toBeNull();
  });

  it('dismisses through its own control and through every openModal route', () => {
    errorModal('Delete collection failed', 'Bucket is not reachable.');
    click('.error-dismiss');
    expect(document.querySelector('.modal-backdrop')).toBeNull();

    errorModal('Delete collection failed', 'Bucket is not reachable.');
    pressEscape();
    expect(document.querySelector('.modal-backdrop')).toBeNull();
  });

  it('forwards the optional action and detail lines to the shared dialog', () => {
    errorModal('Delete collection failed', 'Bucket is not reachable.', {
      action: 'Delete collection',
      detail: 'Nothing was deleted.',
    });

    const body = errorBody()!;
    expect(body.querySelector('.error-action')!.textContent).toContain('Delete collection');
    expect(body.querySelector('.error-detail')!.textContent).toBe('Nothing was deleted.');
  });

  it('writes the reason with textContent, never as HTML', () => {
    errorModal('Delete failed', '<img src=x onerror=alert(1)>');
    const body = errorBody()!;
    expect(body.querySelector('img')).toBeNull();
    expect(body.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

// ─── errorModal renders the structured `reason` ────────────────────────────────

describe('errorModal renders the structured reason field (#952)', () => {
  it('prefers the operator-facing copy for a reason over the developer message', () => {
    // The server message here is the internal sentence issue #920 stopped
    // showing (DeleteProtectedError, src/data/asset-repo.ts:830).
    errorModal(
      'Delete asset failed',
      apiError(409, {
        error: 'delete_blocked',
        message: 'asset 01J8ZZZ is protected from deletion by an explicit lock',
        reason: 'delete_protected',
        blockedBy: { jobIds: [], collectionIds: [] },
      })
    );

    const text = errorBody()!.querySelector('.msg.msg-error')!.textContent || '';
    expect(text).toBe(ACTION_FAILURE_REASON_COPY.delete_protected);
    expect(text).not.toContain('01J8ZZZ');
  });

  it('reads the reason from a parsed error body handed over on its own', () => {
    errorModal('Delete collection failed', {
      error: 'delete_blocked',
      message: 'collection 01J8ZZZ is in use (2 member asset(s))',
      reason: 'member_of_collection',
    });

    const text = errorBody()!.querySelector('.msg.msg-error')!.textContent || '';
    expect(text).toBe(ACTION_FAILURE_REASON_COPY.member_of_collection);
  });

  it('covers every reason the routers can emit', () => {
    for (const reason of Object.keys(ACTION_FAILURE_REASON_COPY)) {
      expect(resolveFailureText({ error: 'delete_blocked', reason })).toBe(
        ACTION_FAILURE_REASON_COPY[reason as keyof typeof ACTION_FAILURE_REASON_COPY]
      );
    }
  });

  it('falls back to the server message when there is no structured reason', () => {
    // DELETE /api/v1/jobs/{id} answers 404 { error: 'not_found' } with no reason
    // (src/routes/jobs.ts:153-164) — the fallback arm.
    errorModal('Cancel job failed', apiError(404, { error: 'not_found' }));

    const text = errorBody()!.querySelector('.msg.msg-error')!.textContent || '';
    expect(text).toBe('not_found');
  });

  it('falls back to the server message when the reason is not one it knows', () => {
    errorModal(
      'Update collection failed',
      apiError(400, {
        error: 'invalid_metadata',
        message: 'description exceeds the maximum length of 2048 characters',
        reason: 'description_too_long',
      })
    );

    const text = errorBody()!.querySelector('.msg.msg-error')!.textContent || '';
    expect(text).toBe('description exceeds the maximum length of 2048 characters');
  });

  it('names an unrecognised reason code rather than claiming the server said nothing', () => {
    expect(resolveFailureText({ error: 'conflict', reason: 'some_new_reason' })).toContain(
      'some_new_reason'
    );
  });

  it('falls back to a generic message when there is no reason and no message', () => {
    errorModal('Delete asset failed', null);

    const text = errorBody()!.querySelector('.msg.msg-error')!.textContent || '';
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('failed');
  });

  it('never reaches an inherited property when looking up a reason', () => {
    // Guards the hasOwnProperty lookups: a body whose reason is 'constructor'
    // must not resolve to Object.prototype.constructor.
    expect(resolveFailureText({ error: 'conflict', reason: 'constructor' })).toContain(
      'constructor'
    );
    expect(resolveFailureText({ error: 'conflict', reason: 'toString' })).not.toContain(
      'function'
    );
  });

  it('accepts a plain string and an Error with no body', () => {
    expect(resolveFailureText('Bucket is not reachable.')).toBe('Bucket is not reachable.');
    expect(resolveFailureText(new Error('Network request failed'))).toBe(
      'Network request failed'
    );
  });
});
