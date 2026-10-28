// Recorded paging contract for Encore's `findByStatus` search (issue #769).
//
// WHY THIS FILE EXISTS
// The scaler's dropped-job detection now DECIDES on the answer to "which of my
// externalIds is Encore still running?" — a job that looks absent is written
// terminally FAILED. That makes two properties of the HATEOAS page load-bearing:
//
//   1. `page.totalElements` is the count across ALL pages, not the size of the
//      returned page. If it were the page size, `totalElements > documents.length`
//      would never fire and the truncation guard would be dead code that silently
//      never protects anything.
//   2. There is a maximum accepted `size`, above which the request is quietly
//      clamped rather than rejected.
//
// Until now both existed only as prose in a header comment and a friction log
// (#769 review finding 2). They are recorded here AS DATA and pinned by
// test/encore-findbystatus-contract.test.ts against the vendored artefact at
// docs/contracts/encore-findbystatus-paging.json, so a drift in either the
// service or our reading of it fails CI instead of failing a production job.
//
// CONTRACT SOURCES (CLAUDE.md rule 7)
//
// A live catalog Encore instance was NOT reachable when this was written
// (2026-09-29): the OSC personal access token available to the build is rejected
// — `GET https://catalog.svc.prod.osaas.io/mysubscriptions` answers 401
// "Authorization token is invalid: The token signature is invalid" — so neither
// `listInstances` nor `{instanceUrl}/v3/api-docs` could be called. Stating that
// explicitly rather than pretending to a live fetch.
//
// So the contract is pinned from the two strongest sources that ARE reachable:
//
//   A. Encore's own source, fetched at pinned commit
//      svt/encore@8dd7c596c51a8c31bae805e31ff0969564f68229 (master HEAD,
//      2026-09-14). This is stronger than the OpenAPI document for property 1,
//      because the OpenAPI document only NAMES `PageMetadata.totalElements` — it
//      never says what it counts. The source does:
//        - EncoreController.kt:101-111 — `@GetMapping("/search/findByStatus")`,
//          `@RequestParam status: Status`, `@ParameterObject Pageable`
//          (`page`/`size`/`sort`, `@PageableDefault(size = 10)`), returning
//          `PagedModel<EntityModel<EncoreJob>>`.
//        - RedisService.kt:154-163 — `findByQuery` returns
//          `PageImpl(jobs, pageable, count)` where `count = searchReply.count`
//          (:158) is the FULL Redis FT.SEARCH match count and `jobs` is limited
//          to the requested window by `searchArgs.limit(offset, pageSize)`
//          (:167). `Page.getTotalElements()` is that `count`. THAT is the proof
//          of property 1.
//        - Spring HATEOAS `PagedResourcesAssembler` (injected at
//          EncoreController.kt:52, applied at :107-110) adds the `next` link if
//          and only if `page.hasNext()`. For page 0, `hasNext()` is exactly
//          `totalElements > documents.length` — so the two truncation tests are
//          the same test, which is what the contract test asserts.
//        - Status.kt:7-13 — the status enum.
//        - EncoreJob.kt:44 — `val externalId: String? = null` (NULLABLE; a
//          document may carry no externalId, which is why the reader skips
//          falsy values rather than assuming the field).
//
//   B. The live capture recorded on 2026-09-26 against a catalog instance and
//      written up in docs/osc-feedback/incoming-issue769-encore-findbystatus-paging.md
//      (two throwaway jobs seeded under a known externalId prefix, read back at
//      size=1 and size=100, then deleted). Reproduced as data in
//      `recordedResponses` in the vendored artefact. It is the only evidence for
//      the size clamp, and it independently corroborates A: the `_links` rel sets
//      it recorded (first/self/next/last at size=1, self only at size=100) are
//      exactly what `PagedResourcesAssembler.addPaginationLinks` emits for a
//      navigable and a non-navigable page.
//
// ON THE CLAMP VALUE: Encore configures no maximum page size of its own, so the
// effective clamp comes from whichever Spring pageable argument resolver is in
// play and is therefore version- and classpath-dependent — Spring Data REST
// defaults to 1000 (and `spring-boot-starter-data-rest` IS on encore-web's
// classpath, encore-web/build.gradle.kts:14), while the plain Spring Data web
// resolver defaults to 2000. 1000 was what the live capture observed. We request
// the LOWEST observed clamp so the request is never silently reduced. Nothing
// about correctness rests on that number: it rests on `truncated`, which is
// computed from the response itself and stays right whatever the clamp turns out
// to be.

// Provenance of the recording above, asserted by the contract test so the pin
// cannot drift silently away from the artefact it was taken from.
export const ENCORE_PAGING_CONTRACT_SOURCE = {
  repo: 'svt/encore',
  ref: '8dd7c596c51a8c31bae805e31ff0969564f68229',
  openApiTitle: 'Encore OpenAPI',
  openApiPath: '/v3/api-docs',
  // Path of the vendored artefact, relative to the repository root.
  snapshot: 'docs/contracts/encore-findbystatus-paging.json',
  verifiedOn: '2026-09-29'
} as const;

// The statuses that mean "this instance still has work for this job". A freshly
// dispatched job sits in QUEUED until Encore picks it up, so IN_PROGRESS alone
// would make an instance look idle immediately after dispatch.
export const ENCORE_ACTIVE_STATUSES = ['QUEUED', 'IN_PROGRESS'] as const;
export type EncoreActiveStatus = (typeof ENCORE_ACTIVE_STATUSES)[number];

// Status.kt:7-13, in declaration order.
export const ENCORE_STATUS_ENUM = [
  'NEW',
  'QUEUED',
  'IN_PROGRESS',
  'SUCCESSFUL',
  'FAILED',
  'CANCELLED'
] as const;

// The largest page size observed to be honoured (see "ON THE CLAMP VALUE"
// above). Exported so operator logs interpolate the real value instead of
// repeating a literal that has already drifted once (#769 review finding 5).
export const ENCORE_MAX_PAGE_SIZE = 1000;

export const ENCORE_FINDBYSTATUS = {
  method: 'GET',
  path: '/encoreJobs/search/findByStatus',
  queryParameters: ['status', 'page', 'size', 'sort'],
  // EncoreController.kt:106 @PageableDefault(size = 10) — i.e. NOT asking for a
  // size is the same as asking for 10, which is why the reader always passes one.
  defaultPageSize: 10,
  mediaType: 'application/hal+json',
  schema: 'PagedModelEntityModelEncoreJob',
  documentsAt: '_embedded.encoreJobs',
  pageMetadataSchema: 'PageMetadata',
  pageMetadataFields: ['size', 'totalElements', 'totalPages', 'number'],
  // The one property the truncation guard rests on: RedisService.kt:158-162.
  totalElementsMeaning: 'all-pages',
  // PagedResourcesAssembler adds this rel iff page.hasNext().
  nextLinkRel: 'next'
} as const;

// The raw wire shape the reader accepts. Everything is optional because a
// non-Encore body (a proxy error page, an empty 200) must parse to "unknown"
// rather than throw — `readEncoreJobPage` returns undefined for those.
export type EncoreJobPageBody = {
  _embedded?: { encoreJobs?: Array<{ externalId?: string }> };
  _links?: Record<string, unknown>;
  page?: { size?: number; totalElements?: number; totalPages?: number; number?: number };
};

export type EncoreJobPage = {
  // externalIds present on THIS page, in page order, skipping documents that
  // carry none (EncoreJob.externalId is nullable — EncoreJob.kt:44).
  externalIds: string[];
  // Number of documents on this page, INCLUDING any without an externalId, so
  // the truncation comparison is against the real page length.
  documentCount: number;
  // page.totalElements — the count across ALL pages (RedisService.kt:158-162).
  totalElements: number;
  // `_links.next` present (PagedResourcesAssembler: iff page.hasNext()).
  hasNextLink: boolean;
};

// Build the findByStatus URL for one status. Single definition so the request
// this repo makes and the request the contract test asserts cannot diverge.
export function buildFindByStatusUrl(
  instanceUrl: string,
  status: EncoreActiveStatus | (typeof ENCORE_STATUS_ENUM)[number],
  options: { page?: number; size?: number } = {}
): string {
  const base = instanceUrl.replace(/\/+$/, '');
  const page = options.page ?? 0;
  const size = options.size ?? ENCORE_MAX_PAGE_SIZE;
  return `${base}${ENCORE_FINDBYSTATUS.path}?status=${status}&page=${page}&size=${size}`;
}

// Parse a findByStatus body against the recorded contract. Returns undefined
// when the body is not a page we can read — specifically when
// `page.totalElements` is absent or non-numeric, because that is the field every
// downstream decision (count correction AND truncation) is derived from. A
// caller that gets undefined must treat the instance's state as UNKNOWN, never
// as empty.
export function readEncoreJobPage(body: unknown): EncoreJobPage | undefined {
  const page = body as EncoreJobPageBody | null | undefined;
  const totalElements = page?.page?.totalElements;
  if (typeof totalElements !== 'number' || !Number.isFinite(totalElements)) {
    return undefined;
  }
  const documents = page?._embedded?.encoreJobs ?? [];
  const externalIds: string[] = [];
  for (const doc of documents) {
    if (doc?.externalId) externalIds.push(doc.externalId);
  }
  return {
    externalIds,
    documentCount: documents.length,
    totalElements,
    hasNextLink: Boolean(page?._links?.[ENCORE_FINDBYSTATUS.nextLinkRel])
  };
}

// Is this page only PART of what Encore reports for the status?
//
// Two equivalent tests are OR'd rather than picking one. `totalElements >
// documentCount` is the primary reading and the one that holds for any page
// number; `_links.next` is the service's own statement of the same fact. They
// agree by construction (both derive from the same `Page`), so the OR only ever
// matters if a future Encore emits one without the other — in which case erring
// toward "partial" is the safe direction, since `truncated` only ever WITHHOLDS
// a conclusion.
export function isTruncatedPage(page: EncoreJobPage): boolean {
  return page.totalElements > page.documentCount || page.hasNextLink;
}
