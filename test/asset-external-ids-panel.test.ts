// @vitest-environment happy-dom
//
// External identifiers on the asset detail view (issue #908, broken out of #796):
// every `{ namespace, id }` correlation listed with BOTH components visible, plus
// add / edit / remove — each offered only because a verified method can perform
// it.
//
// The integration block drives the REAL detail renderer (renderAssetDetailBody —
// the same code path the asset side panel and the detached detail window use)
// against a stubbed fetch, so what is asserted is the request the panel actually
// puts on the wire.
//
// CONTRACT GROUNDING — every path, method, field, bound and status below was read
// from this repo's generated spec and route source before the tests were written
// (CLAUDE.md rule 7), never from the issue text. `openapi.json` declares no
// `operationId` anywhere, so operations are named by path + method, as the spec
// itself identifies them.
//
//   THE METHODS THAT EXIST. `openapi.json .paths` carries exactly three
//   operations for this sub-resource, checked key by key:
//     "/api/v1/assets/{id}/external-ids"                        -> get, post
//     "/api/v1/assets/{id}/external-ids/{namespace}/{externalId}" -> delete
//   There is NO put and NO patch on either path. Asserted below as a property of
//   the panel: no edit control sends anything but POST-then-DELETE.
//
//   GET /api/v1/assets/{id}/external-ids  (src/routes/assets.ts:3315-3362)
//     200: a bare ARRAY (not an envelope) of { namespace: string, id: string },
//          required ["namespace","id"], additionalProperties: false.
//          Description, verbatim: "External identifiers attached to the asset, in
//          persisted order. Empty when none are attached."
//          Handler: `asset.externalIdentifiers ?? []` (:3360) — so an asset with
//          none is 200 [], an EMPTY SET and not a miss.
//     404: errorSchema { error, message? } (:533) — the ASSET is unknown.
//     Returned AS STORED: "no dedup, sort, or reformatting" (:3301-3303).
//
//   POST /api/v1/assets/{id}/external-ids  (src/routes/assets.ts:3173-3209)
//     body REQUIRED: { namespace: string (1..256), id: string (1..1024) },
//          required ["namespace","id"], additionalProperties: false
//          (attachExternalIdBodySchema, :501-518). The four bounds asserted below
//          are those numbers.
//     200: the FULL asset (assetSchema). NOT a read-back: `assetSchema` declares
//          no `externalIdentifiers` property (openapi.json
//          .paths["/api/v1/assets/{id}"].get 200 schema, additionalProperties:
//          false), which is why the sub-resource exists at all (:3293-3299).
//     400: errorSchema (empty/oversized component, rejected before the handler).
//     404: errorSchema (unknown asset id).
//     409: externalIdConflictSchema (:524-531) = { error:
//          "external_id_conflict", message?, reason: "external_id_conflict",
//          namespace, externalId, conflictingAssetId }, sent by the router error
//          handler at :2696-2704 from ExternalIdConflictError
//          (src/data/asset-repo.ts:805-820). Enforced mode only
//          (EXTERNAL_ID_UNIQUENESS, read per request at :3198-3202) and NOTHING in
//          the API advertises the mode — so it is handled reactively, never
//          pre-validated.
//     APPENDS, never replaces within a namespace:
//          `[...(existing.externalIdentifiers ?? []), {…}]`
//          (src/data/asset-repo.ts:1546-1551). This is why an edit cannot be one
//          request.
//
//   DELETE /api/v1/assets/{id}/external-ids/{namespace}/{externalId}
//          (src/routes/assets.ts:3247-3294)
//     params: id, namespace (minLength 1), externalId (minLength 1). No body.
//     204 idempotently whether or not the pair was attached (:3240-3243); 404 only
//          when the ASSET is unknown. Two path segments so an id containing a
//          colon stays unambiguous (:3225-3228); the second is `externalId` because
//          find-my-way collapses duplicate param names (:3220-3224).
//
//   ROLE GATE — MATRIX (src/auth/authorize.ts:54-58) grants `read` to every role
//     but `write`/`delete` to editor|admin only; methodToAction (:79-93) maps
//     GET->read, POST->write, DELETE->delete; resourceAuthorizationPreHandler
//     ('asset') runs on every asset route (registered src/routes/assets.ts:1748).
//     So a viewer lists and nothing else.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetDetailBody, setClientRole } from '../public/app.js';
import {
  EXTERNAL_IDS_COPY,
  IDENTIFIER_MAX_LENGTH,
  NAMESPACE_MAX_LENGTH,
  classifyExternalIdError,
  conflictMessage,
  detachPath,
  externalIdsPath,
  normaliseExternalIds,
  renderExternalIdsBlock,
  sameExternalId,
  validateExternalIdDraft,
} from '../public/external-ids.js';

const ULID = '01J9BBBBBBBBBBBBBBBBBBBBBB';

const ASSET = {
  id: ULID,
  name: 'rights-cleared-master.mxf',
  status: 'ready',
  statusHistory: [{ at: '2026-09-30T08:00:00.000Z', from: null, to: 'ready' }],
  createdAt: '2026-09-30T08:00:00.000Z',
  updatedAt: '2026-09-30T09:00:00.000Z',
};

// Two entries in two different namespaces, exactly as the 200 array declares
// them: both components required, nothing else.
const ENTRIES = [
  { namespace: 'rights-registry', id: 'urn:rights:7f3a-91' },
  { namespace: 'ingest-tool', id: '48215' },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const noBody = (status: number) => new Response(null, { status });

type Call = { url: string; method: string; body: unknown };

/**
 * Route by path, recording every call. `externalIds` is the sequence of answers
 * `GET …/external-ids` gives, one per call (the panel re-reads after each write
 * because the POST's 200 asset has the field stripped), with the last repeated.
 */
function routedFetch(opts: {
  externalIds?: object[][];
  postResponse?: () => Response;
  deleteResponse?: () => Response;
  getListStatus?: number;
}) {
  const sequence = opts.externalIds ?? [[]];
  let reads = 0;
  const calls: Call[] = [];

  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    let parsed: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        parsed = JSON.parse(init.body);
      } catch {
        parsed = init.body;
      }
    }
    calls.push({ url: path, method, body: parsed });

    if (/\/external-ids$/.test(path)) {
      if (method === 'POST') return (opts.postResponse ?? (() => json(ASSET)))();
      if (opts.getListStatus && opts.getListStatus !== 200) {
        return json({ error: 'not_found' }, opts.getListStatus);
      }
      const answer = sequence[Math.min(reads, sequence.length - 1)];
      reads += 1;
      return json(answer);
    }
    if (/\/external-ids\//.test(path) && method === 'DELETE') {
      return (opts.deleteResponse ?? (() => noBody(204)))();
    }
    if (/\/review-state$/.test(path)) {
      return json({ reviewState: 'draft', allowedTransitions: ['in-review'] });
    }
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(ASSET);
    return json({}, 200);
  });

  return { spy, calls };
}

async function settle(ticks = 40) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function block(root: ParentNode): HTMLElement {
  return root.querySelector('#asset-external-ids') as HTMLElement;
}

function rows(root: ParentNode): string[][] {
  const table = block(root)?.querySelector('table');
  if (!table) return [];
  return Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())
  );
}

function headers(root: ParentNode): string[] {
  const table = block(root)?.querySelector('table');
  if (!table) return [];
  return Array.from(table.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim());
}

function typeInto(root: ParentNode, name: string, value: string) {
  const input = block(root).querySelector(
    'input[data-field="' + name + '"]'
  ) as HTMLInputElement;
  input.value = value;
  return input;
}

function click(node: Element | null) {
  (node as HTMLElement).dispatchEvent(new Event('click', { bubbles: true }));
}

function submitForm(root: ParentNode) {
  const form = block(root).querySelector('form') as HTMLFormElement;
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('normaliseExternalIds — the 200 body is a bare array, taken as stored', () => {
  it('preserves server order element for element', () => {
    expect(normaliseExternalIds(ENTRIES)).toEqual(ENTRIES);
  });

  it('does NOT de-duplicate, because the route promises no dedup', () => {
    // src/routes/assets.ts:3301-3303 — "no dedup, sort, or reformatting". DELETE
    // removes every equal entry in one call (src/data/asset-repo.ts:1570), so a
    // duplicate must be visible to be clearable.
    const dupe = [ENTRIES[0], ENTRIES[0]];
    expect(normaliseExternalIds(dupe)).toHaveLength(2);
  });

  it('treats a non-array body as nothing rather than inventing an entry', () => {
    expect(normaliseExternalIds(null)).toEqual([]);
    expect(normaliseExternalIds({ entries: ENTRIES })).toEqual([]);
    expect(normaliseExternalIds(undefined)).toEqual([]);
  });

  it('keeps an entry missing a required field so an odd answer stays visible', () => {
    const odd = [{ namespace: 'rights-registry' }];
    expect(normaliseExternalIds(odd)).toEqual(odd);
  });

  it('drops entries the schema could never have produced', () => {
    expect(normaliseExternalIds([null, 'ns:id', 7, ENTRIES[0]])).toEqual([ENTRIES[0]]);
  });
});

describe('sameExternalId — equality is the API\'s, both components, verbatim', () => {
  it('matches only when BOTH components are identical', () => {
    expect(sameExternalId(ENTRIES[0], { ...ENTRIES[0] })).toBe(true);
    expect(sameExternalId(ENTRIES[0], { namespace: 'ingest-tool', id: ENTRIES[0].id })).toBe(false);
    expect(sameExternalId(ENTRIES[0], { namespace: ENTRIES[0].namespace, id: 'x' })).toBe(false);
  });

  it('does not trim or case-fold, because the store does not', () => {
    // src/data/asset-repo.ts:1534-1536 and :1570 compare with === only.
    expect(sameExternalId(ENTRIES[0], { namespace: 'Rights-Registry', id: ENTRIES[0].id })).toBe(
      false
    );
    expect(sameExternalId(ENTRIES[0], { namespace: ' rights-registry', id: ENTRIES[0].id })).toBe(
      false
    );
  });
});

describe('validateExternalIdDraft — exactly the POST body schema, nothing more', () => {
  it('requires a non-empty namespace and identifier', () => {
    const r = validateExternalIdDraft({ namespace: '', id: '' });
    expect(r.ok).toBe(false);
    expect(r.errors.namespace).toBe(EXTERNAL_IDS_COPY.errNamespaceRequired);
    expect(r.errors.id).toBe(EXTERNAL_IDS_COPY.errIdentifierRequired);
  });

  it('accepts the schema maxima exactly and rejects one over', () => {
    // attachExternalIdBodySchema: namespace max 256, id max 1024
    // (src/routes/assets.ts:505, 513).
    expect(NAMESPACE_MAX_LENGTH).toBe(256);
    expect(IDENTIFIER_MAX_LENGTH).toBe(1024);
    const atMax = validateExternalIdDraft({
      namespace: 'n'.repeat(256),
      id: 'i'.repeat(1024),
    });
    expect(atMax.ok).toBe(true);
    const overNs = validateExternalIdDraft({ namespace: 'n'.repeat(257), id: 'x' });
    expect(overNs.errors.namespace).toBe(EXTERNAL_IDS_COPY.errNamespaceTooLong);
    const overId = validateExternalIdDraft({ namespace: 'n', id: 'i'.repeat(1025) });
    expect(overId.errors.id).toBe(EXTERNAL_IDS_COPY.errIdentifierTooLong);
  });

  it('accepts a URN, a space and a slash — the API constrains no character class', () => {
    // `namespace`/`id` are bare bounded strings in all three operations: no enum,
    // no pattern (attachExternalIdBodySchema :501-518). Rejecting more here would
    // be inventing a contract.
    expect(validateExternalIdDraft({ namespace: 'rights registry', id: 'urn:a:b/c' }).ok).toBe(true);
  });

  it('refuses a pair the asset already carries, which POST would no-op', () => {
    // POST is idempotent for an exact repeat (src/data/asset-repo.ts:1533-1537),
    // so sending it would report a change the server did not make.
    const r = validateExternalIdDraft(ENTRIES[0], { existing: ENTRIES });
    expect(r.ok).toBe(false);
    expect(r.errors.form).toBe(EXTERNAL_IDS_COPY.errDuplicate);
  });

  it('lets an edit keep its own pair unchanged (the row being edited is ignored)', () => {
    const r = validateExternalIdDraft(ENTRIES[0], { existing: ENTRIES, ignore: ENTRIES[0] });
    expect(r.ok).toBe(true);
  });

  it('still refuses an edit that collides with a DIFFERENT existing row', () => {
    const r = validateExternalIdDraft(ENTRIES[1], { existing: ENTRIES, ignore: ENTRIES[0] });
    expect(r.errors.form).toBe(EXTERNAL_IDS_COPY.errDuplicate);
  });
});

describe('detachPath — the composite key is two independently encoded segments', () => {
  it('builds /assets/{id}/external-ids/{namespace}/{externalId}', () => {
    expect(detachPath(ULID, ENTRIES[1])).toBe(
      '/assets/' + ULID + '/external-ids/ingest-tool/48215'
    );
  });

  it('encodes a colon, a slash and a space per segment, never merging the two', () => {
    // The route declares two segments precisely so a URN-shaped id is unambiguous
    // (src/routes/assets.ts:3225-3228). Verified against the live route: a
    // namespace with a space and an id containing ':' and '/' (as %2F) match and
    // remove correctly.
    const path = detachPath(ULID, { namespace: 'rights registry', id: 'urn:x:a/b' });
    expect(path).toBe(
      '/assets/' + ULID + '/external-ids/rights%20registry/urn%3Ax%3Aa%2Fb'
    );
    // Exactly four slashes after the leading one: assets / id / external-ids /
    // namespace / externalId. An unencoded '/' in the id would add a fifth.
    expect(path.split('/')).toHaveLength(6);
  });

  it('externalIdsPath is the collection both GET and POST use', () => {
    expect(externalIdsPath(ULID)).toBe('/assets/' + ULID + '/external-ids');
  });
});

describe('classifyExternalIdError — only statuses the operations declare', () => {
  it('409 names the conflicting asset id from the real envelope fields', () => {
    // externalIdConflictSchema (src/routes/assets.ts:524-531): error, message?,
    // reason, namespace, externalId, conflictingAssetId.
    const c = classifyExternalIdError({
      status: 409,
      message: 'already attached',
      body: {
        error: 'external_id_conflict',
        reason: 'external_id_conflict',
        namespace: 'rights-registry',
        externalId: 'urn:rights:7f3a-91',
        conflictingAssetId: '01J9CCCCCCCCCCCCCCCCCCCCCC',
      },
    });
    expect(c.kind).toBe('conflict');
    expect(c.message).toContain('01J9CCCCCCCCCCCCCCCCCCCCCC');
    expect(c.message).toContain('rights-registry');
    expect(c.revokeControls).toBe(false);
  });

  it('403 revokes the controls that cannot work', () => {
    const c = classifyExternalIdError({ status: 403, message: 'forbidden_insufficient_role' });
    expect(c.kind).toBe('forbidden');
    expect(c.revokeControls).toBe(true);
    expect(c.message).toBe(EXTERNAL_IDS_COPY.errForbidden);
  });

  it('404 means the ASSET is gone — never "the pair is gone"', () => {
    // A pair that was never attached is a 204 on DELETE (:3240-3243) and a 200
    // no-op on POST, so 404 can only be the asset.
    const c = classifyExternalIdError({ status: 404 });
    expect(c.message).toBe(EXTERNAL_IDS_COPY.errNotFound);
    expect(c.refresh).toBe(true);
  });

  it('400 reports the boundary refusal and keeps the form open', () => {
    const c = classifyExternalIdError({ status: 400, message: 'body/namespace too long' });
    expect(c.kind).toBe('invalid');
    expect(c.message).toContain('body/namespace too long');
    expect(c.refresh).toBe(false);
  });

  it('falls back to the server message for anything undeclared', () => {
    expect(classifyExternalIdError({ status: 503, message: 'upstream down' }).message).toBe(
      'upstream down'
    );
  });

  it('conflictMessage still reads without the optional pair fields', () => {
    expect(conflictMessage({ conflictingAssetId: 'abc' })).toContain('abc');
    expect(conflictMessage({})).toContain('another asset');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure rendering
// ─────────────────────────────────────────────────────────────────────────────

describe('renderExternalIdsBlock', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => host.remove());

  it('lists every entry with its namespace AND value in separate columns', () => {
    const r = renderExternalIdsBlock({ entries: ENTRIES, usable: true }, { canChange: true });
    host.appendChild(r.block);
    expect(headers(host)).toEqual([
      EXTERNAL_IDS_COPY.colNamespace,
      EXTERNAL_IDS_COPY.colIdentifier,
      EXTERNAL_IDS_COPY.colActions,
    ]);
    expect(rows(host)).toEqual([
      ['rights-registry', 'urn:rights:7f3a-91', EXTERNAL_IDS_COPY.editButton + EXTERNAL_IDS_COPY.removeButton],
      ['ingest-tool', '48215', EXTERNAL_IDS_COPY.editButton + EXTERNAL_IDS_COPY.removeButton],
    ]);
  });

  it('renders an entry missing a field as "—" rather than hiding the row', () => {
    const r = renderExternalIdsBlock(
      { entries: [{ namespace: 'rights-registry' }], usable: true },
      { canChange: false }
    );
    host.appendChild(r.block);
    expect(rows(host)).toEqual([['rights-registry', '—']]);
  });

  it('shows an explicit empty state for 200 [] — an empty set is not a miss', () => {
    const r = renderExternalIdsBlock({ entries: [], usable: true }, { canChange: true });
    host.appendChild(r.block);
    const empty = host.querySelector('[data-empty="external-ids"]')!;
    expect(empty.textContent).toContain(EXTERNAL_IDS_COPY.empty);
    // Add is still offered: there is nothing to list but something to create.
    expect(host.querySelector('#btn-external-id-add')).not.toBeNull();
  });

  it('tells an unreadable set apart from an empty one, and offers no write', () => {
    const r = renderExternalIdsBlock({ entries: [], usable: false }, { canChange: true });
    host.appendChild(r.block);
    expect(host.querySelector('[data-empty="external-ids-unavailable"]')).not.toBeNull();
    expect(host.querySelector('[data-empty="external-ids"]')).toBeNull();
    expect(host.querySelector('#btn-external-id-add')).toBeNull();
  });

  it('read-only for a role without write: values visible, no controls, reason given', () => {
    const r = renderExternalIdsBlock({ entries: ENTRIES, usable: true }, { canChange: false });
    host.appendChild(r.block);
    expect(headers(host)).toEqual([EXTERNAL_IDS_COPY.colNamespace, EXTERNAL_IDS_COPY.colIdentifier]);
    expect(rows(host)).toEqual([
      ['rights-registry', 'urn:rights:7f3a-91'],
      ['ingest-tool', '48215'],
    ]);
    expect(host.querySelectorAll('.external-id-edit, .external-id-remove, .external-id-add')).toHaveLength(
      0
    );
    expect(host.querySelector('#external-ids-role-note')!.textContent).toBe(
      EXTERNAL_IDS_COPY.readOnly
    );
  });

  it('never routes a server value through innerHTML', () => {
    const nasty = { namespace: '<img src=x onerror=alert(1)>', id: '"><script>bad()</script>' };
    const r = renderExternalIdsBlock({ entries: [nasty], usable: true }, { canChange: true });
    host.appendChild(r.block);
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('script')).toBeNull();
    expect(rows(host)[0][0]).toBe(nasty.namespace);
  });

  it('the edit form states that saving is two requests, because the API has no update', () => {
    const r = renderExternalIdsBlock(
      { entries: ENTRIES, usable: true },
      { canChange: true, editing: ENTRIES[0] }
    );
    host.appendChild(r.block);
    expect(host.querySelector('.external-id-form--edit')!.textContent).toContain(
      EXTERNAL_IDS_COPY.editNote
    );
  });

  it('the namespace field is free text with a labelled, described input (no picker)', () => {
    // No `enum` on `namespace` anywhere in the three operations, so there is no
    // vocabulary to offer and nothing to populate a <select> from.
    const r = renderExternalIdsBlock({ entries: [], usable: true }, { canChange: true, adding: true });
    host.appendChild(r.block);
    expect(host.querySelector('select')).toBeNull();
    const input = host.querySelector('input[data-field="namespace"]') as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.getAttribute('maxlength')).toBe('256');
    const label = host.querySelector('label[for="' + input.id + '"]')!;
    expect(label.textContent).toBe(EXTERNAL_IDS_COPY.namespaceLabel);
    const describedBy = input.getAttribute('aria-describedby')!;
    expect(host.querySelector('#' + describedBy)!.textContent).toBe(
      EXTERNAL_IDS_COPY.namespaceHint
    );
    const idInput = host.querySelector('input[data-field="id"]') as HTMLInputElement;
    expect(idInput.getAttribute('maxlength')).toBe('1024');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail view integration — the real renderer, against a stubbed fetch
// ─────────────────────────────────────────────────────────────────────────────

describe('asset detail — external identifiers (issue #908)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    setClientRole('admin');
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads the sub-resource — the asset body cannot supply the identifiers', async () => {
    const { spy, calls } = routedFetch({ externalIds: [ENTRIES] });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    // `assetSchema` declares no `externalIdentifiers` property, so this GET is the
    // only way to learn the set (src/routes/assets.ts:3293-3299).
    const reads = calls.filter((c) => c.method === 'GET' && /\/external-ids$/.test(c.url));
    expect(reads).toHaveLength(1);
    expect(reads[0].url).toContain('/assets/' + ULID + '/external-ids');

    expect(rows(container).map((r) => [r[0], r[1]])).toEqual([
      ['rights-registry', 'urn:rights:7f3a-91'],
      ['ingest-tool', '48215'],
    ]);
  });

  it('renders the empty state for 200 [] without reporting a failure', async () => {
    const { spy } = routedFetch({ externalIds: [[]] });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(container.querySelector('[data-empty="external-ids"]')).not.toBeNull();
    expect(container.querySelector('[data-empty="external-ids-unavailable"]')).toBeNull();
  });

  it('reports an unreadable set as unknown rather than as empty', async () => {
    const { spy } = routedFetch({ getListStatus: 404 });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(container.querySelector('[data-empty="external-ids-unavailable"]')).not.toBeNull();
    expect(container.querySelector('#btn-external-id-add')).toBeNull();
  });

  it('adds an entry with exactly the two declared body properties, then re-reads', async () => {
    const { spy, calls } = routedFetch({
      externalIds: [[], [{ namespace: 'rights-registry', id: 'urn:rights:7f3a-91' }]],
    });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    click(container.querySelector('#btn-external-id-add'));
    typeInto(container, 'namespace', 'rights-registry');
    typeInto(container, 'id', 'urn:rights:7f3a-91');
    submitForm(container);
    await settle();

    const posts = calls.filter((c) => c.method === 'POST' && /\/external-ids$/.test(c.url));
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ namespace: 'rights-registry', id: 'urn:rights:7f3a-91' });

    // The POST's 200 asset has the field stripped by the serializer, so the panel
    // must re-read the sub-resource to learn the new set.
    const reads = calls.filter((c) => c.method === 'GET' && /\/external-ids$/.test(c.url));
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(rows(container).map((r) => r[0])).toEqual(['rights-registry']);
  });

  it('never sends PUT or PATCH — neither method exists on either path', async () => {
    const { spy, calls } = routedFetch({
      externalIds: [ENTRIES, [{ namespace: 'rights-registry', id: 'urn:rights:NEW' }, ENTRIES[1]]],
    });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    click(container.querySelectorAll('.external-id-edit')[0]);
    typeInto(container, 'id', 'urn:rights:NEW');
    submitForm(container);
    await settle();

    const methods = calls.filter((c) => /external-ids/.test(c.url)).map((c) => c.method);
    expect(methods).not.toContain('PUT');
    expect(methods).not.toContain('PATCH');
  });

  it('saves an edit as POST(new) then DELETE(old) — in that order', async () => {
    const { spy, calls } = routedFetch({
      externalIds: [ENTRIES, [{ namespace: 'rights-registry', id: 'urn:rights:NEW' }, ENTRIES[1]]],
    });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    click(container.querySelectorAll('.external-id-edit')[0]);
    typeInto(container, 'id', 'urn:rights:NEW');
    submitForm(container);
    await settle();

    const writes = calls.filter((c) => c.method === 'POST' || c.method === 'DELETE');
    expect(writes.map((c) => c.method)).toEqual(['POST', 'DELETE']);
    // POST carries the NEW pair …
    expect(writes[0].body).toEqual({ namespace: 'rights-registry', id: 'urn:rights:NEW' });
    // … and the DELETE targets the OLD one, on the two-segment path.
    expect(writes[1].url).toContain(detachPath(ULID, ENTRIES[0]));
  });

  it('an edit that changes nothing sends no request at all', async () => {
    const { spy, calls } = routedFetch({ externalIds: [ENTRIES] });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    click(container.querySelectorAll('.external-id-edit')[0]);
    submitForm(container);
    await settle();

    // POST would answer 200 as an idempotent no-op (src/data/asset-repo.ts:1533-1537),
    // which would read as a change the server did not make.
    expect(calls.filter((c) => c.method === 'POST' || c.method === 'DELETE')).toHaveLength(0);
    expect(block(container).textContent).toContain(EXTERNAL_IDS_COPY.unchangedMessage);
  });

  it('reports the half-done edit when the add lands but the remove does not', async () => {
    const { spy, calls } = routedFetch({
      externalIds: [ENTRIES, [{ namespace: 'rights-registry', id: 'urn:rights:NEW' }, ...ENTRIES]],
      deleteResponse: () => json({ error: 'not_found' }, 404),
    });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    click(container.querySelectorAll('.external-id-edit')[0]);
    typeInto(container, 'id', 'urn:rights:NEW');
    submitForm(container);
    await settle();

    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(block(container).textContent).toContain(EXTERNAL_IDS_COPY.errEditHalfDone);
    // And the surviving old pair is on screen, so it can be cleared.
    expect(rows(container).map((r) => r[1])).toContain('urn:rights:7f3a-91');
  });

  it('removes an entry through the two-segment DELETE, after confirming', async () => {
    const { spy, calls } = routedFetch({ externalIds: [ENTRIES, [ENTRIES[1]]] });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    click(container.querySelectorAll('.external-id-remove')[0]);
    await settle(5);

    // The house destructive-confirm dialog (issue #919) names the pair.
    const dialog = document.querySelector('.confirm-dialog')!;
    expect(dialog.textContent).toContain('rights-registry');
    expect(dialog.textContent).toContain('urn:rights:7f3a-91');
    click(dialog.querySelector('.confirm-accept'));
    await settle();

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toContain(detachPath(ULID, ENTRIES[0]));
    expect(rows(container).map((r) => r[0])).toEqual(['ingest-tool']);
  });

  it('sends nothing when the remove confirmation is dismissed', async () => {
    const { spy, calls } = routedFetch({ externalIds: [ENTRIES] });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    click(container.querySelectorAll('.external-id-remove')[0]);
    await settle(5);
    click(document.querySelector('.confirm-dialog')!.querySelector('.confirm-cancel'));
    await settle();

    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('surfaces the 409 conflict by naming the asset that holds the pair, and stops there', async () => {
    const { spy, calls } = routedFetch({
      externalIds: [ENTRIES],
      postResponse: () =>
        json(
          {
            error: 'external_id_conflict',
            message: 'already attached',
            reason: 'external_id_conflict',
            namespace: 'rights-registry',
            externalId: 'urn:rights:NEW',
            conflictingAssetId: '01J9CCCCCCCCCCCCCCCCCCCCCC',
          },
          409
        ),
    });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    click(container.querySelectorAll('.external-id-edit')[0]);
    typeInto(container, 'id', 'urn:rights:NEW');
    submitForm(container);
    await settle();

    expect(block(container).textContent).toContain('01J9CCCCCCCCCCCCCCCCCCCCCC');
    // The add failed, so the old pair must NOT be removed.
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('blocks an over-long identifier client-side, without spending a 400', async () => {
    const { spy, calls } = routedFetch({ externalIds: [[]] });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    click(container.querySelector('#btn-external-id-add'));
    typeInto(container, 'namespace', 'rights-registry');
    const idInput = typeInto(container, 'id', 'i'.repeat(IDENTIFIER_MAX_LENGTH + 1));
    submitForm(container);
    await settle();

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(idInput.getAttribute('aria-invalid')).toBe('true');
    expect(block(container).textContent).toContain(EXTERNAL_IDS_COPY.errIdentifierTooLong);
  });

  it('a viewer sees every namespace and value but gets no write control', async () => {
    // MATRIX (src/auth/authorize.ts:54-58): viewer holds `read` only; POST->write
    // and DELETE->delete would both be 403 (methodToAction :79-93).
    setClientRole('viewer');
    const { spy, calls } = routedFetch({ externalIds: [ENTRIES] });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(rows(container)).toEqual([
      ['rights-registry', 'urn:rights:7f3a-91'],
      ['ingest-tool', '48215'],
    ]);
    expect(container.querySelector('#btn-external-id-add')).toBeNull();
    expect(container.querySelectorAll('.external-id-edit, .external-id-remove')).toHaveLength(0);
    expect(container.querySelector('#external-ids-role-note')).not.toBeNull();
    // The read itself is still issued — `read` is a permission a viewer holds.
    expect(calls.some((c) => c.method === 'GET' && /\/external-ids$/.test(c.url))).toBe(true);
  });

  it('stops offering a control that returned 403 and says why', async () => {
    const { spy } = routedFetch({
      externalIds: [ENTRIES],
      deleteResponse: () =>
        json({ error: 'forbidden_insufficient_role', message: 'denied' }, 403),
    });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    click(container.querySelectorAll('.external-id-remove')[0]);
    await settle(5);
    click(document.querySelector('.confirm-dialog')!.querySelector('.confirm-accept'));
    await settle();

    expect(block(container).textContent).toContain(EXTERNAL_IDS_COPY.errForbidden);
    expect(container.querySelectorAll('.external-id-edit, .external-id-remove')).toHaveLength(0);
    // The identifiers themselves stay visible.
    expect(rows(container).map((r) => r[0])).toEqual(['rights-registry', 'ingest-tool']);
  });

  it('sits between the review block and the action controls', async () => {
    const { spy } = routedFetch({ externalIds: [ENTRIES] });
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const review = container.querySelector('#review-state')!;
    const extIds = block(container);
    // #btn-extract-meta lives in the always-present action row the panel anchors
    // against (public/app.js — `actionsDiv`).
    const action = container.querySelector('#btn-extract-meta')!;
    expect(review.compareDocumentPosition(extIds) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(extIds.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
