// @vitest-environment happy-dom
//
// Unit tests for the jobs table wiring (issue #370, parent #366).
//
// public/jobs-table.js composes the ALREADY-MERGED shared primitives — the ops
// table primitive (public/ops-ui-table.js, #367) and the URL-state contract
// (public/table-url-state.js, #368) — for the jobs surface. It does NOT reinvent
// a table, sort, filter, or URL-state mechanism.
//
// ─── Contract grounding (verified before any query param was written) ─────────
// The jobs listing endpoint accepts ONLY limit + offset:
//   - src/routes/jobs.ts:87-104 (querystring zod schema: limit 1..100, offset>=0)
//   - openapi.json path "/api/v1/jobs/" GET parameters (same two params)
// Job status enum — JOB_STATUSES (src/data/job-repo.ts:35, identical in
// openapi.json job.status enum), includes 'cancelled' (added via #124/#126):
//   'pending' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
// Because the endpoint has no server-side sort/filter/search, this table fetches
// a BOUNDED window (never the full set) via limit/offset and applies
// sort/filter/search client-side. These tests exercise those pure passes plus
// the composition (URL round-trip, single network path, failed-isolation).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createJobsTable,
  filterJobs,
  sortJobs,
  pageJobs,
  renderAssetCell,
  JOB_STATUSES,
  JOBS_NS,
  JOBS_PAGE_SIZE,
  JOBS_WORKING_SET_MAX,
} from '../public/jobs-table.js';
import { COPY_ID_BTN_CLASS } from '../public/copy-id.js';

// A small deterministic fixture spanning statuses + dates.
function makeJobs() {
  return [
    { id: 'job-1', type: 'ingest-url', status: 'failed', assetId: 'asset-a', progress: 0, createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:05:00.000Z' },
    { id: 'job-2', type: 'transcode', status: 'done', assetId: 'asset-b', progress: 100, createdAt: '2026-01-02T10:00:00.000Z', updatedAt: '2026-01-02T11:00:00.000Z' },
    { id: 'job-3', type: 'transcode', status: 'running', assetId: 'asset-a', progress: 50, createdAt: '2026-01-03T10:00:00.000Z', updatedAt: '2026-01-03T10:30:00.000Z' },
    { id: 'job-4', type: 'ingest-url', status: 'failed', assetId: 'asset-c', progress: 0, createdAt: '2026-01-04T10:00:00.000Z', updatedAt: '2026-01-04T10:01:00.000Z' },
    { id: 'job-5', type: 'transcode', status: 'cancelled', assetId: 'asset-b', progress: 20, createdAt: '2026-01-05T10:00:00.000Z', updatedAt: '2026-01-05T10:10:00.000Z' },
  ];
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ─── contract-grounded constants ─────────────────────────────────────────────

describe('contract constants', () => {
  it('exposes the exact JOB_STATUSES enum from the backend (incl. cancelled)', () => {
    expect(JOB_STATUSES).toEqual(['pending', 'queued', 'running', 'done', 'failed', 'cancelled']);
  });
  it('uses the jobs namespace and a bounded, visible page size', () => {
    expect(JOBS_NS).toBe('jobs');
    expect(JOBS_PAGE_SIZE).toBe(20);
    // Working window is capped at the endpoint's max limit (100) — never a full set.
    expect(JOBS_WORKING_SET_MAX).toBe(100);
  });
});

// ─── client-side filter ───────────────────────────────────────────────────────

describe('filterJobs', () => {
  it('isolates failed jobs (the primary operator need)', () => {
    // filterJobs preserves input order; makeJobs() lists job-1 before job-4.
    const out = filterJobs(makeJobs(), { status: ['failed'] });
    expect(out.map((j) => j.id)).toEqual(['job-1', 'job-4']);
  });

  it('filters by an inclusive createdAt date range (bare dates extend to end-of-day)', () => {
    const out = filterJobs(makeJobs(), { from: '2026-01-02', to: '2026-01-04' });
    expect(out.map((j) => j.id)).toEqual(['job-2', 'job-3', 'job-4']);
  });

  it('text search matches job id OR associated asset id, case-insensitively', () => {
    expect(filterJobs(makeJobs(), { q: 'JOB-3' }).map((j) => j.id)).toEqual(['job-3']);
    // asset-a is shared by job-1 and job-3.
    expect(filterJobs(makeJobs(), { q: 'asset-a' }).map((j) => j.id)).toEqual(['job-1', 'job-3']);
  });

  it('text search also matches the asset NAME, tolerating rows without one (#988)', () => {
    // Once the Asset column shows a name, searching that name has to work —
    // otherwise the one value the operator can actually read is unsearchable.
    const jobs = makeJobs();
    jobs[0] = { ...jobs[0], assetName: 'Opening keynote' };
    jobs[2] = { ...jobs[2], assetName: 'Opening keynote' };
    // jobs[1], [3], [4] have NO assetName (deleted asset / unresolved) and must
    // not throw or match.
    expect(filterJobs(jobs, { q: 'opening KEY' }).map((j) => j.id)).toEqual(['job-1', 'job-3']);
    expect(filterJobs(jobs, { q: 'nothing-matches-this' })).toEqual([]);
  });

  it('combines status + range + search (AND semantics)', () => {
    const out = filterJobs(makeJobs(), { status: ['failed'], from: '2026-01-04', q: 'asset-c' });
    expect(out.map((j) => j.id)).toEqual(['job-4']);
  });

  it('empty filter returns every job', () => {
    expect(filterJobs(makeJobs(), {}).length).toBe(5);
  });
});

// ─── client-side sort ─────────────────────────────────────────────────────────

describe('sortJobs', () => {
  it('defaults to createdAt descending (the server natural order)', () => {
    expect(sortJobs(makeJobs(), null).map((j) => j.id)).toEqual(['job-5', 'job-4', 'job-3', 'job-2', 'job-1']);
  });

  it('sorts by createdAt ascending when requested', () => {
    const out = sortJobs(makeJobs(), { field: 'createdAt', dir: 'asc' });
    expect(out.map((j) => j.id)).toEqual(['job-1', 'job-2', 'job-3', 'job-4', 'job-5']);
  });

  it('sorts by status ascending (alphabetical)', () => {
    const out = sortJobs(makeJobs(), { field: 'status', dir: 'asc' });
    expect(out.map((j) => j.status)).toEqual(['cancelled', 'done', 'failed', 'failed', 'running']);
  });

  it('falls back to the createdAt field for an unknown sort field (dir honoured)', () => {
    const out = sortJobs(makeJobs(), { field: 'bogus', dir: 'asc' } as never);
    // Unknown field -> sort on createdAt, keeping the requested ascending dir.
    expect(out.map((j) => j.id)).toEqual(['job-1', 'job-2', 'job-3', 'job-4', 'job-5']);
  });
});

// ─── client-side paging ───────────────────────────────────────────────────────

describe('pageJobs', () => {
  it('slices a bounded page out of the working set', () => {
    const jobs = makeJobs();
    expect(pageJobs(jobs, 0, 2).map((j) => j.id)).toEqual(['job-1', 'job-2']);
    expect(pageJobs(jobs, 2, 2).map((j) => j.id)).toEqual(['job-3', 'job-4']);
    expect(pageJobs(jobs, 4, 2).map((j) => j.id)).toEqual(['job-5']);
  });
});

// ─── composition: single network path + URL round-trip ───────────────────────

describe('createJobsTable composition', () => {
  it('fetches ONLY the bounded limit/offset jobs path (no invented params)', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeJobs(), total: 5 });
    const table = createJobsTable({ apiFetch, win: null });
    await table.refresh();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const url = apiFetch.mock.calls[0][0] as string;
    // Uses the real endpoint with only limit + offset, capped at the max window.
    expect(url).toBe('/jobs?limit=' + JOBS_WORKING_SET_MAX + '&offset=0');
    expect(url).not.toMatch(/sort=|status=|q=|from=|to=/);
  });

  it('renders a bounded page and reports the filtered total to the primitive', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeJobs(), total: 5 });
    const table = createJobsTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await table.refresh();
    // Default sort is createdAt desc — newest job (job-5) first.
    const firstCell = table.el.querySelector('tbody tr td');
    expect(firstCell?.textContent).toContain('job-5');
    // Pagination indicator reflects the client-filtered total (5 rows).
    const indicator = table.el.querySelector('.page-indicator');
    expect(indicator?.textContent).toContain('of 5');
  });

  it('applies a failed-only status filter client-side over the fetched window', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: makeJobs(), total: 5 });
    const table = createJobsTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await table.refresh();
    // Drive the status filter through the shared primitive's state.
    table.table.state.setFilter('status', 'failed');
    const ids = Array.from(table.el.querySelectorAll('tbody tr[data-row-key]')).map(
      (tr) => (tr as HTMLElement).dataset.rowKey
    );
    // Default sort is createdAt DESC, so the newer failed job (job-4) is first.
    expect(ids).toEqual(['job-4', 'job-1']);
    // No extra network round-trip — the working window is filtered in memory.
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('reconstructs sort + filter state from the URL via the shared contract', () => {
    const win = {
      location: { search: '?jobs.sort=status&jobs.status=running', pathname: '/', hash: '' },
      history: { replaceState: vi.fn(), pushState: vi.fn(), state: null },
    } as unknown as Window;
    const table = createJobsTable({ apiFetch: vi.fn().mockResolvedValue({ items: [], total: 0 }), win });
    const snap = table.table.state.getState();
    expect(snap.sort).toEqual({ columnKey: 'status', direction: 'asc' });
    expect(snap.filters.status).toBe('running');
  });

  it('reflects a user filter change back into the URL (namespaced)', async () => {
    const replaceState = vi.fn();
    const win = {
      location: { search: '', pathname: '/', hash: '' },
      history: { replaceState, pushState: vi.fn(), state: null },
    } as unknown as Window;
    const table = createJobsTable({ apiFetch: vi.fn().mockResolvedValue({ items: makeJobs(), total: 5 }), win });
    await table.refresh();
    table.table.state.setFilter('status', 'failed');
    // The most recent history write carries the namespaced status param.
    const lastUrl = replaceState.mock.calls[replaceState.mock.calls.length - 1][2] as string;
    expect(lastUrl).toContain('jobs.status=failed');
  });

  it('discloses window truncation when the server total exceeds the fetched window', async () => {
    // A full window (JOBS_WORKING_SET_MAX rows) while the server reports MORE
    // jobs than that => the client-side filter/count only sees the newest window.
    const windowItems = Array.from({ length: JOBS_WORKING_SET_MAX }, (_, i) => ({
      id: 'job-' + i,
      type: 'transcode',
      status: 'done',
      assetId: 'asset-' + i,
      progress: 100,
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T11:00:00.000Z',
    }));
    const apiFetch = vi
      .fn()
      .mockResolvedValue({ items: windowItems, total: JOBS_WORKING_SET_MAX + 250 });
    const table = createJobsTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await table.refresh();
    const banner = table.el.querySelector('.ops-table-truncation') as HTMLElement | null;
    expect(banner).not.toBeNull();
    expect(banner?.hidden).toBe(false);
    // Honest cap: names both the window size and the true system-wide total.
    expect(banner?.textContent).toContain('newest ' + JOBS_WORKING_SET_MAX);
    expect(banner?.textContent).toContain('of ' + (JOBS_WORKING_SET_MAX + 250));
  });

  it('hides the truncation banner when the window holds every job (total <= items.length)', async () => {
    // makeJobs() is 5 rows and total is 5 => nothing beyond the window.
    const apiFetch = vi.fn().mockResolvedValue({ items: makeJobs(), total: 5 });
    const table = createJobsTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await table.refresh();
    const banner = table.el.querySelector('.ops-table-truncation') as HTMLElement | null;
    expect(banner).not.toBeNull();
    expect(banner?.hidden).toBe(true);
    expect(banner?.textContent).toBe('');
  });

  it('surfaces a fetch error through the shared error state', async () => {
    const apiFetch = vi.fn().mockRejectedValue(new Error('boom'));
    const table = createJobsTable({ apiFetch, win: null });
    document.body.appendChild(table.el);
    await table.refresh();
    const errRow = table.el.querySelector('tr.ops-table-error td');
    expect(errRow?.textContent).toContain('boom');
  });

  it('requires an apiFetch dependency', () => {
    expect(() => createJobsTable({} as never)).toThrow(/apiFetch/);
  });
});

// ─── the Asset column names the asset (issue #988) ───────────────────────────
//
// Contract grounding for the fields read here:
//   - `assetId`   string, ALWAYS present — jobSchema, src/routes/jobs.ts:54
//   - `assetName` string, OPTIONAL — src/routes/jobs.ts:62; the route resolves
//     it with `.catch(() => undefined)` (mirroring src/routes/pipelines.ts:98),
//     so a deleted asset arrives as a row with an id and no name. Every
//     assertion below therefore covers both shapes.

describe('renderAssetCell', () => {
  function html(job: unknown) {
    const el = document.createElement('div');
    el.innerHTML = renderAssetCell(job as never);
    return el;
  }

  it('leads with the asset name and keeps the ULID beneath it', () => {
    const el = html({ assetId: '01J8Z3K4M5N6P7Q8R9S0T1V2W3', assetName: 'Opening keynote' });
    expect(el.querySelector('.job-asset-name')?.textContent).toBe('Opening keynote');
    // The ULID is still on screen IN FULL — it is the value the API accepts.
    expect(el.querySelector('.job-asset-id')?.textContent).toContain('01J8Z3K4M5N6P7Q8R9S0T1V2W3');
  });

  it('falls back to the ULID when the asset resolved no name (deleted asset)', () => {
    const el = html({ assetId: '01J8Z3K4M5N6P7Q8R9S0T1V2W3' });
    expect(el.textContent).toContain('01J8Z3K4M5N6P7Q8R9S0T1V2W3');
    // No empty name element left behind above it.
    expect(el.querySelector('.job-asset-name')).toBeNull();
  });

  it('offers a click-to-copy affordance for the ULID in both shapes', () => {
    const named = html({ assetId: '01J8Z3K4M5N6P7Q8R9S0T1V2W3', assetName: 'Opening keynote' });
    const bare = html({ assetId: '01J8Z3K4M5N6P7Q8R9S0T1V2W3' });
    for (const el of [named, bare]) {
      const btn = el.querySelector<HTMLButtonElement>('.' + COPY_ID_BTN_CLASS);
      expect(btn).not.toBeNull();
      expect(btn?.dataset.copyId).toBe('01J8Z3K4M5N6P7Q8R9S0T1V2W3');
      // Accessible name distinguishes this row's control from every other row's.
      expect(btn?.getAttribute('aria-label')).toBe('Copy asset id 01J8Z3K4M5N6P7Q8R9S0T1V2W3');
    }
  });

  it('renders an em-dash when the job references no asset at all', () => {
    expect(html({}).textContent).toBe('—');
    expect(html(null).textContent).toBe('—');
  });

  it('escapes a hostile asset name (no raw markup reaches the cell)', () => {
    const el = html({ assetId: 'asset-x', assetName: '<img src=x onerror=alert(1)>' });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.job-asset-name')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('the Asset column in a rendered table', () => {
  it('shows names where they resolved and the ULID where they did not', async () => {
    const items = [
      { id: 'job-1', type: 'transcode', status: 'running', assetId: '01J8Z3K4M5N6P7Q8R9S0T1V2W3', assetName: 'Opening keynote', progress: 10, createdAt: '2026-01-02T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z' },
      // Asset deleted: the row still lists, identified by its ULID.
      { id: 'job-2', type: 'transcode', status: 'done', assetId: '01J8Z3K4M5N6P7Q8R9S0T1V2W4', progress: 100, createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T11:00:00.000Z' },
    ];
    const table = createJobsTable({ apiFetch: vi.fn().mockResolvedValue({ items, total: 2 }), win: null });
    document.body.appendChild(table.el);
    await table.refresh();

    const headers = Array.from(table.el.querySelectorAll('thead th')).map((th) => th.textContent?.trim());
    expect(headers).toContain('Asset');

    const rows = Array.from(table.el.querySelectorAll('tbody tr[data-row-key]'));
    expect(rows).toHaveLength(2);
    const cellOf = (tr: Element) => tr.querySelectorAll('td')[3];
    expect(cellOf(rows[0]).querySelector('.job-asset-name')?.textContent).toBe('Opening keynote');
    expect(cellOf(rows[0]).textContent).toContain('01J8Z3K4M5N6P7Q8R9S0T1V2W3');
    expect(cellOf(rows[1]).querySelector('.job-asset-name')).toBeNull();
    expect(cellOf(rows[1]).textContent).toContain('01J8Z3K4M5N6P7Q8R9S0T1V2W4');
  });

  it('copying an asset id does not also open the row detail panel', async () => {
    const onSelect = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const items = [
      { id: 'job-1', type: 'transcode', status: 'running', assetId: '01J8Z3K4M5N6P7Q8R9S0T1V2W3', assetName: 'Opening keynote', progress: 10, createdAt: '2026-01-02T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z' },
    ];
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const table = createJobsTable({
      apiFetch: vi.fn().mockResolvedValue({ items, total: 1 }),
      onSelect,
      win: null,
    });
    document.body.appendChild(table.el);
    await table.refresh();

    const btn = table.el.querySelector<HTMLButtonElement>('.' + COPY_ID_BTN_CLASS)!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(writeText).toHaveBeenCalledWith('01J8Z3K4M5N6P7Q8R9S0T1V2W3');
    expect(onSelect).not.toHaveBeenCalled();

    // The row itself still opens the panel when clicked anywhere else.
    table.el.querySelector<HTMLElement>('tbody tr[data-row-key]')!.click();
    expect(onSelect).toHaveBeenCalledWith('job-1');
  });
});

// ─── unset filter controls look unset (issue #984) ────────────────────────────
//
// Contract grounding for the markers asserted here:
//   - class names: public/jobs-table.js statusFilterControl() -> 'ops-filter-select',
//     dateInput() -> 'ops-filter-date', searchControl() -> 'ops-filter-search'
//   - the muted colour token: public/style.css :root -> `--text-muted: #94a3b8`
//     (line 6; the only muted text token in the sheet)
//   - the paint rules keyed off the marker: public/style.css
//     `.ops-filter-select.is-unset, .ops-filter-date.is-unset { color: var(--text-muted) }`
// happy-dom does not do layout or cascade resolution, so the assertions below
// verify the DOM seam (the .is-unset marker on empty vs. filled controls), not the
// resolved pixel colour. The search box needs no marker — it carries a native
// placeholder, muted by `.ops-filter-search::placeholder`.

describe('unset filter controls are marked muted', () => {
  function controls(el: HTMLElement) {
    return {
      select: el.querySelector<HTMLSelectElement>('.ops-filter-select')!,
      from: el.querySelector<HTMLInputElement>('#jobs-filter-from')!,
      to: el.querySelector<HTMLInputElement>('#jobs-filter-to')!,
      search: el.querySelector<HTMLInputElement>('.ops-filter-search')!,
    };
  }

  it('marks the select and both date inputs unset on first render', () => {
    const table = createJobsTable({
      apiFetch: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      win: null,
    });
    document.body.appendChild(table.el);
    const c = controls(table.el);
    expect(c.select.value).toBe('');
    expect(c.select.classList.contains('is-unset')).toBe(true);
    expect(c.from.classList.contains('is-unset')).toBe(true);
    expect(c.to.classList.contains('is-unset')).toBe(true);
    // The search box renders its own empty state via the native placeholder,
    // which the stylesheet paints with the same --text-muted token.
    expect(c.search.placeholder).toBe('Job id, asset id, or asset name');
    expect(c.search.value).toBe('');
  });

  it('does NOT mark controls unset when the URL state already carries values', () => {
    const win = {
      location: {
        search: '?jobs.status=running&jobs.from=2026-01-02&jobs.to=2026-01-04&jobs.q=asset-a',
        pathname: '/',
        hash: '',
      },
      history: { replaceState: vi.fn(), pushState: vi.fn(), state: null },
    } as unknown as Window;
    const table = createJobsTable({
      apiFetch: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      win,
    });
    document.body.appendChild(table.el);
    const c = controls(table.el);
    expect(c.select.value).toBe('running');
    expect(c.select.classList.contains('is-unset')).toBe(false);
    expect(c.from.value).toBe('2026-01-02');
    expect(c.from.classList.contains('is-unset')).toBe(false);
    expect(c.to.value).toBe('2026-01-04');
    expect(c.to.classList.contains('is-unset')).toBe(false);
    expect(c.search.value).toBe('asset-a');
  });

  it('drops the marker when a value is chosen and restores it when cleared', () => {
    const table = createJobsTable({
      apiFetch: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      win: null,
    });
    document.body.appendChild(table.el);
    const c = controls(table.el);

    c.select.value = 'failed';
    c.select.dispatchEvent(new Event('change'));
    expect(c.select.classList.contains('is-unset')).toBe(false);

    c.from.value = '2026-01-02';
    c.from.dispatchEvent(new Event('change'));
    expect(c.from.classList.contains('is-unset')).toBe(false);

    c.to.value = '2026-01-04';
    c.to.dispatchEvent(new Event('change'));
    expect(c.to.classList.contains('is-unset')).toBe(false);

    // Back to "All statuses" / cleared dates => muted again.
    c.select.value = '';
    c.select.dispatchEvent(new Event('change'));
    expect(c.select.classList.contains('is-unset')).toBe(true);

    c.from.value = '';
    c.from.dispatchEvent(new Event('change'));
    expect(c.from.classList.contains('is-unset')).toBe(true);

    c.to.value = '';
    c.to.dispatchEvent(new Event('input'));
    expect(c.to.classList.contains('is-unset')).toBe(true);
  });

  it('keeps the placeholder option muted in the open list while real statuses stay full strength', () => {
    // The paint lives in public/style.css:
    //   .ops-filter-select option           { color: var(--text) }
    //   .ops-filter-select option[value=''] { color: var(--text-muted) }
    // The DOM contract those rules key off is the empty-valued placeholder entry
    // being first, with every other option carrying a non-empty value.
    const table = createJobsTable({
      apiFetch: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      win: null,
    });
    document.body.appendChild(table.el);
    const opts = Array.from(controls(table.el).select.options);
    expect(opts[0].value).toBe('');
    expect(opts[0].textContent).toBe('All statuses');
    expect(opts.slice(1).every((o) => o.value !== '')).toBe(true);
  });
});
