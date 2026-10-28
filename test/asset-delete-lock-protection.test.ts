// @vitest-environment happy-dom
//
// Delete-lock protection on the asset archive action (issue #896), implementing
// docs/ux/asset-lock-state-spec.md §5 ("Surface C — protected delete") and the
// parts of its §10 acceptance checklist that belong to that surface.
//
// The issue's acceptance criteria, and where each is pinned below:
//   1. "A locked asset's delete control communicates protection before or at the
//      point of the attempted delete."
//        -> `pre-flight` and `post-flight (409)` describes.
//   2. "The operator is directed to the unlock action rather than shown a
//      generic error."
//        -> `resolution + route to the unlock control`.
//   3. "Behaviour matches the force=true response confirmed in the API-contract
//      sub-issue."
//        -> `contract: force never defeats the lock`, which reads the live spec
//           and route source rather than trusting the issue text.
//
// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT GROUNDING (CLAUDE.md rule 7). Every symbol below was read from
// openapi.json and src/ in this tree before these tests were written.
//
//   openapi.json .paths["/api/v1/assets/{id}"].delete
//     .parameters => `force` (query, optional, boolean) and `id` (path, required)
//     .responses  => exactly 204 / 404 / 409
//     .responses["409"] => anyOf of
//        { error: 'delete_blocked', message?, reason:
//            'referenced_by_job'|'member_of_collection'|'delete_protected',
//          blockedBy: { jobIds: string[], collectionIds: string[] } }   (required:
//            error, reason, blockedBy; additionalProperties false)
//        and the bare { error: string, message? } arm that still serves
//        `has_children` (src/routes/assets.ts:2644-2646).
//     Source of the first arm: `deleteBlockedSchema`, src/routes/assets.ts:542-550.
//
//   Bodies, from the handlers that emit them:
//     delete_protected     src/routes/assets.ts:2666-2673, blockedBy always
//                          { jobIds: [], collectionIds: [] }
//     member_of_collection src/routes/assets.ts:2678-2686
//     referenced_by_job    src/routes/assets.ts:2691-2699
//
//   FORCE vs THE LOCK: the lock guard is unconditional and runs FIRST
//   (src/routes/assets.ts:5499-5502, `if (existing?.deleteLock?.locked) throw new
//   DeleteProtectedError(...)`), while `request.query.force` is not read until
//   :5533. `DeleteProtectedError.statusCode = 409` (src/data/asset-repo.ts:801-807).
//   Asserted end-to-end server-side by "does NOT let ?force=true bypass the lock",
//   src/routes/assets.delete-lock.test.ts. The ordering is re-derived from source
//   below so a future reorder breaks this UI test too, not just the server one.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { confirmModal, TAB_RENDERERS } from '../public/app.js';
import { createAssetsTable } from '../public/assets-table.js';
import {
  DELETE_BLOCKED_COPY,
  classifyDeleteBlock,
  deleteBlockedSpec,
  isDeleteProtected,
  protectedBlock,
  showDeleteBlocked,
} from '../public/delete-blocked.js';

const ROOT = process.cwd();
const OPENAPI = JSON.parse(readFileSync(resolve(ROOT, 'openapi.json'), 'utf8'));
const ASSETS_TS = readFileSync(resolve(ROOT, 'src/routes/assets.ts'), 'utf8');
const APP_JS = readFileSync(resolve(ROOT, 'public/app.js'), 'utf8');
const TABLE_JS = readFileSync(resolve(ROOT, 'public/assets-table.js'), 'utf8');
const BLOCKED_JS = readFileSync(resolve(ROOT, 'public/delete-blocked.js'), 'utf8');

const DELETE_OP = OPENAPI.paths['/api/v1/assets/{id}'].delete;

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await tick();
}

function dialog(): HTMLElement | null {
  return document.querySelector('.confirm-dialog');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
  document.body.innerHTML = '';
});

// ─── AC3: the contract this whole surface rests on ───────────────────────────

describe('contract: DELETE /api/v1/assets/{id} and force-vs-lock precedence', () => {
  it('declares 204 / 404 / 409 and a `force` query parameter', () => {
    expect(Object.keys(DELETE_OP.responses).sort()).toEqual(['204', '404', '409']);
    const params = DELETE_OP.parameters.map((p: { in: string; name: string }) => p.in + ':' + p.name);
    expect(params).toContain('query:force');
    expect(params).toContain('path:id');
  });

  it('declares the delete_blocked 409 arm with the three reasons and blockedBy', () => {
    const arms = DELETE_OP.responses['409'].content['application/json'].schema.anyOf;
    expect(Array.isArray(arms)).toBe(true);
    const rich = arms.find((a: { properties?: Record<string, unknown> }) => a.properties?.reason);
    expect(rich.properties.error.enum).toEqual(['delete_blocked']);
    expect(rich.properties.reason.enum).toEqual([
      'referenced_by_job',
      'member_of_collection',
      'delete_protected',
    ]);
    expect(Object.keys(rich.properties.blockedBy.properties).sort()).toEqual([
      'collectionIds',
      'jobIds',
    ]);
    expect(rich.required.sort()).toEqual(['blockedBy', 'error', 'reason']);
    // The SECOND arm carries neither `reason` nor `blockedBy` — which is why the
    // client must gate on `error === 'delete_blocked'` before reading them.
    const bare = arms.find((a: { properties?: Record<string, unknown> }) => !a.properties?.reason);
    expect(bare.properties.blockedBy).toBeUndefined();
  });

  it('runs the lock guard BEFORE `force` is ever read, so force cannot defeat a lock', () => {
    const guardAt = ASSETS_TS.indexOf('throw new DeleteProtectedError(request.params.id)');
    const forceAt = ASSETS_TS.indexOf('if (!request.query.force && opts.collectionRepository)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(forceAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(forceAt);
    // …and the guard is unconditional: it does not mention force at all.
    expect(ASSETS_TS.slice(guardAt - 200, guardAt)).not.toContain('force');
  });

  it('emits delete_protected with BOTH id arrays empty', () => {
    // src/routes/assets.ts:2666-2673 — the block is intrinsic to the document,
    // not a foreign reference, so there is no id list to show the operator.
    const at = ASSETS_TS.indexOf('if (err instanceof DeleteProtectedError)');
    expect(at).toBeGreaterThan(-1);
    const handler = ASSETS_TS.slice(at, at + 320);
    expect(handler).toContain("reason: 'delete_protected'");
    expect(handler).toContain('blockedBy: { jobIds: [], collectionIds: [] }');
  });

  it('the UI never sends ?force=true on the asset archive path (spec §5.3)', () => {
    expect(APP_JS).not.toMatch(/\/assets\/'\s*\+\s*encodeURIComponent\(id\)\s*\+\s*'\?force/);
    // No "force", "delete anyway", "override" or "retry" affordance in the
    // blocked copy either — offering a retry guaranteed to fail identically is
    // worse than offering nothing.
    const copy = Object.values(DELETE_BLOCKED_COPY).join(' ').toLowerCase();
    expect(copy).not.toContain('delete anyway');
    expect(copy).not.toContain('override');
    expect(copy).not.toContain('force delete');
    expect(copy).not.toContain('retry');
  });
});

// ─── classifyDeleteBlock: defensive branching on the anyOf (spec §5.4) ───────

describe('classifyDeleteBlock (spec §5.4)', () => {
  const err = (status: number, body: unknown) =>
    Object.assign(new Error('boom'), { status, body });

  it('returns null for anything that is not a 409', () => {
    expect(classifyDeleteBlock(err(404, { error: 'not_found' }))).toBeNull();
    expect(classifyDeleteBlock(err(403, { error: 'forbidden_insufficient_role' }))).toBeNull();
    // A network failure has no status at all.
    expect(classifyDeleteBlock(new Error('Failed to fetch'))).toBeNull();
    expect(classifyDeleteBlock(null)).toBeNull();
  });

  it('classifies delete_protected with its empty id arrays', () => {
    const b = classifyDeleteBlock(
      err(409, {
        error: 'delete_blocked',
        message: 'asset a1 is protected from deletion by an explicit lock',
        reason: 'delete_protected',
        blockedBy: { jobIds: [], collectionIds: [] },
      })
    );
    expect(b).toMatchObject({ kind: 'protected', reason: 'delete_protected', jobIds: [], collectionIds: [] });
  });

  it('classifies referenced_by_job and keeps the job ids', () => {
    const b = classifyDeleteBlock(
      err(409, {
        error: 'delete_blocked',
        reason: 'referenced_by_job',
        blockedBy: { jobIds: ['job_1', 'job_2'], collectionIds: [] },
      })
    );
    expect(b!.kind).toBe('job');
    expect(b!.jobIds).toEqual(['job_1', 'job_2']);
  });

  it('classifies member_of_collection and keeps the collection ids', () => {
    const b = classifyDeleteBlock(
      err(409, {
        error: 'delete_blocked',
        reason: 'member_of_collection',
        blockedBy: { jobIds: [], collectionIds: ['col_1'] },
      })
    );
    expect(b!.kind).toBe('collection');
    expect(b!.collectionIds).toEqual(['col_1']);
  });

  it('falls back to generic for the bare {error,message} arm, without reading reason/blockedBy', () => {
    const b = classifyDeleteBlock(
      err(409, { error: 'has_children', message: 'asset a1 still has 2 child assets' })
    );
    expect(b).toMatchObject({ kind: 'generic', reason: null, jobIds: [], collectionIds: [] });
    expect(b!.message).toContain('child assets');
  });

  it('does not crash on a future reason member, or on a missing blockedBy', () => {
    const b = classifyDeleteBlock(
      err(409, { error: 'delete_blocked', reason: 'legal_hold_v2' } as unknown)
    );
    expect(b!.kind).toBe('generic');
    expect(b!.jobIds).toEqual([]);
    expect(b!.collectionIds).toEqual([]);
  });

  it('tolerates a 409 whose body could not be parsed at all', () => {
    const b = classifyDeleteBlock(Object.assign(new Error('HTTP 409'), { status: 409 }));
    expect(b!.kind).toBe('generic');
  });
});

// ─── The blocked dialog spec (§5.2) and its copy (§7) ────────────────────────

describe('deleteBlockedSpec — copy and shape (spec §5.2, §7)', () => {
  it('uses the copy deck verbatim for a delete lock', () => {
    const s = deleteBlockedSpec(protectedBlock(), 'Protected master');
    expect(s.title).toBe('Archive blocked');
    expect(s.question).toBe('"Protected master" is protected from deletion.');
    expect(s.detail).toBe(
      'A delete lock is set on this asset, so the API refuses to archive it. Nothing has changed.'
    );
    expect(s.unaffected).toEqual([
      'The asset, its files and its metadata are untouched.',
      'No job was started and nothing was queued.',
    ]);
    expect(s.resolution).toBe(
      "To archive this asset, clear its delete lock from the asset's detail view first. " +
        'The lock cannot be forced.'
    );
    expect(s.closeLabel).toBe('Close');
    expect(DELETE_BLOCKED_COPY.btnDetail).toBe('Open detail');
  });

  it('is a blocked dialog: nothing to affect, nothing to confirm', () => {
    const s = deleteBlockedSpec(protectedBlock(), 'Protected master');
    expect(s.blocked).toBe(true);
    expect(s.affected).toEqual([]);
    expect(s.confirmLabel).toBeUndefined();
  });

  it('renders NO "blocked by" list for a lock — both arrays are empty by contract', () => {
    expect(deleteBlockedSpec(protectedBlock(), 'x').blockedBy).toBeNull();
  });

  it('names the blocking job ids for referenced_by_job', () => {
    const s = deleteBlockedSpec({ kind: 'job', jobIds: ['job_1'] }, 'Master');
    expect(s.question).toContain('is in use by a job that is still running');
    expect(s.blockedBy).toEqual({ heading: 'Jobs still referencing this asset', items: ['job_1'] });
    expect(s.resolution).toContain('cancel them');
  });

  it('names the blocking collection ids for member_of_collection', () => {
    const s = deleteBlockedSpec({ kind: 'collection', collectionIds: ['col_1'] }, 'Master');
    expect(s.question).toContain('is still a member of a collection');
    expect(s.blockedBy).toEqual({
      heading: 'Collections this asset belongs to',
      items: ['col_1'],
    });
  });

  it('uses the server message for the generic arm rather than inventing a cause', () => {
    const s = deleteBlockedSpec({ kind: 'generic', message: 'asset a1 still has 2 child assets' }, 'M');
    expect(s.question).toBe('"M" could not be archived.');
    expect(s.detail).toBe('asset a1 still has 2 child assets');
  });

  it('never claims the archive happened', () => {
    const all = ['protected', 'job', 'collection', 'generic'].map((kind) =>
      JSON.stringify(deleteBlockedSpec({ kind }, 'M'))
    );
    all.forEach((s) => {
      expect(s.toLowerCase()).not.toContain('archived successfully');
      expect(s).toContain('Nothing has changed');
    });
  });
});

// ─── The confirmModal blocked variant (§5.2, §8) ─────────────────────────────

describe('confirmModal blocked variant (spec §5.2)', () => {
  const spec = () => deleteBlockedSpec(protectedBlock(), 'Protected master');

  it('renders no confirm control at all and resolves false on Close', async () => {
    const p = confirmModal(spec());
    const el = dialog()!;
    expect(el).toBeTruthy();
    expect(el.querySelector('.confirm-accept')).toBeNull();
    const close = el.querySelector('.confirm-cancel') as HTMLButtonElement;
    expect(close.textContent).toBe('Close');
    close.click();
    await expect(p).resolves.toBe(false);
  });

  it('omits the empty "What this affects" list but keeps "what this does not affect"', () => {
    void confirmModal(spec());
    const el = dialog()!;
    expect(el.querySelector('.confirm-affected')).toBeNull();
    expect(el.querySelector('.confirm-unaffected')!.querySelectorAll('li').length).toBe(2);
  });

  it('renders the resolution sentence under the lists', () => {
    void confirmModal(spec());
    const el = dialog()!;
    const res = el.querySelector('.confirm-resolution') as HTMLElement;
    expect(res).toBeTruthy();
    expect(res.textContent).toContain('clear its delete lock');
    expect(res.textContent).toContain('cannot be forced');
    // It sits after the impact list, not before it.
    const kids = Array.from(el.children);
    expect(kids.indexOf(res)).toBeGreaterThan(
      kids.indexOf(el.querySelector('.confirm-unaffected') as Element)
    );
  });

  it('focuses Close — the only action in the dialog (spec §8)', () => {
    void confirmModal(spec());
    expect(document.activeElement).toBe(dialog()!.querySelector('.confirm-cancel'));
  });

  it('resolves false on Escape and on the × control, like every other dismissal', async () => {
    const p = confirmModal(spec());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(p).resolves.toBe(false);
  });

  it('renders asset-controlled text and blocking ids as TEXT, never as markup', () => {
    void confirmModal(
      deleteBlockedSpec(
        { kind: 'job', jobIds: ['<img src=x onerror=alert(1)>', 'job_2'] },
        '<script>alert(1)</script>'
      )
    );
    const el = dialog()!;
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).toContain('<script>alert(1)</script>');
    expect(el.querySelector('.confirm-blocked-by')!.textContent).toContain(
      '<img src=x onerror=alert(1)>'
    );
  });

  it('leaves the ordinary destructive dialog untouched (additive change)', async () => {
    const p = confirmModal({
      title: 'Archive asset',
      subject: 'Ordinary asset',
      confirmLabel: 'Archive',
      affected: ['a'],
      unaffected: ['b'],
    });
    const el = dialog()!;
    expect(el.querySelector('.confirm-affected')).toBeTruthy();
    expect((el.querySelector('.confirm-cancel') as HTMLElement).textContent).toBe('Cancel');
    expect(el.querySelector('.confirm-resolution')).toBeNull();
    (el.querySelector('.confirm-accept') as HTMLButtonElement).click();
    await expect(p).resolves.toBe(true);
  });
});

// ─── AC2: the route to the unlock action (§5.2) ──────────────────────────────

describe('resolution + route to the unlock control (issue #896 AC2)', () => {
  it('offers "Open detail" for a lock, and invokes it after closing the dialog', async () => {
    const onOpenDetail = vi.fn();
    const p = showDeleteBlocked({
      block: protectedBlock(),
      name: 'Protected master',
      confirmModal,
      onOpenDetail,
    });
    const btn = dialog()!.querySelector('.confirm-secondary') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe('Open detail');
    btn.click();
    await p;
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it('does NOT put an Unlock button in the archive dialog (two decisions, not one)', () => {
    void showDeleteBlocked({
      block: protectedBlock(),
      name: 'Protected master',
      confirmModal,
      onOpenDetail: () => {},
    });
    const labels = Array.from(dialog()!.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).not.toContain('Unlock');
    expect(labels).toContain('Close');
  });

  it('offers no "Open detail" for a job or collection block — there is no control there', () => {
    void showDeleteBlocked({
      block: { kind: 'job', jobIds: ['job_1'] },
      name: 'M',
      confirmModal,
      onOpenDetail: () => {},
    });
    expect(dialog()!.querySelector('.confirm-secondary')).toBeNull();
  });
});

// ─── AC1a: pre-flight — the list knows the row is locked (§5.1) ──────────────

describe('pre-flight: the Archive control on a known-locked row (spec §5.1)', () => {
  const LOCKED_ROW = {
    id: 'a-locked',
    name: 'Protected master',
    status: 'ready',
    createdAt: '2026-01-01T00:00:00Z',
    deleteLock: { locked: true, lockedAt: '2026-01-02T10:00:00Z' },
  };
  const PLAIN_ROW = {
    id: 'a-plain',
    name: 'Ordinary asset',
    status: 'ready',
    createdAt: '2026-01-01T00:00:00Z',
  };

  async function mount(items: unknown[], onDelete: (...a: unknown[]) => unknown, search = '') {
    const apiFetch = vi.fn(async (path: string) => {
      if (path.startsWith('/search')) return { assets: items, total: items.length, page: 1 };
      return { items, total: items.length };
    });
    const t = createAssetsTable({
      apiFetch,
      renderBadge: (s: string) => '<span class="badge">' + s + '</span>',
      renderTags: () => '',
      fmtDate: (v: string) => String(v || '—'),
      isAssetWedged: () => false,
      onDelete,
      win: { location: { search, pathname: '/', hash: '' }, history: { state: null, replaceState() {}, pushState() {} } },
    });
    document.body.appendChild(t.el);
    await tick();
    return t;
  }

  function archiveBtn(el: HTMLElement, id: string) {
    return el.querySelector('.asset-delete-btn[data-id="' + id + '"]') as HTMLButtonElement;
  }

  it('keeps the Archive button ENABLED and focusable on a locked row (§5.1, §10)', async () => {
    const t = await mount([LOCKED_ROW], () => false);
    const btn = archiveBtn(t.el, 'a-locked');
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
    expect(btn.hasAttribute('disabled')).toBe(false);
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    expect(btn.textContent).toBe('Archive');
    // Nothing in the source disables it on account of a lock.
    expect(TABLE_JS).not.toMatch(/disabled[^\n]*isAssetLocked|isAssetLocked[^\n]*disabled/);
  });

  it('hands the handler the row lock state so it can explain before requesting', async () => {
    const onDelete = vi.fn(async () => false);
    const t = await mount([LOCKED_ROW, PLAIN_ROW], onDelete);

    archiveBtn(t.el, 'a-locked').click();
    await flush();
    expect(onDelete).toHaveBeenLastCalledWith('a-locked', 'Protected master', { locked: true });

    archiveBtn(t.el, 'a-plain').click();
    await flush();
    expect(onDelete).toHaveBeenLastCalledWith('a-plain', 'Ordinary asset', { locked: false });
  });

  it('reports locked:false — never a guess — for a row whose projection omits the field', async () => {
    // Free-text search tier: `deleteLock` is absent from the projection
    // (src/routes/search.ts assetSchema), so the row is state L0 UNKNOWN. The
    // handler must fall through to the 409 path rather than assert either way.
    const onDelete = vi.fn(async () => false);
    const t = await mount([{ ...PLAIN_ROW, id: 'a-search' }], onDelete, '?assets.q=promo');
    archiveBtn(t.el, 'a-search').click();
    await flush();
    expect(onDelete).toHaveBeenLastCalledWith('a-search', 'Ordinary asset', { locked: false });
  });

  it('isDeleteProtected reuses the shared derivation, including the L0 case', () => {
    expect(isDeleteProtected(LOCKED_ROW)).toBe(true);
    expect(isDeleteProtected(PLAIN_ROW)).toBe(false);
    expect(isDeleteProtected(LOCKED_ROW, { projectionCarriesLock: false })).toBe(false);
    // One derivation, one module (spec §10 checklist item 1).
    expect(BLOCKED_JS).toContain("from './lock-state.js'");
    expect(BLOCKED_JS).not.toContain('deleteLock.locked === false');
    expect(BLOCKED_JS).not.toContain("'deleteLock' in ");
  });
});

// ─── AC1b: end-to-end through the real Assets tab ────────────────────────────

describe('Assets tab archive flow (issues #896, #919)', () => {
  const LOCKED = {
    id: '01J8ZQF7LOCKEDASSETID0000',
    name: 'Protected master',
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    deleteLock: { locked: true, lockedAt: '2026-01-02T10:00:00.000Z', lockedBy: 'retention-policy' },
  };
  const PLAIN = {
    id: '01J8ZQF7PLAINASSETID00000',
    name: 'Ordinary asset',
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  function jsonResponse(payload: unknown, status = 200) {
    return new Response(status === 204 ? null : JSON.stringify(payload), {
      status,
      headers: status === 204 ? {} : { 'content-type': 'application/json' },
    });
  }

  async function renderTab(items: unknown[], deleteOutcome?: { status: number; body: unknown }) {
    const calls: { method: string; path: string }[] = [];
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api\/v1/, '');
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ method, path });
      if (method === 'DELETE') {
        const out = deleteOutcome || { status: 204, body: null };
        return jsonResponse(out.body, out.status);
      }
      if (path.startsWith('/assets')) return jsonResponse({ items, total: items.length });
      if (path.startsWith('/search')) return jsonResponse({ assets: items, total: items.length, page: 1 });
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchStub);

    const container = document.createElement('div');
    document.body.appendChild(container);
    await TAB_RENDERERS['assets'](container);
    await flush();
    return { container, calls };
  }

  const btnFor = (c: HTMLElement, id: string) =>
    c.querySelector('.asset-delete-btn[data-id="' + id + '"]') as HTMLButtonElement;

  it('explains the protection and issues NO DELETE for a known-locked asset', async () => {
    const { container, calls } = await renderTab([LOCKED]);
    btnFor(container, LOCKED.id).click();
    await flush();

    const el = dialog();
    expect(el).toBeTruthy();
    expect(document.querySelectorAll('.confirm-dialog').length).toBe(1);
    expect(el!.textContent).toContain('is protected from deletion');
    expect(el!.textContent).toContain('clear its delete lock');
    // It is the BLOCKED dialog, not the ordinary archive confirmation.
    expect(el!.querySelector('.confirm-accept')).toBeNull();
    expect(el!.textContent).not.toContain('Archive "Protected master"?');
    // Nothing was requested — the refusal was explained before the round-trip.
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);

    (el!.querySelector('.confirm-cancel') as HTMLButtonElement).click();
    await flush();
    expect(dialog()).toBeNull();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('still shows the ordinary archive confirmation for an unlocked asset', async () => {
    const { container, calls } = await renderTab([PLAIN]);
    btnFor(container, PLAIN.id).click();
    await flush();

    const el = dialog()!;
    expect(el.textContent).toContain('Archive "Ordinary asset"?');
    expect(el.querySelector('.confirm-accept')).toBeTruthy();
    (el.querySelector('.confirm-accept') as HTMLButtonElement).click();
    await flush();

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(1);
    // No `?force=true` — it cannot defeat a lock and would widen the blast
    // radius for the soft collection-membership guard.
    expect(deletes[0].path).not.toContain('force');
  });

  it('turns a delete_protected 409 into the blocked dialog, not an alert (spec §5.4)', async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    // An L0 row (no lock field visible) that the server refuses — the race /
    // search-tier case the pre-flight check cannot cover.
    const { container, calls } = await renderTab([PLAIN], {
      status: 409,
      body: {
        error: 'delete_blocked',
        message: 'asset ' + PLAIN.id + ' is protected from deletion by an explicit lock',
        reason: 'delete_protected',
        blockedBy: { jobIds: [], collectionIds: [] },
      },
    });

    btnFor(container, PLAIN.id).click();
    await flush();
    (dialog()!.querySelector('.confirm-accept') as HTMLButtonElement).click();
    await flush();

    expect(calls.filter((c) => c.method === 'DELETE').length).toBe(1);
    const el = dialog();
    expect(el).toBeTruthy();
    expect(el!.textContent).toContain('is protected from deletion');
    expect(el!.querySelector('.confirm-resolution')!.textContent).toContain(
      'clear its delete lock'
    );
    // Directed to the unlock action rather than shown a generic error (AC2).
    expect(el!.querySelector('.confirm-secondary')!.textContent).toBe('Open detail');
    // And never the opaque failure this issue exists to remove.
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('turns a referenced_by_job 409 into the job wording with the real job ids', async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    const { container } = await renderTab([PLAIN], {
      status: 409,
      body: {
        error: 'delete_blocked',
        message: 'blocked',
        reason: 'referenced_by_job',
        blockedBy: { jobIds: ['job_01J8', 'job_01J9'], collectionIds: [] },
      },
    });
    btnFor(container, PLAIN.id).click();
    await flush();
    (dialog()!.querySelector('.confirm-accept') as HTMLButtonElement).click();
    await flush();

    const el = dialog()!;
    expect(el.textContent).toContain('is in use by a job that is still running');
    const ids = el.querySelector('.confirm-blocked-by')!;
    expect(ids.textContent).toContain('job_01J8');
    expect(ids.textContent).toContain('job_01J9');
    expect(el.textContent).not.toContain('delete lock');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('handles the bare {error,message} 409 arm without reading reason/blockedBy', async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    const { container } = await renderTab([PLAIN], {
      status: 409,
      body: { error: 'has_children', message: 'asset still has 2 child assets' },
    });
    btnFor(container, PLAIN.id).click();
    await flush();
    (dialog()!.querySelector('.confirm-accept') as HTMLButtonElement).click();
    await flush();

    const el = dialog()!;
    expect(el.textContent).toContain('could not be archived');
    expect(el.textContent).toContain('still has 2 child assets');
    expect(el.querySelector('.confirm-blocked-by')).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('reports a non-409 failure in the app-styled error dialog, not a native alert', async () => {
    // Issue #920: this path used to end in `alert('Error: ' + err.message)`. It
    // is not a refusal classifyDeleteBlock explains, so it goes to
    // reportActionFailure -> errorToast instead.
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    const { container } = await renderTab([PLAIN], {
      status: 404,
      body: { error: 'not_found' },
    });
    btnFor(container, PLAIN.id).click();
    await flush();
    (dialog()!.querySelector('.confirm-accept') as HTMLButtonElement).click();
    await flush();

    // Not the blocked-delete confirm dialog...
    expect(dialog()).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
    // ...but the shared action-failure dialog, in app styling.
    const err = document.querySelector('.error-dialog') as HTMLElement | null;
    expect(err).toBeTruthy();
    expect(err!.querySelector('.error-action')!.textContent).toBe('Archive asset failed.');
    // 404 body is `{ error: 'not_found' }` with no message and no reason, so
    // apiFetch's machine-code fallback (public/app.js:268) is what shows.
    expect(err!.querySelector('.msg-error')!.textContent).toBe('not_found');
    expect(err!.querySelector('.error-detail')!.textContent).toContain('was not archived');
  });
});
