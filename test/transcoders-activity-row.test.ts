// @vitest-environment happy-dom
//
// The transcoder card's duration row must answer the question the operator is
// actually asking, in both instance states (issue #982).
//
// The row used to read "Last idle <X> ago" unconditionally. `lastIdleAt` is
// stamped when an instance's activeJobs last reached 0 and is frozen while it is
// busy, so on a working instance the row counted upward away from an already
// stale value and reset to zero the instant work finished — the exact moment the
// countdown to reaping actually starts. Rendered next to an idle timeout that
// reads like time-until-teardown, running the opposite direction.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - GET /api/v1/scaler/status response: `scalerStatusSchema` in
//     src/routes/scaler.ts:90 — { workspaces, maxInstances, jobsPerInstance,
//     idleTimeoutMs, scalerActive }; per-instance `instanceSchema`
//     (src/routes/scaler.ts:74) { instanceId, url, activeJobs, lastIdleAt?,
//     readyAt?, draining? }, projected by toInstanceView() (:108) which drops any
//     timestamp that is not a finite number. No field is added here: both
//     branches below are computed from fields already on that wire.
//   - `lastIdleAt`: EncoreInstanceRecord (src/encore-scaler/types.ts:219) —
//     "epoch ms when activeJobs last reached 0", written on job completion
//     (src/routes/internal.ts:202, src/pipeline/encore-callback-poller.ts:371)
//     and NOT touched at dispatch (src/encore-scaler/scaler-loop.ts:433
//     increments activeJobs on its own).
//   - `readyAt`: EncoreInstanceRecord (src/encore-scaler/types.ts:230) — the idle
//     clock's fallback basis; on spawn lastIdleAt === readyAt
//     (src/encore-scaler/instance-pool.ts:469-477).
//   - Idle-clock resolution order: resolveIdleSince()
//     (src/encore-scaler/scaler-loop.ts:128) — lastIdleAt, then readyAt, both
//     tolerating a numeric string; undefined when neither is usable, which
//     isIdlePastTimeout() (:148) treats as aged (fails closed).
//   - public/app.js: humanDuration, resolveIdleSince, instanceActivity,
//     renderTranscodersTab.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  humanDuration,
  resolveIdleSince,
  instanceActivity,
  renderTranscodersTab,
} from '../public/app.js';

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// A status payload in the exact shape scalerStatusSchema serialises.
function statusPayload(instances: Array<Record<string, unknown>>) {
  return {
    workspaces: [{ workspaceId: 'ws-1', queueDepth: 0, inflightDepth: 0, instances }],
    maxInstances: 4,
    jobsPerInstance: 1,
    idleTimeoutMs: 300_000,
    scalerActive: true,
  };
}

function stubStatus(payload: unknown) {
  const fetchStub = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

const MIN = 60_000;
const NOW = 1_800_000_000_000;

// ─── humanDuration ───────────────────────────────────────────────────────────

describe('humanDuration (issue #982)', () => {
  it('climbs the same unit ladder the old relative formatter used, without "ago"', () => {
    expect(humanDuration(0)).toBe('0 seconds');
    expect(humanDuration(1_000)).toBe('1 second');
    expect(humanDuration(47_000)).toBe('47 seconds');
    expect(humanDuration(9 * MIN)).toBe('9 minutes');
    expect(humanDuration(60 * MIN)).toBe('1 hour');
    expect(humanDuration(26 * 60 * MIN)).toBe('1 day');
  });

  it('clamps a negative span instead of rendering a negative duration', () => {
    // A record written a shade ahead of this browser's clock must not read
    // "-3 seconds" on the card.
    expect(humanDuration(-3_000)).toBe('0 seconds');
  });
});

// ─── resolveIdleSince (mirrors the server's own resolution order) ────────────

describe('resolveIdleSince (issue #982)', () => {
  it('prefers lastIdleAt, falls back to readyAt', () => {
    expect(resolveIdleSince({ lastIdleAt: 10, readyAt: 20 })).toBe(10);
    expect(resolveIdleSince({ readyAt: 20 })).toBe(20);
  });

  it('tolerates a numeric string, like scaler-loop.ts:128 does', () => {
    expect(resolveIdleSince({ lastIdleAt: '10' })).toBe(10);
    expect(resolveIdleSince({ lastIdleAt: '', readyAt: '20' })).toBe(20);
  });

  it('returns undefined when neither timestamp is usable', () => {
    expect(resolveIdleSince({})).toBeUndefined();
    expect(resolveIdleSince({ lastIdleAt: 'soon', readyAt: null })).toBeUndefined();
  });
});

// ─── instanceActivity: the state-aware row ───────────────────────────────────

describe('instanceActivity (issue #982)', () => {
  it('reports elapsed running time on a busy instance, not a last-idle age', () => {
    const row = instanceActivity({ activeJobs: 1, lastIdleAt: NOW - 9 * MIN }, NOW);
    expect(row.label).toBe('Running');
    expect(row.value).toBe('9 minutes');
  });

  it('reports idle age on an idle instance — the quantity the reaping bound uses', () => {
    const row = instanceActivity({ activeJobs: 0, lastIdleAt: NOW - 4 * MIN }, NOW);
    expect(row.label).toBe('Idle');
    expect(row.value).toBe('4 minutes');
  });

  it('reads sensibly on a freshly spawned instance awaiting dispatch', () => {
    // instance-pool.ts spawn: lastIdleAt === readyAt, activeJobs 0.
    const readyAt = NOW - 12_000;
    const row = instanceActivity({ activeJobs: 0, lastIdleAt: readyAt, readyAt }, NOW);
    expect(row.label).toBe('Idle');
    expect(row.value).toBe('12 seconds');
  });

  it('uses readyAt for an instance that has never completed a job', () => {
    // The #778 case: spawned, never dispatched, lastIdleAt lost or unwritten.
    const row = instanceActivity({ activeJobs: 0, readyAt: NOW - 7 * MIN }, NOW);
    expect(row.label).toBe('Idle');
    expect(row.value).toBe('7 minutes');
  });

  it('does not reset to zero when work finishes — the bug, from the other side', () => {
    const startedWorking = NOW - 10 * MIN;
    const busy = instanceActivity({ activeJobs: 1, lastIdleAt: startedWorking }, NOW);
    // Work completes now: the poller stamps lastIdleAt = NOW, activeJobs -> 0.
    const justFinished = instanceActivity({ activeJobs: 0, lastIdleAt: NOW }, NOW);
    expect(busy.label).toBe('Running');
    expect(justFinished.label).toBe('Idle');
    // The zero belongs to the idle clock, which is the one counting toward
    // teardown — not to the row shown while the instance worked hardest.
    expect(justFinished.value).toBe('0 seconds');
    expect(busy.value).toBe('10 minutes');
  });

  it('shows an em dash rather than a bogus duration when no timestamp is usable', () => {
    expect(instanceActivity({ activeJobs: 0 }, NOW).value).toBe('—');
    expect(instanceActivity({ activeJobs: 1 }, NOW).value).toBe('—');
    // A null must not coerce to 0 and render the instance as busy since 1970.
    expect(instanceActivity({ activeJobs: 1, lastIdleAt: null }, NOW).value).toBe('—');
    expect(instanceActivity({ activeJobs: 0, lastIdleAt: null, readyAt: null }, NOW).value).toBe('—');
  });

  it('carries a title that names the quantity in each state', () => {
    const busy = instanceActivity({ activeJobs: 1, lastIdleAt: NOW - MIN }, NOW);
    const idle = instanceActivity({ activeJobs: 0, lastIdleAt: NOW - MIN }, NOW);
    expect(busy.title).toBeTruthy();
    expect(idle.title).toContain('idle timeout');
    expect(busy.title).not.toBe(idle.title);
  });
});

// ─── The rendered card ───────────────────────────────────────────────────────

describe('renderTranscodersTab duration row (issue #982)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  async function render() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderTranscodersTab(container);
    await flush();
    return container;
  }

  it('labels a busy card Running and an idle card Idle — never "Last idle"', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stubStatus(
      statusPayload([
        {
          instanceId: 'inst-busy',
          url: 'https://inst-busy.example',
          activeJobs: 1,
          lastIdleAt: NOW - 9 * MIN,
          readyAt: NOW - 30 * MIN,
        },
        {
          instanceId: 'inst-idle',
          url: 'https://inst-idle.example',
          activeJobs: 0,
          lastIdleAt: NOW - 4 * MIN,
          readyAt: NOW - 30 * MIN,
        },
      ])
    );
    const container = await render();

    const rows = [...container.querySelectorAll('.tc-activity')].map((el) =>
      el.textContent!.replace(/\s+/g, ' ').trim()
    );
    expect(rows).toEqual(['Running 9 minutes', 'Idle 4 minutes']);
    expect(container.innerHTML).not.toContain('Last idle');
  });

  it('renders a freshly spawned instance as idle for its age since readiness', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const readyAt = NOW - 20_000;
    stubStatus(
      statusPayload([
        {
          instanceId: 'inst-new',
          url: 'https://inst-new.example',
          activeJobs: 0,
          lastIdleAt: readyAt,
          readyAt,
        },
      ])
    );
    const container = await render();

    const row = container.querySelector('.tc-activity')!;
    expect(row.textContent!.replace(/\s+/g, ' ').trim()).toBe('Idle 20 seconds');
  });
});

// ─── The stale label is gone, not merely unused ──────────────────────────────

describe('the unconditional "Last idle" row is deleted (issue #982)', () => {
  it('no longer appears in public/app.js', () => {
    const source = readFileSync(resolve(process.cwd(), 'public/app.js'), 'utf8');
    expect(source).not.toContain('Last idle<');
    expect(source).not.toContain('>Last idle');
  });
});
