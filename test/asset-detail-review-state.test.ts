// @vitest-environment happy-dom
//
// Editorial review-state control on the asset detail view (issue #901, broken
// out of #792): the control offers EXACTLY the moves the API advertises, an
// illegal move is structurally impossible to initiate, and the review state is
// rendered distinctly from the lifecycle `status` badge (#134).
//
// The integration blocks drive the REAL detail renderer (renderAssetDetailBody —
// the same code path used by the asset side panel and the detached detail
// window) against a stubbed fetch.
//
// CONTRACT GROUNDING — every path, field, method and status below was read from
// this repo's generated spec and route source before the tests were written
// (CLAUDE.md rule 7), never from the issue text:
//
//   openapi.json .paths["/api/v1/assets/{id}/review-state"] — exactly two
//   operations, `get` and `post`.
//     .get.responses: exactly `200` and `404`. The 200 schema is
//       { reviewState: <enum>, allowedTransitions: <enum>[] },
//       required ["reviewState","allowedTransitions"],
//       additionalProperties: false; enum = draft|in-review|approved|rejected.
//       Source: src/routes/assets.ts:5437-5457, `reviewStateReadSchema` :223-241,
//       body from `asset.reviewState ?? 'draft'` + `allowedReviewTransitions()`.
//     .post.requestBody: required: true, application/json, schema
//       { reviewState: <enum> }, required ["reviewState"],
//       additionalProperties: false.
//     .post.responses: exactly `200` (the FULL asset), `404` and `422`.
//       Source: src/routes/assets.ts:5470-5484; the 422 body is
//       { error: 'invalid_review_transition', message } (:2663-2664, mapping
//       `InvalidReviewTransitionError`, src/data/asset-repo.ts:772-777).
//
//   The graph — `ALLOWED_REVIEW_TRANSITIONS` (src/data/asset-repo.ts:88-93),
//   read by both the 422 gate `isValidReviewTransition()` (:95-100) and
//   `allowedReviewTransitions()` (:114-116) which produces the advertised list:
//       draft      -> ['in-review']
//       in-review  -> ['approved','rejected']
//       approved   -> ['in-review']
//       rejected   -> ['in-review']
//   Nothing in the UI re-derives this: the table below is the FIXTURE the
//   stubbed API serves, and the assertions check the rendered controls against
//   what the fixture advertised — not against a client-side copy.
//   (docs/findings/review-state-contract-897.md §1 documents it in full,
//   including that no edge targets `draft` and that there is no direct
//   approved <-> rejected edge.)
//
//   Authorisation — `MATRIX` (src/auth/authorize.ts:54-58): viewer holds `read`
//   but not `write`; `methodToAction` (:79-93) maps GET->read, POST->write,
//   applied by `resourceAuthorizationPreHandler('asset')` (:126, registered
//   src/routes/assets.ts:1718). 403 code
//   `AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role'` (:99).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetDetailBody } from '../public/app.js';
import {
  REVIEW_COPY,
  REVIEW_STATE_LABEL,
  classifyReviewError,
  normaliseReviewRead,
  renderReviewBlock,
  reviewStateLabel,
  transitionLabel,
  transitionResultMessage,
} from '../public/review-state.js';

const ULID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';

// The server-side table, used ONLY to build fixtures (see grounding above).
const GRAPH: Record<string, string[]> = {
  draft: ['in-review'],
  'in-review': ['approved', 'rejected'],
  approved: ['in-review'],
  rejected: ['in-review'],
};
const ALL_STATES = Object.keys(GRAPH);

const ASSET = {
  id: ULID,
  name: 'promo-cut.mov',
  slug: 'promo-cut',
  status: 'ready',
  reviewState: 'in-review',
  statusHistory: [{ at: '2026-09-20T10:00:00.000Z', from: null, to: 'ready' }],
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

type ReviewRead = { reviewState: string; allowedTransitions: string[] };

/**
 * Route by path. `/review-state` is matched before the generic asset read.
 * `reviewGet` is a thunk so a test can change the served state mid-flight
 * (exactly what a transition does).
 */
function routedFetch(
  reviewGet: () => { status: number; body: unknown },
  reviewPost?: (target: string) => { status: number; body: unknown }
) {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const path = String(url);
    const method = (opts && opts.method) || 'GET';
    if (/\/review-state$/.test(path)) {
      if (method === 'POST') {
        const target = JSON.parse(String(opts?.body || '{}')).reviewState;
        const out = reviewPost
          ? reviewPost(target)
          : { status: 200, body: { ...ASSET, reviewState: target } };
        return json(out.body, out.status);
      }
      const out = reviewGet();
      return json(out.body, out.status);
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

const okRead = (state: string, allowed = GRAPH[state]): { status: number; body: ReviewRead } => ({
  status: 200,
  body: { reviewState: state, allowedTransitions: allowed },
});

async function settle(ticks = 30) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Every transition target the rendered block can originate a POST for. */
function offeredTargets(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('.review-transition')).map(
    (b) => b.getAttribute('data-target') || ''
  );
}

function blockText(container: ParentNode): string {
  const block = container.querySelector('#review-state');
  return ((block && block.textContent) || '').replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('review read normalisation (GET 200 shape)', () => {
  it('accepts the declared shape verbatim, preserving server order', () => {
    const r = normaliseReviewRead({ reviewState: 'in-review', allowedTransitions: ['approved', 'rejected'] });
    expect(r).toEqual({
      reviewState: 'in-review',
      allowedTransitions: ['approved', 'rejected'],
      usable: true,
    });
  });

  it('treats an EMPTY allowedTransitions as usable — the contract gives it a meaning', () => {
    // "May be empty, which means the state is terminal" (the property's own
    // description in openapi.json). Empty is not missing.
    const r = normaliseReviewRead({ reviewState: 'approved', allowedTransitions: [] });
    expect(r.usable).toBe(true);
    expect(r.allowedTransitions).toEqual([]);
  });

  it('is unusable when either required property is missing or malformed', () => {
    expect(normaliseReviewRead({ allowedTransitions: ['approved'] }).usable).toBe(false);
    expect(normaliseReviewRead({ reviewState: 'approved' }).usable).toBe(false);
    expect(normaliseReviewRead({ reviewState: '', allowedTransitions: [] }).usable).toBe(false);
    expect(normaliseReviewRead(null).usable).toBe(false);
    expect(normaliseReviewRead(undefined).usable).toBe(false);
  });

  it('never invents a move the server did not advertise', () => {
    const r = normaliseReviewRead({ reviewState: 'draft', allowedTransitions: ['in-review'] });
    expect(r.allowedTransitions).toEqual(['in-review']);
    // Not approved, not rejected, and never `draft` back to itself.
    expect(r.allowedTransitions).not.toContain('approved');
    expect(r.allowedTransitions).not.toContain('rejected');
  });

  it('drops the current state and non-string entries', () => {
    // The contract says the current state is never listed (a self-POST is an
    // idempotent no-op, not a move). If one ever appeared, it must not become a
    // button that changes nothing.
    const r = normaliseReviewRead({
      reviewState: 'in-review',
      allowedTransitions: ['in-review', 'approved', 7, null, '', 'rejected'],
    });
    expect(r.allowedTransitions).toEqual(['approved', 'rejected']);
  });

  it('passes through a state this build does not recognise', () => {
    // The API owns the vocabulary; an unknown state is still a real state.
    const r = normaliseReviewRead({ reviewState: 'embargoed', allowedTransitions: ['in-review'] });
    expect(r.usable).toBe(true);
    expect(r.reviewState).toBe('embargoed');
    expect(reviewStateLabel('embargoed')).toBe('embargoed');
  });
});

describe('transition labels (presentation only)', () => {
  it('names each real move in editorial language', () => {
    expect(transitionLabel('draft', 'in-review')).toBe('Submit for review');
    expect(transitionLabel('in-review', 'approved')).toBe('Approve');
    expect(transitionLabel('in-review', 'rejected')).toBe('Reject');
    expect(transitionLabel('rejected', 'in-review')).toBe('Resubmit for review');
    // `approved` is not terminal: the way back is in-review, never draft
    // (docs/findings/review-state-contract-897.md §1).
    expect(transitionLabel('approved', 'in-review')).toBe('Re-open for review');
  });

  it('labels an unknown target rather than suppressing it', () => {
    // The label map must never act as a second gate: a move the API grows later
    // still gets a control.
    expect(transitionLabel('approved', 'embargoed')).toBe('Move to “embargoed”');
  });

  it('reports the outcome with the new state', () => {
    expect(transitionResultMessage('approved')).toBe('Review state is now “Approved”.');
  });

  it('uses the API vocabulary for its labels', () => {
    expect(Object.keys(REVIEW_STATE_LABEL).sort()).toEqual(ALL_STATES.slice().sort());
  });
});

describe('review error classification', () => {
  it('maps a 422 to "stale" and asks for a re-read', () => {
    // The only moves this UI can send are ones the API advertised, so a 422 can
    // only mean the state changed underneath the panel.
    const c = classifyReviewError({
      status: 422,
      body: { error: 'invalid_review_transition', message: 'invalid review-state transition: approved -> rejected' },
    });
    expect(c.kind).toBe('stale');
    expect(c.refresh).toBe(true);
    expect(c.message).toBe(REVIEW_COPY.errStale);
    // The raw machine code is never shown to the operator.
    expect(c.message).not.toMatch(/invalid_review_transition/);
  });

  it('maps 403/401 to the role sentence and 404 to the gone sentence', () => {
    expect(classifyReviewError({ status: 403 }).message).toBe(REVIEW_COPY.errForbidden);
    expect(classifyReviewError({ status: 401 }).kind).toBe('forbidden');
    expect(classifyReviewError({ status: 404 }).message).toBe(REVIEW_COPY.errNotFound);
  });

  it('reports a transport failure as "nothing changed"', () => {
    const c = classifyReviewError(new Error('fetch failed') as never);
    expect(c.kind).toBe('other');
    expect(c.message).toBe(REVIEW_COPY.errNetwork);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The gate: only legal moves are representable
// ─────────────────────────────────────────────────────────────────────────────

describe('transition control offers exactly the advertised moves', () => {
  it.each(ALL_STATES)('from %s, offers the advertised set and nothing else', (state) => {
    const read = normaliseReviewRead({ reviewState: state, allowedTransitions: GRAPH[state] });
    const { block } = renderReviewBlock(read, { canChange: true });

    expect(offeredTargets(block)).toEqual(GRAPH[state]);

    // Every state NOT advertised from here — including the current state itself
    // and `draft`, which no edge targets — has no control of any kind.
    ALL_STATES.filter((s) => GRAPH[state].indexOf(s) === -1).forEach((illegal) => {
      expect(block.querySelector('[data-target="' + illegal + '"]')).toBeNull();
      expect(block.querySelector('#btn-review-' + illegal)).toBeNull();
    });
  });

  it('gives an illegal move no input to originate from at all', () => {
    // Structural, not advisory: no picker, no free-text field, no disabled
    // buttons for illegal moves — the control set IS the allowed set.
    const read = normaliseReviewRead({ reviewState: 'approved', allowedTransitions: ['in-review'] });
    const { block } = renderReviewBlock(read, { canChange: true });

    expect(block.querySelector('select')).toBeNull();
    expect(block.querySelector('input')).toBeNull();
    expect(block.querySelector('textarea')).toBeNull();
    expect(block.querySelectorAll('.review-transition')).toHaveLength(1);
    // Not "present but disabled" — absent.
    expect(
      Array.from(block.querySelectorAll('button')).filter((b) => (b as HTMLButtonElement).disabled)
    ).toHaveLength(0);
  });

  it('offers a target the server advertises even when this build cannot label it', () => {
    const read = normaliseReviewRead({ reviewState: 'approved', allowedTransitions: ['embargoed'] });
    const { block } = renderReviewBlock(read, { canChange: true });
    expect(offeredTargets(block)).toEqual(['embargoed']);
  });

  it('offers nothing, and says so, for a terminal state', () => {
    const read = normaliseReviewRead({ reviewState: 'approved', allowedTransitions: [] });
    const { block } = renderReviewBlock(read, { canChange: true });
    expect(offeredTargets(block)).toEqual([]);
    expect(block.textContent).toContain(REVIEW_COPY.terminal);
  });

  it('offers nothing when the read is unusable, rather than guessing a state', () => {
    const { block } = renderReviewBlock(normaliseReviewRead({}), { canChange: true });
    expect(offeredTargets(block)).toEqual([]);
    expect(block.textContent).toContain(REVIEW_COPY.unavailable);
  });

  it('shows the state read-only for a role that cannot write', () => {
    const read = normaliseReviewRead({ reviewState: 'in-review', allowedTransitions: GRAPH['in-review'] });
    const { block } = renderReviewBlock(read, { canChange: false });
    expect(offeredTargets(block)).toEqual([]);
    expect(block.textContent).toContain(REVIEW_COPY.readOnly);
    // The state itself stays visible: a viewer holds `read` on this sub-resource.
    expect(block.querySelector('.review-badge')?.textContent).toBe('In review');
  });

  it('associates each control with the state text (WCAG 1.3.1) and groups them', () => {
    const read = normaliseReviewRead({ reviewState: 'in-review', allowedTransitions: GRAPH['in-review'] });
    const { block } = renderReviewBlock(read, { canChange: true });
    const group = block.querySelector('#review-actions')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Review state transitions');
    block.querySelectorAll('.review-transition').forEach((b) => {
      expect(b.getAttribute('aria-describedby')).toBe('review-state-note');
      expect((b as HTMLButtonElement).type).toBe('button');
    });
    // Outcomes are announced without moving focus.
    expect(block.querySelector('#review-msg')?.getAttribute('aria-live')).toBe('polite');
  });

  it('renders an unrecognised state as text, never as markup', () => {
    const nasty = '<img src=x onerror="alert(1)">';
    const { block } = renderReviewBlock(
      normaliseReviewRead({ reviewState: nasty, allowedTransitions: [nasty] }),
      { canChange: true }
    );
    document.body.appendChild(block);
    try {
      expect(block.querySelector('img')).toBeNull();
      expect(block.textContent).toContain(nasty);
    } finally {
      block.remove();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail view integration
// ─────────────────────────────────────────────────────────────────────────────

describe('asset detail — editorial review block (issue #901)', () => {
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

  it('reads the sub-resource, not the asset field, and renders the advertised moves', async () => {
    const fetchSpy = routedFetch(() => okRead('in-review'));
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.endsWith('/assets/' + ULID + '/review-state'))).toBe(true);

    expect(blockText(container)).toContain(REVIEW_COPY.heading);
    expect(offeredTargets(container)).toEqual(['approved', 'rejected']);
    expect(container.querySelector('#btn-review-approved')?.textContent).toBe('Approve');
    expect(container.querySelector('#btn-review-rejected')?.textContent).toBe('Reject');
  });

  it('gates on the API answer even when the asset field disagrees', async () => {
    // The asset read carries `reviewState: 'in-review'` (ASSET), but the
    // sub-resource is the only thing that carries the graph. If the UI were
    // deriving moves from the asset field it would offer approve/reject here.
    const fetchSpy = routedFetch(() => okRead('approved', ['in-review']));
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(offeredTargets(container)).toEqual(['in-review']);
    expect(container.querySelector('#btn-review-approved')).toBeNull();
    expect(container.querySelector('#btn-review-rejected')).toBeNull();
    expect(container.querySelector('.review-badge')?.textContent).toBe('Approved');
  });

  it('renders the review state distinctly from the lifecycle status badge (#134)', async () => {
    vi.stubGlobal('fetch', routedFetch(() => okRead('in-review')));

    await renderAssetDetailBody(ULID, container);
    await settle();

    const lifecycle = container.querySelector('.badge')!;
    const review = container.querySelector('.review-badge')!;
    expect(lifecycle.textContent).toBe('ready');
    expect(review.textContent).toBe('In review');

    // Different element families: the review badge is not a member of the
    // lifecycle `.badge` palette, and the lifecycle badge is not a review badge.
    expect(review.classList.contains('badge')).toBe(false);
    expect(lifecycle.classList.contains('review-badge')).toBe(false);
    // The two axes live in different blocks, and the review one is labelled and
    // says outright that it is a separate axis — so the distinction survives
    // monochrome rendering (WCAG 1.4.1).
    expect(container.querySelector('#review-state')!.contains(lifecycle)).toBe(false);
    expect(blockText(container)).toContain(REVIEW_COPY.stateKey);
    expect(blockText(container)).toContain(REVIEW_COPY.axisNote);
    // The lifecycle vocabulary never appears as a review move, and vice versa.
    expect(offeredTargets(container)).not.toContain('archived');
  });

  it('posts exactly the declared body, then re-reads the new legal set', async () => {
    let state = 'in-review';
    const fetchSpy = routedFetch(
      () => okRead(state),
      (target) => {
        state = target;
        return { status: 200, body: { ...ASSET, reviewState: target } };
      }
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLButtonElement>('#btn-review-approved')!.click();
    await settle();

    const post = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(String(post[0])).toMatch(/\/assets\/01J8ZZZZZZZZZZZZZZZZZZZZZZ\/review-state$/);
    // The one declared property, and only it (additionalProperties: false).
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ reviewState: 'approved' });

    // The set is re-read from the API, never recomputed locally: from
    // `approved` the only advertised move is back to `in-review`.
    expect(container.querySelector('.review-badge')?.textContent).toBe('Approved');
    expect(offeredTargets(container)).toEqual(['in-review']);
    expect(container.querySelector('#btn-review-approved')).toBeNull();
    expect(container.querySelector('#btn-review-rejected')).toBeNull();
    expect(blockText(container)).toContain('Review state is now “Approved”.');
    // A GET on the sub-resource followed the POST.
    const order = fetchSpy.mock.calls.map((c) => ((c[1] as RequestInit | undefined)?.method || 'GET') + ' ' + String(c[0]));
    const postIdx = order.findIndex((o) => o.startsWith('POST'));
    expect(order.slice(postIdx + 1).some((o) => o.startsWith('GET') && o.endsWith('/review-state'))).toBe(true);
  });

  it('recovers from a 422 by re-reading rather than blaming the operator', async () => {
    // A move that was advertised at load but is no longer legal (someone else
    // moved the asset). The UI cannot prevent this race; it must not leave the
    // panel claiming a stale set.
    let state = 'in-review';
    const fetchSpy = routedFetch(
      () => okRead(state),
      () => {
        state = 'approved';
        return {
          status: 422,
          body: {
            error: 'invalid_review_transition',
            message: 'invalid review-state transition: approved -> rejected',
          },
        };
      }
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLButtonElement>('#btn-review-rejected')!.click();
    await settle();

    expect(blockText(container)).toContain(REVIEW_COPY.errStale);
    // Re-read: the panel now shows the real state and its real moves.
    expect(container.querySelector('.review-badge')?.textContent).toBe('Approved');
    expect(offeredTargets(container)).toEqual(['in-review']);
  });

  it('retires the controls on a 403 instead of inviting a guaranteed failure', async () => {
    const fetchSpy = routedFetch(
      () => okRead('in-review'),
      () => ({
        status: 403,
        body: {
          error: 'forbidden_insufficient_role',
          message: 'role viewer may not write asset',
          action: 'write',
          resourceType: 'asset',
          role: 'viewer',
        },
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLButtonElement>('#btn-review-approved')!.click();
    await settle();

    expect(blockText(container)).toContain(REVIEW_COPY.errForbidden);
    expect(offeredTargets(container)).toEqual([]);
    // The observability fields of the 403 body are never shown.
    expect(blockText(container)).not.toMatch(/forbidden_insufficient_role|resourceType/);
  });

  it('offers no controls to a viewer, and still shows the state', async () => {
    localStorage.setItem('ovc_role', 'viewer');
    vi.stubGlobal('fetch', routedFetch(() => okRead('in-review')));

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(offeredTargets(container)).toEqual([]);
    expect(blockText(container)).toContain(REVIEW_COPY.readOnly);
    expect(container.querySelector('.review-badge')?.textContent).toBe('In review');
  });

  it('keeps the rest of the panel intact when the review read fails', async () => {
    vi.stubGlobal('fetch', routedFetch(() => ({ status: 404, body: { error: 'not_found' } })));

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(blockText(container)).toContain(REVIEW_COPY.unavailable);
    expect(offeredTargets(container)).toEqual([]);
    // The lifecycle side of the panel is untouched.
    expect(container.querySelector('.badge')?.textContent).toBe('ready');
    expect(container.querySelector('#delete-protection')).not.toBeNull();
  });
});
