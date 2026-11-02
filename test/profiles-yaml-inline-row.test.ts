// @vitest-environment happy-dom
//
// DOM/unit tests for the per-profile YAML disclosure on the Profiles tab
// (issue #832).
//
// Before the fix, every row's View YAML button wrote into ONE shared
// `<div id="pf-yaml-view">` rendered below the whole table. With a full profile
// list the output landed off-screen, so the button read as dead; clicking a
// second profile silently replaced the first; and nothing could close the
// panel. The YAML now renders in a detail row inserted directly beneath the
// clicked profile row.
//
// ─── Contract grounding (verified before writing, per CLAUDE.md rule 7) ──────
//   - GET /api/v1/profiles — openapi.json .paths["/api/v1/profiles/"].get,
//     200 body { profiles: string[], items: { name, yaml, runnable, createdAt,
//     updatedAt }[] } (all five item fields required, additionalProperties
//     false). The list stub below uses exactly that envelope.
//   - GET /api/v1/profiles/{name} — openapi.json
//     .paths["/api/v1/profiles/{name}"].get, 200 body { name, yaml, runnable,
//     createdAt, updatedAt }; 404 body { error, message? }. The detail stub
//     uses exactly that shape.
//   Neither operation carries an operationId in openapi.json (both are null),
//   so the path + method is the identifying reference.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TAB_RENDERERS,
  wireProfileYamlToggles,
  createProfileYamlDetailRow,
  PROFILE_YAML_MAX_HEIGHT,
} from '../public/app.js';

const here = dirname(fileURLToPath(import.meta.url));
const STYLE_CSS = join(here, '../public/style.css');

/** One profile document as GET /api/v1/profiles/{name} returns it. */
function profileDoc(name: string, yaml: string) {
  return {
    name,
    yaml,
    runnable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

/** The 11-profile list the issue describes, `program-twopass` being the long one. */
const PROFILE_NAMES = [
  'program',
  'program-twopass',
  'preview',
  'preview-audio-only',
  'archive',
  'proxy',
  'thumbnail',
  'subtitle-burn',
  'loudnorm',
  'hdr-passthrough',
  'audio-only',
];

const LONG_YAML = Array.from({ length: 242 }, (_, i) => `  - line_${i}: value`).join('\n');

function yamlFor(name: string): string {
  return name === 'program-twopass' ? `name: ${name}\nencodes:\n${LONG_YAML}` : `name: ${name}\nencodes: []`;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Routes the two profile GETs this view makes; anything else is a test bug. */
function stubProfilesApi(overrides: Record<string, unknown> = {}) {
  fetchMock = vi.fn(async (url: string) => {
    const path = String(url);
    const detail = path.match(/\/profiles\/([^/?]+)$/);
    if (detail) {
      const name = decodeURIComponent(detail[1]);
      const yaml = (overrides[name] as string) ?? yamlFor(name);
      return jsonResponse(profileDoc(name, yaml));
    }
    if (/\/profiles\/?(\?|$)/.test(path)) {
      return jsonResponse({
        profiles: PROFILE_NAMES,
        items: PROFILE_NAMES.map((n) => profileDoc(n, yamlFor(n))),
      });
    }
    throw new Error('unexpected fetch: ' + path);
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** Renders the REAL Profiles tab and waits for the table to arrive. */
async function renderProfiles(): Promise<HTMLElement> {
  const container = document.createElement('div');
  container.id = 'content';
  document.body.appendChild(container);
  await TAB_RENDERERS['profiles'](container);
  await vi.waitFor(() => expect(container.querySelector('table tbody tr')).not.toBeNull());
  return container;
}

function profileRow(container: HTMLElement, name: string): HTMLTableRowElement {
  const row = container.querySelector<HTMLTableRowElement>(`tr.pf-row[data-name="${name}"]`);
  expect(row).not.toBeNull();
  return row!;
}

function viewBtn(container: HTMLElement, name: string): HTMLButtonElement {
  const btn = profileRow(container, name).querySelector<HTMLButtonElement>('.pf-view-btn');
  expect(btn).not.toBeNull();
  return btn!;
}

/** The detail row for `name`, if one is open. */
function detailRowFor(container: HTMLElement, name: string): HTMLTableRowElement | null {
  const next = profileRow(container, name).nextElementSibling;
  return next && next.classList.contains('pf-yaml-row') ? (next as HTMLTableRowElement) : null;
}

async function openYaml(container: HTMLElement, name: string): Promise<HTMLTableRowElement> {
  viewBtn(container, name).click();
  await vi.waitFor(() => expect(detailRowFor(container, name)).not.toBeNull());
  return detailRowFor(container, name)!;
}

beforeEach(() => {
  localStorage.clear();
  stubProfilesApi();
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── AC 1: the YAML appears adjacent to the clicked row ──────────────────────

describe('View YAML placement (issue #832)', () => {
  it('renders the YAML in a row immediately after the clicked profile row', async () => {
    const container = await renderProfiles();
    // A row deep in the list — the case where a container below the table was
    // off-screen.
    const row = await openYaml(container, 'subtitle-burn');

    expect(profileRow(container, 'subtitle-burn').nextElementSibling).toBe(row);
    expect(row.querySelector('pre')!.textContent).toBe(yamlFor('subtitle-burn'));
  });

  it('no longer renders a shared YAML container outside the table', async () => {
    const container = await renderProfiles();
    expect(container.querySelector('#pf-yaml-view')).toBeNull();

    await openYaml(container, 'program');
    // Every <pre> holding YAML is inside the table, not after it.
    const pres = Array.from(container.querySelectorAll('pre'));
    expect(pres.length).toBeGreaterThan(0);
    for (const pre of pres) expect(pre.closest('table')).not.toBeNull();
  });

  it('fetches the clicked profile from GET /api/v1/profiles/{name}', async () => {
    const container = await renderProfiles();
    await openYaml(container, 'program-twopass');

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith('/api/v1/profiles/program-twopass'))).toBe(true);
  });
});

// ─── AC 2: clicking again collapses ──────────────────────────────────────────

describe('toggling the disclosure', () => {
  it('collapses the detail row on a second click and restores the label', async () => {
    const container = await renderProfiles();
    const btn = viewBtn(container, 'preview');
    expect(btn.textContent).toBe('View YAML');

    await openYaml(container, 'preview');
    expect(btn.textContent).toBe('Hide YAML');
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    btn.click();

    expect(detailRowFor(container, 'preview')).toBeNull();
    expect(container.querySelectorAll('tr.pf-yaml-row').length).toBe(0);
    expect(btn.textContent).toBe('View YAML');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('can be closed from the detail row itself', async () => {
    const container = await renderProfiles();
    const row = await openYaml(container, 'archive');

    row.querySelector<HTMLButtonElement>('.pf-yaml-collapse-btn')!.click();

    expect(detailRowFor(container, 'archive')).toBeNull();
    expect(viewBtn(container, 'archive').getAttribute('aria-expanded')).toBe('false');
  });

  it('points aria-controls at the row it opened, and drops it when closed', async () => {
    const container = await renderProfiles();
    const btn = viewBtn(container, 'proxy');
    const row = await openYaml(container, 'proxy');

    expect(row.id).not.toBe('');
    expect(btn.getAttribute('aria-controls')).toBe(row.id);

    btn.click();
    expect(btn.hasAttribute('aria-controls')).toBe(false);
  });
});

// ─── AC 3: a second profile does not silently discard the first ──────────────

describe('opening more than one profile', () => {
  it('keeps both detail rows open, each under its own profile', async () => {
    const container = await renderProfiles();
    await openYaml(container, 'program');
    await openYaml(container, 'loudnorm');

    expect(container.querySelectorAll('tr.pf-yaml-row').length).toBe(2);
    expect(detailRowFor(container, 'program')!.querySelector('pre')!.textContent).toBe(yamlFor('program'));
    expect(detailRowFor(container, 'loudnorm')!.querySelector('pre')!.textContent).toBe(yamlFor('loudnorm'));
    expect(viewBtn(container, 'program').getAttribute('aria-expanded')).toBe('true');
    expect(viewBtn(container, 'loudnorm').getAttribute('aria-expanded')).toBe('true');
  });

  it('collapsing one leaves the other open', async () => {
    const container = await renderProfiles();
    await openYaml(container, 'program');
    await openYaml(container, 'loudnorm');

    viewBtn(container, 'program').click();

    expect(detailRowFor(container, 'program')).toBeNull();
    expect(detailRowFor(container, 'loudnorm')).not.toBeNull();
  });
});

// ─── AC 4: long profiles do not push the rest of the table out of reach ──────

describe('long profiles', () => {
  it('bounds the YAML in a scroll region instead of growing the row', async () => {
    const container = await renderProfiles();
    const row = await openYaml(container, 'program-twopass');
    const pre = row.querySelector<HTMLElement>('pre')!;

    // The full 242-line body is present…
    expect(pre.textContent!.split('\n').length).toBeGreaterThan(200);
    // …inside a height-bounded box.
    expect(pre.style.maxHeight).toBe(PROFILE_YAML_MAX_HEIGHT);
    expect(PROFILE_YAML_MAX_HEIGHT).toMatch(/^\d/);
    // The stylesheet makes that bound scrollable rather than clipped.
    const css = readFileSync(STYLE_CSS, 'utf8');
    const rule = css.match(/\.pf-yaml-pre\s*\{[\s\S]*?\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).toMatch(/overflow:\s*auto/);
  });

  it('keeps every following profile row in the table', async () => {
    const container = await renderProfiles();
    await openYaml(container, 'program-twopass');

    const names = Array.from(container.querySelectorAll('tr.pf-row')).map(
      (r) => (r as HTMLElement).dataset.name
    );
    expect(names).toEqual(PROFILE_NAMES);
  });

  it('makes the scroll region reachable by keyboard', async () => {
    const container = await renderProfiles();
    const pre = (await openYaml(container, 'program-twopass')).querySelector<HTMLElement>('pre')!;

    expect(pre.tabIndex).toBe(0);
    // Focusable scroll regions need an accessible name.
    expect(pre.getAttribute('aria-label')).toContain('program-twopass');
  });
});

// ─── AC 5: YAML stays text, never markup ─────────────────────────────────────

describe('YAML escaping', () => {
  const HOSTILE = 'name: x\ndescription: "<img src=x onerror=alert(1)>"\n<script>alert(2)</script>';

  it('renders hostile YAML as text, injecting no elements', async () => {
    vi.unstubAllGlobals();
    stubProfilesApi({ program: HOSTILE });
    const container = await renderProfiles();
    const row = await openYaml(container, 'program');

    expect(row.querySelector('pre')!.textContent).toBe(HOSTILE);
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('script')).toBeNull();
    // Serialised, the angle brackets are escaped — i.e. it went through
    // textContent, not innerHTML.
    expect(row.innerHTML).toContain('&lt;img');
    expect(row.innerHTML).not.toContain('<img');
  });

  it('escapes in the row builder itself, for any caller', () => {
    const row = createProfileYamlDetailRow({ name: 'p', yaml: HOSTILE }, 3, () => {});
    expect(row.querySelector('pre')!.textContent).toBe(HOSTILE);
    expect(row.querySelector('img')).toBeNull();
    expect(row.innerHTML).not.toContain('<img');
  });

  it('names the profile via textContent too', () => {
    const row = createProfileYamlDetailRow({ name: '<b>bold</b>', yaml: 'a: 1' }, 3, () => {});
    expect(row.querySelector('.pf-yaml-title')!.textContent).toBe('YAML — <b>bold</b>');
    expect(row.querySelector('b')).toBeNull();
  });
});

// ─── Failure + structure ─────────────────────────────────────────────────────

describe('wireProfileYamlToggles', () => {
  function table(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.innerHTML =
      '<table><thead><tr><th>Name</th><th>Updated</th><th>Actions</th></tr></thead><tbody>' +
      '<tr class="pf-row" data-name="a"><td>a</td><td>-</td><td>' +
      '<button class="pf-view-btn" data-name="a">View YAML</button></td></tr>' +
      '</tbody></table>';
    document.body.appendChild(wrap);
    return wrap;
  }

  it('reports a failed load inline, next to the row, as an alert', async () => {
    const wrap = table();
    wireProfileYamlToggles(wrap, async () => {
      throw new Error('HTTP 404');
    });
    wrap.querySelector<HTMLButtonElement>('.pf-view-btn')!.click();
    await vi.waitFor(() => expect(wrap.querySelector('tr.pf-yaml-row')).not.toBeNull());

    const row = wrap.querySelector('tr.pf-yaml-row')!;
    expect(row.previousElementSibling).toBe(wrap.querySelector('tr.pf-row'));
    const alert = row.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('HTTP 404');
    // And it is dismissible like a successful expand.
    row.querySelector<HTMLButtonElement>('.pf-yaml-collapse-btn')!.click();
    expect(wrap.querySelector('tr.pf-yaml-row')).toBeNull();
  });

  it('spans the detail cell across every table column', async () => {
    const wrap = table();
    wireProfileYamlToggles(wrap, async (name: string) => profileDoc(name, 'a: 1'));
    wrap.querySelector<HTMLButtonElement>('.pf-view-btn')!.click();
    await vi.waitFor(() => expect(wrap.querySelector('tr.pf-yaml-row')).not.toBeNull());

    const cell = wrap.querySelector<HTMLTableCellElement>('.pf-yaml-cell')!;
    expect(cell.colSpan).toBe(3);
  });

  it('ignores clicks while a load is in flight, opening exactly one row', async () => {
    const wrap = table();
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => {
      release = r;
    });
    wireProfileYamlToggles(wrap, async (name: string) => {
      await pending;
      return profileDoc(name, 'a: 1');
    });
    const btn = wrap.querySelector<HTMLButtonElement>('.pf-view-btn')!;
    btn.click();
    btn.click();
    btn.click();
    release(null);
    await vi.waitFor(() => expect(wrap.querySelector('tr.pf-yaml-row')).not.toBeNull());

    expect(wrap.querySelectorAll('tr.pf-yaml-row').length).toBe(1);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });
});
