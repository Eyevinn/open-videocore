// @vitest-environment happy-dom
//
// Version-chain navigation on the asset detail view (issue #907, broken out of
// #795): the chain is visible and navigable, the current version is
// identifiable, and an asset with no other versions says so.
//
// The integration block drives the REAL detail renderer (renderAssetDetailBody —
// the same code path used by the asset side panel and the detached detail
// window) against a stubbed fetch.
//
// CONTRACT GROUNDING — every path, field and status below was read from this
// repo's generated spec and route source before the tests were written
// (CLAUDE.md rule 7), never from the issue text. `openapi.json` declares no
// `operationId` anywhere, so the operation is named by path + method:
//
//   openapi.json .paths["/api/v1/assets/{id}/versions"] — the ONLY key on that
//   path is `get`. Handler src/routes/assets.ts:3446-3484.
//     .get.parameters — exactly one entry: `id`, in `path`, required, string
//       (`params: z.object({ id: z.string() })`, :3450). NO query parameters:
//       the chain is returned whole and is not paginated (ADR-024 D6).
//     .get.responses["200"] schema — properties `assetId`, `versionGroupId`,
//       `currentVersionId`, `versions`; required
//       ["assetId","currentVersionId","versions"] (:3452-3457). So
//       `versionGroupId` is the one optional member of the envelope, and its
//       ABSENCE is what marks a never-versioned asset.
//     .get.responses["200"]…versions.items — the full `assetSchema`,
//       required ["id","name","status","statusHistory","createdAt","updatedAt"],
//       with the optional lineage edges `versionOfAssetId` (:882) and
//       `versionGroupId` (:883). `status` enum =
//       uploading | processing | ready | failed | archived.
//     .get.responses["404"] — FLAT { error: string, message?: string },
//       required ["error"], additionalProperties: false (`errorSchema`, :529;
//       the handler sends { error: 'not_found' } at :3465).
//
//   ORDERING — oldest first: createdAt ascending, ties broken by id ascending
//     (`compareVersionOrder`, src/data/asset-repo.ts:1231-1233), applied by both
//     repositories (src/data/asset-repo.ts:1817, src/data/couch-asset-repo.ts:631).
//
//   CURRENT IS SERVER-COMPUTED and is NOT the last array element:
//     `currentVersionId(versions)` (src/routes/assets.ts:3476), defined
//     src/data/asset-repo.ts:1275-1294 as a preference ladder over `status` —
//     ready -> (uploading|processing) -> failed -> archived, newest-first within
//     the highest non-empty tier. :1239-1243 states outright that "last element"
//     is not the rule. The FIXTURES below are built so that re-deriving it would
//     give a different answer from the field, which is what makes the assertion
//     meaningful. It is also not a promise of playability (:1264-1269).
//
//   MEMBERSHIP — always includes the target, and INCLUDES archived members:
//     lineage history, not a live listing (`listVersions`,
//     src/data/asset-repo.ts:1805-1819; route comment :3440-3441).
//
//   NEVER-VERSIONED ASSET — a SINGLE-MEMBER chain with `versionGroupId` absent:
//     `if (!asset.versionGroupId) return [{ ...asset }]`
//     (src/data/asset-repo.ts:1811-1813, mirrored
//     src/data/couch-asset-repo.ts:620-622). There is no empty `versions` array
//     for an existing asset, so the empty state is length-1-and-no-group.
//
//   CHAINS BRANCH — `resolveVersionLinkage` reuses the source's group and names
//     the immediate source (src/data/asset-repo.ts:1210-1221); nothing rejects a
//     second `asVersion` operation against one source, and
//     src/routes/assets.versions.test.ts asserts exactly that shape (ADR-024 D4).
//
//   TRUNCATION — MAX_LIMIT = 200 (src/data/asset-repo.ts:853) bounds the page,
//     and the route itself warns the target can fall outside it
//     (src/routes/assets.ts:3467-3471).
//
//   NOT EXPOSED, so not built: there is no promote / set-current / reorder
//     operation on any path, and no stored "current" marker — the only way a
//     version is created at all is `asVersion: true` on POST /assets/{id}/export
//     or POST /assets/{id}/clip (src/routes/assets.ts:720, :733).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetDetailBody } from '../public/app.js';
import {
  DEPTH_CAP,
  MAX_CHAIN_PAGE,
  VERSION_CHAIN_COPY,
  buildVersionTree,
  focusYouAreHereRow,
  isSingleMemberChain,
  isTruncatedChain,
  isoUtc,
  normaliseVersionChain,
  renderVersionChainBlock,
  versionChainErrorText,
  versionStatusBadgeClass,
  versionStepTargets,
} from '../public/version-chain.js';

// ULIDs: 26 chars, Crockford base32. Lexical order == creation order, which is
// what makes the server's `id` tiebreak total (src/data/asset-repo.ts:1228-1230).
const MASTER = '01J9AAAAAAAAAAAAAAAAAAAAAA';
const ROUGH = '01J9BBBBBBBBBBBBBBBBBBBBBB';
const ROUGH2 = '01J9CCCCCCCCCCCCCCCCCCCCCC';
const TRAILER = '01J9DDDDDDDDDDDDDDDDDDDDDD';
const GROUP = MASTER; // seeded to the root asset's own id (resolveVersionLinkage)

type Member = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  versionOfAssetId?: string;
  versionGroupId?: string;
};

const member = (
  id: string,
  name: string,
  status: string,
  createdAt: string,
  versionOfAssetId?: string
): Member => ({
  id,
  name,
  status,
  createdAt,
  updatedAt: createdAt,
  statusHistory: [{ at: createdAt, from: null, to: status }],
  versionGroupId: GROUP,
  ...(versionOfAssetId ? { versionOfAssetId } : {}),
}) as Member;

// The branching fixture from the design spec, in the server's oldest-first
// array order:
//
//   master                   ready       2026-03-01
//   ├─ rough-cut             archived    2026-03-02
//   │  └─ rough-cut-v2       ready       2026-03-04   <- currentVersionId
//   └─ trailer-cut           processing  2026-03-05   <- NEWEST + last element
//
// This shape is chosen so the assertions can discriminate. `currentVersionId` is
// rough-cut-v2, which is NEITHER the last array element NOR the newest member:
// the ladder skipped the in-flight trailer-cut (tier 2) because a `ready` member
// exists (tier 1), exactly as src/data/asset-repo.ts:1275-1294 computes it. A
// view that re-derived current from "last element" or "newest createdAt" would
// badge trailer-cut and fail these tests. `rough-cut` and `trailer-cut` are the
// branch: both name `master` as their source.
const CHAIN_VERSIONS: Member[] = [
  member(MASTER, 'master', 'ready', '2026-03-01T00:00:00.000Z'),
  member(ROUGH, 'rough-cut', 'archived', '2026-03-02T09:14:00.000Z', MASTER),
  member(ROUGH2, 'rough-cut-v2', 'ready', '2026-03-04T11:02:00.000Z', ROUGH),
  member(TRAILER, 'trailer-cut', 'processing', '2026-03-05T16:40:00.000Z', MASTER),
];

const chainFor = (assetId: string) => ({
  assetId,
  versionGroupId: GROUP,
  currentVersionId: ROUGH2,
  versions: CHAIN_VERSIONS,
});

/** The never-versioned shape: itself only, and NO versionGroupId. */
const soloChain = (assetId: string) => ({
  assetId,
  currentVersionId: assetId,
  versions: [member(assetId, 'lonely.mov', 'ready', '2026-03-01T00:00:00.000Z')].map((v) => {
    const { versionGroupId: _drop, ...rest } = v as Member;
    return rest;
  }),
});

const ASSET = {
  id: MASTER,
  name: 'master',
  slug: 'master',
  status: 'ready',
  reviewState: 'draft',
  statusHistory: [{ at: '2026-03-01T00:00:00.000Z', from: null, to: 'ready' }],
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * A fetch stub for the whole detail render. `versions` is routed FIRST so the
 * generic asset route cannot swallow it, and the handler is given the id from
 * the path so navigation can be observed changing it.
 */
function routedFetch(versionsFor: (id: string) => { status: number; body: unknown }) {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const path = String(url);
    const m = /\/assets\/([^/?]+)\/versions$/.exec(path);
    if (m) {
      const out = versionsFor(decodeURIComponent(m[1]));
      return json(out.body, out.status);
    }
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/review-state$/.test(path)) {
      return json({ reviewState: 'draft', allowedTransitions: ['in-review'] });
    }
    const a = /\/assets\/([^/?]+)(?:\?|$)/.exec(path);
    if (a) return json({ ...ASSET, id: decodeURIComponent(a[1]), name: 'asset-' + a[1] });
    return json({}, 200);
  });
}

async function settle(ticks = 30) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Every version id the rendered chain lists, in render (tree) order. */
function renderedIds(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('.version-row')).map(
    (r) => r.getAttribute('data-version-id') || ''
  );
}

function currentRowId(root: ParentNode): string | null {
  const row = root.querySelector('.version-row[data-version-current="true"]');
  return row ? row.getAttribute('data-version-id') : null;
}

function hereRowId(root: ParentNode): string | null {
  const row = root.querySelector('.version-row[data-version-here="true"]');
  return row ? row.getAttribute('data-version-id') : null;
}

function depthOf(root: ParentNode, id: string): number {
  const row = root.querySelector('.version-row[data-version-id="' + id + '"]');
  return row ? Number(row.getAttribute('data-depth')) : NaN;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('version chain — reading the envelope (issue #907)', () => {
  it('keeps an absent versionGroupId absent rather than inventing one', () => {
    const c = normaliseVersionChain(soloChain(MASTER));
    expect(c.versionGroupId).toBeUndefined();
    expect(c.assetId).toBe(MASTER);
    expect(c.currentVersionId).toBe(MASTER);
  });

  it('detects "no other versions" as a single-member chain, not an empty array', () => {
    expect(isSingleMemberChain(normaliseVersionChain(soloChain(MASTER)))).toBe(true);
    // A member that DOES carry a group is a real chain of one read, not the
    // never-versioned state.
    expect(
      isSingleMemberChain({ versions: [CHAIN_VERSIONS[0]], versionGroupId: GROUP })
    ).toBe(false);
    // length 0 is a shape listVersions never produces for an existing asset; it
    // must not be mistaken for the empty state either.
    expect(isSingleMemberChain({ versions: [], versionGroupId: undefined })).toBe(false);
  });

  it('flags a page that is exactly the server cap as possibly truncated', () => {
    expect(MAX_CHAIN_PAGE).toBe(200);
    expect(isTruncatedChain({ versions: CHAIN_VERSIONS })).toBe(false);
    const full = Array.from({ length: MAX_CHAIN_PAGE }, (_, i) =>
      member('01J9' + String(i).padStart(22, '0'), 'v' + i, 'ready', '2026-03-01T00:00:00.000Z')
    );
    expect(isTruncatedChain({ versions: full })).toBe(true);
  });

  it('reads a failed request as the route’s FLAT { error, message? } body', () => {
    expect(versionChainErrorText({ message: 'asset not found' })).toContain('asset not found');
    expect(versionChainErrorText({ body: { error: 'not_found' } })).toContain('not_found');
    // Never degrades into a claim about the asset.
    expect(versionChainErrorText({})).not.toContain(VERSION_CHAIN_COPY.emptyHeadline);
  });

  it('renders createdAt as ISO 8601 UTC and leaves an unparseable value verbatim', () => {
    expect(isoUtc('2026-03-04T11:02:00.000Z')).toBe('2026-03-04T11:02:00.000Z');
    expect(isoUtc('not-a-date')).toBe('not-a-date');
    expect(isoUtc(undefined)).toBe(VERSION_CHAIN_COPY.absent);
  });

  it('maps every status in the documented enum, and nothing else', () => {
    expect(versionStatusBadgeClass('ready')).toBe('badge-ready');
    expect(versionStatusBadgeClass('uploading')).toBe('badge-pending');
    expect(versionStatusBadgeClass('processing')).toBe('badge-pending');
    expect(versionStatusBadgeClass('failed')).toBe('badge-failed');
    expect(versionStatusBadgeClass('archived')).toBe('badge-failed');
    expect(versionStatusBadgeClass('embargoed')).toBe('badge-unknown');
  });
});

describe('version chain — tree reconstruction (ADR-024 D4)', () => {
  it('places each member under the source its versionOfAssetId names', () => {
    const { rows, orphans } = buildVersionTree(CHAIN_VERSIONS);
    expect(orphans).toHaveLength(0);
    const depth = Object.fromEntries(rows.map((r) => [r.version.id, r.depth]));
    expect(depth[MASTER]).toBe(0);
    expect(depth[ROUGH]).toBe(1);
    expect(depth[TRAILER]).toBe(1); // sibling of rough-cut: both name master
    expect(depth[ROUGH2]).toBe(2);
  });

  it('keeps siblings in the server’s array order', () => {
    const { rows } = buildVersionTree(CHAIN_VERSIONS);
    // rough-cut (2026-03-02) precedes trailer-cut (2026-03-03) in `versions`, so
    // it precedes it among master's children.
    const ids = rows.map((r) => r.version.id);
    expect(ids.indexOf(ROUGH)).toBeLessThan(ids.indexOf(TRAILER));
    // Every member is emitted exactly once.
    expect(ids.sort()).toEqual([MASTER, ROUGH, ROUGH2, TRAILER].sort());
  });

  it('groups a member whose source is outside the page instead of reparenting it', () => {
    const outside = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
    const page = [
      CHAIN_VERSIONS[0],
      member(ROUGH, 'rough-cut', 'ready', '2026-03-02T09:14:00.000Z', outside),
    ];
    const { rows, orphans } = buildVersionTree(page);
    expect(rows.map((r) => r.version.id)).toEqual([MASTER]);
    expect(orphans.map((r) => r.version.id)).toEqual([ROUGH]);
    // Specifically NOT attached to the root — that would assert an edge the API
    // did not report.
    expect(rows.some((r) => r.version.id === ROUGH)).toBe(false);
  });

  it('never drops a member caught in a cycle the server should not emit', () => {
    const a = member(ROUGH, 'a', 'ready', '2026-03-02T00:00:00.000Z', ROUGH2);
    const b = member(ROUGH2, 'b', 'ready', '2026-03-03T00:00:00.000Z', ROUGH);
    const { rows, orphans } = buildVersionTree([a, b]);
    const all = rows.concat(orphans).map((r) => r.version.id).sort();
    expect(all).toEqual([ROUGH, ROUGH2].sort());
  });

  it('clamps the drawn indent without losing the real depth', () => {
    const ids = Array.from({ length: 8 }, (_, i) => '01J9' + String(i).padStart(22, '0'));
    const deep = ids.map((id, i) =>
      member(id, 'v' + i, 'ready', '2026-03-0' + (i + 1) + 'T00:00:00.000Z', i === 0 ? undefined : ids[i - 1])
    );
    const { rows } = buildVersionTree(deep);
    expect(rows[7].depth).toBe(7);
    expect(rows[7].indent).toBe(DEPTH_CAP);
  });
});

describe('version chain — stepping in the server’s array order', () => {
  it('steps oldest -> newest and stops at each end', () => {
    const first = versionStepTargets(chainFor(MASTER));
    expect(first.index).toBe(0);
    expect(first.total).toBe(4);
    expect(first.previousId).toBeNull();
    expect(first.nextId).toBe(ROUGH);

    const last = versionStepTargets(chainFor(TRAILER));
    expect(last.index).toBe(3);
    expect(last.previousId).toBe(ROUGH2);
    expect(last.nextId).toBeNull();
  });

  it('steps in ARRAY order, not tree order, across a branch', () => {
    // rough-cut-v2 is a LEAF at depth 2: tree order has nothing after it. The
    // array does — trailer-cut, which sits on the other branch at depth 1.
    // Array order wins, because it is the server's declared total order and the
    // one "next" that is defined on a branching chain.
    expect(versionStepTargets(chainFor(ROUGH2)).nextId).toBe(TRAILER);
    expect(versionStepTargets(chainFor(ROUGH2)).previousId).toBe(ROUGH);
  });

  it('offers no step at all when the viewed asset is outside the page', () => {
    const step = versionStepTargets({ assetId: '01J9QQQQQQQQQQQQQQQQQQQQQQ', versions: CHAIN_VERSIONS });
    expect(step.index).toBe(-1);
    expect(step.previousId).toBeNull();
    expect(step.nextId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

describe('version chain — rendered block (issue #907)', () => {
  it('lists the whole chain, including archived members', () => {
    const { block } = renderVersionChainBlock(chainFor(MASTER));
    expect(renderedIds(block).sort()).toEqual([MASTER, ROUGH, ROUGH2, TRAILER].sort());
    // The archived member is present AND navigable: lineage history, not a live
    // listing.
    const archived = block.querySelector('.version-row[data-version-id="' + ROUGH + '"]')!;
    expect(archived.querySelector('.version-link')).not.toBeNull();
    expect(archived.textContent).toContain('archived');
  });

  it('badges exactly the currentVersionId member — not the last element', () => {
    const { block } = renderVersionChainBlock(chainFor(MASTER));
    expect(currentRowId(block)).toBe(ROUGH2);

    // Both re-derivations the contract warns against would give trailer-cut.
    // The fixture is built so they disagree with the field; the view follows
    // the field (src/data/asset-repo.ts:1239-1243).
    expect(CHAIN_VERSIONS[CHAIN_VERSIONS.length - 1].id).toBe(TRAILER);
    const byCreatedAt = [...CHAIN_VERSIONS].sort((x, y) =>
      x.createdAt.localeCompare(y.createdAt)
    );
    expect(byCreatedAt[byCreatedAt.length - 1].id).toBe(TRAILER);

    // Exactly one row is badged, and it is not either of those.
    expect(block.querySelectorAll('.version-row[data-version-current="true"]')).toHaveLength(1);
    expect(block.querySelectorAll('.badge-current')).toHaveLength(1);
  });

  it('follows the field even when the newest member is a different one', () => {
    // Same members, but the server names the in-flight trailer-cut as current.
    // The view must agree with the API, not with any local heuristic.
    const { block } = renderVersionChainBlock({ ...chainFor(MASTER), currentVersionId: TRAILER });
    expect(currentRowId(block)).toBe(TRAILER);
  });

  it('says Current, never Latest, and carries the consequence for a screen reader', () => {
    const { block } = renderVersionChainBlock(chainFor(MASTER));
    const badge = block.querySelector('.badge-current')!;
    expect(badge.textContent).toContain(VERSION_CHAIN_COPY.current);
    expect(block.textContent).not.toMatch(/\bLatest\b/);
    expect(badge.querySelector('.visually-hidden')?.textContent).toContain(
      VERSION_CHAIN_COPY.currentConsequence
    );
  });

  it('marks the asset being viewed separately from Current, and they coexist', () => {
    // Viewing the current member: both facts land on one row and both render.
    const { block } = renderVersionChainBlock(chainFor(ROUGH2));
    expect(hereRowId(block)).toBe(ROUGH2);
    expect(currentRowId(block)).toBe(ROUGH2);
    const row = block.querySelector('.version-row[data-version-here="true"]')!;
    expect(row.querySelector('.badge-current')).not.toBeNull();
    expect(row.querySelector('.version-here')).not.toBeNull();
    // The row you are on is not a link to itself.
    expect(row.querySelector('.version-link')).toBeNull();
  });

  it('marks you-are-here and Current on DIFFERENT rows when they differ', () => {
    const { block } = renderVersionChainBlock(chainFor(MASTER));
    expect(hereRowId(block)).toBe(MASTER);
    expect(currentRowId(block)).toBe(ROUGH2);
  });

  it('links every member except the one being viewed', () => {
    const { block, links } = renderVersionChainBlock(chainFor(MASTER));
    expect(links.map((l) => l.getAttribute('data-asset-id')).sort()).toEqual(
      [ROUGH, ROUGH2, TRAILER].sort()
    );
    expect(block.querySelectorAll('.version-link')).toHaveLength(3);
  });

  it('states the lineage edge in text, so depth is not indent-only (WCAG 1.3.1)', () => {
    const { block } = renderVersionChainBlock(chainFor(MASTER));
    const child = block.querySelector('.version-row[data-version-id="' + ROUGH2 + '"]')!;
    expect(child.querySelector('.visually-hidden')?.textContent).toContain(
      VERSION_CHAIN_COPY.sourceVersionPrefix + 'rough-cut'
    );
    expect(depthOf(block, ROUGH2)).toBe(2);
    // The connector glyph is decoration only.
    expect(child.querySelector('.version-indent')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('warns that Current is not playable when the named member is not ready', () => {
    const inFlight = {
      assetId: MASTER,
      versionGroupId: GROUP,
      currentVersionId: TRAILER, // status: processing
      versions: CHAIN_VERSIONS,
    };
    const { block } = renderVersionChainBlock(inFlight);
    expect(block.querySelector('[data-version-no-ready="true"]')?.textContent).toBe(
      VERSION_CHAIN_COPY.noReadyVersion
    );
    // The badge is NOT suppressed: the field still names the head of the chain.
    expect(currentRowId(block)).toBe(TRAILER);
  });

  it('offers no promote / set-current / create control — the API has none', () => {
    const { block } = renderVersionChainBlock(chainFor(MASTER));
    const labels = Array.from(block.querySelectorAll('button')).map((b) => b.textContent || '');
    // The only buttons in the block are the two step controls.
    expect(labels).toEqual([VERSION_CHAIN_COPY.stepPrevious, VERSION_CHAIN_COPY.stepNext]);
    expect(block.querySelector('input')).toBeNull();
    expect(block.querySelector('select')).toBeNull();
    expect(block.textContent).not.toMatch(/promote|make current|set current/i);
  });

  it('disables the step that would run off the end of the array', () => {
    const atStart = renderVersionChainBlock(chainFor(MASTER)).block;
    expect(
      (atStart.querySelector('.version-step[data-step="previous"]') as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (atStart.querySelector('.version-step[data-step="next"]') as HTMLButtonElement).disabled
    ).toBe(false);

    const atEnd = renderVersionChainBlock(chainFor(TRAILER)).block;
    expect(
      (atEnd.querySelector('.version-step[data-step="next"]') as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('groups orphans under their own heading rather than hiding or reparenting them', () => {
    const outside = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
    const { block } = renderVersionChainBlock({
      assetId: MASTER,
      versionGroupId: GROUP,
      currentVersionId: MASTER,
      versions: [
        CHAIN_VERSIONS[0],
        member(ROUGH, 'rough-cut', 'ready', '2026-03-02T09:14:00.000Z', outside),
      ],
    });
    const orphans = block.querySelector('[data-version-orphans="true"]')!;
    expect(orphans).not.toBeNull();
    expect(orphans.textContent).toContain(VERSION_CHAIN_COPY.orphanHeading);
    expect(renderedIds(orphans)).toEqual([ROUGH]);
  });

  it('notices a page that may be truncated at the server cap', () => {
    const full = Array.from({ length: MAX_CHAIN_PAGE }, (_, i) =>
      member('01J9' + String(i).padStart(22, '0'), 'v' + i, 'ready', '2026-03-01T00:00:00.000Z')
    );
    const { block } = renderVersionChainBlock({
      assetId: full[0].id,
      versionGroupId: GROUP,
      currentVersionId: full[0].id,
      versions: full,
    });
    expect(block.querySelector('[data-version-truncated="true"]')?.textContent).toBe(
      VERSION_CHAIN_COPY.truncated
    );
  });

  it('renders the "no other versions" state for a single-member chain', () => {
    const { block } = renderVersionChainBlock(soloChain(MASTER));
    // The SECTION is rendered — "no other versions" is an answer, and an absent
    // section is not.
    expect(block.textContent).toContain(VERSION_CHAIN_COPY.heading);
    expect(block.querySelector('[data-empty="version-chain"]')?.textContent).toContain(
      VERSION_CHAIN_COPY.emptyHeadline
    );
    expect(block.textContent).toContain(VERSION_CHAIN_COPY.emptyDetail);
    // No one-row tree, no Current badge on a chain of one, no step controls, and
    // no "none" placeholder in the group slot.
    expect(renderedIds(block)).toEqual([]);
    expect(block.querySelector('.badge-current')).toBeNull();
    expect(block.querySelector('.version-steps')).toBeNull();
    expect(block.querySelector('.version-group-id')).toBeNull();
  });

  it('renders a member name as text, never as markup', () => {
    const nasty = '<img src=x onerror="alert(1)">';
    const { block } = renderVersionChainBlock({
      assetId: MASTER,
      versionGroupId: GROUP,
      currentVersionId: MASTER,
      versions: [member(MASTER, nasty, 'ready', '2026-03-01T00:00:00.000Z'), CHAIN_VERSIONS[1]],
    });
    document.body.appendChild(block);
    try {
      expect(block.querySelector('img')).toBeNull();
      expect(block.textContent).toContain(nasty);
    } finally {
      block.remove();
    }
  });

  it('never uses the rendition vocabulary for a version’s source', () => {
    // `?parentId=` is a DIFFERENT relationship (src/routes/assets.ts:3422-3423).
    const { block } = renderVersionChainBlock(chainFor(MASTER));
    expect(block.textContent).not.toMatch(/\bparent\b/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail view integration
// ─────────────────────────────────────────────────────────────────────────────

describe('asset detail — version chain (issue #907)', () => {
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

  it('reads GET /assets/{id}/versions and renders the chain', async () => {
    const fetchSpy = routedFetch((id) => ({ status: 200, body: chainFor(id) }));
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(MASTER, container);
    await settle();

    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.endsWith('/assets/' + MASTER + '/versions'))).toBe(true);

    const block = container.querySelector('#asset-versions')!;
    expect(block).not.toBeNull();
    expect(block.textContent).toContain(VERSION_CHAIN_COPY.heading);
    expect(renderedIds(block).sort()).toEqual([MASTER, ROUGH, ROUGH2, TRAILER].sort());
    expect(currentRowId(block)).toBe(ROUGH2);
    expect(hereRowId(block)).toBe(MASTER);
  });

  it('navigates to another version and RE-FETCHES the chain for it', async () => {
    const fetchSpy = routedFetch((id) => ({ status: 200, body: chainFor(id) }));
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(MASTER, container);
    await settle();

    const link = container.querySelector(
      '.version-link[data-asset-id="' + TRAILER + '"]'
    ) as HTMLElement;
    expect(link).not.toBeNull();
    link.click();
    await settle();

    const versionCalls = fetchSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => /\/versions$/.test(u));
    // The envelope is target-relative, so the previous response is never reused.
    expect(versionCalls.some((u) => u.endsWith('/assets/' + TRAILER + '/versions'))).toBe(true);

    const block = container.querySelector('#asset-versions')!;
    expect(hereRowId(block)).toBe(TRAILER);
    // Current is group-scoped and does not move with the viewer.
    expect(currentRowId(block)).toBe(ROUGH2);
    // The row you are now on is no longer a link.
    expect(block.querySelector('.version-link[data-asset-id="' + TRAILER + '"]')).toBeNull();
    expect(block.querySelector('.version-link[data-asset-id="' + MASTER + '"]')).not.toBeNull();
  });

  it('steps to the next version in the server’s array order', async () => {
    vi.stubGlobal('fetch', routedFetch((id) => ({ status: 200, body: chainFor(id) })));

    await renderAssetDetailBody(MASTER, container);
    await settle();

    (container.querySelector('.version-step[data-step="next"]') as HTMLElement).click();
    await settle();

    expect(hereRowId(container.querySelector('#asset-versions')!)).toBe(ROUGH);
  });

  it('renders the "no other versions" state for a never-versioned asset', async () => {
    vi.stubGlobal('fetch', routedFetch((id) => ({ status: 200, body: soloChain(id) })));

    await renderAssetDetailBody(MASTER, container);
    await settle();

    const block = container.querySelector('#asset-versions')!;
    expect(block.querySelector('[data-empty="version-chain"]')?.textContent).toContain(
      VERSION_CHAIN_COPY.emptyHeadline
    );
    expect(block.querySelector('.version-steps')).toBeNull();
  });

  it('reports a failed read as a failed READ, never as "no other versions"', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch(() => ({ status: 404, body: { error: 'not_found' } }))
    );

    await renderAssetDetailBody(MASTER, container);
    await settle();

    const block = container.querySelector('#asset-versions')!;
    expect(block.querySelector('#version-chain-error')?.textContent).toContain(
      VERSION_CHAIN_COPY.errorPrefix
    );
    expect(block.textContent).not.toContain(VERSION_CHAIN_COPY.emptyHeadline);
    expect(block.querySelector('#version-chain-retry')).not.toBeNull();
  });

  it('retries the read on demand', async () => {
    let fail = true;
    const fetchSpy = routedFetch((id) =>
      fail ? { status: 500, body: { error: 'internal' } } : { status: 200, body: chainFor(id) }
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(MASTER, container);
    await settle();
    expect(container.querySelector('#version-chain-error')).not.toBeNull();

    fail = false;
    (container.querySelector('#version-chain-retry') as HTMLElement).click();
    await settle();

    expect(container.querySelector('#version-chain-error')).toBeNull();
    expect(hereRowId(container.querySelector('#asset-versions')!)).toBe(MASTER);
  });

  it('puts the reader back on the you-are-here row after navigating', async () => {
    vi.stubGlobal('fetch', routedFetch((id) => ({ status: 200, body: chainFor(id) })));

    await renderAssetDetailBody(MASTER, container);
    await settle();

    (container.querySelector('.version-link[data-asset-id="' + ROUGH + '"]') as HTMLElement).click();
    await settle();

    const row = focusYouAreHereRow(container);
    expect(row?.getAttribute('data-version-id')).toBe(ROUGH);
  });
});
