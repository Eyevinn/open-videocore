// @vitest-environment happy-dom
//
// DOM/unit tests for ops-UI tab routing (issue #823).
//
// The Logs tab was rendered, clickable and backed by a complete renderer, but
// `'logs'` was absent from the TABS allowlist, so `switchTab` hit its guard and
// returned silently — no view change, no error, no console output. These tests
// lock the three lists that must agree (rendered buttons / allowlist /
// renderer registry) and prove a disagreement is reported rather than dropped.
//
// ─── Contract grounding (verified before writing, per CLAUDE.md rule 7) ───────
//   - Rendered tab buttons: public/index.html:22-32, `.tab-btn[data-tab]` —
//     11 buttons, `data-tab="logs"` at index.html:24. The test reads the real
//     file rather than restating the markup, so it cannot drift.
//   - Allowlist: `TABS` (public/app.js:1159 pre-fix) and the guard
//     `if (!TABS.includes(name)) return;` (public/app.js:1174-1175 pre-fix).
//   - Role gate: `ROLE_GATED_TABS = { storage: canManageStorage }`
//     (public/app.js:1167 pre-fix); `getClientRole()` defaults to 'admin'
//     (public/app.js:68-71), so Storage is visible unless a test sets a viewer.
//   - Renderer registry: `TAB_RENDERERS['logs'] = renderLogsTab`
//     (public/app.js:5057 pre-fix); `renderLogsTab` at app.js:5025 pre-fix.
//   - Logs endpoint the Logs view calls: GET /api/v1/logs/ —
//     openapi.json .paths["/api/v1/logs/"].get, 200 envelope
//     { items: LogRecord[], nextCursor: string|null }. Stubbed with exactly
//     that shape (the empty page the issue observed live).
//
// Line numbers above are the pre-fix `main` (92a13cc) positions cited in the
// issue's correction comment; the symbols, not the lines, are the contract.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TABS,
  TAB_RENDERERS,
  switchTab,
  setupTabs,
  auditTabWiring,
  reportTabWiring,
  TAB_KEY,
  setClientRole,
} from '../public/app.js';

const here = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(here, '../public/index.html');

/** The `.tab-bar` markup exactly as public/index.html ships it. */
function indexTabBarHtml(): string {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const m = html.match(/<nav class="tab-bar">[\s\S]*?<\/nav>/);
  if (!m) throw new Error('could not find .tab-bar in public/index.html');
  return m[0];
}

/** The data-tab names public/index.html actually renders, in document order. */
function renderedTabNames(): string[] {
  return Array.from(indexTabBarHtml().matchAll(/data-tab="([^"]+)"/g)).map((m) => m[1]);
}

/** Mount the real tab bar + #content container, as the main page does. */
function mountOpsShell(): void {
  document.body.innerHTML = indexTabBarHtml() + '<main><div id="content"></div></main>';
}

/** GET /api/v1/logs/ 200 envelope, per the OpenAPI response schema. */
function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  fetchMock = vi.fn(async () => jsonResponse({ items: [], nextCursor: null }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── The regression itself ───────────────────────────────────────────────────

describe('TABS allowlist (issue #823)', () => {
  it('includes every tab public/index.html renders', () => {
    const rendered = renderedTabNames();
    // Sanity: the fixture really is reading the shipped markup.
    expect(rendered).toContain('logs');
    expect(rendered.length).toBeGreaterThan(1);

    const missing = rendered.filter((name) => !TABS.includes(name));
    expect(missing).toEqual([]);
  });

  it("includes 'logs' — the entry whose absence made the tab inert", () => {
    expect(TABS).toContain('logs');
  });

  it('has a registered renderer for every allowlisted tab', () => {
    const unrendered = TABS.filter((name: string) => typeof TAB_RENDERERS[name] !== 'function');
    expect(unrendered).toEqual([]);
  });
});

// ─── Acceptance criterion 1: clicking Logs renders the logs view ─────────────

describe('clicking the Logs tab', () => {
  it('activates the button and renders the logs view with its header and Refresh button', () => {
    mountOpsShell();
    setupTabs();

    const logsBtn = document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="logs"]');
    expect(logsBtn).not.toBeNull();
    // The button is visible and wired, not role-gated away.
    expect(logsBtn!.style.display).not.toBe('none');

    logsBtn!.click();

    // The button is now the active one, and only it.
    const active = Array.from(document.querySelectorAll('.tab-btn.active')).map(
      (b) => (b as HTMLElement).dataset.tab
    );
    expect(active).toEqual(['logs']);

    // The view rendered: header title + Refresh control + the logs table.
    const content = document.getElementById('content')!;
    expect(content.innerHTML).not.toBe('');
    expect(content.querySelector('.section-title')!.textContent).toBe('Logs');
    expect(content.querySelector('#logs-refresh')).not.toBeNull();
    expect(content.querySelector('table')).not.toBeNull();

    // And it is persisted as the active tab.
    expect(localStorage.getItem(TAB_KEY)).toBe('logs');
  });

  it('loads the logs page from GET /api/v1/logs on render', async () => {
    mountOpsShell();
    setupTabs();
    document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="logs"]')!.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/v1/logs?');
  });

  // Acceptance criterion 2: Refresh reloads the table.
  it('re-fetches the logs page when Refresh is clicked', async () => {
    mountOpsShell();
    setupTabs();
    document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="logs"]')!.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Wait for the FIRST load to settle before pressing Refresh: the table's
    // reload() has a `loading` re-entrancy guard (public/logs-table.js:335), so
    // a click landing mid-flight is dropped by design, not by this defect.
    const content = document.getElementById('content')!;
    await vi.waitFor(() => expect(content.textContent).toContain('No log entries'));

    const before = fetchMock.mock.calls.length;
    document.querySelector<HTMLButtonElement>('#logs-refresh')!.click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('/api/v1/logs?');
  });

  it('routes to Logs from a persisted TAB_KEY across a reload', () => {
    mountOpsShell();
    localStorage.setItem(TAB_KEY, 'logs');
    setupTabs();
    switchTab(localStorage.getItem(TAB_KEY) || 'assets');

    expect(document.querySelector('#content .section-title')!.textContent).toBe('Logs');
  });
});

// ─── Acceptance criterion 3: unroutable tabs are reported, not ignored ───────

describe('startup tab-wiring audit', () => {
  it('reports nothing for the shipped tab bar', () => {
    mountOpsShell();
    expect(auditTabWiring(document)).toEqual([]);
  });

  it('reports a rendered button that has no allowlist entry', () => {
    mountOpsShell();
    const stray = document.createElement('button');
    stray.className = 'tab-btn';
    stray.dataset.tab = 'not-a-real-tab';
    document.querySelector('.tab-bar')!.appendChild(stray);

    expect(auditTabWiring(document)).toContainEqual({
      tab: 'not-a-real-tab',
      inAllowlist: false,
      hasRenderer: false,
    });
  });

  it('reports an allowlisted tab whose renderer is not registered', () => {
    mountOpsShell();
    const saved = TAB_RENDERERS['logs'];
    delete TAB_RENDERERS['logs'];
    try {
      expect(auditTabWiring(document)).toContainEqual({
        tab: 'logs',
        inAllowlist: true,
        hasRenderer: false,
      });
    } finally {
      TAB_RENDERERS['logs'] = saved;
    }
  });

  it('logs loudly — the silence is what hid the defect', () => {
    mountOpsShell();
    const stray = document.createElement('button');
    stray.className = 'tab-btn';
    stray.dataset.tab = 'not-a-real-tab';
    document.querySelector('.tab-bar')!.appendChild(stray);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportTabWiring(document);
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0][0])).toContain('not-a-real-tab');
    expect(String(spy.mock.calls[0][0])).toContain('TABS allowlist');
  });

  it('is run by setupTabs at startup', () => {
    mountOpsShell();
    const stray = document.createElement('button');
    stray.className = 'tab-btn';
    stray.dataset.tab = 'not-a-real-tab';
    document.querySelector('.tab-bar')!.appendChild(stray);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setupTabs();
    expect(
      spy.mock.calls.some((c) => String(c[0]).includes('not-a-real-tab'))
    ).toBe(true);
  });
});

describe('switchTab on an unknown name', () => {
  it('reports and falls back to assets instead of returning silently', () => {
    mountOpsShell();
    setupTabs();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    switchTab('not-a-real-tab');

    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0][0])).toContain('not-a-real-tab');
    expect(localStorage.getItem(TAB_KEY)).toBe('assets');
    expect(document.getElementById('content')!.innerHTML).not.toBe('');
  });
});

// ─── Role gating must remain intact (issue #680) ─────────────────────────────

describe('role gating is unchanged by the allowlist fix', () => {
  it('hides Storage for a viewer but leaves Logs visible and routable', () => {
    mountOpsShell();
    setClientRole('viewer');
    setupTabs();

    const storageBtn = document.querySelector<HTMLElement>('.tab-btn[data-tab="storage"]')!;
    const logsBtn = document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="logs"]')!;
    expect(storageBtn.style.display).toBe('none');
    expect(storageBtn.getAttribute('aria-hidden')).toBe('true');
    expect(logsBtn.style.display).not.toBe('none');

    logsBtn.click();
    expect(document.querySelector('#content .section-title')!.textContent).toBe('Logs');
  });

  it('still falls back to assets when a viewer routes to the gated storage tab', () => {
    mountOpsShell();
    setClientRole('viewer');
    setupTabs();

    switchTab('storage');
    expect(localStorage.getItem(TAB_KEY)).toBe('assets');
  });
});
