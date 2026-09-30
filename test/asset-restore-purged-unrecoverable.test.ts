// @vitest-environment happy-dom
//
// A purged (410) asset reads as PERMANENTLY UNRECOVERABLE in the restore UI
// (issue #933).
//
// The restore action already handled its 410, but it handled it like every other
// failure: the same red `.msg-error` box used for a 403, a 5xx or a dropped
// connection, with the button left on screen merely disabled. Both invite the one
// thing that can never work here. These tests pin the distinction:
//   - a 410 is told apart from a retryable failure (isPurgedGone);
//   - the notice is visually AND textually distinct from `.msg-error`, and says
//     the outcome is final rather than "try again";
//   - the control that led there is REMOVED, not greyed out, and so is the note
//     that promised a revival;
//   - the notice persists (it is not a showMsg toast that vanishes after 6s);
//   - operator- and server-supplied text is escaped.
//
// Contract grounding — read in the live tree before these tests were written
// (CLAUDE.md rule 7):
//   - openapi.json .paths["/api/v1/assets/{id}/restore"].post.responses — keys are
//     exactly 200 / 404 / 410; one required path parameter `id`; no requestBody.
//   - src/routes/assets.ts:5755 — `response: { 200: assetSchema, 404: errorSchema,
//     410: errorSchema }` on `app.post('/:id/restore')`, mounted under
//     `/api/v1/assets`.
//   - src/routes/assets.ts:529 — `errorSchema = z.object({ error: z.string(),
//     message: z.string().optional() })`; `error` is the only required field.
//   - src/routes/assets.ts:5767 — the single 410 emitter:
//     `reply.code(410).send({ error: 'gone', message: 'asset has been purged' })`,
//     reached when `repo.getState(id).kind === 'tombstone'` (assets.ts:5764-5768).
//     No state change and no audit entry (assets.ts:5743-5744, 5780-5781).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isPurgedGone,
  renderPurgedUnrecoverable,
  PURGED_UNRECOVERABLE_LABEL,
  renderAssetDetailBody,
} from '../public/app.js';

const ULID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';

const ARCHIVED_ASSET = {
  id: ULID,
  name: 'retired-promo.mov',
  slug: 'retired-promo',
  status: 'archived',
  statusHistory: [
    { at: '2026-09-20T10:00:00.000Z', from: null, to: 'ready' },
    { at: '2026-09-25T08:30:00.000Z', from: 'ready', to: 'archived' },
  ],
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-25T08:30:00.000Z',
};

// Exactly the body src/routes/assets.ts:5767 sends.
const GONE_BODY = { error: 'gone', message: 'asset has been purged' };

type Outcome = { status: number; body: unknown };

function routedFetch(restore: () => Outcome) {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const path = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (/\/restore$/.test(path) && opts && opts.method === 'POST') {
      const out = restore();
      return json(out.body, out.status);
    }
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(ARCHIVED_ASSET);
    return json({}, 200);
  });
}

async function settle(ticks = 25) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('isPurgedGone — telling a tombstone apart from a retryable failure (#933)', () => {
  it('recognises the route’s own 410 body', () => {
    expect(isPurgedGone({ status: 410, body: GONE_BODY })).toBe(true);
  });

  it('recognises a 410 whose optional `message` is absent', () => {
    // errorSchema makes `message` optional (src/routes/assets.ts:529), so a body
    // of just `{ error: 'gone' }` is contract-legal.
    expect(isPurgedGone({ status: 410, body: { error: 'gone' } })).toBe(true);
  });

  it('recognises a 410 whose body could not be parsed at all', () => {
    // apiFetch leaves `body` undefined when the response is not JSON
    // (public/app.js, the non-ok branch of apiFetch). The status alone is
    // conclusive: the route declares one 410 and emits it from one line.
    expect(isPurgedGone({ status: 410 })).toBe(true);
    expect(isPurgedGone({ status: 410, body: undefined })).toBe(true);
  });

  it('does NOT claim the other documented failures, or a transport error', () => {
    expect(isPurgedGone({ status: 404, body: { error: 'not_found' } })).toBe(false);
    expect(isPurgedGone({ status: 403, body: { error: 'forbidden_insufficient_role' } })).toBe(
      false
    );
    expect(isPurgedGone({ status: 503 })).toBe(false);
    // A transport failure has no status at all.
    expect(isPurgedGone(new Error('Failed to fetch'))).toBe(false);
    expect(isPurgedGone(null)).toBe(false);
    expect(isPurgedGone(undefined)).toBe(false);
  });

  it('does not treat a different 410 code as a purge', () => {
    expect(isPurgedGone({ status: 410, body: { error: 'something_else' } })).toBe(false);
  });
});

describe('renderPurgedUnrecoverable — the notice itself (#933)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
  });

  it('is visually distinct from the generic error box', () => {
    const notice = renderPurgedUnrecoverable(host, { subject: '“clip.mov”' })!;

    expect(notice.classList.contains('msg')).toBe(true);
    expect(notice.classList.contains('msg-unrecoverable')).toBe(true);
    // The whole point: not the class that means "try again".
    expect(notice.classList.contains('msg-error')).toBe(false);
    // Machine-readable outcome, so a caller need not match on prose.
    expect(notice.getAttribute('data-outcome')).toBe('unrecoverable');
    expect(notice.getAttribute('role')).toBe('alert');
  });

  it('is textually distinct: labelled final, with no invitation to retry', () => {
    const notice = renderPurgedUnrecoverable(host, { subject: '“clip.mov”' })!;
    const text = notice.textContent || '';

    // A standing label, not a sentence the operator has to parse.
    expect(notice.querySelector('.unrecoverable-label')?.textContent).toBe(
      PURGED_UNRECOVERABLE_LABEL
    );
    expect(PURGED_UNRECOVERABLE_LABEL.toLowerCase()).toContain('permanently unrecoverable');

    expect(text).toContain('clip.mov');
    expect(text).toContain('purged');
    expect(text).toContain('tombstone');
    expect(text).toContain('410');
    expect(text).toContain('can never be restored');
    expect(text).toContain('final');
    // It must never read like the retryable copy this app uses elsewhere.
    expect(text).not.toMatch(/try again/i);
    expect(text).not.toMatch(/retry now|try later|temporar(y|ily) unavailable/i);
    // And it offers the only real way forward instead of a retry.
    expect(text).toContain('ingest the source file as a new asset');
  });

  it('shows the API’s own message when there is one, and omits the line when not', () => {
    const withMsg = renderPurgedUnrecoverable(host, {
      subject: '“clip.mov”',
      serverMessage: GONE_BODY.message,
    })!;
    expect(withMsg.querySelector('.unrecoverable-detail')?.textContent).toContain(
      'asset has been purged'
    );

    const withoutMsg = renderPurgedUnrecoverable(host, { subject: '“clip.mov”' })!;
    expect(withoutMsg.querySelector('.unrecoverable-detail')).toBeNull();
  });

  it('falls back to a generic subject rather than empty quotes', () => {
    const notice = renderPurgedUnrecoverable(host, {})!;
    expect(notice.textContent).toContain('This asset has been purged');
    expect(notice.textContent).not.toContain('“”');
  });

  it('escapes operator- and server-supplied text', () => {
    const notice = renderPurgedUnrecoverable(host, {
      subject: '<img src=x onerror="alert(1)">',
      serverMessage: '<script>alert(2)</script>',
    })!;

    expect(notice.querySelector('img')).toBeNull();
    expect(notice.querySelector('script')).toBeNull();
    // The dangerous text survives as text, escaped.
    expect(notice.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(notice.textContent).toContain('<script>alert(2)</script>');
  });

  it('removes the controls it is handed, and survives the toast lifetime', async () => {
    vi.useFakeTimers();
    try {
      const btn = document.createElement('button');
      btn.id = 'doomed-btn';
      const note = document.createElement('div');
      note.id = 'doomed-note';
      host.appendChild(btn);
      host.appendChild(note);

      renderPurgedUnrecoverable(host, { retire: [btn, note] });

      // Removed outright: a disabled control still reads as "not right now".
      expect(host.querySelector('#doomed-btn')).toBeNull();
      expect(host.querySelector('#doomed-note')).toBeNull();
      expect(host.querySelector('button')).toBeNull();

      // showMsg auto-dismisses after 6s; the one outcome that never changes must
      // not quietly disappear.
      vi.advanceTimersByTime(30000);
      expect(host.querySelector('.msg-unrecoverable')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('asset detail — a 410 from restore is unrecoverable, not an error (#933)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('replaces the restore affordance with the unrecoverable notice', async () => {
    vi.stubGlobal('fetch', routedFetch(() => ({ status: 410, body: GONE_BODY })));

    await renderAssetDetailBody(ARCHIVED_ASSET.id, container);
    // Precondition: the archived asset does offer the action.
    expect(container.querySelector('#btn-restore-asset')).not.toBeNull();
    expect(container.querySelector('#restore-note')).not.toBeNull();

    container.querySelector<HTMLButtonElement>('#btn-restore-asset')!.click();
    await settle();

    const notice = container.querySelector('#restore-gone-notice')!;
    expect(notice).not.toBeNull();
    expect(notice.classList.contains('msg-unrecoverable')).toBe(true);
    expect(notice.classList.contains('msg-error')).toBe(false);
    expect(notice.getAttribute('data-outcome')).toBe('unrecoverable');
    expect(notice.getAttribute('role')).toBe('alert');

    // Names the asset it is talking about, and the API's own words.
    expect(notice.textContent).toContain(ARCHIVED_ASSET.name);
    expect(notice.textContent).toContain('asset has been purged');

    // No retry affordance survives: not the button, and not the note that
    // promised the revival (which was also the button's aria-describedby target).
    expect(container.querySelector('#btn-restore-asset')).toBeNull();
    expect(container.querySelector('#restore-note')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    ).not.toContain('Restore');
  });

  it('does not reuse the treatment a transient failure gets', async () => {
    // Same action, a retryable failure: the generic red box, and the control stays
    // usable. The two outcomes must not look alike.
    vi.stubGlobal(
      'fetch',
      routedFetch(() => ({
        status: 503,
        body: { error: 'unavailable', message: 'upstream temporarily unavailable' },
      }))
    );

    await renderAssetDetailBody(ARCHIVED_ASSET.id, container);
    const btn = container.querySelector<HTMLButtonElement>('#btn-restore-asset')!;
    btn.click();
    await settle();

    expect(container.querySelector('#restore-gone-notice')).toBeNull();
    expect(container.querySelector('[data-outcome="unrecoverable"]')).toBeNull();
    expect(container.querySelector('#action-msg')?.textContent).toContain('Restore failed');
    // Retryable, so the affordance remains.
    expect(container.querySelector('#btn-restore-asset')).not.toBeNull();
    expect(btn.disabled).toBe(false);
  });

  it('does not fire the restore call twice after a 410', async () => {
    const fetchSpy = routedFetch(() => ({ status: 410, body: GONE_BODY }));
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ARCHIVED_ASSET.id, container);
    const btn = container.querySelector<HTMLButtonElement>('#btn-restore-asset')!;
    btn.click();
    await settle();

    // The control is detached, so even a stored reference cannot re-dispatch into
    // a live view; clicking the orphan must not add a second POST.
    btn.click();
    await settle();

    const restoreCalls = fetchSpy.mock.calls.filter(([u]) => /\/restore$/.test(String(u)));
    expect(restoreCalls).toHaveLength(1);
  });
});
