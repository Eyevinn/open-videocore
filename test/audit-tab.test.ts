// @vitest-environment happy-dom
//
// DOM/unit tests for the cross-cutting Audit tab (issue #987).
//
// The audit log had a complete, filterable query endpoint but no cross-cutting
// surface: the UI only ever showed per-asset history, so "who archived things",
// "every failed job", "a collection's deletion history" and "system vs operator
// activity" could not be asked at all. These tests cover the new tab's routing,
// its filter->query-param mapping, and its offset paging.
//
// ─── Contract grounding (verified before any query param was written) ────────
// GET /api/v1/audit — src/routes/audit.ts:90-121, mounted at prefix
// '/api/v1/audit' (src/main.ts:2334-2337); spec openapi.json
// .paths["/api/v1/audit/"].get.
//   query params (listQuerySchema, src/routes/audit.ts:62-72):
//     limit 1..200 (AUDIT_MAX_LIMIT, src/data/audit-repo.ts:135), offset >= 0,
//     targetType enum asset|collection|job (AUDIT_TARGET_TYPES,
//     src/data/audit-repo.ts:40), targetId (min 1), origin enum user|system|ai
//     (PROVENANCE_ACTORS_FOR_AUDIT, src/data/audit-repo.ts:48 -> asset-repo.ts:99),
//     principalId, action (exact), from/to (inclusive ISO bounds on `at`).
//   `targetId` without `targetType` is a 400 invalid_query
//     (src/routes/audit.ts:102-107).
//   200 envelope (listSchema, src/routes/audit.ts:75-80):
//     { items, limit, offset, total } — `total` is the pre-paging match count
//     (applyAuditQuery, src/data/audit-repo.ts:157).
//   item (auditEntrySchema, src/routes/audit.ts:50-58):
//     { id, at, actor: { principalId: string|null, origin }, action,
//       targetType, targetId, detail }.
//   order is fixed newest-first with NO sort/order param
//     (src/data/audit-repo.ts:152-156) — hence no sortable column.
//   `actor.principalId` is null on every entry until read-auth lands
//     (src/data/audit-repo.ts:50-54, src/data/audit-emit.ts:38-47).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAuditTable,
  buildAuditQuery,
  summariseDetail,
  AUDIT_NS,
  AUDIT_PAGE_SIZE,
  AUDIT_LIMIT_MAX,
  AUDIT_TARGET_TYPES,
  AUDIT_ORIGINS,
  KNOWN_AUDIT_ACTIONS,
} from '../public/audit-table.js';
import { TABS, TAB_RENDERERS, setupTabs, auditTabWiring, TAB_KEY } from '../public/app.js';

const here = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(here, '../public/index.html');

/** The `.tab-bar` markup exactly as public/index.html ships it. */
function indexTabBarHtml(): string {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const m = html.match(/<nav class="tab-bar">[\s\S]*?<\/nav>/);
  if (!m) throw new Error('could not find .tab-bar in public/index.html');
  return m[0];
}

function mountOpsShell(): void {
  document.body.innerHTML = indexTabBarHtml() + '<main><div id="content"></div></main>';
}

/** A page of entries in the real wire shape, newest-first as the route returns. */
function makeEntries() {
  return [
    {
      id: '01JB000000000000000000000A',
      at: '2026-09-29T12:00:00.000Z',
      actor: { principalId: null, origin: 'user' },
      action: 'collection.deleted',
      targetType: 'collection',
      targetId: 'col-highlights',
      detail: { name: 'Highlights', memberCount: 4 },
    },
    {
      id: '01JB000000000000000000000B',
      at: '2026-09-29T11:00:00.000Z',
      actor: { principalId: null, origin: 'system' },
      action: 'job.failed',
      targetType: 'job',
      targetId: 'job-42',
      detail: { reason: 'transcode exited 1' },
    },
    {
      id: '01JB000000000000000000000C',
      at: '2026-09-29T10:00:00.000Z',
      actor: { principalId: null, origin: 'user' },
      action: 'asset.archived',
      targetType: 'asset',
      targetId: 'asset-7',
      detail: {},
    },
  ];
}

function page(items: unknown[], total?: number, offset = 0) {
  return { items, limit: AUDIT_PAGE_SIZE, offset, total: total ?? items.length };
}

/** A JSON fetch Response, as apiFetch (public/app.js:273-312) expects one. */
function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── Contract-grounded constants ─────────────────────────────────────────────

describe('contract constants', () => {
  it('mirrors AUDIT_TARGET_TYPES exactly', () => {
    expect(AUDIT_TARGET_TYPES).toEqual(['asset', 'collection', 'job']);
  });

  it('mirrors the coarse actor-origin enum exactly (no invented identity axis)', () => {
    expect(AUDIT_ORIGINS).toEqual(['user', 'system', 'ai']);
  });

  it('uses the audit namespace and a bounded page size within the limit ceiling', () => {
    expect(AUDIT_NS).toBe('audit');
    expect(AUDIT_LIMIT_MAX).toBe(200); // src/data/audit-repo.ts:135
    expect(AUDIT_PAGE_SIZE).toBeLessThanOrEqual(AUDIT_LIMIT_MAX);
  });

  it('suggests known actions without closing the open-string `action` field', () => {
    // A suggestion list, not an enum: the wire type is z.string()
    // (src/routes/audit.ts:69), so an unlisted action must stay queryable.
    expect(KNOWN_AUDIT_ACTIONS).toContain('collection.deleted');
    expect(KNOWN_AUDIT_ACTIONS).toContain('job.failed');
    expect(KNOWN_AUDIT_ACTIONS).toContain('asset.archived');
    expect(buildAuditQuery({ filters: { action: 'brand.new.action' } }).get('action')).toBe(
      'brand.new.action'
    );
  });
});

// ─── Pure query builder ──────────────────────────────────────────────────────

describe('buildAuditQuery', () => {
  it('emits bounded offset paging and nothing else for an unfiltered view', () => {
    const p = buildAuditQuery({ pageSize: AUDIT_PAGE_SIZE, offset: 0, filters: {} });
    expect(p.get('limit')).toBe(String(AUDIT_PAGE_SIZE));
    expect(p.get('offset')).toBe('0');
    expect([...p.keys()].sort()).toEqual(['limit', 'offset']);
    // Offset paging, not cursor — matches the route's paging mode.
    expect(p.get('cursor')).toBeNull();
  });

  it('clamps an over-large limit to the endpoint maximum', () => {
    expect(buildAuditQuery({ pageSize: 9999, filters: {} }).get('limit')).toBe(
      String(AUDIT_LIMIT_MAX)
    );
  });

  it('carries the current page offset', () => {
    expect(buildAuditQuery({ pageSize: 50, offset: 100, filters: {} }).get('offset')).toBe('100');
  });

  it('maps each filter onto its endpoint param one-to-one', () => {
    const p = buildAuditQuery({
      pageSize: 50,
      offset: 0,
      filters: {
        targetType: 'collection',
        targetId: 'col-1',
        origin: 'system',
        action: 'collection.deleted',
        from: '2026-01-02',
        to: '2026-01-04',
      },
    });
    expect(p.get('targetType')).toBe('collection');
    expect(p.get('targetId')).toBe('col-1');
    expect(p.get('origin')).toBe('system');
    expect(p.get('action')).toBe('collection.deleted');
    expect(p.get('from')).toBe('2026-01-02T00:00:00.000Z');
    expect(p.get('to')).toBe('2026-01-04T23:59:59.999Z');
  });

  it('never sends targetId without targetType — the route 400s on that pair', () => {
    const p = buildAuditQuery({ pageSize: 50, filters: { targetId: 'asset-7' } });
    expect(p.get('targetId')).toBeNull();
    expect(p.get('targetType')).toBeNull();
  });

  it('drops values outside the closed enums rather than sending a 400', () => {
    const p = buildAuditQuery({
      pageSize: 50,
      filters: { targetType: 'workspace', origin: 'robot' },
    });
    expect(p.get('targetType')).toBeNull();
    expect(p.get('origin')).toBeNull();
  });

  it('trims the exact-match action and omits it when blank', () => {
    expect(buildAuditQuery({ filters: { action: '  asset.archived  ' } }).get('action')).toBe(
      'asset.archived'
    );
    expect(buildAuditQuery({ filters: { action: '   ' } }).get('action')).toBeNull();
  });

  it('passes a full ISO range through unchanged', () => {
    const p = buildAuditQuery({
      filters: { from: '2026-01-02T08:30:00.000Z', to: '2026-01-04T12:00:00.000Z' },
    });
    expect(p.get('from')).toBe('2026-01-02T08:30:00.000Z');
    expect(p.get('to')).toBe('2026-01-04T12:00:00.000Z');
  });

  it('never invents a param the endpoint does not accept', () => {
    const p = buildAuditQuery({
      pageSize: 50,
      sort: { columnKey: 'at', direction: 'desc' },
      filters: { q: 'archived', status: 'failed', order: 'asc' },
    });
    const keys = [...p.keys()];
    expect(keys).not.toContain('q');
    expect(keys).not.toContain('status');
    expect(keys).not.toContain('order');
    expect(keys).not.toContain('sort');
  });
});

// ─── Detail summariser ───────────────────────────────────────────────────────

describe('summariseDetail', () => {
  it('renders the free-form detail bag as one scannable line', () => {
    expect(summariseDetail({ name: 'Highlights', memberCount: 4 })).toBe(
      'name=Highlights · memberCount=4'
    );
  });

  it('serialises nested values and truncates a long bag', () => {
    expect(summariseDetail({ prev: { status: 'ready' } })).toBe('prev={"status":"ready"}');
    const long = summariseDetail({ reason: 'x'.repeat(400) }, 40);
    expect(long.length).toBe(40);
    expect(long.endsWith('…')).toBe(true);
  });

  it('degrades to an empty summary for a missing/!object detail', () => {
    expect(summariseDetail(undefined)).toBe('');
    expect(summariseDetail({})).toBe('');
    expect(summariseDetail('nope' as unknown as object)).toBe('');
  });
});

// ─── Composition over the shared primitive ───────────────────────────────────

describe('createAuditTable', () => {
  it('queries the audit endpoint with offset paging on mount', async () => {
    const apiFetch = vi.fn().mockResolvedValue(page(makeEntries()));
    const table = createAuditTable({ apiFetch, win: null });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const url = apiFetch.mock.calls[apiFetch.mock.calls.length - 1][0] as string;
    expect(url).toMatch(/^\/audit\?/);
    expect(url).toContain('limit=' + AUDIT_PAGE_SIZE);
    expect(url).toContain('offset=0');
    table.destroy();
  });

  it('renders every entry newest-first, including a collection deletion', async () => {
    const apiFetch = vi.fn().mockResolvedValue(page(makeEntries()));
    const table = createAuditTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await vi.waitFor(() =>
      expect(table.el.querySelectorAll('tbody tr[data-row-key]').length).toBe(3)
    );

    const rows = Array.from(table.el.querySelectorAll('tbody tr[data-row-key]'));
    // Order is the server's (newest-first); the table must not re-sort.
    expect(rows.map((r) => r.querySelectorAll('td')[1]!.textContent)).toEqual([
      'collection.deleted',
      'job.failed',
      'asset.archived',
    ]);

    // The collection deletion — previously invisible anywhere in the UI.
    const deletion = rows[0]!;
    expect(deletion.textContent).toContain('collection');
    expect(deletion.textContent).toContain('col-highlights');
    expect(deletion.textContent).toContain('name=Highlights');
  });

  it('shows the coarse origin and an explicit empty Actor (identity is not recorded yet)', async () => {
    const apiFetch = vi.fn().mockResolvedValue(page(makeEntries()));
    const table = createAuditTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await vi.waitFor(() =>
      expect(table.el.querySelectorAll('tbody tr[data-row-key]').length).toBe(3)
    );

    const origins = Array.from(table.el.querySelectorAll('.audit-origin')).map(
      (el) => el.textContent
    );
    expect(origins).toEqual(['user', 'system', 'user']);
    // principalId is null on every entry, so the Actor cell is a dash, and the
    // reason is stated once rather than implied.
    const actorCells = Array.from(table.el.querySelectorAll('tbody tr[data-row-key]')).map(
      (r) => r.querySelectorAll('td')[5]!.textContent
    );
    expect(actorCells).toEqual(['—', '—', '—']);
    const note = table.el.querySelector('.audit-note');
    expect(note).not.toBeNull();
    expect(note!.getAttribute('role')).toBe('note');
    expect(note!.textContent).toContain('identity');
  });

  it('offers no sortable column — the endpoint has no sort param', async () => {
    const apiFetch = vi.fn().mockResolvedValue(page(makeEntries()));
    const table = createAuditTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(table.el.querySelectorAll('.ops-th-sort').length).toBe(0);
  });

  it('renders its filter controls with the existing filter-bar classes', async () => {
    const apiFetch = vi.fn().mockResolvedValue(page([]));
    const table = createAuditTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());

    const bar = table.el.querySelector('.ops-table-filters')!;
    expect(bar.querySelectorAll('[data-filter]').length).toBe(6);
    // Same classes the Jobs bar already uses, so the controls are never
    // unstyled (this does NOT depend on the unmerged shared-colour work).
    expect(bar.querySelectorAll('.ops-filter-select').length).toBe(2);
    expect(bar.querySelectorAll('.ops-filter-date').length).toBe(2);
    expect(bar.querySelectorAll('.ops-filter-search').length).toBe(2);
    // Unset controls read as unset (issue #984's class contract).
    expect(bar.querySelector('#audit-filter-target-type')!.classList.contains('is-unset')).toBe(
      true
    );
    // Every control is programmatically labelled (WCAG 2.1 AA).
    bar.querySelectorAll('select, input').forEach((ctrl) => {
      const id = (ctrl as HTMLElement).id;
      expect(id).not.toBe('');
      expect(bar.querySelector('label[for="' + id + '"]')).not.toBeNull();
    });
  });

  it('re-queries with targetType=collection when the target-type filter is used', async () => {
    const apiFetch = vi.fn().mockResolvedValue(page(makeEntries()));
    const table = createAuditTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await vi.waitFor(() =>
      expect(table.el.querySelectorAll('tbody tr[data-row-key]').length).toBe(3)
    );

    const sel = table.el.querySelector('#audit-filter-target-type') as HTMLSelectElement;
    sel.value = 'collection';
    sel.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      const url = apiFetch.mock.calls[apiFetch.mock.calls.length - 1][0] as string;
      expect(url).toContain('targetType=collection');
    });
    // The chosen control no longer reads as unset.
    expect(sel.classList.contains('is-unset')).toBe(false);
  });

  it('re-queries with origin=system when the origin filter is used', async () => {
    const apiFetch = vi.fn().mockResolvedValue(page(makeEntries()));
    const table = createAuditTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());

    const sel = table.el.querySelector('#audit-filter-origin') as HTMLSelectElement;
    sel.value = 'system';
    sel.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      const url = apiFetch.mock.calls[apiFetch.mock.calls.length - 1][0] as string;
      expect(url).toContain('origin=system');
    });
  });

  it('re-queries with the date range when From is set', async () => {
    const apiFetch = vi.fn().mockResolvedValue(page(makeEntries()));
    const table = createAuditTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());

    const from = table.el.querySelector('#audit-filter-from') as HTMLInputElement;
    from.value = '2026-09-01';
    from.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      const url = apiFetch.mock.calls[apiFetch.mock.calls.length - 1][0] as string;
      expect(url).toContain('from=2026-09-01T00%3A00%3A00.000Z');
    });
  });

  it('pages on the server total with offset, not a client-side window', async () => {
    const apiFetch = vi.fn().mockResolvedValue(page(makeEntries(), 120));
    const table = createAuditTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await vi.waitFor(() =>
      expect(table.el.querySelectorAll('tbody tr[data-row-key]').length).toBe(3)
    );

    const nextBtn = table.el.querySelector('.ops-table-next') as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(false);
    nextBtn.click();

    await vi.waitFor(() => {
      const url = apiFetch.mock.calls[apiFetch.mock.calls.length - 1][0] as string;
      expect(url).toContain('offset=' + AUDIT_PAGE_SIZE);
    });
  });

  it('reports a failed load on the table rather than silently blanking', async () => {
    const apiFetch = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    const table = createAuditTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await vi.waitFor(() =>
      expect(table.el.querySelector('.ops-table-error')?.textContent).toContain('HTTP 500')
    );
  });

  it('reconstructs filters from the URL and reflects a change back into it', async () => {
    const history = { replaceState: vi.fn(), pushState: vi.fn(), state: null };
    const win = {
      location: {
        search: '?audit.targetType=collection&audit.origin=user&audit.from=2026-09-01',
        pathname: '/',
        hash: '',
      },
      history,
    } as unknown as Window;
    const apiFetch = vi.fn().mockResolvedValue(page(makeEntries()));
    const table = createAuditTable({ apiFetch, fmtDate: (v: string) => v, win });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());

    const snap = table.state.getState();
    expect(snap.filters.targetType).toBe('collection');
    expect(snap.filters.origin).toBe('user');
    expect(snap.filters.from).toBe('2026-09-01');

    const url = apiFetch.mock.calls[apiFetch.mock.calls.length - 1][0] as string;
    expect(url).toContain('targetType=collection');
    expect(url).toContain('origin=user');

    // The audit-specific keys round-trip alongside the shared contract's keys.
    const applied = String(history.replaceState.mock.calls.at(-1)![2]);
    expect(applied).toContain('audit.targetType=collection');
    expect(applied).toContain('audit.origin=user');
    expect(applied).toContain('audit.from=2026-09-01');
  });

  it('never restores a targetId that has no targetType (unsendable state)', async () => {
    const win = {
      location: { search: '?audit.targetId=asset-7', pathname: '/', hash: '' },
      history: { replaceState: vi.fn(), pushState: vi.fn(), state: null },
    } as unknown as Window;
    const apiFetch = vi.fn().mockResolvedValue(page([]));
    const table = createAuditTable({ apiFetch, win });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(table.state.getState().filters.targetId).toBeUndefined();
    expect(apiFetch.mock.calls[0][0] as string).not.toContain('targetId');
  });

  it('requires an apiFetch rather than guessing a transport', () => {
    expect(() => createAuditTable({} as never)).toThrow(/apiFetch/);
  });
});

// ─── Tab routing (the allowlist the tab was missing) ─────────────────────────

describe('the Audit tab is routable', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(page(makeEntries(), 3)))
    );
  });

  it("is in the TABS allowlist, is rendered by index.html, and has a renderer", () => {
    expect(TABS).toContain('audit');
    expect(indexTabBarHtml()).toContain('data-tab="audit"');
    expect(typeof TAB_RENDERERS['audit']).toBe('function');
  });

  it('leaves the startup wiring audit clean', () => {
    mountOpsShell();
    expect(auditTabWiring(document)).toEqual([]);
  });

  it('renders the Audit view and loads GET /api/v1/audit when clicked', async () => {
    mountOpsShell();
    setupTabs();
    const btn = document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="audit"]')!;
    btn.click();

    const content = document.getElementById('content')!;
    expect(content.querySelector('.section-title')!.textContent).toBe('Audit');
    expect(content.querySelector('#audit-refresh')).not.toBeNull();
    expect(content.querySelector('table')).not.toBeNull();
    expect(localStorage.getItem(TAB_KEY)).toBe('audit');

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/audit?');

    // And the collection deletion is on screen.
    await vi.waitFor(() => expect(content.textContent).toContain('collection.deleted'));
  });

  it('re-queries when Refresh is pressed', async () => {
    mountOpsShell();
    setupTabs();
    document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="audit"]')!.click();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await vi.waitFor(() =>
      expect(document.getElementById('content')!.textContent).toContain('job.failed')
    );

    const before = fetchMock.mock.calls.length;
    document.querySelector<HTMLButtonElement>('#audit-refresh')!.click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('/api/v1/audit?');
  });
});
