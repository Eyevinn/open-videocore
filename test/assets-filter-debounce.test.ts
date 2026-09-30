// @vitest-environment happy-dom
//
// Issue #946 — the Assets tab free-text box must behave like a FILTER, not a
// query form: it narrows the list as you type, it can be cleared in one click,
// and Enter is a shortcut rather than a requirement.
//
// Verified backend contract (unchanged by this issue — the box only changes WHEN
// the existing calls are made, never WHICH):
//   - Tier 2, a `q` term present: GET /api/v1/search/
//     openapi.json .paths["/api/v1/search/"].get.parameters
//       -> q (string, minLength 1, maxLength 512), tags, mimeType, status, from,
//          to, tamsFlowId, tamsTimerange, page (integer >= 1),
//          pageSize (integer 1..100)
//     200 body properties (`searchResultSchema`, src/routes/search.ts)
//       -> assets, collections, total, collectionTotal, page
//   - Tier 1, no `q`: GET /api/v1/assets/
//     openapi.json .paths["/api/v1/assets/"].get.parameters
//       -> limit (1..200), offset (>= 0), status, parentId, from, to
//     200 body properties -> items, limit, offset, total
// `q` having minLength 1 is exactly why an emptied box must drop the param rather
// than send `q=`: the empty string is not a legal term, and the full list lives
// on the other tier.
//
// A fake apiFetch is injected so the assertions are about the exact paths the
// module builds, with no live server involved.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssetsTable, SEARCH_DEBOUNCE_MS } from '../public/assets-table.js';

const deps = () => ({
  renderBadge: (s: string) => '<span class="badge">' + s + '</span>',
  renderTags: () => '',
  fmtDate: (v: string) => String(v || '—'),
  isAssetWedged: () => false,
});

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

const LIST_ROW = { id: 'a1', name: 'One', status: 'ready', createdAt: '2026-01-01T00:00:00Z' };
const HIT_ROW = { id: 'a2', name: 'Two', status: 'ready', createdAt: '2026-01-02T00:00:00Z' };

// Records every path the table requests and answers both tiers with a canned
// envelope. `onSearch` lets a test take control of the in-flight search promise.
function fakeApi(onSearch?: () => unknown) {
  const calls: string[] = [];
  const apiFetch = vi.fn(async (path: string) => {
    calls.push(path);
    if (path.startsWith('/search')) {
      return onSearch ? onSearch() : { assets: [HIT_ROW], total: 1, page: 1 };
    }
    return { items: [LIST_ROW], limit: 20, offset: 0, total: 1 };
  });
  return { apiFetch, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Comfortably past the trailing debounce, without hard-coding the constant.
const settleDebounce = () => wait(SEARCH_DEBOUNCE_MS + 60);

function mount(apiFetch: unknown, search = '') {
  const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin(search) });
  document.body.appendChild(t.el);
  return t;
}

function box(t: { el: HTMLElement }) {
  return t.el.querySelector<HTMLInputElement>('.ops-filter-q input')!;
}

function clearBtn(t: { el: HTMLElement }) {
  return t.el.querySelector<HTMLButtonElement>('.ops-filter-q .ops-search-clear')!;
}

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// Type a term one character at a time with no pause, the way a keyboard does.
function typeEachKey(input: HTMLInputElement, term: string) {
  for (let i = 1; i <= term.length; i += 1) type(input, term.slice(0, i));
}

function pressEnter(input: HTMLInputElement) {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

const searchCalls = (calls: string[]) => calls.filter((c) => c.startsWith('/search'));
const listCalls = (calls: string[]) => calls.filter((c) => c.startsWith('/assets?'));

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('free-text box narrows the list without Enter (issue #946)', () => {
  it('queries the search tier after the debounce, with no Enter and no button press', async () => {
    const { apiFetch, calls } = fakeApi();
    const t = mount(apiFetch);
    await tick();
    expect(searchCalls(calls)).toHaveLength(0);

    typeEachKey(box(t), 'news');
    await settleDebounce();
    await tick();

    const hit = searchCalls(calls);
    expect(hit).toHaveLength(1);
    // The verified param name, and the term itself — not a guessed alias.
    expect(new URL('http://x' + hit[0]).searchParams.get('q')).toBe('news');
    expect(t.el.querySelector('tbody')!.textContent).toContain('Two');
  });

  it('spends one request on one search term, not one per keystroke', async () => {
    const { apiFetch, calls } = fakeApi();
    const t = mount(apiFetch);
    await tick();

    typeEachKey(box(t), 'promo reel'); // 10 keystrokes
    await settleDebounce();
    await tick();

    expect(searchCalls(calls)).toHaveLength(1);
    expect(new URL('http://x' + searchCalls(calls)[0]).searchParams.get('q')).toBe('promo reel');
  });

  it('sends no request at all while the term is still being typed', async () => {
    const { apiFetch, calls } = fakeApi();
    const t = mount(apiFetch);
    await tick();
    const before = calls.length;

    typeEachKey(box(t), 'archive');
    await tick(); // a microtask-ish pause, well inside the debounce window

    expect(calls.length).toBe(before);
  });
});

describe('emptying the box restores the full list immediately (issue #946)', () => {
  it('fires straight away when the text is deleted, without waiting on the debounce', async () => {
    const { apiFetch, calls } = fakeApi();
    const t = mount(apiFetch, '?assets.q=news');
    await tick();
    expect(searchCalls(calls)).toHaveLength(1);

    type(box(t), '');
    await tick(); // NO debounce wait

    const list = listCalls(calls);
    expect(list).toHaveLength(1);
    // `q` has minLength 1, so the param is dropped rather than sent empty.
    expect(list[0]).not.toContain('q=');
    expect(t.el.querySelector('tbody')!.textContent).toContain('One');
  });

  it('applies no minimum term length — one character queries like any other', async () => {
    const { apiFetch, calls } = fakeApi();
    const t = mount(apiFetch);
    await tick();

    type(box(t), 'a');
    await settleDebounce();
    await tick();

    expect(new URL('http://x' + searchCalls(calls)[0]).searchParams.get('q')).toBe('a');
  });

  it('treats a whitespace-only box as empty and returns to the list tier', async () => {
    const { apiFetch, calls } = fakeApi();
    const t = mount(apiFetch, '?assets.q=news');
    await tick();

    type(box(t), '   ');
    await tick();

    expect(listCalls(calls)).toHaveLength(1);
  });
});

describe('the clear control (issue #946)', () => {
  it('is absent while the box is empty and appears once there is something to clear', async () => {
    const { apiFetch } = fakeApi();
    const t = mount(apiFetch);
    await tick();
    expect(clearBtn(t).hidden).toBe(true);

    type(box(t), 'news');
    expect(clearBtn(t).hidden).toBe(false);
  });

  it('is present from the first paint when the URL seeds a term', async () => {
    const { apiFetch } = fakeApi();
    const t = mount(apiFetch, '?assets.q=news');
    await tick();
    expect(clearBtn(t).hidden).toBe(false);
  });

  it('empties the box and reloads the full list on one click, with no debounce wait', async () => {
    const { apiFetch, calls } = fakeApi();
    const t = mount(apiFetch, '?assets.q=news');
    await tick();

    clearBtn(t).click();
    await tick();

    expect(box(t).value).toBe('');
    expect(clearBtn(t).hidden).toBe(true);
    expect(listCalls(calls)).toHaveLength(1);
    expect(t.el.querySelector('tbody')!.textContent).toContain('One');
  });

  it('is a real focusable button with an accessible name, not a decorative glyph', async () => {
    const { apiFetch } = fakeApi();
    const t = mount(apiFetch, '?assets.q=news');
    await tick();
    const btn = clearBtn(t);
    expect(btn.tagName).toBe('BUTTON');
    // type=button so it can never submit an enclosing form.
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.getAttribute('aria-label')).toBe('Clear search');
  });

  it('restores the full list even when clicked while a search request is still open', async () => {
    // The reload coalescing guard: before #946 an in-flight request made the
    // clear a no-op and the stale search results stayed on screen.
    let release: (v: unknown) => void = () => {};
    const { apiFetch, calls } = fakeApi(
      () => new Promise((r) => { release = r; })
    );
    const t = mount(apiFetch);
    await tick();

    type(box(t), 'news');
    await settleDebounce();
    await tick();
    expect(searchCalls(calls)).toHaveLength(1); // open, unresolved

    clearBtn(t).click();
    await tick();
    release({ assets: [HIT_ROW], total: 1, page: 1 });
    await tick();
    await tick();

    expect(listCalls(calls).length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1].startsWith('/assets?')).toBe(true);
    expect(t.el.querySelector('tbody')!.textContent).toContain('One');
  });
});

describe('Enter flushes the debounce instead of being required (issue #946)', () => {
  it('queries immediately on Enter, before the debounce would have elapsed', async () => {
    const { apiFetch, calls } = fakeApi();
    const t = mount(apiFetch);
    await tick();

    type(box(t), 'news');
    pressEnter(box(t));
    await tick(); // NO debounce wait

    expect(searchCalls(calls)).toHaveLength(1);
    expect(new URL('http://x' + searchCalls(calls)[0]).searchParams.get('q')).toBe('news');
  });

  it('does not replay the term when the debounce already landed', async () => {
    const { apiFetch, calls } = fakeApi();
    const t = mount(apiFetch);
    await tick();

    type(box(t), 'news');
    await settleDebounce();
    await tick();
    expect(searchCalls(calls)).toHaveLength(1);

    pressEnter(box(t));
    pressEnter(box(t));
    await settleDebounce();
    await tick();

    expect(searchCalls(calls)).toHaveLength(1);
  });

  it('costs one request, not two, when Enter follows the last keystroke', async () => {
    const { apiFetch, calls } = fakeApi();
    const t = mount(apiFetch);
    await tick();

    typeEachKey(box(t), 'news');
    pressEnter(box(t));
    await settleDebounce();
    await tick();

    expect(searchCalls(calls)).toHaveLength(1);
  });
});

describe('the box looks like a filter (issue #946)', () => {
  it('carries a magnifier affordance that is decorative and not focusable', async () => {
    const { apiFetch } = fakeApi();
    const t = mount(apiFetch);
    await tick();
    const icon = t.el.querySelector('.ops-filter-q .ops-search-icon')!;
    expect(icon).not.toBeNull();
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    // Drawn in CSS: public/ has no icon font and no inline SVG, and this box is
    // not the place to introduce one.
    expect(icon.innerHTML).toBe('');
    expect(t.el.querySelector('.ops-filter-q svg')).toBeNull();
  });

  it('keeps the input accessibly named and out of the browser autofill path', async () => {
    const { apiFetch } = fakeApi();
    const t = mount(apiFetch);
    await tick();
    const input = box(t);
    expect(input.getAttribute('type')).toBe('search');
    expect(input.getAttribute('aria-label')).toBe('Search');
    expect(input.getAttribute('autocomplete')).toBe('off');
  });
});
