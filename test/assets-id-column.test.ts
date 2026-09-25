// @vitest-environment happy-dom
//
// Issue #851 — a column headed "ID" must carry the value the API accepts as an
// asset id, the slug must be labelled as the slug, and the id must be copyable
// without hovering for a `title` tooltip.
//
// CONTRACT GROUNDING (verified, not guessed):
//   - `PUT /api/v1/collections/:id/assets/:assetId` (openapi.json path key
//     "/api/v1/collections/{id}/assets/{assetId}") resolves the member with
//     `assets.get(request.params.assetId)` — src/routes/collections.ts:493-510 —
//     i.e. the plain ULID read `AssetRepository.get` (src/data/asset-repo.ts:841).
//     There is no slug fallback on that path, so only the ULID works there.
//   - Only `GET /api/v1/assets/:id` is slug-tolerant, via `resolveAsset()` and
//     `isUlid()` (src/routes/assets.ts:2807-2814, src/data/asset-repo.ts:834).
//   - The asset list item carries `id` (always) and `slug` (OPTIONAL — see
//     `slug?: string` on `Asset`, src/data/asset-repo.ts:455, and the optional
//     `slug` in the persisted document schema, src/data/asset-document.ts:286),
//     so the slug cell must tolerate an absent slug.
//
// The ULID below is real-shaped Crockford base32 (26 chars) so it satisfies
// `isUlid()` — the same predicate the routes use to tell an id from a slug.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssetsTable } from '../public/assets-table.js';
import {
  copyableIdCellHtml,
  slugCellHtml,
  wireCopyIdButtons,
  COPY_ID_BTN_CLASS,
} from '../public/copy-id.js';

const ULID = '01M39TGAB79CPKREYVBGKGVNQS';
const SLUG = 'gentle-badger-678';

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

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeApi(items: Array<Record<string, unknown>>) {
  return vi.fn(async () => ({ items, total: items.length }));
}

function headerTexts(el: Element): string[] {
  return [...el.querySelectorAll('thead th')].map((th) => (th.textContent || '').trim());
}

function cellFor(el: Element, label: string): HTMLElement {
  const idx = headerTexts(el).indexOf(label);
  if (idx < 0) throw new Error('no column headed ' + label + ' in ' + JSON.stringify(headerTexts(el)));
  const cells = el.querySelectorAll('tbody tr[data-row-key] td');
  return cells[idx] as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('assets table — the ID column carries the API-acceptable id (issue #851)', () => {
  it('shows the ULID under "ID" and the slug under its own "Slug" header', async () => {
    const t = createAssetsTable({
      ...deps(),
      apiFetch: fakeApi([
        { id: ULID, slug: SLUG, name: 'Clip', status: 'ready', createdAt: '2026-01-01T00:00:00Z' },
      ]),
      win: stubWin(),
    });
    document.body.appendChild(t.el);
    await tick();

    expect(headerTexts(t.el)).toContain('ID');
    expect(headerTexts(t.el)).toContain('Slug');

    // AC1: the value under "ID" is the one the endpoints accept.
    const idCell = cellFor(t.el, 'ID');
    expect(idCell.textContent).toContain(ULID);
    expect(idCell.textContent).not.toContain(SLUG);

    // AC2: the slug is displayed, labelled as the slug.
    expect(cellFor(t.el, 'Slug').textContent).toContain(SLUG);
  });

  it('exposes the id as visible text, not only as a hover-only title tooltip', async () => {
    const t = createAssetsTable({
      ...deps(),
      apiFetch: fakeApi([
        { id: ULID, slug: SLUG, name: 'Clip', status: 'ready', createdAt: '2026-01-01T00:00:00Z' },
      ]),
      win: stubWin(),
    });
    document.body.appendChild(t.el);
    await tick();

    const idCell = cellFor(t.el, 'ID');
    // AC3 (part 1): the id is readable/selectable without hovering — it is the
    // cell's own text. No element in the cell hides it behind `title`.
    expect(idCell.textContent).toContain(ULID);
    [...idCell.querySelectorAll('[title]')].forEach((el) => {
      expect(el.getAttribute('title')).not.toBe(ULID);
    });
  });

  it('offers a click-to-copy button carrying the ULID that does not open the row', async () => {
    const onRowClick = vi.fn();
    const t = createAssetsTable({
      ...deps(),
      apiFetch: fakeApi([
        { id: ULID, slug: SLUG, name: 'Clip', status: 'ready', createdAt: '2026-01-01T00:00:00Z' },
      ]),
      onRowClick,
      win: stubWin(),
    });
    document.body.appendChild(t.el);
    await tick();

    const btn = cellFor(t.el, 'ID').querySelector('.' + COPY_ID_BTN_CLASS) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    // AC3 (part 2): the copy affordance copies the id, not the slug.
    expect(btn.dataset.copyId).toBe(ULID);

    btn.dispatchEvent(new Event('click', { bubbles: true }));
    // Copying an id must not also open that row's detail panel.
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('renders an em-dash slug for a slug-less asset and still shows its ULID', async () => {
    const t = createAssetsTable({
      ...deps(),
      apiFetch: fakeApi([
        { id: ULID, name: 'Legacy', status: 'ready', createdAt: '2026-01-01T00:00:00Z' },
      ]),
      win: stubWin(),
    });
    document.body.appendChild(t.el);
    await tick();

    expect(cellFor(t.el, 'ID').textContent).toContain(ULID);
    expect((cellFor(t.el, 'Slug').textContent || '').trim()).toBe('—');
  });
});

describe('copyable id cell helper (issue #851)', () => {
  it('writes the id to the clipboard and reports it on the button', async () => {
    const host = document.createElement('div');
    host.innerHTML = copyableIdCellHtml(ULID, 'Copy asset id');
    document.body.appendChild(host);

    const writeText = vi.fn(async () => {});
    wireCopyIdButtons(host, { nav: { clipboard: { writeText } } as unknown as Navigator });

    const btn = host.querySelector('.' + COPY_ID_BTN_CLASS) as HTMLButtonElement;
    btn.click();
    expect(writeText).toHaveBeenCalledWith(ULID);
    await vi.waitFor(() => expect(btn.textContent).toBe('Copied'));
  });

  it('degrades without a clipboard API — the value stays selectable text', () => {
    const host = document.createElement('div');
    host.innerHTML = copyableIdCellHtml(ULID, 'Copy asset id');
    document.body.appendChild(host);

    wireCopyIdButtons(host, { nav: {} as Navigator });
    const btn = host.querySelector('.' + COPY_ID_BTN_CLASS) as HTMLButtonElement;
    btn.click();
    expect(btn.textContent).toBe('Select to copy');
    expect(host.textContent).toContain(ULID);
  });

  it('is idempotent across re-renders (one copy per click, not N)', () => {
    const host = document.createElement('div');
    host.innerHTML = copyableIdCellHtml(ULID, 'Copy asset id');
    document.body.appendChild(host);

    const writeText = vi.fn(async () => {});
    const nav = { clipboard: { writeText } } as unknown as Navigator;
    wireCopyIdButtons(host, { nav });
    wireCopyIdButtons(host, { nav });

    (host.querySelector('.' + COPY_ID_BTN_CLASS) as HTMLButtonElement).click();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('escapes hostile values in both the text and the copy attribute (XSS posture)', () => {
    const hostile = '"><img src=x onerror=alert(1)>';
    const html = copyableIdCellHtml(hostile, 'Copy asset id');
    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;&gt;&lt;img');

    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('img')).toBeNull();
    expect(
      (host.querySelector('.' + COPY_ID_BTN_CLASS) as HTMLButtonElement).dataset.copyId
    ).toBe(hostile);
  });

  it('renders an em-dash for a missing slug', () => {
    const host = document.createElement('div');
    host.innerHTML = slugCellHtml(undefined);
    expect((host.textContent || '').trim()).toBe('—');
  });
});

describe('asset detail pane — the ULID is copyable, not retyped (issue #851)', () => {
  it('puts a copy button carrying the ULID on the detail pane ULID row', async () => {
    vi.resetModules();
    const asset = { id: ULID, slug: SLUG, title: 'Clip', status: 'ready', mimeType: 'video/mp4' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
        if (path === '/assets/' + ULID) {
          return new Response(JSON.stringify(asset), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      })
    );

    const { renderAssetDetailBody } = await import('../public/app.js');
    const body = document.createElement('div');
    document.body.appendChild(body);
    await renderAssetDetailBody(ULID, body);
    await vi.waitFor(() => expect(body.querySelector('.kv-grid')).not.toBeNull());

    const btn = body.querySelector('.' + COPY_ID_BTN_CLASS) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.dataset.copyId).toBe(ULID);
    // The slug keeps its place in the pane; it is just not the copyable id.
    expect(body.textContent).toContain(SLUG);
  });
});
