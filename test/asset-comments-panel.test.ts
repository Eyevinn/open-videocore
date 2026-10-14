// @vitest-environment happy-dom
//
// Comments add/read panel on the asset editorial view (issue #900, broken out of
// #792). MVP scope is ADD + READ ONLY; edit/delete are out of scope, and the
// tests below assert that the panel issues no request that would imply either.
//
// The integration block drives the REAL detail renderer (renderAssetDetailBody —
// the same code path used by the asset side panel and the detached detail
// window) against a stubbed fetch.
//
// CONTRACT GROUNDING — every path, field and status below was read from this
// repo's generated spec and route source before the tests were written
// (CLAUDE.md rule 7), never from the issue text. `openapi.json` declares no
// `operationId` anywhere, so operations are named by path + method.
//
//   THE PATH IS A SUB-RESOURCE. The issue says `/comments`; no such top-level
//   path exists. The only comments path in the spec is
//   `/api/v1/assets/{id}/comments`, and it carries exactly two operations —
//   `get` and `post`.
//
//   READ — openapi.json .paths["/api/v1/assets/{id}/comments"].get
//     parameters: one path param `id` (string, required). NO query parameters,
//       so the list is unpaged and unordered-by-the-client.
//     responses: exactly 200 and 404.
//     200 schema: `type: array`, items
//       { id, assetId, body, createdAt } — all four `required`, all strings,
//       additionalProperties: false. A bare array, NOT an envelope.
//     404 schema: { error: string, message?: string }, required ["error"].
//     Source: app.get('/:id/comments', …), src/routes/assets.ts:4798-4814 —
//       `response: { 200: z.array(commentSchema), 404: errorSchema }` (:4803);
//       the handler 404s on an unknown/foreign parent (:4807-4809) before
//       sending `comments.listByAsset(asset.id)` (:4811-4812).
//     ORDER IS THE SERVER'S: oldest -> newest, `createdAt` primary with the ULID
//       `id` breaking same-millisecond ties (InMemoryCommentRepository.listByAsset,
//       src/data/comment-repo.ts:50-58; interface contract :31).
//
//   WRITE — …["/api/v1/assets/{id}/comments"].post
//     requestBody: required: true, application/json, schema
//       { body: string, minLength: 1, maxLength: 4096 }, required ["body"],
//       additionalProperties: false. `body` is the ONLY property the request may
//       carry — no author, no timecode, no thread id.
//     responses: exactly 201 (the created comment, same four-field object) and
//       404.
//     Source: app.post('/:id/comments', …), src/routes/assets.ts:4776-4793 —
//       `body: commentBodySchema` (:4781), `response: { 201: commentSchema,
//       404: errorSchema }` (:4782), handler passes `request.body.body` through
//       (:4790).
//     commentBodySchema = z.object({ body: z.string().trim().min(1).max(4096) }),
//       src/routes/assets.ts:1174-1176. `.trim()` runs BEFORE `.min(1)`, so a
//       whitespace-only body is a 400 — asserted server-side at
//       test/asset-comments.test.ts:149-179.
//     400 IS UNDECLARED in the response map but real (produced by the body
//       schema at the validation layer), so the panel treats it as an outcome
//       rather than as "unexpected".
//
//   RECORD SHAPE — `Comment`, src/data/comment-repo.ts:17-22: `id` is a ULID and
//     `createdAt` an ISO 8601 string, both SERVER-MINTED
//     (InMemoryCommentRepository.create, :38-48). The client can neither supply
//     nor predict them, which is why an accepted comment is re-read rather than
//     spliced in optimistically — asserted below.
//
//   AUTHORISATION — MATRIX (src/auth/authorize.ts:54-58) gives `viewer`
//     { read: true, write: false }; methodToAction (:79-93) maps GET -> read and
//     POST -> write; resourceAuthorizationPreHandler('asset') (:126, registered
//     src/routes/assets.ts:1748) enforces it with 403
//     AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role' (:99). So a viewer
//     READS comments but cannot add one.
//
//   NOT EXPOSED, CHECKED NOT ASSUMED:
//     - no `…/comments/{commentId}` path anywhere in openapi.json, and
//       CommentRepository declares only `create` + `listByAsset`
//       (src/data/comment-repo.ts:29-33) — hence no edit and no delete.
//     - no author field on `Comment` (:17-22), and no per-user identity exists to
//       fill one (src/auth/principal.ts:11-16).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetDetailBody } from '../public/app.js';
import {
  COMMENTS_COPY,
  COMMENT_MAX_LENGTH,
  classifyCommentError,
  commentTimeLabel,
  mountAssetComments,
  normaliseCommentList,
  renderComment,
  renderCommentsBlock,
  validateDraft,
} from '../public/comments-panel.js';

const ULID = '01J9BBBBBBBBBBBBBBBBBBBBBB';

/** Two comments as the 200 array actually arrives: oldest first. */
const COMMENTS = [
  {
    id: '01J9CCCCCCCCCCCCCCCCCCCCC1',
    assetId: ULID,
    body: 'Check the audio sync at 00:42.',
    createdAt: '2026-09-21T08:00:00.000Z',
  },
  {
    id: '01J9CCCCCCCCCCCCCCCCCCCCC2',
    assetId: ULID,
    body: 'Re-ingested the master, sync is fine now.',
    createdAt: '2026-09-21T09:30:00.000Z',
  },
];

const ASSET = {
  id: ULID,
  name: 'trailer-master.mov',
  status: 'ready',
  reviewState: 'draft',
  statusHistory: [{ at: '2026-09-21T08:00:00.000Z', from: null, to: 'ready' }],
  createdAt: '2026-09-21T08:00:00.000Z',
  updatedAt: '2026-09-21T09:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Route by path. The comments sub-resource is matched before the asset read. */
function routedFetch(comments: unknown = COMMENTS, commentsStatus = 200) {
  return vi.fn(async (url: string) => {
    const path = String(url);
    if (/\/comments$/.test(path)) return json(comments, commentsStatus);
    if (/\/review-state$/.test(path)) {
      return json({ reviewState: 'draft', allowedTransitions: ['in-review'] });
    }
    if (/\/lock$/.test(path)) return json(ASSET);
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/tracks$/.test(path)) return json({ audioTracks: [], subtitleTracks: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(ASSET);
    return json({}, 200);
  });
}

async function settle(ticks = 30) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// A distinct asset id per mount test. The panel's unsent-draft cache is keyed by
// asset id and is deliberately module-scoped and long-lived — a draft survives
// the detail pane being rebuilt by an unrelated poll, and is dropped only when
// the comment is accepted. That is the behaviour under test in
// "keeps the draft in the field when the add fails", so tests that need a clean
// field ask about a different asset rather than reaching into the cache.
let nextAsset = 0;
function freshAssetId(): string {
  nextAsset += 1;
  return '01J9DDDDDDDDDDDDDDDDDDDD' + String(nextAsset).padStart(2, '0');
}

/** A minimal apiFetch stub with the same rejection shape as app.js's. */
function fakeApiFetch(
  handler: (path: string, options?: any) => any
): ReturnType<typeof vi.fn> {
  return vi.fn(async (path: string, options?: any) => handler(path, options));
}

function httpError(status: number, message = 'HTTP ' + status) {
  const err: any = new Error(message);
  err.status = status;
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('normaliseCommentList (the 200 is a bare array)', () => {
  it('accepts an array and preserves the server order exactly', () => {
    const r = normaliseCommentList(COMMENTS);
    expect(r.usable).toBe(true);
    // Oldest first, as listByAsset returns them (src/data/comment-repo.ts:50-58).
    expect(r.items.map((c: any) => c.id)).toEqual([COMMENTS[0].id, COMMENTS[1].id]);
  });

  it('treats an EMPTY array as a usable "no comments" answer, not a failure', () => {
    expect(normaliseCommentList([])).toEqual({ items: [], usable: true });
  });

  it('marks a non-array payload unusable rather than rendering it as empty', () => {
    // "we could not read" and "there are none" must not collapse into one state.
    for (const bad of [null, undefined, {}, 'nope', 7, { items: COMMENTS }]) {
      expect(normaliseCommentList(bad as any).usable).toBe(false);
    }
  });

  it('drops entries the schema could never produce, keeping the rest', () => {
    const r = normaliseCommentList([COMMENTS[0], null, 'x', 5, COMMENTS[1]]);
    expect(r.usable).toBe(true);
    expect(r.items.map((c: any) => c.id)).toEqual([COMMENTS[0].id, COMMENTS[1].id]);
  });

  it('keeps an entry missing a required field instead of hiding it', () => {
    const partial = { id: 'c-x', assetId: ULID };
    expect(normaliseCommentList([partial]).items).toEqual([partial]);
  });
});

describe('validateDraft (mirror of commentBodySchema)', () => {
  it('trims first, exactly as z.string().trim().min(1) does', () => {
    const s = validateDraft('   ');
    expect(s.empty).toBe(true);
    expect(s.valid).toBe(false);
    expect(validateDraft('  hello  ').value).toBe('hello');
  });

  it('rejects a non-string and a missing draft', () => {
    expect(validateDraft(undefined).valid).toBe(false);
    expect(validateDraft(null).valid).toBe(false);
    expect(validateDraft(42 as any).valid).toBe(false);
  });

  it('allows exactly the API ceiling and rejects one character more', () => {
    expect(COMMENT_MAX_LENGTH).toBe(4096);
    expect(validateDraft('a'.repeat(4096)).valid).toBe(true);
    const over = validateDraft('a'.repeat(4097));
    expect(over.tooLong).toBe(true);
    expect(over.valid).toBe(false);
    expect(over.remaining).toBe(-1);
  });

  it('measures AFTER the trim, so trailing space cannot push a legal draft over', () => {
    expect(validateDraft('a'.repeat(4096) + '   ').valid).toBe(true);
  });
});

describe('classifyCommentError', () => {
  it('names the undeclared-but-real 400 from the body schema', () => {
    expect(classifyCommentError(httpError(400)).kind).toBe('invalid');
    expect(classifyCommentError(httpError(422)).kind).toBe('invalid');
  });

  it('names the 403 the role matrix produces for a viewer', () => {
    expect(classifyCommentError(httpError(403)).kind).toBe('forbidden');
    expect(classifyCommentError(httpError(401)).kind).toBe('forbidden');
  });

  it('names the declared 404 for an unknown/foreign asset', () => {
    expect(classifyCommentError(httpError(404)).kind).toBe('not-found');
    expect(classifyCommentError(httpError(404)).message).toBe(COMMENTS_COPY.errNotFound);
  });

  it('falls back to "could not reach the API" for anything else', () => {
    expect(classifyCommentError(new Error('boom')).kind).toBe('other');
    expect(classifyCommentError(httpError(500)).kind).toBe('other');
    expect(classifyCommentError(undefined as any).kind).toBe('other');
  });
});

describe('commentTimeLabel', () => {
  it('formats a parseable ISO timestamp through the house formatter', () => {
    expect(commentTimeLabel('2026-09-21T08:00:00.000Z', () => '21/09/2026, 08:00')).toBe(
      '21/09/2026, 08:00'
    );
  });

  it('shows an unparseable value verbatim rather than inventing a date', () => {
    expect(commentTimeLabel('not-a-date')).toBe('not-a-date');
  });

  it('reports an absent timestamp honestly', () => {
    expect(commentTimeLabel(undefined)).toBe(COMMENTS_COPY.unknownTime);
    expect(commentTimeLabel('')).toBe(COMMENTS_COPY.unknownTime);
    expect(commentTimeLabel(null)).toBe(COMMENTS_COPY.unknownTime);
  });

  it('ignores a formatter that returns the house em-dash placeholder', () => {
    const out = commentTimeLabel('2026-09-21T08:00:00.000Z', () => '—');
    expect(out).not.toBe('—');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

describe('renderComment', () => {
  it('never routes a comment body through innerHTML', () => {
    // A comment is free text typed by a human: the most obviously
    // attacker-influenced value on this view.
    const item = renderComment({
      id: 'c-1',
      assetId: ULID,
      body: '<img src=x onerror="alert(1)"><script>bad()</script>',
      createdAt: '2026-09-21T08:00:00.000Z',
    });
    expect(item.querySelector('img')).toBeNull();
    expect(item.querySelector('script')).toBeNull();
    expect(item.querySelector('.comment-body')!.textContent).toContain('<img src=x');
  });

  it('keeps the operator line breaks (pre-wrap body, not collapsed)', () => {
    const item = renderComment({ body: 'line one\nline two', createdAt: '' });
    expect(item.querySelector('.comment-body')!.textContent).toBe('line one\nline two');
  });

  it('sets a machine-readable datetime only when the server value parses', () => {
    const ok = renderComment({ body: 'x', createdAt: '2026-09-21T08:00:00.000Z' });
    expect(ok.querySelector('time')!.getAttribute('datetime')).toBe('2026-09-21T08:00:00.000Z');
    const bad = renderComment({ body: 'x', createdAt: 'whenever' });
    expect(bad.querySelector('time')!.getAttribute('datetime')).toBeNull();
  });

  it('shows no author, because the API stores none', () => {
    // `Comment` has no author/createdBy (src/data/comment-repo.ts:17-22) and
    // there is no per-user identity (src/auth/principal.ts:11-16). A role name
    // printed here would read as a byline it is not.
    const item = renderComment({ ...COMMENTS[0], author: 'someone' } as any);
    expect(item.textContent).not.toContain('someone');
  });
});

describe('renderCommentsBlock', () => {
  it('distinguishes loading, unavailable and genuinely-empty', () => {
    const loading = renderCommentsBlock({ items: [], usable: false }, { loading: true });
    expect(loading.block.querySelector('[data-empty="comments-loading"]')).not.toBeNull();
    // In flight: claims nothing about how many comments exist.
    expect(loading.block.textContent).not.toContain(COMMENTS_COPY.empty);

    const failed = renderCommentsBlock({ items: [], usable: false });
    expect(failed.block.querySelector('[data-empty="comments-unavailable"]')).not.toBeNull();
    expect(failed.block.textContent).toContain(COMMENTS_COPY.unavailableDetail);
    // Crucially NOT the "no comments" copy — the asset may well have some.
    expect(failed.block.querySelector('[data-empty="comments"]')).toBeNull();

    const none = renderCommentsBlock({ items: [], usable: true });
    expect(none.block.querySelector('[data-empty="comments"]')).not.toBeNull();
    expect(none.block.textContent).toContain(COMMENTS_COPY.empty);
  });

  it('lists the comments in the order given and counts them in the heading', () => {
    const r = renderCommentsBlock({ items: COMMENTS, usable: true });
    const bodies = Array.from(r.block.querySelectorAll('.comment-body')).map(
      (n) => n.textContent || ''
    );
    expect(bodies).toEqual([COMMENTS[0].body, COMMENTS[1].body]);
    expect(r.block.querySelector('.section-title')!.textContent).toBe(
      COMMENTS_COPY.heading + ' (2)'
    );
    // An ordered list, because oldest-first is meaningful and AT should say so.
    expect(r.listEl!.tagName).toBe('OL');
    expect(r.listEl!.getAttribute('aria-label')).toContain('oldest first');
  });

  it('omits the count when the read failed, rather than publishing "(0)"', () => {
    const r = renderCommentsBlock({ items: [], usable: false });
    expect(r.block.querySelector('.section-title')!.textContent).toBe(COMMENTS_COPY.heading);
  });

  it('offers an accessible add control bound to the server ceiling', () => {
    const r = renderCommentsBlock({ items: COMMENTS, usable: true }, { canAdd: true });
    const ta = r.textarea as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    const label = r.block.querySelector('label')!;
    expect(label.getAttribute('for')).toBe(ta.id);
    expect(ta.getAttribute('maxlength')).toBe(String(COMMENT_MAX_LENGTH));
    expect(ta.getAttribute('aria-describedby')).toBe('comment-length-hint');
    expect(r.block.querySelector('#comment-length-hint')).not.toBeNull();
    // Errors are announced without moving focus.
    expect(r.msgHost.getAttribute('aria-live')).toBe('polite');
  });

  it('withholds the add control from a read-only role and explains why', () => {
    const r = renderCommentsBlock({ items: COMMENTS, usable: true }, { canAdd: false });
    expect(r.textarea).toBeNull();
    expect(r.submitBtn).toBeNull();
    expect(r.block.querySelector('#comments-role-note')!.textContent).toBe(COMMENTS_COPY.readOnly);
    // …but the list a viewer IS entitled to read stays fully visible.
    expect(r.block.querySelectorAll('.comment-item')).toHaveLength(2);
  });

  it('offers no edit and no delete affordance anywhere', () => {
    // There is no `…/comments/{commentId}` path at all, so such a control would
    // have nothing to call. This is a contract fact, not a scope preference.
    const r = renderCommentsBlock({ items: COMMENTS, usable: true }, { canAdd: true });
    const labels = Array.from(r.block.querySelectorAll('button')).map((b) =>
      (b.textContent || '').toLowerCase()
    );
    expect(labels).toEqual([COMMENTS_COPY.submit.toLowerCase()]);
    expect(r.block.textContent!.toLowerCase()).not.toContain('delete comment');
    expect(r.block.textContent!.toLowerCase()).not.toContain('edit comment');
  });

  it('restores a pending draft into the textarea', () => {
    const r = renderCommentsBlock({ items: [], usable: true }, { canAdd: true, draft: 'half typed' });
    expect((r.textarea as HTMLTextAreaElement).value).toBe('half typed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mount — the real request shapes
// ─────────────────────────────────────────────────────────────────────────────

describe('mountAssetComments', () => {
  let host: HTMLElement;
  let assetId: string;

  beforeEach(() => {
    assetId = freshAssetId();
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads the asset sub-resource path, with no query parameters', async () => {
    const apiFetch = fakeApiFetch(() => COMMENTS);
    await mountAssetComments({ assetId: assetId, host, apiFetch });

    // The GET declares exactly one path parameter and no query parameters.
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe('/assets/' + assetId + '/comments');
    expect(apiFetch.mock.calls[0][1]).toBeUndefined();
    expect(host.querySelectorAll('.comment-item')).toHaveLength(2);
  });

  it('renders the unavailable state (never an empty list) when the read fails', async () => {
    const apiFetch = fakeApiFetch(() => {
      throw httpError(500);
    });
    await mountAssetComments({ assetId: assetId, host, apiFetch });

    expect(host.querySelector('[data-empty="comments-unavailable"]')).not.toBeNull();
    expect(host.querySelector('[data-empty="comments"]')).toBeNull();
    expect(host.textContent).toContain(COMMENTS_COPY.errRead);
  });

  it('says the ASSET is gone when the read 404s', async () => {
    const apiFetch = fakeApiFetch(() => {
      throw httpError(404);
    });
    await mountAssetComments({ assetId: assetId, host, apiFetch });
    expect(host.textContent).toContain(COMMENTS_COPY.errReadNotFound);
  });

  it('posts exactly the one declared property, trimmed, then re-reads', async () => {
    let list = [COMMENTS[0]];
    const apiFetch = fakeApiFetch((path, options) => {
      if (options && options.method === 'POST') {
        const created = {
          id: COMMENTS[1].id,
          assetId: assetId,
          body: JSON.parse(options.body).body,
          createdAt: COMMENTS[1].createdAt,
        };
        list = [...list, created];
        return created;
      }
      return list;
    });

    const panel = await mountAssetComments({ assetId: assetId, host, apiFetch, canAdd: true });
    const ta = panel.block.querySelector('#comment-body-input') as HTMLTextAreaElement;
    ta.value = '  Looks good to me.  ';
    ta.dispatchEvent(new Event('input'));
    (panel.block.querySelector('#btn-add-comment') as HTMLButtonElement).click();
    await settle();

    const post = apiFetch.mock.calls.find((c: any[]) => c[1] && c[1].method === 'POST')!;
    expect(post[0]).toBe('/assets/' + assetId + '/comments');
    // additionalProperties: false — `body` and nothing else, trimmed as the
    // schema would have trimmed it.
    expect(JSON.parse(post[1].body)).toEqual({ body: 'Looks good to me.' });

    // Re-read, not an optimistic splice: `id`/`createdAt` are server-minted.
    const after = apiFetch.mock.calls.slice(apiFetch.mock.calls.indexOf(post) + 1);
    expect(after.some((c: any[]) => !c[1])).toBe(true);
    expect(host.querySelectorAll('.comment-item')).toHaveLength(2);
    expect((host.querySelector('#comment-body-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('issues nothing but GET and POST on the comments path, ever', async () => {
    const apiFetch = fakeApiFetch((_path, options) =>
      options && options.method === 'POST' ? { ...COMMENTS[0], body: 'x' } : COMMENTS
    );
    const panel = await mountAssetComments({ assetId: assetId, host, apiFetch, canAdd: true });
    const ta = panel.block.querySelector('#comment-body-input') as HTMLTextAreaElement;
    ta.value = 'x';
    ta.dispatchEvent(new Event('input'));
    (panel.block.querySelector('#btn-add-comment') as HTMLButtonElement).click();
    await settle();

    const methods = apiFetch.mock.calls.map((c: any[]) => (c[1] && c[1].method) || 'GET');
    expect(new Set(methods)).toEqual(new Set(['GET', 'POST']));
    // No `…/comments/{commentId}` path exists to address a single comment.
    expect(apiFetch.mock.calls.every((c: any[]) => /\/comments$/.test(String(c[0])))).toBe(true);
  });

  it('keeps the draft in the field when the add fails, and reports the reason', async () => {
    const apiFetch = fakeApiFetch((_path, options) => {
      if (options && options.method === 'POST') throw httpError(500);
      return COMMENTS;
    });
    const panel = await mountAssetComments({ assetId: assetId, host, apiFetch, canAdd: true });
    const ta = panel.block.querySelector('#comment-body-input') as HTMLTextAreaElement;
    ta.value = 'do not lose me';
    ta.dispatchEvent(new Event('input'));
    (panel.block.querySelector('#btn-add-comment') as HTMLButtonElement).click();
    await settle();

    expect((host.querySelector('#comment-body-input') as HTMLTextAreaElement).value).toBe(
      'do not lose me'
    );
    expect((host.querySelector('#comment-body-input') as HTMLTextAreaElement).disabled).toBe(false);
    expect(host.textContent).toContain(COMMENTS_COPY.errNetwork);
    // The list the server last gave is still on screen.
    expect(host.querySelectorAll('.comment-item')).toHaveLength(2);
  });

  it('withdraws the add control after a 403, because it is known to fail', async () => {
    const apiFetch = fakeApiFetch((_path, options) => {
      if (options && options.method === 'POST') throw httpError(403);
      return COMMENTS;
    });
    const panel = await mountAssetComments({ assetId: assetId, host, apiFetch, canAdd: true });
    const ta = panel.block.querySelector('#comment-body-input') as HTMLTextAreaElement;
    ta.value = 'nope';
    ta.dispatchEvent(new Event('input'));
    (panel.block.querySelector('#btn-add-comment') as HTMLButtonElement).click();
    await settle();

    expect(host.querySelector('#comment-form')).toBeNull();
    expect(host.textContent).toContain(COMMENTS_COPY.errForbidden);
    // Reading is a right the role still holds.
    expect(host.querySelectorAll('.comment-item')).toHaveLength(2);
  });

  it('disables the submit for the two drafts the server answers 400 to', async () => {
    const apiFetch = fakeApiFetch(() => COMMENTS);
    const panel = await mountAssetComments({ assetId: assetId, host, apiFetch, canAdd: true });
    const ta = panel.block.querySelector('#comment-body-input') as HTMLTextAreaElement;
    const btn = panel.block.querySelector('#btn-add-comment') as HTMLButtonElement;

    expect(btn.disabled).toBe(true); // empty on first paint
    ta.value = '    ';
    ta.dispatchEvent(new Event('input'));
    expect(btn.disabled).toBe(true); // whitespace-only: 400 server-side
    ta.value = 'a'.repeat(COMMENT_MAX_LENGTH + 1);
    ta.dispatchEvent(new Event('input'));
    expect(btn.disabled).toBe(true);
    expect(panel.block.querySelector('#comment-counter')!.className).toContain(
      'comments-counter--over'
    );
    ta.value = 'real text';
    ta.dispatchEvent(new Event('input'));
    expect(btn.disabled).toBe(false);
    // The server is still the authority: no POST was attempted meanwhile.
    expect(apiFetch.mock.calls.filter((c: any[]) => c[1] && c[1].method === 'POST')).toHaveLength(0);
  });

  it('reports honestly when the add succeeded but the re-read did not', async () => {
    let posted = false;
    const apiFetch = fakeApiFetch((_path, options) => {
      if (options && options.method === 'POST') {
        posted = true;
        return { ...COMMENTS[0], body: 'added' };
      }
      if (posted) throw httpError(500);
      return COMMENTS;
    });
    const panel = await mountAssetComments({ assetId: assetId, host, apiFetch, canAdd: true });
    const ta = panel.block.querySelector('#comment-body-input') as HTMLTextAreaElement;
    ta.value = 'added';
    ta.dispatchEvent(new Event('input'));
    (panel.block.querySelector('#btn-add-comment') as HTMLButtonElement).click();
    await settle();

    expect(host.textContent).toContain(COMMENTS_COPY.errRefreshAfterAdd);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail view integration
// ─────────────────────────────────────────────────────────────────────────────

describe('asset detail — comments panel (issue #900)', () => {
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

  it('reads /api/v1/assets/{id}/comments once and renders the list', async () => {
    const fetchSpy = routedFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const commentCalls = fetchSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => /\/comments$/.test(u));
    expect(commentCalls).toHaveLength(1);
    expect(commentCalls[0]).toContain('/api/v1/assets/' + ULID + '/comments');

    const block = container.querySelector('#asset-comments')!;
    expect(block).not.toBeNull();
    expect(block.querySelectorAll('.comment-item')).toHaveLength(2);
    expect(block.textContent).toContain(COMMENTS[0].body);
  });

  it('shows the explicit empty state for an asset with no comments', async () => {
    vi.stubGlobal('fetch', routedFetch([]));

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(container.querySelector('[data-empty="comments"]')!.textContent).toContain(
      COMMENTS_COPY.empty
    );
  });

  it('still shows the list to a viewer, but no add control', async () => {
    // MATRIX: viewer { read: true, write: false } (src/auth/authorize.ts:54-58).
    localStorage.setItem('ovc_role', 'viewer');
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    const block = container.querySelector('#asset-comments')!;
    expect(block.querySelectorAll('.comment-item')).toHaveLength(2);
    expect(block.querySelector('#comment-body-input')).toBeNull();
    expect(block.querySelector('#comments-role-note')).not.toBeNull();
  });

  it('gives an editor the add control', async () => {
    localStorage.setItem('ovc_role', 'editor');
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(container.querySelector('#asset-comments #comment-body-input')).not.toBeNull();
  });

  it('sits below the editorial review block and above the asset action row', async () => {
    // Editorial commentary belongs with the other editorial blocks, not among
    // the lifecycle operations (Extract Metadata / Thumbnails), which live in
    // the action row the panel anchors itself before (public/app.js:2930-2940).
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    const comments = container.querySelector('#asset-comments')!;

    const review = container.querySelector('#review-state')!;
    expect(review).not.toBeNull();
    expect(
      review.compareDocumentPosition(comments) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    const actionRow = container.querySelector('#btn-extract-meta')!.parentElement!;
    expect(
      comments.compareDocumentPosition(actionRow) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
