// @vitest-environment happy-dom
//
// The Transcoders tab must read per-instance capacity off the wire instead of
// reverse-engineering it from the pool (issue #979).
//
// The old helper inferred capacity as "the highest activeJobs seen in this pool,
// floored at 1". With JOBS_PER_INSTANCE = 1 that coincided with the truth, which
// hid two defects: raise the constant and every card under-reports capacity until
// some instance happens to reach the new value, and the amber `load-partial`
// branch was unreachable — with capacity pinned at 1 and activeJobs in {0,1},
// every busy instance satisfied `activeJobs >= capacity`.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - GET /api/v1/scaler/status response: `scalerStatusSchema` in
//     src/routes/scaler.ts — { workspaces, maxInstances, jobsPerInstance,
//     idleTimeoutMs, scalerActive }; per-workspace `workspaceSchema`
//     { workspaceId, queueDepth, inflightDepth, instances }; per-instance
//     `instanceSchema` { instanceId, url, activeJobs, lastIdleAt?, readyAt?,
//     draining? }.
//   - Capacity source: JOBS_PER_INSTANCE (src/encore-scaler/types.ts), reported
//     verbatim by the status handler.
//   - Load classes: .tc-load.load-idle / .load-partial / .load-full
//     (public/style.css:852-866).
//   - public/app.js: resolveJobsPerInstance, loadClass, loadLabel,
//     renderTranscodersTab.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveJobsPerInstance,
  loadClass,
  loadLabel,
  renderTranscodersTab,
} from '../public/app.js';

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// A status payload in the exact shape scalerStatusSchema serialises.
function statusPayload(
  jobsPerInstance: number,
  instances: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {}
) {
  return {
    workspaces: [
      { workspaceId: 'ws-1', queueDepth: 0, inflightDepth: 0, instances },
    ],
    maxInstances: 4,
    jobsPerInstance,
    idleTimeoutMs: 300_000,
    scalerActive: true,
    ...extra,
  };
}

function stubStatus(payload: unknown) {
  const fetchStub = vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

// ─── resolveJobsPerInstance (wired capacity, no inference) ───────────────────

describe('resolveJobsPerInstance (issue #979)', () => {
  it('returns the server-reported capacity', () => {
    expect(resolveJobsPerInstance({ jobsPerInstance: 4 })).toBe(4);
    expect(resolveJobsPerInstance({ jobsPerInstance: 1 })).toBe(1);
  });

  it('ignores the pool it is not given — capacity does not depend on observed load', () => {
    // The whole bug: capacity used to be a function of activeJobs. A busy pool
    // and an idle pool must report the same capacity for the same server config.
    const busy = statusPayload(4, [{ instanceId: 'a', url: 'https://a', activeJobs: 4 }]);
    const idle = statusPayload(4, [{ instanceId: 'a', url: 'https://a', activeJobs: 0 }]);
    expect(resolveJobsPerInstance(busy)).toBe(resolveJobsPerInstance(idle));
  });

  it('falls back to 1 when the field is absent, junk, or below one', () => {
    expect(resolveJobsPerInstance({})).toBe(1);
    expect(resolveJobsPerInstance(null)).toBe(1);
    expect(resolveJobsPerInstance({ jobsPerInstance: 'lots' })).toBe(1);
    expect(resolveJobsPerInstance({ jobsPerInstance: 0 })).toBe(1);
    expect(resolveJobsPerInstance({ jobsPerInstance: -3 })).toBe(1);
  });
});

// ─── loadClass / loadLabel ───────────────────────────────────────────────────

describe('loadClass (issue #979)', () => {
  it('reaches load-partial once capacity is greater than one', () => {
    expect(loadClass(0, 4)).toBe('load-idle');
    expect(loadClass(1, 4)).toBe('load-partial');
    expect(loadClass(3, 4)).toBe('load-partial');
    expect(loadClass(4, 4)).toBe('load-full');
  });

  it('collapses to idle/full at capacity 1, where partial cannot exist', () => {
    expect(loadClass(0, 1)).toBe('load-idle');
    expect(loadClass(1, 1)).toBe('load-full');
  });

  it('labels every class it can return', () => {
    expect(loadLabel('load-idle')).toBe('idle');
    expect(loadLabel('load-partial')).toBe('partially loaded');
    expect(loadLabel('load-full')).toBe('at capacity');
  });
});

// ─── The rendered instance card ──────────────────────────────────────────────

describe('renderTranscodersTab instance cards (issue #979)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function render(payload: unknown) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderTranscodersTab(container);
    await flush();
    return container;
  }

  it('shows N / jobsPerInstance, not N / busiest-instance-seen', async () => {
    stubStatus(
      statusPayload(4, [
        { instanceId: 'inst-1', url: 'https://inst-1.example', activeJobs: 1, lastIdleAt: Date.now() },
        { instanceId: 'inst-2', url: 'https://inst-2.example', activeJobs: 0, lastIdleAt: Date.now() },
      ])
    );
    const container = await render(undefined);

    const loads = [...container.querySelectorAll('.tc-load')].map((el) =>
      el.textContent!.replace(/\s+/g, ' ').trim()
    );
    // Under the old inference both cards would have read "/ 1".
    expect(loads).toEqual(['1 / 4', '0 / 4']);
  });

  it('renders an instance below capacity as partially loaded, not at capacity', async () => {
    stubStatus(
      statusPayload(4, [
        { instanceId: 'inst-1', url: 'https://inst-1.example', activeJobs: 1, lastIdleAt: Date.now() },
      ])
    );
    const container = await render(undefined);

    const load = container.querySelector('.tc-load')!;
    expect(load.classList.contains('load-partial')).toBe(true);
    expect(load.classList.contains('load-full')).toBe(false);
    expect(load.getAttribute('title')).toBe('partially loaded');
  });

  it('still renders a saturated instance as at capacity', async () => {
    stubStatus(
      statusPayload(4, [
        { instanceId: 'inst-1', url: 'https://inst-1.example', activeJobs: 4, lastIdleAt: Date.now() },
      ])
    );
    const container = await render(undefined);

    const load = container.querySelector('.tc-load')!;
    expect(load.classList.contains('load-full')).toBe(true);
    expect(load.textContent!.replace(/\s+/g, ' ').trim()).toBe('4 / 4');
    expect(load.getAttribute('title')).toBe('at capacity');
  });

  it('falls back to a capacity of 1 against a server that does not report the field', async () => {
    const legacy = statusPayload(1, [
      { instanceId: 'inst-1', url: 'https://inst-1.example', activeJobs: 1, lastIdleAt: Date.now() },
    ]) as Record<string, unknown>;
    delete legacy['jobsPerInstance'];
    stubStatus(legacy);
    const container = await render(undefined);

    const load = container.querySelector('.tc-load')!;
    expect(load.textContent!.replace(/\s+/g, ' ').trim()).toBe('1 / 1');
    expect(load.classList.contains('load-full')).toBe(true);
  });
});

// ─── The inference is gone, not merely unused ───────────────────────────────

describe('deriveInstanceCapacity is deleted (issue #979)', () => {
  it('no longer appears anywhere in public/app.js', () => {
    const source = readFileSync(resolve(process.cwd(), 'public/app.js'), 'utf8');
    expect(source).not.toContain('deriveInstanceCapacity');
  });
});
