// Authoritative "does this Encore instance have work?" query (#778 review).
//
// This is the single implementation of the check the scaler treats as the truth
// about an instance's in-flight work. It was extracted from
// EncoreScalerLoop.fetchRealActiveState so BOTH teardown paths use the identical
// query:
//   - scale-down (scaler-loop.ts): never destroys a pool instance without it
//     (#513 drain-don't-kill),
//   - the orphan reaper (instance-pool.ts reapOrphanedInstances): must not
//     destroy an instance that is mid-transcode just because it is missing from
//     the pool hash.
//
// CONTRACT SOURCE VERIFIED (CLAUDE.md rule 7)
//   The endpoint, its parameters, the response envelope, the meaning of
//   `page.totalElements` and the `_links.next` truncation rule are all RECORDED
//   AS DATA in ./encore-paging-contract.ts and pinned by
//   test/encore-findbystatus-contract.test.ts against the vendored artefact
//   docs/contracts/encore-findbystatus-paging.json (#769 review finding 2). Read
//   that module's header for the full provenance — upstream
//   svt/encore@8dd7c596 file:line citations plus the 2026-09-26 live capture —
//   including why a live /v3/api-docs fetch was not possible at the time of
//   writing. Nothing about the wire shape is stated twice: this file builds its
//   URLs with `buildFindByStatusUrl` and reads its bodies with
//   `readEncoreJobPage` / `isTruncatedPage`, so the contract has exactly one
//   definition and exactly one place a test has to pin.
//
//   Bearer auth: the OSC service access token, exactly as
//   src/pipeline/encore-client.ts sends it. Consistent with the identical
//   readers already in this repo (src/pipeline/encore-callback-poller.ts
//   sweepTerminalJobs, src/routes/internal.ts encoreCallbackSchema).

import {
  ENCORE_ACTIVE_STATUSES,
  ENCORE_MAX_PAGE_SIZE,
  buildFindByStatusUrl,
  isTruncatedPage,
  readEncoreJobPage
} from './encore-paging-contract.js';

export type EncoreActiveState = {
  // QUEUED + IN_PROGRESS count. A freshly dispatched job sits in QUEUED until
  // Encore picks it up, so counting only IN_PROGRESS would make an instance look
  // idle immediately after dispatch.
  count: number;
  // The externalIds Encore still reports active (used by the dropped-job diff).
  activeExternalIds: Set<string>;
  // True when Encore reports MORE active jobs than this query returned documents
  // for — i.e. `page.totalElements` exceeds the number of encoreJobs on the
  // single page 0 we request for either status, or the page carries a `next`
  // link (#769 review finding 2). The `totalElements` reading this depends on is
  // pinned by the contract module, not assumed.
  //
  // `count` stays exact either way (it comes from totalElements), but
  // `activeExternalIds` is then a PARTIAL set: a job sitting off page 0 is
  // missing from it while genuinely running. Callers may therefore treat a
  // PRESENT externalId as proof the job is active, but must NOT treat an ABSENT
  // one as proof it is gone. Every diff that concludes "this tracked job
  // vanished" has to skip a truncated instance rather than classify against it.
  truncated: boolean;
};

// Encore's effective maximum page size — the largest single-request answer
// available, which keeps the page-0 blind spot as small as the service allows.
// Re-exported (rather than redeclared) so the operator logs in scaler-loop.ts
// interpolate the real value instead of a literal that has already drifted once
// (#769 review finding 5).
export const ACTIVE_PAGE_SIZE = ENCORE_MAX_PAGE_SIZE;

// Returns undefined when the real state could NOT be determined (network error,
// non-2xx, unparseable page). Callers MUST treat undefined conservatively: never
// destroy an instance whose in-flight state could not be confirmed empty.
export async function fetchEncoreActiveState(
  instanceUrl: string,
  token: string
): Promise<EncoreActiveState | undefined> {
  try {
    const [queuedStatus, inProgressStatus] = ENCORE_ACTIVE_STATUSES;
    const headers = { authorization: `Bearer ${token}` };
    const [resQ, resP] = await Promise.all([
      fetch(
        buildFindByStatusUrl(instanceUrl, queuedStatus, {
          page: 0,
          size: ACTIVE_PAGE_SIZE
        }),
        { headers }
      ),
      fetch(
        buildFindByStatusUrl(instanceUrl, inProgressStatus, {
          page: 0,
          size: ACTIVE_PAGE_SIZE
        }),
        { headers }
      )
    ]);
    if (!resQ.ok || !resP.ok) return undefined;

    const [bodyQ, bodyP] = await Promise.all([
      resQ.json().catch(() => ({})),
      resP.json().catch(() => ({}))
    ]);
    const queued = readEncoreJobPage(bodyQ);
    const inProgress = readEncoreJobPage(bodyP);
    // readEncoreJobPage returns undefined when page.totalElements is missing or
    // not a number — the single field every decision below derives from.
    if (!queued || !inProgress) return undefined;

    const activeExternalIds = new Set<string>([
      ...queued.externalIds,
      ...inProgress.externalIds
    ]);

    // Page-0 truncation (#769 review finding 2): we ask for one page per status,
    // so an instance holding more than ACTIVE_PAGE_SIZE QUEUED or IN_PROGRESS
    // jobs returns a complete-looking page that omits the rest. `isTruncatedPage`
    // is the recorded contract's own test for that (totalElements vs the
    // documents actually returned, or a `next` link) — see
    // encore-paging-contract.ts for why both readings are sound.
    const truncated = isTruncatedPage(queued) || isTruncatedPage(inProgress);

    return {
      count: queued.totalElements + inProgress.totalElements,
      activeExternalIds,
      truncated
    };
  } catch {
    // Any error means we could not confirm the real state.
    return undefined;
  }
}
