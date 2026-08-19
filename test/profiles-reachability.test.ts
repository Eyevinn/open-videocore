// Boot-time profiles-index reachability self-check tests (issue #284).
//
// The check fetches this app's OWN derived Encore profiles index URL exactly as
// Encore would — an unauthenticated GET — and must log a HARD ERROR when the OSC
// login wall rejects it (401/403) or it is otherwise unreachable, while staying
// quiet (info-only) on a 200. Uses an injected fetch so there is no real network
// I/O; unrelated to the workspace-scoping suite failures.

import { describe, it, expect, vi } from 'vitest';
import {
  checkProfilesIndexReachable,
  type FetchLike,
  type ReachabilityLogger
} from '../src/services/profiles-reachability.js';

const LOCAL_URL = 'https://app.example.test/api/v1/profiles/index.yml';

function makeLogger(): ReachabilityLogger & {
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  return { error: vi.fn(), info: vi.fn() };
}

describe('profiles-index reachability self-check (issue #284)', () => {
  it('logs a HARD ERROR (not info) when the login wall returns 401', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: false, status: 401 }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: LOCAL_URL,
      usingLocalIndex: true,
      log,
      fetchImpl
    });

    expect(outcome).toEqual({ ok: false, kind: 'auth-wall', status: 401 });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
    // Fetched unauthenticated: no headers/authorization passed to fetch.
    expect(fetchImpl).toHaveBeenCalledWith(LOCAL_URL, expect.objectContaining({}));
    const initArg = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1] ?? {};
    expect(initArg).not.toHaveProperty('headers');
  });

  it('logs a HARD ERROR when the login wall returns 403', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: false, status: 403 }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: LOCAL_URL,
      usingLocalIndex: true,
      log,
      fetchImpl
    });

    expect(outcome).toEqual({ ok: false, kind: 'auth-wall', status: 403 });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('stays quiet (info only, no error) on a 200', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: LOCAL_URL,
      usingLocalIndex: true,
      log,
      fetchImpl
    });

    expect(outcome).toEqual({ ok: true, status: 200 });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('logs a HARD ERROR on other non-OK statuses (e.g. 500)', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: false, status: 500 }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: LOCAL_URL,
      usingLocalIndex: true,
      log,
      fetchImpl
    });

    expect(outcome).toEqual({ ok: false, kind: 'unreachable', status: 500 });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('logs a HARD ERROR when the fetch throws (unreachable / network error)', async () => {
    const log = makeLogger();
    const boom = new Error('ECONNREFUSED');
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw boom;
    });

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: LOCAL_URL,
      usingLocalIndex: true,
      log,
      fetchImpl
    });

    expect(outcome).toEqual({ ok: false, kind: 'unreachable', error: boom });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('is a no-op (no fetch, no logs) when no local index was derived', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: undefined,
      usingLocalIndex: false,
      log,
      fetchImpl
    });

    expect(outcome).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('is a no-op when the derived URL is the REMOTE default (not the local index)', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: 'https://raw.githubusercontent.com/Eyevinn/encore-test-profiles/refs/heads/main/profiles.yml',
      usingLocalIndex: false,
      log,
      fetchImpl
    });

    expect(outcome).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
