// @vitest-environment happy-dom
//
// DOM/unit tests for the Storage-tab watch-folder toggle suppression on
// deployments where the watch-folder service is not configured (issue #871).
//
// Before this change the toggle was rendered off the PER-BUCKET status route,
// which cannot tell "no watch-folder service on this deployment" from
// "service present but idle" — so the control was offered unconditionally and
// the only way to learn the feature was unavailable was to press it and read the
// 501. These tests drive the REAL renderer (the same function openBucketBrowser
// calls) against a stubbed fetch and pin: suppressed when /health says
// unavailable, unchanged when it says available, fail-open when /health cannot
// be read, and the on-click 501 backstop still intact.
//
// Verified contract (per CLAUDE.md rule 7):
//   - GET /health — the only `get` under the `/health` path in openapi.json;
//     handler `healthRouter`, src/routes/health.ts. 200 body
//     `healthResponseSchema` (src/routes/health.ts:96). The member read here is
//     `ingest.watchFolder`, of `ingestMethodSchema` (src/routes/health.ts:36-41):
//       { available: boolean, reason?: 'no-storage-endpoint' | 'not-enabled'
//                                     | 'missing-storage-endpoint' }
//     `reason` is optional and present only when unavailable; the closed set is
//     `IngestUnavailableReason` in src/services/ingest-availability.ts, and the
//     watch-folder member is classified by `watchFolderMethod` there.
//     Mirrored in openapi.json: paths./health.get.responses.200.content.
//     "application/json".schema.properties.ingest.properties.watchFolder
//     (required: ["available"], reason enum exactly the three values above).
//     /health is unauthenticated and NOT under the /api/v1 prefix
//     (src/main.ts:380), hence the root-relative URL asserted below.
//   - GET /api/v1/storage/buckets/{bucket}/watch-folder — src/routes/storage.ts:642,
//     200 body `watchFolderBucketSchema` (src/routes/storage.ts:125):
//       { enabled: boolean, running: boolean, bucket: string }
//   - POST /api/v1/storage/buckets/{bucket}/watch-folder/toggle —
//     src/routes/storage.ts:668. 200 the same `watchFolderBucketSchema`;
//     501 `errorSchema` with body
//       { error: 'not_configured', message: 'watch-folder service is not configured' }
//     (src/routes/storage.ts:678-682) — the backstop this change keeps.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderWatchFolderToggle,
  fetchWatchFolderAvailability,
  watchFolderUnavailableText,
  WATCH_FOLDER_UNAVAILABLE_COPY,
  WATCH_FOLDER_UNAVAILABLE_FALLBACK,
  watchFolderSuppressed,
  WATCH_FOLDER_FATAL_REASONS,
  resetWatchFolderAvailabilityCache,
} from '../public/app.js';

type IngestMethod = { available: boolean; reason?: string };

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Minimal /health body: only the member under test is populated. The renderer
// reads `ingest.watchFolder` and nothing else, so the other members of
// healthResponseSchema are irrelevant here and left out deliberately.
function healthBody(watchFolder: IngestMethod) {
  return { ingest: { directUpload: { available: true }, urlPull: { available: true }, watchFolder } };
}

// Routes the two (or three) URLs this flow touches. `calls` records every
// request URL so a test can assert what was NOT requested.
function stubFetch(handlers: {
  health?: () => Response | Promise<Response>;
  bucketStatus?: () => Response | Promise<Response>;
  toggle?: () => Response | Promise<Response>;
}) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push((init?.method || 'GET') + ' ' + url);
    if (url.endsWith('/health')) {
      if (!handlers.health) throw new Error('unexpected /health request');
      return handlers.health();
    }
    if (url.endsWith('/watch-folder/toggle')) {
      if (!handlers.toggle) throw new Error('unexpected toggle request');
      return handlers.toggle();
    }
    if (url.endsWith('/watch-folder')) {
      if (!handlers.bucketStatus) throw new Error('unexpected bucket-status request');
      return handlers.bucketStatus();
    }
    throw new Error('unrouted request: ' + url);
  });
  vi.stubGlobal('fetch', impl);
  return { calls, impl };
}

function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// The deployment-level /health read is memoised at module level, so every test
// must start from an unread signal — otherwise the first deployment shape
// rendered in this file would be reused by all the later ones.
afterEach(() => {
  resetWatchFolderAvailabilityCache();
});

// ─── The reason copy ─────────────────────────────────────────────────────────

describe('watchFolderUnavailableText (issue #871 reason copy)', () => {
  it('covers exactly the three reasons the contract can report', () => {
    // Guard against the copy map drifting from `IngestUnavailableReason`
    // (src/services/ingest-availability.ts) / the openapi reason enum.
    expect(Object.keys(WATCH_FOLDER_UNAVAILABLE_COPY).sort()).toEqual([
      'missing-storage-endpoint',
      'no-storage-endpoint',
      'not-enabled',
    ]);
  });

  it('tells a disabled flag apart from a missing storage endpoint', () => {
    const notEnabled = watchFolderUnavailableText('not-enabled');
    const missingEndpoint = watchFolderUnavailableText('missing-storage-endpoint');
    const noEndpoint = watchFolderUnavailableText('no-storage-endpoint');

    expect(notEnabled).not.toBe(missingEndpoint);
    expect(notEnabled).not.toBe(noEndpoint);
    expect(missingEndpoint).not.toBe(noEndpoint);

    // The flag case names the flag; the provisioning cases say they are a
    // provisioning gap rather than something to switch on.
    expect(notEnabled).toContain('WATCH_FOLDER_ENABLED');
    expect(notEnabled).toContain('configuration flag');
    expect(missingEndpoint).toContain('provisioning gap');
    expect(noEndpoint).toContain('provisioning gap');
  });

  it('falls back to a plain statement for an absent or unknown reason', () => {
    expect(watchFolderUnavailableText(undefined)).toBe(WATCH_FOLDER_UNAVAILABLE_FALLBACK);
    // A value added to the enum after this build must still produce text.
    expect(watchFolderUnavailableText('some-future-reason')).toBe(
      WATCH_FOLDER_UNAVAILABLE_FALLBACK
    );
  });
});

// ─── Reading the signal ──────────────────────────────────────────────────────

describe('fetchWatchFolderAvailability (issue #871 /health read)', () => {
  it('reads ingest.watchFolder from the root-relative, unauthenticated /health', async () => {
    const { calls } = stubFetch({
      health: () => jsonResponse(healthBody({ available: false, reason: 'not-enabled' })),
    });

    await expect(fetchWatchFolderAvailability()).resolves.toEqual({
      available: false,
      reason: 'not-enabled',
    });
    // Not under /api/v1 — src/main.ts:380 registers healthRouter at the root.
    expect(calls).toEqual(['GET ' + window.location.origin + '/health']);
  });

  it('returns null — "cannot tell" — on a non-2xx, a throw, or a body without the block', async () => {
    stubFetch({ health: () => jsonResponse({ error: 'nope' }, 503) });
    await expect(fetchWatchFolderAvailability()).resolves.toBeNull();

    vi.unstubAllGlobals();
    stubFetch({
      health: () => {
        throw new Error('network down');
      },
    });
    await expect(fetchWatchFolderAvailability()).resolves.toBeNull();

    vi.unstubAllGlobals();
    stubFetch({ health: () => jsonResponse({ status: 'ok' }) });
    await expect(fetchWatchFolderAvailability()).resolves.toBeNull();
  });
});

// ─── Suppression ─────────────────────────────────────────────────────────────

describe('renderWatchFolderToggle with the service unavailable (issue #871)', () => {
  it('renders a disabled control that states why, and makes no per-bucket request', async () => {
    const { calls } = stubFetch({
      health: () => jsonResponse(healthBody({ available: false, reason: 'not-enabled' })),
    });
    const el = mount();

    await renderWatchFolderToggle(el, 'ovc-source');

    const btn = el.querySelector('button') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
    // Visibly unavailable in text, not by colour alone (WCAG 1.4.1).
    expect(btn.textContent).toContain('unavailable');

    // The explanation is persistent text tied to the control, so it is announced
    // on focus and readable without hovering.
    const noteId = btn.getAttribute('aria-describedby') as string;
    expect(noteId).toBeTruthy();
    const note = el.querySelector('#' + noteId) as HTMLElement;
    expect(note).toBeTruthy();
    expect(note.textContent).toBe(watchFolderUnavailableText('not-enabled'));

    // Only /health was asked. The per-bucket status route cannot answer this
    // question, so it is not called.
    expect(calls).toEqual(['GET ' + window.location.origin + '/health']);
  });

  it('shows the provisioning reason when the flag is on but no endpoint is configured', async () => {
    stubFetch({
      health: () =>
        jsonResponse(healthBody({ available: false, reason: 'missing-storage-endpoint' })),
    });
    const el = mount();

    await renderWatchFolderToggle(el, 'ovc-source');

    const note = el.querySelector('[id="storage-watch-folder-unavailable"]') as HTMLElement;
    expect(note.textContent).toBe(watchFolderUnavailableText('missing-storage-endpoint'));
    expect(note.textContent).not.toBe(watchFolderUnavailableText('not-enabled'));
  });

  it('issues no request when the disabled control is clicked', async () => {
    const { calls } = stubFetch({
      health: () => jsonResponse(healthBody({ available: false, reason: 'not-enabled' })),
    });
    const el = mount();

    await renderWatchFolderToggle(el, 'ovc-source');
    const before = calls.length;

    const btn = el.querySelector('button') as HTMLButtonElement;
    btn.click();
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    expect(calls.length).toBe(before);
  });
});

// ─── The configured path is unchanged ────────────────────────────────────────

describe('renderWatchFolderToggle with the service available (issue #871 regression guard)', () => {
  it('renders the live toggle off the per-bucket status, exactly as before', async () => {
    const { calls } = stubFetch({
      health: () => jsonResponse(healthBody({ available: true })),
      bucketStatus: () =>
        jsonResponse({ enabled: true, running: true, bucket: 'ovc-source' }),
    });
    const el = mount();

    await renderWatchFolderToggle(el, 'ovc-source');

    const btn = el.querySelector('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('Disable watch folder');
    expect(el.querySelector('#storage-watch-folder-unavailable')).toBeNull();
    expect(calls).toContain(
      'GET ' + window.location.origin + '/api/v1/storage/buckets/ovc-source/watch-folder'
    );
  });

  it('fails open: an unreadable /health leaves the toggle offered', async () => {
    stubFetch({
      health: () => {
        throw new Error('health unreachable');
      },
      bucketStatus: () =>
        jsonResponse({ enabled: false, running: false, bucket: 'ovc-source' }),
    });
    const el = mount();

    await renderWatchFolderToggle(el, 'ovc-source');

    const btn = el.querySelector('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('Enable watch folder');
    expect(btn.textContent).not.toContain('unavailable');
  });

  it('keeps the on-click 501 as the backstop for a configuration change after render', async () => {
    // /health said available at render time; by the time the operator clicks,
    // the service is gone and the toggle route answers 501. The pre-existing
    // error path must still report it.
    const { calls } = stubFetch({
      health: () => jsonResponse(healthBody({ available: true })),
      bucketStatus: () =>
        jsonResponse({ enabled: false, running: false, bucket: 'ovc-source' }),
      toggle: () =>
        jsonResponse(
          { error: 'not_configured', message: 'watch-folder service is not configured' },
          501
        ),
    });
    const el = mount();

    await renderWatchFolderToggle(el, 'ovc-source');
    const btn = el.querySelector('button') as HTMLButtonElement;
    btn.click();
    await flush();

    expect(calls).toContain(
      'POST ' + window.location.origin + '/api/v1/storage/buckets/ovc-source/watch-folder/toggle'
    );
    const err = el.querySelector('.msg-error') as HTMLElement;
    expect(err).toBeTruthy();
    expect(err.textContent).toContain('watch-folder service is not configured');
    // Re-enabled so the operator can retry once configuration is restored.
    expect(btn.disabled).toBe(false);
  });
});

// ─── Only a stack-independent reason may hide the control ────────────────────
//
// `ingest.watchFolder.available` is derived from the presence of a single global
// storage endpoint alone — src/main.ts:383-386 passes
// `hasEnvMinio: Boolean(process.env['MINIO_URL'])` into the health router and
// `watchFolderMethod` (src/services/ingest-availability.ts) reports
// `missing-storage-endpoint` whenever the opt-in flag is on without it. The
// watcher is nevertheless wired from each PROVISIONED STACK's own storage
// connection (`wireWatchFolderFromStack`, src/main.ts:3178, reconciling via
// src/services/watch-folder-wiring.ts, issue #1099) and rebinds the shared
// `watchFolder` that `currentWatchFolder()` (src/routes/storage.ts:275) returns
// to the status and toggle handlers (src/routes/storage.ts:651, 671). So
// `available: false` is NOT sufficient grounds to disable the control;
// `not-enabled` is, because both wiring paths check the same flag
// (src/main.ts:3145 and the first line of wireWatchFolderFromStack).

describe('watchFolderSuppressed (issue #871 suppression gate)', () => {
  it('suppresses on the opt-in flag only, never on a stack-dependent reason', () => {
    expect(WATCH_FOLDER_FATAL_REASONS).toEqual(['not-enabled']);

    expect(watchFolderSuppressed({ available: false, reason: 'not-enabled' })).toBe(true);

    // Functional on the parameter-store path — must stay offered.
    expect(watchFolderSuppressed({ available: false, reason: 'missing-storage-endpoint' })).toBe(
      false
    );
    expect(watchFolderSuppressed({ available: false, reason: 'no-storage-endpoint' })).toBe(false);
    // Unavailable with no reason, or a reason added to the enum after this
    // build: cannot be shown to be stack-independent, so fail open.
    expect(watchFolderSuppressed({ available: false })).toBe(false);
    expect(watchFolderSuppressed({ available: false, reason: 'some-future-reason' })).toBe(false);

    expect(watchFolderSuppressed({ available: true })).toBe(false);
    expect(watchFolderSuppressed(null)).toBe(false);
  });

  it('does not offer a remedy that is wrong on a stack-provisioned deployment', () => {
    const missingEndpoint = watchFolderUnavailableText('missing-storage-endpoint');
    // It must not tell the operator the feature is simply off here, because a
    // provisioned stack runs a watcher without any global endpoint.
    expect(missingEndpoint).toContain('still works');
    expect(missingEndpoint).toContain('stack');
  });
});

describe('renderWatchFolderToggle on a stack-provisioned deployment (issue #871)', () => {
  it('offers a working toggle when the only gap is a deployment-wide endpoint', async () => {
    const { calls } = stubFetch({
      health: () =>
        jsonResponse(healthBody({ available: false, reason: 'missing-storage-endpoint' })),
      bucketStatus: () => jsonResponse({ enabled: false, running: false, bucket: 'ovc-source' }),
      toggle: () => jsonResponse({ enabled: true, running: true, bucket: 'ovc-source' }),
    });
    const el = mount();

    await renderWatchFolderToggle(el, 'ovc-source');

    const btn = el.querySelector('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('Enable watch folder');
    expect(btn.textContent).not.toContain('unavailable');

    // The reported reason is still surfaced — as an advisory tied to the live
    // control, not as a dead end.
    const note = el.querySelector('#storage-watch-folder-unavailable') as HTMLElement;
    expect(note).toBeTruthy();
    expect(note.textContent).toBe(watchFolderUnavailableText('missing-storage-endpoint'));
    expect(btn.getAttribute('aria-describedby')).toBe('storage-watch-folder-unavailable');

    // And pressing it actually reaches the toggle route.
    btn.click();
    await flush();
    expect(calls).toContain(
      'POST ' + window.location.origin + '/api/v1/storage/buckets/ovc-source/watch-folder/toggle'
    );
  });

  it('offers the toggle for a reason this build does not recognise', async () => {
    stubFetch({
      health: () => jsonResponse(healthBody({ available: false, reason: 'some-future-reason' })),
      bucketStatus: () => jsonResponse({ enabled: false, running: false, bucket: 'ovc-source' }),
    });
    const el = mount();

    await renderWatchFolderToggle(el, 'ovc-source');

    const btn = el.querySelector('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    const note = el.querySelector('#storage-watch-folder-unavailable') as HTMLElement;
    expect(note.textContent).toBe(WATCH_FOLDER_UNAVAILABLE_FALLBACK);
  });
});

// ─── One read per page, not one per render ───────────────────────────────────

describe('the deployment-level /health read (issue #871)', () => {
  it('is read once across repeated renders', async () => {
    const { calls } = stubFetch({
      health: () => jsonResponse(healthBody({ available: true })),
      bucketStatus: () => jsonResponse({ enabled: false, running: false, bucket: 'ovc-source' }),
    });
    const el = mount();

    await renderWatchFolderToggle(el, 'ovc-source');
    await renderWatchFolderToggle(el, 'ovc-source');
    await renderWatchFolderToggle(el, 'ovc-source');

    expect(calls.filter((c) => c.endsWith('/health'))).toHaveLength(1);
    // The per-bucket status is still read on every render — it is the part that
    // can change while the page is open.
    expect(
      calls.filter((c) => c.endsWith('/api/v1/storage/buckets/ovc-source/watch-folder'))
    ).toHaveLength(3);
  });

  it('retries after an unreadable /health instead of caching "cannot tell"', async () => {
    let attempts = 0;
    stubFetch({
      health: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('health blip');
        return jsonResponse(healthBody({ available: false, reason: 'not-enabled' }));
      },
      bucketStatus: () => jsonResponse({ enabled: false, running: false, bucket: 'ovc-source' }),
    });
    const el = mount();

    // First render fails open.
    await renderWatchFolderToggle(el, 'ovc-source');
    expect((el.querySelector('button') as HTMLButtonElement).disabled).toBe(false);

    // Second render reads again and now learns the flag is off.
    await renderWatchFolderToggle(el, 'ovc-source');
    expect((el.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(attempts).toBe(2);
  });
});
