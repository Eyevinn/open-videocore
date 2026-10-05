// @vitest-environment happy-dom
//
// Export action on the asset detail view (issue #945, broken out of #796).
//
// What these tests hold in place — the issue's three acceptance criteria:
//   1. The picker offers the CURRENTLY configured destinations, read from the
//      live destinations endpoint, and can only ever submit an id that endpoint
//      just reported. The implicit OSC-managed default is excluded, asserted
//      against the SERVER constant so the client cannot drift from it.
//   2. Every outcome is reported truthfully: a 200 is only believed when it
//      carries the contract's single terminal value, a 502 prints the server's
//      own sentence, and a 504 is reported as an UNKNOWN outcome rather than as
//      either a success or a settled failure.
//   3. When nothing is registered the block explains that plainly instead of
//      presenting an empty picker or a submit button that could only fail — and
//      a list that could not be READ is never reported as "nothing registered".
//
// CONTRACT GROUNDING — every path, field, method and status below was read from
// route source and the generated spec before the tests were written (CLAUDE.md
// rule 7), never from the issue text:
//
//   GET /api/v1/export-destinations — handler src/routes/export-destinations.ts
//     :279-288 (`app.get('/')`, mounted at prefix `/api/v1/export-destinations`,
//     src/main.ts:2448-2449); `openapi.json
//     .paths["/api/v1/export-destinations/"].get`, asserted against directly
//     below so the fields this UI reads cannot vanish from the contract
//     unnoticed.
//     200 = `destinationListSchema` (:125-127) `{ destinations: View[] }`, with
//       `View` = `destinationViewSchema` (:95-123):
//       `{ id, name, role: 'source'|'packaged'|'both'|'archive',
//          backend: 'external', bucket, accessKeyId, endpointUrl?, region?,
//          publicBaseUrl?, pathTemplate?, hasSessionToken, deletable, createdAt,
//          credentials: { accessKeyId, secretAccessKey: '***redacted***',
//                         sessionToken?: '***redacted***' } }`.
//     501 = `{ error: 'not_configured', message: 'export destinations are not
//       configured' }` (:236-239, sent at :283).
//     The implicit OSC-managed default is ALWAYS in the 200 list:
//     `StorageBackendRegistry.list` prepends `defaultBackendView()`
//     (src/services/storage-backend-registry.ts:686-693, :138-153) with
//     `id: DEFAULT_BACKEND_ID` (:57), `role: 'both'`. `DEFAULT_BACKEND_ID` is
//     IMPORTED below rather than restated, so this test fails if the client and
//     the server ever disagree about which id to exclude.
//
//   POST /api/v1/assets/{id}/deliver (issue #1131, PR #1158) — handler
//     src/routes/assets.ts, the "Deliver an EXISTING asset to a registered
//     export destination" block; verified on branch
//     `issue-1131/deliver-endpoint`, which also adds
//     `openapi.json .paths["/api/v1/assets/{id}/deliver"].post`.
//     body: `deliverBodySchema` = `{ destination: string(1..256) }` — the ONLY
//       property, `additionalProperties: false`.
//     responses: exactly 200, 400, 404, 409, 422, 501, 502, 504.
//       200 = `{ assetId, status: 'delivered', destination: { id, name, role },
//         bucket, objectKey, bytes, etag, deliveredAt }`. `status` is the single
//         literal `'delivered'`, sent only after the object was re-read at the
//         destination with the source's byte count.
//       400 `bad_request` — unknown destination, or the OSC-managed default.
//       404 `not_found` — unknown/foreign asset; existence not leaked.
//       409 `no_object` (shared `requireSourceObject` contract,
//         src/pipeline/source-object.ts:31/37) or `source_missing`.
//       422 `backend_role` | `destination_unreachable` | `destination_unresolved`
//         | `source_too_large` — refused before any bytes moved.
//       501 `not_configured`, 502 `delivery_failed`, 504 `delivery_timeout`
//         (`DELIVERY_FAILURE_RESPONSE` in the route, reasons in
//         src/pipeline/asset-delivery.ts).
//     That PR is open at the time of writing, so the endpoint is STUBBED here
//     (as every other UI test in this suite stubs its endpoint) — no test
//     depends on a live backend. The `openapi.json` assertions for this path are
//     written so they tighten automatically once the spec entry lands, rather
//     than asserting a shape the spec does not yet carry.
//
//   Authorisation — MATRIX (src/auth/authorize.ts:54-58): viewer holds `read`
//   but not `write`; methodToAction (:79-92) maps POST -> write, applied by
//   resourceAuthorizationPreHandler('asset') (:126). 403 code
//   AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role' (:99). A viewer may
//   still read the destinations list.
//
//   Copy and visual treatment — docs/design/export-action-states.md (issue
//   #911) §1-§5, plus the two states that spec explicitly deferred until a
//   destination-carrying endpoint existed. The honesty rule the success and
//   timeout states follow — docs/findings/export-truthful-status-944.md.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BACKEND_ID } from '../src/services/storage-backend-registry.js';
import { renderAssetDetailBody } from '../public/app.js';
import {
  DELIVERABLE_ROLES,
  DESTINATIONS_PATH,
  EXPORT_COPY,
  NON_DELIVERABLE_ROLES,
  OSC_MANAGED_DEFAULT_ID,
  buildDeliverBody,
  classifyDestinationsError,
  classifyExportError,
  deliverableDestinations,
  describeDestination,
  destinationLabel,
  exportPathFor,
  formatDeliveredBytes,
  mountExportAction,
  renderDestinationsUnreadable,
  renderExportBlock,
  renderExportNotConfigured,
  renderNoDestinations,
  resetExportAvailability,
} from '../public/export-action.js';

const ULID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';

const ASSET = {
  id: ULID,
  name: 'promo-cut.mov',
  slug: 'promo-cut',
  status: 'ready',
  objectKey: 'sources/' + ULID + '.mov',
  statusHistory: [{ at: '2026-09-20T10:00:00.000Z', from: null, to: 'ready' }],
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
};

/**
 * The implicit OSC-managed default, exactly as `defaultBackendView()` builds it
 * (src/services/storage-backend-registry.ts:138-153). It is in EVERY 200 body,
 * which is why the picker has to exclude it.
 */
const DEFAULT_VIEW = {
  id: DEFAULT_BACKEND_ID,
  name: 'OSC-managed default',
  role: 'both',
  backend: 'external',
  bucket: '(OSC-managed default object storage)',
  accessKeyId: '(OSC-managed)',
  hasSessionToken: false,
  deletable: false,
  createdAt: '1970-01-01T00:00:00.000Z',
  credentials: { accessKeyId: '(OSC-managed)', secretAccessKey: '***redacted***' },
};

/** A registered destination view (`destinationViewSchema`). */
const ARCHIVE_DEST = {
  id: 'bk_01HQ',
  name: 'partner-archive',
  role: 'packaged',
  backend: 'external',
  bucket: 'partner-archive-bucket',
  accessKeyId: 'AKIAEXAMPLE',
  pathTemplate: '{date}/{assetId}',
  hasSessionToken: false,
  deletable: true,
  createdAt: '2026-09-01T09:00:00.000Z',
  credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: '***redacted***' },
};

const CDN_DEST = {
  id: 'bk_02HQ',
  name: 'cdn-origin',
  role: 'both',
  backend: 'external',
  bucket: 'cdn-origin-bucket',
  accessKeyId: 'AKIAEXAMPLE2',
  hasSessionToken: false,
  deletable: true,
  createdAt: '2026-09-02T09:00:00.000Z',
  credentials: { accessKeyId: 'AKIAEXAMPLE2', secretAccessKey: '***redacted***' },
};

const DESTINATIONS_BODY = { destinations: [DEFAULT_VIEW, ARCHIVE_DEST, CDN_DEST] };

/** A 200 body from the export call (`deliverResultSchema`). */
const DELIVERED = {
  assetId: ULID,
  status: 'delivered',
  destination: { id: ARCHIVE_DEST.id, name: ARCHIVE_DEST.name, role: 'packaged' },
  bucket: ARCHIVE_DEST.bucket,
  objectKey: '2026-10-05/' + ULID + '/sources/' + ULID + '.mov',
  bytes: 734_003_200,
  etag: 'd41d8cd98f00b204e9800998ecf8427e',
  deliveredAt: '2026-10-05T09:30:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function settle(ticks = 30) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * The error shape `apiFetch` (public/app.js) throws: `status`, the parsed
 * `body`, and `message` = body.message || body.error || 'HTTP <status>'.
 */
function apiError(status: number, body?: { error?: string; message?: string }) {
  const err = new Error(
    (body && (body.message || body.error)) || 'HTTP ' + status
  ) as Error & { status: number; body?: unknown };
  err.status = status;
  err.body = body;
  return err;
}

/**
 * A stub `apiFetch` that answers the destinations GET from `list` and the export
 * POST from `onExport`. Both calls are real to the module; only the transport is
 * stubbed, so no test needs a live backend.
 */
function stubApi(opts: {
  list?: () => unknown;
  onExport?: (body: unknown) => unknown;
} = {}) {
  const list = opts.list || (() => DESTINATIONS_BODY);
  const onExport = opts.onExport || (() => DELIVERED);
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (path === DESTINATIONS_PATH) return list();
    if ((init?.method || 'GET') === 'POST') {
      return onExport(init?.body ? JSON.parse(String(init.body)) : undefined);
    }
    throw new Error('unexpected call: ' + path);
  });
}

async function mount(
  api: ReturnType<typeof stubApi>,
  extra: Record<string, unknown> = {}
) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  mountExportAction({
    assetId: ULID,
    sourceName: ASSET.name,
    host,
    apiFetch: api,
    ...extra,
  });
  await settle();
  return host;
}

function q<T extends Element = HTMLElement>(root: ParentNode, sel: string) {
  return root.querySelector(sel) as T | null;
}

function msgText(root: ParentNode): string {
  const host = q(root, '#export-msg');
  return ((host && host.textContent) || '').replace(/\s+/g, ' ').trim();
}

function submitForm(root: ParentNode) {
  q<HTMLFormElement>(root, '#export-form')!.dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true })
  );
}

// The generated spec, read from the repo root (`process.cwd()` under vitest —
// the same convention test/asset-delete-lock-protection.test.ts:63 uses; a
// file: URL relative to import.meta.url is not available in the happy-dom
// environment).
const SPEC = JSON.parse(readFileSync(resolve(process.cwd(), 'openapi.json'), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};

beforeEach(() => {
  localStorage.clear();
  // The 501 memo is module state; a leak between cases would silently retire
  // the form for every later test.
  resetExportAvailability();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// Contract — asserted against the generated spec and the server constants
// ─────────────────────────────────────────────────────────────────────────────

describe('contract the export action is written against', () => {
  it('reads the destinations list from the path the spec declares', () => {
    // Mounted at prefix /api/v1/export-destinations with a route of '/', which
    // the generator renders with the trailing slash. `apiFetch` prefixes
    // /api/v1, so the module's path is the suffix.
    expect('/api/v1' + DESTINATIONS_PATH + '/').toBe('/api/v1/export-destinations/');
    const op = SPEC.paths['/api/v1/export-destinations/']?.['get'];
    expect(op).toBeDefined();
    // Exactly two declared responses, which is why the module has exactly two
    // list-failure states (501 vs "could not read").
    expect(Object.keys(op!['responses'] as object).sort()).toEqual(['200', '501']);
  });

  it('only reads destination fields the spec actually declares', () => {
    const op = SPEC.paths['/api/v1/export-destinations/']!['get'] as Record<string, any>;
    const item =
      op['responses']['200']['content']['application/json']['schema']['properties'][
        'destinations'
      ]['items'];
    const props = Object.keys(item['properties']);
    // Every field the picker, its detail line and its filter read.
    for (const field of ['id', 'name', 'role', 'bucket', 'endpointUrl', 'pathTemplate']) {
      expect(props).toContain(field);
    }
    // The filter's role vocabulary comes from the declared enum, split into the
    // output-serving roles an export may target and the read/cold roles the
    // export call refuses with a 422. If a role is ADDED to the enum
    // server-side, this fails — deliberately: somebody has to decide which side
    // of that split it falls on rather than letting the picker guess.
    const roles = (item['properties']['role']['enum'] as string[]).slice().sort();
    expect([...DELIVERABLE_ROLES, ...NON_DELIVERABLE_ROLES].sort()).toEqual(roles);
    for (const role of DELIVERABLE_ROLES) {
      expect(NON_DELIVERABLE_ROLES).not.toContain(role);
    }
  });

  it('excludes exactly the id the server synthesises as the implicit default', () => {
    // Imported from the registry, not restated: if the server renames it, this
    // fails instead of the picker silently offering a guaranteed 400.
    expect(OSC_MANAGED_DEFAULT_ID).toBe(DEFAULT_BACKEND_ID);
  });

  it('posts to the asset-scoped export path', () => {
    expect(exportPathFor(ULID)).toBe('/assets/' + ULID + '/deliver');
    // An id is encoded, so nothing in it can escape the path segment.
    expect(exportPathFor('a/b')).toBe('/assets/a%2Fb/deliver');
  });

  it('matches the deliver operation in the spec once PR #1158 lands', () => {
    const op = SPEC.paths['/api/v1/assets/{id}/deliver']?.['post'] as
      | Record<string, any>
      | undefined;
    if (!op) {
      // PR #1158 (issue #1131) is not merged yet, so the generated spec has no
      // entry. The body shape is pinned from the route source regardless, by
      // the `buildDeliverBody` tests below; this assertion starts enforcing the
      // generated contract the moment the entry appears.
      expect(SPEC.paths['/api/v1/assets/{id}/export']?.['post']).toBeDefined();
      return;
    }
    const schema = op['requestBody']['content']['application/json']['schema'];
    expect(Object.keys(schema['properties'])).toEqual(['destination']);
    expect(schema['required']).toEqual(['destination']);
    expect(schema['additionalProperties']).toBe(false);
    expect(Object.keys(op['responses']).sort()).toEqual([
      '200',
      '400',
      '404',
      '409',
      '422',
      '501',
      '502',
      '504',
    ]);
    const ok = op['responses']['200']['content']['application/json']['schema'];
    expect(ok['properties']['status']['enum']).toEqual(['delivered']);
    for (const field of ['bucket', 'objectKey', 'bytes', 'etag', 'deliveredAt']) {
      expect(ok['required']).toContain(field);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Request body — exactly the one declared property
// ─────────────────────────────────────────────────────────────────────────────

describe('request body (deliverBodySchema)', () => {
  it('carries exactly `destination` and nothing else', () => {
    // additionalProperties: false — an invented key would be a 400.
    expect(buildDeliverBody(ARCHIVE_DEST.id)).toEqual({ destination: ARCHIVE_DEST.id });
    expect(Object.keys(buildDeliverBody(ARCHIVE_DEST.id))).toEqual(['destination']);
  });

  it('never grows a field the re-wrap endpoint owns', () => {
    // POST /:id/export (targetFormat/outputName/asVersion) is a DIFFERENT
    // contract. Sending any of its fields here would be a 400.
    const keys = Object.keys(buildDeliverBody('x'));
    for (const k of ['targetFormat', 'outputName', 'asVersion', 'destinationBucket']) {
      expect(keys).not.toContain(k);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The live list — which entries may be offered
// ─────────────────────────────────────────────────────────────────────────────

describe('deliverableDestinations', () => {
  it('offers the registered destinations from the live list', () => {
    expect(deliverableDestinations(DESTINATIONS_BODY).map((d: any) => d.id)).toEqual([
      ARCHIVE_DEST.id,
      CDN_DEST.id,
    ]);
  });

  it('excludes the implicit OSC-managed default, which the export call refuses', () => {
    const ids = deliverableDestinations(DESTINATIONS_BODY).map((d: any) => d.id);
    expect(ids).not.toContain(DEFAULT_BACKEND_ID);
    // A list holding ONLY the default is the real "nothing is registered"
    // state — `200 { destinations: [] }` is not reachable while the registry is
    // wired (StorageBackendRegistry.list prepends the default).
    expect(deliverableDestinations({ destinations: [DEFAULT_VIEW] })).toEqual([]);
  });

  it('drops a role the export call would refuse with a 422, keeps an unknown one', () => {
    const body = {
      destinations: [
        { ...ARCHIVE_DEST, id: 'src', role: 'source' },
        { ...ARCHIVE_DEST, id: 'cold', role: 'archive' },
        // A role this build has not heard of: the listing endpoint already
        // decided it is a destination, so it is the API's call, not ours.
        { ...ARCHIVE_DEST, id: 'future', role: 'mirror' },
      ],
    };
    expect(deliverableDestinations(body).map((d: any) => d.id)).toEqual(['future']);
  });

  it('drops an entry with no usable id — there would be nothing to send', () => {
    const body = { destinations: [{ ...ARCHIVE_DEST, id: '' }, { role: 'packaged' }, null] };
    expect(deliverableDestinations(body)).toEqual([]);
  });

  it('tolerates a body shape it does not recognise rather than throwing', () => {
    expect(deliverableDestinations(undefined)).toEqual([]);
    expect(deliverableDestinations({})).toEqual([]);
    expect(deliverableDestinations([ARCHIVE_DEST]).length).toBe(1);
  });
});

describe('destination presentation', () => {
  it('labels a destination by its operator-chosen name, falling back to its id', () => {
    expect(destinationLabel(ARCHIVE_DEST)).toBe('partner-archive');
    expect(destinationLabel({ id: 'bk_1' })).toBe('bk_1');
    expect(destinationLabel('already-a-label')).toBe('already-a-label');
    expect(destinationLabel(undefined)).toBe('');
  });

  it('shows the non-secret coordinates and never the redaction marker', () => {
    const facts = describeDestination(ARCHIVE_DEST);
    const labels = facts.map((f) => f.label);
    expect(labels).toContain('Bucket');
    expect(labels).toContain('Path template');
    expect(labels).toContain('Role');
    const values = facts.map((f) => f.value).join(' ');
    expect(values).toContain('partner-archive-bucket');
    expect(values).toContain('{date}/{assetId}');
    // The secret is never stored or echoed; surfacing the marker would only
    // suggest there is a credential here to look at.
    expect(values).not.toContain('redacted');
    expect(values).not.toContain('AKIA');
  });

  it('omits a field the view did not carry rather than printing an empty row', () => {
    const labels = describeDestination(CDN_DEST).map((f) => f.label);
    expect(labels).not.toContain('Path template');
    expect(labels).not.toContain('Endpoint');
  });
});

describe('formatDeliveredBytes', () => {
  it('renders the verified byte count the 200 body carries', () => {
    expect(formatDeliveredBytes(512)).toBe('512 B');
    expect(formatDeliveredBytes(734_003_200)).toBe('734 MB');
    expect(formatDeliveredBytes(1_500_000_000)).toBe('1.5 GB');
  });

  it('renders nothing for a value the body did not carry', () => {
    expect(formatDeliveredBytes(undefined)).toBe('');
    expect(formatDeliveredBytes(-1)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error classification — one state per declared status
// ─────────────────────────────────────────────────────────────────────────────

describe('export response classification', () => {
  const DEST = 'partner-archive';

  it('502 prints the server sentence verbatim, never a generic failure line', () => {
    const sentence = 'copy to partner-archive-bucket failed: AccessDenied';
    const c = classifyExportError(
      apiError(502, { error: 'delivery_failed', message: sentence }),
      { destination: DEST }
    );
    expect(c.kind).toBe('failed');
    expect(c.message).toBe('Export to partner-archive failed: ' + sentence);
    expect(c.unsettled).toBe(false);
  });

  it('504 is an UNKNOWN outcome — neither a success nor a settled failure', () => {
    const sentence = 'delivery did not settle within 120000ms';
    const c = classifyExportError(
      apiError(504, { error: 'delivery_timeout', message: sentence }),
      { destination: DEST }
    );
    expect(c.kind).toBe('unsettled');
    expect(c.unsettled).toBe(true);
    expect(c.message).toContain(sentence);
    expect(c.message).toContain(EXPORT_COPY.unsettledAdvice);
    // The whole point: it must not read as a settled outcome either way.
    expect(c.message).not.toContain('failed');
    expect(c.message.toLowerCase()).not.toContain('exported to');
  });

  it('422 is a refusal decided before any bytes moved, with the reason verbatim', () => {
    const sentence =
      'destination is registered at endpoint "https://s3.partner.example", which this API holds no credentials for';
    const c = classifyExportError(
      apiError(422, { error: 'destination_unreachable', message: sentence }),
      { destination: DEST }
    );
    expect(c.kind).toBe('refused');
    expect(c.message).toBe('Export to partner-archive was refused: ' + sentence);
  });

  it('501 is the not-configured state, with the server message as supporting detail only', () => {
    const c = classifyExportError(
      apiError(501, {
        error: 'not_configured',
        message: 'storage-backend registry is not configured',
      }),
      { destination: DEST }
    );
    expect(c.notConfigured).toBe(true);
    expect(c.message).toBe(EXPORT_COPY.notConfiguredTitle);
    expect(c.detail).toBe('storage-backend registry is not configured');
  });

  it('400 says the list was stale and asks for a reload', () => {
    const c = classifyExportError(
      apiError(400, { error: 'bad_request', message: 'no destination matches "bk_01HQ"' }),
      { destination: DEST }
    );
    expect(c.kind).toBe('unknown-destination');
    expect(c.staleList).toBe(true);
    expect(c.message).toBe(EXPORT_COPY.errUnknownDestination);
  });

  it('409 no_object names the asset rather than echoing the shared generic sentence', () => {
    const c = classifyExportError(
      apiError(409, {
        error: 'no_object',
        message: 'asset has no stored source object to process',
      }),
      { destination: DEST, sourceName: 'promo-cut.mov' }
    );
    expect(c.kind).toBe('no-object');
    expect(c.message).toBe('promo-cut.mov has no stored file to export.');
  });

  it('409 source_missing prints the server sentence — it names which object is gone', () => {
    const sentence = 'source object sources/x.mov is not present in bucket ovc-source';
    const c = classifyExportError(
      apiError(409, { error: 'source_missing', message: sentence }),
      { destination: DEST }
    );
    expect(c.kind).toBe('source-missing');
    expect(c.message).toContain(sentence);
  });

  it('404 does not narrow which of "gone" or "not yours" happened', () => {
    const c = classifyExportError(apiError(404, { error: 'not_found' }), {
      destination: DEST,
    });
    expect(c.message).toBe(EXPORT_COPY.errNotFound);
    expect(c.message.toLowerCase()).not.toContain('access');
    expect(c.message.toLowerCase()).not.toContain('permission');
  });

  it('403 from the authorisation gate is a role refusal, not an export failure', () => {
    const c = classifyExportError(
      apiError(403, { error: 'forbidden_insufficient_role' }),
      { destination: DEST }
    );
    expect(c.forbidden).toBe(true);
    expect(c.message).toBe(EXPORT_COPY.errForbidden);
  });

  it('a transport failure says nothing was exported', () => {
    const c = classifyExportError(new Error('network down'), { destination: DEST });
    expect(c.kind).toBe('network');
    expect(c.message).toBe(EXPORT_COPY.errNetwork);
  });
});

describe('destinations-list classification', () => {
  it('treats a 501 as "no destination storage on this deployment"', () => {
    const c = classifyDestinationsError(
      apiError(501, {
        error: 'not_configured',
        message: 'export destinations are not configured',
      })
    );
    expect(c.notConfigured).toBe(true);
    expect(c.message).toBe('export destinations are not configured');
  });

  it('treats anything else as "could not read the list", never as "none registered"', () => {
    expect(classifyDestinationsError(apiError(500, { error: 'internal' })).notConfigured).toBe(
      false
    );
    expect(classifyDestinationsError(new Error('offline')).notConfigured).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

describe('renderExportBlock', () => {
  it('offers one option per live destination, valued by its stable id', () => {
    const { block, destinationSelect } = renderExportBlock({
      destinations: [ARCHIVE_DEST, CDN_DEST],
    });
    const options = Array.from(
      (destinationSelect as HTMLSelectElement).querySelectorAll('option')
    ) as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual([ARCHIVE_DEST.id, CDN_DEST.id]);
    expect(options.map((o) => o.textContent)).toEqual(['partner-archive', 'cdn-origin']);
    // No route to a value the API did not just report.
    expect(block.querySelector('input[name="destination"]')).toBeNull();
  });

  it('binds the picker to a visible label and announces outcomes politely', () => {
    const { block } = renderExportBlock({ destinations: [ARCHIVE_DEST] });
    expect(q(block, 'label[for="export-destination"]')?.textContent).toBe(
      EXPORT_COPY.destinationLabel
    );
    expect(q(block, '#export-destination')).not.toBeNull();
    expect(q(block, '#export-msg')?.getAttribute('aria-live')).toBe('polite');
    // Enter in the picker submits.
    expect(q<HTMLButtonElement>(block, '#btn-export-asset')?.type).toBe('submit');
    // The picker's description points at both the standing hint and the live
    // per-destination detail line.
    expect(q(block, '#export-destination')?.getAttribute('aria-describedby')).toBe(
      'export-destination-hint export-destination-detail'
    );
  });

  it('offers no container-format control — that is a different endpoint', () => {
    const { block } = renderExportBlock({ destinations: [ARCHIVE_DEST] });
    expect(block.querySelector('[name="targetFormat"]')).toBeNull();
    expect(block.querySelector('[name="outputName"]')).toBeNull();
  });

  it('explains the absence of the control for a role that cannot export', () => {
    const { block, form } = renderExportBlock({
      destinations: [ARCHIVE_DEST],
      canExport: false,
    });
    expect(form).toBeNull();
    expect(q(block, '#export-role-note')?.textContent).toBe(EXPORT_COPY.readOnly);
    expect(q(block, '#btn-export-asset')).toBeNull();
  });

  it('shows a pending state while the list is being read, with no doomed submit', () => {
    const { block, form } = renderExportBlock({ loading: true });
    expect(form).toBeNull();
    expect(q(block, '#export-loading')?.textContent).toBe(EXPORT_COPY.loading);
    expect(block.querySelector('#btn-export-asset')).toBeNull();
    // Not a "no destinations" claim: we have not read the list yet.
    expect(block.querySelector('[data-outcome="no-destinations"]')).toBeNull();
  });
});

describe('the three standing states', () => {
  it('501 names the condition instead of showing a generic error', () => {
    const block = renderExportNotConfigured();
    const text = (block.textContent || '').replace(/\s+/g, ' ');
    expect(text).toContain(EXPORT_COPY.notConfiguredTitle);
    expect(text).toContain(EXPORT_COPY.notConfiguredBody);
    expect(text.toLowerCase()).not.toContain('something went wrong');
    expect(text.toLowerCase()).not.toContain('try again later');
    expect(block.getAttribute('data-outcome')).toBe('not-configured');
  });

  it("shows the API's own 501 sentence as supporting detail when there is one", () => {
    const block = renderExportNotConfigured('export destinations are not configured');
    expect(q(block, '.not-configured-detail')?.textContent).toBe(
      EXPORT_COPY.notConfiguredDetailPrefix + 'export destinations are not configured'
    );
  });

  it('"nothing registered" explains the gap and how an operator closes it', () => {
    const block = renderNoDestinations();
    const text = (block.textContent || '').replace(/\s+/g, ' ');
    expect(block.getAttribute('data-outcome')).toBe('no-destinations');
    expect(text).toContain(EXPORT_COPY.noDestinationsTitle);
    expect(text).toContain('POST /api/v1/export-destinations');
    // Explains why the platform-managed default is not offered as one.
    expect(text).toContain(EXPORT_COPY.noDestinationsDefaultNote);
  });

  it('an unreadable list says only that, and offers a retry', () => {
    const block = renderDestinationsUnreadable('HTTP 500');
    expect(block.getAttribute('data-outcome')).toBe('destinations-unreadable');
    const text = (block.textContent || '').replace(/\s+/g, ' ');
    expect(text).toContain(EXPORT_COPY.unreadableTitle);
    // It must NOT claim there are no destinations — we do not know that.
    expect(text).not.toContain(EXPORT_COPY.noDestinationsTitle);
    expect(q<HTMLButtonElement>(block, '#btn-export-destinations-retry')?.type).toBe('button');
  });

  it('all three are distinguishable from a retryable error and from the tombstone block', () => {
    for (const block of [
      renderExportNotConfigured(),
      renderNoDestinations(),
      renderDestinationsUnreadable(),
    ]) {
      expect(block.classList.contains('msg-error')).toBe(false);
      expect(block.classList.contains('msg-unrecoverable')).toBe(false);
      expect(block.classList.contains('msg-not-configured')).toBe(true);
      expect(block.getAttribute('tabindex')).toBe('-1');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mounted behaviour — the live list
// ─────────────────────────────────────────────────────────────────────────────

describe('mountExportAction — loading the live destinations', () => {
  it('reads the destinations endpoint and builds the picker from it', async () => {
    const api = stubApi();
    const host = await mount(api);

    expect(api).toHaveBeenCalledWith(DESTINATIONS_PATH);
    const options = Array.from(
      q<HTMLSelectElement>(host, '#export-destination')!.querySelectorAll('option')
    ) as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual([ARCHIVE_DEST.id, CDN_DEST.id]);
  });

  it('shows the selected destination’s coordinates, and updates them on change', async () => {
    const api = stubApi();
    const host = await mount(api);

    const detail = q(host, '#export-destination-detail')!;
    expect(detail.textContent).toContain('partner-archive-bucket');

    const select = q<HTMLSelectElement>(host, '#export-destination')!;
    select.value = CDN_DEST.id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(detail.textContent).toContain('cdn-origin-bucket');
    expect(detail.textContent).not.toContain('partner-archive-bucket');
  });

  it('explains plainly when nothing is registered, offering no picker at all', async () => {
    // The reachable "nothing registered" body: only the implicit default.
    const api = stubApi({ list: () => ({ destinations: [DEFAULT_VIEW] }) });
    const host = await mount(api);

    expect(host.querySelector('#export-form')).toBeNull();
    expect(host.querySelector('#export-destination')).toBeNull();
    expect(host.querySelector('#btn-export-asset')).toBeNull();
    const block = q(host, '[data-outcome="no-destinations"]')!;
    expect(block).not.toBeNull();
    expect(block.textContent).toContain(EXPORT_COPY.noDestinationsTitle);
  });

  it('opens straight into the 501 state when destination storage is unconfigured', async () => {
    const api = stubApi({
      list: () => {
        throw apiError(501, {
          error: 'not_configured',
          message: 'export destinations are not configured',
        });
      },
    });
    const host = await mount(api);

    expect(host.querySelector('#export-form')).toBeNull();
    const block = q(host, '[data-outcome="not-configured"]')!;
    expect(block.textContent).toContain(EXPORT_COPY.notConfiguredTitle);
    expect(block.textContent).toContain('export destinations are not configured');
  });

  it('remembers the 501 for the session instead of re-probing on every asset', async () => {
    const api = stubApi({
      list: () => {
        throw apiError(501, { error: 'not_configured' });
      },
    });
    await mount(api);
    const second = await mount(api);

    expect(second.querySelector('[data-outcome="not-configured"]')).not.toBeNull();
    // One probe for the deployment-level condition, not one per asset view.
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('a list it could not read is never reported as "nothing registered"', async () => {
    let calls = 0;
    const api = stubApi({
      list: () => {
        calls += 1;
        if (calls === 1) throw apiError(500, { error: 'internal' });
        return DESTINATIONS_BODY;
      },
    });
    const host = await mount(api);

    const notice = q(host, '[data-outcome="destinations-unreadable"]')!;
    expect(notice).not.toBeNull();
    expect(host.querySelector('[data-outcome="no-destinations"]')).toBeNull();
    expect(host.querySelector('#export-form')).toBeNull();

    // The retry is the one control that can change this state.
    q<HTMLButtonElement>(host, '#btn-export-destinations-retry')!.click();
    await settle();
    expect(host.querySelector('[data-outcome="destinations-unreadable"]')).toBeNull();
    expect(
      Array.from(
        q<HTMLSelectElement>(host, '#export-destination')!.querySelectorAll('option')
      ).length
    ).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mounted behaviour — exporting
// ─────────────────────────────────────────────────────────────────────────────

describe('mountExportAction — submitting', () => {
  it('POSTs the chosen destination id to the asset-scoped export path', async () => {
    const api = stubApi();
    const host = await mount(api);

    q<HTMLSelectElement>(host, '#export-destination')!.value = CDN_DEST.id;
    submitForm(host);
    await settle();

    const post = api.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(post[0]).toBe('/assets/' + ULID + '/deliver');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      destination: CDN_DEST.id,
    });
  });

  it('defaults to the first offered destination — never the OSC-managed default', async () => {
    const api = stubApi();
    const host = await mount(api);

    submitForm(host);
    await settle();

    const post = api.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    const body = JSON.parse(String((post[1] as RequestInit).body));
    expect(body.destination).toBe(ARCHIVE_DEST.id);
    expect(body.destination).not.toBe(DEFAULT_BACKEND_ID);
  });

  it('disables the controls and shows an indeterminate busy state while in flight', async () => {
    let release: (v: unknown) => void = () => {};
    const api = stubApi({
      onExport: () => new Promise((r) => { release = r; }),
    });
    const host = await mount(api);

    submitForm(host);
    await settle(3);

    const btn = q<HTMLButtonElement>(host, '#btn-export-asset')!;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe(EXPORT_COPY.busy);
    expect(q<HTMLSelectElement>(host, '#export-destination')!.disabled).toBe(true);
    expect(msgText(host)).toBe('Exporting to partner-archive…');
    // No fabricated progress signal: the contract exposes none.
    expect(host.querySelector('progress')).toBeNull();
    expect(msgText(host)).not.toMatch(/%/);

    release(DELIVERED);
    await settle();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe(EXPORT_COPY.submit);
  });
});

describe('mountExportAction — 200 exported', () => {
  it('names the destination the server resolved and the coordinates it verified', async () => {
    const api = stubApi();
    const host = await mount(api);

    submitForm(host);
    await settle();

    expect(q(host, '#export-msg .msg-success')).not.toBeNull();
    const text = msgText(host);
    expect(text).toContain('Exported to partner-archive.');
    expect(text).toContain(DELIVERED.bucket);
    expect(text).toContain(DELIVERED.objectKey);
    expect(text).toContain('734 MB');
    expect(text).toContain(DELIVERED.etag);
    expect(text).toContain(DELIVERED.deliveredAt);
  });

  it('offers the verified object key as click-to-copy, following the house convention', async () => {
    const wired: ParentNode[] = [];
    const api = stubApi();
    const host = await mount(api, { wireCopyIds: (root: ParentNode) => wired.push(root) });

    submitForm(host);
    await settle();

    const copyBtn = q(host, '.copy-id-btn')!;
    expect(copyBtn.getAttribute('data-copy-id')).toBe(DELIVERED.objectKey);
    expect(copyBtn.getAttribute('aria-live')).toBe('polite');
    expect(wired).toHaveLength(1);
  });

  it('links to no asset — a delivery creates none', async () => {
    const api = stubApi();
    const host = await mount(api);

    submitForm(host);
    await settle();

    expect(host.querySelector('#export-msg a')).toBeNull();
  });

  it('keeps the picker usable for a second destination', async () => {
    const api = stubApi();
    const host = await mount(api);

    submitForm(host);
    await settle();

    const select = q<HTMLSelectElement>(host, '#export-destination')!;
    expect(select.disabled).toBe(false);
    expect(q<HTMLButtonElement>(host, '#btn-export-asset')!.disabled).toBe(false);
    // The choice is left as the operator made it — exporting the same asset to a
    // second destination is a normal next step, not a mistake to clear.
    expect(select.value).toBe(ARCHIVE_DEST.id);
  });

  it('hands the 200 body to onExported so the surrounding view can react', async () => {
    const seen: unknown[] = [];
    const api = stubApi();
    const host = await mount(api, { onExported: (r: unknown) => seen.push(r) });

    submitForm(host);
    await settle();

    expect(seen).toEqual([DELIVERED]);
  });

  it('does not claim success for a 2xx that does not carry the terminal value', async () => {
    // The contract declares exactly one `status` value. "The call returned" is
    // not evidence that an object landed, so an unexpected body is reported.
    const api = stubApi({
      onExport: () => ({ ...DELIVERED, status: 'queued' }),
    });
    const host = await mount(api);

    submitForm(host);
    await settle();

    expect(host.querySelector('#export-msg .msg-success')).toBeNull();
    expect(msgText(host)).toContain('without confirming the export');
    expect(msgText(host)).toContain('queued');
    // Nothing is presented as verified.
    expect(msgText(host)).not.toContain(DELIVERED.etag);
  });
});

describe('mountExportAction — failures', () => {
  it("502 shows the API's own failure sentence, not a generic message", async () => {
    const sentence = 'copy to partner-archive-bucket failed: AccessDenied';
    const api = stubApi({
      onExport: () => {
        throw apiError(502, { error: 'delivery_failed', message: sentence });
      },
    });
    const host = await mount(api);

    submitForm(host);
    await settle();

    expect(q(host, '#export-msg .msg-error')).not.toBeNull();
    expect(msgText(host)).toBe('Export to partner-archive failed: ' + sentence);
    // Nothing is offered as a result.
    expect(host.querySelector('.copy-id-btn')).toBeNull();
    expect(msgText(host).toLowerCase()).not.toContain('details');
  });

  it('504 is reported as an unknown outcome, not as a success or a failure', async () => {
    const sentence = 'delivery did not settle within 120000ms';
    const api = stubApi({
      onExport: () => {
        throw apiError(504, { error: 'delivery_timeout', message: sentence });
      },
    });
    const host = await mount(api);

    submitForm(host);
    await settle();

    // Its own visual treatment: neither the success green nor the failure red.
    expect(q(host, '#export-msg .msg-warn')).not.toBeNull();
    expect(host.querySelector('#export-msg .msg-success')).toBeNull();
    expect(host.querySelector('#export-msg .msg-error')).toBeNull();
    const text = msgText(host);
    expect(text).toContain('did not settle');
    expect(text).toContain(sentence);
    expect(text).toContain('Check the destination bucket before exporting again.');
    expect(text).not.toContain('failed');
  });

  it('422 keeps the chosen destination and says it was refused, with the reason', async () => {
    const sentence =
      'destination is registered at endpoint "https://s3.partner.example", which this API holds no credentials for';
    const api = stubApi({
      onExport: () => {
        throw apiError(422, { error: 'destination_unreachable', message: sentence });
      },
    });
    const host = await mount(api);

    submitForm(host);
    await settle();

    expect(msgText(host)).toContain('was refused:');
    expect(msgText(host)).toContain(sentence);
    // Still retryable against another destination.
    const select = q<HTMLSelectElement>(host, '#export-destination')!;
    expect(select.disabled).toBe(false);
    expect(select.value).toBe(ARCHIVE_DEST.id);
  });

  it('400 reloads the list so a destination the API no longer has stops being offered', async () => {
    let calls = 0;
    const api = stubApi({
      list: () => {
        calls += 1;
        return calls === 1 ? DESTINATIONS_BODY : { destinations: [DEFAULT_VIEW, CDN_DEST] };
      },
      onExport: () => {
        throw apiError(400, {
          error: 'bad_request',
          message: 'no destination matches "bk_01HQ"',
        });
      },
    });
    const host = await mount(api);

    submitForm(host);
    await settle();

    const options = Array.from(
      q<HTMLSelectElement>(host, '#export-destination')!.querySelectorAll('option')
    ) as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual([CDN_DEST.id]);
    // The reload must not swallow the explanation for the failed attempt.
    expect(msgText(host)).toBe(EXPORT_COPY.errUnknownDestination);
  });

  it('409 no_object names the asset rather than echoing the shared sentence', async () => {
    const api = stubApi({
      onExport: () => {
        throw apiError(409, {
          error: 'no_object',
          message: 'asset has no stored source object to process',
        });
      },
    });
    const host = await mount(api);

    submitForm(host);
    await settle();

    expect(msgText(host)).toBe('promo-cut.mov has no stored file to export.');
    expect(q<HTMLButtonElement>(host, '#btn-export-asset')!.disabled).toBe(false);
  });

  it('501 on the export call retires the form and moves focus to the explanation', async () => {
    const api = stubApi({
      onExport: () => {
        throw apiError(501, {
          error: 'not_configured',
          message: 'object storage is not configured; asset delivery is unavailable',
        });
      },
    });
    const host = await mount(api);

    submitForm(host);
    await settle();

    expect(host.querySelector('#export-form')).toBeNull();
    expect(host.querySelector('#export-destination')).toBeNull();
    expect(host.querySelector('#btn-export-asset')).toBeNull();
    const block = q(host, '[data-outcome="not-configured"]')!;
    expect(block.textContent).toContain(EXPORT_COPY.notConfiguredTitle);
    // Focus is not stranded on the removed submit control (WCAG 2.4.3).
    expect(document.activeElement).toBe(block);
  });

  it('403 stops offering the control and says why', async () => {
    const api = stubApi({
      onExport: () => {
        throw apiError(403, { error: 'forbidden_insufficient_role' });
      },
    });
    const host = await mount(api);

    submitForm(host);
    await settle();

    expect(host.querySelector('#export-form')).toBeNull();
    expect(msgText(host)).toBe(EXPORT_COPY.errForbidden);
    // Not mistaken for the deployment-level unavailable state.
    expect(host.querySelector('[data-outcome="not-configured"]')).toBeNull();
    expect(document.activeElement).toBe(q(host, '#export-msg .msg-error'));
  });

  it('a transport failure says nothing was exported', async () => {
    const api = stubApi({
      onExport: () => {
        throw new Error('network down');
      },
    });
    const host = await mount(api);

    submitForm(host);
    await settle();

    expect(msgText(host)).toBe(EXPORT_COPY.errNetwork);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail view integration — the real renderer
// ─────────────────────────────────────────────────────────────────────────────

describe('asset detail — export block (issue #945)', () => {
  let container: HTMLElement;

  function routedFetch() {
    return vi.fn(async (url: string, opts?: RequestInit) => {
      const path = String(url);
      const method = (opts && opts.method) || 'GET';
      if (/\/export-destinations$/.test(path)) return json(DESTINATIONS_BODY);
      if (/\/deliver$/.test(path) && method === 'POST') return json(DELIVERED);
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

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('renders the export action with the live destinations on the detail view', async () => {
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    const block = q(container, '#export-action')!;
    expect(block).not.toBeNull();
    expect(block.textContent).toContain(EXPORT_COPY.heading);
    const options = Array.from(
      q<HTMLSelectElement>(container, '#export-destination')!.querySelectorAll('option')
    ) as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual([ARCHIVE_DEST.id, CDN_DEST.id]);
  });

  it('exports against the ULID sub-resource path and reports the verified landing', async () => {
    const fetchSpy = routedFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    submitForm(container);
    await settle();

    const posts = fetchSpy.mock.calls.filter(
      (c) => /\/deliver$/.test(String(c[0])) && (c[1] as RequestInit)?.method === 'POST'
    );
    expect(posts).toHaveLength(1);
    expect(String(posts[0][0])).toContain('/assets/' + ULID + '/deliver');
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({
      destination: ARCHIVE_DEST.id,
    });
    expect(msgText(container)).toContain('Exported to partner-archive.');
  });

  it('offers no export control to a viewer role', async () => {
    localStorage.setItem('ovc_role', 'viewer');
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(container.querySelector('#btn-export-asset')).toBeNull();
    expect(q(container, '#export-role-note')?.textContent).toBe(EXPORT_COPY.readOnly);
  });
});
