// @vitest-environment happy-dom
//
// Version-chain view on the asset detail pane (issue #942, broken out of #795),
// against the interaction spec in docs/design/asset-version-chain.md (#941).
//
// The three acceptance points are each pinned here:
//   1. the chain is visible and navigable from asset detail — the integration
//      block drives the REAL renderer (renderAssetDetailBody, the same code path
//      the side panel and the detached window use) and clicks a row;
//   2. the current version is clearly identifiable — badged from the server's
//      `currentVersionId`, on a fixture where that is NOT the last element;
//   3. an asset with no versions renders a clear empty state — the
//      single-member chain the API actually returns, not a length-0 array.
//
// CONTRACT GROUNDING — every field, order and status below was read from this
// repo's generated spec and source before the tests were written (CLAUDE.md
// rule 7), never from the issue text. `openapi.json` declares no `operationId`
// anywhere, so the operation is named by path + method:
//
//   openapi.json .paths["/api/v1/assets/{id}/versions"] — the only key is
//     `get`; its only parameter is path `id` (string, required). There is no
//     pagination parameter. Handler src/routes/assets.ts:3689-3727.
//
//   200 schema (…get.responses["200"].content["application/json"].schema):
//     properties `assetId`, `versionGroupId`, `currentVersionId`, `versions`;
//     required ["assetId","currentVersionId","versions"];
//     additionalProperties: false. Source src/routes/assets.ts:3694-3699 —
//     `versionGroupId: z.string().optional()` (:3696),
//     `currentVersionId: z.string()` (:3697),
//     `versions: z.array(assetSchema)` (:3698).
//     `versions` items require ["id","name","status","statusHistory",
//     "createdAt","updatedAt"]; `status` enum = uploading|processing|ready|
//     failed|archived.
//
//   Lineage edges: `versionOfAssetId` / `versionGroupId`, both
//     `z.string().optional()` on assetSchema (src/routes/assets.ts:887-888).
//     `versionOfAssetId` names the IMMEDIATE predecessor and is absent on the
//     root (resolveVersionLinkage, src/data/asset-repo.ts:1210-1221).
//
//   Ordering: oldest first — createdAt ascending, ties broken by id ascending
//     (compareVersionOrder, src/data/asset-repo.ts:1231-1233). Pinned by
//     src/routes/assets.versions.test.ts:146-204.
//
//   `currentVersionId` is SERVER-computed and is NOT the last array element:
//     the ladder is ready → (uploading|processing) → failed → archived,
//     newest-first within the highest non-empty tier
//     (src/data/asset-repo.ts:1275-1295), and :1239-1246 says outright that
//     clients must read the field rather than re-derive it. The archived-head
//     fixture below is the shape src/routes/assets.versions.test.ts:252-280
//     asserts.
//
//   Chains BRANCH: two versions cut from one source share a group and both name
//     that source (src/routes/assets.versions.test.ts:206-235, ADR-024 D4), so
//     the view reconstructs a TREE.
//
//   Never-versioned asset: a single-member chain containing only itself with
//     `versionGroupId` ABSENT (src/data/asset-repo.ts:1811-1813,
//     src/data/couch-asset-repo.ts:620-622; pinned by
//     src/routes/assets.versions.test.ts:112-126). There is no length-0 case.
//
//   404 body is flat: { error, message? }, required ["error"]; the handler
//     sends { error: 'not_found' } (src/routes/assets.ts:3707).
//
//   MAX_LIMIT = 200 caps the page (src/data/asset-repo.ts:853, applied
//     src/data/couch-asset-repo.ts:626), so the view discloses truncation and
//     never reparents a member whose source fell outside the window.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetDetailBody } from '../public/app.js';
import {
  VERSIONS_COPY,
  VERSION_PAGE_LIMIT,
  buildVersionRows,
  currentVersionMember,
  isUnversioned,
  isVersionChainTruncated,
  isoUtc,
  mountVersionChain,
  normaliseVersionsRead,
  renderVersionChainBlock,
  versionChainPosition,
  versionLabel,
} from '../public/version-chain.js';

const SOURCE = '01J9AAAAAAAAAAAAAAAAAAAAAA';
const V1 = '01J9BBBBBBBBBBBBBBBBBBBBBB';
const V2 = '01J9CCCCCCCCCCCCCCCCCCCCCC';
const ABSENT = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';

function member(over: Record<string, unknown>) {
  return {
    status: 'ready',
    statusHistory: [{ at: '2026-05-01T00:00:00.000Z', from: null, to: 'ready' }],
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...over,
  };
}

// The archived-head chain from src/routes/assets.versions.test.ts:252-280:
// source -> v1 -> v2, v2 soft-deleted, so the server names v1 current while v2
// is the LAST element. Any view that re-derived "current" would badge v2.
const ARCHIVED_HEAD = {
  assetId: SOURCE,
  versionGroupId: SOURCE,
  currentVersionId: V1,
  versions: [
    member({ id: SOURCE, name: 'master', createdAt: '2026-05-01T00:00:00.000Z' }),
    member({
      id: V1,
      name: 'rough-cut',
      createdAt: '2026-05-02T00:00:00.000Z',
      versionOfAssetId: SOURCE,
      versionGroupId: SOURCE,
    }),
    member({
      id: V2,
      name: 'rough-cut-v2',
      status: 'archived',
      createdAt: '2026-05-03T00:00:00.000Z',
      versionOfAssetId: V1,
      versionGroupId: SOURCE,
    }),
  ],
};

// The branching chain from src/routes/assets.versions.test.ts:206-235: two
// versions cut from ONE source, both naming it.
const BRANCHED = {
  assetId: SOURCE,
  versionGroupId: SOURCE,
  currentVersionId: V2,
  versions: [
    member({ id: SOURCE, name: 'master', createdAt: '2026-03-01T00:00:00.000Z' }),
    member({
      id: V1,
      name: 'left-branch',
      createdAt: '2026-03-02T00:00:00.000Z',
      versionOfAssetId: SOURCE,
      versionGroupId: SOURCE,
    }),
    member({
      id: V2,
      name: 'right-branch',
      createdAt: '2026-03-03T00:00:00.000Z',
      versionOfAssetId: SOURCE,
      versionGroupId: SOURCE,
    }),
  ],
};

// The never-versioned asset: itself, no group (src/data/asset-repo.ts:1811-1813).
const SOLO = {
  assetId: SOURCE,
  currentVersionId: SOURCE,
  versions: [member({ id: SOURCE, name: 'never-versioned' })],
};

const rowIds = (root: ParentNode) =>
  Array.from(root.querySelectorAll('.version-row')).map((li) =>
    li.getAttribute('data-version-id')
  );

const rowFor = (root: ParentNode, id: string) =>
  root.querySelector('.version-row[data-version-id="' + id + '"]') as HTMLElement;

const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

// The envelope is TARGET-relative: `assetId` is whichever member was asked for
// and the server echoes it back (src/routes/assets.ts:3720), while
// `versions` / `versionGroupId` / `currentVersionId` are group-scoped and do not
// move. So "viewing member X" means the SAME chain with `assetId: X`.
const chainViewedFrom = (body: typeof ARCHIVED_HEAD, viewed: string) =>
  normaliseVersionsRead({ ...body, assetId: viewed }, viewed);

// ─────────────────────────────────────────────────────────────────────────────
// Envelope
// ─────────────────────────────────────────────────────────────────────────────

describe('reading the /versions envelope', () => {
  it('keeps the four declared fields and nothing else', () => {
    const read = normaliseVersionsRead(ARCHIVED_HEAD, SOURCE);
    expect(read.assetId).toBe(SOURCE);
    expect(read.versionGroupId).toBe(SOURCE);
    expect(read.currentVersionId).toBe(V1);
    expect(read.versions.map((v: any) => v.id)).toEqual([SOURCE, V1, V2]);
  });

  it('treats an ABSENT versionGroupId as null — the never-versioned signal', () => {
    // Optional on the wire (src/routes/assets.ts:3696) and read off the target
    // asset (:3721): absent means no lineage, not "unknown".
    const read = normaliseVersionsRead(SOLO, SOURCE);
    expect(read.versionGroupId).toBeNull();
  });

  it('falls back to the requested id, and never guesses a current version', () => {
    // Both fields are `required` on the wire, so this only fires for a
    // non-conforming server. An unresolvable currentVersionId must leave the
    // badge OFF rather than land it on an arbitrary row.
    const read = normaliseVersionsRead({}, SOURCE);
    expect(read.assetId).toBe(SOURCE);
    expect(read.currentVersionId).toBe('');
    expect(read.versions).toEqual([]);
  });

  it('drops entries that could not have come from the schema', () => {
    const read = normaliseVersionsRead(
      { assetId: SOURCE, currentVersionId: SOURCE, versions: [null, 7, { name: 'no id' }, member({ id: V1, name: 'ok' })] },
      SOURCE
    );
    expect(read.versions.map((v: any) => v.id)).toEqual([V1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Empty state (acceptance point 3)
// ─────────────────────────────────────────────────────────────────────────────

describe('the "no other versions" case', () => {
  it('is a SINGLE-member chain with no group, not an empty array', () => {
    expect(isUnversioned(normaliseVersionsRead(SOLO, SOURCE))).toBe(true);
  });

  it('is not triggered by a one-member page that DOES belong to a lineage', () => {
    // A truncated/filtered page of a real lineage still has a group id, and
    // claiming "no other versions" there would be a lie about the asset.
    const read = normaliseVersionsRead(
      { ...SOLO, versionGroupId: SOURCE },
      SOURCE
    );
    expect(isUnversioned(read)).toBe(false);
  });

  it('is not triggered by a populated chain', () => {
    expect(isUnversioned(normaliseVersionsRead(ARCHIVED_HEAD, SOURCE))).toBe(false);
  });

  it('renders the section with the empty copy, no rows and no stepper', () => {
    const block = renderVersionChainBlock(normaliseVersionsRead(SOLO, SOURCE), {});
    const empty = block.querySelector('[data-empty="versions"]') as HTMLElement;
    expect(empty).toBeTruthy();
    expect(norm(empty.textContent)).toContain(VERSIONS_COPY.empty);
    // Says how versions come to exist, and stops there — no action button.
    expect(norm(empty.textContent)).toContain(VERSIONS_COPY.emptyDetail);
    expect(block.querySelectorAll('button').length).toBe(0);
    // A chain of one is not a meaningful "current", so no row and no badge.
    expect(rowIds(block)).toEqual([]);
    expect(block.querySelector('.badge-current')).toBeNull();
    // The group slot is left empty rather than printing "none".
    expect(block.querySelector('.version-group-id')).toBeNull();
  });

  it('still renders the heading, so the section never silently disappears', () => {
    const block = renderVersionChainBlock(normaliseVersionsRead(SOLO, SOURCE), {});
    expect(norm(block.querySelector('.section-title')?.textContent)).toBe(VERSIONS_COPY.heading);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Current version (acceptance point 2)
// ─────────────────────────────────────────────────────────────────────────────

describe('identifying the current version', () => {
  it('badges the member the SERVER named, which is not the last element', () => {
    const read = normaliseVersionsRead(ARCHIVED_HEAD, SOURCE);
    // The trap: the newest member is archived, so "last element" is wrong
    // (src/data/asset-repo.ts:1239-1246).
    expect(read.versions[read.versions.length - 1].id).toBe(V2);
    expect(currentVersionMember(read)?.id).toBe(V1);

    const block = renderVersionChainBlock(read, {});
    const badges = block.querySelectorAll('.badge-current');
    expect(badges.length).toBe(1);
    expect(rowFor(block, V1).querySelector('.badge-current')).toBeTruthy();
    expect(rowFor(block, V2).querySelector('.badge-current')).toBeNull();
  });

  it('labels it "Current", never "Latest"', () => {
    const block = renderVersionChainBlock(normaliseVersionsRead(ARCHIVED_HEAD, SOURCE), {});
    const badge = block.querySelector('.badge-current') as HTMLElement;
    expect(norm(badge.textContent)).toContain('Current');
    expect(norm(block.textContent).toLowerCase()).not.toContain('latest');
    // Colour is never the only carrier of the state (WCAG 1.4.1): the badge
    // spells out the consequence for assistive technology.
    expect(norm(badge.querySelector('.visually-hidden')?.textContent)).toBe(
      VERSIONS_COPY.currentBadgeConsequence
    );
  });

  it('shows the member’s own status alongside Current, and says when nothing is ready', () => {
    // currentVersionId names the head of the lineage; it does not promise the
    // member is `ready` (src/data/asset-repo.ts:1266-1270).
    const read = normaliseVersionsRead(
      {
        assetId: SOURCE,
        versionGroupId: SOURCE,
        currentVersionId: V1,
        versions: [
          member({ id: SOURCE, name: 'master', status: 'failed' }),
          member({
            id: V1,
            name: 'retry',
            status: 'processing',
            createdAt: '2026-05-02T00:00:00.000Z',
            versionOfAssetId: SOURCE,
          }),
        ],
      },
      SOURCE
    );
    const block = renderVersionChainBlock(read, {});
    const row = rowFor(block, V1);
    // Both facts on one row: Current is kept, so the view cannot disagree with
    // the API, and the real status is right next to it.
    expect(row.querySelector('.badge-current')).toBeTruthy();
    expect(norm(row.textContent)).toContain('processing');
    expect(norm(block.querySelector('[data-note="nothing-ready"]')?.textContent)).toBe(
      VERSIONS_COPY.nothingReadyNote
    );
  });

  it('omits the note when the current member is ready', () => {
    const block = renderVersionChainBlock(normaliseVersionsRead(ARCHIVED_HEAD, SOURCE), {});
    expect(block.querySelector('[data-note="nothing-ready"]')).toBeNull();
  });

  it('offers no promote / set-current control, because no such endpoint exists', () => {
    // ADR-024 D3: current is derived, not operator-set. Nothing here may imply
    // otherwise (spec §0 gap 1).
    const block = renderVersionChainBlock(normaliseVersionsRead(ARCHIVED_HEAD, SOURCE), {});
    const labels = Array.from(block.querySelectorAll('button'))
      // The per-row copy-id buttons are the shared #851 affordance, not a
      // version action.
      .filter((b) => !b.classList.contains('copy-id-btn'))
      .map((b) => norm(b.textContent).toLowerCase());
    expect(labels).toEqual(['previous version', 'next version']);
    expect(block.querySelector('input,select')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tree reconstruction
// ─────────────────────────────────────────────────────────────────────────────

describe('reconstructing the chain as a tree', () => {
  it('renders a linear chain flat, in the server’s oldest-first order', () => {
    const tree = buildVersionRows(normaliseVersionsRead(ARCHIVED_HEAD, SOURCE));
    expect(tree.rows.map((r: any) => [r.version.id, r.depth])).toEqual([
      [SOURCE, 0],
      [V1, 1],
      [V2, 2],
    ]);
    expect(tree.orphans).toEqual([]);
  });

  it('renders a BRANCH as two siblings under one source', () => {
    const tree = buildVersionRows(normaliseVersionsRead(BRANCHED, SOURCE));
    expect(tree.rows.map((r: any) => [r.version.id, r.depth])).toEqual([
      [SOURCE, 0],
      [V1, 1],
      [V2, 1],
    ]);
    // Siblings keep the server's order within the group.
    expect(tree.rows[2].last).toBe(true);
  });

  it('carries the true depth to assistive technology as aria-level', () => {
    const block = renderVersionChainBlock(normaliseVersionsRead(ARCHIVED_HEAD, SOURCE), {});
    expect(rowFor(block, SOURCE).getAttribute('aria-level')).toBe('1');
    expect(rowFor(block, V2).getAttribute('aria-level')).toBe('3');
    // The connector is decoration; the lineage edge is also stated in text.
    expect(norm(rowFor(block, V2).textContent)).toContain('Source version: rough-cut');
  });

  it('groups a member whose source is NOT in the page instead of reparenting it', () => {
    // The page is bounded by MAX_LIMIT, so the source of a member can fall
    // outside it. Attaching it to the root would fabricate a lineage edge.
    const read = normaliseVersionsRead(
      {
        assetId: SOURCE,
        versionGroupId: SOURCE,
        currentVersionId: SOURCE,
        versions: [
          member({ id: SOURCE, name: 'master' }),
          member({ id: V1, name: 'cut-from-elsewhere', versionOfAssetId: ABSENT }),
        ],
      },
      SOURCE
    );
    const tree = buildVersionRows(read);
    expect(tree.rows.map((r: any) => r.version.id)).toEqual([SOURCE]);
    expect(tree.orphans.map((r: any) => r.version.id)).toEqual([V1]);

    const block = renderVersionChainBlock(read, {});
    expect(norm(block.querySelector('[data-group="orphans"]')?.textContent)).toBe(
      VERSIONS_COPY.orphanGroup
    );
    // Never dropped: every member the server sent is still on screen.
    expect(rowIds(block)).toEqual([SOURCE, V1]);
  });

  it('never loses a member, even if the edges form a cycle', () => {
    // Unreachable through the API (versionOfAssetId is set at create and
    // immutable, src/data/asset-repo.ts:649-650) — but a lost row would be a
    // worse failure than an orphaned one.
    const read = normaliseVersionsRead(
      {
        assetId: V1,
        versionGroupId: SOURCE,
        currentVersionId: V1,
        versions: [
          member({ id: V1, name: 'a', versionOfAssetId: V2 }),
          member({ id: V2, name: 'b', versionOfAssetId: V1 }),
        ],
      },
      V1
    );
    const block = renderVersionChainBlock(read, {});
    expect(rowIds(block).sort()).toEqual([V1, V2].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// You-are-here, ordering, truncation
// ─────────────────────────────────────────────────────────────────────────────

describe('orienting the reader in the chain', () => {
  it('marks the asset being viewed, separately from Current', () => {
    // On this fixture the two facts land on DIFFERENT rows, which is exactly
    // why they are different markers.
    const block = renderVersionChainBlock(normaliseVersionsRead(ARCHIVED_HEAD, SOURCE), {});
    const here = block.querySelectorAll('.version-row-here');
    expect(here.length).toBe(1);
    expect((here[0] as HTMLElement).getAttribute('data-version-id')).toBe(SOURCE);
    expect(here[0].getAttribute('aria-current')).toBe('true');
    expect(norm(here[0].textContent)).toContain(VERSIONS_COPY.hereMarker);
    expect(here[0].querySelector('.badge-current')).toBeNull();
  });

  it('shows both markers on one row when they coincide', () => {
    const block = renderVersionChainBlock(chainViewedFrom(ARCHIVED_HEAD, V1), {});
    const row = rowFor(block, V1);
    expect(row.classList.contains('version-row-here')).toBe(true);
    expect(row.querySelector('.badge-current')).toBeTruthy();
  });

  it('keeps archived members listed and navigable — this is lineage history', () => {
    const block = renderVersionChainBlock(normaliseVersionsRead(ARCHIVED_HEAD, SOURCE), {});
    const row = rowFor(block, V2);
    expect(norm(row.textContent)).toContain('archived');
    expect(row.querySelector('.version-link')).toBeTruthy();
  });

  it('renders createdAt as ISO 8601 UTC, and shows an unparseable value verbatim', () => {
    expect(isoUtc('2026-05-02T00:00:00.000Z')).toBe('2026-05-02T00:00:00.000Z');
    expect(isoUtc('not-a-date')).toBe('not-a-date');
    expect(isoUtc(undefined)).toBe(VERSIONS_COPY.absent);
    const block = renderVersionChainBlock(normaliseVersionsRead(ARCHIVED_HEAD, SOURCE), {});
    expect(norm(rowFor(block, V1).querySelector('.version-created')?.textContent)).toBe(
      '2026-05-02T00:00:00.000Z'
    );
  });

  it('carries each version id with the shared click-to-copy affordance', () => {
    // Issue #851's primitive, reused: the ULID is the value every asset-id
    // endpoint accepts, so it is shown in full and copyable rather than
    // truncated into a tooltip.
    const block = renderVersionChainBlock(normaliseVersionsRead(ARCHIVED_HEAD, SOURCE), {});
    const cell = rowFor(block, V2).querySelector('.version-id') as HTMLElement;
    expect(norm(cell.querySelector('.cell-id-value')?.textContent)).toBe(V2);
    expect(cell.querySelector('.copy-id-btn')?.getAttribute('data-copy-id')).toBe(V2);
  });

  it('falls back to the id when a server omits the required name', () => {
    expect(versionLabel({ id: V1 })).toBe(V1);
    expect(versionLabel({ id: V1, name: 'cut' })).toBe('cut');
  });

  it('discloses truncation at MAX_LIMIT rather than implying a complete chain', () => {
    expect(VERSION_PAGE_LIMIT).toBe(200);
    const versions = Array.from({ length: VERSION_PAGE_LIMIT }, (_, i) =>
      member({ id: 'v' + i, name: 'v' + i })
    );
    const read = normaliseVersionsRead(
      { assetId: 'v0', versionGroupId: SOURCE, currentVersionId: 'v0', versions },
      'v0'
    );
    expect(isVersionChainTruncated(read)).toBe(true);
    const block = renderVersionChainBlock(read, {});
    expect(norm(block.querySelector('[data-note="truncated"]')?.textContent)).toBe(
      VERSIONS_COPY.truncationNote
    );
  });

  it('shows no truncation note below the cap', () => {
    const read = normaliseVersionsRead(ARCHIVED_HEAD, SOURCE);
    expect(isVersionChainTruncated(read)).toBe(false);
    expect(renderVersionChainBlock(read, {}).querySelector('[data-note="truncated"]')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Navigation (acceptance point 1)
// ─────────────────────────────────────────────────────────────────────────────

describe('stepping through the chain', () => {
  it('steps in ARRAY order, which is the server’s declared total order', () => {
    const read = chainViewedFrom(ARCHIVED_HEAD, V1);
    expect(versionChainPosition(read)).toEqual({
      index: 1,
      total: 3,
      prevId: SOURCE,
      nextId: V2,
    });
  });

  it('disables the stepper at each end', () => {
    const first = renderVersionChainBlock(normaliseVersionsRead(ARCHIVED_HEAD, SOURCE), {});
    expect((first.querySelector('#version-prev') as HTMLButtonElement).disabled).toBe(true);
    expect((first.querySelector('#version-next') as HTMLButtonElement).disabled).toBe(false);

    const last = renderVersionChainBlock(chainViewedFrom(ARCHIVED_HEAD, V2), {});
    expect((last.querySelector('#version-prev') as HTMLButtonElement).disabled).toBe(false);
    expect((last.querySelector('#version-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('never links the row the reader is already on', () => {
    const block = renderVersionChainBlock(normaliseVersionsRead(ARCHIVED_HEAD, SOURCE), {});
    expect(rowFor(block, SOURCE).querySelector('a')).toBeNull();
    expect(
      Array.from(block.querySelectorAll('.version-link')).map((a) =>
        a.getAttribute('data-asset-id')
      )
    ).toEqual([V1, V2]);
  });

  it('renders plain text instead of dead links when the host offers no navigation', () => {
    const block = renderVersionChainBlock(normaliseVersionsRead(ARCHIVED_HEAD, SOURCE), {
      canNavigate: false,
    });
    expect(block.querySelectorAll('a').length).toBe(0);
    expect(rowIds(block)).toEqual([SOURCE, V1, V2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mount: the fetch, its failure, and the hand-off to the host
// ─────────────────────────────────────────────────────────────────────────────

describe('mounting the block', () => {
  it('reads GET /assets/{id}/versions once and renders the chain', async () => {
    const apiFetch = vi.fn(async () => ARCHIVED_HEAD);
    const host = document.createElement('div');
    await mountVersionChain({ assetId: SOURCE, host, apiFetch, onNavigate: () => {} });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe('/assets/' + SOURCE + '/versions');
    expect(rowIds(host)).toEqual([SOURCE, V1, V2]);
  });

  it('hands the clicked version id to the host, without following the href', async () => {
    const apiFetch = vi.fn(async () => ARCHIVED_HEAD);
    const onNavigate = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    await mountVersionChain({ assetId: SOURCE, host, apiFetch, onNavigate });

    const link = host.querySelector('.version-link[data-asset-id="' + V1 + '"]') as HTMLElement;
    const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith(V1);
    host.remove();
  });

  it('steps with the Next control too', async () => {
    const apiFetch = vi.fn(async () => ({ ...ARCHIVED_HEAD, assetId: V1 }));
    const onNavigate = vi.fn();
    const host = document.createElement('div');
    await mountVersionChain({ assetId: V1, host, apiFetch, onNavigate });

    (host.querySelector('#version-next') as HTMLButtonElement).click();
    expect(onNavigate).toHaveBeenCalledWith(V2);
    (host.querySelector('#version-prev') as HTMLButtonElement).click();
    expect(onNavigate).toHaveBeenLastCalledWith(SOURCE);
  });

  it('reports a failed READ as a failed read — never as "no other versions"', async () => {
    // The 404/5xx body is flat { error, message? } (src/routes/assets.ts:3707);
    // degrading it into the empty state would state a falsehood about the asset.
    const err: Error & { status?: number; body?: unknown } = new Error('versions unavailable');
    err.status = 503;
    err.body = { error: 'unavailable', message: 'versions unavailable' };
    const apiFetch = vi.fn(async () => {
      throw err;
    });
    const host = document.createElement('div');
    await mountVersionChain({ assetId: SOURCE, host, apiFetch, onNavigate: () => {} });

    const box = host.querySelector('[data-error="versions"]') as HTMLElement;
    expect(box).toBeTruthy();
    expect(norm(box.textContent)).toContain('versions unavailable');
    expect(box.getAttribute('role')).toBe('alert');
    expect(host.querySelector('[data-empty="versions"]')).toBeNull();
    // ...and it offers a way out.
    expect(host.querySelector('#versions-retry')).toBeTruthy();
  });

  it('retries on demand and replaces the error with the chain', async () => {
    let fail = true;
    const apiFetch = vi.fn(async () => {
      if (fail) {
        fail = false;
        throw new Error('boom');
      }
      return ARCHIVED_HEAD;
    });
    const host = document.createElement('div');
    await mountVersionChain({ assetId: SOURCE, host, apiFetch, onNavigate: () => {} });
    (host.querySelector('#versions-retry') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-error="versions"]')).toBeNull();
    expect(rowIds(host)).toEqual([SOURCE, V1, V2]);
  });

  it('moves focus to the you-are-here row when asked, so the reader keeps their place', async () => {
    const apiFetch = vi.fn(async () => ({ ...ARCHIVED_HEAD, assetId: V1 }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    await mountVersionChain({
      assetId: V1,
      host,
      apiFetch,
      onNavigate: () => {},
      focusHere: true,
    });
    expect((document.activeElement as HTMLElement)?.getAttribute('data-version-id')).toBe(V1);
    host.remove();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: the real asset-detail renderer
// ─────────────────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const assetFor = (id: string, name: string) => ({
  id,
  name,
  status: 'ready',
  reviewState: 'draft',
  statusHistory: [{ at: '2026-05-01T00:00:00.000Z', from: null, to: 'ready' }],
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
});

/** Route by path; every asset read serves the matching chain member. */
function routedFetch() {
  return vi.fn(async (url: string) => {
    const path = String(url);
    if (/\/versions$/.test(path)) {
      // The envelope is TARGET-relative: `assetId` is whichever member was
      // asked for (src/routes/assets.ts:3720), the rest is group-scoped.
      const target = path.includes(V1) ? V1 : path.includes(V2) ? V2 : SOURCE;
      return json({ ...ARCHIVED_HEAD, assetId: target });
    }
    if (/\/review-state$/.test(path)) {
      return json({ reviewState: 'draft', allowedTransitions: ['in-review'] });
    }
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) {
      const id = path.includes(V1) ? V1 : path.includes(V2) ? V2 : SOURCE;
      return json(assetFor(id, id === SOURCE ? 'master' : id === V1 ? 'rough-cut' : 'rough-cut-v2'));
    }
    return json({}, 200);
  });
}

async function settle(ticks = 30) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('the version chain on the real asset detail pane', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  it('is visible from asset detail, with the current version badged', async () => {
    vi.stubGlobal('fetch', routedFetch());
    await renderAssetDetailBody(SOURCE, container);
    await settle();

    const block = container.querySelector('#asset-versions') as HTMLElement;
    expect(block).toBeTruthy();
    expect(norm(block.querySelector('.section-title')?.textContent)).toBe('Versions');
    expect(rowIds(block)).toEqual([SOURCE, V1, V2]);
    expect(rowFor(block, V1).querySelector('.badge-current')).toBeTruthy();
    expect(rowFor(block, SOURCE).classList.contains('version-row-here')).toBe(true);
  });

  it('navigates to another version in place, re-reading that version’s chain', async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal('fetch', fetchMock);
    await renderAssetDetailBody(SOURCE, container);
    await settle();

    const link = container.querySelector(
      '.version-link[data-asset-id="' + V2 + '"]'
    ) as HTMLElement;
    link.click();
    await settle();

    // The pane is now showing V2...
    const block = container.querySelector('#asset-versions') as HTMLElement;
    expect(rowFor(block, V2).classList.contains('version-row-here')).toBe(true);
    expect(rowFor(block, SOURCE).classList.contains('version-row-here')).toBe(false);
    // ...Current did NOT move with it — it is the server's answer, not "the row
    // you are on".
    expect(rowFor(block, V1).querySelector('.badge-current')).toBeTruthy();
    // ...and the chain was re-read for the new target rather than carried over.
    const versionReads = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((p) => /\/versions$/.test(p));
    expect(versionReads.some((p) => p.includes(V2))).toBe(true);
  });

  it('renders the empty state for an asset that has never been versioned', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (/\/versions$/.test(path)) return json(SOLO);
      if (/\/review-state$/.test(path)) {
        return json({ reviewState: 'draft', allowedTransitions: [] });
      }
      if (/\/delivery$/.test(path)) return json({ urls: {} });
      if (/\/executions$/.test(path)) return json([]);
      if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
      if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
      if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(assetFor(SOURCE, 'solo'));
      return json({}, 200);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderAssetDetailBody(SOURCE, container);
    await settle();

    const block = container.querySelector('#asset-versions') as HTMLElement;
    expect(norm(block.querySelector('[data-empty="versions"]')?.textContent)).toContain(
      VERSIONS_COPY.empty
    );
    expect(rowIds(block)).toEqual([]);
  });
});
