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
