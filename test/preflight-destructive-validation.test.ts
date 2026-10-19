// @vitest-environment happy-dom
//
// DOM/unit tests for pre-flight validation of destructive actions (issue #921,
// broken out from #853): where the client can already see that the API will
// refuse a delete, the operator is told why INSTEAD of confirming an action that
// cannot happen.
//
// Acceptance criteria under test:
//   1. A blocked action does not require the operator to confirm first and then
//      learn it was impossible — no confirm control, and no request sent.
//   2. The blocked state communicates WHY, using the same structured-reason
//      mapping as the error-rendering path (issue #920).
//   3. It builds on the confirmModal / errorToast primitives (#919 / #918)
//      rather than introducing a second dialog.
//
// Verified contract sources (CLAUDE.md rule 7 — read in the live tree on this
// branch, not assumed):
//   - DELETE /api/v1/collections/{id}: handler src/routes/collections.ts:412-530.
//     openapi.json .paths["/api/v1/collections/{id}"].delete declares exactly
//     the query params ['force', 'confirmMemberCount'] + path 'id', and exactly
//     the responses ['204', '400', '404', '409'].
//     The 409 is the shared `delete_blocked` envelope: error (enum
//     ['delete_blocked']), message?, reason (enum ['referenced_by_job',
//     'member_of_collection', 'delete_protected']), blockedBy { jobIds[],
//     collectionIds[] }, memberCount? (integer >= 0); required ['error',
//     'reason', 'blockedBy'].
//   - The two guards, in order: `existing?.deleteLock?.locked` ->
//     CollectionDeleteProtectedError (collections.ts:453-455, HARD, `force`
//     never consulted) and `existing.assetIds.length > 0` ->
//     CollectionInUseError (:490-492, skipped by `?force=true` or a matching
//     `?confirmMemberCount=`). `repo.delete(id)` is only reached after both
//     (:502), so a refusal changes nothing and writes no audit entry (the emit
//     is at :506-527, after the delete).
//   - The UI sends a bare DELETE with neither override, which is what makes the
//     prediction sound. Asserted below by inspecting the recorded request URL.
//   - GET /api/v1/collections -> { collections: collectionSchema[] }
//     (collections.ts:343-353). openapi.json
//     .paths["/api/v1/collections/"].get.responses["200"] item properties are
//     id, name, assetIds, description, tags, custom, createdAt, updatedAt,
//     deleteLock — so BOTH inputs to the guards above are already in the list
//     payload and no extra request is needed to know the block.
//   - Clearing a lock removes the field rather than writing `locked: false`
//     (DELETE /collections/{id}/lock, collections.ts:572-584), so `locked ===
//     true` is the only safe test — the trap documented in public/lock-state.js.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_FAILURE_REASON_COPY, TAB_RENDERERS } from '../public/app.js';
import {
  actionFailureReasonCopy,
  blockedFlagLabel,
  reasonExplanation,
} from '../public/action-failure-reasons.js';
import {
  blockedActionFlag,
  collectionDeleteBlock,
  preflightBlockedSpec,
} from '../public/preflight-delete.js';

function jsonResponse(payload: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: status === 204 ? {} : { 'content-type': 'application/json' },
  });
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function dialog() {
  return document.querySelector('.confirm-dialog') as HTMLElement | null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
  document.body.innerHTML = '';
});

const COLLECTION = {
  id: '01J8ZQF7TESTCOLLECTIONID',
  name: 'Summer campaign rushes',
  assetIds: [] as string[],
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
};

const LOCK = { locked: true, lockedAt: '2026-01-01T00:00:00.000Z' };

// ─── The prediction (AC1: it has to be right to be worth short-circuiting) ─────

describe('collectionDeleteBlock mirrors the route guards', () => {
  it('reports member_of_collection, with the count, for a non-empty collection', () => {
    const block = collectionDeleteBlock({ ...COLLECTION, assetIds: ['a', 'b', 'c'] });
    expect(block).toEqual({
      subject: 'collection',
      reason: 'member_of_collection',
      memberCount: 3,
    });
  });

  it('reports delete_protected for a locked collection, even an empty one', () => {
    // Guard order: the lock throws at collections.ts:453-455, before the
    // emptiness check at :490-492, so the lock is the reason whatever the count.
    expect(collectionDeleteBlock({ ...COLLECTION, deleteLock: LOCK })!.reason)
      .toBe('delete_protected');
    expect(
      collectionDeleteBlock({ ...COLLECTION, assetIds: ['a'], deleteLock: LOCK })!.reason
    ).toBe('delete_protected');
  });

  it('reports no block for an empty, unlocked collection', () => {
    expect(collectionDeleteBlock(COLLECTION)).toBeNull();
  });

  it('treats an explicit locked:false as unlocked, not as a lock marker', () => {
    // The schema permits { locked: false, lockedAt } (deleteLockSchema,
    // src/routes/collections.ts:54-59), so presence of the field is not the test.
    expect(
      collectionDeleteBlock({
        ...COLLECTION,
        deleteLock: { locked: false, lockedAt: '2026-01-01T00:00:00.000Z' },
      })
    ).toBeNull();
  });

  it('treats a payload with no assetIds as unknown, never as blocked', () => {
    const { assetIds: _dropped, ...withoutMembership } = COLLECTION;
    expect(collectionDeleteBlock(withoutMembership)).toBeNull();
    expect(collectionDeleteBlock(null)).toBeNull();
  });
});

// ─── The shared mapping (AC2) ──────────────────────────────────────────────────

describe('pre-flight copy comes from the issue-#920 reason deck', () => {
  it('is the same deck: cause + resolution reproduces the post-flight sentence', () => {
    // One mapping, two renderings. If the deck is edited, both move together.
    for (const reason of Object.keys(ACTION_FAILURE_REASON_COPY)) {
      const explanation = reasonExplanation(reason)!;
      expect(explanation).toBeTruthy();
      expect(explanation.cause + ' ' + explanation.resolution).toBe(
        (ACTION_FAILURE_REASON_COPY as Record<string, string>)[reason]
      );
    }
  });

  it('covers exactly the closed enum the routers declare', () => {
    // src/routes/collections.ts:76 / src/routes/assets.ts:575 — if the server
    // adds a member, this is where the client notices.
    expect(Object.keys(ACTION_FAILURE_REASON_COPY).sort()).toEqual([
      'delete_protected',
      'member_of_collection',
      'referenced_by_job',
    ]);
  });

  it('says something subject-true for a collection, not the item-centric default', () => {
    // `member_of_collection` means "this asset is in collections" from the
    // assets router (assets.ts:2722-2728) and "this collection still holds members"
    // from the collections router (collections.ts:298-306). One sentence cannot
    // be true of both.
    const forCollection = actionFailureReasonCopy('member_of_collection', {
      subject: 'collection',
    })!;
    expect(forCollection).not.toBe(ACTION_FAILURE_REASON_COPY.member_of_collection);
    expect(forCollection).toContain('still holds member assets');
    // The lock resolution names the ONLY route that lifts a collection lock
    // (collections.ts:572-584); this UI has no control for it, so the copy must
    // not point at one.
    expect(actionFailureReasonCopy('delete_protected', { subject: 'collection' }))
      .toContain('/collections/{id}/lock');
  });

  it('returns null for an absent, unknown or inherited reason', () => {
    expect(actionFailureReasonCopy(undefined)).toBeNull();
    expect(actionFailureReasonCopy('brand_new_reason')).toBeNull();
    // `reason` is server-controlled z.string() on the generic envelope
    // (collections.ts:46-50): it must not resolve up the prototype chain.
    expect(actionFailureReasonCopy('constructor')).toBeNull();
    expect(actionFailureReasonCopy('toString')).toBeNull();
    expect(blockedFlagLabel({ reason: 'constructor', subject: 'collection' })).toBeNull();
  });
});

// ─── The dialog spec (AC1/AC3) ─────────────────────────────────────────────────

describe('preflightBlockedSpec builds the blocked confirmModal variant', () => {
  const spec = preflightBlockedSpec(
    { subject: 'collection', reason: 'member_of_collection', memberCount: 2 },
    'Summer campaign rushes'
  );

  it('selects the variant that HAS no confirm control', () => {
    expect(spec.blocked).toBe(true);
    expect(spec.closeLabel).toBe('Close');
    // Nothing is confirmed, so nothing is labelled for confirming.
    expect((spec as Record<string, unknown>).confirmLabel).toBeUndefined();
  });

  it('names the subject by name and carries the live count', () => {
    expect(spec.question).toContain('Summer campaign rushes');
    expect(spec.question).toContain('2 assets');
    expect(spec.question).not.toContain(COLLECTION.id);
  });

  it('states the cause and the resolution from the shared deck', () => {
    const explanation = reasonExplanation('member_of_collection', { subject: 'collection' })!;
    expect(spec.detail).toBe(explanation.cause);
    expect(spec.resolution).toBe(explanation.resolution);
  });

  it('claims nothing was affected, because no request is sent', () => {
    expect(spec.affected).toEqual([]);
    expect(spec.unaffected.join(' ')).toContain('nothing has changed');
  });

  it('singularises the count', () => {
    const one = preflightBlockedSpec(
      { subject: 'collection', reason: 'member_of_collection', memberCount: 1 },
      'Reel'
    );
    expect(one.question).toContain('1 asset.');
  });
});

describe('blockedActionFlag is the terse version of the same reason', () => {
  it('folds the member count into the flag', () => {
    expect(
      blockedActionFlag({ subject: 'collection', reason: 'member_of_collection', memberCount: 2 })
    ).toBe('Delete blocked: still holds 2 assets');
  });

  it('names the lock without a count', () => {
    expect(blockedActionFlag({ subject: 'collection', reason: 'delete_protected' })).toBe(
      'Delete blocked: a delete lock is set'
    );
  });

  it('is null for a reason this client does not recognise', () => {
    expect(blockedActionFlag({ subject: 'collection', reason: 'brand_new_reason' })).toBeNull();
  });
});

// ─── Integration: the Collections tab ──────────────────────────────────────────

describe('Collections tab short-circuits a blocked delete (issue #921)', () => {
  async function renderTab(collection: Record<string, unknown>, deleteStatus = 204) {
    const calls: { method: string; path: string }[] = [];
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api\/v1/, '');
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ method, path });
      if (path === '/collections' && method === 'GET') {
        return jsonResponse({ collections: [collection] });
      }
      if (path === '/collections/' + collection.id && method === 'GET') {
        return jsonResponse({ ...collection, assets: [] });
      }
      if (method === 'DELETE') {
        return deleteStatus === 204
          ? jsonResponse(null, 204)
          : jsonResponse(
              {
                error: 'delete_blocked',
                message: 'collection ' + collection.id + ' is in use (2 member asset(s))',
                reason: 'member_of_collection',
                blockedBy: { jobIds: [], collectionIds: [String(collection.id)] },
                memberCount: 2,
              },
              409
            );
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchStub);

    const container = document.createElement('div');
    document.body.appendChild(container);
    await TAB_RENDERERS['collections'](container);
    await flush();
    const deleteBtn = container.querySelector('.coll-delete-btn') as HTMLButtonElement;
    return { container, calls, deleteBtn };
  }

  it('flags WHY on the row, before the control is activated', async () => {
    const { container, deleteBtn } = await renderTab({
      ...COLLECTION,
      assetIds: ['01J8A', '01J8B'],
    });

    const note = container.querySelector('.action-blocked-note') as HTMLElement;
    expect(note).toBeTruthy();
    expect(note.textContent).toBe('Delete blocked: still holds 2 assets');
    // Wired to the control, so the reason is announced with the button's name
    // and does not live only in a hover title.
    expect(deleteBtn.getAttribute('aria-describedby')).toBe(note.id);
    expect(deleteBtn.getAttribute('title')).toBe(note.textContent);
    // NOT disabled: a disabled control cannot be focused and carries no reason
    // (docs/ux/asset-lock-state-spec.md §5.1).
    expect(deleteBtn.disabled).toBe(false);
  });

  it('explains instead of confirming, and sends nothing (AC1)', async () => {
    const { calls, deleteBtn } = await renderTab({
      ...COLLECTION,
      assetIds: ['01J8A', '01J8B'],
    });
    deleteBtn.click();
    await flush();

    const el = dialog();
    expect(el).toBeTruthy();
    // Exactly one dialog, and it has NO confirm control to activate.
    expect(document.querySelectorAll('.confirm-dialog').length).toBe(1);
    expect(el!.querySelector('.confirm-accept')).toBeNull();
    expect((el!.querySelector('.confirm-cancel') as HTMLElement).textContent).toBe('Close');
    // The reason, in the words of the shared deck (AC2).
    expect(el!.querySelector('.confirm-detail')!.textContent).toBe(
      reasonExplanation('member_of_collection', { subject: 'collection' })!.cause
    );
    expect(el!.querySelector('.confirm-resolution')!.textContent).toBe(
      reasonExplanation('member_of_collection', { subject: 'collection' })!.resolution
    );
    // Named by name, never by the opaque id.
    expect(el!.textContent).toContain('Summer campaign rushes');
    expect(el!.textContent).not.toContain(COLLECTION.id);
    // AC1, the part that matters: no request was issued at any point.
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('offers the route to the fix, and no "delete anyway"', async () => {
    const { calls, deleteBtn } = await renderTab({
      ...COLLECTION,
      assetIds: ['01J8A', '01J8B'],
    });
    deleteBtn.click();
    await flush();

    const secondary = dialog()!.querySelector('.confirm-secondary') as HTMLButtonElement;
    expect(secondary).toBeTruthy();
    expect(secondary.textContent).toBe('View collection');
    // No override affordance: `?force=true` / `?confirmMemberCount=` exist on
    // the route (collections.ts:431-434) but this UI does not send them, so the
    // dialog must not imply it will.
    const text = dialog()!.textContent || '';
    expect(text.toLowerCase()).not.toContain('force');
    expect(text.toLowerCase()).not.toContain('delete anyway');

    secondary.click();
    await flush();
    // The member list — where Remove per row lives — is what it opens.
    expect(calls.some((c) => c.method === 'GET' && c.path === '/collections/' + COLLECTION.id))
      .toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('explains a delete-locked collection and offers no control that is not there', async () => {
    const { calls, container, deleteBtn } = await renderTab({
      ...COLLECTION,
      deleteLock: LOCK,
    });

    expect((container.querySelector('.action-blocked-note') as HTMLElement).textContent).toBe(
      'Delete blocked: a delete lock is set'
    );
    deleteBtn.click();
    await flush();

    const el = dialog()!;
    expect(el.querySelector('.confirm-accept')).toBeNull();
    expect(el.querySelector('.confirm-resolution')!.textContent).toContain(
      '/collections/{id}/lock'
    );
    // This UI has no unlock control for a collection, so there is nowhere to
    // send the operator — better no button than one that leads nowhere.
    expect(el.querySelector('.confirm-secondary')).toBeNull();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('still confirms — and still deletes — when nothing blocks it', async () => {
    const { container, calls, deleteBtn } = await renderTab(COLLECTION);

    expect(container.querySelector('.action-blocked-note')).toBeNull();
    expect(deleteBtn.getAttribute('data-blocked-reason')).toBeNull();
    deleteBtn.click();
    await flush();

    const accept = dialog()!.querySelector('.confirm-accept') as HTMLButtonElement;
    expect(accept).toBeTruthy();
    accept.click();
    await flush();

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(1);
    // A bare DELETE: no `?force=true`, no `?confirmMemberCount=` — the premise
    // the pre-flight prediction rests on.
    expect(deletes[0]!.path).toBe('/collections/' + COLLECTION.id);
  });

  it('leaves the post-flight path in place for a block that appeared since the read', async () => {
    // Empty when the list was read, non-empty by the time the delete lands. The
    // pre-flight check cannot see this one, so the 409 still has to be reported
    // — with the same subject-aware copy (issue #920 + #921).
    const { calls, deleteBtn } = await renderTab(COLLECTION, 409);
    deleteBtn.click();
    await flush();
    (dialog()!.querySelector('.confirm-accept') as HTMLButtonElement).click();
    await flush();

    const failure = document.querySelector('.error-dialog') as HTMLElement;
    expect(failure).toBeTruthy();
    expect(failure.querySelector('.msg-error')!.textContent).toBe(
      actionFailureReasonCopy('member_of_collection', { subject: 'collection' })
    );
    expect(calls.filter((c) => c.method === 'DELETE').length).toBe(1);
  });
});
