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
// Fake timers are used so the 3s poll interval and the 30s unknown-status grace
// window can be crossed without the test actually waiting.

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

  it('fails fast on a status that is neither terminal nor a known in-progress value', async () => {
    vi.useFakeTimers();
    const getJob = vi.fn(async () => ({ status: 'Cancelled' })) as unknown as JobWaiter['getJob'];

    const pending = pollOscJobUntilDone(waiter(getJob), 'svc', 'job4', 'sat');
    const assertion = expect(pending).rejects.toThrow(/unrecognised status "Cancelled"/);
    // Well inside the 5-minute overall timeout: the point is that the wait does
    // NOT hold the caller open until then.
    await vi.advanceTimersByTimeAsync(35_000);
    await assertion;
  });

  it('does not fail on an unrecognised status that clears within the grace window', async () => {
    vi.useFakeTimers();
    const getJob = vi
      .fn()
      .mockResolvedValueOnce({ status: 'Pending' })
      .mockResolvedValueOnce({ status: 'Running' })
      .mockResolvedValue({ status: 'SuccessCriteriaMet' }) as unknown as JobWaiter['getJob'];

    const pending = pollOscJobUntilDone(waiter(getJob), 'svc', 'job5', 'sat');
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
