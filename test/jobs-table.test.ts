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
  JOB_STATUSES,
  JOBS_NS,
  JOBS_PAGE_SIZE,
  JOBS_WORKING_SET_MAX,
} from '../public/jobs-table.js';

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
