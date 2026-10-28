// @vitest-environment happy-dom
//
// Issue #828 — the ops UI must say WHICH BUILD of the API it is talking to.
//
// CONTRACT GROUNDING (verified before this suite was written, not assumed):
//   - `GET /health` is registered by `healthRouter` (src/routes/health.ts:107);
//     it is NOT under the /api/v1 prefix (src/main.ts:350) and is
//     unauthenticated by design (src/routes/health.ts:17-32).
//   - Its 200 body is `healthResponseSchema` (src/routes/health.ts:71). The
//     build identity lives on `build`, typed by `buildInfoSchema`
//     (src/routes/health.ts:55, added by issue #827): REQUIRED fields
//     `version`, `commit`, `sourceDigest`, `builtAt` (nullable), and
//     `packageVersion`. The same shape is in openapi.json at
//     `paths./health.get.responses.200.content.application/json.schema
//      .properties.build`.
//
// This suite imports `healthResponseSchema` from the server route and parses the
// fixture through it, so the payload the UI is tested against is the payload the
// server is actually able to produce. If #827's schema changes, this fails here
// rather than drifting silently in the browser.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthResponseSchema } from '../src/routes/health.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, '../public/index.html'), 'utf8');
const detailHtml = readFileSync(join(here, '../public/detail.html'), 'utf8');

// A realistic /health body, validated against the SERVER's own Zod schema so the
// fixture cannot drift from the contract.
const HEALTH_BODY = healthResponseSchema.parse({
  status: 'ok',
  service: 'open-videocore-api',
  build: {
    version: 'v1.5.0-56-g92a13cc',
    commit: '92a13cc4f1b2c3d4e5f60718293a4b5c6d7e8f90',
    sourceDigest: 'sha256:abc123def456',
    builtAt: '2026-10-20T11:22:33.000Z',
    packageVersion: '1.6.0',
  },
  resolver: {
    degraded: false,
    mode: 'none',
    noStorageFallbackTotal: 0,
    staleFallbackTotal: 0,
    lastDegradedAt: null,
  },
  ingest: {
    directUpload: { available: true },
    urlPull: { available: true },
    watchFolder: { available: false, reason: 'not-enabled' },
  },
});

function mount(html: string, search: string): void {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyClass = (html.match(/<body([^>]*)>/i) || [, ''])[1];
  document.documentElement.innerHTML = `<head></head><body${bodyClass}>${bodyMatch![1]}</body>`;
  // Strip module <script>s; the tests import the modules explicitly so they can
  // control fetch timing.
  document.querySelectorAll('script').forEach((s) => s.remove());
  window.history.replaceState(null, '', search);
}

// Answers /health with HEALTH_BODY and anything else with 404, so the detail
// renderers degrade instead of hanging.
function stubFetch(healthBody: unknown = HEALTH_BODY, healthStatus = 200) {
  return vi.fn(async (url: string) => {
    const path = new URL(url, window.location.origin).pathname;
    if (path === '/health') {
      return new Response(JSON.stringify(healthBody), {
        status: healthStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.innerHTML = '';
});

describe('build-info module — contract + formatting (issue #828)', () => {
  it('reads the build identity from /health, not from a baked-in constant', async () => {
    const mod = await import('../public/build-info.js');
    const fetchImpl = stubFetch();

    const build = await mod.fetchBuildInfo(fetchImpl as unknown as typeof fetch);

    // It asked the running deployment, at the root path (NOT /api/v1/health).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requested = new URL((fetchImpl.mock.calls[0] as unknown[])[0] as string);
    expect(requested.pathname).toBe('/health');
    // ...and must never be served from cache: the process may have been
    // replaced since the last page view.
    expect((fetchImpl.mock.calls[0] as unknown[])[1]).toMatchObject({ cache: 'no-store' });

    // The exact fields from buildInfoSchema came back through.
    expect(build).toEqual(HEALTH_BODY.build);

    // Requirement 4: nothing resembling a version is hard-coded in the asset.
    // Comments are stripped first — the module documents the contract with an
    // EXAMPLE version string, and that prose is not a fallback value.
    const code = readFileSync(join(here, '../public/build-info.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bv?\d+\.\d+\.\d+/);
  });

  it('shows the git-describe version short, and every field in the details', () => {
    const b = HEALTH_BODY.build;
    return import('../public/build-info.js').then((mod) => {
      // Short label is `version` — the git-describe identity. NOT packageVersion:
      // two images from different commits on one release line share that value
      // and so could not be told apart.
      expect(mod.formatBuildLabel(b)).toBe('v1.5.0-56-g92a13cc');
      expect(mod.formatBuildLabel(b)).not.toBe(b.packageVersion);

      const details = mod.formatBuildDetails(b, 'prod-stack');
      for (const v of [b.version, b.commit, b.sourceDigest, b.builtAt!, b.packageVersion]) {
        expect(details).toContain(v);
      }
      expect(details).toContain('prod-stack');
    });
  });

  it('renders "unknown" rather than a plausible-looking version when /health fails', async () => {
    const mod = await import('../public/build-info.js');
    const build = await mod.fetchBuildInfo(stubFetch({}, 503) as unknown as typeof fetch);
    expect(build).toBeNull();
    expect(mod.formatBuildLabel(build)).toBe(mod.UNKNOWN_LABEL);
    expect(mod.formatBuildLabel(build)).not.toMatch(/\d+\.\d+/);
  });

  it('tolerates a /health body without a build block', async () => {
    const mod = await import('../public/build-info.js');
    const build = await mod.fetchBuildInfo(
      stubFetch({ status: 'ok', service: 'open-videocore-api' }) as unknown as typeof fetch
    );
    expect(build).toBeNull();
  });

  it('nullable builtAt renders as "unknown", never as the string "null"', async () => {
    const mod = await import('../public/build-info.js');
    // builtAt is `z.string().nullable()` in buildInfoSchema — null is a legal
    // value the server really does emit when the build stamp is absent.
    const details = mod.formatBuildDetails({ ...HEALTH_BODY.build, builtAt: null }, 's1');
    expect(details).toContain('built at: unknown');
    expect(details).not.toContain('null');
    expect(mod.formatConsoleLine({ ...HEALTH_BODY.build, builtAt: null }, 's1')).toContain(
      'built unknown'
    );
  });

  it('logs ONE console line on load with the full build details and the stack', async () => {
    const mod = await import('../public/build-info.js');
    const info = vi.fn();
    const mountEl = document.createElement('div');

    await mod.initBuildIndicator({
      mount: mountEl,
      stack: 'prod-stack',
      fetchImpl: stubFetch() as unknown as typeof fetch,
      console: { info },
    });

    expect(info).toHaveBeenCalledTimes(1);
    const line = String((info.mock.calls[0] as unknown[])[0]);
    const b = HEALTH_BODY.build;
    expect(line).toContain(b.version);
    expect(line).toContain(b.commit);
    expect(line).toContain(b.builtAt!);
    expect(line).toContain(b.packageVersion);
    expect(line).toContain('prod-stack');
    // One LINE, not a multi-line dump.
    expect(line).not.toContain('\n');
  });

  it('exposes the full details without hover and without devtools (a11y)', async () => {
    const mod = await import('../public/build-info.js');
    const mountEl = document.createElement('div');
    document.body.appendChild(mountEl);

    await mod.initBuildIndicator({
      mount: mountEl,
      stack: 'prod-stack',
      fetchImpl: stubFetch() as unknown as typeof fetch,
      console: { info: vi.fn() },
    });

    const btn = mountEl.querySelector('button.build-indicator-toggle') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    // Hover affordance...
    expect(btn.title).toContain(HEALTH_BODY.build.commit);
    // ...but ALSO a keyboard-operable disclosure, so the details are not
    // hover-only (WCAG 2.1.1 / 1.4.13).
    const panel = mountEl.querySelector('.build-indicator-details') as HTMLElement;
    expect(panel.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    btn.click();
    expect(panel.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(panel.textContent).toContain(HEALTH_BODY.build.sourceDigest);
    // The control has an accessible name beyond the bare version string.
    expect(btn.getAttribute('aria-label')).toMatch(/build/i);
  });
});

describe('main ops page shows the running build (issue #828)', () => {
  it('renders the version in the header, visible without devtools', async () => {
    mount(indexHtml, '/ui/index.html');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal('fetch', stubFetch());

    // index.html must provide the mount point...
    const mountEl = document.getElementById('build-indicator');
    expect(mountEl).not.toBeNull();
    // ...and it must be inside the real header chrome, not tucked in a
    // comment or a hidden node.
    expect(document.querySelector('header #build-indicator')).not.toBeNull();

    const mod = await import('../public/build-info.js');
    await mod.initBuildIndicator({ mount: mountEl!, stack: 'prod-stack' });

    // Rendered as readable text in the page.
    expect(mountEl!.textContent).toContain('v1.5.0-56-g92a13cc');
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]![0])).toContain('prod-stack');
  });

  it('ships no build identifier in the static HTML itself', () => {
    // Requirement 4: the value must come from the running deployment. If a
    // version string were ever templated into index.html, this fails.
    const headerRegion = indexHtml.replace(/<!--[\s\S]*?-->/g, '');
    expect(headerRegion).not.toMatch(/\bv?\d+\.\d+\.\d+(-\w+)?/);
  });
});

describe('detached detail window carries the same indicator (issue #828)', () => {
  it('mounts a build indicator in the pop-out context strip', async () => {
    mount(detailHtml, '/ui/detail.html?type=asset&id=abc123&stack=pop-stack');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal('fetch', stubFetch());

    // The pop-out shell provides its own mount point (its own realm) and keeps
    // the stack label alongside it.
    expect(document.querySelector('.detail-standalone-context #build-indicator')).not.toBeNull();
    expect(document.getElementById('detail-stack-label')).not.toBeNull();

    await import('../public/detail.js');

    await vi.waitFor(() => {
      const el = document.getElementById('build-indicator')!;
      expect(el.textContent).toContain('v1.5.0-56-g92a13cc');
    });

    // The pop-out logs its own single line, naming the stack it was pointed at
    // via ?stack= (not the opener's).
    await vi.waitFor(() => {
      expect(info).toHaveBeenCalled();
    });
    const buildLines = info.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('running build'));
    expect(buildLines).toHaveLength(1);
    expect(buildLines[0]).toContain('pop-stack');
  });

  it('still identifies the build when the pop-out params are invalid', async () => {
    // An operator screenshotting the "Not available" error must still be able
    // to say which build produced it.
    mount(detailHtml, '/ui/detail.html?type=nonsense');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal('fetch', stubFetch());

    await import('../public/detail.js');

    await vi.waitFor(() => {
      expect(document.getElementById('build-indicator')!.textContent).toContain(
        'v1.5.0-56-g92a13cc'
      );
    });
    // ...and the invalid-params path still reported itself.
    expect(document.getElementById('detail-root')!.textContent).toContain('Not available');
  });
});
