// @vitest-environment happy-dom
//
// Unit tests for the logs table wiring (issue #371, parent #366).
//
// public/logs-table.js composes the ALREADY-MERGED shared primitives — the ops
// table primitive (public/ops-ui-table.js, #367) in CURSOR paging mode and the
// URL-state contract (public/table-url-state.js, #368) — for the logs surface.
// It does NOT reinvent a table, sort, filter, or URL-state mechanism.
//
// ─── Contract grounding (verified before any query param was written) ─────────
// GET /api/v1/logs/ (openapi.json .paths["/api/v1/logs/"].get):
//   query params: limit (1..200, default 50), cursor (string), from/to
//     (date-time), q (string), order (enum asc|desc, default desc).
//   response 200 envelope: { items: LogRecord[], nextCursor: string|null }.
//   LogRecord: { seq:int (req), timestamp:string (req), message:string (req),
//     level?: enum debug|info|warn|error, category?: string }.
// The endpoint is cursor/sequence-only (NO offset/page param) and has NO
// server-side level/category filter — so those are display-only columns.
// These tests exercise the pure query builder plus the composition (single
// cursor network path, nextCursor -> Next, order toggle, URL round-trip).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLogsTable,
  buildLogsQuery,
  isUnfilteredFirstPage,
  LOGS_COPY,
  LOGS_NS,
  LOGS_PAGE_SIZE,
  LOGS_LIMIT_MAX,
  LOG_LEVELS,
  SORT_KEY_TIMESTAMP,
} from '../public/logs-table.js';

// A small deterministic fixture spanning levels + categories + times.
function makeLogs() {
  return [
    { seq: 5, timestamp: '2026-01-05T10:00:00.000Z', message: 'transcode started', level: 'info', category: 'jobs' },
    { seq: 4, timestamp: '2026-01-04T10:00:00.000Z', message: 'disk pressure high', level: 'warn', category: 'storage' },
    { seq: 3, timestamp: '2026-01-03T10:00:00.000Z', message: 'ingest failed: 500', level: 'error', category: 'ingest' },
    // A record WITHOUT the optional level/category fields (must still render).
    { seq: 2, timestamp: '2026-01-02T10:00:00.000Z', message: 'heartbeat ok' },
    { seq: 1, timestamp: '2026-01-01T10:00:00.000Z', message: 'boot complete', level: 'debug', category: 'system' },
  ];
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ─── contract-grounded constants ─────────────────────────────────────────────

describe('contract constants', () => {
  it('uses the logs namespace and a bounded, visible page size within the limit ceiling', () => {
    expect(LOGS_NS).toBe('logs');
    expect(LOGS_PAGE_SIZE).toBe(50); // matches the endpoint default
    expect(LOGS_LIMIT_MAX).toBe(200); // matches the endpoint's limit maximum
    expect(LOGS_PAGE_SIZE).toBeLessThanOrEqual(LOGS_LIMIT_MAX);
  });
  it('exposes the exact level enum from the LogRecord schema', () => {
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error']);
  });
  it('sorts on the timestamp axis (the only ordered field the endpoint exposes)', () => {
    expect(SORT_KEY_TIMESTAMP).toBe('timestamp');
  });
});

// ─── pure query builder: only the verified params, cursor-not-offset ──────────

describe('buildLogsQuery', () => {
  it('emits a bounded limit and the default newest-first order, no cursor on page 1', () => {
    const p = buildLogsQuery({ pageSize: LOGS_PAGE_SIZE, sort: { columnKey: 'timestamp', direction: 'desc' }, filters: {} });
    expect(p.get('limit')).toBe(String(LOGS_PAGE_SIZE));
    expect(p.get('order')).toBe('desc');
    expect(p.get('cursor')).toBeNull();
    // Never an offset/page param — cursor-only endpoint.
    expect(p.toString()).not.toMatch(/offset=|page=/);
  });

  it('clamps an over-large limit down to the endpoint maximum (200)', () => {
    expect(buildLogsQuery({ pageSize: 9999, filters: {} }).get('limit')).toBe(String(LOGS_LIMIT_MAX));
  });

  it('falls back to the default page size for a non-positive / invalid size', () => {
    // The URL contract already clamps size to >= 1, so a 0/NaN here is a
    // defensive path; it degrades to the bounded default rather than 0.
    expect(buildLogsQuery({ pageSize: 0, filters: {} }).get('limit')).toBe(String(LOGS_PAGE_SIZE));
    expect(buildLogsQuery({ filters: {} }).get('limit')).toBe(String(LOGS_PAGE_SIZE));
  });

  it('maps a timestamp ASC sort onto order=asc (reverses newest-first)', () => {
    const p = buildLogsQuery({ pageSize: 50, sort: { columnKey: 'timestamp', direction: 'asc' }, filters: {} });
    expect(p.get('order')).toBe('asc');
  });

  it('passes an opaque cursor through when present', () => {
    const p = buildLogsQuery({ pageSize: 50, cursor: 'opaque-123', filters: {} });
    expect(p.get('cursor')).toBe('opaque-123');
  });

  it('widens bare date-range inputs to inclusive start/end-of-day ISO bounds', () => {
    const p = buildLogsQuery({ pageSize: 50, filters: { from: '2026-01-02', to: '2026-01-04' } });
    expect(p.get('from')).toBe('2026-01-02T00:00:00.000Z');
    expect(p.get('to')).toBe('2026-01-04T23:59:59.999Z');
  });

  it('passes a full ISO date-time range through unchanged', () => {
    const p = buildLogsQuery({ pageSize: 50, filters: { from: '2026-01-02T08:30:00.000Z', to: '2026-01-04T12:00:00.000Z' } });
    expect(p.get('from')).toBe('2026-01-02T08:30:00.000Z');
    expect(p.get('to')).toBe('2026-01-04T12:00:00.000Z');
  });

  it('emits a trimmed free-text message query as q', () => {
    const p = buildLogsQuery({ pageSize: 50, filters: { q: '  disk pressure  ' } });
    expect(p.get('q')).toBe('disk pressure');
  });

  it('never emits an invented level or category server param', () => {
    const p = buildLogsQuery({ pageSize: 50, filters: { level: 'error', category: 'ingest' } });
    expect(p.get('level')).toBeNull();
    expect(p.get('category')).toBeNull();
  });
});

// ─── composition: single cursor network path + URL round-trip ─────────────────

describe('createLogsTable composition', () => {
  it('fetches ONLY the cursor-paged logs path (limit + order, no offset)', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeLogs(), nextCursor: null });
    const table = createLogsTable({ apiFetch, win: null });
    await table.reload();
    // The subscribe-driven initial reload + explicit reload may fire; assert the
    // shape of the path rather than an exact call count.
    const url = apiFetch.mock.calls[apiFetch.mock.calls.length - 1][0] as string;
    expect(url).toMatch(/^\/logs\?/);
    expect(url).toContain('limit=' + LOGS_PAGE_SIZE);
    expect(url).toContain('order=desc');
    expect(url).not.toMatch(/offset=|page=/);
  });

  it('renders every record, including one missing the optional level/category', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeLogs(), nextCursor: null });
    const table = createLogsTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await table.reload();
    const rows = table.el.querySelectorAll('tbody tr[data-row-key]');
    expect(rows.length).toBe(5);
    // The level-less record (seq 2) still renders; its level cell degrades to '—'.
    const seq2 = table.el.querySelector('tbody tr[data-row-key="2"]');
    expect(seq2).not.toBeNull();
    expect(seq2?.textContent).toContain('heartbeat ok');
  });

  it('enables Next when the backend returns a nextCursor and advances with it', async () => {
    const apiFetch = vi
      .fn()
      .mockResolvedValueOnce({ items: makeLogs().slice(0, 2), nextCursor: 'cur-1' })
      .mockResolvedValueOnce({ items: makeLogs().slice(2, 4), nextCursor: null });
    const table = createLogsTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await table.reload();
    const nextBtn = table.el.querySelector('.ops-table-next') as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(false);
    // Advance: the primitive stores cur-1 and the next fetch must carry it.
    table.state.nextPage();
    await Promise.resolve();
    await Promise.resolve();
    const lastUrl = apiFetch.mock.calls[apiFetch.mock.calls.length - 1][0] as string;
    expect(lastUrl).toContain('cursor=cur-1');
  });

  it('disables Next on the last page (nextCursor === null)', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeLogs(), nextCursor: null });
    const table = createLogsTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await table.reload();
    const nextBtn = table.el.querySelector('.ops-table-next') as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
  });

  it('reconstructs order + message + range state from the URL via the shared contract', async () => {
    const win = {
      location: { search: '?logs.sort=timestamp&logs.q=disk&logs.from=2026-01-02', pathname: '/', hash: '' },
      history: { replaceState: vi.fn(), pushState: vi.fn(), state: null },
    } as unknown as Window;
    const apiFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const table = createLogsTable({ apiFetch, win });
    await table.reload();
    const snap = table.state.getState();
    // `logs.sort=timestamp` (no leading '-') decodes to ascending order.
    expect(snap.sort).toEqual({ columnKey: 'timestamp', direction: 'asc' });
    expect(snap.filters.q).toBe('disk');
    expect(snap.filters.from).toBe('2026-01-02');
    // And the request reflects that reconstructed state.
    const url = apiFetch.mock.calls[apiFetch.mock.calls.length - 1][0] as string;
    expect(url).toContain('order=asc');
    expect(url).toContain('q=disk');
    expect(url).toContain('from=2026-01-02T00%3A00%3A00.000Z');
  });

  it('reflects a user message filter change back into the URL (namespaced)', async () => {
    const replaceState = vi.fn();
    const win = {
      location: { search: '', pathname: '/', hash: '' },
      history: { replaceState, pushState: vi.fn(), state: null },
    } as unknown as Window;
    const apiFetch = vi.fn().mockResolvedValue({ items: makeLogs(), nextCursor: null });
    const table = createLogsTable({ apiFetch, win });
    await table.reload();
    table.state.setFilter('q', 'error');
    await Promise.resolve();
    await Promise.resolve();
    const lastUrl = replaceState.mock.calls[replaceState.mock.calls.length - 1][2] as string;
    expect(lastUrl).toContain('logs.q=error');
  });

  it('honours a deep-linked cursor from the URL on the first request', async () => {
    const win = {
      location: { search: '?logs.cursor=deep-cur', pathname: '/', hash: '' },
      history: { replaceState: vi.fn(), pushState: vi.fn(), state: null },
    } as unknown as Window;
    const apiFetch = vi.fn().mockResolvedValue({ items: makeLogs(), nextCursor: null });
    const table = createLogsTable({ apiFetch, win });
    await table.reload();
    const firstUrl = apiFetch.mock.calls[0][0] as string;
    expect(firstUrl).toContain('cursor=deep-cur');
  });

  it('surfaces a fetch error through the shared error state', async () => {
    const apiFetch = vi.fn().mockRejectedValue(new Error('boom'));
    const table = createLogsTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await table.reload();
    const errRow = table.el.querySelector('tr.ops-table-error td');
    expect(errRow?.textContent).toContain('boom');
  });

  it('requires an apiFetch dependency', () => {
    expect(() => createLogsTable({} as never)).toThrow(/apiFetch/);
  });
});

// ─── the two empty states (issue #997) ───────────────────────────────────────
//
// GET /api/v1/logs returns `{ items: [], nextCursor: null }` both when the store
// has never been written to and when the filters match nothing, and the endpoint
// exposes no "has ever been written" flag. The distinction is derived from the
// reads it already answers: retention is count-based only (oldest-first eviction
// at LOG_STORE_MAX_RECORDS, src/services/log-store.ts:143/:347 and
// src/data/couch-log-repo.ts:157-164), so an UNFILTERED first page returning zero
// items proves the store never received a write.

async function settle(table: { reload: () => Promise<void> }) {
  await table.reload();
  await Promise.resolve();
  await Promise.resolve();
}

function emptyCell(el: HTMLElement) {
  return el.querySelector('tr.ops-table-empty td');
}

describe('createLogsTable empty states (issue #997)', () => {
  it('explains an unfiltered, never-written store instead of showing a no-results message', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const table = createLogsTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await settle(table);

    const cell = emptyCell(table.el)!;
    expect(cell.getAttribute('data-empty')).toBe(LOGS_COPY.emptyNeverWrittenKind);
    // Headline says the store is empty — never that a filter excluded anything.
    expect(cell.firstChild?.textContent).toBe(LOGS_COPY.emptyNeverWritten);
    expect(cell.textContent).not.toContain(LOGS_COPY.emptyFiltered);
    // And a detail line says why, and what makes entries appear.
    const detail = cell.querySelector('.ops-table-empty-detail')!;
    expect(detail.textContent).toBe(LOGS_COPY.emptyNeverWrittenDetail);
  });

  it('shows the ordinary no-results message when a filtered page comes back empty', async () => {
    const win = {
      location: { search: '?logs.q=nothing-matches-this', pathname: '/', hash: '' },
      history: { replaceState: vi.fn(), pushState: vi.fn(), state: null },
    } as unknown as Window;
    const apiFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const table = createLogsTable({ apiFetch, win });
    document.body.appendChild(table.el);
    await settle(table);

    const cell = emptyCell(table.el)!;
    // A filtered empty page proves nothing about the store, so it must NOT be
    // promoted to the explanatory state.
    expect(cell.getAttribute('data-empty')).toBe(LOGS_COPY.emptyFilteredKind);
    expect(cell.textContent).toBe(LOGS_COPY.emptyFiltered);
    expect(cell.querySelector('.ops-table-empty-detail')).toBeNull();
  });

  it('keeps the ordinary no-results message once real entries have been seen', async () => {
    const apiFetch = vi
      .fn()
      .mockResolvedValueOnce({ items: makeLogs(), nextCursor: null })
      .mockResolvedValue({ items: [], nextCursor: null });
    const win = {
      location: { search: '', pathname: '/', hash: '' },
      history: { replaceState: vi.fn(), pushState: vi.fn(), state: null },
    } as unknown as Window;
    const table = createLogsTable({ apiFetch, win });
    document.body.appendChild(table.el);
    await settle(table);
    expect(table.el.querySelectorAll('tbody tr[data-row-key]').length).toBe(5);

    // Filter down to nothing: entries provably exist, so this is a plain
    // no-results state, not the never-written one.
    table.state.setFilter('q', 'no-such-message');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const cell = emptyCell(table.el)!;
    expect(cell.getAttribute('data-empty')).toBe(LOGS_COPY.emptyFilteredKind);
    expect(cell.textContent).toBe(LOGS_COPY.emptyFiltered);
  });

  it('keeps the two empty states textually and structurally distinct', () => {
    expect(LOGS_COPY.emptyNeverWritten).not.toBe(LOGS_COPY.emptyFiltered);
    expect(LOGS_COPY.emptyNeverWrittenKind).not.toBe(LOGS_COPY.emptyFilteredKind);
    // The never-written copy must not blame the filters…
    expect(LOGS_COPY.emptyNeverWritten.toLowerCase()).not.toContain('filter');
    // …and the ordinary one must not claim nothing was ever recorded.
    expect(LOGS_COPY.emptyFiltered.toLowerCase()).toContain('filter');
  });
});

describe('isUnfilteredFirstPage', () => {
  it('is true for the newest page of the whole store, whatever the order', () => {
    expect(isUnfilteredFirstPage({ filters: {} })).toBe(true);
    expect(isUnfilteredFirstPage({ filters: { from: '', to: '', q: '  ' }, cursor: null })).toBe(true);
    expect(isUnfilteredFirstPage({ filters: {}, sort: { columnKey: 'timestamp', direction: 'asc' } })).toBe(true);
  });

  it('is false once any server-side filter or a cursor narrows the read', () => {
    expect(isUnfilteredFirstPage({ filters: { q: 'ingest' } })).toBe(false);
    expect(isUnfilteredFirstPage({ filters: { from: '2026-01-01' } })).toBe(false);
    expect(isUnfilteredFirstPage({ filters: { to: '2026-01-01' } })).toBe(false);
    expect(isUnfilteredFirstPage({ filters: {}, cursor: 'opaque-1' })).toBe(false);
  });

  it('tolerates a missing/garbage snapshot', () => {
    expect(isUnfilteredFirstPage(undefined)).toBe(true);
    expect(isUnfilteredFirstPage({})).toBe(true);
  });
});

// ─── The Logs bar is typeset by the SAME rules as the other bars (issue #983) ──
//
// CONTRACT GROUNDING — markers read off their source, not assumed:
//   - the caption hook: `span.className = 'ops-filter-caption'` in
//     labelledControl(), public/logs-table.js:267. Logs captions are <span>s
//     inside the control's <label>; the Jobs bar uses a bare
//     `.ops-filter-label` instead, which is why the shared rule names both.
//   - the bar: `filterBar.className = 'ops-table-filters'`
//     (public/ops-ui-table.js:414) — every selector below is scoped to it.
//   - the controls: `input.type = 'date'` in dateFilterControl() and
//     `input.type = 'search'` in searchFilterControl() (public/logs-table.js).
//     Neither carries a class, so they are reached by the type-qualified
//     selectors — the exact reason those selectors exist in the sheet.
//   - the rules, public/style.css:3050-3053, :3075-3078 and :2929-2932:
//     caption 11px/uppercase; `.ops-table-filters select, .ops-table-filters
//     input { font-size: 13px }`; `.ops-filter-search::placeholder,
//     .ops-table-filters input[type='search']::placeholder
//      { color: var(--text-muted); opacity: 1 }`
//   - the muted token: `--text-muted: #94a3b8`, public/style.css:6.
describe('the Logs filter bar resolves against the real stylesheet', () => {
  const STYLESHEET = readFileSync(resolve(process.cwd(), 'public/style.css'), 'utf8');

  function withStylesheet(): { drop: () => void; sheet: CSSStyleSheet } {
    const style = document.createElement('style');
    style.textContent = STYLESHEET;
    document.head.appendChild(style);
    return { drop: () => style.remove(), sheet: style.sheet as CSSStyleSheet };
  }

  function mountStyled() {
    const styled = withStylesheet();
    const table = createLogsTable({
      apiFetch: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      win: null,
    });
    document.body.appendChild(table.el);
    return { table, ...styled };
  }

  it('typesets the Logs captions at the bar caption size, uppercased', () => {
    const { table, drop } = mountStyled();
    try {
      const captions = table.el.querySelectorAll<HTMLElement>(
        '.ops-table-filters .ops-filter-caption',
      );
      // From + To + Message.
      expect(captions.length).toBeGreaterThanOrEqual(3);
      for (const caption of captions) {
        expect(caption.tagName).toBe('SPAN');
        const s = getComputedStyle(caption);
        expect(s.fontSize).toBe('11px');
        expect(s.textTransform).toBe('uppercase');
      }
    } finally {
      drop();
    }
  });

  it('typesets every Logs date/search control at the same 13px as the other bars', () => {
    const { table, drop } = mountStyled();
    try {
      const from = table.el.querySelector<HTMLElement>('.ops-filter-from input')!;
      const to = table.el.querySelector<HTMLElement>('.ops-filter-to input')!;
      const search = table.el.querySelector<HTMLElement>('.ops-filter-q input')!;
      for (const control of [from, to, search]) {
        expect(control).toBeTruthy();
        expect(control.closest('.ops-table-filters')).toBeTruthy();
        // The regression: these inherited their caption <label>'s 12px, so the
        // Logs controls rendered visibly smaller than the Jobs ones.
        expect(getComputedStyle(control).fontSize).toBe('13px');
      }
    } finally {
      drop();
    }
  });

  it('mutes the Logs search placeholder, which matched no ::placeholder rule before', () => {
    const { table, drop, sheet } = mountStyled();
    try {
      const search = table.el.querySelector<HTMLInputElement>('.ops-filter-q input')!;
      expect(search.type).toBe('search');
      expect(search.placeholder.length).toBeGreaterThan(0);
      expect(search.className).toBe(''); // reached by type, not by class

      // happy-dom does not resolve ::placeholder — getComputedStyle(el,
      // '::placeholder') reports the INPUT's own colour — so the assertion is
      // made against the real sheet's CSSOM instead: find every authored
      // ::placeholder rule, and require that one of them both matches this input
      // and paints it with the muted token.
      const placeholderRules = Array.from(sheet.cssRules)
        .filter((r): r is CSSStyleRule => 'selectorText' in r)
        .filter((r) => r.selectorText.includes('::placeholder'));
      expect(placeholderRules.length).toBeGreaterThan(0);

      const muted = getComputedStyle(document.documentElement)
        .getPropertyValue('--text-muted')
        .trim();
      expect(muted).toBe('#94a3b8');

      const hit = placeholderRules.find((r) =>
        r.selectorText
          .split(',')
          .map((s) => s.trim().replace(/::placeholder$/, ''))
          .some((base) => base.length > 0 && search.matches(base)),
      );
      expect(hit).toBeTruthy();
      expect(hit!.style.color).toBe('var(--text-muted)');
      // Firefox dims placeholders by default; the rule pins it back.
      expect(hit!.style.opacity).toBe('1');
    } finally {
      drop();
    }
  });
});

// ─── Unset Logs date boxes read as unset, exactly like the Jobs ones (#983) ────
//
// The Jobs-side seam is asserted at test/jobs-table.test.ts:398-400; these are
// the Logs equivalents for the wireUnset() call site at public/logs-table.js:290.
// CONTRACT GROUNDING: `wireUnset(input)` (public/filter-unset.js, imported at
// public/logs-table.js:107) toggles `.is-unset` on an empty control, and
// `.ops-table-filters input[type='date'].is-unset` in public/style.css mutes the
// UA's yyyy-mm-dd hint. Logs has no <select> in its bar, so the two date boxes
// are its only placeholder-less controls. No stylesheet needed: happy-dom does
// not resolve the UA date hint, so the DOM marker IS the testable seam.
describe('unset Logs date boxes are marked muted', () => {
  function dates(el: HTMLElement) {
    return {
      from: el.querySelector<HTMLInputElement>('.ops-filter-from input')!,
      to: el.querySelector<HTMLInputElement>('.ops-filter-to input')!,
    };
  }

  it('marks both date inputs unset on first render', () => {
    const table = createLogsTable({
      apiFetch: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      win: null,
    });
    document.body.appendChild(table.el);
    const d = dates(table.el);
    expect(d.from.type).toBe('date');
    expect(d.from.value).toBe('');
    expect(d.from.classList.contains('is-unset')).toBe(true);
    expect(d.to.value).toBe('');
    expect(d.to.classList.contains('is-unset')).toBe(true);
  });

  it('does NOT mark the date boxes unset when the URL state already carries a range', () => {
    const win = {
      location: { search: '?logs.from=2026-01-02&logs.to=2026-01-04', pathname: '/', hash: '' },
      history: { replaceState: vi.fn(), pushState: vi.fn(), state: null },
    } as unknown as Window;
    const table = createLogsTable({
      apiFetch: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      win,
    });
    document.body.appendChild(table.el);
    const d = dates(table.el);
    expect(d.from.value).toBe('2026-01-02');
    expect(d.from.classList.contains('is-unset')).toBe(false);
    expect(d.to.value).toBe('2026-01-04');
    expect(d.to.classList.contains('is-unset')).toBe(false);
  });

  it('drops the marker as soon as a date is picked, and restores it when cleared', () => {
    const table = createLogsTable({
      apiFetch: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      win: null,
    });
    document.body.appendChild(table.el);
    const { from } = dates(table.el);
    expect(from.classList.contains('is-unset')).toBe(true);
    from.value = '2026-01-03';
    from.dispatchEvent(new Event('change', { bubbles: true }));
    expect(from.classList.contains('is-unset')).toBe(false);
    from.value = '';
    from.dispatchEvent(new Event('change', { bubbles: true }));
    expect(from.classList.contains('is-unset')).toBe(true);
  });
});

// Appended with the describe blocks above: ESM imports are hoisted, so this sits
// next to the tests that need it rather than disturbing the import block at the
// top of this file.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
