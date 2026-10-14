// @vitest-environment happy-dom
//
// The unified Editorial panel on asset detail (issue #937, broken out of #792):
// tags, comments and review state read as ONE named surface rather than three
// unrelated widgets, review state stays visually distinct from the lifecycle
// `status`, and the three underlying sub-panels keep shipping independently.
//
// The layout under test was DEFINED in #898 / PR #1035 and lives in
// docs/design/editorial-panel-layout.md — §1 (panel shape and ids), §2 (fixed
// Review → Tags → Comments order and the panel's position before the action
// row), §3 (the panel never collapses), §4 (the seven separations from the
// lifecycle axis) and §6.1-§6.2 (composition with renderAssetDetailBody).
// These tests drive the REAL renderer (renderAssetDetailBody — the same path
// the asset side panel and the detached detail window use) against a stubbed
// fetch, so they assert the shipped composition and not a re-implementation.
//
// CONTRACT GROUNDING — every path, field and status in the fixtures below was
// read from this repo's generated spec and route source before the tests were
// written (CLAUDE.md rule 7), never from the issue text:
//
//   openapi.json .paths["/api/v1/assets/{id}"].get.responses["200"] — the asset
//     body. `required: ["id","name","status","statusHistory","createdAt",
//     "updatedAt"]`; `status` enum = uploading|processing|ready|failed|archived;
//     `tags` is `{"type":"array","items":{"type":"string"}}` and is NOT in
//     `required` (absent means "no tags"); `reviewState` enum =
//     draft|in-review|approved|rejected, also not required.
//     Source: `assetSchema`, src/routes/assets.ts.
//   openapi.json .paths["/api/v1/assets/{id}/review-state"] — exactly `get`
//     (200 { reviewState, allowedTransitions }, both required,
//     additionalProperties: false; 404) and `post` (200 = the FULL asset; 404;
//     422). Source: `reviewStateReadSchema`, src/routes/assets.ts.
//   openapi.json .paths["/api/v1/assets/{id}/comments"] — exactly `post`
//     (201 = the created comment; 404) and `get` (200 = a BARE ARRAY of
//     { id, assetId, body, createdAt }, all four required,
//     additionalProperties: false; 404). No query parameters, so the list is
//     unpaged. Source: `commentSchema` / `commentBodySchema`,
//     src/routes/assets.ts.
//   openapi.json .paths["/api/v1/assets/{id}/tags"] declares `post` only —
//     there is no GET, so the tag list comes from the asset body already read.
//
//   Two independent axes, which is the whole reason for separation #4:
//   `ASSET_STATUSES` and `ASSET_REVIEW_STATES` (both src/data/asset-repo.ts)
//   share no member, and the comment above them says the axes are INDEPENDENT —
//   "a `ready` asset can be `draft`, `in-review`, `approved`, or `rejected`,
//   and moving one never moves the other".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDITORIAL_COPY, renderAssetDetailBody } from '../public/app.js';
import { REVIEW_COPY } from '../public/review-state.js';
import { TAGS_COPY } from '../public/asset-tags.js';
import { COMMENTS_COPY } from '../public/comments-panel.js';

const ULID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';

const ASSET = {
  id: ULID,
  name: 'promo-cut.mov',
  slug: 'promo-cut',
  status: 'ready',
  reviewState: 'in-review',
  tags: ['news', 'sports'],
  statusHistory: [{ at: '2026-09-20T10:00:00.000Z', from: null, to: 'ready' }],
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
};

const COMMENTS = [
  {
    id: '01J9000000000000000000000A',
    assetId: ULID,
    body: 'Received from the field.',
    createdAt: '2026-09-28T16:15:00.000Z',
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Routes by path, most specific first, exactly as the real API is addressed. */
function routedFetch(asset: Record<string, unknown> = ASSET, comments = COMMENTS) {
  return vi.fn(async (url: string) => {
    const path = String(url);
    if (/\/review-state$/.test(path)) {
      return json({
        reviewState: asset.reviewState || 'draft',
        allowedTransitions: ['approved', 'rejected'],
      });
    }
    if (/\/comments$/.test(path)) return json(comments);
    if (/\/lock$/.test(path)) return json(asset);
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(asset);
    return json({}, 200);
  });
}

async function settle(ticks = 30) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** True when `a` precedes `b` in document order. */
function precedes(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('unified editorial panel on asset detail (issue #937)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.setItem('ovc_role', 'editor');
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders ONE named editorial panel holding all three sub-panels', async () => {
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    const panel = container.querySelector('#editorial-panel');
    expect(panel).not.toBeNull();
    expect(container.querySelectorAll('#editorial-panel')).toHaveLength(1);
    // The panel is named, and named "Editorial" — not "Metadata" (taken by the
    // free-form metadata block) and not "Workflow" (would read as the pipeline).
    expect(panel!.querySelector('.section-title')!.textContent).toBe(EDITORIAL_COPY.heading);

    // All three modules keep their own block ids, and all three are inside the
    // panel — one surface, not three unrelated widgets.
    for (const id of ['#review-state', '#asset-tags', '#asset-comments']) {
      const block = container.querySelector(id);
      expect(block, id).not.toBeNull();
      expect(panel!.contains(block!), id).toBe(true);
    }
  });

  it('heads every group with its copy-deck string, never repeating the panel name', async () => {
    // docs/design/editorial-panel-layout.md §9 copy deck, verbatim:
    //   | panel heading         | Editorial |
    //   | review group heading  | Review    |
    //   | tags group heading    | Tags      |
    // and §1's panel tree (`#editorial-review .editorial-group "Review"`).
    // Pinned as literals as well as by reference: asserting only
    // `toBe(REVIEW_COPY.heading)` passes for ANY value of the constant, which is
    // how "Editorial review" shipped green once already.
    expect(EDITORIAL_COPY.heading).toBe('Editorial');
    expect(REVIEW_COPY.heading).toBe('Review');
    expect(TAGS_COPY.heading).toBe('Tags');
    expect(COMMENTS_COPY.heading).toBe('Comments');
    // §5.1: "Editorial" is the panel heading, so no group may repeat it —
    // repeating it reads as a section of its own.
    for (const h of [REVIEW_COPY.heading, TAGS_COPY.heading, COMMENTS_COPY.heading]) {
      expect(h, h).not.toContain(EDITORIAL_COPY.heading);
    }

    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    // …and what actually renders in each group matches the deck. The comments
    // heading carries the thread count ("Comments (n)"), so it is matched by
    // prefix; the other two are exact.
    const headingOf = (groupId: string): string => {
      const group = container.querySelector(groupId);
      expect(group, groupId).not.toBeNull();
      const title = group!.querySelector('.section-title');
      expect(title, groupId).not.toBeNull();
      return title!.textContent ?? '';
    };
    expect(headingOf('#editorial-review')).toBe(REVIEW_COPY.heading);
    expect(headingOf('#editorial-tags')).toBe(TAGS_COPY.heading);
    expect(headingOf('#editorial-comments')).toMatch(
      new RegExp('^' + COMMENTS_COPY.heading + '\\b')
    );
  });

  it('groups each sub-panel under its own stable group id, one block per group', async () => {
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    // The GROUP carries the panel-level identity; the module inside it is
    // untouched. That is what keeps the three sub-panels independently
    // shippable: the panel supplies a host element and nothing else.
    const pairs: [string, string][] = [
      ['#editorial-review', '#review-state'],
      ['#editorial-tags', '#asset-tags'],
      ['#editorial-comments', '#asset-comments'],
    ];
    for (const [groupId, blockId] of pairs) {
      const group = container.querySelector(groupId);
      expect(group, groupId).not.toBeNull();
      expect(group!.classList.contains('editorial-group'), groupId).toBe(true);
      expect(group!.querySelectorAll(blockId), groupId).toHaveLength(1);
    }
  });

  it('orders the sub-panels Review -> Tags -> Comments, identically on every asset', async () => {
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    const review = container.querySelector('#review-state')!;
    const tags = container.querySelector('#asset-tags')!;
    const comments = container.querySelector('#asset-comments')!;

    // Review first: the only sub-panel with a state machine and the only one an
    // operator is blocked by. Comments last: the thread is unbounded and the
    // API offers no pagination, so nothing may sit below it.
    expect(precedes(review, tags)).toBe(true);
    expect(precedes(tags, comments)).toBe(true);
  });

  it('keeps the same order on an asset with no tags and no comments', async () => {
    // `tags` is absent (not `[]`) on an untagged asset, and the comment list is
    // a bare empty array. Empty sub-panels are SHOWN, not hidden, so the panel's
    // shape does not vary per asset and the features stay discoverable.
    const bare = { ...ASSET, tags: undefined, reviewState: 'draft' };
    vi.stubGlobal('fetch', routedFetch(bare, []));

    await renderAssetDetailBody(ULID, container);
    await settle();

    const panel = container.querySelector('#editorial-panel')!;
    expect(panel.querySelector('#review-state')).not.toBeNull();
    expect(panel.querySelector('#asset-tags')).not.toBeNull();
    expect(panel.querySelector('#asset-comments')).not.toBeNull();
    expect(
      precedes(panel.querySelector('#review-state')!, panel.querySelector('#asset-tags')!)
    ).toBe(true);
    expect(
      precedes(panel.querySelector('#asset-tags')!, panel.querySelector('#asset-comments')!)
    ).toBe(true);
  });

  it('carries the axis sentence once, on the panel, naming the lifecycle field', async () => {
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    const intro = container.querySelector('#editorial-panel .editorial-intro')!;
    expect(intro.textContent).toBe(EDITORIAL_COPY.intro);
    // Asserted against the copy deck's own claim rather than a literal: the two
    // axes are independent and the panel must say so in words, so the
    // distinction survives monochrome and screen-reader rendering.
    expect(EDITORIAL_COPY.intro).toContain('separate axis');
    expect(EDITORIAL_COPY.intro).toContain('summary grid');
    // No positional claim anywhere on the editorial axis copy: "above" goes
    // stale the moment the panel is re-ordered or the pane is narrowed.
    expect(EDITORIAL_COPY.intro).not.toContain('above');
    expect(REVIEW_COPY.axisNote).not.toContain('above');
  });

  it('keeps review state visually distinct from the lifecycle status badge', async () => {
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    const panel = container.querySelector('#editorial-panel')!;
    const reviewBadge = container.querySelector('.review-badge')!;
    const lifecycleBadge = container.querySelector('.kv-grid .badge')!;

    // Separation 1 — region: the lifecycle badge lives in the summary grid,
    // outside the editorial boundary; the review badge lives inside it.
    expect(panel.contains(reviewBadge)).toBe(true);
    expect(panel.contains(lifecycleBadge)).toBe(false);

    // Separation 2 — shape: the review badge is NOT a member of the `.badge`
    // family (square corners vs a pill), so the two never share a class.
    expect(reviewBadge.classList.contains('badge')).toBe(false);
    expect(lifecycleBadge.classList.contains('review-badge')).toBe(false);

    // The hard rule: the two badges never appear in the same row, cell or grid.
    expect(reviewBadge.parentElement).not.toBe(lifecycleBadge.parentElement);
    expect(container.querySelectorAll('.kv-grid .review-badge')).toHaveLength(0);

    // Separation 4 — an always-present word label, never a bare badge.
    expect(
      (container.querySelector('#review-state')!.textContent || '').replace(/\s+/g, ' ')
    ).toContain(REVIEW_COPY.stateKey);
  });

  it('places the panel before the action row and leaves every other block where it was', async () => {
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    const panel = container.querySelector('#editorial-panel')!;
    const grid = container.querySelector('.kv-grid')!;
    const history = container.querySelector('#status-history')!;
    const actionRow = container.querySelector('#btn-extract-meta')!.parentElement!;

    // What the asset IS -> what HAPPENED to it -> what humans DECIDE about it
    // -> what you can DO to it.
    expect(precedes(grid, panel)).toBe(true);
    expect(precedes(history, panel)).toBe(true);
    expect(precedes(panel, actionRow)).toBe(true);
  });

  it('never hides the panel or the review axis behind a disclosure', async () => {
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    const panel = container.querySelector('#editorial-panel')!;
    expect(panel.closest('details')).toBeNull();
    expect(container.querySelector('#review-state')!.closest('details')).toBeNull();
  });

  it('renders the tag list exactly once on the pane', async () => {
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    // Tags left the summary grid when they became editable; two renderings of
    // one list is how a stale UI happens, since the grid is built once per
    // detail read and the block re-renders from each mutation's response.
    const gridKeys = Array.from(container.querySelectorAll('.kv-grid .kv-key')).map((k) =>
      (k.textContent || '').trim()
    );
    expect(gridKeys).not.toContain('Tags');
    expect(gridKeys).toContain('Status');
    expect(container.querySelectorAll('#asset-tags-list')).toHaveLength(1);
  });

  it('gives every sub-panel its own live region, not the shared action message', async () => {
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    const panel = container.querySelector('#editorial-panel')!;
    // Each sub-panel announces its own outcome where the operator is looking.
    // The shared #action-msg belongs to the action row below and stays outside
    // the panel — another reason the three remain independently shippable.
    for (const id of ['#review-msg', '#comments-msg']) {
      const msgHost = panel.querySelector(id);
      expect(msgHost, id).not.toBeNull();
    }
    const actionMsg = container.querySelector('#action-msg');
    if (actionMsg) expect(panel.contains(actionMsg)).toBe(false);
  });
});
