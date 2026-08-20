// Boot-time reachability self-check for the local Encore profiles index
// (issue #284).
//
// Background: each Encore instance the auto-scaler spawns is a SEPARATE OSC
// container that HTTP-GETs its `profilesUrl` with Java's UrlResource — a plain,
// UNAUTHENTICATED GET that cannot present a bearer token
// (src/encore-scaler/instance-pool.ts). When PUBLIC_BASE_URL is set, the app
// points that URL at its own GET /api/v1/profiles/index.yml
// (src/main.ts — `encoreScalerProfilesUrl`).
//
// The whole profiles router is unauthenticated *inside the app* (there is no
// in-app auth hook — the global preHandler at src/main.ts only resolves stack
// connections and never rejects; see the router comment in
// src/routes/profiles.ts). The only thing that can reject Encore's fetch is the
// OSC login wall at the platform edge, which returned 401 on
// /api/v1/profiles/index.yml (docs/osc-feedback/
// incoming-08-login-wall-blocks-encore-profile-fetch.md). OSC said on
// 2026-07-08 they would make /api/v1/profiles publicly accessible for the app,
// but that was left UNCONFIRMED.
//
// This check closes that confirmation gap at runtime: at startup, once the
// server is listening and the derived profiles URL is known, the app fetches
// its OWN derived profiles index URL UNAUTHENTICATED (exactly as Encore would).
// A 401/403 or unreachable result is logged as a HARD ERROR — so a silent
// fallback (Encore quietly loading the remote default index instead of the
// operator-managed local store) is surfaced loudly instead of hidden. The
// check is non-fatal: it logs and returns; the server keeps running.

// Timeout so a slow/hung edge can't hang startup. Matches the profile-bootstrap
// FETCH_TIMEOUT_MS convention.
const FETCH_TIMEOUT_MS = 5000;

export type ReachabilityLogger = {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// Injectable fetch so the check is testable without real network I/O. Defaults
// to the global fetch in production.
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number }>;

export type ReachabilityOutcome =
  | { ok: true; status: number }
  | { ok: false; kind: 'auth-wall'; status: number }
  | { ok: false; kind: 'unreachable'; status?: number; error?: unknown };

/**
 * Fetch this deployment's own derived Encore profiles index URL UNAUTHENTICATED
 * and log a HARD ERROR when it is not reachable as Encore would see it.
 *
 * A 401/403 means the OSC login wall is still gating the path — the exact
 * failure Encore's tokenless UrlResource fetch hits — so the local profile
 * store is effectively a no-op (Encore silently falls back to the remote
 * default index). Any other non-OK response or network failure is likewise
 * reported as a hard error.
 *
 * Non-fatal by design: this logs and returns; it never throws and the caller
 * continues booting. (No evidence startup should abort: the app is still fully
 * functional for its own API consumers; only Encore's custom-profile fetch is
 * degraded, and the app already falls back to a working remote default index.)
 *
 * @param opts.profilesIndexUrl the derived absolute URL Encore is handed
 *   (e.g. `${PUBLIC_BASE_URL}/api/v1/profiles/index.yml`). When undefined the
 *   check is skipped (no local URL was derived; the remote-default fallback is
 *   already logged by the caller as a warning).
 * @param opts.usingLocalIndex whether `profilesIndexUrl` is this app's OWN
 *   local index (true) or the remote default fallback (false). The hard-error
 *   semantics only apply to the local index; the remote default is out of scope.
 * @returns the outcome for programmatic use/testing.
 */
export async function checkProfilesIndexReachable(opts: {
  profilesIndexUrl: string | undefined;
  usingLocalIndex: boolean;
  log: ReachabilityLogger;
  fetchImpl?: FetchLike;
}): Promise<ReachabilityOutcome | undefined> {
  const { profilesIndexUrl, usingLocalIndex, log } = opts;
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  // No local index to verify: the app is already using the remote default
  // fallback, which the caller surfaces as a warning. Nothing to self-check.
  if (!profilesIndexUrl || !usingLocalIndex) {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(profilesIndexUrl, { signal: controller.signal });
    if (res.status === 401 || res.status === 403) {
      log.error(
        { url: profilesIndexUrl, status: res.status },
        'profiles-index reachability check FAILED: the local Encore profiles index is behind the OSC login wall (401/403). ' +
          'Encore instances fetch this URL unauthenticated and will be REJECTED, silently falling back to the remote default index — ' +
          'operator-managed profiles will NOT be used. Confirm the OSC platform has made /api/v1/profiles publicly accessible for this app (issue #284).'
      );
      return { ok: false, kind: 'auth-wall', status: res.status };
    }
    if (!res.ok) {
      log.error(
        { url: profilesIndexUrl, status: res.status },
        'profiles-index reachability check FAILED: the local Encore profiles index returned a non-OK status. ' +
          'Encore instances may be unable to load operator-managed profiles (issue #284).'
      );
      return { ok: false, kind: 'unreachable', status: res.status };
    }
    log.info(
      { url: profilesIndexUrl, status: res.status },
      'profiles-index reachability check OK: the local Encore profiles index is reachable unauthenticated (OSC login-wall exemption confirmed at runtime).'
    );
    return { ok: true, status: res.status };
  } catch (err) {
    log.error(
      { url: profilesIndexUrl, err },
      'profiles-index reachability check FAILED: could not reach the local Encore profiles index. ' +
        'Encore instances may be unable to load operator-managed profiles (issue #284).'
    );
    return { ok: false, kind: 'unreachable', error: err };
  } finally {
    clearTimeout(timeout);
  }
}
