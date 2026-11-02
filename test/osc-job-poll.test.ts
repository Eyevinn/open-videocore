// Tests for the shared OSC ephemeral-job completion helper (issue #786 review).
//
// The status vocabulary asserted here is not invented: it was observed against
// the live `eyevinn-ffmpeg-s3` service on 2026-09-24 by polling `getJob` every
// 2s for the lifetime of a job. The job reported `status: "Running"` throughout
// its execution and flipped straight to `"SuccessCriteriaMet"` on exit. OSC
// publishes no enumeration of these values — `getJob` is typed
// `Promise<any>` (@osaas/client-core/lib/job.d.ts:51) — which is exactly why an
// unrecognised value must not be assumed to be either success or "still working".
//
// Fake timers are used so the 3s poll interval and the 120s unknown-status grace
// window can be crossed without the test actually waiting.
//
// The fail-fast path is OPT-IN (issue #786 round-2 review): only the pipelines
// that hold an HTTP request open pass `failFastOnUnknownStatus`, so both the
// opted-in and default behaviours are asserted below.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  pollOscJobUntilDone,
  DEFAULT_JOB_POLL_TIMEOUT_MS,
  type JobWaiter
} from '../src/pipeline/osc-job-poll.js';

function waiter(getJob: JobWaiter['getJob']): JobWaiter {
  return { context: {} as JobWaiter['context'], getJob };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pollOscJobUntilDone', () => {
  it('returns the terminal status as soon as the job reports one', async () => {
    const getJob = vi.fn(async () => ({ status: 'SuccessCriteriaMet' })) as unknown as JobWaiter['getJob'];
    await expect(pollOscJobUntilDone(waiter(getJob), 'svc', 'job1', 'sat')).resolves.toBe(
      'SuccessCriteriaMet'
    );
  });

  it('keeps polling while the job reports the observed in-progress status', async () => {
    vi.useFakeTimers();
    const getJob = vi
      .fn()
      .mockResolvedValueOnce({ status: 'Running' })
      .mockResolvedValueOnce({ status: 'Running' })
      .mockResolvedValue({ status: 'SuccessCriteriaMet' }) as unknown as JobWaiter['getJob'];

    const pending = pollOscJobUntilDone(waiter(getJob), 'svc', 'job2', 'sat');
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBe('SuccessCriteriaMet');
    expect(getJob).toHaveBeenCalledTimes(3);
  });

  it('treats a vanished job as completed and cleaned up', async () => {
    const getJob = vi.fn(async () => undefined) as unknown as JobWaiter['getJob'];
    await expect(pollOscJobUntilDone(waiter(getJob), 'svc', 'job3', 'sat')).resolves.toBe('Complete');
  });

  it('fails fast on an unrecognised status ONLY for a caller that opted in', async () => {
    vi.useFakeTimers();
    const getJob = vi.fn(async () => ({ status: 'Cancelled' })) as unknown as JobWaiter['getJob'];

    const pending = pollOscJobUntilDone(waiter(getJob), 'svc', 'job4', 'sat', {
      failFastOnUnknownStatus: true
    });
    const assertion = expect(pending).rejects.toThrow(/unrecognised status "Cancelled"/);
    // Well inside the 5-minute overall timeout: the point is that the wait does
    // NOT hold the caller open until then.
    await vi.advanceTimersByTimeAsync(130_000);
    await assertion;
  });

  // The fire-and-forget pipelines (osc-ffprobe, osc-thumbnail — dispatched with
  // `void` on every ingest) do NOT opt in: nobody is waiting on them, so an
  // unseen-but-healthy status must not take metadata extraction and thumbnails
  // down for every uploaded asset. They keep the pre-#786 behaviour, where an
  // unrecognised status still ends in failure, just at TIMEOUT_MS.
  it('keeps polling an unrecognised status by default, past the grace window', async () => {
    vi.useFakeTimers();
    const getJob = vi.fn(async () => ({ status: 'Cancelled' })) as unknown as JobWaiter['getJob'];

    const pending = pollOscJobUntilDone(waiter(getJob), 'svc', 'job4b', 'sat');
    let settled = false;
    void pending.catch(() => undefined).finally(() => (settled = true));

    await vi.advanceTimersByTimeAsync(130_000);
    expect(settled).toBe(false);

    // It still terminates — at the overall timeout, which costs no held request.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(pending).rejects.toThrow(/timed out/);
  });

  // Plausible cold-start vocabulary is treated as "still working" even for an
  // opted-in caller: the in-progress set is unpublished (getJob is
  // `Promise<any>`), so failing a queued job would be a guess with an asymmetric
  // cost. Matching is case-insensitive for the same reason.
  it.each(['Pending', 'Queued', 'ContainerCreating', 'starting', 'PROVISIONING'])(
    'treats %s as in-progress rather than unrecognised',
    async (queueing) => {
      vi.useFakeTimers();
      const getJob = vi
        .fn()
        .mockResolvedValueOnce({ status: queueing })
        .mockResolvedValueOnce({ status: queueing })
        .mockResolvedValue({ status: 'SuccessCriteriaMet' }) as unknown as JobWaiter['getJob'];

      const pending = pollOscJobUntilDone(waiter(getJob), 'svc', 'job5', 'sat', {
        failFastOnUnknownStatus: true
      });
      await vi.advanceTimersByTimeAsync(150_000);

      await expect(pending).resolves.toBe('SuccessCriteriaMet');
    }
  );

  it('does not fail on an unrecognised status that clears within the grace window', async () => {
    vi.useFakeTimers();
    const getJob = vi
      .fn()
      .mockResolvedValueOnce({ status: 'Renaming' })
      .mockResolvedValueOnce({ status: 'Running' })
      .mockResolvedValue({ status: 'SuccessCriteriaMet' }) as unknown as JobWaiter['getJob'];

    const pending = pollOscJobUntilDone(waiter(getJob), 'svc', 'job5b', 'sat', {
      failFastOnUnknownStatus: true
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBe('SuccessCriteriaMet');
  });

  it('tolerates a missing status while the job is being scheduled', async () => {
    vi.useFakeTimers();
    const getJob = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValue({ status: 'Failed' }) as unknown as JobWaiter['getJob'];

    const pending = pollOscJobUntilDone(waiter(getJob), 'svc', 'job6', 'sat');
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBe('Failed');
  });
});

// The per-call budget (ADR-027 D8.1, issue #1192). Scene detection decodes the
// whole file, so it needs a budget above the shared default — and the awaited
// routes must keep the shared default exactly, which is what the last case here
// pins. The timeout message must name the caller's service and the budget that
// actually applied (ADR-027 C6: it used to hardcode "probe").
describe('pollOscJobUntilDone per-call timeoutMs budget (ADR-027 D8.1)', () => {
  it('waits for the caller-supplied budget rather than the 5-minute default', async () => {
    vi.useFakeTimers();
    const getJob = vi.fn().mockResolvedValue({ status: 'Running' }) as unknown as JobWaiter['getJob'];

    const pending = pollOscJobUntilDone(waiter(getJob), 'eyevinn-ffmpeg-s3', 'scenes1', 'sat', {
      timeoutMs: 10 * 60_000
    });
    const settled = pending.catch((err: unknown) => err);

    // Past the shared 5-minute default: a job on a 10-minute budget is still
    // being polled here, which is the whole point of the option.
    await vi.advanceTimersByTimeAsync(DEFAULT_JOB_POLL_TIMEOUT_MS + 30_000);
    expect(getJob).toHaveBeenCalled();
    const callsAtDefaultDeadline = (getJob as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('eyevinn-ffmpeg-s3 job "scenes1" timed out after 600s');
    expect(
      (getJob as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBeGreaterThan(callsAtDefaultDeadline);
  });

  it('returns the terminal status inside a short explicit budget', async () => {
    vi.useFakeTimers();
    const getJob = vi
      .fn()
      .mockResolvedValueOnce({ status: 'Running' })
      .mockResolvedValue({ status: 'SuccessCriteriaMet' }) as unknown as JobWaiter['getJob'];

    const pending = pollOscJobUntilDone(waiter(getJob), 'svc', 'job7', 'sat', {
      timeoutMs: 30_000
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBe('SuccessCriteriaMet');
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the exported shared default for timeoutMs=%s',
    async (bad) => {
      vi.useFakeTimers();
      const getJob = vi.fn().mockResolvedValue({ status: 'Running' }) as unknown as JobWaiter['getJob'];

      const pending = pollOscJobUntilDone(waiter(getJob), 'svc', 'job8', 'sat', {
        timeoutMs: bad as number | undefined
      });
      const settled = pending.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(DEFAULT_JOB_POLL_TIMEOUT_MS + 10_000);

      const err = await settled;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(
        `timed out after ${DEFAULT_JOB_POLL_TIMEOUT_MS / 1000}s`
      );
    }
  );
});
