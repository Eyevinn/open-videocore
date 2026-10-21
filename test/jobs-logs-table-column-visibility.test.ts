// @vitest-environment happy-dom
//
// Column visibility on the JOBS and LOGS tables (issue #960, broken out of #856,
// lifted from the assets table's #959 — whose own coverage lives in
// test/assets-table-column-visibility.test.ts and is not repeated here).
//
// WHAT IS UNDER TEST — the wiring #960 added, not the model #959 already proved:
//   public/ops-ui-table.js   createColumnVisibility() (the precedence rule, the
//                            storage write, the undeclared-lock-key warning) and
//                            the `onRowsRendered` repaint hook.
//   public/jobs-table.js     JOBS_COLUMN_KEYS, JOBS_REQUIRED_COLUMN_GROUPS, the
//                            chooser slot, and wireRowInteractions() moved onto
//                            `onRowsRendered` (public/jobs-table.js:601).
//   public/logs-table.js     LOGS_COLUMN_KEYS, the `hideable: false` pin on
//                            `message`, LOGS_REQUIRED_COLUMN_GROUPS, and the
//                            `urlCursor` tracking variable
//                            (public/logs-table.js:519) that keeps a deep-linked
//                            cursor alive across a chooser-initiated syncUrl().
//
// ─── CONTRACT GROUNDING ──────────────────────────────────────────────────────
// Column visibility is VIEW state: it changes what is painted, never what is
// requested, so the feature itself has no backend contract to fetch. The
// contracts that ARE load-bearing are the two requests these tests assert stay
// UNCHANGED under a column toggle, and both were read out of this repo's
// openapi.json rather than assumed (neither GET carries an `operationId` in the
// spec, so each is cited by path + method):
//
//   GET /api/v1/jobs/  — openapi.json .paths["/api/v1/jobs/"].get
//     parameters: limit (number), offset (number) — and NOTHING else, which is
//       why the table pages a bounded window and filters client-side.
//     responses["200"] schema: { items, total }, both required.
//     items.items required: id, type, status, assetId, sourceUrl, progress,
//       bytesTransferred, attempts, createdAt, updatedAt — the fixture below
//       carries every one of them (assetName is optional; see #988).
//
//   GET /api/v1/logs/  — openapi.json .paths["/api/v1/logs/"].get
//     parameters: limit (integer), cursor (string), from (string), to (string),
//       q (string), order (string enum asc|desc).
//     responses["200"] schema: { items, nextCursor }, both required.
//     items.items required: seq, timestamp, message; level and category optional.
//
// Internal contracts, each verified against its source rather than guessed:
//   - the `cols` / `cursor` / `page` URL params and the "null means unspecified"
//     rule: PARAM_KEYS / BASE_DEFAULTS in public/table-url-state.js:72-105.
//   - the chooser's mount point and markup: the `.ops-columns-slot` append in
//     renderFilters() (public/ops-ui-table.js:663-673) and createColumnChooser()
//     in public/table-columns.js:474-717.
//   - the copy-button wiring marker `data-copy-id-wired`:
//     wireCopyIdButtons() in public/copy-id.js:171-179.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createJobsTable,
  JOBS_COLUMN_KEYS,
  JOBS_NS,
  JOBS_PAGE_SIZE,
  JOBS_REQUIRED_COLUMN_GROUPS,
} from '../public/jobs-table.js';
import {
  createLogsTable,
  LOGS_COLUMN_KEYS,
  LOGS_NS,
  LOGS_REQUIRED_COLUMN_GROUPS,
} from '../public/logs-table.js';
import { createColumnVisibility } from '../public/ops-ui-table.js';
import { undeclaredGroupKeys } from '../public/table-columns.js';
import { COPY_ID_BTN_CLASS } from '../public/copy-id.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Jobs that satisfy every REQUIRED property of the verified item schema. Statuses
// cycle so the fixture always contains a `running` row (the only state that
// renders a Cancel button — public/jobs-table.js:481-487).
function makeJobs(n = 3) {
  const statuses = ['running', 'done', 'failed'];
  return Array.from({ length: n }, (_, i) => {
    const num = String(i + 1).padStart(2, '0');
    return {
      id: 'job-' + num,
      type: 'transcode',
      status: statuses[i % statuses.length],
      assetId: '01J8Z3K4M5N6P7Q8R9S0T1V2W' + num,
      assetName: 'Asset ' + num,
      sourceUrl: 'https://example.invalid/in-' + num + '.mp4',
      progress: 10,
      bytesTransferred: 0,
      attempts: 0,
      // Descending createdAt so the table's natural order is job-01 first.
      createdAt: '2026-01-' + String(31 - i).padStart(2, '0') + 'T10:00:00.000Z',
      updatedAt: '2026-01-' + String(31 - i).padStart(2, '0') + 'T11:00:00.000Z',
    };
  });
}

// Log records: one with both optional fields, one with neither.
function makeLogs() {
  return [
    { seq: 3, timestamp: '2026-01-03T10:00:00.000Z', message: 'transcode started', level: 'info', category: 'jobs' },
    { seq: 2, timestamp: '2026-01-02T10:00:00.000Z', message: 'disk pressure high', level: 'warn', category: 'storage' },
    { seq: 1, timestamp: '2026-01-01T10:00:00.000Z', message: 'heartbeat ok' },
  ];
}

// A stub window: seedable location.search plus captured history writes, kept in
// step so a later syncUrl() merges into the URL the previous one produced (the
// same stub shape test/assets-table-column-visibility.test.ts uses). No
// localStorage property, so nothing in these tests reads or writes the real one.
function stubWin(search = '') {
  const applied: string[] = [];
  const win = {
    location: { search, pathname: '/', hash: '' },
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, url: string) => {
        applied.push(url);
        const q = url.indexOf('?');
        const h = url.indexOf('#');
        win.location.search = q >= 0 ? (h > q ? url.slice(q, h) : url.slice(q)) : '';
      },
      pushState: (_s: unknown, _t: string, url: string) => {
        applied.push(url);
      },
    },
    _applied: applied,
  };
  return win;
}

function lastParams(win: { _applied: string[] }): URLSearchParams {
  const last = win._applied[win._applied.length - 1];
  return new URL('http://x' + last).searchParams;
}

// The logs table self-loads on construction and re-fetches from a state emit, so
// a test has to let both the promise chain and the timer queue drain.
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function headerLabels(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim());
}

function chooserSlot(el: HTMLElement): HTMLElement {
  const slot = el.querySelector('.ops-table-filters .ops-columns-slot') as HTMLElement | null;
  if (!slot) throw new Error('no column chooser slot in the filter bar');
  return slot;
}

function toggleFor(el: HTMLElement, key: string): HTMLInputElement {
  const cb = el.querySelector(
    '.ops-columns-item[data-column="' + key + '"] input'
  ) as HTMLInputElement | null;
  if (!cb) throw new Error('no chooser toggle for column ' + key);
  return cb;
}

function itemFor(el: HTMLElement, key: string): HTMLElement {
  const item = el.querySelector('.ops-columns-item[data-column="' + key + '"]') as HTMLElement | null;
  if (!item) throw new Error('no chooser row for column ' + key);
  return item;
}

// Drive a toggle the way an operator does: set .checked, then dispatch.
function setColumn(el: HTMLElement, key: string, visible: boolean) {
  const cb = toggleFor(el, key);
  cb.checked = visible;
  cb.dispatchEvent(new Event('change'));
}

function rowsOf(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll('tbody tr[data-row-key]')) as HTMLElement[];
}

function jobsDeps(apiFetch: unknown, extra: Record<string, unknown> = {}) {
  return {
    apiFetch,
    fmtDate: (v: string) => String(v || '—'),
    renderBadge: (s: string) => '<span class="badge">' + s + '</span>',
    ...extra,
  } as never;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── 1. The chooser is mounted on both tables ────────────────────────────────

describe('the chooser reaches the jobs and logs filter bars', () => {
  it('declares the jobs column vocabulary the URL param and the panel both use', () => {
    // Stated literally so a reorder or a rename has to say so here. The list is
    // derived from buildColumns() via columnKeysOf(), so this is the declaration
    // itself, not a second copy of it.
    expect([...JOBS_COLUMN_KEYS]).toEqual([
      'id',
      'type',
      'status',
      'assetId',
      'progress',
      'createdAt',
      'updatedAt',
      'actions',
    ]);
    expect([...LOGS_COLUMN_KEYS]).toEqual(['timestamp', 'level', 'category', 'message', 'seq']);
  });

  it('mounts a Columns control in the jobs filter bar, as a view control not a filter', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeJobs(), total: 3 });
    const t = createJobsTable(jobsDeps(apiFetch, { win: null }));
    document.body.appendChild(t.el);
    await t.refresh();

    const slot = chooserSlot(t.el);
    // Marked as a view control and kept OUT of the `filters` array, which is what
    // keeps it out of state.setFilter() and therefore out of the paging reset.
    expect(slot.dataset.control).toBe('columns');
    expect(slot.dataset.filter).toBeUndefined();
    // Last in the bar, after the status/from/to/search slots.
    expect(slot.parentElement?.lastElementChild).toBe(slot);

    const btn = slot.querySelector('.ops-columns-btn') as HTMLButtonElement;
    expect(btn.textContent).toContain('Columns');
    // Jobs declares nothing `defaultVisible: false`, so every column is on.
    expect(btn.textContent).toContain(
      JOBS_COLUMN_KEYS.length + ' of ' + JOBS_COLUMN_KEYS.length
    );
    expect(t.getVisibleColumns()).toEqual([...JOBS_COLUMN_KEYS]);
    // Every declared column is pickable, including Actions, whose header caption
    // is empty and which therefore names itself via `chooserLabel`.
    for (const key of JOBS_COLUMN_KEYS) {
      expect(() => toggleFor(t.el, key)).not.toThrow();
    }
    expect(itemFor(t.el, 'actions').querySelector('.ops-columns-item-label')?.textContent).toBe(
      'Actions'
    );
  });

  it('mounts a Columns control in the logs filter bar', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeLogs(), nextCursor: null });
    const t = createLogsTable({ apiFetch, win: null } as never);
    document.body.appendChild(t.el);
    await flush();

    const slot = chooserSlot(t.el);
    expect(slot.dataset.control).toBe('columns');
    expect(slot.dataset.filter).toBeUndefined();
    const btn = slot.querySelector('.ops-columns-btn') as HTMLButtonElement;
    expect(btn.textContent).toContain('Columns');
    expect(btn.textContent).toContain(
      LOGS_COLUMN_KEYS.length + ' of ' + LOGS_COLUMN_KEYS.length
    );
    expect(t.getVisibleColumns()).toEqual([...LOGS_COLUMN_KEYS]);
    for (const key of LOGS_COLUMN_KEYS) {
      expect(() => toggleFor(t.el, key)).not.toThrow();
    }
  });

  it('hiding a jobs column drops its header and one cell from every row', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeJobs(), total: 3 });
    const t = createJobsTable(jobsDeps(apiFetch, { win: null }));
    document.body.appendChild(t.el);
    await t.refresh();

    expect(headerLabels(t.el)).toContain('Type');
    const widthBefore = rowsOf(t.el)[0].children.length;

    setColumn(t.el, 'type', false);

    expect(t.getVisibleColumns()).not.toContain('type');
    expect(headerLabels(t.el)).not.toContain('Type');
    const rows = rowsOf(t.el);
    expect(rows.length).toBe(3);
    expect(rows[0].children.length).toBe(widthBefore - 1);
    // The surviving cells still belong to the columns that are still declared —
    // nothing shifted onto the next column's renderer.
    expect(rows[0].textContent).toContain('job-01');
    expect(rows[0].querySelector('.badge')?.textContent).toBe('running');
  });

  it('hiding a logs column drops its header and one cell from every row', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeLogs(), nextCursor: null });
    const t = createLogsTable({ apiFetch, win: null } as never);
    document.body.appendChild(t.el);
    await flush();

    const widthBefore = rowsOf(t.el)[0].children.length;
    setColumn(t.el, 'category', false);

    expect(t.getVisibleColumns()).not.toContain('category');
    expect(headerLabels(t.el)).not.toContain('Category');
    const rows = rowsOf(t.el);
    expect(rows.length).toBe(3);
    expect(rows[0].children.length).toBe(widthBefore - 1);
    // The message is the point of a log line; it is still there (and still pinned).
    expect(rows[0].querySelector('.log-message')?.textContent).toBe('transcode started');
  });
});

// ─── 2. onRowsRendered: per-row wiring survives a repaint it did not cause ───
//
// Before #960 the jobs table wired its row interactions after a FETCH. A column
// toggle rebuilds the tbody without one (public/ops-ui-table.js:680-688 →
// renderBody → :799), so every handler would have been lost on the first hide —
// zero-wiring. Moving the wiring onto `onRowsRendered` (public/jobs-table.js:601)
// fixes that, and makes the opposite failure reachable too: a surviving
// wire-after-fetch call would attach each handler twice on a fetch-driven
// repaint. Both are why every assertion below counts calls rather than asserting
// "at least one".

describe('jobs row interactions re-attach on a column-toggle repaint, exactly once', () => {
  it('re-attaches the row-click handler, firing once per click', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeJobs(), total: 3 });
    const onSelect = vi.fn();
    const t = createJobsTable(jobsDeps(apiFetch, { onSelect, win: null }));
    document.body.appendChild(t.el);
    await t.refresh();

    // Baseline: one click, one call (a double-wired row would report two).
    rowsOf(t.el)[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith('job-01');

    // A toggle replaces every <tr>; the handler has to come back with them.
    setColumn(t.el, 'progress', false);
    const afterToggle = rowsOf(t.el);
    expect(afterToggle[1].dataset.rowKey).toBe('job-02');
    afterToggle[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith('job-02');

    // And again on the next toggle, so the hook is not a one-shot.
    setColumn(t.el, 'progress', true);
    rowsOf(t.el)[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it('re-attaches the Cancel handler, firing once per click', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeJobs(), total: 3 });
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const t = createJobsTable(jobsDeps(apiFetch, { onCancel, win: null }));
    document.body.appendChild(t.el);
    await t.refresh();

    // Only the `running` row renders a Cancel control.
    expect(t.el.querySelectorAll('.job-cancel-btn').length).toBe(1);

    setColumn(t.el, 'updatedAt', false);

    const btn = t.el.querySelector('.job-cancel-btn') as HTMLButtonElement;
    expect(btn.dataset.id).toBe('job-01');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith('job-01');
  });

  it('a Cancel click after a toggle does not also open the row detail panel', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeJobs(), total: 3 });
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const onSelect = vi.fn();
    const t = createJobsTable(jobsDeps(apiFetch, { onCancel, onSelect, win: null }));
    document.body.appendChild(t.el);
    await t.refresh();

    setColumn(t.el, 'type', false);
    (t.el.querySelector('.job-cancel-btn') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    await flush();

    expect(onCancel).toHaveBeenCalledTimes(1);
    // The handler stops propagation, so the row listener behind it stays silent.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('re-wires the Asset cell copy buttons, copying once per click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const apiFetch = vi.fn().mockResolvedValue({ items: makeJobs(1), total: 1 });
    const onSelect = vi.fn();
    const t = createJobsTable(jobsDeps(apiFetch, { onSelect, win: null }));
    document.body.appendChild(t.el);
    await t.refresh();

    setColumn(t.el, 'createdAt', false);

    const btn = t.el.querySelector('.' + COPY_ID_BTN_CLASS) as HTMLButtonElement;
    // wireCopyIdButtons() marks what it wired (public/copy-id.js:178-179); the
    // fresh button carries the mark, so the hook reached the new DOM.
    expect(btn.dataset.copyIdWired).toBe('1');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Exactly one write: the idempotence guard above is what makes a second
    // wiring pass harmless, and this is the assertion that proves it holds.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('01J8Z3K4M5N6P7Q8R9S0T1V2W01');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('brings the copy affordance back when the Asset column is hidden and shown again', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const apiFetch = vi.fn().mockResolvedValue({ items: makeJobs(1), total: 1 });
    const t = createJobsTable(jobsDeps(apiFetch, { win: null }));
    document.body.appendChild(t.el);
    await t.refresh();

    setColumn(t.el, 'assetId', false);
    expect(t.el.querySelector('.' + COPY_ID_BTN_CLASS)).toBeNull();

    setColumn(t.el, 'assetId', true);
    const btn = t.el.querySelector('.' + COPY_ID_BTN_CLASS) as HTMLButtonElement;
    expect(btn.dataset.copyIdWired).toBe('1');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});

// ─── 3. A toggle changes the view, never the request ─────────────────────────

describe('a column toggle does not touch paging or the request', () => {
  it('leaves the jobs page window and the bounded working-set fetch alone', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeJobs(25), total: 25 });
    const win = stubWin();
    const t = createJobsTable(jobsDeps(apiFetch, { win }));
    document.body.appendChild(t.el);
    await t.refresh();
    expect(apiFetch).toHaveBeenCalledTimes(1);

    // Page 2 of the client-paged window (JOBS_PAGE_SIZE = 20 of 25 rows).
    expect(t.table.state.nextPage()).toBe(true);
    await flush();
    expect(t.table.state.getState().offset).toBe(JOBS_PAGE_SIZE);
    expect(apiFetch).toHaveBeenCalledTimes(1);

    setColumn(t.el, 'type', false);
    setColumn(t.el, 'progress', false);
    await flush();

    // Every real filter resets paging through state.setFilter(); the chooser is
    // not a filter, and the bounded limit/offset request is byte-identical, so
    // re-issuing it would be a wasted round-trip and a loading flash.
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(t.table.state.getState().offset).toBe(JOBS_PAGE_SIZE);
    expect(rowsOf(t.el).length).toBe(5);

    // The URL records the new view and keeps the page the operator is on.
    const params = lastParams(win);
    expect(params.get(JOBS_NS + '.page')).toBe('2');
    expect(params.get(JOBS_NS + '.cols')).toBe(t.getVisibleColumns().join(','));
  });

  it('leaves the logs cursor request alone', async () => {
    const apiFetch = vi
      .fn()
      .mockResolvedValueOnce({ items: makeLogs(), nextCursor: 'cur-1' })
      .mockResolvedValue({ items: makeLogs(), nextCursor: null });
    const t = createLogsTable({ apiFetch, win: null } as never);
    document.body.appendChild(t.el);
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(1);

    // Walk one page forward so there is a cursor worth losing.
    expect(t.state.nextPage()).toBe(true);
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[1][0]).toContain('cursor=cur-1');
    const before = t.state.getState();

    setColumn(t.el, 'level', false);
    setColumn(t.el, 'category', false);
    await flush();

    // buildLogsQuery() reads pageSize / cursor / sort / filters only, so the
    // request would be byte-identical — and on a cursor table re-issuing it would
    // repaint a page the operator is in the middle of reading.
    expect(apiFetch).toHaveBeenCalledTimes(2);
    const after = t.state.getState();
    expect(after.cursor).toBe('cur-1');
    expect(after.pageIndex).toBe(before.pageIndex);
    expect(after.filters).toEqual(before.filters);
    expect(after.sort).toEqual(before.sort);
  });
});

// ─── 4. A deep-linked logs cursor survives a chooser-initiated syncUrl() ─────
//
// syncUrl() used to be called only from inside reload(), where the cursor in hand
// was a local. The chooser calls it from OUTSIDE a fetch
// (public/logs-table.js:464-466), and encodeTableState() clears every param in
// the namespace before rewriting it — so without the `urlCursor` tracking
// variable (public/logs-table.js:519) a column toggle would silently drop the
// `logs.cursor` the operator arrived with, and a refresh would land them back on
// page one.

describe('logs.cursor survives a chooser-initiated URL sync', () => {
  it('keeps a deep-linked cursor in the URL after a column toggle', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeLogs(), nextCursor: null });
    const win = stubWin('?' + LOGS_NS + '.cursor=deep-cur');
    const t = createLogsTable({ apiFetch, win } as never);
    document.body.appendChild(t.el);
    await flush();

    // The first request honours the deep link, and the URL still describes it.
    expect(apiFetch.mock.calls[0][0]).toContain('cursor=deep-cur');
    expect(lastParams(win).get(LOGS_NS + '.cursor')).toBe('deep-cur');

    setColumn(t.el, 'category', false);

    const params = lastParams(win);
    expect(params.get(LOGS_NS + '.cursor')).toBe('deep-cur');
    expect(params.get(LOGS_NS + '.cols')).toBe(t.getVisibleColumns().join(','));
    // …and the toggle really was repaint-only: no second read was issued.
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('still keeps the cursor after a second toggle merges into its own URL', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeLogs(), nextCursor: null });
    const win = stubWin('?' + LOGS_NS + '.cursor=deep-cur');
    const t = createLogsTable({ apiFetch, win } as never);
    document.body.appendChild(t.el);
    await flush();

    setColumn(t.el, 'category', false);
    setColumn(t.el, 'level', false);

    const params = lastParams(win);
    expect(params.get(LOGS_NS + '.cursor')).toBe('deep-cur');
    expect(params.get(LOGS_NS + '.cols')).toBe('timestamp,message,seq');
  });
});

// ─── 5. The lock rules, which are NOT the assets table's ─────────────────────

describe('the jobs lock rule', () => {
  it('declares the identifying/actionable group', () => {
    expect(JOBS_REQUIRED_COLUMN_GROUPS.map((g) => [...g])).toEqual([['id', 'assetId', 'actions']]);
  });

  it('locks the last surviving member rather than allowing anonymous rows', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeJobs(), total: 3 });
    const t = createJobsTable(jobsDeps(apiFetch, { win: null }));
    document.body.appendChild(t.el);
    await t.refresh();

    setColumn(t.el, 'id', false);
    setColumn(t.el, 'assetId', false);

    // Actions carries the Cancel control and is now the only way to tell one row
    // from another, so its toggle is disabled instead of being allowed to produce
    // a grid of anonymous progress bars.
    expect(t.getVisibleColumns()).toContain('actions');
    expect(toggleFor(t.el, 'actions').disabled).toBe(true);
    expect(itemFor(t.el, 'actions').classList.contains('is-locked')).toBe(true);
    expect(itemFor(t.el, 'actions').title).toBe(
      'The last one of these columns has to stay visible.'
    );
    // The panel states the rule up front, not as a refusal afterwards.
    const hint = t.el.querySelector('.ops-columns-hint') as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe('Keep at least one of ID, Asset or Actions visible.');
    expect(toggleFor(t.el, 'actions').getAttribute('aria-describedby')).toBe(hint.id);

    // Bringing a second member back releases the lock.
    setColumn(t.el, 'id', true);
    expect(toggleFor(t.el, 'actions').disabled).toBe(false);
    expect(toggleFor(t.el, 'id').disabled).toBe(false);
  });

  it('repairs a hand-crafted jobs URL that would leave no identifying column', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeJobs(), total: 3 });
    const t = createJobsTable(
      jobsDeps(apiFetch, { win: stubWin('?' + JOBS_NS + '.cols=type,progress') })
    );
    document.body.appendChild(t.el);
    await t.refresh();

    // The request is honoured except where it would break the rule: the first
    // declared group member comes back rather than the URL being rejected.
    expect(t.getVisibleColumns()).toEqual(['id', 'type', 'progress']);
  });
});

describe('the logs lock rules', () => {
  it('declares the locate-the-line group', () => {
    expect(LOGS_REQUIRED_COLUMN_GROUPS.map((g) => [...g])).toEqual([['timestamp', 'seq']]);
  });

  it('pins Message with hideable: false, from the first paint', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeLogs(), nextCursor: null });
    const t = createLogsTable({ apiFetch, win: null } as never);
    document.body.appendChild(t.el);
    await flush();

    // Nothing else can stand in for what the line actually says, so this toggle
    // is disabled while every other column is still visible — a group lock would
    // only bite once the group was down to one member.
    const cb = toggleFor(t.el, 'message');
    expect(cb.disabled).toBe(true);
    expect(itemFor(t.el, 'message').classList.contains('is-locked')).toBe(true);
    expect(itemFor(t.el, 'message').title).toBe('This column cannot be hidden.');
    const hint = t.el.querySelector('.ops-columns-hint') as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(
      'Keep at least one of Time or Seq visible. Message cannot be hidden.'
    );
    expect(cb.getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('re-adds Message to a set that asked for everything else', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeLogs(), nextCursor: null });
    const t = createLogsTable({ apiFetch, win: null } as never);
    document.body.appendChild(t.el);
    await flush();

    // A programmatic set (or a hand-edited URL) cannot route around the pin.
    expect(t.setVisibleColumns(['timestamp', 'seq'])).toEqual(['timestamp', 'message', 'seq']);
    expect(headerLabels(t.el)).toEqual(['Time ▼', 'Message', 'Seq']);
  });

  it('locks the last of Time / Seq', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeLogs(), nextCursor: null });
    const t = createLogsTable({ apiFetch, win: null } as never);
    document.body.appendChild(t.el);
    await flush();

    setColumn(t.el, 'timestamp', false);
    // A matching line can still be read, but `seq` is now the only way to point
    // at it, so it stays.
    expect(t.getVisibleColumns()).toContain('seq');
    expect(toggleFor(t.el, 'seq').disabled).toBe(true);
    expect(toggleFor(t.el, 'message').disabled).toBe(true);

    setColumn(t.el, 'timestamp', true);
    expect(toggleFor(t.el, 'seq').disabled).toBe(false);
    // The other direction locks the other member.
    setColumn(t.el, 'seq', false);
    expect(toggleFor(t.el, 'timestamp').disabled).toBe(true);
  });

  it('repairs a hand-crafted logs URL that names neither Time nor Seq', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeLogs(), nextCursor: null });
    const t = createLogsTable({
      apiFetch,
      win: stubWin('?' + LOGS_NS + '.cols=level'),
    } as never);
    document.body.appendChild(t.el);
    await flush();

    // `message` back by the pin, `timestamp` back as the first declared member of
    // the group — in declared order, not requested order.
    expect(t.getVisibleColumns()).toEqual(['timestamp', 'level', 'message']);
  });
});

// ─── 6. A mis-stated lock rule warns; it never throws ────────────────────────
//
// Each table's key vocabulary is derived from its own buildColumns(), so that
// half cannot drift — but a `requireAtLeastOne` group still names its keys by
// hand. A group naming a column the table no longer declares does not fail
// loudly: normalizeVisibleColumns() only ever restores a DECLARED member, so the
// rule quietly stops being enforced. createColumnVisibility() reports that where
// a table wires itself up (public/ops-ui-table.js:362-370).

describe('an undeclared lock-rule key is reported, not fatal', () => {
  it('names the undeclared keys without throwing, and still renders the table', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const columns = [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
    ];

    // The model answers the question directly…
    expect(undeclaredGroupKeys(columns, [['a', 'ghost'], ['alsoGone']])).toEqual([
      'ghost',
      'alsoGone',
    ]);

    // …and wiring a table with that rule warns rather than throwing.
    let vis!: ReturnType<typeof createColumnVisibility>;
    expect(() => {
      vis = createColumnVisibility({
        ns: 'probe',
        columns,
        urlCols: null,
        requireAtLeastOne: [['a', 'ghost']],
        win: null,
      } as never);
    }).not.toThrow();

    const messages = warn.mock.calls.map((c) => String(c[0]));
    const reported = messages.filter((m) => m.includes('[table-columns]'));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('probe');
    expect(reported[0]).toContain('ghost');
    // The table is fully usable: the declared default set is still resolved, and
    // the surviving half of the rule still applies.
    expect(vis.getVisible()).toEqual(['a', 'b']);
    expect(vis.urlCols()).toBeNull();
  });

  it('says nothing for the jobs and logs tables as shipped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const jobs = createJobsTable(
      jobsDeps(vi.fn().mockResolvedValue({ items: makeJobs(), total: 3 }), { win: null })
    );
    await jobs.refresh();
    const logs = createLogsTable({
      apiFetch: vi.fn().mockResolvedValue({ items: makeLogs(), nextCursor: null }),
      win: null,
    } as never);
    await flush();

    // Both tables' hand-written lock rules name only columns they declare — the
    // half of the #960 drift risk that derivation cannot cover.
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('[table-columns]')))
      .toHaveLength(0);
    jobs.destroy();
    logs.destroy();
  });
});
