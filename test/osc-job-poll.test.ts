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
import { pollOscJobUntilDone, type JobWaiter } from '../src/pipeline/osc-job-poll.js';

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
