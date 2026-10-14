// @vitest-environment happy-dom
//
// Clip / trim affordance in the ops UI (issue #793).
//
// POST /api/v1/assets/{id}/clip has existed since issue #17; nothing in the UI
// could reach it. These tests cover the new control end to end: the pure
// range/body/error helpers, the dialog, and the detail-view integration driven
// through the REAL renderer (renderAssetDetailBody — the same code path the
// asset side panel and the detached detail window use).
//
// CONTRACT GROUNDING — every path, field, bound and status below was read from
// this repo's route source and generated spec before the tests were written
// (CLAUDE.md rule 7), never from the issue text:
//
//   openapi.json .paths["/api/v1/assets/{id}/clip"].post   (no operationId is
//     declared for any operation in this spec; path + method identify it)
//     parameters: exactly one — path `id` (string, required); no query params.
//     requestBody REQUIRED: startSeconds (number, minimum 0), endSeconds
//       (number, exclusive minimum 0), outputName (string, 1..256), asVersion
//       (boolean); required ["startSeconds","endSeconds"];
//       additionalProperties: false.
//     responses: exactly 201 / 400 / 404 / 409 / 501 / 502. 201 is the FULL
//       asset; the rest are { error, message? }.
//     Source: `clipBodySchema` src/routes/assets.ts:734-746 (including
//       `.refine((b) => b.endSeconds > b.startSeconds)` at :744-746), wired at
//       `app.post('/:id/clip', …)` src/routes/assets.ts:5389-5464 with
//       `response: { 201: assetSchema, 400, 404, 409, 501, 502: errorSchema }`
//       at :5395-5402.
//
//   The 201 child: `parentId` = the source asset id and the default name
//     `clip-${startSeconds}-${endSeconds}` are both decided in the pipeline —
//     src/pipeline/clip.ts:158-164 — and `parentId` is an optional property of
//     the asset schema (src/routes/assets.ts:883).
//
//   Failure is real failure (issue #786, CLOSED): the pipeline verifies the
//     written object exists and is non-empty before recording its objectKey and
//     advancing the child to `ready`, and marks the child `failed` + rethrows
//     otherwise (src/pipeline/clip.ts:166-209); the route maps that to
//     `502 { error: 'clip_failed', message }` (src/routes/assets.ts:5452-5461).
//     So the UI may report a usable clip ONLY for a 201 whose child says
//     `ready`.
//
//   The duration bound: `technicalMetadata.durationSeconds`
//     (technicalMetadataSchema, src/routes/assets.ts:761-770; `durationSeconds:
//     z.number()` at :765), reached through `assetSchema.technicalMetadata`,
//     which is `.nullish()` (src/routes/assets.ts:434). The API itself does NOT
//     bound the window against it — the only server-side ordering rule is the
//     schema refinement above — so the bound is a client-side guard and is
//     absent (explicitly, not invented) when the asset has no extracted
//     metadata.
//
//   409 `no_object` is the shared refusal for an asset with no stored source
//     (NO_SOURCE_OBJECT_ERROR / _MESSAGE, src/pipeline/source-object.ts:31-36,
//     applied at src/routes/assets.ts:5409), so the control is not offered when
//     `objectKey` is absent (an optional property, src/routes/assets.ts:886).
//
//   Authorisation: MATRIX (src/auth/authorize.ts:54-58) grants `write` to
//     editor and admin only; methodToAction (:79-93) maps POST -> write;
//     resourceAuthorizationPreHandler('asset') (:126, registered
//     src/routes/assets.ts:1718) applies it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  renderAssetDetailBody,
  setClientRole,
  canClipAsset,
  detailWindowUrl,
} from '../public/app.js';
import {
  CLIP_COPY,
  OUTPUT_NAME_MAX,
  buildClipForm,
  buildClipResult,
  classifyClipError,
  clipOutcome,
  clipRequestBody,
  formatSeconds,
  mountAssetClip,
  normaliseOutputName,
  outsideDurationMessage,
  parseSeconds,
  validateClipRange,
} from '../public/asset-clip.js';

const ULID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';
const CHILD_ULID = '01J9CHILDCHILDCHILDCHILDCH';
const OBJECT_KEY = 'sources/' + ULID;
const DURATION = 63.5;

type AssetDoc = Record<string, unknown>;

const sourceAsset = (overrides?: AssetDoc): AssetDoc => ({
  id: ULID,
  name: 'promo-master.mov',
  slug: 'brave-river-042',
  objectKey: OBJECT_KEY,
  status: 'ready',
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
  statusHistory: [{ at: '2026-09-20T10:00:00.000Z', from: null, to: 'ready' }],
  technicalMetadata: {
    codec: 'h264',
    width: 1920,
    height: 1080,
    durationSeconds: DURATION,
    bitrateBps: 5_000_000,
    containerFormat: 'mov',
    audioTracks: [],
    extractedAt: '2026-09-20T10:01:00.000Z',
  },
  ...overrides,
});

const readyChild = (overrides?: AssetDoc): AssetDoc => ({
  id: CHILD_ULID,
  name: 'clip-10-20',
  parentId: ULID,
  status: 'ready',
  objectKey: 'clips/' + CHILD_ULID + '.mp4',
  createdAt: '2026-09-21T09:00:00.000Z',
  updatedAt: '2026-09-21T09:00:10.000Z',
  statusHistory: [],
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('seconds parsing + formatting', () => {
  it('reads a decimal number of seconds, the unit the body schema declares', () => {
    expect(parseSeconds('0')).toBe(0);
    expect(parseSeconds('12.5')).toBe(12.5);
    expect(parseSeconds(' 7 ')).toBe(7);
    expect(parseSeconds(30)).toBe(30);
  });

  it('reports "nothing usable" rather than guessing a value', () => {
    // A number input hands back '' for text it refused; a caller can hand
    // anything.
    for (const raw of ['', '   ', 'abc', '1:02', null, undefined, {}, NaN, Infinity]) {
      expect(parseSeconds(raw as never)).toBeNull();
    }
  });

  it('formats seconds for display without changing what is sent', () => {
    expect(formatSeconds(0)).toBe('00:00:00');
    expect(formatSeconds(63.5)).toBe('00:01:03.500');
    expect(formatSeconds(3671)).toBe('01:01:11');
    expect(formatSeconds(-1)).toBe('—');
    expect(formatSeconds('63.5' as never)).toBe('—');
  });
});

describe('clip range validation', () => {
  it('accepts a window inside the duration', () => {
    const r = validateClipRange({ start: '10', end: '20.25', durationSeconds: DURATION });
    expect(r).toEqual({
      ok: true,
      startSeconds: 10,
      endSeconds: 20.25,
      reason: null,
      message: null,
    });
  });

  it('allows an out point exactly at the duration (the whole tail)', () => {
    const r = validateClipRange({ start: '0', end: String(DURATION), durationSeconds: DURATION });
    expect(r.ok).toBe(true);
  });

  it('refuses an out point past the duration (AC1)', () => {
    const r = validateClipRange({ start: '10', end: String(DURATION + 0.1), durationSeconds: DURATION });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('outside-duration');
    // The operator is told the actual limit, not just that there is one.
    expect(r.message).toBe(outsideDurationMessage(DURATION));
    expect(r.message).toContain(String(DURATION));
  });

  it('refuses an in point at or past the duration (AC1)', () => {
    expect(validateClipRange({ start: String(DURATION), end: '99', durationSeconds: DURATION }).reason)
      .toBe('outside-duration');
    expect(validateClipRange({ start: '100', end: '120', durationSeconds: DURATION }).reason)
      .toBe('outside-duration');
  });

  it('refuses an out point that is not later than the in point (AC1)', () => {
    // The schema's own refinement, mirrored client-side:
    // `.refine((b) => b.endSeconds > b.startSeconds)` src/routes/assets.ts:744.
    for (const [start, end] of [
      ['10', '10'],
      ['10', '9.999'],
      ['30', '1'],
    ]) {
      const r = validateClipRange({ start, end, durationSeconds: DURATION });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('out-not-after-in');
      expect(r.message).toBe(CLIP_COPY.errOrder);
    }
  });

  it('mirrors the schema bounds on each point', () => {
    // startSeconds: z.number().min(0)
    expect(validateClipRange({ start: '-1', end: '5', durationSeconds: DURATION }).reason)
      .toBe('in-negative');
    // endSeconds: z.number().positive()
    expect(validateClipRange({ start: '-5', end: '0', durationSeconds: DURATION }).reason)
      .toBe('in-negative');
    expect(validateClipRange({ start: '0', end: '0', durationSeconds: DURATION }).reason)
      .toBe('out-not-positive');
  });

  it('asks for a value instead of assuming one when a field is empty', () => {
    expect(validateClipRange({ start: '', end: '10', durationSeconds: DURATION }).message)
      .toBe(CLIP_COPY.errInNumber);
    expect(validateClipRange({ start: '0', end: '', durationSeconds: DURATION }).message)
      .toBe(CLIP_COPY.errOutNumber);
  });

  it('does not invent a bound when the asset has no extracted duration', () => {
    // technicalMetadata is `.nullish()` until the first successful extraction
    // (src/routes/assets.ts:434), and the API itself never bounds the window —
    // so a long window is accepted here and the dialog says the check could not
    // be made.
    for (const duration of [null, undefined, 0, NaN]) {
      const r = validateClipRange({ start: '10', end: '9999', durationSeconds: duration as never });
      expect(r.ok).toBe(true);
    }
    // The ordering rules still apply without a duration.
    expect(validateClipRange({ start: '10', end: '5' }).reason).toBe('out-not-after-in');
  });
});

describe('output name', () => {
  it('treats an empty field as "let the API name it"', () => {
    // Absent, never an empty string: the schema declares minLength 1, so ''
    // would be a 400 (src/routes/assets.ts:738).
    expect(normaliseOutputName('')).toEqual({ ok: true, value: undefined, message: null });
    expect(normaliseOutputName('   ')).toEqual({ ok: true, value: undefined, message: null });
    expect(clipRequestBody(1, 2, '')).toEqual({ startSeconds: 1, endSeconds: 2 });
    expect(clipRequestBody(1, 2, undefined)).toEqual({ startSeconds: 1, endSeconds: 2 });
  });

  it('enforces the schema maximum', () => {
    expect(OUTPUT_NAME_MAX).toBe(256);
    expect(normaliseOutputName('x'.repeat(256)).ok).toBe(true);
    const long = normaliseOutputName('x'.repeat(257));
    expect(long.ok).toBe(false);
    expect(long.message).toBe(CLIP_COPY.errNameTooLong);
  });
});

describe('clip request body', () => {
  it('carries the two required fields, plus the name only when given', () => {
    expect(clipRequestBody(10, 20)).toEqual({ startSeconds: 10, endSeconds: 20 });
    expect(clipRequestBody(10, 20, ' teaser ')).toEqual({
      startSeconds: 10,
      endSeconds: 20,
      outputName: 'teaser',
    });
  });

  it('never sends asVersion, which rewrites the SOURCE asset’s lineage', () => {
    // src/pipeline/clip.ts:144-156 — asVersion writes back to the source.
    const body = clipRequestBody(10, 20, 'teaser') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['endSeconds', 'outputName', 'startSeconds']);
    expect(body.asVersion).toBeUndefined();
  });
});

describe('clip error classification', () => {
  it('reports a 502 as an outright failure with no usable clip (AC3)', () => {
    const c = classifyClipError({
      status: 502,
      message: 'clip output object "clips/x.mp4" is empty (0 bytes) after the job reported success',
      body: { error: 'clip_failed' },
    });
    expect(c.kind).toBe('job-failed');
    expect(c.message).toBe(CLIP_COPY.errJobFailed);
    // Honest in both directions: it failed, and the API did not hand back a
    // clip that looks ready.
    expect(c.message).toMatch(/failed/i);
    expect(c.message).toContain('No clip is available');
    expect(c.message).not.toMatch(/created|succeeded|queued/i);
    // The server's own sentence is kept as the detail line.
    expect(c.detail).toContain('0 bytes');
    expect(c.dismiss).toBe(false);
  });

  it('names each declared refusal', () => {
    expect(classifyClipError({ status: 409, body: { error: 'no_object' } }).message)
      .toBe(CLIP_COPY.errNoObject);
    expect(classifyClipError({ status: 501, body: { error: 'not_configured' } }).message)
      .toBe(CLIP_COPY.errNotConfigured);
    expect(classifyClipError({ status: 404, body: { error: 'not_found' } }).message)
      .toBe(CLIP_COPY.errNotFound);
    expect(classifyClipError({ status: 400 }).message).toBe(CLIP_COPY.errRejected);
    expect(classifyClipError({ status: 403 }).message).toBe(CLIP_COPY.errForbidden);
    expect(classifyClipError({ status: 401 }).message).toBe(CLIP_COPY.errForbidden);
    // Machine codes stay out of the operator's sentence.
    expect(classifyClipError({ status: 409, body: { error: 'no_object' } }).message)
      .not.toMatch(/no_object/);
  });

  it('does not claim nothing happened when the transport failed', () => {
    const c = classifyClipError(new Error('fetch failed') as never);
    expect(c.kind).toBe('unknown');
    expect(c.message).toBe(CLIP_COPY.errNetwork);
    expect(c.message).toMatch(/unknown/i);
  });
});

describe('clip outcome, read off the returned child (AC3)', () => {
  it('reports a ready child as a usable clip', () => {
    const o = clipOutcome(readyChild());
    expect(o.ok).toBe(true);
    expect(o.id).toBe(CHILD_ULID);
    expect(o.name).toBe('clip-10-20');
    expect(o.message).toContain('ready');
  });

  it('refuses to call a non-ready child ready, even on a 201', () => {
    const o = clipOutcome(readyChild({ status: 'failed' }));
    expect(o.ok).toBe(false);
    expect(o.status).toBe('failed');
    expect(o.message).toContain('failed');
    expect(o.message).toContain('not ready');
    // The id is still carried, so the operator can go and inspect it.
    expect(o.id).toBe(CHILD_ULID);
  });

  it('handles a 201 with no asset at all', () => {
    const o = clipOutcome(null);
    expect(o.ok).toBe(false);
    expect(o.id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dialog + outcome block (pure render)
// ─────────────────────────────────────────────────────────────────────────────

describe('clip form (pure render)', () => {
  let body: HTMLElement;

  beforeEach(() => {
    body = document.createElement('div');
    document.body.appendChild(body);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('bounds both points on the inputs themselves, from the asset duration (AC1)', () => {
    const form = buildClipForm(body, { durationSeconds: DURATION });
    expect(form.startInput.type).toBe('number');
    expect(form.startInput.min).toBe('0');
    expect(form.startInput.max).toBe(String(DURATION));
    expect(form.endInput.min).toBe('0');
    expect(form.endInput.max).toBe(String(DURATION));
    // The bound is also stated in words, with the number.
    expect(body.textContent).toContain(String(DURATION));
    expect(body.textContent).toContain(formatSeconds(DURATION));
  });

  it('says the check cannot be made instead of inventing a bound', () => {
    const form = buildClipForm(body, { durationSeconds: null });
    expect(form.startInput.getAttribute('max')).toBeNull();
    expect(form.endInput.getAttribute('max')).toBeNull();
    expect(form.endInput.value).toBe('');
    expect(body.textContent).toContain(CLIP_COPY.durationUnknown);
  });

  it('labels every field and wires its help text for assistive technology', () => {
    const form = buildClipForm(body, { durationSeconds: DURATION });
    expect(body.querySelector('label[for="clip-start-seconds"]')?.textContent).toBe(CLIP_COPY.inLabel);
    expect(body.querySelector('label[for="clip-end-seconds"]')?.textContent).toBe(CLIP_COPY.outLabel);
    expect(body.querySelector('label[for="clip-output-name"]')?.textContent).toBe(CLIP_COPY.nameLabel);
    expect(form.startInput.getAttribute('aria-describedby')).toBe('clip-start-seconds-help');
    expect(form.endInput.getAttribute('aria-describedby')).toBe('clip-end-seconds-help');
    expect(form.nameInput.getAttribute('aria-describedby')).toBe('clip-output-name-help');
    expect(form.nameInput.maxLength).toBe(OUTPUT_NAME_MAX);
    // Silent until something goes wrong, then announced.
    expect(form.errorEl.style.display).toBe('none');
    expect(form.errorEl.getAttribute('role')).toBe('alert');
  });

  it('says what a clip produces and that the request waits for it', () => {
    buildClipForm(body, { durationSeconds: DURATION });
    expect(body.textContent).toContain(CLIP_COPY.dialogIntro);
    expect(body.textContent).toContain(CLIP_COPY.dialogSync);
  });

  it('reuses the house form furniture rather than a new dialog primitive', () => {
    buildClipForm(body, { durationSeconds: DURATION });
    expect(body.classList.contains('clip-dialog')).toBe(true);
    expect(body.querySelector('.form-row')).not.toBeNull();
    expect(body.querySelectorAll('.form-field').length).toBe(3);
    expect(body.querySelector('.modal-actions')).not.toBeNull();
    expect(body.querySelector('.msg.msg-error')).not.toBeNull();
  });
});

describe('clip outcome block', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('links the produced clip and can navigate in place (AC2)', () => {
    const onOpen = vi.fn();
    const node = buildClipResult(clipOutcome(readyChild()), {
      href: 'detail.html?type=asset&id=' + CHILD_ULID,
      onOpen,
    });
    document.body.appendChild(node);
    const link = node.querySelector<HTMLAnchorElement>('#clip-result-link')!;
    expect(link).not.toBeNull();
    // A real anchor: openable in a new tab, copyable, keyboard-reachable.
    expect(link.getAttribute('href')).toBe('detail.html?type=asset&id=' + CHILD_ULID);
    link.click();
    expect(onOpen).toHaveBeenCalledWith(CHILD_ULID);
    expect(node.className).toContain('msg-success');
    expect(node.getAttribute('role')).toBe('status');
  });

  it('renders a non-ready child as an error, still linked for inspection (AC3)', () => {
    const node = buildClipResult(clipOutcome(readyChild({ status: 'failed' })), { href: '#x' });
    expect(node.className).toContain('msg-error');
    expect(node.className).not.toContain('msg-success');
    expect(node.textContent).toContain('not ready');
    expect(node.querySelector('#clip-result-link')).not.toBeNull();
  });

  it('renders a clip name as text, never as markup', () => {
    const node = buildClipResult(clipOutcome(readyChild({ name: '<img src=x onerror="alert(1)">' })), {});
    document.body.appendChild(node);
    expect(node.querySelector('img')).toBeNull();
    expect(node.textContent).toContain('<img src=x');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mount-level gating (no network)
// ─────────────────────────────────────────────────────────────────────────────

describe('clip control mounting', () => {
  let row: HTMLElement;

  beforeEach(() => {
    row = document.createElement('div');
    row.className = 'mt12 flex-gap';
    document.body.appendChild(row);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('offers no control at all to a role that cannot write', () => {
    const r = mountAssetClip({
      asset: sourceAsset(),
      actionsRow: row,
      canChange: false,
      apiFetch: vi.fn(),
      openModal: vi.fn(),
    });
    expect(r.button).toBeNull();
    expect(row.querySelectorAll('button')).toHaveLength(0);
  });

  it('offers no control for an asset with no stored source object', () => {
    // POST /:id/clip can only answer 409 no_object for it
    // (src/routes/assets.ts:5409, src/pipeline/source-object.ts:31-36).
    const r = mountAssetClip({
      asset: sourceAsset({ objectKey: undefined }),
      actionsRow: row,
      canChange: true,
      apiFetch: vi.fn(),
      openModal: vi.fn(),
    });
    expect(r.button).toBeNull();
    expect(row.querySelector('#btn-clip-asset')).toBeNull();
  });

  it('places the control in the existing action row, before the given anchor', () => {
    const anchor = document.createElement('button');
    anchor.id = 'btn-extract-meta';
    row.appendChild(anchor);

    mountAssetClip({
      asset: sourceAsset(),
      actionsRow: row,
      beforeEl: anchor,
      canChange: true,
      apiFetch: vi.fn(),
      openModal: vi.fn(),
    });

    const ids = Array.from(row.querySelectorAll('button')).map((b) => b.id);
    expect(ids).toEqual(['btn-clip-asset', 'btn-extract-meta']);
    expect(row.querySelector('#btn-clip-asset')!.className).toBe('btn-ghost');
  });

  // A host that re-renders on a timer (the standalone detail window, which
  // re-runs the whole body every DETAIL_POLL_INTERVAL_MS) cannot keep a link
  // around, so it follows the clip instead. The side panel, which is not
  // polled, keeps the link.
  describe('following the produced clip', () => {
    const run = async (navigateOnSuccess: boolean) => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const openAsset = vi.fn();
      mountAssetClip({
        asset: sourceAsset(),
        actionsRow: row,
        canChange: true,
        apiFetch: vi.fn(async () => readyChild()),
        openModal: (_title: string, build: (b: HTMLElement, close: () => void) => void) => {
          const b = document.createElement('div');
          document.body.appendChild(b);
          build(b, () => b.remove());
        },
        messageHost: () => host,
        openAsset,
        assetHref: (id: string) => 'detail.html?type=asset&id=' + id,
        navigateOnSuccess,
      });
      row.querySelector<HTMLButtonElement>('#btn-clip-asset')!.click();
      startField()!.value = '1';
      endField()!.value = '2';
      submitDialog();
      await settle(5);
      return { host, openAsset };
    };

    it('navigates when the host cannot keep the link', async () => {
      const { openAsset } = await run(true);
      expect(openAsset).toHaveBeenCalledWith(CHILD_ULID);
    });

    it('leaves the operator on the source asset otherwise, with the link', async () => {
      const { host, openAsset } = await run(false);
      expect(openAsset).not.toHaveBeenCalled();
      expect(host.querySelector('#clip-result-link')).not.toBeNull();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail view integration — the real renderer against a stubbed API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fixture server for one asset plus its clip route. `clip` decides what the
 * POST answers; everything else is the minimum the detail renderer fetches.
 */
function assetServer(clip?: { status?: number; body?: unknown; asset?: AssetDoc }) {
  const store = sourceAsset(clip?.asset);
  const clipBodies: Record<string, unknown>[] = [];
  const fetchSpy = vi.fn(async (url: string, opts?: RequestInit) => {
    const path = String(url);
    const method = (opts && opts.method) || 'GET';
    if (/\/clip$/.test(path) && method === 'POST') {
      clipBodies.push(JSON.parse(String(opts?.body || '{}')));
      const status = clip?.status ?? 201;
      return json(clip?.body ?? readyChild(), status);
    }
    if (/\/review-state$/.test(path)) {
      return json({ reviewState: 'draft', allowedTransitions: ['in-review'] });
    }
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(store);
    return json({});
  });
  return { fetchSpy, store, clipBodies };
}

async function settle(ticks = 40) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

const startField = () => document.querySelector<HTMLInputElement>('#clip-start-seconds');
const endField = () => document.querySelector<HTMLInputElement>('#clip-end-seconds');
const nameField = () => document.querySelector<HTMLInputElement>('#clip-output-name');

function dialogError(): string {
  const e = document.querySelector<HTMLElement>('#clip-dialog-error');
  return e && e.style.display !== 'none' ? e.textContent || '' : '';
}

function submitDialog() {
  document.querySelector<HTMLButtonElement>('#clip-submit')!.click();
}

function resultBlock(container: ParentNode) {
  return container.querySelector<HTMLElement>('#clip-result');
}

describe('asset detail — clip affordance (issue #793)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('mirrors the ADR-018 write gate: editor and admin only', () => {
    setClientRole('admin');
    expect(canClipAsset()).toBe(true);
    setClientRole('editor');
    expect(canClipAsset()).toBe(true);
    setClientRole('viewer');
    expect(canClipAsset()).toBe(false);
  });

  it('offers a Clip control on the detail view', async () => {
    const { fetchSpy } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const btn = container.querySelector<HTMLButtonElement>('#btn-clip-asset');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe(CLIP_COPY.btn);
    expect(btn!.type).toBe('button');
  });

  it('hides the control from a viewer instead of offering a guaranteed 403', async () => {
    setClientRole('viewer');
    const { fetchSpy } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(container.querySelector('#btn-clip-asset')).toBeNull();
  });

  it('bounds the dialog on the duration the asset actually reports (AC1)', async () => {
    const { fetchSpy } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-clip-asset')!.click();

    // technicalMetadata.durationSeconds, the same field the Duration row reads.
    expect(startField()!.max).toBe(String(DURATION));
    expect(endField()!.max).toBe(String(DURATION));
  });

  it('POSTs the ULID clip path with exactly the declared body', async () => {
    const { fetchSpy, clipBodies } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-clip-asset')!.click();
    startField()!.value = '10';
    endField()!.value = '20';
    nameField()!.value = 'teaser';
    submitDialog();
    await settle();

    const call = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST'
    )!;
    expect(call).toBeDefined();
    // The ULID, never the slug: the handler has no slug fallback.
    expect(String(call[0])).toBe('http://localhost:3000/api/v1/assets/' + ULID + '/clip');
    expect(clipBodies).toEqual([{ startSeconds: 10, endSeconds: 20, outputName: 'teaser' }]);
    // Shared apiFetch, not a bespoke call: bearer gate (#740), role mirror,
    // JSON content type.
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer ui-/);
    expect(headers['X-OVC-Role']).toBe('admin');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('links the produced child asset after a successful clip (AC2)', async () => {
    const { fetchSpy } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-clip-asset')!.click();
    startField()!.value = '10';
    endField()!.value = '20';
    submitDialog();
    await settle();

    // The dialog is gone and the outcome is on the pane.
    expect(startField()).toBeNull();
    const result = resultBlock(container)!;
    expect(result).not.toBeNull();
    expect(result.className).toContain('msg-success');
    expect(result.textContent).toContain('clip-10-20');

    const link = result.querySelector<HTMLAnchorElement>('#clip-result-link')!;
    expect(link.textContent).toBe(CLIP_COPY.btnOpen);
    // The link addresses the CHILD, by the id the 201 carried.
    expect(link.getAttribute('href')).toBe(detailWindowUrl('asset', CHILD_ULID));
    expect(link.getAttribute('href')).toContain(CHILD_ULID);
  });

  it('reports a failed clip as failed, with no link to a "ready" child (AC3)', async () => {
    // The honest 502 from the issue #786 fix: the pipeline marked the child
    // `failed` and rethrew, so there is no usable output.
    const { fetchSpy } = assetServer({
      status: 502,
      body: {
        error: 'clip_failed',
        message: 'clip output object "clips/x.mp4" not found in storage after the job reported success',
      },
    });
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-clip-asset')!.click();
    startField()!.value = '10';
    endField()!.value = '20';
    submitDialog();
    await settle();

    // Reported in the dialog, which stays open so the window can be retried.
    expect(dialogError()).toContain(CLIP_COPY.errJobFailed);
    expect(dialogError()).toContain('not found in storage');
    // Nothing anywhere claims a clip is available.
    expect(resultBlock(container)).toBeNull();
    expect(container.textContent).not.toContain(CLIP_COPY.btnOpen);
  });

  it('does not call a 201 child ready when the server says it is not (AC3)', async () => {
    const { fetchSpy } = assetServer({ body: readyChild({ status: 'failed' }) });
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-clip-asset')!.click();
    startField()!.value = '10';
    endField()!.value = '20';
    submitDialog();
    await settle();

    const result = resultBlock(container)!;
    expect(result.className).toContain('msg-error');
    expect(result.className).not.toContain('msg-success');
    expect(result.textContent).toContain('not ready');
  });

  it('refuses an out-of-range window locally, without a request (AC1)', async () => {
    const { fetchSpy, clipBodies } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-clip-asset')!.click();
    startField()!.value = '10';
    endField()!.value = String(DURATION + 30);
    submitDialog();
    await settle();

    expect(clipBodies).toEqual([]);
    expect(dialogError()).toBe(outsideDurationMessage(DURATION));
    // Still open, so the operator can fix the points they chose.
    expect(startField()).not.toBeNull();
    expect(startField()!.value).toBe('10');
  });

  it('refuses an out point that is not after the in point, locally (AC1)', async () => {
    const { fetchSpy, clipBodies } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-clip-asset')!.click();
    startField()!.value = '20';
    endField()!.value = '20';
    submitDialog();
    await settle();

    expect(clipBodies).toEqual([]);
    expect(dialogError()).toBe(CLIP_COPY.errOrder);
  });

  it('stops offering a control the deployment cannot serve (501)', async () => {
    const { fetchSpy } = assetServer({
      status: 501,
      body: { error: 'not_configured', message: 'clip extraction is not configured' },
    });
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-clip-asset')!.click();
    startField()!.value = '10';
    endField()!.value = '20';
    submitDialog();
    await settle();

    expect(resultBlock(container)!.textContent).toContain(CLIP_COPY.errNotConfigured);
    // Absent, not disabled — a control known to fail is not offered again.
    expect(container.querySelector('#btn-clip-asset')).toBeNull();
  });
});
