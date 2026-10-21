// @vitest-environment happy-dom
//
// The Transcoders tab must read per-instance capacity off the wire instead of
// reverse-engineering it from the pool (issue #979).
//
// The old helper inferred capacity as "the highest activeJobs seen in this pool,
// floored at 1". With JOBS_PER_INSTANCE = 1 that coincided with the truth, which
// hid a defect: raise the constant and every card under-reports capacity until
// some instance happens to reach the new value.
//
// The capacity READOUT is what this file pins. The pill's colour is no longer a
// function of utilisation at all (#980) — see transcoders-instance-health.test.ts.
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
//   - Utilisation readout: .tc-load (public/style.css). It is now UNCOLOURED —
//     colouring utilisation was the #980 defect and the traffic light moved to
//     the .tc-health pill; see test/transcoders-instance-health.test.ts.
//   - public/app.js: resolveJobsPerInstance, renderTranscodersTab.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveJobsPerInstance, renderTranscodersTab } from '../public/app.js';

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

  it('reports a saturated instance as N / N', async () => {
    stubStatus(
      statusPayload(4, [
        { instanceId: 'inst-1', url: 'https://inst-1.example', activeJobs: 4, lastIdleAt: Date.now() },
      ])
    );
    const container = await render(undefined);

    const load = container.querySelector('.tc-load')!;
    expect(load.textContent!.replace(/\s+/g, ' ').trim()).toBe('4 / 4');
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
  });

  it('does not colour the utilisation readout — utilisation is not health (#980)', async () => {
    stubStatus(
      statusPayload(1, [
        { instanceId: 'inst-1', url: 'https://inst-1.example', activeJobs: 1, lastIdleAt: Date.now() },
      ])
    );
    const container = await render(undefined);

    const load = container.querySelector('.tc-load')!;
    // The whole #980 defect was that being busy painted the readout --danger.
    expect([...load.classList]).toEqual(['tc-load', 'text-mono']);
  });
});

// ─── The inference is gone, not merely unused ───────────────────────────────

describe('deriveInstanceCapacity is deleted (issue #979)', () => {
  it('no longer appears anywhere in public/app.js', () => {
    const source = readFileSync(resolve(process.cwd(), 'public/app.js'), 'utf8');
    expect(source).not.toContain('deriveInstanceCapacity');
  });
});
