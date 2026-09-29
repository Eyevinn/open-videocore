// @vitest-environment happy-dom
//
// Component-level tests for the delete-lock indicator in the asset list
// (issue #894), implementing docs/ux/asset-lock-state-spec.md §3 and the parts
// of its §10 acceptance checklist that belong to the list surface.
//
// CONTRACT GROUNDING — the fixtures below use only field names verified against
// this repo's generated spec and route source, never the issue text:
//
//   Lock object on the LIST payload (present):
//     openapi.json .paths["/api/v1/assets/"].get.responses["200"]
//       .content["application/json"].schema.properties.items.items
//       .properties.deleteLock
//     = { locked: boolean, reason?: string, lockedAt: string, lockedBy?: string },
//       required ["locked","lockedAt"], additionalProperties false.
//     Source: `deleteLockSchema` src/routes/assets.ts:528, used at
//     `assetSchema.deleteLock` :838; TS type `DeleteLock`
//     src/data/asset-repo.ts:441, on `Asset.deleteLock?` :470.
//
//   Lock object ABSENT from the free-text search payload:
//     openapi.json .paths["/api/v1/search/"].get.responses["200"]
//       .content["application/json"].schema.properties.assets.items.properties
//     = id, name, description, status, parentId, objectKey, statusHistory,
//       technicalMetadata, technicalMetadataError, manifestUrls, packagingError,
//       renditions, metadata, createdAt, updatedAt, type — no `deleteLock`.
//     Source: `assetSchema` src/routes/search.ts:78 (Fastify serializes the
//     response against it).
//
//   Unlock removes the field rather than writing `locked: false`:
//     `applyDeleteLock` src/data/asset-repo.ts:1083-1086 returns
//     `deleteLock: undefined`. Asserted below as a derivation case.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssetsTable } from '../public/assets-table.js';
import {
  LOCK_COPY,
  LOCK_LOCKED,
  LOCK_UNKNOWN,
  LOCK_UNLOCKED,
  isAssetLocked,
  lockStateOf,
} from '../public/lock-state.js';

// Minimal render helpers matching app.js's signatures (same shape the sibling
// assets-table test uses).
const deps = () => ({
  renderBadge: (s: string) => '<span class="badge">' + s + '</span>',
  renderTags: () => '',
  fmtDate: (v: string) => String(v || '—'),
  isAssetWedged: () => false,
});

function fakeApi(handlers: Record<string, (url: URL) => unknown>) {
  const calls: string[] = [];
  const apiFetch = vi.fn(async (path: string) => {
    calls.push(path);
    const url = new URL('http://x' + (path.startsWith('/') ? path : '/' + path));
    const key = url.pathname.replace(/^\//, '').split('?')[0];
    const h = handlers[key];
    if (!h) throw new Error('unexpected endpoint: ' + key);
    return h(url);
  });
  return { apiFetch, calls };
}

function stubWin(search = '') {
  return {
    location: { search, pathname: '/', hash: '' },
    history: {
      state: null,
      replaceState: () => {},
      pushState: () => {},
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Rows as the two tiers really serve them.
const LOCKED_ROW = {
  id: 'a-locked',
  name: 'Protected master',
  status: 'ready',
  createdAt: '2026-01-01T00:00:00Z',
  deleteLock: {
    locked: true,
    lockedAt: '2026-01-02T10:00:00Z',
    lockedBy: 'retention-policy',
    reason: 'Legal hold until the appeal closes',
  },
};
const UNLOCKED_ROW = {
  id: 'a-plain',
  name: 'Ordinary asset',
  status: 'ready',
  createdAt: '2026-01-01T00:00:00Z',
};

function rowFor(el: HTMLElement, id: string): HTMLElement {
  const tr = el.querySelector('tbody tr[data-row-key="' + id + '"]');
  if (!tr) throw new Error('no row for ' + id);
  return tr as HTMLElement;
}

async function mountList(items: unknown[], search = '') {
  const { apiFetch } = fakeApi({
    assets: () => ({ items, total: items.length }),
    search: () => ({ assets: items, total: items.length, page: 1 }),
  });
  const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin(search) });
  document.body.appendChild(t.el);
  await tick();
  return t;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ── §2 the shared derivation ────────────────────────────────────────────────

describe('lockStateOf — the one derivation all three surfaces share (spec §2)', () => {
  it('reports L2 locked only for deleteLock.locked === true', () => {
    expect(lockStateOf(LOCKED_ROW)).toBe(LOCK_LOCKED);
    expect(isAssetLocked(LOCKED_ROW)).toBe(true);
  });

  it('reports L1 unlocked when the field is absent, without throwing', () => {
    // Unlock DELETES the field (asset-repo.ts:1083-1086) — it does not write
    // `locked: false`. A check shaped `asset.deleteLock.locked === false` would
    // throw right here.
    expect(() => lockStateOf(UNLOCKED_ROW)).not.toThrow();
    expect(lockStateOf(UNLOCKED_ROW)).toBe(LOCK_UNLOCKED);
  });

  it('treats an explicit locked:false as L1 unlocked, not as a lock', () => {
    // The schema permits it (`locked` is a real boolean, required alongside
    // `lockedAt`), so a `'deleteLock' in asset` test would be wrong here.
    const asset = { id: 'x', deleteLock: { locked: false, lockedAt: '2026-01-02T10:00:00Z' } };
    expect(lockStateOf(asset)).toBe(LOCK_UNLOCKED);
    expect(isAssetLocked(asset)).toBe(false);
  });

  it('reports L0 unknown for a projection that does not carry the field', () => {
    expect(lockStateOf(UNLOCKED_ROW, { projectionCarriesLock: false })).toBe(LOCK_UNKNOWN);
    // Unknown is NOT locked — the UI must not assert a lock it cannot see...
    expect(isAssetLocked(UNLOCKED_ROW, { projectionCarriesLock: false })).toBe(false);
    // ...and it is not "unlocked" either, which is the whole point of L0.
    expect(lockStateOf(UNLOCKED_ROW, { projectionCarriesLock: false })).not.toBe(LOCK_UNLOCKED);
  });

  it('tolerates a null/undefined asset', () => {
    expect(lockStateOf(null)).toBe(LOCK_UNLOCKED);
    expect(lockStateOf(undefined)).toBe(LOCK_UNLOCKED);
  });
});

// ── §3.2 / §3.3 the list indicator ───────────────────────────────────────────

describe('asset list — locked rows (spec §3.2 L2, §3.3)', () => {
  it('flags a locked row in the Status cell with the word "Locked"', async () => {
    const t = await mountList([LOCKED_ROW]);
    const flag = rowFor(t.el, 'a-locked').querySelector('.asset-lock-flag') as HTMLElement;
    expect(flag).toBeTruthy();
    // Real text, not an icon or a colour swatch.
    expect(flag.textContent).toContain(LOCK_COPY.badge);
    expect(LOCK_COPY.badge).toBe('Locked');
  });

  it('puts the flag in the Status cell, after the status badge — no new column', async () => {
    const t = await mountList([LOCKED_ROW]);
    const row = rowFor(t.el, 'a-locked');
    const headerLabels = Array.from(t.el.querySelectorAll('thead th')).map((th) =>
      (th.textContent || '').trim()
    );
    // The column set is unchanged — thumb, ID, Slug, Name/Title, Status, Tags,
    // Created, Actions — so no "Lock" column was added (spec §3.1: the lock is a
    // rare, secondary attribute and does not earn a column of its own).
    expect(headerLabels.length).toBe(8);
    expect(headerLabels.join('|').toLowerCase()).not.toContain('lock');

    const statusCellIndex = headerLabels.findIndex((l) => l.toLowerCase().startsWith('status'));
    const statusCell = row.querySelectorAll('td')[statusCellIndex];
    expect(statusCell.querySelector('.asset-lock-flag')).toBeTruthy();
    // Status badge first, lock flag second.
    const badges = Array.from(statusCell.querySelectorAll('span'));
    expect(badges[0].className).toContain('badge');
    expect(badges[0].className).not.toContain('badge-locked');
  });

  it('uses the shared badge pattern and the exact spec copy', async () => {
    const t = await mountList([LOCKED_ROW]);
    const flag = rowFor(t.el, 'a-locked').querySelector('.asset-lock-flag') as HTMLElement;
    expect(flag.classList.contains('badge')).toBe(true);
    expect(flag.classList.contains('badge-locked')).toBe(true);
    // Not the wedged/attention amber, and not an error colour.
    expect(flag.classList.contains('badge-attention')).toBe(false);
    expect(flag.getAttribute('title')).toBe(
      'Delete-locked. Archiving is refused until the lock is cleared.'
    );
    expect(LOCK_COPY.badgeTitle).toBe(flag.getAttribute('title'));
  });

  it('carries a visually-hidden consequence clause for assistive technology', async () => {
    const t = await mountList([LOCKED_ROW]);
    const sr = rowFor(t.el, 'a-locked').querySelector(
      '.asset-lock-flag .visually-hidden'
    ) as HTMLElement;
    expect(sr).toBeTruthy();
    expect(sr.textContent).toBe(': archiving is refused until the lock is cleared');
  });

  it('accents the locked row so the flag survives horizontal scrolling', async () => {
    const t = await mountList([LOCKED_ROW, UNLOCKED_ROW]);
    expect(rowFor(t.el, 'a-locked').classList.contains('row-locked')).toBe(true);
    // Decorative only: it never appears without the badge it duplicates.
    expect(rowFor(t.el, 'a-plain').classList.contains('row-locked')).toBe(false);
  });

  it('never renders the lock reason or the lockedBy label in the list', async () => {
    // Both are asset-controlled free text (up to 1024 / 256 chars). They belong
    // on the detail surface (#895); in a table they would wreck the row height,
    // and rendering them here would be the only place the list handled
    // asset-controlled text.
    const t = await mountList([LOCKED_ROW]);
    const row = rowFor(t.el, 'a-locked');
    expect(row.textContent).not.toContain('Legal hold');
    expect(row.textContent).not.toContain('retention-policy');
    expect(row.innerHTML).not.toContain('Legal hold');
    expect(row.innerHTML).not.toContain('retention-policy');
  });

  it('cannot be made to inject markup through lock free-text fields', async () => {
    const hostile = {
      ...LOCKED_ROW,
      id: 'a-hostile',
      deleteLock: {
        locked: true,
        lockedAt: '2026-01-02T10:00:00Z',
        lockedBy: '<img src=x onerror="window.__pwned=1">',
        reason: '</span><script>window.__pwned=1</script>',
      },
    };
    const t = await mountList([hostile]);
    const row = rowFor(t.el, 'a-hostile');
    expect(row.querySelector('script')).toBeNull();
    expect(row.querySelector('img')).toBeNull();
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    // The flag is still there — the lock is shown, its free text is not.
    expect(row.querySelector('.asset-lock-flag')).toBeTruthy();
  });
});

// ── §3.2 L1 — absence is the signal ──────────────────────────────────────────

describe('asset list — unlocked rows (spec §3.2 L1)', () => {
  it('renders no indicator at all for an unlocked asset', async () => {
    const t = await mountList([UNLOCKED_ROW]);
    const row = rowFor(t.el, 'a-plain');
    expect(row.querySelector('.asset-lock-flag')).toBeNull();
    expect(row.querySelector('.badge-locked')).toBeNull();
    // No empty placeholder cell, and no "Unlocked" counter-badge.
    expect((row.textContent || '').toLowerCase()).not.toContain('lock');
  });

  it('renders no indicator for an explicit locked:false lock object', async () => {
    const t = await mountList([
      {
        id: 'a-false',
        name: 'Was locked once',
        status: 'ready',
        createdAt: '2026-01-01T00:00:00Z',
        deleteLock: { locked: false, lockedAt: '2026-01-02T10:00:00Z' },
      },
    ]);
    const row = rowFor(t.el, 'a-false');
    expect(row.querySelector('.asset-lock-flag')).toBeNull();
    expect(row.classList.contains('row-locked')).toBe(false);
  });
});

// ── §3.2 L0 — the search projection omits the field ──────────────────────────

describe('asset list — free-text tier is lock-state UNKNOWN (spec §3.2 L0, gap H1)', () => {
  it('shows no lock flag for search rows, and no "unlocked" claim either', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({ items: [LOCKED_ROW], total: 1 }),
      // What the real search projection returns for the SAME asset: no
      // `deleteLock` key, because `assetSchema` (src/routes/search.ts:78) has
      // no such property and Fastify serializes against it.
      search: () => ({
        assets: [
          {
            id: 'a-locked',
            name: 'Protected master',
            status: 'ready',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
        total: 1,
        page: 1,
      }),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    // Tier 1: the asset is known-locked and flagged.
    expect(rowFor(t.el, 'a-locked').querySelector('.asset-lock-flag')).toBeTruthy();

    t.state.setFilter('q', 'master');
    await tick();
    expect(calls.some((c) => c.startsWith('/search'))).toBe(true);

    // Tier 2: same asset, projection without the field. No flag is asserted...
    const row = rowFor(t.el, 'a-locked');
    expect(row.querySelector('.asset-lock-flag')).toBeNull();
    expect(row.classList.contains('row-locked')).toBe(false);
    // ...and no counter-claim is made either: nothing in the row says the asset
    // is unlocked, so the operator is not told something false (§1 rule 3).
    expect((row.textContent || '').toLowerCase()).not.toContain('unlock');
  });

  it('restores the flag when the free-text term is cleared and tier 1 returns', async () => {
    const { apiFetch } = fakeApi({
      assets: () => ({ items: [LOCKED_ROW], total: 1 }),
      search: () => ({
        assets: [
          { id: 'a-locked', name: 'Protected master', status: 'ready', createdAt: '2026-01-01T00:00:00Z' },
        ],
        total: 1,
        page: 1,
      }),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    t.state.setFilter('q', 'master');
    await tick();
    expect(rowFor(t.el, 'a-locked').querySelector('.asset-lock-flag')).toBeNull();

    t.state.setFilter('q', '');
    await tick();
    expect(rowFor(t.el, 'a-locked').querySelector('.asset-lock-flag')).toBeTruthy();
    expect(rowFor(t.el, 'a-locked').classList.contains('row-locked')).toBe(true);
  });

  it('starts in the unknown tier when the URL seeds a free-text term', async () => {
    // A shared link with `assets.q=...` loads tier 2 first; the very first
    // render must not assume the lock-bearing projection.
    const { apiFetch } = fakeApi({
      assets: () => ({ items: [LOCKED_ROW], total: 1 }),
      search: () => ({
        assets: [{ ...LOCKED_ROW }], // even if a row somehow carries the field
        total: 1,
        page: 1,
      }),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin('?assets.q=master') });
    document.body.appendChild(t.el);
    await tick();
    expect(rowFor(t.el, 'a-locked').querySelector('.asset-lock-flag')).toBeNull();
  });
});

// ── §3.4 / §6 what this surface must NOT do ──────────────────────────────────

describe('asset list — lock scope limits (spec §3.4, §6, checklist §10)', () => {
  it('ships no "Locked only" filter and no lock sort axis', async () => {
    // GET /api/v1/assets/ accepts only limit, offset, status, parentId, from,
    // to — there is no lock predicate, so a client-side filter would silently
    // narrow the page while `total` kept reporting the unfiltered count.
    const t = await mountList([LOCKED_ROW, UNLOCKED_ROW]);
    const controls = t.el.querySelectorAll('.ops-table-filters *');
    Array.from(controls).forEach((c) => {
      expect(((c as HTMLElement).textContent || '').toLowerCase()).not.toContain('lock');
      expect(((c as HTMLElement).getAttribute('aria-label') || '').toLowerCase()).not.toContain(
        'lock'
      );
    });
    const sortButtons = Array.from(t.el.querySelectorAll('thead button')).map((b) =>
      (b.textContent || '').toLowerCase()
    );
    expect(sortButtons.some((l) => l.includes('lock'))).toBe(false);
  });

  it('adds no lock or unlock action to the row', async () => {
    // Locking takes an optional reason and belongs on detail (#895), behind the
    // asset's full context.
    const t = await mountList([LOCKED_ROW]);
    const buttons = Array.from(rowFor(t.el, 'a-locked').querySelectorAll('button')).map((b) =>
      (b.textContent || '').trim().toLowerCase()
    );
    expect(buttons).not.toContain('lock');
    expect(buttons).not.toContain('unlock');
  });

  it('leaves the Archive control enabled on a locked row (spec §5.1)', async () => {
    // A disabled button is out of the tab order and explains nothing; the 409
    // path is the explanation point (#896). The list also cannot always know the
    // lock state (L0), so disabling would be applied inconsistently.
    const t = await mountList([LOCKED_ROW]);
    const archive = rowFor(t.el, 'a-locked').querySelector(
      '.asset-delete-btn'
    ) as HTMLButtonElement;
    expect(archive).toBeTruthy();
    expect(archive.disabled).toBe(false);
    expect((archive.textContent || '').trim()).toBe('Archive');
  });

  it('introduces no SVG, icon font or emoji (spec §6)', async () => {
    const t = await mountList([LOCKED_ROW]);
    const html = rowFor(t.el, 'a-locked').innerHTML;
    expect(html.toLowerCase()).not.toContain('<svg');
    // No pictographic characters: the flag is text and colour only.
    expect(/\p{Extended_Pictographic}/u.test(html)).toBe(false);
  });
});
