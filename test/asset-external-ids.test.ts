// @vitest-environment happy-dom
//
// External identifiers on the asset detail view (issue #943, broken out of
// #796): the `{ namespace, id }` correlations an integration wrote onto an asset
// are VISIBLE with their namespace, both components are editable in place, and
// an edit is persisted through the existing contract — with no path through the
// UI that can destroy a correlation by accident.
//
// The integration blocks drive the REAL detail renderer (renderAssetDetailBody —
// the same code path used by the asset side panel and the detached detail
// window) against a stubbed fetch.
//
// CONTRACT GROUNDING — every path, field, method and status below was read from
// this repo's generated spec, route source and repository implementation before
// the tests were written (CLAUDE.md rule 7), never from the issue text. The
// issue says "namespace and value"; the wire field is `id`, and these tests
// assert `id`.
//
//   openapi.json .paths["/api/v1/assets/{id}/external-ids"] — exactly two
//   operations, `get` and `post` (no put, no patch).
//     .get.responses: exactly `200` and `404`. The 200 schema is a top-level
//       ARRAY of { namespace: string, id: string },
//       required ["namespace","id"], additionalProperties: false, described as
//       "External identifiers attached to the asset, in persisted order. Empty
//       when none are attached."
//       Source: src/routes/assets.ts:3555-3602; the handler sends
//       `asset.externalIdentifiers ?? []` (:3602).
//     .post.requestBody: application/json, schema
//       { namespace: string (1..256), id: string (1..1024) },
//       required ["namespace","id"], additionalProperties: false
//       (`attachExternalIdBodySchema`, src/routes/assets.ts:500-523).
//     .post.responses: exactly `200` (the FULL asset), `400`, `404`, `409`.
//       The 409 body is { error: "external_id_conflict", message?,
//       reason: "external_id_conflict", namespace, externalId,
//       conflictingAssetId } (`externalIdConflictSchema`, :529-536), returned
//       only when EXTERNAL_ID_UNIQUENESS=enforced (:3444).
//
//   openapi.json
//   .paths["/api/v1/assets/{id}/external-ids/{namespace}/{externalId}"] —
//   exactly one operation, `delete`. Responses: `204` (null), `400`, `404`.
//     Idempotent by contract: 204 whether or not the pair was carried; 404 only
//     when the ASSET is unknown (src/routes/assets.ts:3472-3480, :3519-3531).
//     The second segment is `externalId`, not a second `id`, because
//     find-my-way collapses duplicate param names (:3464-3470).
//
//   NO UPDATE OPERATION EXISTS. `attachExternalId` APPENDS — it returns the
//   asset untouched when the exact pair is present and otherwise pushes onto
//   `[...(existing.externalIdentifiers ?? []), { namespace, id }]`
//   (src/data/asset-repo.ts:1524-1557; CouchDB mirror
//   src/data/couch-asset-repo.ts:228-252). It does NOT replace an entry sharing
//   a namespace, and `PATCH /assets/{id}` cannot reach the set at all
//   (src/data/asset-repo.ts:920-921). So an edit is POST-then-DELETE, and these
//   tests assert that order and that both calls carry the exact contract shapes.
//
//   The asset read model carries nothing to list from: `assetSchema` declares no
//   `externalIdentifiers` property, so the serializer strips it from every asset
//   body (src/routes/assets.ts:3536-3539). The sub-resource read is therefore
//   mandatory, and one test asserts the UI actually issues it.
//
//   Authorisation — `MATRIX` (src/auth/authorize.ts:54-58): viewer holds `read`
//   but neither `write` nor `delete`; `methodToAction` (:79-93) maps GET->read,
//   POST->write, DELETE->delete, applied by
//   `resourceAuthorizationPreHandler('asset')` (:126, registered
//   src/routes/assets.ts:1773).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetDetailBody } from '../public/app.js';
import {
  EXTERNAL_IDS_COPY,
  EXTERNAL_ID_LIMITS,
  classifyAttachError,
  conflictMessage,
  editResultMessage,
  externalIdKey,
  normaliseExternalIds,
  partialEditMessage,
  planExternalIdEdit,
  renderExternalIdsBlock,
} from '../public/external-ids.js';

const ULID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';

const ASSET = {
  id: ULID,
  name: 'promo-cut.mov',
  slug: 'promo-cut',
  status: 'ready',
  statusHistory: [{ at: '2026-09-20T10:00:00.000Z', from: null, to: 'ready' }],
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
};

type Pair = { namespace: string; id: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** 204 with no body, exactly as the DELETE operation declares. */
const noContent = () => new Response(null, { status: 204 });

/**
 * A stub that behaves like the real sub-resource: the GET reads back whatever
 * the POST/DELETE left behind, with the APPEND semantics the repository
 * actually implements (never a replace). So a test that asserts the rendered
 * rows is asserting against the contract's own behaviour, not a convenient
 * fiction.
 */
function externalIdStore(initial: Pair[]) {
  let items: Pair[] = initial.map((p) => ({ ...p }));
  return {
    list: () => items.map((p) => ({ ...p })),
    attach(p: Pair) {
      if (!items.some((e) => e.namespace === p.namespace && e.id === p.id)) items.push({ ...p });
    },
    detach(p: Pair) {
      items = items.filter((e) => !(e.namespace === p.namespace && e.id === p.id));
    },
  };
}

type Overrides = {
  /** Serve a non-200 on the sub-resource GET. */
  getStatus?: number;
  getBody?: unknown;
  /** Serve a failure on the attach; the store is left untouched. */
  post?: (body: Pair) => { status: number; body: unknown } | null;
  /** Serve a failure on the detach; the store is left untouched. */
  deleteStatus?: number;
};

function routedFetch(store: ReturnType<typeof externalIdStore>, overrides: Overrides = {}) {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const path = String(url);
    const method = (opts && opts.method) || 'GET';

    // DELETE /assets/{id}/external-ids/{namespace}/{externalId}
    const detachMatch = /\/external-ids\/([^/]+)\/([^/]+)$/.exec(path);
    if (detachMatch && method === 'DELETE') {
      if (overrides.deleteStatus && overrides.deleteStatus !== 204) {
        return json({ error: 'not_found' }, overrides.deleteStatus);
      }
      store.detach({
        namespace: decodeURIComponent(detachMatch[1]),
        id: decodeURIComponent(detachMatch[2]),
      });
      return noContent();
    }

    if (/\/external-ids$/.test(path)) {
      if (method === 'POST') {
        const body = JSON.parse(String(opts?.body || '{}')) as Pair;
        const out = overrides.post ? overrides.post(body) : null;
        if (out) return json(out.body, out.status);
        store.attach(body);
        return json(ASSET);
      }
      if (overrides.getStatus && overrides.getStatus !== 200) {
        return json(overrides.getBody ?? { error: 'not_found' }, overrides.getStatus);
      }
      if (overrides.getBody !== undefined) return json(overrides.getBody);
      return json(store.list());
    }

    if (/\/review-state$/.test(path)) {
      return json({ reviewState: 'draft', allowedTransitions: ['in-review'] });
    }
    if (/\/lock$/.test(path)) return json(ASSET);
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(ASSET);
    return json({}, 200);
  });
}

async function settle(ticks = 40) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function rows(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll('.external-id-row'));
}

/** The namespace/identifier pairs as they are RENDERED (not as stored). */
function renderedPairs(root: ParentNode): [string, string][] {
  return rows(root).map((tr) => [
    (tr.querySelector('.external-id-namespace')?.textContent || '').trim(),
    (tr.querySelector('.external-id-value')?.textContent || '').trim(),
  ]);
}

function blockText(root: ParentNode): string {
  const block = root.querySelector('#external-ids');
  return ((block && block.textContent) || '').replace(/\s+/g, ' ').trim();
}

/**
 * `METHOD /api/v1/…` for every call, with the origin stripped. apiFetch builds
 * absolute URLs from `window.location.origin + '/api/v1'` (public/app.js), which
 * is noise here — the path and its encoding are what the contract fixes.
 */
function calls(spy: ReturnType<typeof routedFetch>): string[] {
  return spy.mock.calls.map(
    (c) =>
      ((c[1] as RequestInit | undefined)?.method || 'GET') +
      ' ' +
      String(c[0]).replace(window.location.origin, '')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('external-id read normalisation (GET 200 shape)', () => {
  it('accepts the declared array verbatim, preserving the persisted order', () => {
    // The route documents the list as returned "in persisted order … no dedup,
    // sort, or reformatting" (src/routes/assets.ts:3543-3545). Re-ordering here
    // would hide what the integration wrote.
    const r = normaliseExternalIds([
      { namespace: 'rights-registry', id: 'RR-9' },
      { namespace: 'ingest-mam', id: 'X-1' },
    ]);
    expect(r.usable).toBe(true);
    expect(r.items).toEqual([
      { namespace: 'rights-registry', id: 'RR-9' },
      { namespace: 'ingest-mam', id: 'X-1' },
    ]);
  });

  it('treats an EMPTY array as usable — the contract gives it a meaning', () => {
    // "Empty when none are attached"; an absent persisted field also arrives as
    // [] (src/data/asset-document.ts:712-715). Empty is not missing.
    expect(normaliseExternalIds([])).toEqual({ items: [], usable: true });
  });

  it('is unusable only when the payload is not an array at all', () => {
    expect(normaliseExternalIds(null).usable).toBe(false);
    expect(normaliseExternalIds(undefined).usable).toBe(false);
    expect(normaliseExternalIds({ items: [] }).usable).toBe(false);
  });

  it('drops entries missing either required component', () => {
    // Both are `required`; a half-read pair has no editable identity, since the
    // DELETE path addresses the pair by both segments.
    const r = normaliseExternalIds([
      { namespace: 'ingest-mam' },
      { id: 'X-1' },
      { namespace: '', id: 'X-2' },
      { namespace: 'ns', id: '' },
      null,
      'nope',
      { namespace: 'ok', id: 'OK-1' },
    ]);
    expect(r.items).toEqual([{ namespace: 'ok', id: 'OK-1' }]);
  });

  it('keeps an upstream id shaped like a URN intact', () => {
    // The path is two segments precisely so a colon-bearing id is unambiguous
    // (src/routes/assets.ts:3461-3463).
    const r = normaliseExternalIds([{ namespace: 'rights-registry', id: 'urn:x:1234' }]);
    expect(r.items[0].id).toBe('urn:x:1234');
  });
});

describe('edit planning (what may be sent, and what may not)', () => {
  const before = { namespace: 'ingest-mam', id: 'X-1' };

  it('plans an attach of the new pair and a detach of the old one', () => {
    // The API has no update: the correction is POST { namespace, id } followed
    // by DELETE of the pair being replaced.
    const plan = planExternalIdEdit(before, { namespace: 'ingest-mam', id: 'X-2' }, [before]);
    expect(plan.kind).toBe('apply');
    expect(plan.attach).toEqual({ namespace: 'ingest-mam', id: 'X-2' });
    expect(plan.detach).toEqual({ namespace: 'ingest-mam', id: 'X-1' });
  });

  it('plans the same way when the NAMESPACE is what changed', () => {
    // Attaching into a different namespace does not replace the old entry
    // (attachExternalId appends, src/data/asset-repo.ts:1546-1552), so the old
    // pair still has to be detached explicitly.
    const plan = planExternalIdEdit(before, { namespace: 'rights-registry', id: 'X-1' }, [before]);
    expect(plan.kind).toBe('apply');
    expect(plan.attach).toEqual({ namespace: 'rights-registry', id: 'X-1' });
    expect(plan.detach).toEqual({ namespace: 'ingest-mam', id: 'X-1' });
  });

  it('refuses an unchanged pair — applying it would DELETE the identifier', () => {
    // This is the dangerous one. POST of an already-attached pair is an
    // idempotent no-op (src/data/asset-repo.ts:1531-1537); the DELETE that
    // follows would then remove the very pair that was "saved".
    const plan = planExternalIdEdit(before, { namespace: 'ingest-mam', id: 'X-1' }, [before]);
    expect(plan.kind).toBe('unchanged');
    expect(plan.attach).toBeUndefined();
    expect(plan.detach).toBeUndefined();
  });

  it('refuses an edit onto a pair this asset already carries', () => {
    // Same failure mode by another route: the attach is a no-op and the detach
    // still fires, silently collapsing two rows into one.
    const other = { namespace: 'rights-registry', id: 'RR-9' };
    const plan = planExternalIdEdit(before, { ...other }, [before, other]);
    expect(plan.kind).toBe('duplicate');
    expect(plan.message).toBe(EXTERNAL_IDS_COPY.errDuplicate);
  });

  it('mirrors the POST body bounds before spending a round-trip', () => {
    // minLength 1 / maxLength 256 and 1024 (src/routes/assets.ts:500-523).
    expect(planExternalIdEdit(before, { namespace: '', id: 'X-2' }, [before]).kind).toBe('invalid');
    expect(planExternalIdEdit(before, { namespace: 'ns', id: '' }, [before]).kind).toBe('invalid');
    expect(
      planExternalIdEdit(
        before,
        { namespace: 'n'.repeat(EXTERNAL_ID_LIMITS.namespaceMax + 1), id: 'X-2' },
        [before]
      ).kind
    ).toBe('invalid');
    expect(
      planExternalIdEdit(
        before,
        { namespace: 'ns', id: 'x'.repeat(EXTERNAL_ID_LIMITS.idMax + 1) },
        [before]
      ).kind
    ).toBe('invalid');
    // Exactly at the bound is accepted — the schema is inclusive.
    expect(
      planExternalIdEdit(
        before,
        { namespace: 'n'.repeat(EXTERNAL_ID_LIMITS.namespaceMax), id: 'X-2' },
        [before]
      ).kind
    ).toBe('apply');
  });

  it('does not rewrite what was typed', () => {
    // Both components are opaque upstream keys with no pattern and no
    // normalisation in the contract. Trimming could produce a correlation that
    // does not match the upstream system of record.
    const plan = planExternalIdEdit(before, { namespace: ' ingest-mam ', id: ' X-2 ' }, [before]);
    expect(plan.kind).toBe('apply');
    expect(plan.attach).toEqual({ namespace: ' ingest-mam ', id: ' X-2 ' });
  });

  it('keys a pair on both components together', () => {
    expect(externalIdKey({ namespace: 'a', id: 'b' })).toBe(
      externalIdKey({ namespace: 'a', id: 'b' })
    );
    expect(externalIdKey({ namespace: 'a', id: 'b' })).not.toBe(
      externalIdKey({ namespace: 'b', id: 'a' })
    );
  });
});

describe('attach failure classification', () => {
  it('names the conflicting asset from the declared 409 fields', () => {
    const c = classifyAttachError({
      status: 409,
      body: {
        error: 'external_id_conflict',
        reason: 'external_id_conflict',
        namespace: 'ingest-mam',
        externalId: 'X-2',
        conflictingAssetId: '01JOTHERASSET0000000000000',
      },
    });
    expect(c.kind).toBe('conflict');
    expect(c.message).toBe(
      conflictMessage('ingest-mam', 'X-2', '01JOTHERASSET0000000000000')
    );
    expect(c.message).toContain('01JOTHERASSET0000000000000');
  });

  it('maps the declared and undeclared failures to distinct outcomes', () => {
    expect(classifyAttachError({ status: 400 }).kind).toBe('rejected');
    expect(classifyAttachError({ status: 404 }).kind).toBe('not-found');
    // 401/403 come from the ADR-018 gate and are not declared on the operation.
    expect(classifyAttachError({ status: 403 }).kind).toBe('forbidden');
    expect(classifyAttachError({ status: 401 }).kind).toBe('forbidden');
    expect(classifyAttachError({}).kind).toBe('other');
    expect(classifyAttachError({ status: 500 }).message).toBe(EXTERNAL_IDS_COPY.errNetwork);
  });

  it('says outright when an edit left both pairs attached', () => {
    const msg = partialEditMessage(
      { namespace: 'ingest-mam', id: 'X-1' },
      { namespace: 'ingest-mam', id: 'X-2' }
    );
    expect(msg).toContain('X-2');
    expect(msg).toContain('X-1');
    expect(msg).toContain('both');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block rendering
// ─────────────────────────────────────────────────────────────────────────────

describe('external identifiers block', () => {
  it('names every column, including the actions column, for assistive tech', () => {
    const { block } = renderExternalIdsBlock(
      { items: [{ namespace: 'ingest-mam', id: 'X-1' }], usable: true },
      { canEdit: true }
    );
    const headers = Array.from(block.querySelectorAll('th'));
    expect(headers.map((h) => h.getAttribute('scope'))).toEqual(['col', 'col', 'col']);
    expect(headers[0].textContent).toBe(EXTERNAL_IDS_COPY.colNamespace);
    expect(headers[1].textContent).toBe(EXTERNAL_IDS_COPY.colIdentifier);
    // Visually hidden, but announced — not an unnamed column.
    expect(headers[2].querySelector('.visually-hidden')?.textContent).toBe(
      EXTERNAL_IDS_COPY.colActions
    );
    expect(block.querySelector('caption')?.textContent).toBe(EXTERNAL_IDS_COPY.tableCaption);
    expect(block.querySelector('caption')?.classList.contains('visually-hidden')).toBe(true);
  });

  it('gives each Edit button an accessible name identifying its row', () => {
    const { block } = renderExternalIdsBlock(
      {
        items: [
          { namespace: 'ingest-mam', id: 'X-1' },
          { namespace: 'rights-registry', id: 'RR-9' },
        ],
        usable: true,
      },
      { canEdit: true }
    );
    const labels = Array.from(block.querySelectorAll('.external-id-edit')).map((b) =>
      b.getAttribute('aria-label')
    );
    expect(labels).toEqual([
      'Edit external identifier ingest-mam / X-1',
      'Edit external identifier rights-registry / RR-9',
    ]);
    // WCAG 2.5.3: the visible label is the start of the accessible name.
    Array.from(block.querySelectorAll('.external-id-edit')).forEach((b) => {
      expect(b.textContent).toBe(EXTERNAL_IDS_COPY.btnEdit);
      expect(b.getAttribute('aria-label')!.startsWith(EXTERNAL_IDS_COPY.btnEdit)).toBe(true);
    });
  });

  it('distinguishes "none attached" from "could not be read"', () => {
    const empty = renderExternalIdsBlock({ items: [], usable: true }, {});
    expect(empty.block.querySelector('[data-empty="external-ids"]')).not.toBeNull();
    expect(empty.block.textContent).toContain(EXTERNAL_IDS_COPY.empty);

    const broken = renderExternalIdsBlock({ items: [], usable: false }, {});
    expect(broken.block.querySelector('[data-empty="external-ids-unavailable"]')).not.toBeNull();
    expect(broken.block.textContent).toContain(EXTERNAL_IDS_COPY.unavailable);
  });

  it('announces outcomes without moving focus', () => {
    const { msgHost } = renderExternalIdsBlock({ items: [], usable: true }, {});
    expect(msgHost.getAttribute('aria-live')).toBe('polite');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail view integration
// ─────────────────────────────────────────────────────────────────────────────

describe('asset detail — external identifiers (issue #943)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists each external id with its namespace, read from the sub-resource', async () => {
    const store = externalIdStore([
      { namespace: 'ingest-mam', id: 'X-1' },
      { namespace: 'rights-registry', id: 'urn:rights:9' },
    ]);
    const fetchSpy = routedFetch(store);
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    // The asset body carries no `externalIdentifiers` (the serializer strips
    // it), so the dedicated read is the only possible source — and it is issued.
    expect(calls(fetchSpy)).toContain('GET /api/v1/assets/' + ULID + '/external-ids');

    expect(blockText(container)).toContain(EXTERNAL_IDS_COPY.heading);
    expect(renderedPairs(container)).toEqual([
      ['ingest-mam', 'X-1'],
      ['rights-registry', 'urn:rights:9'],
    ]);
  });

  it('says so plainly when the asset carries none', async () => {
    vi.stubGlobal('fetch', routedFetch(externalIdStore([])));

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(rows(container)).toHaveLength(0);
    expect(container.querySelector('[data-empty="external-ids"]')).not.toBeNull();
    expect(blockText(container)).toContain(EXTERNAL_IDS_COPY.empty);
  });

  it('makes both the namespace and the identifier editable in place', async () => {
    vi.stubGlobal('fetch', routedFetch(externalIdStore([{ namespace: 'ingest-mam', id: 'X-1' }])));

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLButtonElement>('.external-id-edit')!.click();
    await settle(2);

    const ns = container.querySelector<HTMLInputElement>('.external-id-namespace-input')!;
    const value = container.querySelector<HTMLInputElement>('.external-id-value-input')!;
    // Both components are editable, both prefilled with what the API returned.
    expect(ns.value).toBe('ingest-mam');
    expect(value.value).toBe('X-1');
    // Bounded by the POST body schema.
    expect(ns.maxLength).toBe(EXTERNAL_ID_LIMITS.namespaceMax);
    expect(value.maxLength).toBe(EXTERNAL_ID_LIMITS.idMax);
    // Each field is named independently of its column header.
    expect(ns.getAttribute('aria-label')).toBe('Namespace for external identifier ingest-mam / X-1');
    expect(value.getAttribute('aria-label')).toBe(
      'Identifier for external identifier ingest-mam / X-1'
    );
  });

  it('persists an edit as attach-then-detach and re-reads the result', async () => {
    const store = externalIdStore([{ namespace: 'ingest-mam', id: 'X-1' }]);
    const fetchSpy = routedFetch(store);
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLButtonElement>('.external-id-edit')!.click();
    await settle(2);
    container.querySelector<HTMLInputElement>('.external-id-namespace-input')!.value =
      'rights-registry';
    container.querySelector<HTMLInputElement>('.external-id-value-input')!.value = 'RR-42';
    container.querySelector<HTMLButtonElement>('.external-id-save')!.click();
    await settle();

    const post = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST'
    )!;
    expect(String(post[0]).replace(window.location.origin, '')).toBe(
      '/api/v1/assets/' + ULID + '/external-ids'
    );
    // Exactly the two declared properties (additionalProperties: false) — and
    // the key is `id`, not `value`.
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      namespace: 'rights-registry',
      id: 'RR-42',
    });

    // The pair being replaced is detached at the two-segment path.
    const order = calls(fetchSpy);
    const postIdx = order.findIndex((o) => o.startsWith('POST'));
    const delIdx = order.findIndex((o) => o.startsWith('DELETE'));
    expect(delIdx).toBeGreaterThan(postIdx);
    expect(order[delIdx]).toBe(
      'DELETE /api/v1/assets/' + ULID + '/external-ids/ingest-mam/X-1'
    );
    // Neither write returns the identifier set, so the block re-reads.
    expect(order.slice(delIdx + 1).some((o) => o === 'GET /api/v1/assets/' + ULID + '/external-ids'))
      .toBe(true);

    // The server's answer — not a local patch — is what is now on screen.
    expect(store.list()).toEqual([{ namespace: 'rights-registry', id: 'RR-42' }]);
    expect(renderedPairs(container)).toEqual([['rights-registry', 'RR-42']]);
    expect(blockText(container)).toContain(
      editResultMessage({ namespace: 'rights-registry', id: 'RR-42' })
    );
  });

  it('percent-encodes both segments of the detach path', async () => {
    // A namespace or an upstream id may contain `/` or `:`; an unencoded one
    // would address a different resource.
    const store = externalIdStore([{ namespace: 'ns/one', id: 'urn:x:1/2' }]);
    const fetchSpy = routedFetch(store);
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLButtonElement>('.external-id-edit')!.click();
    await settle(2);
    container.querySelector<HTMLInputElement>('.external-id-value-input')!.value = 'urn:x:3';
    container.querySelector<HTMLButtonElement>('.external-id-save')!.click();
    await settle();

    const del = calls(fetchSpy).find((o) => o.startsWith('DELETE'))!;
    expect(del).toBe(
      'DELETE /api/v1/assets/' + ULID + '/external-ids/ns%2Fone/urn%3Ax%3A1%2F2'
    );
    expect(store.list()).toEqual([{ namespace: 'ns/one', id: 'urn:x:3' }]);
  });

  it('sends NOTHING when an edit changes nothing', async () => {
    // The destructive no-op: POST of the same pair is idempotent and the DELETE
    // that followed would remove the identifier the operator just "saved".
    const store = externalIdStore([{ namespace: 'ingest-mam', id: 'X-1' }]);
    const fetchSpy = routedFetch(store);
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLButtonElement>('.external-id-edit')!.click();
    await settle(2);
    container.querySelector<HTMLButtonElement>('.external-id-save')!.click();
    await settle();

    expect(calls(fetchSpy).some((o) => o.startsWith('POST'))).toBe(false);
    expect(calls(fetchSpy).some((o) => o.startsWith('DELETE'))).toBe(false);
    expect(store.list()).toEqual([{ namespace: 'ingest-mam', id: 'X-1' }]);
    expect(renderedPairs(container)).toEqual([['ingest-mam', 'X-1']]);
  });

  it('keeps the original intact when the attach is refused with a 409', async () => {
    // Enforced-uniqueness mode. Attach-first ordering means a refusal costs
    // nothing: the old correlation is still there.
    const store = externalIdStore([{ namespace: 'ingest-mam', id: 'X-1' }]);
    const fetchSpy = routedFetch(store, {
      post: () => ({
        status: 409,
        body: {
          error: 'external_id_conflict',
          reason: 'external_id_conflict',
          namespace: 'ingest-mam',
          externalId: 'X-2',
          conflictingAssetId: '01JOTHERASSET0000000000000',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLButtonElement>('.external-id-edit')!.click();
    await settle(2);
    container.querySelector<HTMLInputElement>('.external-id-value-input')!.value = 'X-2';
    container.querySelector<HTMLButtonElement>('.external-id-save')!.click();
    await settle();

    // No detach was attempted, so nothing was lost.
    expect(calls(fetchSpy).some((o) => o.startsWith('DELETE'))).toBe(false);
    expect(store.list()).toEqual([{ namespace: 'ingest-mam', id: 'X-1' }]);

    // The refusal is shown next to the fields, and names the conflicting asset.
    const err = container.querySelector('.external-id-row-error')!;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toContain('01JOTHERASSET0000000000000');
    // The editor stays open with what was typed, so nothing is retyped.
    expect(container.querySelector<HTMLInputElement>('.external-id-value-input')!.value).toBe('X-2');
  });

  it('reports the both-attached state when the detach half fails', async () => {
    const store = externalIdStore([{ namespace: 'ingest-mam', id: 'X-1' }]);
    const fetchSpy = routedFetch(store, { deleteStatus: 500 });
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLButtonElement>('.external-id-edit')!.click();
    await settle(2);
    container.querySelector<HTMLInputElement>('.external-id-value-input')!.value = 'X-2';
    container.querySelector<HTMLButtonElement>('.external-id-save')!.click();
    await settle();

    // Both are really attached, and both are shown — the UI does not claim a
    // clean edit it did not achieve.
    expect(store.list()).toEqual([
      { namespace: 'ingest-mam', id: 'X-1' },
      { namespace: 'ingest-mam', id: 'X-2' },
    ]);
    expect(renderedPairs(container)).toEqual([
      ['ingest-mam', 'X-1'],
      ['ingest-mam', 'X-2'],
    ]);
    expect(blockText(container)).toContain('could not be removed');
  });

  it('refuses an edit onto a pair the asset already carries, without calling the API', async () => {
    const store = externalIdStore([
      { namespace: 'ingest-mam', id: 'X-1' },
      { namespace: 'ingest-mam', id: 'X-2' },
    ]);
    const fetchSpy = routedFetch(store);
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLButtonElement>('.external-id-edit')!.click();
    await settle(2);
    container.querySelector<HTMLInputElement>('.external-id-value-input')!.value = 'X-2';
    container.querySelector<HTMLButtonElement>('.external-id-save')!.click();
    await settle();

    expect(calls(fetchSpy).some((o) => o.startsWith('POST'))).toBe(false);
    expect(calls(fetchSpy).some((o) => o.startsWith('DELETE'))).toBe(false);
    expect(container.querySelector('.external-id-row-error')!.textContent).toBe(
      EXTERNAL_IDS_COPY.errDuplicate
    );
    expect(store.list()).toHaveLength(2);
  });

  it('rejects an emptied field against the POST bounds before sending', async () => {
    const store = externalIdStore([{ namespace: 'ingest-mam', id: 'X-1' }]);
    const fetchSpy = routedFetch(store);
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLButtonElement>('.external-id-edit')!.click();
    await settle(2);
    container.querySelector<HTMLInputElement>('.external-id-namespace-input')!.value = '';
    container.querySelector<HTMLButtonElement>('.external-id-save')!.click();
    await settle();

    expect(calls(fetchSpy).some((o) => o.startsWith('POST'))).toBe(false);
    expect(container.querySelector('.external-id-row-error')!.textContent).toBe(
      EXTERNAL_IDS_COPY.errNamespaceEmpty
    );
  });

  it('restores the server values on cancel', async () => {
    vi.stubGlobal('fetch', routedFetch(externalIdStore([{ namespace: 'ingest-mam', id: 'X-1' }])));

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLButtonElement>('.external-id-edit')!.click();
    await settle(2);
    container.querySelector<HTMLInputElement>('.external-id-value-input')!.value = 'typed-but-not-saved';
    container.querySelector<HTMLButtonElement>('.external-id-cancel')!.click();
    await settle(2);

    expect(container.querySelector('.external-id-value-input')).toBeNull();
    expect(renderedPairs(container)).toEqual([['ingest-mam', 'X-1']]);
  });

  it('leaves keyboard focus on the row it was working on', async () => {
    // Closing an editor destroys the control that had focus. Without this the
    // keyboard user is dropped back to the top of the document.
    const store = externalIdStore([
      { namespace: 'ingest-mam', id: 'X-1' },
      { namespace: 'rights-registry', id: 'RR-9' },
    ]);
    vi.stubGlobal('fetch', routedFetch(store));

    await renderAssetDetailBody(ULID, container);
    await settle();

    const secondEdit = container.querySelectorAll<HTMLButtonElement>('.external-id-edit')[1];
    secondEdit.click();
    await settle(2);
    // Opening an editor puts focus in the first field.
    expect(document.activeElement).toBe(
      container.querySelector('.external-id-namespace-input')
    );

    container.querySelector<HTMLInputElement>('.external-id-value-input')!.value = 'RR-10';
    container.querySelector<HTMLButtonElement>('.external-id-save')!.click();
    await settle();

    // The corrected row's Edit button holds focus — identified by the NEW pair.
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Edit external identifier rights-registry / RR-10'
    );
  });

  it('shows the identifiers to a viewer but offers no editor', async () => {
    // MATRIX (src/auth/authorize.ts:54-58): viewer holds `read`, neither
    // `write` nor `delete`. Both halves of an edit would be a 403.
    localStorage.setItem('ovc_role', 'viewer');
    vi.stubGlobal('fetch', routedFetch(externalIdStore([{ namespace: 'ingest-mam', id: 'X-1' }])));

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(renderedPairs(container)).toEqual([['ingest-mam', 'X-1']]);
    expect(container.querySelectorAll('.external-id-edit')).toHaveLength(0);
    expect(blockText(container)).toContain(EXTERNAL_IDS_COPY.readOnly);
  });

  it('renders an identifier containing markup as text', async () => {
    const hostile = '<img src=x onerror="window.__xss=1">';
    vi.stubGlobal('fetch', routedFetch(externalIdStore([{ namespace: hostile, id: hostile }])));

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(container.querySelector('#external-ids')!.querySelector('img')).toBeNull();
    expect(renderedPairs(container)).toEqual([[hostile, hostile]]);
  });

  it('degrades to an explicit unavailable state when the read fails', async () => {
    vi.stubGlobal('fetch', routedFetch(externalIdStore([]), { getStatus: 404 }));

    await renderAssetDetailBody(ULID, container);
    await settle();

    // The detail pane still renders; only this block reports the failure.
    expect(container.querySelector('.kv-grid')).not.toBeNull();
    expect(container.querySelector('[data-empty="external-ids-unavailable"]')).not.toBeNull();
  });
});
