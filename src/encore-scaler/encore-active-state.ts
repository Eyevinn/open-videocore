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
//   Primary source — the Encore service's own OpenAPI document, fetched live from
//   a catalog instance: GET {instanceUrl}/v3/api-docs (openapi 3.1.0,
//   info.title "Encore OpenAPI"). Symbols verified there:
//     - path /encoreJobs/search/findByStatus, operationId
//       `executeSearch-encorejob-get`; query params `status`
//       (enum NEW|QUEUED|IN_PROGRESS|SUCCESSFUL|FAILED|CANCELLED), `page`
//       (integer, minimum 0), `size` (integer, minimum 1, default 20);
//       200 -> application/hal+json `PagedModelEntityModelEncoreJob`.
//     - schema PagedModelEntityModelEncoreJob:
//         { _embedded: { encoreJobs: EntityModelEncoreJob[] }, _links: Links,
//           page: PageMetadata }
//     - schema PageMetadata: { size, totalElements, totalPages, number }
//       (all int64).
//     - schema EncoreJobRequestBody/EntityModelEncoreJob: `externalId`
//       ("External id - for external backreference").
//   Bearer auth: the OSC service access token, exactly as
//   src/pipeline/encore-client.ts sends it.
//   Consistent with the identical readers already in this repo
//   (src/pipeline/encore-callback-poller.ts sweepTerminalJobs,
//   src/routes/internal.ts encoreCallbackSchema).
//
// PAGING SEMANTICS — EMPIRICALLY CONFIRMED, NOT ASSUMED (#769 review finding 4)
//   The OpenAPI document names the PageMetadata fields but does not state whether
//   `totalElements` counts the whole result set or just the returned page, and the
//   whole truncation guard below depends on the answer. Confirmed against a live
//   catalog Encore instance by seeding two jobs with a known externalId prefix and
//   reading the same page back at two sizes (jobs deleted again afterwards):
//     GET /encoreJobs/search/findByStatus?status=FAILED&page=0&size=1
//       -> _embedded.encoreJobs.length = 1
//          page = { size: 1, totalElements: 2, totalPages: 2, number: 0 }
//          _links = first, self, next, last
//     GET /encoreJobs/search/findByStatus?status=FAILED&page=0&size=100
//       -> _embedded.encoreJobs.length = 2
//          page = { size: 100, totalElements: 2, totalPages: 1, number: 0 }
//          _links = self
//   So `page.totalElements` is the total across ALL pages, and
//   `totalElements > _embedded.encoreJobs.length` really does identify a
//   truncated page. Also confirmed: `size` is silently clamped to 1000
//   (size=2000 and size=5000 both echoed page.size = 1000), which is why we ask
//   for the clamp value rather than a larger number that would be quietly
//   reduced.

export type EncoreActiveState = {
  // QUEUED + IN_PROGRESS count. A freshly dispatched job sits in QUEUED until
  // Encore picks it up, so counting only IN_PROGRESS would make an instance look
  // idle immediately after dispatch.
  count: number;
  // The externalIds Encore still reports active (used by the dropped-job diff).
  activeExternalIds: Set<string>;
  // True when Encore reports MORE active jobs than this query returned documents
  // for — i.e. `page.totalElements` exceeds the number of encoreJobs on the
  // single page 0 we request for either status (#769 review finding 2). The
  // `totalElements` reading this depends on is confirmed in the header note, not
  // assumed (#769 review finding 4).
  //
  // `count` stays exact either way (it comes from totalElements), but
  // `activeExternalIds` is then a PARTIAL set: a job sitting off page 0 is
  // missing from it while genuinely running. Callers may therefore treat a
  // PRESENT externalId as proof the job is active, but must NOT treat an ABSENT
  // one as proof it is gone. Every diff that concludes "this tracked job
  // vanished" has to skip a truncated instance rather than classify against it.
  truncated: boolean;
};

// Encore's effective maximum page size. Asking for more is silently clamped to
// this value (verified live: size=2000 and size=5000 both came back with
// page.size = 1000), so requesting the clamp value is the largest single-request
// answer available and keeps the page-0 blind spot as small as the service allows.
const ACTIVE_PAGE_SIZE = 1000;

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
      fetch(
        `${base}/encoreJobs/search/findByStatus?status=QUEUED&page=0&size=${ACTIVE_PAGE_SIZE}`,
        { headers: { authorization: `Bearer ${token}` } }
      ),
      fetch(
        `${base}/encoreJobs/search/findByStatus?status=IN_PROGRESS&page=0&size=${ACTIVE_PAGE_SIZE}`,
        { headers: { authorization: `Bearer ${token}` } }
      )
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

    const queuedDocs = bodyQ._embedded?.encoreJobs ?? [];
    const inProgressDocs = bodyP._embedded?.encoreJobs ?? [];

    const activeExternalIds = new Set<string>();
    for (const j of queuedDocs) {
      if (j.externalId) activeExternalIds.add(j.externalId);
    }
    for (const j of inProgressDocs) {
      if (j.externalId) activeExternalIds.add(j.externalId);
    }

    // Page-0 truncation (#769 review finding 2): we ask for one page per status,
    // so an instance holding more than ACTIVE_PAGE_SIZE QUEUED or IN_PROGRESS
    // jobs returns a complete-looking page that omits the rest. Comparing
    // Encore's own totalElements against the documents we actually got is what
    // makes a partial active set distinguishable from a complete one — and
    // `totalElements` is the all-pages total, confirmed live (see header).
    const truncated =
      queuedCount > queuedDocs.length || inProgressCount > inProgressDocs.length;

    return { count: queuedCount + inProgressCount, activeExternalIds, truncated };
  } catch {
    // Any error means we could not confirm the real state.
    return undefined;
  }
}
