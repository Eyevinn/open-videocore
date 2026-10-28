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
// Self-signed cert on the app's own URL (issue #337): from INSIDE the cluster
// the app's own public URL serves a self-signed certificate, so probing it with
// the default global fetch (strict TLS verification) throws a "self-signed
// certificate" error. That made this reachability self-check hard-fail purely
// because of the cert — not because the path was actually unreachable — which
// muddied startup diagnostics. This probe is a self-call to THIS deployment's
// OWN URL, so trusting that URL's certificate for THIS request only is correct
// and safe. The default production probe below (nodeSelfProbeFetch) therefore
// relaxes TLS verification for THIS self-reachability request ONLY, via the
// per-request agent of node:https — it does NOT call setGlobalDispatcher, does
// NOT set NODE_TLS_REJECT_UNAUTHORIZED, and does NOT touch the global fetch, so
// every other outbound OSC call keeps full, strict TLS verification.
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
//
// ---------------------------------------------------------------------------
// ADR-026 D4 (issue #1209, re-scoping #1103): the probe FOLLOWS THE RESOLVED
// TIER.
//
// ADR-026 D1/D2 made the object-store-published index the PRIMARY `profilesUrl`
// and demoted `${PUBLIC_BASE_URL}/api/v1/profiles/index.yml` to a fallback, so
// the single boolean this check used to take (`usingLocalIndex`, computed by the
// call site from `Boolean(publicBaseUrl)`) mis-scoped it in two opposite
// directions: with the new tier winning it probed the BUCKET while emitting
// login-wall/#284 wording that is wrong for an object-store origin, and on a
// catalog deploy — where `PUBLIC_BASE_URL` is unsettable (ADR-026 C9) — it was
// skipped entirely, leaving the new primary with no boot check at all.
//
// So this module now takes the resolved `ProfilesUrlOrigin` itself
// (src/services/public-base-url.ts, `resolveEncoreProfilesUrlWithOrigin`) and:
//   - probes `app-path` exactly as before, with the login-wall/#284 wording
//     that is accurate ONLY there;
//   - probes `object-store` with its own wording — bucket, key, anonymous-read
//     policy, in-cluster vs public endpoint — which never mentions the login
//     wall, and additionally performs ADR-026 D4's PUBLISH VERIFICATION: the
//     published `index.yml` is fetchable AND the entry count it serves matches
//     the count the publisher reported writing;
//   - stays a no-op for `override` / `param-store` / `remote-default`, which are
//     operator-typed or third-party indexes this app neither serves nor
//     publishes (unchanged: only the app path was ever probed).
//
// Everything else about the probe is deliberately UNCHANGED (ADR-026 D4): still
// ONE-SHOT (no periodic probe is introduced — #1103's interval scope is
// rejected), still NON-FATAL, still using the scoped `nodeSelfProbeFetch` TLS
// relaxation for the self-call (#337), and still returning the same
// `ReachabilityOutcome` discriminated union. Only WHICH origin is probed and HOW
// a failure is described changed — plus the one new `stale-index` outcome the
// publish verification needs to be able to report.
// ---------------------------------------------------------------------------

import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { ProfilesUrlOrigin } from './public-base-url.js';
import {
  PROFILES_BUCKET,
  PUBLISHED_INDEX_KEY,
  countPublishedProfileIndexEntries
} from './profile-index-publisher.js';

// Timeout so a slow/hung edge can't hang startup. Matches the profile-bootstrap
// FETCH_TIMEOUT_MS convention.
const FETCH_TIMEOUT_MS = 5000;

// A per-request HTTPS agent that does NOT reject a self-signed / unverifiable
// certificate. Scoped to THIS module's self-probe only — it is passed as the
// `agent` on a single node:https request and never installed globally, so it
// cannot relax TLS for any other outbound call. Justification (issue #337): the
// probe targets THIS deployment's OWN public URL, which serves a self-signed
// cert from inside the cluster; trusting that one URL's cert for this self-call
// is the least-invasive correct fix and leaves strict TLS in force everywhere
// else.
const selfProbeHttpsAgent = new HttpsAgent({ rejectUnauthorized: false });

export type ReachabilityLogger = {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// Upper bound on the index body the probe will read when it needs to COUNT the
// published entries (ADR-026 D4 publish verification). A published index is one
// `name: <name>.yml` line per runnable profile, so a few KB in practice; the cap
// exists purely so a misrouted URL serving something huge can neither balloon
// boot memory nor keep the socket open. A body that hits the cap is reported
// TRUNCATED and the count comparison is SKIPPED rather than guessed at.
const MAX_PROBE_BODY_BYTES = 256 * 1024;

/**
 * What the probe asks of a single request.
 *
 * `collectBody` is opt-in: the app-path probe only cares about the status code,
 * so it keeps draining and discarding the body exactly as before. Only the
 * object-store publish verification asks for the bytes.
 */
export type ProbeInit = { signal?: AbortSignal; collectBody?: boolean };

/**
 * What the probe gets back. `body`/`bodyTruncated` are present only when
 * `collectBody` was requested, so a caller (or a test stub) that resolves with
 * just `{ ok, status }` is unchanged and still valid.
 */
export type ProbeResponse = {
  ok: boolean;
  status: number;
  body?: string;
  bodyTruncated?: boolean;
};

// Injectable fetch so the check is testable without real network I/O. Defaults
// in production to nodeSelfProbeFetch (below), which tolerates a self-signed
// cert on the app's own URL (issue #337).
export type FetchLike = (input: string, init?: ProbeInit) => Promise<ProbeResponse>;

/**
 * Default production probe: an UNAUTHENTICATED GET (exactly as Encore's tokenless
 * UrlResource would issue) that TOLERATES a self-signed / unverifiable cert on
 * the app's OWN URL (issue #337). Implemented with node:https/node:http and a
 * per-request agent so TLS relaxation is scoped to THIS single self-call and
 * never leaks to any other outbound request.
 *
 * By default resolves with only { ok, status } and the body is drained and
 * discarded — the reachability check only cares about the status code. When
 * `init.collectBody` is set (the object-store publish verification, ADR-026 D4)
 * the body is additionally read, bounded by MAX_PROBE_BODY_BYTES, and returned
 * as `body` with `bodyTruncated` telling the caller whether it is complete.
 */
export function nodeSelfProbeFetch(input: string, init?: ProbeInit): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch (err) {
      reject(err);
      return;
    }
    const isHttps = url.protocol === 'https:';
    const doRequest = isHttps ? httpsRequest : httpRequest;
    const req = doRequest(
      url,
      {
        method: 'GET',
        // Relax TLS verification for THIS self-probe request only. No-op for
        // plain http:// (the agent option is ignored there).
        ...(isHttps ? { agent: selfProbeHttpsAgent } : {})
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const ok = status >= 200 && status < 300;
        if (!init?.collectBody) {
          // Drain and discard the body so the socket can be freed/reused.
          res.resume();
          resolve({ ok, status });
          return;
        }
        // Bounded read for the publish verification (ADR-026 D4). Past the cap
        // we stop reading and report the body as truncated, so the caller skips
        // the count comparison instead of comparing against a partial body.
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          if (size + chunk.byteLength > MAX_PROBE_BODY_BYTES) {
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.byteLength;
        });
        const done = () =>
          resolve({
            ok,
            status,
            body: Buffer.concat(chunks).toString('utf8'),
            bodyTruncated: truncated
          });
        res.on('end', done);
        // `res.destroy()` above ends the stream with 'close', not 'end'.
        res.on('close', done);
        res.on('error', () => resolve({ ok, status, body: '', bodyTruncated: true }));
      }
    );
    req.on('error', reject);
    if (init?.signal) {
      const signal = init.signal;
      const onAbort = () => req.destroy(new Error('aborted'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

export type ReachabilityOutcome =
  | { ok: true; status: number }
  | { ok: false; kind: 'auth-wall'; status: number }
  | { ok: false; kind: 'unreachable'; status?: number; error?: unknown }
  // ADR-026 D4 publish verification (issue #1209), object-store origin ONLY: the
  // published index IS fetchable, but the entry count it serves does not match
  // the count the publisher reported writing — i.e. the bucket is stale relative
  // to the profile store and Encore would load the wrong profile set. Additive:
  // the three outcomes above are untouched, and this one can only arise on the
  // object-store origin.
  | {
      ok: false;
      kind: 'stale-index';
      status: number;
      publishedProfileCount: number;
      expectedProfileCount: number;
    };

// The origins this check probes. `app-path` is the pre-ADR-026 behaviour;
// `object-store` is the new primary tier the boot check is extended to
// (ADR-026 D4). `override`, `param-store` and `remote-default` are
// operator-typed or third-party indexes this app neither serves nor publishes,
// so there is nothing of ours to confirm and no wording that would be accurate
// for them — they stay a no-op, exactly as they are today.
const PROBED_ORIGINS: ReadonlySet<ProfilesUrlOrigin> = new Set<ProfilesUrlOrigin>([
  'app-path',
  'object-store'
]);

/**
 * Fetch the resolved Encore profiles index URL UNAUTHENTICATED (exactly as
 * Encore's tokenless `UrlResource` would) and log a HARD ERROR when it is not
 * usable as Encore would see it.
 *
 * SCOPED TO THE RESOLVED TIER (ADR-026 D4, issue #1209). `opts.origin` is the
 * tier {@link resolveEncoreProfilesUrlWithOrigin} actually chose — never
 * re-derived here or at the call site — and it decides both WHETHER to probe and
 * HOW a failure is described:
 *
 *   - `'app-path'` (`${PUBLIC_BASE_URL}/api/v1/profiles/index.yml`): unchanged
 *     behaviour. A 401/403 means the OSC login wall is still gating the path —
 *     the exact failure Encore hits — so the local profile store is effectively
 *     a no-op (Encore silently falls back to the remote default index). The
 *     login-wall / issue-#284 wording lives here and ONLY here, because this is
 *     the only origin it is accurate for.
 *   - `'object-store'` (the published index, ADR-026 D1/D2 primary): probed too,
 *     so a catalog deploy — where `PUBLIC_BASE_URL` cannot be set at all
 *     (ADR-026 C9) and the old boolean skipped the check entirely — still gets a
 *     boot check. Failures are described in terms of the bucket, the object key,
 *     the anonymous-read `GetObject` policy (ADR-026 D3) and which endpoint form
 *     was used; the login wall is never mentioned. When
 *     `opts.expectedProfileCount` is supplied this additionally performs
 *     ADR-026 D4's PUBLISH VERIFICATION — the served index's entry count must
 *     match what the publisher reported writing — reporting `stale-index` when
 *     it does not.
 *   - every other origin: a no-op, as today.
 *
 * Non-fatal by design: this logs and returns; it never throws and the caller
 * continues booting. (No evidence startup should abort: the app is still fully
 * functional for its own API consumers; only Encore's custom-profile fetch is
 * degraded, and the app already falls back to a working index tier.) One-shot by
 * design: ADR-026 D4 rejects #1103's periodic-probe scope.
 *
 * @param opts.profilesIndexUrl the resolved absolute URL Encore is handed. When
 *   undefined the check is skipped (nothing was resolved; the caller already
 *   logs the remote-default fallback as a warning).
 * @param opts.origin the resolved tier, from `resolveEncoreProfilesUrlWithOrigin`
 *   (`ProfilesUrlOrigin`, src/services/public-base-url.ts).
 * @param opts.expectedProfileCount object-store origin only: the number of
 *   profile entries the publisher reported writing
 *   (`PublishOutcome.profileCount`, src/services/profile-index-publisher.ts).
 *   Omit to check fetchability only.
 * @param opts.bucket object-store origin only: the bucket published to
 *   (`PublishOutcome.bucket`); defaults to {@link PROFILES_BUCKET}. Log context.
 * @param opts.endpointKind object-store origin only: which ADR-026 D2 endpoint
 *   form the URL took (`PublishOutcome.endpointKind`). Log context.
 * @returns the outcome for programmatic use/testing.
 */
export async function checkProfilesIndexReachable(opts: {
  profilesIndexUrl: string | undefined;
  origin: ProfilesUrlOrigin;
  log: ReachabilityLogger;
  expectedProfileCount?: number;
  bucket?: string;
  endpointKind?: 'in-cluster' | 'public';
  fetchImpl?: FetchLike;
}): Promise<ReachabilityOutcome | undefined> {
  const { profilesIndexUrl, origin, log } = opts;
  // Default to the self-signed-cert-tolerant node probe (issue #337) rather than
  // the global fetch: the app's own public URL serves a self-signed cert from
  // inside the cluster, and strict global-fetch TLS verification would hard-fail
  // this self-call on the cert alone. The relaxation is confined to this one
  // probe (see nodeSelfProbeFetch); tests inject their own fetchImpl.
  const doFetch = opts.fetchImpl ?? nodeSelfProbeFetch;

  // Nothing of ours to verify: no URL resolved at all, or the resolved tier is
  // an operator-typed/third-party index this app neither serves nor publishes.
  if (!profilesIndexUrl || !PROBED_ORIGINS.has(origin)) {
    return undefined;
  }

  const objectStore = origin === 'object-store';
  // Count verification is only meaningful for the published index, and only when
  // the publisher told us what it wrote.
  const verifyCount = objectStore && typeof opts.expectedProfileCount === 'number';
  const ctx: Record<string, unknown> = { url: profilesIndexUrl, origin };
  if (objectStore) {
    ctx['bucket'] = opts.bucket ?? PROFILES_BUCKET;
    ctx['objectKey'] = PUBLISHED_INDEX_KEY;
    if (opts.endpointKind) ctx['endpointKind'] = opts.endpointKind;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(profilesIndexUrl, {
      signal: controller.signal,
      ...(verifyCount ? { collectBody: true } : {})
    });
    if (res.status === 401 || res.status === 403) {
      log.error(
        { ...ctx, status: res.status },
        objectStore
          ? 'published profile index check FAILED: the object-store-published Encore profile index returned 401/403. ' +
              'Encore instances fetch this URL unauthenticated and will be REJECTED, so the published index is unusable and Encore loads its built-in defaults instead. ' +
              'Verify the anonymous read-only GetObject policy is in force on the profiles bucket (ADR-026 D3) and that the object key above exists.'
          : 'profiles-index reachability check FAILED: the local Encore profiles index is behind the OSC login wall (401/403). ' +
              'Encore instances fetch this URL unauthenticated and will be REJECTED, silently falling back to the remote default index — ' +
              'operator-managed profiles will NOT be used. Confirm the OSC platform has made /api/v1/profiles publicly accessible for this app (issue #284).'
      );
      return { ok: false, kind: 'auth-wall', status: res.status };
    }
    if (!res.ok) {
      log.error(
        { ...ctx, status: res.status },
        objectStore
          ? 'published profile index check FAILED: the object-store-published Encore profile index returned a non-OK status. ' +
              'Confirm the index object was written to the profiles bucket and that the object-store endpoint handed to Encore is reachable from the transcoder (ADR-026 D1/D2).'
          : 'profiles-index reachability check FAILED: the local Encore profiles index returned a non-OK status. ' +
              'Encore instances may be unable to load operator-managed profiles (issue #284).'
      );
      return { ok: false, kind: 'unreachable', status: res.status };
    }

    // ADR-026 D4 publish verification: fetchable is necessary but not
    // sufficient for the primary tier — the index must also name the profiles
    // the store actually published, or Encore silently runs a stale profile set.
    if (verifyCount) {
      const expectedProfileCount = opts.expectedProfileCount as number;
      if (typeof res.body !== 'string' || res.bodyTruncated) {
        // Could not read a complete body (an injected probe that does not
        // collect bodies, or an index larger than the cap). Report the
        // fetchability result honestly rather than inventing a count.
        log.info(
          { ...ctx, status: res.status, expectedProfileCount, countVerified: false },
          'published profile index check OK (fetchable unauthenticated); profile-count verification SKIPPED because the index body was unavailable or truncated.'
        );
        return { ok: true, status: res.status };
      }
      const publishedProfileCount = countPublishedProfileIndexEntries(res.body);
      if (publishedProfileCount !== expectedProfileCount) {
        log.error(
          { ...ctx, status: res.status, publishedProfileCount, expectedProfileCount },
          'published profile index check FAILED: the published index is fetchable but serves a different number of profile entries than the publisher wrote — ' +
            'the profiles bucket is STALE relative to the profile store, so Encore would load the wrong profile set. A republish is required (ADR-026 D4).'
        );
        return {
          ok: false,
          kind: 'stale-index',
          status: res.status,
          publishedProfileCount,
          expectedProfileCount
        };
      }
      log.info(
        { ...ctx, status: res.status, publishedProfileCount, countVerified: true },
        'published profile index VERIFIED: fetchable unauthenticated from the object store and its profile count matches the store (ADR-026 D1/D4).'
      );
      return { ok: true, status: res.status };
    }

    log.info(
      { ...ctx, status: res.status },
      objectStore
        ? 'published profile index check OK: the object-store-published Encore profile index is fetchable unauthenticated (ADR-026 D1/D3).'
        : 'profiles-index reachability check OK: the local Encore profiles index is reachable unauthenticated (OSC login-wall exemption confirmed at runtime).'
    );
    return { ok: true, status: res.status };
  } catch (err) {
    log.error(
      { ...ctx, err },
      objectStore
        ? 'published profile index check FAILED: could not reach the object-store-published Encore profile index. ' +
            'Encore instances may be unable to load the published profiles; confirm the object-store endpoint handed to Encore is reachable (ADR-026 D2).'
        : 'profiles-index reachability check FAILED: could not reach the local Encore profiles index. ' +
            'Encore instances may be unable to load operator-managed profiles (issue #284).'
    );
    return { ok: false, kind: 'unreachable', error: err };
  } finally {
    clearTimeout(timeout);
  }
}
