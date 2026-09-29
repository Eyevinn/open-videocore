// Contract test for the Encore `findByStatus` paging semantics the scaler's
// dropped-job detection decides on (issue #769, review finding 2).
//
// WHAT THIS PINS AND WHY
// `fetchEncoreActiveState` calls an instance a job's active set is diffed
// against, and #769 turned the answer into a TERMINAL decision — a job that
// looks absent is written FAILED. Two properties of the response carry that
// decision:
//
//   1. `page.totalElements` counts the whole result set, not the returned page.
//      If it counted the page, `totalElements > documents.length` would be
//      false for every response ever and the truncation guard would be dead
//      code that silently never protects anything — a page-2 job would be
//      failed while running.
//   2. Asking for more than the service's clamp returns fewer documents than
//      requested with no error, so the guard cannot be replaced by "just ask for
//      a big enough page".
//
// Both existed only as prose in a header comment and a friction log. They are
// now recorded as data in src/encore-scaler/encore-paging-contract.ts and
// diffed here against the vendored artefact
// docs/contracts/encore-findbystatus-paging.json, so a drift in the service or
// in our reading of it fails CI rather than a production job.
//
// CONTRACT SOURCES (CLAUDE.md rule 7) — full provenance, including why a live
// `/v3/api-docs` fetch was not possible, is in the header of
// src/encore-scaler/encore-paging-contract.ts. In short: upstream
// svt/encore@8dd7c596c51a8c31bae805e31ff0969564f68229, specifically
// RedisService.kt:154-163 (`PageImpl(jobs, pageable, count)` with `count =
// searchReply.count`, the full FT.SEARCH match count) for property 1 and
// EncoreController.kt:101-111 for the endpoint; plus the 2026-09-26 live capture
// recorded in docs/osc-feedback/incoming-issue769-encore-findbystatus-paging.md
// for the clamp.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  ENCORE_ACTIVE_STATUSES,
  ENCORE_FINDBYSTATUS,
  ENCORE_MAX_PAGE_SIZE,
  ENCORE_PAGING_CONTRACT_SOURCE,
  ENCORE_STATUS_ENUM,
  buildFindByStatusUrl,
  isTruncatedPage,
  readEncoreJobPage
} from '../src/encore-scaler/encore-paging-contract.js';
import {
  ACTIVE_PAGE_SIZE,
  fetchEncoreActiveState
} from '../src/encore-scaler/encore-active-state.js';

const artefactPath = fileURLToPath(
  new URL('../docs/contracts/encore-findbystatus-paging.json', import.meta.url)
);
const artefact = JSON.parse(readFileSync(artefactPath, 'utf8')) as {
  source: { repo: string; ref: string; openApiDocument: { infoTitle: string; path: string } };
  request: {
    method: string;
    path: string;
    queryParameters: string[];
    activeStatuses: string[];
    statusEnum: string[];
    defaultPageSize: number;
    requestedPageSize: number;
    observedMaxPageSize: number;
  };
  response: {
    schema: string;
    documentsAt: string;
    pageMetadataSchema: string;
    pageMetadataFields: string[];
    totalElementsMeaning: string;
    nextLinkRel: string;
  };
  truncation: { rule: string };
  recordedResponses: Array<{
    request: string;
    documentCount?: number;
    page: { size?: number; totalElements?: number };
    linkRels?: string[];
    truncated: boolean;
  }>;
};

// Rebuild a full HAL envelope from a recorded capture so the reader is exercised
// against the shape the service actually produced, not a shape invented here.
function envelopeFor(recorded: (typeof artefact.recordedResponses)[number]) {
  const docs = Array.from({ length: recorded.documentCount ?? 0 }, (_, i) => ({
    externalId: `job-${i}`
  }));
  const links: Record<string, { href: string }> = {};
  for (const rel of recorded.linkRels ?? []) {
    links[rel] = { href: `https://encore.example/page?rel=${rel}` };
  }
  return {
    _embedded: { encoreJobs: docs },
    _links: links,
    page: recorded.page
  };
}

describe('Encore findByStatus contract (#769)', () => {
  describe('recording fidelity — code vs vendored artefact', () => {
    it('pins the same upstream commit and OpenAPI document', () => {
      expect(ENCORE_PAGING_CONTRACT_SOURCE.repo).toBe(artefact.source.repo);
      expect(ENCORE_PAGING_CONTRACT_SOURCE.ref).toBe(artefact.source.ref);
      expect(ENCORE_PAGING_CONTRACT_SOURCE.openApiTitle).toBe(
        artefact.source.openApiDocument.infoTitle
      );
      expect(ENCORE_PAGING_CONTRACT_SOURCE.openApiPath).toBe(
        artefact.source.openApiDocument.path
      );
      expect(ENCORE_PAGING_CONTRACT_SOURCE.snapshot).toBe(
        'docs/contracts/encore-findbystatus-paging.json'
      );
    });

    it('records the same request surface', () => {
      expect(ENCORE_FINDBYSTATUS.method).toBe(artefact.request.method);
      expect(ENCORE_FINDBYSTATUS.path).toBe(artefact.request.path);
      expect([...ENCORE_FINDBYSTATUS.queryParameters]).toEqual(
        artefact.request.queryParameters
      );
      expect(ENCORE_FINDBYSTATUS.defaultPageSize).toBe(artefact.request.defaultPageSize);
      expect([...ENCORE_ACTIVE_STATUSES]).toEqual(artefact.request.activeStatuses);
      expect([...ENCORE_STATUS_ENUM]).toEqual(artefact.request.statusEnum);
    });

    it('records the same response envelope, including PagedModelEntityModelEncoreJob.page.totalElements', () => {
      expect(ENCORE_FINDBYSTATUS.schema).toBe(artefact.response.schema);
      expect(ENCORE_FINDBYSTATUS.schema).toBe('PagedModelEntityModelEncoreJob');
      expect(ENCORE_FINDBYSTATUS.documentsAt).toBe(artefact.response.documentsAt);
      expect(ENCORE_FINDBYSTATUS.pageMetadataSchema).toBe(
        artefact.response.pageMetadataSchema
      );
      // The field the whole truncation guard is derived from must be present in
      // the recorded PageMetadata, and it must be the ALL-PAGES total.
      expect(artefact.response.pageMetadataFields).toContain('totalElements');
      expect([...ENCORE_FINDBYSTATUS.pageMetadataFields]).toEqual(
        artefact.response.pageMetadataFields
      );
      expect(ENCORE_FINDBYSTATUS.totalElementsMeaning).toBe('all-pages');
      expect(ENCORE_FINDBYSTATUS.totalElementsMeaning).toBe(
        artefact.response.totalElementsMeaning
      );
      expect(ENCORE_FINDBYSTATUS.nextLinkRel).toBe(artefact.response.nextLinkRel);
    });

    it('requests exactly the observed maximum page size', () => {
      expect(ENCORE_MAX_PAGE_SIZE).toBe(artefact.request.observedMaxPageSize);
      expect(ENCORE_MAX_PAGE_SIZE).toBe(artefact.request.requestedPageSize);
      // The scaler-facing alias must not drift away from the contract value —
      // it is interpolated into operator logs (#769 review finding 5).
      expect(ACTIVE_PAGE_SIZE).toBe(ENCORE_MAX_PAGE_SIZE);
    });
  });

  describe('truncation semantics', () => {
    it('reads each recorded capture with the truncation verdict the capture recorded', () => {
      // Every recorded response that carries a document count is replayed
      // through the reader, so the recorded semantics and the code's reading of
      // them cannot diverge.
      const replayable = artefact.recordedResponses.filter(
        (r) => typeof r.documentCount === 'number'
      );
      expect(replayable.length).toBeGreaterThanOrEqual(2);
      for (const recorded of replayable) {
        const page = readEncoreJobPage(envelopeFor(recorded));
        expect(page, recorded.request).toBeDefined();
        expect(page!.documentCount, recorded.request).toBe(recorded.documentCount);
        expect(page!.totalElements, recorded.request).toBe(recorded.page.totalElements);
        expect(isTruncatedPage(page!), recorded.request).toBe(recorded.truncated);
      }
    });

    it('has _links.next present exactly when the page is truncated', () => {
      for (const recorded of artefact.recordedResponses) {
        if (!recorded.linkRels) continue;
        const page = readEncoreJobPage(envelopeFor(recorded));
        expect(page, recorded.request).toBeDefined();
        // The two readings are the same statement (PagedResourcesAssembler adds
        // `next` iff page.hasNext(); for page 0 hasNext() is
        // totalElements > documents.length), so they must agree on every capture.
        expect(page!.hasNextLink, recorded.request).toBe(recorded.truncated);
        expect(
          page!.totalElements > page!.documentCount,
          recorded.request
        ).toBe(page!.hasNextLink);
      }
    });

    it('records the size clamp: asking for more than the maximum comes back reduced, not rejected', () => {
      const overflow = artefact.recordedResponses.find((r) =>
        r.request.includes('size=2000')
      );
      expect(overflow).toBeDefined();
      expect(overflow!.page.size).toBe(artefact.request.observedMaxPageSize);
      // Which is precisely why we ask for the clamp and rely on `truncated`
      // instead of asking for a larger page and trusting the answer.
      expect(ENCORE_MAX_PAGE_SIZE).toBe(overflow!.page.size);
    });

    it('treats a body with no page.totalElements as unreadable, never as empty', () => {
      expect(readEncoreJobPage({ _embedded: { encoreJobs: [] } })).toBeUndefined();
      expect(readEncoreJobPage({ page: {} })).toBeUndefined();
      expect(readEncoreJobPage(undefined)).toBeUndefined();
      expect(readEncoreJobPage({ page: { totalElements: 'lots' } })).toBeUndefined();
    });

    it('skips documents that carry no externalId (EncoreJob.externalId is nullable)', () => {
      const page = readEncoreJobPage({
        _embedded: { encoreJobs: [{ externalId: 'job-a' }, {}, { externalId: '' }] },
        page: { totalElements: 3 }
      });
      expect(page!.externalIds).toEqual(['job-a']);
      // documentCount counts the real page length, so the truncation comparison
      // is not skewed by documents we could not name.
      expect(page!.documentCount).toBe(3);
      expect(isTruncatedPage(page!)).toBe(false);
    });
  });

  describe('the URL the scaler actually puts on the wire', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('builds the recorded path with status, page and the clamp size', () => {
      const url = buildFindByStatusUrl('https://enc.example/', 'QUEUED', {
        page: 0,
        size: ENCORE_MAX_PAGE_SIZE
      });
      expect(url).toBe(
        `https://enc.example${artefact.request.path}?status=QUEUED&page=0&size=${ENCORE_MAX_PAGE_SIZE}`
      );
    });

    it('fetchEncoreActiveState queries exactly the two active statuses at page 0', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          _embedded: { encoreJobs: [{ externalId: 'job-a' }] },
          _links: {},
          page: { size: ENCORE_MAX_PAGE_SIZE, totalElements: 1, totalPages: 1, number: 0 }
        })
      }));
      vi.stubGlobal('fetch', fetchMock);

      const state = await fetchEncoreActiveState('https://enc.example', 'tok');
      expect(state).toEqual({
        count: 2, // one per status page
        activeExternalIds: new Set(['job-a']),
        truncated: false
      });

      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls).toEqual(
        artefact.request.activeStatuses.map(
          (status) =>
            `https://enc.example${artefact.request.path}?status=${status}&page=0&size=${ENCORE_MAX_PAGE_SIZE}`
        )
      );
      // The bearer token goes on every call (OSC service access token).
      for (const call of fetchMock.mock.calls) {
        expect((call[1] as { headers: Record<string, string> }).headers.authorization).toBe(
          'Bearer tok'
        );
      }
    });

    it('returns undefined rather than an empty active set when a status query is not ok', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }))
      );
      expect(await fetchEncoreActiveState('https://enc.example', 'tok')).toBeUndefined();
    });
  });
});
