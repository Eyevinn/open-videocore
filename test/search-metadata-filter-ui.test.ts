// @vitest-environment happy-dom
//
// Search-tab metadata filter (issue #850).
//
// The tab offered Query, Tags and container format only, while the search
// endpoint has always accepted free-form operator metadata filters. This suite
// drives the REAL Search tab (public/app.js renderSearchTab) against the REAL
// search router, so the params the UI serialises and the filter the server
// applies are asserted together.
//
// Verified contract (per CLAUDE.md rule 7):
//   - GET /api/v1/search/ metadata params `metadata.<key>=<value>`:
//     src/routes/search.ts, head-of-file doc block ("Free-form operator
//     metadata (issue #12) is filtered with `metadata.<key>=<value>` query
//     params").
//   - `extractMetadataFilter` (src/routes/search.ts:255-270) keeps every query
//     key prefixed `metadata.`, strips the prefix, skips an empty field name,
//     and collapses a REPEATED param to its first value
//     (`Array.isArray(value) ? value[0] : value`).
//   - The extracted object is passed as `metadata` in the same
//     `repo.search({ q, tags, mimeType, metadata, … })` call as the other
//     filters (src/routes/search.ts:377-394), so pairs combine with each other
//     and with q/tags/mimeType.
//   - Matching is EXACT on key and value: src/data/search-repo.ts:393-397
//     (`if (md[key] !== value) return false`) over the asset's own `metadata`
//     object (src/data/asset-repo.ts:619).
//   - These params are deliberately absent from openapi.json's
//     "/api/v1/search/" get.parameters[] (q, tags, mimeType, status, from, to,
//     tamsFlowId, tamsTimerange, page, pageSize) — a free-form key cannot be
//     enumerated statically, so the route source above is the contract of
//     record for the param name.
//   - Response envelope `{ assets, collections, total, collectionTotal, page }`:
//     src/routes/search.ts searchResultSchema.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerAuth } from '../src/auth/middleware.js';
import { searchRouter } from '../src/routes/search.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemorySearchRepository } from '../src/data/inmemory-search-repo.js';
import {
  renderSearchTab,
  appendMetadataFilterParams,
  readSearchMetadataPairs,
  SEARCH_METADATA_HINT,
  SEARCH_METADATA_LEGEND,
} from '../public/app.js';

// Every /search request this tab issued, newest last — so a test can assert
// what went on the wire, not only what came back.
let requested: string[] = [];

async function buildApp(repo: InMemoryAssetRepository): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(searchRouter, {
    prefix: '/api/v1/search',
    repository: new InMemorySearchRepository(repo),
  });
  await app.ready();
  return app;
}

async function runSearch(section: Element): Promise<void> {
  (section.querySelector('#search-btn') as HTMLButtonElement).click();
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Fill the Nth (0-based) metadata row, adding rows as needed.
function setPair(section: Element, index: number, key: string, value: string): void {
  const addBtn = section.querySelector('#search-md-add') as HTMLButtonElement;
  while (section.querySelectorAll('.search-md-row').length <= index) {
    addBtn.click();
  }
  const row = section.querySelectorAll('.search-md-row')[index]!;
  (row.querySelector('.search-md-key') as HTMLInputElement).value = key;
  (row.querySelector('.search-md-value') as HTMLInputElement).value = value;
}

function resultNames(section: Element): string[] {
  return [...section.querySelectorAll('#search-results tbody tr')].map(
    (tr) => tr.textContent ?? ''
  );
}

describe('metadata filter serialisation (issue #850)', () => {
  it('serialises each pair as metadata.<key>=<value>', () => {
    const params = new URLSearchParams();
    appendMetadataFilterParams(params, [
      { key: 'genre', value: 'documentary' },
      { key: 'language', value: 'sv' },
    ]);
    expect(params.toString()).toBe('metadata.genre=documentary&metadata.language=sv');
  });

  it('keeps the other filters alongside the pairs', () => {
    const params = new URLSearchParams();
    params.set('q', 'nordic');
    params.set('tags', 'news');
    params.set('mimeType', 'video/mp4');
    appendMetadataFilterParams(params, [{ key: 'genre', value: 'documentary' }]);
    expect(params.get('q')).toBe('nordic');
    expect(params.get('tags')).toBe('news');
    expect(params.get('mimeType')).toBe('video/mp4');
    expect(params.get('metadata.genre')).toBe('documentary');
  });

  // Acceptance criterion: a cleared pair leaves the query, rather than becoming
  // an exact-match filter for the empty string.
  it('emits nothing for an empty or whitespace-only value', () => {
    const params = new URLSearchParams();
    appendMetadataFilterParams(params, [
      { key: 'genre', value: '' },
      { key: 'language', value: '   ' },
    ]);
    expect(params.toString()).toBe('');
    expect([...params.keys()]).not.toContain('metadata.genre');
  });

  it('skips a pair with an empty key, even when it has a value', () => {
    const params = new URLSearchParams();
    appendMetadataFilterParams(params, [
      { key: '', value: 'documentary' },
      { key: '   ', value: 'sv' },
    ]);
    expect(params.toString()).toBe('');
  });

  it('trims both sides so a stray space is not part of the exact match', () => {
    const params = new URLSearchParams();
    appendMetadataFilterParams(params, [{ key: '  genre  ', value: '  documentary  ' }]);
    expect(params.get('metadata.genre')).toBe('documentary');
  });

  // extractMetadataFilter keeps only the FIRST value of a repeated param, so a
  // duplicated key must not ship as two params.
  it('collapses a repeated key to one param rather than appending', () => {
    const params = new URLSearchParams();
    appendMetadataFilterParams(params, [
      { key: 'genre', value: 'documentary' },
      { key: 'genre', value: 'drama' },
    ]);
    expect(params.getAll('metadata.genre')).toEqual(['drama']);
    expect(params.toString()).toBe('metadata.genre=drama');
  });

  it('tolerates no pairs at all', () => {
    expect(appendMetadataFilterParams(new URLSearchParams(), []).toString()).toBe('');
    expect(appendMetadataFilterParams(new URLSearchParams(), undefined).toString()).toBe('');
  });
});

describe('Search tab metadata filter (issue #850)', () => {
  let app: FastifyInstance;
  let repo: InMemoryAssetRepository;
  let container: HTMLElement;
  let section: HTMLElement;

  beforeEach(async () => {
    repo = new InMemoryAssetRepository();
    await repo.create({
      name: 'Nordic Winters',
      metadata: { genre: 'documentary', language: 'sv' },
    });
    await repo.create({
      name: 'Harbour Drama',
      metadata: { genre: 'drama', language: 'sv' },
    });
    await repo.create({
      name: 'Desert Doc',
      metadata: { genre: 'documentary', language: 'en' },
    });
    await repo.create({ name: 'Untagged Rushes' });

    app = await buildApp(repo);
    requested = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      requested.push(u.pathname + u.search);
      const res = await app.inject({
        method: (init.method as never) || 'GET',
        url: u.pathname + u.search,
        headers: init.headers as Record<string, string>,
        payload: init.body as never,
      });
      return new Response(res.body, {
        status: res.statusCode,
        headers: res.headers as Record<string, string>,
      });
    });
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    await renderSearchTab(container);
    section = container.querySelector('.section') as HTMLElement;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it('offers a metadata key/value row without a click', () => {
    const rows = section.querySelectorAll('.search-md-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector('.search-md-key')).not.toBeNull();
    expect(rows[0]!.querySelector('.search-md-value')).not.toBeNull();
    expect(section.querySelector('#search-md-add')).not.toBeNull();
  });

  // Acceptance criterion: one pair filters the result set.
  it('filters by a single metadata pair', async () => {
    setPair(section, 0, 'genre', 'documentary');
    await runSearch(section);

    expect(requested.at(-1)).toContain('metadata.genre=documentary');
    const names = resultNames(section);
    expect(names).toHaveLength(2);
    expect(names.join(' ')).toContain('Nordic Winters');
    expect(names.join(' ')).toContain('Desert Doc');
    expect(names.join(' ')).not.toContain('Harbour Drama');
  });

  // Acceptance criterion: multiple pairs combine (every pair must match).
  it('narrows further when a second pair is added', async () => {
    setPair(section, 0, 'genre', 'documentary');
    setPair(section, 1, 'language', 'sv');
    await runSearch(section);

    const sent = requested.at(-1)!;
    expect(sent).toContain('metadata.genre=documentary');
    expect(sent).toContain('metadata.language=sv');
    const names = resultNames(section);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('Nordic Winters');
  });

  // Acceptance criterion: pairs combine with the existing filters.
  it('combines a pair with the free-text query', async () => {
    (section.querySelector('#search-q') as HTMLInputElement).value = 'desert';
    setPair(section, 0, 'genre', 'documentary');
    await runSearch(section);

    const sent = requested.at(-1)!;
    expect(sent).toContain('q=desert');
    expect(sent).toContain('metadata.genre=documentary');
    const names = resultNames(section);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('Desert Doc');
  });

  // Acceptance criterion: clearing a pair removes it from the query.
  it('drops a cleared pair from the request instead of sending an empty value', async () => {
    setPair(section, 0, 'genre', 'documentary');
    setPair(section, 1, 'language', 'en');
    await runSearch(section);
    expect(requested.at(-1)).toContain('metadata.language=en');

    (section.querySelectorAll('.search-md-row')[1]!.querySelector(
      '.search-md-value'
    ) as HTMLInputElement).value = '';
    await runSearch(section);
    const sent = requested.at(-1)!;
    expect(sent).toContain('metadata.genre=documentary');
    expect(sent).not.toContain('metadata.language');
    expect(resultNames(section)).toHaveLength(2);
  });

  it('drops a removed row from the request', async () => {
    setPair(section, 0, 'genre', 'documentary');
    setPair(section, 1, 'language', 'en');
    (section.querySelectorAll('.search-md-row')[1]!.querySelector(
      '.search-md-remove'
    ) as HTMLButtonElement).click();

    expect(readSearchMetadataPairs(section)).toEqual([
      { key: 'genre', value: 'documentary' },
    ]);
    await runSearch(section);
    const sent = requested.at(-1)!;
    expect(sent).toContain('metadata.genre=documentary');
    expect(sent).not.toContain('metadata.language');
  });

  it('keeps one blank row after the last one is removed', () => {
    setPair(section, 0, 'genre', 'documentary');
    (section.querySelector('.search-md-remove') as HTMLButtonElement).click();
    const rows = section.querySelectorAll('.search-md-row');
    expect(rows).toHaveLength(1);
    expect((rows[0]!.querySelector('.search-md-key') as HTMLInputElement).value).toBe('');
  });

  it('sends no metadata param when the rows are untouched', async () => {
    (section.querySelector('#search-q') as HTMLInputElement).value = 'nordic';
    await runSearch(section);
    expect(requested.at(-1)).not.toContain('metadata.');
  });

  // Acceptance criterion: the copy must not promise partial/fuzzy matching,
  // because src/data/search-repo.ts compares with !==.
  it('says the match is exact and never suggests partial matching', () => {
    const legend = section.querySelector('.search-md-legend');
    expect(legend?.textContent).toBe(SEARCH_METADATA_LEGEND);
    expect(legend?.textContent).toMatch(/exact/i);
    const hint = section.querySelector('#search-md-hint');
    expect(hint?.textContent).toBe(SEARCH_METADATA_HINT);
    expect(hint?.textContent).toMatch(/exactly/i);
    const copy = (legend?.textContent ?? '') + ' ' + (hint?.textContent ?? '');
    expect(copy).not.toMatch(/partial|substring|contains|fuzzy|starts with|wildcard/i);
    // The value field asks for an exact value rather than "search value".
    const valueLabel = section.querySelector(
      'label[for="' + (section.querySelector('.search-md-value') as HTMLInputElement).id + '"]'
    );
    expect(valueLabel?.textContent).toMatch(/exact/i);
  });

  // The group has to be reachable and announced: a real fieldset/legend, a
  // <label for> per input, and a distinct accessible name per remove button.
  it('labels every control (WCAG 1.3.1 / 4.1.2)', () => {
    const fieldset = section.querySelector('fieldset.search-md-fieldset') as HTMLFieldSetElement;
    expect(fieldset).not.toBeNull();
    expect(fieldset.querySelector('legend')).not.toBeNull();
    expect(fieldset.getAttribute('aria-describedby')).toBe('search-md-hint');

    (section.querySelector('#search-md-add') as HTMLButtonElement).click();
    const rows = [...section.querySelectorAll('.search-md-row')];
    expect(rows).toHaveLength(2);
    const names: string[] = [];
    rows.forEach((row) => {
      row.querySelectorAll('input').forEach((input) => {
        const label = section.querySelector('label[for="' + input.id + '"]');
        expect(label).not.toBeNull();
        expect(label!.textContent!.trim().length).toBeGreaterThan(0);
        names.push(label!.textContent!);
      });
      const remove = row.querySelector('.search-md-remove') as HTMLButtonElement;
      names.push(remove.getAttribute('aria-label')!);
      expect(remove.getAttribute('aria-label')).toMatch(/metadata filter \d+/);
    });
    // Four inputs + two buttons, each with its own accessible name.
    expect(new Set(names).size).toBe(6);
  });
});
