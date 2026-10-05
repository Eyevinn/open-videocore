// @vitest-environment happy-dom
//
// Tags add/remove control on the asset detail view (issue #899, broken out of
// #792): an operator can add one or several tags and remove one, the two writes
// are the two the API actually exposes, and nothing the API cannot do is
// offered.
//
// The integration blocks drive the REAL detail renderer (renderAssetDetailBody —
// the same code path the asset side panel and the detached detail window use)
// against a stubbed fetch.
//
// CONTRACT GROUNDING — every path, field, method, cap and status below was read
// from this repo's generated spec and route/repository source before the tests
// were written (CLAUDE.md rule 7), never from the issue text:
//
//   The field — `openapi.json .paths["/api/v1/assets/{id}"].get
//     .responses["200"]…schema.properties.tags` = { type: array, items:
//     { type: string } }, and `tags` is NOT in that schema's `required`
//     (= ["id","name","status","statusHistory","createdAt","updatedAt"]).
//     Source: `assetSchema` → `tags: z.array(z.string()).optional()`,
//     src/routes/assets.ts:914 ("Absent until the first tag is set"); the field
//     is ABSENT rather than [] when empty,
//     src/data/asset-document.ts:692; persisted at
//     `descriptive.tags: z.array(z.string()).default([])`,
//     src/data/asset-document.ts:288.
//
//   Add — `openapi.json .paths["/api/v1/assets/{id}/tags"].post`
//     requestBody required, { tags: array<string(1..128)>, 1..128 items },
//     required ["tags"], additionalProperties: false. Responses: exactly 200
//     (the FULL asset) and 404.
//     Source: src/routes/assets.ts:5466-5487; body :5471; response :5472;
//     server-side merge + dedupe `normalizeTags([...(asset.tags ?? []),
//     ...request.body.tags])` :5480, dedupe being an exact-string Set in
//     first-seen order (src/data/asset-repo.ts:1297-1307).
//
//   Remove — `openapi.json .paths["/api/v1/assets/{id}/tags/{tag}"].delete`
//     params: path `id` (string) and path `tag` (string, minLength 1). No body.
//     Responses: exactly 200 (the FULL asset) and 404.
//     Source: src/routes/assets.ts:5493-5514; params :5497; response :5498;
//     filter :5506 (removing an absent tag is a 200 no-op).
//
//   Caps — `tagSchema = z.string().min(1).max(128)` src/routes/assets.ts:393,
//     `tagsSchema = z.array(tagSchema).max(128)` :394. No `.trim()`, no charset
//     restriction, no case folding. A breach is an UNDECLARED 400
//     (…tags.post.responses is exactly ["200","404"]), hence pre-submit checks.
//
//   Authorisation — `MATRIX` (src/auth/authorize.ts:54-58): viewer
//     { read: true, write: false, delete: false }, editor/admin all true;
//     `methodToAction` (:79-93) maps POST->write and DELETE->delete, applied by
//     `resourceAuthorizationPreHandler('asset')` (:126, registered
//     src/routes/assets.ts:1748). 403 code
//     `AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role'` (:99).
//
//   Sub-resources take the ULID: both tag handlers call
//     `repo.get(request.params.id)` directly (:5476, :5502); only `GET /:id`
//     resolves a slug (`resolveAsset`, :3371-3378, called at :3407).
//
//   Design spec — docs/design/editorial-panel-layout.md §5.2 / §9 (issue #898)
//     for ordering, disclosure past 12 pills, and the copy deck.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canAddAssetTags, canRemoveAssetTags, renderAssetDetailBody, setClientRole } from '../public/app.js';
import {
  TAGS_COPY,
  TAG_MAX_COUNT,
  TAG_MAX_LENGTH,
  TAG_OVERFLOW_LIMIT,
  classifyTagError,
  isTagRemovable,
  normaliseTagList,
  parseTagEntry,
  renderTagsGroup,
} from '../public/editorial-tags.js';

const ULID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';

const BASE_ASSET = {
  id: ULID,
  name: 'promo-cut.mov',
  slug: 'promo-cut',
  status: 'ready',
  statusHistory: [{ at: '2026-09-20T10:00:00.000Z', from: null, to: 'ready' }],
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Route by path. The asset read serves `asset()`; the tag writes behave like the
 * real handlers (merge + exact-string dedupe on POST, filter on DELETE) and
 * answer with the FULL asset, as the contract declares.
 */
function routedFetch(initialTags?: string[], fail?: { status: number; on: 'POST' | 'DELETE' }) {
  let tags = initialTags ? initialTags.slice() : undefined;
  const asset = () => ({ ...BASE_ASSET, ...(tags && tags.length > 0 ? { tags } : {}) });
  const spy = vi.fn(async (url: string, opts?: RequestInit) => {
    const path = String(url);
    const method = (opts && opts.method) || 'GET';
    if (/\/tags(\/|$)/.test(path)) {
      if (fail && fail.on === method) return json({ error: 'forbidden_insufficient_role' }, fail.status);
      if (method === 'POST') {
        const sent = JSON.parse(String(opts?.body || '{}')).tags as string[];
        const merged: string[] = [];
        [...(tags || []), ...sent].forEach((t) => {
          if (merged.indexOf(t) === -1) merged.push(t);
        });
        tags = merged;
        return json(asset());
      }
      if (method === 'DELETE') {
        const raw = decodeURIComponent(path.split('/tags/')[1] || '');
        tags = (tags || []).filter((t) => t !== raw);
        return json(asset());
      }
    }
    if (/\/review-state$/.test(path)) return json({ reviewState: 'draft', allowedTransitions: ['in-review'] });
    if (/\/lock$/.test(path)) return json(asset());
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(asset());
    return json({}, 200);
  });
  return { spy, served: () => tags };
}

async function settle(ticks = 30) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function pillTexts(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('#editorial-tag-list .tag-text')).map(
    (n) => n.textContent || ''
  );
}

function removeBtn(root: ParentNode, tag: string): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>('.tag-remove[data-tag="' + tag + '"]');
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('tag list normalisation (the field is absent, not [], when empty)', () => {
  it('collapses undefined and [] to the same empty list', () => {
    expect(normaliseTagList(undefined)).toEqual([]);
    expect(normaliseTagList([])).toEqual([]);
  });

  it('preserves the server order and never sorts', () => {
    expect(normaliseTagList(['sports', 'news', '2026-final'])).toEqual([
      'sports',
      'news',
      '2026-final',
    ]);
  });

  it('survives a malformed payload without inventing tags', () => {
    expect(normaliseTagList(['news', 7, null, '', 'sports'] as unknown[])).toEqual(['news', 'sports']);
    expect(normaliseTagList('news' as unknown)).toEqual([]);
  });
});

describe('entry parsing (what the POST body may contain)', () => {
  it('splits on commas and trims every token — the server does not trim', () => {
    // `tagSchema` has no .trim() (src/routes/assets.ts:393) and dedupe is
    // exact-string, so " news" would persist as a tag distinct from "news".
    const r = parseTagEntry(' news , sports ,  2026-final ', []);
    expect(r.error).toBeNull();
    expect(r.tags).toEqual(['news', 'sports', '2026-final']);
  });

  it('never lowercases, folds or rewrites the operator text', () => {
    const r = parseTagEntry('News, SPORTS', []);
    expect(r.tags).toEqual(['News', 'SPORTS']);
  });

  it('drops tokens already present verbatim — the server would dedupe them', () => {
    const r = parseTagEntry('news, sports', ['news']);
    expect(r.tags).toEqual(['sports']);
    expect(r.duplicates).toEqual(['news']);
  });

  it('reports a case-only collision instead of resolving it', () => {
    const r = parseTagEntry('news', ['News']);
    expect(r.error).toBeNull();
    expect(r.tags).toEqual(['news']);
    expect(r.clashes).toEqual([{ typed: 'news', existing: 'News' }]);
  });

  it('refuses an empty entry and one that is entirely already present', () => {
    expect(parseTagEntry('   ,  , ', []).error).toBe(TAGS_COPY.nothingToAdd);
    expect(parseTagEntry('', []).tags).toEqual([]);
    expect(parseTagEntry('news', ['news']).error).toBe(TAGS_COPY.allPresent);
  });

  it('enforces the 128-character per-tag cap pre-submit (the 400 is undeclared)', () => {
    const long = 'x'.repeat(TAG_MAX_LENGTH + 1);
    const r = parseTagEntry(long, []);
    expect(r.tags).toEqual([]);
    expect(r.error).toContain(String(TAG_MAX_LENGTH + 1));
    expect(parseTagEntry('x'.repeat(TAG_MAX_LENGTH), []).error).toBeNull();
  });

  it('enforces the 128-tag list cap pre-submit', () => {
    const full = Array.from({ length: TAG_MAX_COUNT }, (_, i) => 't' + i);
    expect(parseTagEntry('one-more', full).error).toBe(TAGS_COPY.capReached);
    const nearlyFull = full.slice(0, TAG_MAX_COUNT - 1);
    expect(parseTagEntry('a, b', nearlyFull).error).toBe(TAGS_COPY.capWouldExceed(1, 2));
    expect(parseTagEntry('a', nearlyFull).error).toBeNull();
  });

  it('refuses the four characters the remove URL cannot carry (gap T1)', () => {
    ['a/b', 'a?b', 'a#b', 'a%b'].forEach((t) => {
      expect(parseTagEntry(t, []).error).toBe(TAGS_COPY.badCharacter);
      expect(isTagRemovable(t)).toBe(false);
    });
    expect(isTagRemovable('2026-final_cut.v2')).toBe(true);
  });
});

describe('write failure classification', () => {
  it('names the right action on a 403 — add and remove are different actions', () => {
    // POST -> `write`, DELETE -> `delete` (src/auth/authorize.ts:79-93).
    expect(classifyTagError({ status: 403 }, 'add').message).toBe(TAGS_COPY.errForbiddenAdd);
    expect(classifyTagError({ status: 403 }, 'remove').message).toBe(TAGS_COPY.errForbiddenRemove);
    expect(classifyTagError({ status: 403 }, 'add').kind).toBe('forbidden');
  });

  it('maps the only other declared status, 404', () => {
    expect(classifyTagError({ status: 404 }, 'remove').kind).toBe('not-found');
  });

  it('says the list is unchanged on anything else', () => {
    expect(classifyTagError({}, 'add', { count: 2 }).message).toBe(TAGS_COPY.addFailed(2));
    expect(classifyTagError({}, 'remove', { tag: 'news' }).message).toBe(
      TAGS_COPY.removeFailed('news')
    );
  });
});

describe('group rendering (pure DOM)', () => {
  it('shows the empty state plus the input, for undefined and [] alike', () => {
    [undefined, []].forEach((tags) => {
      const { block } = renderTagsGroup(tags as string[] | undefined, {});
      expect(block.textContent).toContain(TAGS_COPY.empty);
      expect(block.querySelector('#tag-add-input')).not.toBeNull();
    });
  });

  it('names the tag in each remove button label — an × alone announces as "times"', () => {
    const { block } = renderTagsGroup(['news'], {});
    const btn = block.querySelector('.tag-remove')!;
    expect(btn.getAttribute('aria-label')).toBe('Remove tag news');
    expect(btn.tagName).toBe('BUTTON');
  });

  it('renders an un-removable tag but disables its button (gap T1)', () => {
    const { block } = renderTagsGroup(['a/b', 'news'], {});
    const bad = block.querySelector<HTMLButtonElement>('.tag-remove[data-unremovable]')!;
    expect(block.textContent).toContain('a/b');
    expect(bad.disabled).toBe(true);
    expect(bad.title).toBe(TAGS_COPY.unremovable);
    expect(block.querySelector<HTMLButtonElement>('.tag-remove[data-tag="news"]')!.disabled).toBe(
      false
    );
  });

  it('discloses past 12 pills with an aria-expanded toggle (design spec §3)', () => {
    const many = Array.from({ length: 37 }, (_, i) => 'tag-' + i);
    const collapsed = renderTagsGroup(many, {});
    expect(collapsed.block.querySelectorAll('.tag-text').length).toBe(TAG_OVERFLOW_LIMIT);
    const toggle = collapsed.block.querySelector('#btn-tags-overflow')!;
    expect(toggle.textContent).toBe(TAGS_COPY.overflowOpen(37));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('editorial-tag-list');

    const open = renderTagsGroup(many, { expanded: true });
    expect(open.block.querySelectorAll('.tag-text').length).toBe(37);
    expect(open.block.querySelector('#btn-tags-overflow')!.textContent).toBe(
      TAGS_COPY.overflowClose
    );
  });

  it('labels the input visibly and wires aria-describedby to the helper text', () => {
    const { block } = renderTagsGroup([], {});
    const label = block.querySelector('label[for="tag-add-input"]')!;
    expect(label.textContent).toBe(TAGS_COPY.inputLabel);
    expect(block.querySelector('#editorial-tags-help')!.textContent).toBe(TAGS_COPY.helper);
    expect(block.querySelector('#tag-add-input')!.getAttribute('aria-describedby')).toContain(
      'editorial-tags-help'
    );
  });

  it('gives the group its own polite live regions and writes no server text as HTML', () => {
    const { block } = renderTagsGroup(['<img src=x onerror=alert(1)>'], {});
    expect(block.querySelector('#editorial-tags-msg')!.getAttribute('aria-live')).toBe('polite');
    expect(block.querySelector('#editorial-tags-note')!.getAttribute('aria-live')).toBe('polite');
    expect(block.querySelector('img')).toBeNull();
    expect(block.querySelector('.tag-text')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('shows the remaining budget only when it is nearly gone', () => {
    const at = (n: number) =>
      renderTagsGroup(
        Array.from({ length: n }, (_, i) => 't' + i),
        {}
      ).block.textContent || '';
    expect(at(50)).not.toContain('tag slots left');
    expect(at(TAG_MAX_COUNT - 16)).toContain(TAGS_COPY.nearCap(16));
    expect(at(TAG_MAX_COUNT)).toContain(TAGS_COPY.capReached);
  });

  it('offers neither control to a role that holds neither action', () => {
    const { block } = renderTagsGroup(['news'], { canAdd: false, canRemove: false });
    expect(block.querySelector('#tag-add-input')).toBeNull();
    expect(block.querySelector('.tag-remove')).toBeNull();
    expect(block.textContent).toContain('news');
    expect(block.textContent).toContain(TAGS_COPY.readOnly);
  });

  it('gates add and remove separately, as the matrix defines them', () => {
    const addOnly = renderTagsGroup(['news'], { canAdd: true, canRemove: false });
    expect(addOnly.block.querySelector('#tag-add-input')).not.toBeNull();
    expect(addOnly.block.querySelector('.tag-remove')).toBeNull();
    expect(addOnly.block.textContent).toContain(TAGS_COPY.readOnlyRemove);

    const removeOnly = renderTagsGroup(['news'], { canAdd: false, canRemove: true });
    expect(removeOnly.block.querySelector('#tag-add-input')).toBeNull();
    expect(removeOnly.block.querySelector('.tag-remove')).not.toBeNull();
  });
});

describe('role mirrors for the two tag writes', () => {
  afterEach(() => localStorage.clear());

  it('mirrors MATRIX for write (POST) and delete (DELETE) separately', () => {
    setClientRole('viewer');
    expect(canAddAssetTags()).toBe(false);
    expect(canRemoveAssetTags()).toBe(false);
    setClientRole('editor');
    expect(canAddAssetTags()).toBe(true);
    expect(canRemoveAssetTags()).toBe(true);
    setClientRole('admin');
    expect(canAddAssetTags()).toBe(true);
    expect(canRemoveAssetTags()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration — the real detail renderer
// ─────────────────────────────────────────────────────────────────────────────

describe('asset detail: tags add/remove', () => {
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

  it('renders the tags from the asset read, with no request of its own', async () => {
    const { spy } = routedFetch(['news', 'sports']);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(pillTexts(container)).toEqual(['news', 'sports']);
    // No GET of the tag sub-resource exists in the spec, and none is made.
    expect(spy.mock.calls.filter((c) => /\/tags/.test(String(c[0])))).toHaveLength(0);
  });

  it('keeps the editable group as the only rendering of tags on the pane', async () => {
    const { spy } = routedFetch(['news']);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    // The read-only summary-grid row is gone: a second copy would go stale on
    // the first write (design spec §6.1).
    const keys = Array.from(container.querySelectorAll('.kv-grid .kv-key')).map(
      (k) => k.textContent
    );
    expect(keys).not.toContain('Tags');
    expect(container.querySelectorAll('#editorial-tags').length).toBe(1);
    // Review -> Tags, and the group sits above the action row (design spec §2).
    const panel = container.querySelector('#editorial-tags')!;
    const review = container.querySelector('#review-state')!;
    expect(review.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const actions = container.querySelector('#action-msg') || container.querySelector('#btn-extract-meta');
    if (actions) {
      expect(panel.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('adds a comma-separated entry in ONE POST with the array body, on the ULID', async () => {
    const { spy } = routedFetch(['news']);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLInputElement>('#tag-add-input')!.value = ' sports , 2026-final ';
    container.querySelector<HTMLButtonElement>('#btn-add-tags')!.click();
    await settle();

    const posts = spy.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST' && /\/tags$/.test(String(c[0]))
    );
    expect(posts).toHaveLength(1);
    expect(String(posts[0][0])).toMatch(new RegExp('/assets/' + ULID + '/tags$'));
    // The one declared property, trimmed, in input order; already-present tags
    // are not re-sent.
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({
      tags: ['sports', '2026-final'],
    });

    // Redrawn from the 200 (the FULL asset), so the server's merge + order wins.
    expect(pillTexts(container)).toEqual(['news', 'sports', '2026-final']);
    expect(container.querySelector<HTMLInputElement>('#tag-add-input')!.value).toBe('');
    expect(document.activeElement?.id).toBe('tag-add-input');
    expect(container.querySelector('#editorial-tags-msg')!.textContent).toContain(
      TAGS_COPY.added(2)
    );
  });

  it('adds on Enter in the input as well as on the button', async () => {
    const { spy } = routedFetch([]);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const input = container.querySelector<HTMLInputElement>('#tag-add-input')!;
    input.value = 'news';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(pillTexts(container)).toEqual(['news']);
  });

  it('asks before creating a case-twin, then honours the operator either way', async () => {
    const { spy } = routedFetch(['News']);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLInputElement>('#tag-add-input')!.value = 'news';
    container.querySelector<HTMLButtonElement>('#btn-add-tags')!.click();
    await settle();

    // Nothing sent yet, the entry is intact, and the note explains why.
    expect(spy.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
    expect(container.querySelector('#editorial-tags-note')!.textContent).toBe(
      TAGS_COPY.caseClash('News', 'news')
    );
    expect(container.querySelector<HTMLInputElement>('#tag-add-input')!.value).toBe('news');

    // A second press sends it unchanged — the text is never folded for them.
    container.querySelector<HTMLButtonElement>('#btn-add-tags')!.click();
    await settle();
    expect(pillTexts(container)).toEqual(['News', 'news']);
  });

  it('removes a tag with DELETE on the encoded path, and redraws from the response', async () => {
    const { spy, served } = routedFetch(['news', 'sports']);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    removeBtn(container, 'news')!.click();
    await settle();

    const dels = spy.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE');
    expect(dels).toHaveLength(1);
    expect(String(dels[0][0])).toMatch(new RegExp('/assets/' + ULID + '/tags/news$'));
    expect((dels[0][1] as RequestInit).body).toBeUndefined();
    expect(served()).toEqual(['sports']);
    expect(pillTexts(container)).toEqual(['sports']);
    expect(container.querySelector('#editorial-tags-msg')!.textContent).toContain(
      TAGS_COPY.removed('news')
    );
  });

  it('percent-encodes a tag that needs it', async () => {
    const { spy } = routedFetch(['two words & more']);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    removeBtn(container, 'two words & more')!.click();
    await settle();

    const del = spy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')!;
    expect(String(del[0])).toMatch(/\/tags\/two%20words%20%26%20more$/);
    expect(pillTexts(container)).toEqual([]);
  });

  it('returns to the empty state when the last tag goes (the field becomes absent)', async () => {
    const { spy } = routedFetch(['news']);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    removeBtn(container, 'news')!.click();
    await settle();

    expect(container.querySelector('#editorial-tag-list')!.textContent).toContain(TAGS_COPY.empty);
  });

  it('keeps a rejected entry in the input and says the list is unchanged', async () => {
    const { spy } = routedFetch(['news'], { status: 500, on: 'POST' });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLInputElement>('#tag-add-input')!.value = 'sports';
    container.querySelector<HTMLButtonElement>('#btn-add-tags')!.click();
    await settle();

    expect(container.querySelector<HTMLInputElement>('#tag-add-input')!.value).toBe('sports');
    expect(pillTexts(container)).toEqual(['news']);
    expect(container.querySelector('#editorial-tags-msg')!.textContent).toContain(
      TAGS_COPY.addFailed(1)
    );
  });

  it('withdraws only the refused control on a 403, leaving the other action alone', async () => {
    const { spy } = routedFetch(['news'], { status: 403, on: 'POST' });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLInputElement>('#tag-add-input')!.value = 'sports';
    container.querySelector<HTMLButtonElement>('#btn-add-tags')!.click();
    await settle();

    expect(container.querySelector('#tag-add-input')).toBeNull();
    expect(container.querySelector('#editorial-tags-msg')!.textContent).toContain(
      TAGS_COPY.errForbiddenAdd
    );
    // Removal is the `delete` action, not `write`: it is still offered.
    expect(removeBtn(container, 'news')).not.toBeNull();
  });

  it('shows a viewer the tags with no write affordance at all', async () => {
    setClientRole('viewer');
    const { spy } = routedFetch(['news', 'sports']);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(pillTexts(container)).toEqual(['news', 'sports']);
    expect(container.querySelector('#tag-add-input')).toBeNull();
    expect(container.querySelector('.tag-remove')).toBeNull();
    expect(container.querySelector('#editorial-tags')!.textContent).toContain(TAGS_COPY.readOnly);
  });

  it('never re-renders the pane on a write (that would discard a typed entry)', async () => {
    const { spy } = routedFetch(['news']);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    const assetReads = spy.mock.calls.filter((c) => /\/assets\/[^/?]+(?:\?|$)/.test(String(c[0]))).length;

    removeBtn(container, 'news')!.click();
    await settle();

    const after = spy.mock.calls.filter((c) => /\/assets\/[^/?]+(?:\?|$)/.test(String(c[0]))).length;
    expect(after).toBe(assetReads);
  });
});
