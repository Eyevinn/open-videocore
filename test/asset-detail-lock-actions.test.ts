// @vitest-environment happy-dom
//
// Lock / unlock actions on the asset detail view (issue #895), implementing
// docs/ux/asset-lock-state-spec.md §4 and the parts of its §10 acceptance
// checklist that belong to the detail surface.
//
// The integration blocks drive the REAL detail renderer (renderAssetDetailBody —
// the same code path used by both the asset side panel and the detached detail
// window) against a stubbed fetch.
//
// CONTRACT GROUNDING — every field name, path, method and status below was read
// from this repo's generated spec and route source before the tests were
// written (CLAUDE.md rule 7), never from the issue text:
//
//   openapi.json .paths["/api/v1/assets/{id}/lock"] — exactly two operations,
//   `put` and `delete` (there is no POST).
//     .put.requestBody: required: true, application/json, schema
//       { reason?: string (maxLength 1024), lockedBy?: string (maxLength 256) },
//       additionalProperties: false, default {}.
//     .put.parameters / .delete.parameters: one path param `id` (string,
//       required). No query parameters on either.
//     .put.responses / .delete.responses: exactly `200` and `404`. The 200 body
//       is the FULL asset; the 404 body is { error: string, message?: string }.
//     Source of truth: src/routes/assets.ts:5575-5601 (PUT) and :5609-5623
//     (DELETE), both `response: { 200: assetSchema, 404: errorSchema }`.
//
//   The lock object on the detail read this view renders from:
//     openapi.json .paths["/api/v1/assets/{id}"].get.responses["200"]
//       .content["application/json"].schema.properties.deleteLock
//     = { locked: boolean, reason?: string, lockedAt: string, lockedBy?: string },
//       required ["locked","lockedAt"], additionalProperties: false.
//     Source: `deleteLockSchema` src/routes/assets.ts:528, `assetSchema.deleteLock`
//     :838; TS type `DeleteLock` src/data/asset-repo.ts:441.
//
//   Unlock REMOVES the field (`deleteLock: undefined`, applyDeleteLock
//   src/data/asset-repo.ts:1083-1086) rather than writing `locked: false`, so the
//   post-unlock fixture below omits it entirely — exactly what the API returns.
//
//   Authorisation: the ADR-018 role×action matrix `MATRIX`
//   (src/auth/authorize.ts:54-58) — viewer { read: true, write: false,
//   delete: false }, editor/admin all true — applied by
//   `resourceAuthorizationPreHandler('asset')` (:126, registered
//   src/routes/assets.ts:1718) with `methodToAction` (:79-93) mapping PUT→write
//   and DELETE→delete. Failure is 403 with
//   `AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role'` (:99). There is no
//   scope/claim model and no capability endpoint in this API.
//
//   PROVENANCE: the issue's "records the provenance entry format" criterion has
//   no client-side contract to test against. `applyDeleteLock` appends the entry
//   itself, server-side — { at, by: 'user', op: 'lock', detail: input.reason }
//   (src/data/asset-repo.ts:1076-1080) and { at, by: 'user', op: 'unlock' }
//   (:1085) — and NOTHING reads it back: `provenance` is not among the
//   GET /api/v1/assets/{id} 200 properties, and neither lock handler emits an
//   audit entry (spec §9, gaps H4/H5). The only client-controllable part is the
//   optional `reason`, which becomes `detail`; the request-body assertions below
//   are therefore the whole of what the contract supports.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetDetailBody } from '../public/app.js';
import {
  LOCK_DETAIL_COPY,
  LOCKED_BY_MAX,
  REASON_MAX,
  classifyLockError,
  lockRequestBody,
  lockStatusLines,
  renderLockBlock,
} from '../public/lock-detail.js';

const ULID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';
const LOCKED_AT = '2026-09-28T11:22:33.000Z';

// Free operator text carrying markup: `reason` and `lockedBy` are caller-chosen
// strings (<=1024 / <=256 chars) and must never reach innerHTML.
const NASTY_REASON = 'Legal hold <img src=x onerror="alert(1)"> & "quoted"';
const NASTY_BY = 'ops <script>alert(2)</script>';

const UNLOCKED_ASSET = {
  id: ULID,
  name: 'promo-cut.mov',
  slug: 'promo-cut',
  status: 'ready',
  statusHistory: [{ at: '2026-09-20T10:00:00.000Z', from: null, to: 'ready' }],
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
};

const LOCKED_ASSET = {
  ...UNLOCKED_ASSET,
  deleteLock: {
    locked: true,
    reason: NASTY_REASON,
    lockedAt: LOCKED_AT,
    lockedBy: NASTY_BY,
  },
  updatedAt: LOCKED_AT,
};

type Outcome = { status: number; body: unknown };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// Route by path; the lock sub-resource is matched before the generic asset read.
function routedFetch(currentAsset: () => unknown, lock?: (method: string) => Outcome) {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const path = String(url);
    const method = (opts && opts.method) || 'GET';
    if (/\/lock$/.test(path)) {
      const out = lock ? lock(method) : { status: 200, body: currentAsset() };
      return json(out.body, out.status);
    }
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(currentAsset());
    return json({}, 200);
  });
}

async function settle(ticks = 25) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function blockText(container: HTMLElement): string {
  const block = container.querySelector('#delete-protection');
  return ((block && block.textContent) || '').replace(/\s+/g, ' ').trim();
}

function modal() {
  return document.querySelector('.modal-backdrop');
}

function closeAnyModal() {
  document.querySelectorAll('.modal-backdrop').forEach((n) => n.remove());
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('lock request body (spec §4.3, gap H7)', () => {
  it('is always an object, `{}` when both optional fields are blank', () => {
    // requestBody.required is true even though every property is optional, so a
    // body-less PUT is a 400 before the handler runs.
    expect(lockRequestBody({ reason: '', lockedBy: '' })).toEqual({});
    expect(lockRequestBody({ reason: '   ', lockedBy: '\n\t' })).toEqual({});
    expect(lockRequestBody(undefined as never)).toEqual({});
  });

  it('omits a blank field rather than sending an empty string', () => {
    expect(lockRequestBody({ reason: 'contract retention', lockedBy: '' })).toEqual({
      reason: 'contract retention',
    });
    expect(lockRequestBody({ reason: '', lockedBy: 'legal' })).toEqual({ lockedBy: 'legal' });
  });

  it('sends only the two properties the schema declares', () => {
    const body = lockRequestBody({ reason: ' r ', lockedBy: ' b ' });
    expect(Object.keys(body).sort()).toEqual(['lockedBy', 'reason']);
    expect(body).toEqual({ reason: 'r', lockedBy: 'b' });
  });

  it('mirrors the server-enforced caps', () => {
    expect(REASON_MAX).toBe(1024);
    expect(LOCKED_BY_MAX).toBe(256);
  });
});

describe('locked status lines (spec §4.2)', () => {
  const fmt = (v: string) => 'FMT(' + v + ')';

  it('names the actor when `lockedBy` is present', () => {
    const lines = lockStatusLines(
      { locked: true, lockedAt: LOCKED_AT, lockedBy: 'legal', reason: 'why' },
      fmt
    );
    expect(lines.statusLine).toBe('Locked by legal on FMT(' + LOCKED_AT + ').');
    expect(lines.reasonLine).toBe('Reason: why');
  });

  it('never substitutes a placeholder actor when `lockedBy` is absent', () => {
    const lines = lockStatusLines({ locked: true, lockedAt: LOCKED_AT }, fmt);
    expect(lines.statusLine).toBe('Locked on FMT(' + LOCKED_AT + ').');
    expect(lines.statusLine).not.toMatch(/unknown|user|owner|someone/i);
    expect(lines.reasonLine).toBe(LOCK_DETAIL_COPY.reasonNone);
    expect(lines.reasonIsValue).toBe(false);
  });

  it('formats the timestamp through the app formatter, and states no relative age', () => {
    // Spec §1 rule 4: render through fmtDate, never raw ISO-8601, and never as
    // a relative age — there is no server clock to calibrate against.
    const spy = vi.fn(() => '29/09/2026, 11:22:33');
    const lines = lockStatusLines({ locked: true, lockedAt: LOCKED_AT }, spy);
    expect(spy).toHaveBeenCalledWith(LOCKED_AT);
    expect(lines.statusLine).toBe('Locked on 29/09/2026, 11:22:33.');
    expect(lines.statusLine).not.toMatch(/ago|hours?|days?/i);
  });
});

describe('lock error classification (spec §4.4)', () => {
  it('maps 403 to the role sentence', () => {
    const c = classifyLockError({ status: 403, body: { error: 'forbidden_insufficient_role' } });
    expect(c.kind).toBe('forbidden');
    expect(c.message).toBe(LOCK_DETAIL_COPY.errForbidden);
    // The raw action/resourceType/role observability fields are never shown.
    expect(c.message).not.toMatch(/resourceType|forbidden_insufficient_role/);
  });

  it('maps 404 to the gone sentence', () => {
    expect(classifyLockError({ status: 404, body: { error: 'not_found' } })).toEqual({
      kind: 'not-found',
      field: null,
      message: LOCK_DETAIL_COPY.errNotFound,
    });
  });

  it('parses the Fastify validation envelope defensively and names the field', () => {
    // The 400 arrives as { statusCode, code, error, message }, NOT the API's
    // { error, message? } — neither status is declared in openapi.json (gap H3).
    const reason = classifyLockError({
      status: 400,
      message: 'body/reason String must contain at most 1024 character(s)',
      body: {
        statusCode: 400,
        code: 'FST_ERR_VALIDATION',
        error: 'Bad Request',
        message: 'body/reason String must contain at most 1024 character(s)',
      },
    });
    expect(reason).toEqual({
      kind: 'too-long',
      field: 'reason',
      message: LOCK_DETAIL_COPY.errReasonLong,
    });

    const by = classifyLockError({
      status: 400,
      body: { message: 'body/lockedBy String must contain at most 256 character(s)' },
    });
    expect(by.field).toBe('lockedBy');
    expect(by.message).toBe(LOCK_DETAIL_COPY.errLockedByLong);
  });

  it('does not guess a field for an unattributable 400', () => {
    const c = classifyLockError({ status: 400, body: { message: 'body must be object' } });
    expect(c.field).toBeNull();
  });

  it('reports a transport failure as "nothing changed"', () => {
    const c = classifyLockError(new Error('fetch failed') as never);
    expect(c.kind).toBe('other');
    expect(c.message).toBe(LOCK_DETAIL_COPY.errNetwork);
  });
});

describe('lock block rendering (spec §4.2)', () => {
  it('renders free operator text as text, never as markup', () => {
    const { block } = renderLockBlock(LOCKED_ASSET, { fmtDate: (v: string) => v });
    document.body.appendChild(block);
    try {
      expect(block.querySelector('img')).toBeNull();
      expect(block.querySelector('script')).toBeNull();
      expect(block.textContent).toContain(NASTY_REASON);
      expect(block.textContent).toContain(NASTY_BY);
      // The full, unclamped value stays reachable in the tooltip.
      expect(block.querySelector('.lock-reason')?.getAttribute('title')).toBe(NASTY_REASON);
    } finally {
      block.remove();
    }
  });

  it('treats a projection without the field as unknown, not unlocked', () => {
    // L0: absence of the field FROM THE PROJECTION is not evidence of anything.
    const { block, state } = renderLockBlock(
      { id: ULID, name: 'from-search.mov' },
      { fmtDate: (v: string) => v, projectionCarriesLock: false }
    );
    expect(state).toBe('unknown');
    expect(block.textContent).toContain(LOCK_DETAIL_COPY.unavailable);
    expect(block.textContent).not.toContain(LOCK_DETAIL_COPY.unlocked);
  });

  it('treats `locked: false` as unlocked and hides its lock metadata', () => {
    // The schema permits { locked: false, lockedAt }, and no code path may read
    // `deleteLock.locked === false` or `'deleteLock' in asset` (spec §2).
    const { block, state } = renderLockBlock(
      { id: ULID, deleteLock: { locked: false, lockedAt: LOCKED_AT, reason: 'stale' } },
      { fmtDate: (v: string) => v }
    );
    expect(state).toBe('unlocked');
    expect(block.textContent).toContain(LOCK_DETAIL_COPY.unlocked);
    expect(block.textContent).not.toContain('stale');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail view integration
// ─────────────────────────────────────────────────────────────────────────────

describe('asset detail — delete-protection block (issue #895)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    closeAnyModal();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the block and a Lock control for an unlocked asset', async () => {
    vi.stubGlobal('fetch', routedFetch(() => UNLOCKED_ASSET));

    await renderAssetDetailBody(ULID, container);

    expect(blockText(container)).toContain(LOCK_DETAIL_COPY.heading);
    expect(blockText(container)).toContain(LOCK_DETAIL_COPY.unlocked);

    const lockBtn = container.querySelector<HTMLButtonElement>('#btn-lock-asset');
    expect(lockBtn).not.toBeNull();
    expect(lockBtn?.textContent).toBe(LOCK_DETAIL_COPY.btnLock);
    // The control is programmatically associated with the state text (WCAG 1.3.1).
    expect(lockBtn?.getAttribute('aria-describedby')).toBe('lock-state-note');
    expect(container.querySelector('#btn-unlock-asset')).toBeNull();
    expect(container.querySelector('#btn-edit-lock-note')).toBeNull();
    // Lock sits before the always-present actions because it gates the
    // destructive one (spec §4.1).
    const row = lockBtn!.parentElement!;
    const ids = Array.from(row.children).map((c) => c.id);
    expect(ids.indexOf('btn-lock-asset')).toBeLessThan(ids.indexOf('btn-extract-meta'));
  });

  it('shows owner, timestamp and reason for a locked asset, with Unlock', async () => {
    vi.stubGlobal('fetch', routedFetch(() => LOCKED_ASSET));

    await renderAssetDetailBody(ULID, container);

    const text = blockText(container);
    expect(text).toContain('Locked by ' + NASTY_BY);
    expect(text).toContain(new Date(LOCKED_AT).toLocaleString());
    expect(text).toContain('Reason: ' + NASTY_REASON);
    expect(text).toContain(LOCK_DETAIL_COPY.consequence);
    // Asset-controlled text never becomes markup.
    expect(container.querySelector('#delete-protection img')).toBeNull();
    expect(container.querySelector('#delete-protection script')).toBeNull();

    expect(container.querySelector('#btn-unlock-asset')?.textContent).toBe(
      LOCK_DETAIL_COPY.btnUnlock
    );
    expect(container.querySelector('#btn-edit-lock-note')?.textContent).toBe(
      LOCK_DETAIL_COPY.btnEdit
    );
    expect(container.querySelector('#btn-lock-asset')).toBeNull();
  });

  it('announces action outcomes politely', async () => {
    vi.stubGlobal('fetch', routedFetch(() => UNLOCKED_ASSET));
    await renderAssetDetailBody(ULID, container);
    expect(container.querySelector('#action-msg')?.getAttribute('aria-live')).toBe('polite');
  });

  it('offers no lock controls to a role the matrix forbids', async () => {
    // viewer holds neither `write` (PUT) nor `delete` (DELETE) on an asset
    // (src/auth/authorize.ts:54-58), so the control would be a guaranteed 403.
    localStorage.setItem('ovc_role', 'viewer');
    vi.stubGlobal('fetch', routedFetch(() => LOCKED_ASSET));

    await renderAssetDetailBody(ULID, container);

    expect(container.querySelector('#btn-lock-asset')).toBeNull();
    expect(container.querySelector('#btn-unlock-asset')).toBeNull();
    expect(container.querySelector('#btn-edit-lock-note')).toBeNull();
    // The state itself is still shown — viewer holds `read`.
    expect(blockText(container)).toContain('Locked by ' + NASTY_BY);
    expect(container.querySelector('#lock-role-note')?.textContent).toBe(
      LOCK_DETAIL_COPY.errForbidden
    );
  });
});

describe('asset detail — setting the lock (issue #895)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    closeAnyModal();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('PUTs the documented body to the documented route and re-renders from the response', async () => {
    let locked = false;
    const fetchSpy = routedFetch(
      () => (locked ? LOCKED_ASSET : UNLOCKED_ASSET),
      () => {
        locked = true;
        return { status: 200, body: LOCKED_ASSET };
      }
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    container.querySelector<HTMLButtonElement>('#btn-lock-asset')!.click();

    expect(modal()).not.toBeNull();
    const reason = document.querySelector<HTMLTextAreaElement>('#lock-reason')!;
    const by = document.querySelector<HTMLInputElement>('#lock-locked-by')!;
    expect(reason.maxLength).toBe(REASON_MAX);
    expect(by.maxLength).toBe(LOCKED_BY_MAX);
    reason.value = '  contract retention  ';
    by.value = 'legal';
    document.querySelector<HTMLButtonElement>('#lock-submit')!.click();
    await settle();

    const call = fetchSpy.mock.calls.find(([u]) => /\/lock$/.test(String(u)));
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit];
    expect(String(url)).toContain('/assets/' + ULID + '/lock');
    expect(String(url)).not.toContain('?');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      reason: 'contract retention',
      lockedBy: 'legal',
    });

    // The dialog closes and the view is re-read from the API: the
    // server-generated `lockedAt` is only knowable that way.
    expect(modal()).toBeNull();
    expect(blockText(container)).toContain('Locked by ' + NASTY_BY);
    expect(blockText(container)).toContain(new Date(LOCKED_AT).toLocaleString());
    expect(container.querySelector('#action-msg')?.textContent).toContain(
      LOCK_DETAIL_COPY.resultLocked
    );
  });

  it('sends `{}` when both optional fields are left blank (gap H7)', async () => {
    let locked = false;
    const fetchSpy = routedFetch(
      () => (locked ? LOCKED_ASSET : UNLOCKED_ASSET),
      () => {
        locked = true;
        return { status: 200, body: LOCKED_ASSET };
      }
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    container.querySelector<HTMLButtonElement>('#btn-lock-asset')!.click();
    document.querySelector<HTMLButtonElement>('#lock-submit')!.click();
    await settle();

    const call = fetchSpy.mock.calls.find(([u]) => /\/lock$/.test(String(u)))!;
    expect(String(call[1]!.body)).toBe('{}');
  });

  it('prefills the edit dialog and warns that saving overwrites the lock', async () => {
    vi.stubGlobal('fetch', routedFetch(() => LOCKED_ASSET));

    await renderAssetDetailBody(ULID, container);
    container.querySelector<HTMLButtonElement>('#btn-edit-lock-note')!.click();

    expect(document.querySelector<HTMLTextAreaElement>('#lock-reason')!.value).toBe(NASTY_REASON);
    expect(document.querySelector<HTMLInputElement>('#lock-locked-by')!.value).toBe(NASTY_BY);
    // Re-lock is an unconditional overwrite (applyDeleteLock,
    // src/data/asset-repo.ts:1062-1087), so the operator is told before saving.
    expect(document.querySelector('#lock-edit-warning')?.textContent).toBe(
      LOCK_DETAIL_COPY.dialogEditWarning
    );
  });

  it('keeps the dialog open and explains a 403 inline, then retires the control', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch(
        () => UNLOCKED_ASSET,
        () => ({
          status: 403,
          body: {
            error: 'forbidden_insufficient_role',
            message: "role 'viewer' may not write a asset",
            action: 'write',
            resourceType: 'asset',
            role: 'viewer',
          },
        })
      )
    );

    await renderAssetDetailBody(ULID, container);
    container.querySelector<HTMLButtonElement>('#btn-lock-asset')!.click();
    document.querySelector<HTMLButtonElement>('#lock-submit')!.click();
    await settle();

    expect(modal()).not.toBeNull();
    const err = document.querySelector('#lock-dialog-error')!;
    expect(err.textContent).toBe(LOCK_DETAIL_COPY.errForbidden);
    expect(err.getAttribute('role')).toBe('alert');
    // Never the raw observability fields.
    expect(err.textContent).not.toContain('resourceType');
    // A control known to fail stops being offered for this view of the asset.
    expect(container.querySelector('#btn-lock-asset')).toBeNull();
    // The button never stays in its pending state.
    expect(document.querySelector<HTMLButtonElement>('#lock-submit')!.disabled).toBe(false);
  });

  it('keeps the dialog open and marks the offending field on a 400', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch(
        () => UNLOCKED_ASSET,
        () => ({
          status: 400,
          body: {
            statusCode: 400,
            code: 'FST_ERR_VALIDATION',
            error: 'Bad Request',
            message: 'body/reason String must contain at most 1024 character(s)',
          },
        })
      )
    );

    await renderAssetDetailBody(ULID, container);
    container.querySelector<HTMLButtonElement>('#btn-lock-asset')!.click();
    document.querySelector<HTMLTextAreaElement>('#lock-reason')!.value = 'x';
    document.querySelector<HTMLButtonElement>('#lock-submit')!.click();
    await settle();

    expect(modal()).not.toBeNull();
    expect(document.querySelector('#lock-dialog-error')!.textContent).toBe(
      LOCK_DETAIL_COPY.errReasonLong
    );
    // Not an alert() and not a closed dialog: the typed text survives.
    expect(document.querySelector<HTMLTextAreaElement>('#lock-reason')!.value).toBe('x');
    // The control is NOT retired — this failure is correctable.
    expect(container.querySelector('#btn-lock-asset')).not.toBeNull();
  });

  it('closes and reports honestly when the asset is gone (404)', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch(
        () => UNLOCKED_ASSET,
        () => ({ status: 404, body: { error: 'not_found' } })
      )
    );

    await renderAssetDetailBody(ULID, container);
    container.querySelector<HTMLButtonElement>('#btn-lock-asset')!.click();
    document.querySelector<HTMLButtonElement>('#lock-submit')!.click();
    await settle();

    expect(modal()).toBeNull();
    expect(container.querySelector('#action-msg')?.textContent).toContain(
      LOCK_DETAIL_COPY.errNotFound
    );
  });
});

describe('asset detail — clearing the lock (issue #895)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    closeAnyModal();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('confirms with the blast-radius copy, then DELETEs with no body or query', async () => {
    let unlocked = false;
    const fetchSpy = routedFetch(
      () => (unlocked ? UNLOCKED_ASSET : LOCKED_ASSET),
      (method) => {
        expect(method).toBe('DELETE');
        unlocked = true;
        // The API returns the asset with `deleteLock` ABSENT, never
        // `locked: false` (src/data/asset-repo.ts:1083-1086).
        return { status: 200, body: UNLOCKED_ASSET };
      }
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    container.querySelector<HTMLButtonElement>('#btn-unlock-asset')!.click();
    await settle(2);

    const dialog = modal()!;
    const dialogText = (dialog.textContent || '').replace(/\s+/g, ' ');
    expect(dialogText).toContain(LOCK_DETAIL_COPY.dialogUnlockTitle);
    expect(dialogText).toContain('Clear the delete lock on "' + UNLOCKED_ASSET.name + '"?');
    expect(dialogText).toContain(LOCK_DETAIL_COPY.unlockAffected1);
    // The discarded note is genuinely unrecoverable: no endpoint exposes the
    // provenance entry the repo appends (gaps H4/H5), so this is not softened.
    expect(dialogText).toContain(LOCK_DETAIL_COPY.unlockAffected2);
    expect(dialogText).toContain(LOCK_DETAIL_COPY.unlockUnaffected1);
    expect(dialogText).toContain(LOCK_DETAIL_COPY.unlockUnaffected2);
    // No "force", "delete anyway" or "override" affordance anywhere.
    expect(dialogText).not.toMatch(/force|delete anyway|override/i);

    dialog.querySelector<HTMLButtonElement>('.confirm-accept')!.click();
    await settle();

    const call = fetchSpy.mock.calls.find(
      ([u, i]) => /\/lock$/.test(String(u)) && (i as RequestInit).method === 'DELETE'
    );
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit];
    expect(String(url)).toContain('/assets/' + ULID + '/lock');
    expect(String(url)).not.toContain('?');
    expect(init.body).toBeUndefined();

    expect(blockText(container)).toContain(LOCK_DETAIL_COPY.unlocked);
    expect(blockText(container)).not.toContain('Reason:');
    expect(container.querySelector('#btn-lock-asset')).not.toBeNull();
    expect(container.querySelector('#action-msg')?.textContent).toContain(
      LOCK_DETAIL_COPY.resultUnlocked
    );
  });

  it('sends nothing when the confirmation is dismissed', async () => {
    const fetchSpy = routedFetch(() => LOCKED_ASSET);
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    container.querySelector<HTMLButtonElement>('#btn-unlock-asset')!.click();
    await settle(2);
    modal()!.querySelector<HTMLButtonElement>('.confirm-cancel')!.click();
    await settle(3);

    expect(
      fetchSpy.mock.calls.some(([u, i]) => /\/lock$/.test(String(u)) && i)
    ).toBe(false);
    expect(container.querySelector('#btn-unlock-asset')).not.toBeNull();
  });

  it('reports a 403 in the action area and retires the control', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch(
        () => LOCKED_ASSET,
        () => ({
          status: 403,
          body: { error: 'forbidden_insufficient_role', message: 'denied' },
        })
      )
    );

    await renderAssetDetailBody(ULID, container);
    container.querySelector<HTMLButtonElement>('#btn-unlock-asset')!.click();
    await settle(2);
    modal()!.querySelector<HTMLButtonElement>('.confirm-accept')!.click();
    await settle();

    expect(container.querySelector('#action-msg')?.textContent).toContain(
      LOCK_DETAIL_COPY.errForbidden
    );
    expect(container.querySelector('#btn-unlock-asset')).toBeNull();
    expect(container.querySelector('#btn-edit-lock-note')).toBeNull();
    // The state is still shown; only the write controls are withdrawn.
    expect(blockText(container)).toContain(LOCK_DETAIL_COPY.consequence);
  });
});
