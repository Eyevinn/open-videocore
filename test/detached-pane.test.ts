// @vitest-environment happy-dom
//
// Issue #128 — standalone minimal-chrome detached detail window.
//
// The detach ("pop-out") buttons open `detail.html?type=...&id=...&stack=...`
// (verified in test/detach-buttons.test.ts + public/app.js openDetailWindow).
// public/detail.html is that entrypoint and public/detail.js is its module.
//
// This suite boots detail.js the way the browser does — after loading the
// detail.html shell into the document and setting the pop-out URL params — and
// asserts:
//   1. The shell is MINIMAL CHROME: no global <header>, no .tab-bar / nav.
//   2. The reused #127 body-renderer (renderAssetDetailBody / renderJobDetailBody
//      from app.js) fills the pane for BOTH `type=asset` and `type=job`.
//   3. The window self-polls at the shared DETAIL_POLL_INTERVAL_MS via setInterval
//      (no bespoke polling loop is introduced in detail.js).
//
// detail.js runs boot() at import time, so each test uses vi.resetModules() and a
// fresh document + URL so the top-level entrypoint re-executes cleanly.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const detailHtml = readFileSync(join(here, '../public/detail.html'), 'utf8');
const DETAIL_POLL_INTERVAL_MS = 5000; // must match public/app.js

// Minimal payloads the reused renderers need to produce non-empty pane content.
const ASSET = { id: 'abc123', title: 'Clip One', status: 'ready', mimeType: 'video/mp4' };
const JOB = { id: 'job-9', type: 'transcode', status: 'running', createdAt: null, updatedAt: null };

// Extract the <body> markup from detail.html and mount it, then flip the URL to
// the pop-out contract (?type=&id=&stack=) before importing detail.js.
function mountShellWith(search: string): void {
  const bodyMatch = detailHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyClass = (detailHtml.match(/<body([^>]*)>/i) || [, ''])[1];
  document.documentElement.innerHTML = `<head></head><body${bodyClass}>${bodyMatch![1]}</body>`;
  // Strip the module <script> so happy-dom doesn't try to fetch/run it; we import
  // detail.js explicitly below to control timing and the mocked fetch.
  document.querySelectorAll('script').forEach((s) => s.remove());
  window.history.replaceState(null, '', '/ui/detail.html' + search);
}

// A fetch stub that answers the API paths the renderers hit.
function stubFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
    if (path in routes) {
      return new Response(JSON.stringify(routes[path]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Unknown sub-fetches (delivery, scaler status, executions) — 404 so the
    // renderer degrades gracefully instead of hanging.
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });
}

let setIntervalSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  setIntervalSpy = vi.spyOn(window, 'setInterval');
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.innerHTML = '';
});

describe('detached pane entrypoint (detail.html + detail.js) — issue #128', () => {
  it('renders MINIMAL CHROME: no global header / tab bar / nav', () => {
    mountShellWith('?type=asset&id=abc123&stack=mystack');
    // The pop-out shell must not carry the full ops chrome.
    expect(document.querySelector('header')).toBeNull();
    expect(document.querySelector('.tab-bar')).toBeNull();
    expect(document.querySelector('.header-nav')).toBeNull();
    // But it must provide the detail mount point the renderers write into.
    expect(document.getElementById('detail-root')).not.toBeNull();
  });

  it('fills the pane for type=asset using the reused renderer + self-polls', async () => {
    mountShellWith('?type=asset&id=abc123&stack=mystack');
    vi.stubGlobal('fetch', stubFetch({ '/assets/abc123': ASSET }));

    await import('../public/detail.js');
    // Let the initial tick() microtasks/fetches settle.
    await vi.waitFor(() => {
      expect(document.querySelector('.kv-grid')).not.toBeNull();
    });

    // The reused renderer wrote the asset id into the pane.
    expect(document.getElementById('detail-body')!.textContent).toContain('abc123');
    // Self-poll wired at the shared interval (not a bespoke loop).
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), DETAIL_POLL_INTERVAL_MS);
  });

  it('fills the pane for type=job using the reused renderer', async () => {
    mountShellWith('?type=job&id=job-9&stack=mystack');
    vi.stubGlobal('fetch', stubFetch({ '/jobs/job-9': JOB }));

    await import('../public/detail.js');
    await vi.waitFor(() => {
      expect(document.querySelector('.kv-grid')).not.toBeNull();
    });

    expect(document.getElementById('detail-body')!.textContent).toContain('job-9');
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), DETAIL_POLL_INTERVAL_MS);
  });

  it('shows a fatal message (and does not poll) for missing/invalid params', async () => {
    mountShellWith('?type=nonsense');
    vi.stubGlobal('fetch', stubFetch({}));

    await import('../public/detail.js');

    expect(document.getElementById('detail-root')!.textContent).toMatch(/Missing or invalid/i);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
