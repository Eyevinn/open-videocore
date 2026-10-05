// @vitest-environment happy-dom
//
// The Transcoders tab's instance pill must colour LIFECYCLE HEALTH, not
// utilisation (issue #980).
//
// The old pill coloured `activeJobs` against capacity: 0 jobs -> --success,
// at-capacity -> --danger. On a pool of on-demand instances that are billed
// while alive that is backwards — transcoding is the state being paid for and
// idle is the state costing money for nothing — and at a capacity of 1 the
// "at capacity" branch is a synonym for "busy", so every working instance
// rendered red for the whole encode.
//
// Two traps this file exists to pin, because both are silent when you get them
// wrong and both produce a plausible-looking UI:
//
//   1. `lastIdleAt` does NOT advance while an instance is busy — it holds the
//      previous idle moment, so on a long encode it is stale by the length of
//      the run. Evaluate idle age on a busy instance and a normal 3-hour job is
//      "stuck". Idle age may only be read at activeJobs === 0.
//   2. A draining instance (#513, drain-don't-kill) is deliberately held past
//      its idle bound while it finishes in-flight work. Flagging it amber/red
//      reports the scaler's correct behaviour as a fault.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - GET /api/v1/scaler/status: `scalerStatusSchema` in src/routes/scaler.ts —
//     { workspaces, maxInstances, jobsPerInstance, idleTimeoutMs, scalerActive }.
//   - Per-instance wire shape: `instanceSchema` in src/routes/scaler.ts —
//     { instanceId: string, url: string, activeJobs: number,
//       lastIdleAt?: number, readyAt?: number, draining?: boolean }.
//     `draining` reaches the wire as of #979; `toInstanceView` in the same file
//     emits it only when the record is actually draining, so absent means "not
//     draining" and the client must treat a missing flag as false.
//   - Record semantics: EncoreInstanceRecord in src/encore-scaler/types.ts:218-237
//     (`lastIdleAt` = epoch ms activeJobs last reached 0; `readyAt` = entered the
//     pool ready for work; `draining` = selected for teardown, still has work).
//   - Idle-age basis mirrored from resolveIdleSince()
//     (src/encore-scaler/scaler-loop.ts:128) — lastIdleAt, then readyAt.
//   - Health classes: .tc-health.health-transcoding / -idle / -draining /
//     -overdue / -stuck (public/style.css).
//   - public/app.js: instanceHealth, instanceIdleSince, IDLE_OVERDUE_GRACE_MS,
//     IDLE_STUCK_FACTOR, renderTranscodersTab.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  instanceHealth,
  instanceIdleSince,
  IDLE_OVERDUE_GRACE_MS,
  IDLE_STUCK_FACTOR,
  renderTranscodersTab,
} from '../public/app.js';

const BOUND = 300_000; // the ENCORE_IDLE_TIMEOUT_MS default, 5 minutes
const NOW = 1_800_000_000_000;

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function statusPayload(
  instances: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {}
) {
  return {
    workspaces: [{ workspaceId: 'ws-1', queueDepth: 0, inflightDepth: 0, instances }],
    maxInstances: 4,
    jobsPerInstance: 1,
    idleTimeoutMs: BOUND,
    scalerActive: true,
    ...extra,
  };
}

function stubStatus(payload: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
  );
}

// ─── instanceIdleSince ───────────────────────────────────────────────────────

describe('instanceIdleSince', () => {
  it('prefers lastIdleAt, the real completion stamp', () => {
    expect(instanceIdleSince({ lastIdleAt: 1000, readyAt: 500 })).toBe(1000);
  });

  it('falls back to readyAt so a never-dispatched instance has an age at all', () => {
    // lastIdleAt only advances when a job COMPLETES, so a freshly spawned
    // instance that has never been dispatched carries no lastIdleAt.
    expect(instanceIdleSince({ readyAt: 500 })).toBe(500);
  });

  it('accepts numeric strings, since the record round-trips through JSON', () => {
    expect(instanceIdleSince({ lastIdleAt: '1000' })).toBe(1000);
  });

  it('returns undefined when neither field is a usable timestamp', () => {
    expect(instanceIdleSince({})).toBeUndefined();
    expect(instanceIdleSince({ lastIdleAt: null, readyAt: 'never' })).toBeUndefined();
    expect(instanceIdleSince({ lastIdleAt: NaN })).toBeUndefined();
  });
});

// ─── instanceHealth ──────────────────────────────────────────────────────────

describe('instanceHealth (issue #980)', () => {
  it('is green for a transcoding instance at ANY duration', () => {
    // The observed report: an instance 11m48s into a normal encode rendered red.
    // Its lastIdleAt is 11m48s old precisely BECAUSE it has been working.
    const busy = { activeJobs: 1, lastIdleAt: NOW - 708_000 };
    expect(instanceHealth(busy, BOUND, NOW).cls).toBe('health-transcoding');

    // And a 6-hour encode, which is >> IDLE_STUCK_FACTOR * BOUND.
    const long = { activeJobs: 1, lastIdleAt: NOW - 6 * 60 * 60 * 1000 };
    expect(instanceHealth(long, BOUND, NOW).cls).toBe('health-transcoding');
    expect(instanceHealth(long, BOUND, NOW).label).toBe('transcoding');
  });

  it('does not flag a draining instance past its bound, busy or not', () => {
    // #513: scale-down marks an instance draining rather than killing it while
    // it still has in-flight work, so "past the bound" is expected for it.
    const drainingBusy = { activeJobs: 1, draining: true, lastIdleAt: NOW - 10 * BOUND };
    const drainingIdle = { activeJobs: 0, draining: true, lastIdleAt: NOW - 10 * BOUND };

    expect(instanceHealth(drainingBusy, BOUND, NOW).cls).toBe('health-transcoding');
    expect(instanceHealth(drainingIdle, BOUND, NOW).cls).toBe('health-draining');
    for (const inst of [drainingBusy, drainingIdle]) {
      expect(instanceHealth(inst, BOUND, NOW).cls).not.toBe('health-overdue');
      expect(instanceHealth(inst, BOUND, NOW).cls).not.toBe('health-stuck');
    }
  });

  it('walks gray -> amber -> red across the bound, the grace, and the stuck factor', () => {
    const at = (ageMs: number) => instanceHealth({ activeJobs: 0, lastIdleAt: NOW - ageMs }, BOUND, NOW).cls;

    expect(at(0)).toBe('health-idle');
    expect(at(BOUND - 1)).toBe('health-idle');
    // Inside the grace that absorbs the 10s scaler tick jitter.
    expect(at(BOUND + IDLE_OVERDUE_GRACE_MS)).toBe('health-idle');
    expect(at(BOUND + IDLE_OVERDUE_GRACE_MS + 1)).toBe('health-overdue');
    expect(at(BOUND * IDLE_STUCK_FACTOR)).toBe('health-overdue');
    expect(at(BOUND * IDLE_STUCK_FACTOR + 1)).toBe('health-stuck');
  });

  it('derives every threshold from the payload bound, not a hardcoded 5 minutes', () => {
    // Same 20-minute idle age, two different server configs. If the thresholds
    // were hardcoded to the 5-minute default, both would read the same.
    const inst = { activeJobs: 0, lastIdleAt: NOW - 20 * 60_000 };
    expect(instanceHealth(inst, 5 * 60_000, NOW).cls).toBe('health-stuck');
    expect(instanceHealth(inst, 15 * 60_000, NOW).cls).toBe('health-overdue');
    expect(instanceHealth(inst, 60 * 60_000, NOW).cls).toBe('health-idle');
  });

  it('renders a freshly spawned, never-dispatched instance gray, not amber', () => {
    const fresh = { activeJobs: 0, readyAt: NOW - 3_000 };
    expect(instanceHealth(fresh, BOUND, NOW).cls).toBe('health-idle');
  });

  it('claims no fault when the record carries no usable timestamp or bound', () => {
    // Nothing to measure means no evidence of a lifecycle failure. The server's
    // own scale-down path fails closed on a missing stamp (isIdlePastTimeout,
    // scaler-loop.ts:148), so the instance still gets reaped.
    expect(instanceHealth({ activeJobs: 0 }, BOUND, NOW).cls).toBe('health-idle');
    expect(instanceHealth({ activeJobs: 0, lastIdleAt: NOW - 10 * BOUND }, undefined, NOW).cls).toBe('health-idle');
  });

  it('treats an absent draining flag as not draining', () => {
    // toInstanceView omits the field entirely unless the record is draining.
    expect(instanceHealth({ activeJobs: 0, lastIdleAt: NOW - 10 * BOUND }, BOUND, NOW).cls).toBe('health-stuck');
  });

  it('gives every state a label, so the colour is never the only channel', () => {
    const states = [
      { activeJobs: 1 },
      { activeJobs: 0, draining: true },
      { activeJobs: 0, lastIdleAt: NOW },
      { activeJobs: 0, lastIdleAt: NOW - 2 * BOUND },
      { activeJobs: 0, lastIdleAt: NOW - 10 * BOUND },
    ];
    for (const inst of states) {
      const h = instanceHealth(inst, BOUND, NOW);
      expect(h.label).toBeTruthy();
      expect(h.detail).toBeTruthy();
    }
  });
});

// ─── The rendered pill ───────────────────────────────────────────────────────

describe('renderTranscodersTab health pill (issue #980)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  async function render(payload: unknown) {
    stubStatus(payload);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderTranscodersTab(container);
    await flush();
    return container;
  }

  function pill(container: HTMLElement) {
    const el = container.querySelector('.tc-health');
    if (!el) throw new Error('no .tc-health pill rendered');
    return el;
  }

  it('paints a working instance green, not red', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const container = await render(
      statusPayload([
        // 11m48s into an encode — the exact live observation in the issue.
        { instanceId: 'i-1', url: 'https://i-1.example', activeJobs: 1, lastIdleAt: NOW - 708_000 },
      ])
    );
    const el = pill(container);
    expect(el.classList.contains('health-transcoding')).toBe(true);
    expect(el.classList.contains('health-stuck')).toBe(false);
    expect(el.classList.contains('health-overdue')).toBe(false);
  });

  it('states the meaning in visible text, not only in a tooltip', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const container = await render(
      statusPayload([
        { instanceId: 'i-1', url: 'https://i-1.example', activeJobs: 1, lastIdleAt: NOW - 708_000 },
      ])
    );
    const el = pill(container);
    expect(el.textContent!.replace(/\s+/g, ' ').trim()).toBe('transcoding');
    // The tooltip still carries the longer explanation, but it is not the only
    // place the state is legible.
    expect(el.getAttribute('title')).toContain('billed');
  });

  it('does not flag a draining instance long past its bound', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const container = await render(
      statusPayload([
        {
          instanceId: 'i-1',
          url: 'https://i-1.example',
          activeJobs: 0,
          draining: true,
          lastIdleAt: NOW - 10 * BOUND,
        },
      ])
    );
    const el = pill(container);
    expect(el.textContent!.replace(/\s+/g, ' ').trim()).toBe('draining');
    expect(el.classList.contains('health-overdue')).toBe(false);
    expect(el.classList.contains('health-stuck')).toBe(false);
  });

  it('flags an idle instance that should have been reaped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const container = await render(
      statusPayload([
        { instanceId: 'i-1', url: 'https://i-1.example', activeJobs: 0, lastIdleAt: NOW - 2 * BOUND },
        { instanceId: 'i-2', url: 'https://i-2.example', activeJobs: 0, lastIdleAt: NOW - 10 * BOUND },
      ])
    );
    const pills = [...container.querySelectorAll('.tc-health')];
    expect(pills[0].classList.contains('health-overdue')).toBe(true);
    expect(pills[0].textContent!.trim()).toBe('overdue');
    expect(pills[1].classList.contains('health-stuck')).toBe(true);
    expect(pills[1].textContent!.trim()).toBe('stuck');
  });

  it('follows a retuned idle bound from the payload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // The same instance that is "stuck" against a 5-minute bound is healthy
    // against the hour-long bound this operator configured.
    const container = await render(
      statusPayload(
        [{ instanceId: 'i-1', url: 'https://i-1.example', activeJobs: 0, lastIdleAt: NOW - 20 * 60_000 }],
        { idleTimeoutMs: 60 * 60_000 }
      )
    );
    expect(pill(container).classList.contains('health-idle')).toBe(true);
  });
});

// ─── The utilisation colouring is gone, not merely unused ────────────────────

describe('the load-class traffic light is deleted (issue #980)', () => {
  it('no longer appears in public/app.js or public/style.css', () => {
    const js = readFileSync(resolve(process.cwd(), 'public/app.js'), 'utf8');
    const css = readFileSync(resolve(process.cwd(), 'public/style.css'), 'utf8');
    for (const token of ['loadClass', 'load-idle', 'load-partial', 'load-full']) {
      expect(js).not.toContain(token);
      expect(css).not.toContain(token);
    }
  });
});
