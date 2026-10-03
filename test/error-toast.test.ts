// @vitest-environment happy-dom
//
// DOM/unit tests for errorToast(), the shared action-failure dialog primitive
// (issue #918), and for the one call site wired as its smoke test.
//
// Scope note: issue #918 asked for TWO primitives, confirmModal and errorToast.
// confirmModal already shipped with issue #919 (public/app.js:1051) with a richer
// spec-object signature than #918 sketched, and is covered by
// test/confirm-modal-destructive.test.ts. Only errorToast was missing, so only it
// is added and tested here — see that file for the confirmModal coverage.
//
// Verified contract sources (CLAUDE.md rule 7 — read in the live tree, not assumed):
//   - openModal(title, buildBody, opts) -> close fn, public/app.js:945-993. It
//     appends `.modal-backdrop > .modal-dialog[role=dialog][aria-modal=true]`
//     with a `.modal-header` (h3 + `.modal-close-btn`) and a `.modal-body`, calls
//     buildBody(bodyEl, close), and closes idempotently via the × button, Escape,
//     a backdrop click, or the returned close(). `opts.onClose` fires exactly once
//     on whichever route removed it (:972-981).
//   - apiFetch, public/app.js:244-283. On !res.ok it throws an Error whose
//     `message` is already resolved as body.message -> body.error -> 'HTTP <status>'
//     (:260-269), with `status` and the parsed `body` attached (:271-274). So
//     err.message is the human-readable text errorToast should show verbatim.
//   - DELETE /api/v1/collections/{id} (openapi.json) answers 204 | 404 | 409. The
//     409 body is { error: 'delete_blocked', message, reason:
//     'referenced_by_job'|'member_of_collection'|'delete_protected', blockedBy },
//     which is why the refusal reason reaches the operator through err.message.
//   - Collection list read shape: `assetIds` is the authoritative member list
//     (collectionSchema, src/routes/collections.ts:80-91).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTION_FAILURE_REASON_COPY, errorToast, TAB_RENDERERS } from '../public/app.js';
// The shared reason deck (issue #920), which issue #921 moved into its own leaf
// module so the pre-flight and post-flight paths read one source.
import { actionFailureReasonCopy } from '../public/action-failure-reasons.js';

// Read from the repo root (vitest runs with cwd = project root). `import.meta.url`
// is not a file: URL under the happy-dom environment, so it cannot be used here.
const APP_JS = readFileSync(resolve(process.cwd(), 'public/app.js'), 'utf8');

function jsonResponse(payload: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: status === 204 ? {} : { 'content-type': 'application/json' },
  });
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function dialog() {
  return document.querySelector('.error-dialog') as HTMLElement | null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
  document.body.innerHTML = '';
});

// ─── The primitive is built on openModal ───────────────────────────────────────

describe('errorToast is built on openModal (issue #918 AC1)', () => {
  it('renders through openModal: one backdrop, one role=dialog, app styling', () => {
    errorToast('Bucket is not reachable.');

    expect(document.querySelectorAll('.modal-backdrop').length).toBe(1);

    const dlg = document.querySelector('.modal-dialog') as HTMLElement;
    expect(dlg).toBeTruthy();
    // openModal's own contract (app.js:951-952), inherited rather than re-created.
    expect(dlg.getAttribute('role')).toBe('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.querySelector('.modal-header h3')).toBeTruthy();
    expect(dlg.querySelector('.modal-close-btn')).toBeTruthy();

    // The body is openModal's .modal-body, marked with our variant class.
    const body = dialog()!;
    expect(body.classList.contains('modal-body')).toBe(true);
  });

  it('calls openModal rather than hand-rolling a backdrop', () => {
    // Source scan: the implementation must delegate, not duplicate. Pins the AC
    // that both primitives are built ON openModal.
    const fn = APP_JS.slice(APP_JS.indexOf('function errorToast('));
    const bodyText = fn.slice(0, fn.indexOf('\n}\n'));
    expect(bodyText).toContain('openModal(');
    expect(bodyText).not.toContain('modal-backdrop');
  });

  it('shows the message in the app\'s own error styling, not a bespoke one', () => {
    errorToast('Bucket is not reachable.');
    // Same class pair showMsg() applies for an inline failure (app.js:927-934),
    // so a failure looks identical inline and in the dialog.
    const msg = dialog()!.querySelector('.msg.msg-error') as HTMLElement;
    expect(msg).toBeTruthy();
    expect(msg.textContent).toBe('Bucket is not reachable.');
  });
});

// ─── Content and accessibility ─────────────────────────────────────────────────

describe('errorToast content (issue #918)', () => {
  it('uses a default heading and names the failed action when given one', () => {
    errorToast('Collection is not empty.', { action: 'Delete collection' });
    const h3 = document.querySelector('.modal-header h3') as HTMLElement;
    expect(h3.textContent).toBe('Something went wrong');
    // The operator should not have to infer WHICH action failed from the message.
    expect(dialog()!.querySelector('.error-action')!.textContent)
      .toBe('Delete collection failed.');
  });

  it('honours an explicit title, detail line and close label', () => {
    errorToast('Nope.', {
      title: 'Re-drive failed',
      detail: 'assets/01J8A/source.mov',
      closeLabel: 'Dismiss',
    });
    expect((document.querySelector('.modal-header h3') as HTMLElement).textContent)
      .toBe('Re-drive failed');
    expect(dialog()!.querySelector('.error-detail')!.textContent)
      .toBe('assets/01J8A/source.mov');
    expect(dialog()!.querySelector('.error-dismiss')!.textContent).toBe('Dismiss');
  });

  it('omits the optional lines when they are not supplied', () => {
    errorToast('Bare failure.');
    expect(dialog()!.querySelector('.error-action')).toBeNull();
    expect(dialog()!.querySelector('.error-detail')).toBeNull();
  });

  it('falls back to a sentence rather than opening an empty dialog', () => {
    for (const bad of [undefined, null, '', '   ']) {
      errorToast(bad as unknown as string);
      expect(dialog()!.querySelector('.msg-error')!.textContent)
        .toBe('The action failed, and the server did not say why.');
      document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
    }
  });

  it('announces the message to assistive tech (WCAG 2.1 AA 4.1.3)', () => {
    errorToast('Bucket is not reachable.');
    // The heading is static across every failure; the message is the part that
    // changes, so the live region has to be on the message.
    expect(dialog()!.querySelector('.msg-error')!.getAttribute('role')).toBe('alert');
  });

  it('focuses the dismiss control, the only way out of the dialog', () => {
    errorToast('Bucket is not reachable.');
    expect(document.activeElement).toBe(dialog()!.querySelector('.error-dismiss'));
  });

  it('renders server and tenant data as text, never as markup', () => {
    // Error messages embed object keys, asset names and webhook URLs.
    errorToast('<img src=x onerror=alert(1)>', {
      action: '<b>act</b>',
      detail: '<script>bad()</script>',
    });
    const el = dialog()!;
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

// ─── Dismissal: every openModal route, exactly once ────────────────────────────

describe('errorToast dismissal (issue #918)', () => {
  it('closes on the dismiss button', () => {
    errorToast('Boom.');
    (dialog()!.querySelector('.error-dismiss') as HTMLButtonElement).click();
    expect(dialog()).toBeNull();
  });

  it('closes on the × control, Escape and a backdrop click', () => {
    errorToast('Boom.');
    (document.querySelector('.modal-close-btn') as HTMLButtonElement).click();
    expect(dialog()).toBeNull();

    errorToast('Boom.');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dialog()).toBeNull();

    errorToast('Boom.');
    (document.querySelector('.modal-backdrop') as HTMLElement)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dialog()).toBeNull();
  });

  it('returns openModal\'s close handle so a caller can dismiss it', () => {
    const close = errorToast('Boom.');
    expect(typeof close).toBe('function');
    close();
    expect(dialog()).toBeNull();
  });

  it('fires onClose exactly once, whichever route dismissed it', () => {
    const onClose = vi.fn();
    const close = errorToast('Boom.', { onClose });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    // A late programmatic close must not double-fire (openModal:972-981).
    close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ─── Smoke test: the one wired call site (issue #918 AC3) ──────────────────────

describe('Collections tab delete failure uses errorToast (issue #918 AC3)', () => {
  // EMPTY as the list read it. Since issue #921 a collection the list already
  // shows as non-empty never reaches the request at all — it is explained before
  // the confirmation instead — so the post-flight failure path is now reached
  // only by a genuine race: someone added members between this read and the
  // click, and the API answers the 409 below.
  const COLLECTION = {
    id: '01J8ZQF7TESTCOLLECTIONID',
    name: 'Summer campaign rushes',
    assetIds: [] as string[],
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  };

  // The 409 the API really returns for a non-empty collection (openapi.json
  // DELETE /api/v1/collections/{id}, 409 delete_blocked / member_of_collection).
  const BLOCKED = {
    error: 'delete_blocked',
    message: 'Collection still has 2 members; remove them before deleting.',
    reason: 'member_of_collection',
    blockedBy: { collectionIds: [] as string[] },
  };

  async function renderTabAndDelete() {
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api\/v1/, '');
      const method = (init?.method || 'GET').toUpperCase();
      if (path === '/collections' && method === 'GET') {
        return jsonResponse({ collections: [COLLECTION] });
      }
      if (method === 'DELETE') return jsonResponse(BLOCKED, 409);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchStub);

    const container = document.createElement('div');
    document.body.appendChild(container);
    await TAB_RENDERERS['collections'](container);
    await flush();

    // Delete is gated by confirmModal (issue #919); accept it to reach the
    // failure path this test is about.
    (container.querySelector('.coll-delete-btn') as HTMLButtonElement).click();
    await flush();
    (document.querySelector('.confirm-accept') as HTMLButtonElement).click();
    await flush();

    return container;
  }

  it('reports the 409 refusal in an errorToast, not a native alert()', async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);

    await renderTabAndDelete();

    expect(alertSpy).not.toHaveBeenCalled();

    const el = dialog();
    expect(el).toBeTruthy();
    expect(el!.querySelector('.error-action')!.textContent)
      .toBe('Delete collection failed.');
    // The 409 carries a structured `reason` (src/routes/collections.ts:298-306),
    // so the operator gets the humanized copy for it — NOT the server's internal
    // sentence (issue #920). The fallback to `message` is covered separately, in
    // test/error-reason-rendering.test.ts.
    //
    // Subject-specific wording (issue #921): `member_of_collection` from THIS
    // router means "this collection still holds members", not "the subject is
    // inside a collection", so the call site passes `subject: 'collection'` and
    // gets the collections deck.
    expect(el!.querySelector('.msg-error')!.textContent)
      .toBe(actionFailureReasonCopy('member_of_collection', { subject: 'collection' }));
    expect(el!.querySelector('.msg-error')!.textContent)
      .not.toBe(ACTION_FAILURE_REASON_COPY.member_of_collection);
    expect(el!.querySelector('.msg-error')!.textContent).not.toBe(BLOCKED.message);
    // Names the collection by name, and says plainly that nothing changed.
    expect(el!.querySelector('.error-detail')!.textContent)
      .toBe('Collection "Summer campaign rushes" was not deleted.');
  });
});

// ─── Scope discipline (issue #918 AC2) ─────────────────────────────────────────

describe('no native alert() remains on an operator path (issue #920 AC1)', () => {
  it('has migrated every native alert() site in app.js', () => {
    // Strip line comments so prose mentioning alert() cannot mask or fake a call.
    const code = APP_JS.split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    // 8 native sites existed before #918; #918 migrated one and #920 the other 7.
    expect(code.match(/(^|[^\w.])alert\s*\(/g) || []).toHaveLength(0);

    // Every one of them now goes through the shared primitive.
    expect(code).toContain('function errorToast(');
    expect(code).toContain('function reportActionFailure(');
  });
});
