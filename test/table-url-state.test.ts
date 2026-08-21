// @vitest-environment happy-dom
//
// Unit tests for the shared table URL-state serialization module (issue #368,
// under parent #366). This module is deliberately self-contained: it defines
// its OWN contract and depends on nothing (the shared table primitive, issue
// #367, is NOT on main and MUST NOT be imported here).
//
// Verified contract — the exact symbols under test live in
//   public/table-url-state.js  (ESM named exports):
//     decodeTableState(input, ns, defaults)
//     encodeTableState(state, ns, defaults, into) -> URLSearchParams
//     encodeTableStateToQuery(state, ns, defaults) -> string
//     normalizeTableState(state, defaults)
//     applyTableState(state, ns, { defaults, replace, win })  (history sync)
//     readTableStateFromUrl(ns, defaults, win)
//     PARAM_KEYS, SORT_DIR, BASE_DEFAULTS
//
// Param schema (namespaced as `<ns>.<key>`): sort (`field`/`-field`), status
// (comma set), q (text), from/to (ISO dates), page (1-based), cursor, size.
//
// We assert: (1) encode/decode round-trips, (2) namespacing keeps sibling
// tables from colliding, (3) tolerant parsing of malformed/absent params
// degrades to defaults rather than throwing. The applyTableState history sync
// is exercised under happy-dom (the only window-touching part).

import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  PARAM_KEYS,
  SORT_DIR,
  BASE_DEFAULTS,
  decodeTableState,
  encodeTableState,
  encodeTableStateToQuery,
  normalizeTableState,
  applyTableState,
  readTableStateFromUrl,
} from '../public/table-url-state.js';

// ─── Schema constants ────────────────────────────────────────────────────────

describe('schema constants', () => {
  it('exposes a single shared set of param keys', () => {
    expect(PARAM_KEYS).toMatchObject({
      sort: 'sort',
      status: 'status',
      q: 'q',
      from: 'from',
      to: 'to',
      page: 'page',
      cursor: 'cursor',
      size: 'size',
    });
  });

  it('freezes the constants so no table can mutate the shared schema', () => {
    expect(Object.isFrozen(PARAM_KEYS)).toBe(true);
    expect(Object.isFrozen(SORT_DIR)).toBe(true);
    expect(Object.isFrozen(BASE_DEFAULTS)).toBe(true);
  });
});

// ─── decode: defaults & absence ──────────────────────────────────────────────

describe('decodeTableState — defaults & absent params', () => {
  it('returns base defaults for an empty query', () => {
    const s = decodeTableState('', 'assets');
    expect(s).toEqual({
      sort: null,
      status: [],
      q: '',
      from: null,
      to: null,
      page: 1,
      cursor: null,
      size: 20,
    });
  });

  it('accepts null/undefined input without throwing', () => {
    expect(() => decodeTableState(null as unknown as string, 'assets')).not.toThrow();
    expect(decodeTableState(undefined as unknown as string, 'assets').page).toBe(1);
  });

  it('honours per-table default overrides for omitted params', () => {
    const defaults = { sort: '-createdAt', size: 50, page: 1 };
    const s = decodeTableState('', 'assets', defaults);
    expect(s.sort).toEqual({ field: 'createdAt', dir: SORT_DIR.desc });
    expect(s.size).toBe(50);
  });

  it('accepts a full URL string and reads only its query', () => {
    const s = decodeTableState('https://ops.example.com/tables?assets.page=3', 'assets');
    expect(s.page).toBe(3);
  });

  it('accepts a URLSearchParams instance directly', () => {
    const params = new URLSearchParams('assets.q=hello&assets.size=10');
    const s = decodeTableState(params, 'assets');
    expect(s.q).toBe('hello');
    expect(s.size).toBe(10);
  });
});

// ─── decode: sort ────────────────────────────────────────────────────────────

describe('decodeTableState — sort', () => {
  it('parses ascending (bare field)', () => {
    expect(decodeTableState('assets.sort=name', 'assets').sort).toEqual({
      field: 'name',
      dir: SORT_DIR.asc,
    });
  });

  it('parses descending (leading dash)', () => {
    expect(decodeTableState('assets.sort=-createdAt', 'assets').sort).toEqual({
      field: 'createdAt',
      dir: SORT_DIR.desc,
    });
  });

  it('treats a bare dash / empty sort as the default (no crash)', () => {
    expect(decodeTableState('assets.sort=-', 'assets').sort).toBeNull();
    expect(decodeTableState('assets.sort=', 'assets').sort).toBeNull();
  });
});

// ─── decode: status / text / dates ───────────────────────────────────────────

describe('decodeTableState — filters', () => {
  it('parses a single status', () => {
    expect(decodeTableState('jobs.status=failed', 'jobs').status).toEqual(['failed']);
  });

  it('parses a comma-separated status set, de-duped and trimmed', () => {
    expect(
      decodeTableState('jobs.status=queued,%20running%20,queued', 'jobs').status,
    ).toEqual(['queued', 'running']);
  });

  it('parses free text (preserving spaces)', () => {
    expect(decodeTableState('assets.q=my%20clip', 'assets').q).toBe('my clip');
  });

  it('accepts valid date bounds and preserves the original representation', () => {
    const s = decodeTableState('jobs.from=2026-01-01&jobs.to=2026-06-30', 'jobs');
    expect(s.from).toBe('2026-01-01');
    expect(s.to).toBe('2026-06-30');
  });

  it('drops an unparseable date back to the default', () => {
    expect(decodeTableState('jobs.from=not-a-date', 'jobs').from).toBeNull();
  });
});

// ─── decode: paging (tolerant) ───────────────────────────────────────────────

describe('decodeTableState — paging & tolerant parsing', () => {
  it('parses a valid page and size', () => {
    const s = decodeTableState('assets.page=4&assets.size=25', 'assets');
    expect(s.page).toBe(4);
    expect(s.size).toBe(25);
  });

  it('falls back to default page for non-numeric junk', () => {
    expect(decodeTableState('assets.page=abc', 'assets').page).toBe(1);
    expect(decodeTableState('assets.page=1e9', 'assets').page).toBe(1);
    expect(decodeTableState('assets.page=NaN', 'assets').page).toBe(1);
  });

  it('clamps page/size to safe bounds instead of erroring', () => {
    expect(decodeTableState('assets.page=0', 'assets').page).toBe(1); // below PAGE_MIN
    expect(decodeTableState('assets.page=-5', 'assets').page).toBe(1);
    expect(decodeTableState('assets.size=0', 'assets').size).toBe(1); // below SIZE_MIN
    expect(decodeTableState('assets.size=99999', 'assets').size).toBe(500); // above SIZE_MAX
  });

  it('reads a cursor token', () => {
    expect(decodeTableState('assets.cursor=abc123', 'assets').cursor).toBe('abc123');
  });

  it('never throws on hostile/garbled query strings', () => {
    expect(() => decodeTableState('%%%&&&=&assets.size=%zz', 'assets')).not.toThrow();
    const s = decodeTableState('%%%&&&=&assets.size=%zz', 'assets');
    expect(s.size).toBe(20); // degraded to default
  });
});

// ─── namespacing ─────────────────────────────────────────────────────────────

describe('namespacing — sibling tables never collide', () => {
  const query =
    'assets.sort=-createdAt&assets.page=2&jobs.sort=name&jobs.page=5&jobs.status=failed';

  it('each namespace decodes only its own params', () => {
    const assets = decodeTableState(query, 'assets');
    const jobs = decodeTableState(query, 'jobs');

    expect(assets.sort).toEqual({ field: 'createdAt', dir: SORT_DIR.desc });
    expect(assets.page).toBe(2);
    expect(assets.status).toEqual([]); // status belongs to jobs, not assets

    expect(jobs.sort).toEqual({ field: 'name', dir: SORT_DIR.asc });
    expect(jobs.page).toBe(5);
    expect(jobs.status).toEqual(['failed']);
  });

  it('encoding one table into a URL preserves the other table params', () => {
    const existing = new URLSearchParams('jobs.page=5&jobs.status=failed');
    const merged = encodeTableState({ page: 2, sort: '-createdAt' }, 'assets', undefined, existing);
    // assets keys written...
    expect(merged.get('assets.page')).toBe('2');
    expect(merged.get('assets.sort')).toBe('-createdAt');
    // ...jobs keys untouched.
    expect(merged.get('jobs.page')).toBe('5');
    expect(merged.get('jobs.status')).toBe('failed');
  });

  it('re-encoding the same namespace is idempotent (no stale keys)', () => {
    const first = encodeTableState({ page: 3, q: 'x' }, 'assets');
    const second = encodeTableState({ page: 2 }, 'assets', undefined, first);
    expect(second.get('assets.page')).toBe('2');
    // q was not part of the second state and is not a default -> must be cleared.
    expect(second.get('assets.q')).toBeNull();
  });
});

// ─── encode: only non-defaults are written ───────────────────────────────────

describe('encodeTableState — writes only non-default keys', () => {
  it('emits nothing for the default view', () => {
    expect(encodeTableStateToQuery({}, 'assets')).toBe('');
  });

  it('omits keys equal to the table default', () => {
    const defaults = { size: 20, sort: '-createdAt' };
    const qs = encodeTableStateToQuery(
      { size: 20, sort: '-createdAt', page: 3 },
      'assets',
      defaults,
    );
    // size & sort match defaults -> omitted; only page emitted.
    expect(qs).toBe('assets.page=3');
  });

  it('URL-encodes text and status values', () => {
    const qs = encodeTableStateToQuery(
      { q: 'a b/c', status: ['queued', 'running'] },
      'jobs',
    );
    expect(qs).toContain('jobs.q=a+b%2Fc');
    expect(qs).toContain('jobs.status=queued%2Crunning');
  });
});

// ─── round-trip: encode -> decode -> encode ──────────────────────────────────

describe('round-trip encode/decode', () => {
  const cases = [
    { name: 'sort only', state: { sort: { field: 'name', dir: 'desc' } } },
    { name: 'text filter', state: { q: 'holiday 2026' } },
    { name: 'status set', state: { status: ['queued', 'running'] } },
    { name: 'date range', state: { from: '2026-01-01', to: '2026-12-31' } },
    { name: 'paging', state: { page: 7, size: 50 } },
    { name: 'cursor paging', state: { cursor: 'eyJvIjoxMH0', size: 25 } },
    {
      name: 'everything',
      state: {
        sort: { field: 'createdAt', dir: 'asc' },
        status: ['failed'],
        q: 'render',
        from: '2026-03-01',
        to: '2026-03-31',
        page: 4,
        size: 40,
      },
    },
  ];

  for (const { name, state } of cases) {
    it(`round-trips: ${name}`, () => {
      const qs = encodeTableStateToQuery(state, 'assets');
      const decoded = decodeTableState(qs, 'assets');
      // decoded must equal the normalized form of the input state.
      const normalized = normalizeTableState(state);
      expect(decoded).toEqual(normalized);

      // And re-encoding the decoded state yields an identical query string.
      expect(encodeTableStateToQuery(decoded, 'assets')).toBe(qs);
    });
  }

  it('a shared URL reconstructs the identical view in a fresh parse', () => {
    // Simulate: user configures a view, we build the URL, they paste it fresh.
    const state = {
      sort: { field: 'createdAt', dir: 'desc' },
      status: ['failed', 'queued'],
      q: 'nightly',
      page: 3,
      size: 50,
    };
    const url = 'https://ops.example.com/jobs?' + encodeTableStateToQuery(state, 'jobs');
    const reopened = decodeTableState(url, 'jobs');
    expect(reopened).toEqual(normalizeTableState(state));
  });
});

// ─── normalizeTableState ─────────────────────────────────────────────────────

describe('normalizeTableState — in-memory coercion matches encode/decode rules', () => {
  it('coerces string sort tokens and numeric strings', () => {
    const n = normalizeTableState({ sort: '-name', page: '3', size: '25' });
    expect(n.sort).toEqual({ field: 'name', dir: SORT_DIR.desc });
    expect(n.page).toBe(3);
    expect(n.size).toBe(25);
  });

  it('drops junk to defaults without throwing', () => {
    const n = normalizeTableState({ page: {}, size: null, status: 42 as unknown as string });
    expect(n.page).toBe(1);
    expect(n.size).toBe(20);
    expect(n.status).toEqual([]);
  });
});

// ─── history sync helper (window-touching) ───────────────────────────────────

describe('applyTableState / readTableStateFromUrl (history sync)', () => {
  beforeEach(() => {
    // happy-dom pins the document origin; use same-origin relative paths so
    // history mutations are allowed (a cross-origin URL raises SecurityError).
    window.history.replaceState(null, '', '/tables');
  });

  it('replaces the URL (default) with this table\'s namespaced state', () => {
    const applied = applyTableState({ page: 4, sort: { field: 'name', dir: 'asc' } }, 'assets');
    expect(applied).toContain('/tables?');
    expect(window.location.search).toContain('assets.page=4');
    expect(window.location.search).toContain('assets.sort=name');
  });

  it('preserves sibling-table params already in the URL', () => {
    window.history.replaceState(null, '', '/tables?jobs.page=9');
    applyTableState({ page: 2 }, 'assets');
    expect(window.location.search).toContain('jobs.page=9');
    expect(window.location.search).toContain('assets.page=2');
  });

  it('pushes a new history entry when replace:false', () => {
    const push = vi.spyOn(window.history, 'pushState');
    applyTableState({ page: 2 }, 'assets', { replace: false });
    expect(push).toHaveBeenCalledTimes(1);
    push.mockRestore();
  });

  it('round-trips through the live URL via readTableStateFromUrl', () => {
    applyTableState({ sort: { field: 'createdAt', dir: 'desc' }, page: 3, size: 50 }, 'assets');
    const read = readTableStateFromUrl('assets');
    expect(read.sort).toEqual({ field: 'createdAt', dir: SORT_DIR.desc });
    expect(read.page).toBe(3);
    expect(read.size).toBe(50);
  });

  it('preserves the URL hash when applying state', () => {
    window.history.replaceState(null, '', '/tables#section');
    applyTableState({ page: 2 }, 'assets');
    expect(window.location.hash).toBe('#section');
  });

  it('no-ops safely when no window is available (SSR-style)', () => {
    expect(applyTableState({ page: 2 }, 'assets', { win: undefined })).toBe('');
  });
});
