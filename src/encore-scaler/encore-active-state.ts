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
//   Encore REST: GET {instanceUrl}/encoreJobs/search/findByStatus?status=...
//   returns a Spring HATEOAS page
//     { _embedded: { encoreJobs: [{ id, externalId, ... }] },
//       page: { totalElements } }
//   Verified against the identical readers already in this repo:
//     - src/pipeline/encore-callback-poller.ts sweepTerminalJobs (findByStatus
//       page + externalId per encoreJob),
//     - src/routes/internal.ts encoreCallbackSchema (externalId/status fields).
//   Bearer auth: the OSC service access token, exactly as
//   src/pipeline/encore-client.ts sends it.

export type EncoreActiveState = {
  // QUEUED + IN_PROGRESS count. A freshly dispatched job sits in QUEUED until
  // Encore picks it up, so counting only IN_PROGRESS would make an instance look
  // idle immediately after dispatch.
  count: number;
  // The externalIds Encore still reports active (used by the dropped-job diff).
  activeExternalIds: Set<string>;
};

type EncoreJobPage = {
  _embedded?: { encoreJobs?: Array<{ externalId?: string }> };
  page?: { totalElements?: number };
};

// Returns undefined when the real state could NOT be determined (network error,
// non-2xx, unparseable page). Callers MUST treat undefined conservatively: never
// destroy an instance whose in-flight state could not be confirmed empty.
export async function fetchEncoreActiveState(
  instanceUrl: string,
  token: string
): Promise<EncoreActiveState | undefined> {
  try {
    const base = instanceUrl.replace(/\/+$/, '');
    const [resQ, resP] = await Promise.all([
      fetch(`${base}/encoreJobs/search/findByStatus?status=QUEUED&page=0&size=100`, {
        headers: { authorization: `Bearer ${token}` }
      }),
      fetch(`${base}/encoreJobs/search/findByStatus?status=IN_PROGRESS&page=0&size=100`, {
        headers: { authorization: `Bearer ${token}` }
      })
    ]);
    if (!resQ.ok || !resP.ok) return undefined;

    const [bodyQ, bodyP] = await Promise.all([
      resQ.json().catch(() => ({})) as Promise<EncoreJobPage>,
      resP.json().catch(() => ({})) as Promise<EncoreJobPage>
    ]);
    const queuedCount = bodyQ.page?.totalElements;
    const inProgressCount = bodyP.page?.totalElements;
    if (typeof queuedCount !== 'number' || typeof inProgressCount !== 'number') {
      return undefined;
    }

    const activeExternalIds = new Set<string>();
    for (const j of bodyQ._embedded?.encoreJobs ?? []) {
      if (j.externalId) activeExternalIds.add(j.externalId);
    }
    for (const j of bodyP._embedded?.encoreJobs ?? []) {
      if (j.externalId) activeExternalIds.add(j.externalId);
    }

    return { count: queuedCount + inProgressCount, activeExternalIds };
  } catch {
    // Any error means we could not confirm the real state.
    return undefined;
  }
}
