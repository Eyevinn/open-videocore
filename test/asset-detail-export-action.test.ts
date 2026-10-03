// @vitest-environment happy-dom
//
// Export action on the asset detail view (issue #945, broken out of #796).
//
// What these tests hold in place:
//   1. The format picker can only ever submit a value the endpoint's `z.enum`
//      accepts — asserted against the SERVER constant, so the client list
//      cannot drift from `REWRAP_FORMATS`.
//   2. The request body carries exactly the declared properties and NO
//      destination field — the premise correction this ticket rests on.
//   3. Each response status drives the state the design spec pins for it, and a
//      502 prints the server's own sentence verbatim rather than a generic
//      "export failed".
//   4. A 501 retires the form and explains the condition by name, instead of
//      leaving a doomed submit button on screen.
//
// CONTRACT GROUNDING — every path, field, method and status below was read from
// this repo's generated spec and route source before the tests were written
// (CLAUDE.md rule 7), never from the issue text:
//
//   openapi.json .paths["/api/v1/assets/{id}/export"] — exactly one operation,
//   `post`.
//     .post.parameters: one path param `id` (string, required). No query params.
//     .post.requestBody: required: true, application/json, schema
//       { targetFormat: 'mp4'|'mkv'|'mov'|'mxf'|'ts' (the only required
//         property), outputName?: string(minLength 1, maxLength 256),
//         asVersion?: boolean },
//       additionalProperties: false.
//       Source: `exportBodySchema`, src/routes/assets.ts:723-730.
//     .post.responses: exactly 201, 400, 404, 409, 501, 502
//       (src/routes/assets.ts:5204-5211).
//         201 = assetSchema, the NEW CHILD asset (:5255).
//         404 = { error: 'not_found' } (:5215-5217).
//         409 = { error: 'no_object', message: 'asset has no stored source
//               object to process' } — NO_SOURCE_OBJECT_ERROR / _MESSAGE,
//               src/pipeline/source-object.ts:31/36, via requireSourceObject
//               (:96-104) called at src/routes/assets.ts:5220-5221.
//         501 = { error: 'not_configured', message: 'export / re-wrap is not
//               configured' } (:5222-5227). The same `error` code is also sent
//               by resolveConfiguredRunner (:2053-2069, the 501 at :2064).
//         502 = { error: 'rewrap_failed', message: <single sentence> }
//               (:5268-5269). The ffmpeg log is server-side only (:5262-5265)
//               and never in `message`.
//
//   Format vocabulary — REWRAP_FORMATS, src/pipeline/rewrap.ts:30, consumed by
//   exportBodySchema via z.enum(REWRAP_FORMATS) (src/routes/assets.ts:724). It
//   is IMPORTED below rather than restated, so this test fails if the client
//   list and the server enum ever diverge.
//
//   Authorisation — MATRIX (src/auth/authorize.ts:54-58): viewer holds `read`
//   but not `write`; methodToAction (:79-92) maps POST -> write, applied by
//   resourceAuthorizationPreHandler('asset') (:126, registered
//   src/routes/assets.ts:1773). 403 code
//   AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role' (:99).
//
//   NO destination field — `exportBodySchema` has none, and the named
//   export-destinations registry (src/routes/export-destinations.ts) is
//   consumed only by the optional `destination` body property of
//   POST /:id/package and POST /:id/execute (resolveJobDestination,
//   src/routes/assets.ts:2137-2266). Asserted explicitly below.
//
//   Copy and visual treatment — docs/design/export-action-states.md (issue
//   #911) §1-§5. The honesty guarantee the success copy relies on —
//   docs/findings/export-truthful-status-944.md §6.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REWRAP_FORMATS } from '../src/pipeline/rewrap.js';
import { renderAssetDetailBody } from '../public/app.js';
import {
  EXPORT_COPY,
  EXPORT_FORMATS,
  buildExportBody,
  classifyExportError,
  formatLabel,
  mountExportAction,
  normaliseOutputName,
  renderExportBlock,
  renderExportNotConfigured,
  resetExportAvailability,
} from '../public/export-action.js';

const ULID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';
const CHILD_ULID = '01J9AAAAAAAAAAAAAAAAAAAAAA';

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

// A 201 body: the new CHILD asset (src/routes/assets.ts:5255). `objectKey` is
// `exports/<childId>.<format>` (rewrapObjectKey, src/pipeline/rewrap.ts:62).
const CHILD = {
  id: CHILD_ULID,
  name: 'promo-cut.mov [mp4]',
  slug: 'promo-cut-mp4',
  status: 'ready',
  parentId: ULID,
  objectKey: 'exports/' + CHILD_ULID + '.mp4',
  statusHistory: [{ at: '2026-09-20T11:00:00.000Z', from: null, to: 'ready' }],
  createdAt: '2026-09-20T11:00:00.000Z',
  updatedAt: '2026-09-20T11:00:00.000Z',
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

/** A stub `apiFetch` that always answers with `impl`. */
function stubApi(impl: (path: string, opts?: RequestInit) => unknown) {
  return vi.fn(async (path: string, opts?: RequestInit) => impl(path, opts));
}

function mount(
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
  return host;
}

function q<T extends Element = HTMLElement>(root: ParentNode, sel: string) {
  return root.querySelector(sel) as T | null;
}

function msgText(root: ParentNode): string {
  const host = q(root, '#export-msg');
  return ((host && host.textContent) || '').replace(/\s+/g, ' ').trim();
}

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
// Format vocabulary — the client list cannot drift from the server enum
// ─────────────────────────────────────────────────────────────────────────────

describe('export format vocabulary', () => {
  it('mirrors REWRAP_FORMATS exactly, in order', () => {
    // The real constant the route's z.enum is built from
    // (src/pipeline/rewrap.ts:30, src/routes/assets.ts:724). If a format is
    // added or removed server-side and the picker is not updated, this fails.
    expect([...EXPORT_FORMATS]).toEqual([...REWRAP_FORMATS]);
  });

  it('renders a format as the wire value uppercased, never a longer invented name', () => {
    expect(formatLabel('mp4')).toBe('MP4');
    expect(formatLabel('mxf')).toBe('MXF');
    // Not "MPEG-4 Part 14" or any other expansion the contract does not carry.
    expect(formatLabel('mp4')).not.toContain('MPEG');
  });

  it('passes through a format this build does not recognise rather than blanking it', () => {
    expect(formatLabel('webm')).toBe('WEBM');
    expect(formatLabel('')).toBe('');
    expect(formatLabel(undefined)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Request body — exactly the declared properties
// ─────────────────────────────────────────────────────────────────────────────

describe('request body (exportBodySchema)', () => {
  it('sends only targetFormat when no name was given', () => {
    expect(buildExportBody('mkv')).toEqual({ targetFormat: 'mkv' });
  });

  it('adds outputName only when there is one', () => {
    expect(buildExportBody('mp4', 'master')).toEqual({
      targetFormat: 'mp4',
      outputName: 'master',
    });
  });

  it('never carries a destination field — the schema has none', () => {
    // The premise correction this ticket rests on: POST /:id/export takes no
    // destination of any kind, so the body must not grow one. The schema is
    // additionalProperties: false, so an invented key would be a 400.
    const keys = Object.keys(buildExportBody('mp4', 'master'));
    expect(keys.sort()).toEqual(['outputName', 'targetFormat']);
    for (const k of ['destination', 'destinationBucket', 'externalBackend', 'destinationId']) {
      expect(keys).not.toContain(k);
    }
  });

  it('omits an empty or whitespace-only name instead of sending an invalid empty string', () => {
    // outputName is string().min(1) (src/routes/assets.ts:725): '' would 400.
    expect(normaliseOutputName('')).toEqual({ ok: true });
    expect(normaliseOutputName('   ')).toEqual({ ok: true });
    expect(normaliseOutputName(null)).toEqual({ ok: true });
    expect(normaliseOutputName(undefined)).toEqual({ ok: true });
  });

  it('trims a name but does not truncate an over-long one', () => {
    expect(normaliseOutputName('  master  ')).toEqual({ ok: true, value: 'master' });
    expect(normaliseOutputName('a'.repeat(256))).toEqual({
      ok: true,
      value: 'a'.repeat(256),
    });
    // 257 > max(256). Truncating would export under a name nobody chose.
    expect(normaliseOutputName('a'.repeat(257))).toEqual({ ok: false, reason: 'too-long' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error classification — one state per declared status
// ─────────────────────────────────────────────────────────────────────────────

describe('response classification', () => {
  it('502 prints the server sentence verbatim, never a generic failure line', () => {
    const serverSentence = 're-wrap job ended with status Stopped';
    const c = classifyExportError(
      apiError(502, { error: 'rewrap_failed', message: serverSentence }),
      { format: 'mp4' }
    );
    expect(c.kind).toBe('failed');
    expect(c.message).toContain(serverSentence);
    expect(c.message).toContain('Export to MP4 failed:');
    expect(c.notConfigured).toBe(false);
  });

  it('501 is the not-configured state, with the server message as supporting detail only', () => {
    const c = classifyExportError(
      apiError(501, { error: 'not_configured', message: 'export / re-wrap is not configured' }),
      { format: 'mp4' }
    );
    expect(c.notConfigured).toBe(true);
    expect(c.message).toBe(EXPORT_COPY.notConfiguredTitle);
    expect(c.detail).toBe('export / re-wrap is not configured');
    // §1 keeps the pipeline's internal name out of the headline.
    expect(c.message.toLowerCase()).not.toContain('re-wrap');
  });

  it('treats the runner-factory 501 as the same condition (same error code, different message)', () => {
    // resolveConfiguredRunner sends 501 not_configured carrying the factory's
    // own message (src/routes/assets.ts:2064).
    const c = classifyExportError(
      apiError(501, { error: 'not_configured', message: 'rewrapRunner factory could not be resolved' }),
      { format: 'ts' }
    );
    expect(c.notConfigured).toBe(true);
    expect(c.detail).toBe('rewrapRunner factory could not be resolved');
  });

  it('409 names the asset rather than echoing the shared generic sentence', () => {
    const c = classifyExportError(
      apiError(409, { error: 'no_object', message: 'asset has no stored source object to process' }),
      { format: 'mp4', sourceName: 'promo-cut.mov' }
    );
    expect(c.kind).toBe('no-object');
    expect(c.message).toBe('promo-cut.mov has no stored file to export.');
  });

  it('404 does not narrow which of "gone" or "not yours" happened', () => {
    const c = classifyExportError(apiError(404, { error: 'not_found' }), { format: 'mp4' });
    expect(c.message).toBe(EXPORT_COPY.errNotFound);
    expect(c.message.toLowerCase()).not.toContain('access');
    expect(c.message.toLowerCase()).not.toContain('permission');
  });

  it('400 is the defensive unsupported-format line', () => {
    const c = classifyExportError(apiError(400, { error: 'bad_request' }), { format: 'mp4' });
    expect(c.kind).toBe('bad-format');
    expect(c.message).toBe(EXPORT_COPY.errUnsupportedFormat);
  });

  it('403 from the authorisation gate is a role refusal, not an export failure', () => {
    const c = classifyExportError(
      apiError(403, { error: 'forbidden_insufficient_role' }),
      { format: 'mp4' }
    );
    expect(c.forbidden).toBe(true);
    expect(c.message).toBe(EXPORT_COPY.errForbidden);
  });

  it('a transport failure says nothing was exported', () => {
    const c = classifyExportError(new Error('network down'), { format: 'mp4' });
    expect(c.kind).toBe('network');
    expect(c.message).toBe(EXPORT_COPY.errNetwork);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

describe('renderExportBlock', () => {
  it('offers one option per accepted format and no free-text format field', () => {
    const { block, formatSelect } = renderExportBlock();
    const values = Array.from(
      (formatSelect as HTMLSelectElement).querySelectorAll('option')
    ).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual([...REWRAP_FORMATS]);
    // No route to a value the enum would reject.
    expect(block.querySelector('input[name="targetFormat"]')).toBeNull();
  });

  it('binds every control to a visible label and announces outcomes politely', () => {
    const { block } = renderExportBlock();
    const formatLabelEl = q(block, 'label[for="export-format"]');
    const nameLabelEl = q(block, 'label[for="export-output-name"]');
    expect(formatLabelEl?.textContent).toBe(EXPORT_COPY.formatLabel);
    expect(nameLabelEl?.textContent).toBe(EXPORT_COPY.nameLabel);
    expect(q(block, '#export-format')).not.toBeNull();
    expect(q(block, '#export-output-name')).not.toBeNull();
    expect(q(block, '#export-msg')?.getAttribute('aria-live')).toBe('polite');
    // Enter in the name field submits.
    expect(q<HTMLButtonElement>(block, '#btn-export-asset')?.type).toBe('submit');
  });

  it("caps the name field at the schema's own bound", () => {
    const { nameInput } = renderExportBlock();
    expect((nameInput as HTMLInputElement).getAttribute('maxlength')).toBe('256');
  });

  it('explains the absence of the control for a role that cannot export', () => {
    const { block, form } = renderExportBlock({ canExport: false });
    expect(form).toBeNull();
    expect(q(block, '#export-role-note')?.textContent).toBe(EXPORT_COPY.readOnly);
    expect(q(block, '#btn-export-asset')).toBeNull();
  });

  it('never offers a destination picker', () => {
    const { block } = renderExportBlock();
    const text = (block.textContent || '').toLowerCase();
    expect(text).not.toContain('destination');
    expect(block.querySelector('[name="destination"]')).toBeNull();
  });
});

describe('renderExportNotConfigured (501)', () => {
  it('names the condition instead of showing a generic error', () => {
    const block = renderExportNotConfigured();
    const text = (block.textContent || '').replace(/\s+/g, ' ');
    expect(text).toContain(EXPORT_COPY.notConfiguredTitle);
    expect(text).toContain(EXPORT_COPY.notConfiguredBody);
    expect(text.toLowerCase()).not.toContain('something went wrong');
    expect(text.toLowerCase()).not.toContain('try again later');
  });

  it('is distinguishable from a retryable error and from the 410 tombstone block', () => {
    const block = renderExportNotConfigured();
    expect(block.getAttribute('data-outcome')).toBe('not-configured');
    expect(block.classList.contains('msg-error')).toBe(false);
    expect(block.classList.contains('msg-unrecoverable')).toBe(false);
    expect(block.classList.contains('msg-not-configured')).toBe(true);
  });

  it("shows the API's own sentence as supporting detail when there is one", () => {
    const block = renderExportNotConfigured('export / re-wrap is not configured');
    expect(q(block, '.not-configured-detail')?.textContent).toBe(
      EXPORT_COPY.notConfiguredDetailPrefix + 'export / re-wrap is not configured'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mounted behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('mountExportAction — submitting', () => {
  it('POSTs to the asset-scoped export path with exactly the declared body', async () => {
    const api = stubApi(() => CHILD);
    const host = mount(api);

    q<HTMLSelectElement>(host, '#export-format')!.value = 'mkv';
    q<HTMLInputElement>(host, '#export-output-name')!.value = '  master  ';
    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    expect(api).toHaveBeenCalledTimes(1);
    const [path, opts] = api.mock.calls[0];
    expect(path).toBe('/assets/' + ULID + '/export');
    expect(opts!.method).toBe('POST');
    expect(JSON.parse(String(opts!.body))).toEqual({
      targetFormat: 'mkv',
      outputName: 'master',
    });
  });

  it('defaults to the first accepted format and omits a blank name', async () => {
    const api = stubApi(() => CHILD);
    const host = mount(api);

    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    expect(JSON.parse(String(api.mock.calls[0][1]!.body))).toEqual({
      targetFormat: REWRAP_FORMATS[0],
    });
  });

  it('disables the controls and shows an indeterminate busy state while in flight', async () => {
    let release: (v: unknown) => void = () => {};
    const api = stubApi(() => new Promise((r) => { release = r; }));
    const host = mount(api);

    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle(3);

    const btn = q<HTMLButtonElement>(host, '#btn-export-asset')!;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe(EXPORT_COPY.busy);
    expect(q<HTMLSelectElement>(host, '#export-format')!.disabled).toBe(true);
    expect(q<HTMLInputElement>(host, '#export-output-name')!.disabled).toBe(true);
    expect(msgText(host)).toBe('Exporting to MP4…');
    // No fabricated progress signal: the contract exposes none.
    expect(host.querySelector('progress')).toBeNull();
    expect(msgText(host)).not.toMatch(/%/);

    release(CHILD);
    await settle();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe(EXPORT_COPY.submit);
  });

  it('refuses an over-long name locally without sending a request', async () => {
    const api = stubApi(() => CHILD);
    const host = mount(api);

    q<HTMLInputElement>(host, '#export-output-name')!.value = 'a'.repeat(300);
    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    expect(api).not.toHaveBeenCalled();
    expect(msgText(host)).toContain('256 characters or fewer');
  });
});

describe('mountExportAction — 201 exported', () => {
  it('reports the format and names the export, linking to it', async () => {
    const api = stubApi(() => CHILD);
    const opened: string[] = [];
    const host = mount(api, { onOpenAsset: (id: string) => opened.push(id) });

    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    const msg = q(host, '#export-msg')!;
    expect(msg.querySelector('.msg-success')).not.toBeNull();
    expect(msgText(host)).toContain('Exported to MP4.');
    const link = q<HTMLAnchorElement>(host, '.export-result-link')!;
    expect(link.textContent).toBe(CHILD.name);
    expect(link.getAttribute('data-asset-id')).toBe(CHILD_ULID);

    link.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    expect(opened).toEqual([CHILD_ULID]);
  });

  it('offers the export id as click-to-copy, following the house convention', async () => {
    const api = stubApi(() => CHILD);
    const wired: ParentNode[] = [];
    const host = mount(api, { wireCopyIds: (root: ParentNode) => wired.push(root) });

    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    const copyBtn = q(host, '.copy-id-btn')!;
    expect(copyBtn.getAttribute('data-copy-id')).toBe(CHILD_ULID);
    expect(copyBtn.getAttribute('aria-live')).toBe('polite');
    expect(wired).toHaveLength(1);
  });

  it('clears the name field and re-enables the form for the next export', async () => {
    const api = stubApi(() => CHILD);
    const host = mount(api);

    q<HTMLInputElement>(host, '#export-output-name')!.value = 'master';
    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    expect(q<HTMLInputElement>(host, '#export-output-name')!.value).toBe('');
    expect(q<HTMLButtonElement>(host, '#btn-export-asset')!.disabled).toBe(false);
  });

  it('hands the 201 body to onExported so the surrounding view can refresh', async () => {
    const api = stubApi(() => CHILD);
    const seen: unknown[] = [];
    const host = mount(api, { onExported: (c: unknown) => seen.push(c) });

    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    expect(seen).toEqual([CHILD]);
  });
});

describe('mountExportAction — 502 export failed', () => {
  const SENTENCE = 're-wrap job ended with status Stopped';

  it("shows the API's own failure sentence, not a generic message", async () => {
    const api = stubApi(() => {
      throw apiError(502, { error: 'rewrap_failed', message: SENTENCE });
    });
    const host = mount(api);

    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    expect(q(host, '#export-msg .msg-error')).not.toBeNull();
    expect(msgText(host)).toBe('Export to MP4 failed: ' + SENTENCE);
  });

  it('keeps the operator inputs and stays retryable', async () => {
    const api = stubApi(() => {
      throw apiError(502, { error: 'rewrap_failed', message: SENTENCE });
    });
    const host = mount(api);

    q<HTMLSelectElement>(host, '#export-format')!.value = 'mov';
    q<HTMLInputElement>(host, '#export-output-name')!.value = 'master';
    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    // Nothing about a 502 says the inputs were wrong.
    expect(q<HTMLSelectElement>(host, '#export-format')!.value).toBe('mov');
    expect(q<HTMLInputElement>(host, '#export-output-name')!.value).toBe('master');
    const btn = q<HTMLButtonElement>(host, '#btn-export-asset')!;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe(EXPORT_COPY.submit);
  });

  it('links to nothing — a failed export has no file to offer', async () => {
    const api = stubApi(() => {
      throw apiError(502, { error: 'rewrap_failed', message: SENTENCE });
    });
    const host = mount(api);

    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    expect(host.querySelector('.export-result-link')).toBeNull();
    expect(host.querySelector('.copy-id-btn')).toBeNull();
    // No "see details" affordance: the ffmpeg log is server-side only.
    expect(msgText(host).toLowerCase()).not.toContain('details');
  });
});

describe('mountExportAction — 501 export not available', () => {
  it('retires the form and explains the condition by name', async () => {
    const api = stubApi(() => {
      throw apiError(501, { error: 'not_configured', message: 'export / re-wrap is not configured' });
    });
    const host = mount(api);

    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    // §5: no format picker, no name field, no submit button in this state.
    expect(host.querySelector('#export-form')).toBeNull();
    expect(host.querySelector('#export-format')).toBeNull();
    expect(host.querySelector('#export-output-name')).toBeNull();
    expect(host.querySelector('#btn-export-asset')).toBeNull();

    const block = q(host, '[data-outcome="not-configured"]')!;
    expect(block).not.toBeNull();
    expect((block.textContent || '')).toContain(EXPORT_COPY.notConfiguredTitle);
  });

  it('moves focus to the explanation, since the control that had focus is gone', async () => {
    const api = stubApi(() => {
      throw apiError(501, { error: 'not_configured', message: 'export / re-wrap is not configured' });
    });
    const host = mount(api);

    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    const block = q(host, '[data-outcome="not-configured"]')!;
    // Programmatically focusable but not a tab stop: nothing inside is interactive.
    expect(block.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(block);
  });

  it('opens straight into the unavailable state on a later mount in the same session', async () => {
    const api = stubApi(() => {
      throw apiError(501, { error: 'not_configured', message: 'export / re-wrap is not configured' });
    });
    const first = mount(api);
    q<HTMLFormElement>(first, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    // A second asset's detail view: the deployment-level condition is already
    // known, so the doomed form is never offered again.
    const second = mount(api);
    expect(second.querySelector('#export-form')).toBeNull();
    expect(second.querySelector('[data-outcome="not-configured"]')).not.toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
  });
});

describe('mountExportAction — 403 role refusal', () => {
  it('stops offering the control and says why', async () => {
    const api = stubApi(() => {
      throw apiError(403, { error: 'forbidden_insufficient_role' });
    });
    const host = mount(api);

    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    expect(host.querySelector('#export-form')).toBeNull();
    expect(msgText(host)).toBe(EXPORT_COPY.errForbidden);
    // Not mistaken for the deployment-level unavailable state.
    expect(host.querySelector('[data-outcome="not-configured"]')).toBeNull();
    // Focus is not stranded on the submit button that was just removed.
    expect(document.activeElement).toBe(q(host, '#export-msg .msg-error'));
  });
});

describe('mountExportAction — 409 no stored source object', () => {
  it('names the asset rather than echoing the shared generic sentence', async () => {
    const api = stubApi(() => {
      throw apiError(409, {
        error: 'no_object',
        message: 'asset has no stored source object to process',
      });
    });
    const host = mount(api);

    q<HTMLFormElement>(host, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    expect(msgText(host)).toBe('promo-cut.mov has no stored file to export.');
    expect(q<HTMLButtonElement>(host, '#btn-export-asset')!.disabled).toBe(false);
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
      if (/\/export$/.test(path) && method === 'POST') return json(CHILD, 201);
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

  it('renders the export action on the asset detail view', async () => {
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    const block = q(container, '#export-action')!;
    expect(block).not.toBeNull();
    expect((block.textContent || '')).toContain(EXPORT_COPY.heading);
    expect(q(container, '#btn-export-asset')).not.toBeNull();
    const values = Array.from(
      q<HTMLSelectElement>(container, '#export-format')!.querySelectorAll('option')
    ).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual([...REWRAP_FORMATS]);
  });

  it('exports against the ULID sub-resource path and reports the new asset', async () => {
    const fetchSpy = routedFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    q<HTMLFormElement>(container, '#export-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();

    const exportCalls = fetchSpy.mock.calls.filter(
      (c) => /\/export$/.test(String(c[0])) && (c[1] as RequestInit)?.method === 'POST'
    );
    expect(exportCalls).toHaveLength(1);
    expect(String(exportCalls[0][0])).toContain('/assets/' + ULID + '/export');
    expect(msgText(container)).toContain('Exported to MP4.');
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
