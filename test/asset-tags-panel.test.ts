// @vitest-environment happy-dom
//
// Tags panel on the asset detail view (issue #934, broken out of #792): tags can
// be added and removed from the detail view, the list on screen is always the
// server's answer (no stale UI), and invalid input is refused CLIENT-SIDE using
// the API's own constraints rather than by round-tripping into a rejection.
//
// Three layers, in order:
//   1. CONTRACT MIRROR — drives the REAL assets router with `app.inject` and
//      asserts the client's exported bounds against what the API actually
//      accepts and refuses. This is what keeps the client-side validation from
//      drifting away from the schema it claims to mirror (AC3).
//   2. Pure helpers.
//   3. Integration through the REAL detail renderer (renderAssetDetailBody — the
//      same path the asset side panel and the detached detail window use)
//      against a stubbed fetch.
//
// CONTRACT GROUNDING — every path, field, method and status below was read from
// this repo's route source and generated spec before the tests were written
// (CLAUDE.md rule 7), never from the issue text:
//
//   openapi.json .paths["/api/v1/assets/{id}/tags"] — exactly ONE operation,
//     `post`. There is no GET: the list is the optional `tags` array on the
//     asset body (`assetSchema`, src/routes/assets.ts:919).
//     .post.requestBody: required: true, application/json, schema
//       { tags: { type: 'array', items: { type: 'string', minLength: 1,
//       maxLength: 128 }, minItems: 1, maxItems: 128 } },
//       required ['tags'], additionalProperties: false.
//     .post.responses: exactly 200 (the FULL asset) and 404.
//     Source: app.post('/:id/tags', …) src/routes/assets.ts:5568-5590; body
//       schema :5574; APPEND + dedupe at :5583 via `normalizeTags`
//       (src/data/asset-repo.ts:1297-1308).
//   openapi.json .paths["/api/v1/assets/{id}/tags/{tag}"] — exactly `delete`.
//     parameters: path `id` (string) and path `tag` (string, minLength 1).
//     responses: exactly 200 (the FULL asset) and 404.
//     Source: app.delete('/:id/tags/:tag', …) src/routes/assets.ts:5595-5618;
//       filter at :5609.
//   Bounds mirrored client-side: `tagSchema = z.string().min(1).max(128)`
//     (src/routes/assets.ts:398) and `tagsSchema = z.array(tagSchema).max(128)`
//     (:399). No pattern, no charset, no case rule anywhere.
//   Authorisation: `MATRIX` (src/auth/authorize.ts:54-58) — viewer
//     { read: true, write: false, delete: false }; `methodToAction` (:79-93)
//     POST → write, DELETE → delete; gate registered for the whole assets
//     router at src/routes/assets.ts:1773; 403 code
//     `AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role'`
//     (src/auth/authorize.ts:99). Role header `x-ovc-role` (ROLE_HEADER,
//     src/auth/principal.ts:36).
//   Production Fastify config `maxParamLength: 500` (src/main.ts:185) — the
//     harness below mirrors it, because Fastify's default of 100 would 404 the
//     removal of any tag longer than 100 characters.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      if (token !== 'token-a') throw new actual.AuthError('invalid token');
      return 'workspace-a';
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { registerPrincipal } from '../src/auth/principal.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { renderAssetDetailBody } from '../public/app.js';
import {
  TAGS_COPY,
  TAG_MAX_LENGTH,
  TAG_MIN_LENGTH,
  TAGS_MAX_TOTAL,
  addTagRequestBody,
  classifyTagError,
  mountAssetTags,
  normaliseTagInput,
  readTags,
  renderTagList,
  tagAddedMessage,
  tagPath,
  tagRemovedMessage,
  tagsPath,
} from '../public/asset-tags.js';

const ULID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';
const AUTH = { authorization: 'Bearer token-a' };

// ─────────────────────────────────────────────────────────────────────────────
// 1. Contract mirror: the client's bounds vs. the real router
// ─────────────────────────────────────────────────────────────────────────────

async function buildApi(): Promise<FastifyInstance> {
  // maxParamLength mirrors src/main.ts:185; Fastify's default (100) would 404
  // the DELETE of a long tag the POST happily accepts.
  const app = Fastify({ maxParamLength: 500 });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  registerPrincipal(app, { trustRoleHeader: true });
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: new InMemoryAssetRepository()
  });
  await app.ready();
  return app;
}

describe('tag constraints mirrored client-side match the live contract (issue #934 AC3)', () => {
  let api: FastifyInstance;
  let id: string;

  beforeEach(async () => {
    api = await buildApi();
    const created = await api.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: AUTH,
      payload: { name: 'tags-fixture' }
    });
    id = created.json().id as string;
  });

  const addTags = (tags: unknown[], role?: string) =>
    api.inject({
      method: 'POST',
      url: '/api/v1/assets/' + id + '/tags',
      headers: role ? { ...AUTH, 'x-ovc-role': role } : AUTH,
      payload: { tags }
    });

  // The UI builds its DELETE URL with `tagPath`, so the test uses `tagPath`
  // itself (minus the client's `/assets` base) — the encoding under test is the
  // encoding that ships.
  const removeTag = (tag: string, role?: string) =>
    api.inject({
      method: 'DELETE',
      url: '/api/v1' + tagPath(id, tag),
      headers: role ? { ...AUTH, 'x-ovc-role': role } : AUTH
    });

  it('accepts a tag at exactly TAG_MAX_LENGTH and refuses one character more', async () => {
    const atMax = await addTags(['x'.repeat(TAG_MAX_LENGTH)]);
    expect(atMax.statusCode).toBe(200);
    expect(atMax.json().tags).toContain('x'.repeat(TAG_MAX_LENGTH));

    const overMax = await addTags(['y'.repeat(TAG_MAX_LENGTH + 1)]);
    // `tagSchema.max(128)`, rejected by the schema compiler before the handler.
    expect(overMax.statusCode).toBe(400);
    // 400 is NOT declared on this operation, which is why the panel validates
    // first rather than treating this envelope as a modelled error body.
    expect(overMax.json().code).toBe('FST_ERR_VALIDATION');
  });

  it('refuses a tag shorter than TAG_MIN_LENGTH', async () => {
    expect(TAG_MIN_LENGTH).toBe(1);
    const res = await addTags(['']);
    expect(res.statusCode).toBe(400);
  });

  it('refuses an empty tag array — the panel never sends one', async () => {
    // `minItems: 1`. `addTagRequestBody` always carries exactly one tag.
    const res = await addTags([]);
    expect(res.statusCode).toBe(400);
    expect(addTagRequestBody('promo').tags).toHaveLength(1);
  });

  it('allows ANY characters in a tag, and removes every one of them again', async () => {
    // The schema has no pattern and no charset: a client-side character rule
    // would refuse input the API accepts. Each of these is added and then
    // removed through the exact path `tagPath` builds.
    const odd = [
      'with/slash',
      'with space',
      'with#hash',
      'with?query',
      'with%25percent',
      'ÅÄÖ-ünï',
      'UPPER.case',
      'ü'.repeat(TAG_MAX_LENGTH),
    ];
    const added = await addTags(odd);
    expect(added.statusCode).toBe(200);
    expect(added.json().tags).toEqual(odd);

    for (const tag of odd) {
      const res = await removeTag(tag);
      expect(res.statusCode).toBe(200);
      expect(res.json().tags).not.toContain(tag);
    }
    expect(readTags(await (await removeTag('absent')).json())).toEqual([]);
  });

  it('appends and deduplicates rather than replacing, in first-seen order', async () => {
    await addTags(['a', 'b']);
    const res = await addTags(['b', 'c']);
    expect(res.statusCode).toBe(200);
    // Existing tags kept, duplicate collapsed, server order preserved — which
    // is why the panel renders the RETURNED list instead of appending locally.
    expect(res.json().tags).toEqual(['a', 'b', 'c']);
  });

  it('treats removing a tag the asset does not have as a 200 no-op', async () => {
    await addTags(['keep']);
    const res = await removeTag('never-existed');
    expect(res.statusCode).toBe(200);
    expect(res.json().tags).toEqual(['keep']);
  });

  it('404s both mutations for an unknown asset, and for a slug instead of a ULID', async () => {
    const slug = (
      await api.inject({ method: 'GET', url: '/api/v1/assets/' + id, headers: AUTH })
    ).json().slug as string;
    expect(typeof slug).toBe('string');

    const bySlug = await api.inject({
      method: 'POST',
      url: '/api/v1/assets/' + slug + '/tags',
      headers: AUTH,
      payload: { tags: ['x'] }
    });
    expect(bySlug.statusCode).toBe(404);

    const unknown = await api.inject({
      method: 'DELETE',
      url: '/api/v1/assets/01JNOSUCHASSETXXXXXXXXXXXX/tags/x',
      headers: AUTH
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('not_found');
  });

  it('refuses both mutations to a viewer and allows both to an editor', async () => {
    const viewerAdd = await addTags(['nope'], 'viewer');
    expect(viewerAdd.statusCode).toBe(403);
    expect(viewerAdd.json().error).toBe('forbidden_insufficient_role');
    expect(viewerAdd.json().action).toBe('write');

    await addTags(['present']);
    const viewerRemove = await removeTag('present', 'viewer');
    expect(viewerRemove.statusCode).toBe(403);
    // DELETE maps to the `delete` action, which a viewer also lacks — so the
    // panel hides the remove buttons for a viewer too, not just the add row.
    expect(viewerRemove.json().action).toBe('delete');

    expect((await addTags(['editor-added'], 'editor')).statusCode).toBe(200);
    expect((await removeTag('editor-added', 'editor')).statusCode).toBe(200);
  });

  it('documents the list cap TAGS_MAX_TOTAL that the append route does not enforce', async () => {
    // `tagsSchema.max(128)` is the declared cap on the list. POST does not
    // re-check it, so repeated appends really do pass it; PATCH — which
    // replaces the list wholesale — then refuses the very list POST created.
    // The panel honours the declared cap, so it never builds this state.
    const full = await addTags(Array.from({ length: TAGS_MAX_TOTAL }, (_, i) => 't' + i));
    expect(full.statusCode).toBe(200);
    expect(full.json().tags).toHaveLength(TAGS_MAX_TOTAL);

    const over = await addTags(['one-too-many']);
    expect(over.statusCode).toBe(200);
    expect(over.json().tags).toHaveLength(TAGS_MAX_TOTAL + 1);

    const patch = await api.inject({
      method: 'PATCH',
      url: '/api/v1/assets/' + id,
      headers: AUTH,
      payload: { tags: over.json().tags }
    });
    expect(patch.statusCode).toBe(400);

    // Client-side: the 129th tag is refused before any request is made.
    const atCap = Array.from({ length: TAGS_MAX_TOTAL }, (_, i) => 't' + i);
    expect(normaliseTagInput('one-too-many', atCap)).toMatchObject({
      ok: false,
      reason: 'list-full',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('readTags (the asset body is the only source of the list)', () => {
  it('treats absent and empty as the same thing: no tags', () => {
    // Both really occur — CouchDB drops the key when empty
    // (src/data/asset-document.ts:692), the in-memory repo returns [].
    expect(readTags({ id: ULID })).toEqual([]);
    expect(readTags({ id: ULID, tags: [] })).toEqual([]);
  });

  it('preserves the server order verbatim and never sorts', () => {
    expect(readTags({ tags: ['zulu', 'alpha', 'mike'] })).toEqual(['zulu', 'alpha', 'mike']);
  });

  it('drops values it could not send back to the remove route', () => {
    expect(readTags({ tags: ['ok', 7, null, '', {}] as unknown[] })).toEqual(['ok']);
  });

  it('survives a non-object or non-array payload', () => {
    expect(readTags(null)).toEqual([]);
    expect(readTags({ tags: 'promo' })).toEqual([]);
  });
});

describe('normaliseTagInput mirrors the API bounds and nothing more', () => {
  it('accepts a plain tag', () => {
    expect(normaliseTagInput('promo', [])).toEqual({
      value: 'promo',
      ok: true,
      reason: null,
      message: null,
    });
  });

  it('refuses empty and whitespace-only input', () => {
    expect(normaliseTagInput('', [])).toMatchObject({ ok: false, reason: 'empty' });
    // The API would actually STORE "   " (verified); it is invisible in every
    // rendering of a tag, so the client refuses it — the same rule the rename
    // dialog applies to a name.
    expect(normaliseTagInput('   ', [])).toMatchObject({ ok: false, reason: 'empty' });
    expect(normaliseTagInput(undefined, [])).toMatchObject({ ok: false, reason: 'empty' });
    expect(normaliseTagInput('', []).message).toBe(TAGS_COPY.errEmpty);
  });

  it('accepts exactly TAG_MAX_LENGTH characters and refuses one more', () => {
    expect(normaliseTagInput('x'.repeat(TAG_MAX_LENGTH), []).ok).toBe(true);
    const over = normaliseTagInput('x'.repeat(TAG_MAX_LENGTH + 1), []);
    expect(over).toMatchObject({ ok: false, reason: 'too-long' });
    expect(over.message).toBe(TAGS_COPY.errTooLong);
  });

  it('counts characters, not bytes — a 128-character non-ASCII tag is valid', () => {
    // zod's .max() counts UTF-16 code units; the API accepts it (verified
    // against the real router above), so the client must not refuse it.
    expect(normaliseTagInput('ü'.repeat(TAG_MAX_LENGTH), []).ok).toBe(true);
  });

  it('trims surrounding whitespace and sends the trimmed value', () => {
    expect(normaliseTagInput('  promo  ', [])).toMatchObject({ ok: true, value: 'promo' });
  });

  it('adds NO character rule of its own', () => {
    // Every one of these is accepted by the API (verified in the contract
    // mirror above), so every one of them must pass here.
    [
      'with/slash',
      'with space',
      'with#hash',
      'with?query',
      'with%25percent',
      'ÅÄÖ-ünï',
      'UPPER.case',
      '<script>alert(1)</script>',
      '2026-10-02',
      'emoji-🎬',
    ].forEach((tag) => {
      expect(normaliseTagInput(tag, [])).toMatchObject({ ok: true, value: tag });
    });
  });

  it('refuses a tag the asset already has, case-sensitively', () => {
    const dup = normaliseTagInput('promo', ['promo']);
    expect(dup).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(dup.message).toBe(TAGS_COPY.errDuplicate);
    // The API treats case as significant, so `Promo` is a different tag.
    expect(normaliseTagInput('Promo', ['promo']).ok).toBe(true);
    // ...and trimming happens BEFORE the duplicate check.
    expect(normaliseTagInput(' promo ', ['promo'])).toMatchObject({ reason: 'duplicate' });
  });

  it('refuses the tag that would push the list past the declared cap', () => {
    const atCap = Array.from({ length: TAGS_MAX_TOTAL }, (_, i) => 't' + i);
    expect(normaliseTagInput('extra', atCap)).toMatchObject({
      ok: false,
      reason: 'list-full',
    });
    // One below the cap is still fine.
    expect(normaliseTagInput('extra', atCap.slice(1)).ok).toBe(true);
  });
});

describe('request construction', () => {
  it('sends exactly the one declared property, carrying one tag', () => {
    expect(addTagRequestBody('promo')).toEqual({ tags: ['promo'] });
    // additionalProperties: false — no sibling key, ever.
    expect(Object.keys(addTagRequestBody('promo'))).toEqual(['tags']);
  });

  it('encodes the path so every acceptable tag is removable', () => {
    expect(tagsPath(ULID)).toBe('/assets/' + ULID + '/tags');
    expect(tagPath(ULID, 'with/slash')).toBe('/assets/' + ULID + '/tags/with%2Fslash');
    expect(tagPath(ULID, 'with space')).toBe('/assets/' + ULID + '/tags/with%20space');
    expect(tagPath(ULID, 'with#hash')).toBe('/assets/' + ULID + '/tags/with%23hash');
    expect(tagPath(ULID, 'with?query')).toBe('/assets/' + ULID + '/tags/with%3Fquery');
    expect(tagPath(ULID, '100%')).toBe('/assets/' + ULID + '/tags/100%25');
  });
});

describe('tag error classification', () => {
  it('maps the role gate to the role sentence and keeps the list', () => {
    const c = classifyTagError({
      status: 403,
      body: { error: 'forbidden_insufficient_role', action: 'delete', role: 'viewer' },
    });
    expect(c.kind).toBe('forbidden');
    expect(c.message).toBe(TAGS_COPY.errForbidden);
    // The machine code and the observability fields are never shown.
    expect(c.message).not.toMatch(/forbidden_insufficient_role|resourceType/);
  });

  it('maps 404 to "the asset is gone" and asks for a re-read', () => {
    // Both handlers 404 only on an unknown asset: an unknown TAG is a 200 no-op.
    const c = classifyTagError({ status: 404, body: { error: 'not_found' } });
    expect(c).toMatchObject({ kind: 'not-found', message: TAGS_COPY.errNotFound, refresh: true });
  });

  it('maps a 400/422 the client rules missed to a rejection plus a re-read', () => {
    expect(classifyTagError({ status: 400 })).toMatchObject({
      kind: 'rejected',
      message: TAGS_COPY.errRejected,
      refresh: true,
    });
    expect(classifyTagError({ status: 422 }).kind).toBe('rejected');
  });

  it('reports a transport failure as "nothing changed"', () => {
    const c = classifyTagError(new Error('fetch failed') as never);
    expect(c).toMatchObject({ kind: 'other', message: TAGS_COPY.errNetwork, refresh: false });
  });
});

describe('renderTagList', () => {
  it('renders one labelled remove button per tag', () => {
    const { listEl, removeButtons } = renderTagList(['promo', 'ÅÄÖ'], { canChange: true });
    expect(listEl.tagName).toBe('UL');
    expect(listEl.getAttribute('aria-label')).toBe(TAGS_COPY.listLabel);
    expect(listEl.querySelectorAll('li').length).toBe(2);
    expect(removeButtons).toHaveLength(2);
    // The accessible name names the tag, so a screen-reader user is not left
    // with a row of identical "Remove" buttons.
    expect(removeButtons[0].getAttribute('aria-label')).toBe('Remove tag “promo”');
    expect(removeButtons[1].getAttribute('data-tag')).toBe('ÅÄÖ');
    expect(removeButtons[0].tagName).toBe('BUTTON');
  });

  it('offers no remove control when the role cannot delete', () => {
    const { listEl, removeButtons } = renderTagList(['promo'], { canChange: false });
    expect(removeButtons).toEqual([]);
    expect(listEl.querySelector('button')).toBeNull();
    expect(listEl.textContent).toContain('promo');
  });

  it('states the empty case instead of rendering an empty list', () => {
    const { listEl } = renderTagList([], { canChange: true });
    expect(listEl.textContent).toBe(TAGS_COPY.empty);
    expect(listEl.querySelector('li')).toBeNull();
  });

  it('renders a tag as TEXT, never as markup', () => {
    const { listEl } = renderTagList(['<img src=x onerror=alert(1)>'], { canChange: true });
    expect(listEl.querySelector('img')).toBeNull();
    expect(listEl.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The panel, mounted on its own and through the real detail renderer
// ─────────────────────────────────────────────────────────────────────────────

const ASSET = {
  id: ULID,
  name: 'promo-cut.mov',
  slug: 'promo-cut',
  status: 'ready',
  tags: ['promo', 'q4'],
  statusHistory: [{ at: '2026-09-20T10:00:00.000Z', from: null, to: 'ready' }],
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

type Outcome = { status: number; body: unknown };

/**
 * Route by path, serving the detail renderer's other reads with empty answers.
 * `assetGet` is a thunk so a test can change what a re-read returns.
 */
function routedFetch(
  assetGet: () => Outcome,
  onMutate?: (method: string, url: string, body: unknown) => Outcome
) {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const path = String(url);
    const method = (opts && opts.method) || 'GET';
    if (/\/tags(\/|$)/.test(path) && method !== 'GET') {
      const parsed = opts && opts.body ? JSON.parse(String(opts.body)) : undefined;
      const out = onMutate
        ? onMutate(method, path, parsed)
        : { status: 200, body: ASSET };
      return json(out.body, out.status);
    }
    if (/\/review-state$/.test(path)) {
      return json({ reviewState: 'draft', allowedTransitions: ['in-review'] });
    }
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) {
      const out = assetGet();
      return json(out.body, out.status);
    }
    return json({}, 200);
  });
}

async function settle(ticks = 30) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** The tags the panel is currently showing, in order. */
function shownTags(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('#asset-tags-list .tag-chip-label')).map(
    (n) => n.textContent || ''
  );
}

function blockText(root: ParentNode): string {
  const block = root.querySelector('#asset-tags');
  return ((block && block.textContent) || '').replace(/\s+/g, ' ').trim();
}

function removeButton(root: ParentNode, tag: string): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(
    '#asset-tags-list .tag-remove[data-tag="' + tag + '"]'
  );
}

describe('asset detail — tags panel (issue #934)', () => {
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

  it('shows the asset tags with no extra request, and no second rendering of the list', async () => {
    const fetchSpy = routedFetch(() => ({ status: 200, body: ASSET }));
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(blockText(container)).toContain(TAGS_COPY.heading);
    expect(shownTags(container)).toEqual(['promo', 'q4']);

    // There is no GET sub-resource, and the panel must not invent one.
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => /\/tags$/.test(u))).toBe(false);

    // Exactly ONE place renders the list: the old read-only key/value row is
    // gone, so a mutation cannot leave a stale copy behind.
    const kv = container.querySelector('.kv-grid')!;
    expect(kv.textContent).not.toContain('Tags');
    expect(kv.querySelector('.tag')).toBeNull();
  });

  it('adds a tag, sending exactly the declared body to the declared path', async () => {
    let tags = ['promo', 'q4'];
    const fetchSpy = routedFetch(
      () => ({ status: 200, body: { ...ASSET, tags } }),
      (method, _url, body) => {
        expect(method).toBe('POST');
        tags = tags.concat((body as { tags: string[] }).tags);
        return { status: 200, body: { ...ASSET, tags } };
      }
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const input = container.querySelector<HTMLInputElement>('#asset-tag-input')!;
    input.value = '  launch/2026  ';
    container.querySelector<HTMLButtonElement>('#asset-tag-add')!.click();
    await settle();

    const post = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    // API_BASE may be absolute, so match the path suffix.
    expect(String(post[0]).endsWith('/api/v1/assets/' + ULID + '/tags')).toBe(true);
    // Trimmed, one tag, the single declared property.
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ tags: ['launch/2026'] });

    expect(shownTags(container)).toEqual(['promo', 'q4', 'launch/2026']);
    expect(blockText(container)).toContain(tagAddedMessage('launch/2026'));
    // The field is cleared and ready for the next tag.
    expect(input.value).toBe('');
  });

  it('adds a tag on Enter as well as on the button', async () => {
    const fetchSpy = routedFetch(
      () => ({ status: 200, body: ASSET }),
      (_m, _u, body) => ({
        status: 200,
        body: { ...ASSET, tags: ['promo', 'q4'].concat((body as { tags: string[] }).tags) },
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const input = container.querySelector<HTMLInputElement>('#asset-tag-input')!;
    input.value = 'keyboard-only';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(shownTags(container)).toContain('keyboard-only');
  });

  it('renders the list the SERVER returned, not the list the client expected', async () => {
    // The server dedupes and keeps its own order (`normalizeTags`), and another
    // operator may have changed the list in the meantime. The panel must show
    // the returned list verbatim.
    const fetchSpy = routedFetch(
      () => ({ status: 200, body: ASSET }),
      () => ({ status: 200, body: { ...ASSET, tags: ['someone-else', 'promo', 'q4', 'added'] } })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLInputElement>('#asset-tag-input')!.value = 'added';
    container.querySelector<HTMLButtonElement>('#asset-tag-add')!.click();
    await settle();

    expect(shownTags(container)).toEqual(['someone-else', 'promo', 'q4', 'added']);
  });

  it('removes a tag through the encoded single-tag path and redraws from the response', async () => {
    const odd = 'with/slash';
    let tags = ['promo', odd, 'q4'];
    const fetchSpy = routedFetch(
      () => ({ status: 200, body: { ...ASSET, tags } }),
      (method, url) => {
        expect(method).toBe('DELETE');
        const removed = decodeURIComponent(String(url).split('/tags/')[1]);
        tags = tags.filter((t) => t !== removed);
        return { status: 200, body: { ...ASSET, tags } };
      }
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(shownTags(container)).toEqual(['promo', odd, 'q4']);
    removeButton(container, odd)!.click();
    await settle();

    const del = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')!;
    expect(String(del[0]).endsWith('/api/v1/assets/' + ULID + '/tags/with%2Fslash')).toBe(true);
    expect((del[1] as RequestInit).body).toBeUndefined();

    expect(shownTags(container)).toEqual(['promo', 'q4']);
    expect(removeButton(container, odd)).toBeNull();
    expect(blockText(container)).toContain(tagRemovedMessage(odd));
  });

  it('falls back to the empty state when the last tag is removed', async () => {
    const fetchSpy = routedFetch(
      () => ({ status: 200, body: { ...ASSET, tags: ['only'] } }),
      // The CouchDB projection DROPS the key when the list is empty — the panel
      // must read that as "no tags", not as "unknown".
      () => ({ status: 200, body: { ...ASSET, tags: undefined } })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    removeButton(container, 'only')!.click();
    await settle();

    expect(shownTags(container)).toEqual([]);
    expect(blockText(container)).toContain(TAGS_COPY.empty);
  });

  it('refuses invalid input client-side without making a request', async () => {
    const fetchSpy = routedFetch(() => ({ status: 200, body: ASSET }));
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const input = container.querySelector<HTMLInputElement>('#asset-tag-input')!;
    const addBtn = container.querySelector<HTMLButtonElement>('#asset-tag-add')!;
    const errorEl = container.querySelector<HTMLElement>('#asset-tag-error')!;
    const mutations = () =>
      fetchSpy.mock.calls.filter((c) => {
        const m = (c[1] as RequestInit | undefined)?.method;
        return m === 'POST' || m === 'DELETE';
      });

    const cases: Array<[string, string]> = [
      ['', TAGS_COPY.errEmpty],
      ['    ', TAGS_COPY.errEmpty],
      ['x'.repeat(TAG_MAX_LENGTH + 1), TAGS_COPY.errTooLong],
      ['promo', TAGS_COPY.errDuplicate],
    ];
    for (const [value, message] of cases) {
      input.value = value;
      addBtn.click();
      await settle(3);
      expect(errorEl.textContent).toBe(message);
      expect(errorEl.getAttribute('role')).toBe('alert');
      expect(errorEl.style.display).not.toBe('none');
      // Nothing was sent, and what was typed is still there to be fixed.
      expect(mutations()).toHaveLength(0);
      expect(input.value).toBe(value);
    }

    // Typing clears the refusal rather than leaving it shouting.
    input.value = 'fixed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(errorEl.style.display).toBe('none');

    // The field also carries the bound at the keyboard, and its rule in words.
    expect(input.maxLength).toBe(TAG_MAX_LENGTH);
    expect(blockText(container)).toContain(String(TAG_MAX_LENGTH));
    // The list is untouched by every refusal above.
    expect(shownTags(container)).toEqual(['promo', 'q4']);
  });

  it('retires the controls on a 403 instead of inviting a guaranteed failure', async () => {
    const fetchSpy = routedFetch(
      () => ({ status: 200, body: ASSET }),
      () => ({
        status: 403,
        body: {
          error: 'forbidden_insufficient_role',
          message: 'role viewer may not write a asset',
          action: 'write',
          resourceType: 'asset',
          role: 'viewer',
        },
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLInputElement>('#asset-tag-input')!.value = 'nope';
    container.querySelector<HTMLButtonElement>('#asset-tag-add')!.click();
    await settle();

    expect(blockText(container)).toContain(TAGS_COPY.errForbidden);
    expect(container.querySelector('.tags-add-row')).toBeNull();
    expect(container.querySelectorAll('.tag-remove')).toHaveLength(0);
    // The tags themselves stay visible, and the machine code is never shown.
    expect(shownTags(container)).toEqual(['promo', 'q4']);
    expect(blockText(container)).not.toMatch(/forbidden_insufficient_role|resourceType/);
  });

  it('re-reads the list after a 404 rather than leaving a stale list on screen', async () => {
    // Another operator removed `q4` between this panel loading and the click.
    let served = ['promo', 'q4'];
    const fetchSpy = routedFetch(
      () => ({ status: 200, body: { ...ASSET, tags: served } }),
      () => {
        served = ['promo'];
        return { status: 404, body: { error: 'not_found' } };
      }
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    removeButton(container, 'q4')!.click();
    await settle();

    expect(blockText(container)).toContain(TAGS_COPY.errNotFound);
    expect(shownTags(container)).toEqual(['promo']);
  });

  it('re-reads the list after an undeclared rejection', async () => {
    let served = ['promo', 'q4'];
    const fetchSpy = routedFetch(
      () => ({ status: 200, body: { ...ASSET, tags: served } }),
      () => {
        served = ['promo', 'q4', 'landed-anyway'];
        return {
          status: 400,
          body: { statusCode: 400, code: 'FST_ERR_VALIDATION', message: 'body/tags/0 …' },
        };
      }
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    container.querySelector<HTMLInputElement>('#asset-tag-input')!.value = 'landed-anyway';
    container.querySelector<HTMLButtonElement>('#asset-tag-add')!.click();
    await settle();

    expect(blockText(container)).toContain(TAGS_COPY.errRejected);
    // Whatever the server really holds is what is shown.
    expect(shownTags(container)).toEqual(['promo', 'q4', 'landed-anyway']);
    expect(blockText(container)).not.toMatch(/FST_ERR_VALIDATION/);
  });

  it('keeps the list on screen when the network drops, and says nothing changed', async () => {
    const fetchSpy = vi.fn(async (url: string, opts?: RequestInit) => {
      const method = (opts && opts.method) || 'GET';
      if (/\/tags(\/|$)/.test(String(url)) && method !== 'GET') throw new Error('fetch failed');
      return routedFetch(() => ({ status: 200, body: ASSET }))(url, opts);
    });
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    removeButton(container, 'promo')!.click();
    await settle();

    expect(blockText(container)).toContain(TAGS_COPY.errNetwork);
    expect(shownTags(container)).toEqual(['promo', 'q4']);
    // The controls are usable again, not left disabled.
    expect(removeButton(container, 'promo')!.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('#asset-tag-add')!.disabled).toBe(false);
  });

  it('offers a viewer no controls, and still shows the tags', async () => {
    localStorage.setItem('ovc_role', 'viewer');
    vi.stubGlobal('fetch', routedFetch(() => ({ status: 200, body: ASSET })));

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(shownTags(container)).toEqual(['promo', 'q4']);
    expect(container.querySelector('#asset-tag-input')).toBeNull();
    expect(container.querySelector('#asset-tag-add')).toBeNull();
    expect(container.querySelectorAll('.tag-remove')).toHaveLength(0);
    expect(blockText(container)).toContain(TAGS_COPY.readOnly);
  });

  it('renders a hostile tag as text and still removes it', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    let tags = [hostile];
    const fetchSpy = routedFetch(
      () => ({ status: 200, body: { ...ASSET, tags } }),
      () => {
        tags = [];
        return { status: 200, body: { ...ASSET, tags } };
      }
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(container.querySelector('#asset-tags img')).toBeNull();
    expect(shownTags(container)).toEqual([hostile]);

    container.querySelector<HTMLButtonElement>('#asset-tags-list .tag-remove')!.click();
    await settle();

    const del = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')!;
    expect(String(del[0]).endsWith('/api/v1' + tagPath(ULID, hostile))).toBe(true);
    expect(shownTags(container)).toEqual([]);
  });

  it('moves focus to a surviving control after a removal (keyboard operation continues)', async () => {
    let tags = ['a', 'b', 'c'];
    const apiFetch = vi.fn(async (path: string, opts?: RequestInit) => {
      if (opts && opts.method === 'DELETE') {
        tags = tags.filter((t) => t !== decodeURIComponent(path.split('/tags/')[1]));
        return { ...ASSET, tags };
      }
      return { ...ASSET, tags };
    });

    const host = document.createElement('div');
    container.appendChild(host);
    const panel = mountAssetTags({
      asset: { ...ASSET, tags },
      host,
      canChange: true,
      apiFetch: apiFetch as unknown as (p: string, o?: RequestInit) => Promise<unknown>,
    });

    removeButton(host, 'b')!.click();
    await settle();

    expect(panel.tags()).toEqual(['a', 'c']);
    // Focus lands on the control that took the removed chip's place.
    expect((document.activeElement as HTMLElement).getAttribute('data-tag')).toBe('c');

    removeButton(host, 'c')!.click();
    await settle();
    removeButton(host, 'a')!.click();
    await settle();

    expect(panel.tags()).toEqual([]);
    // Nothing left to focus in the list: focus goes to the add field.
    expect((document.activeElement as HTMLElement).id).toBe('asset-tag-input');
  });
});
