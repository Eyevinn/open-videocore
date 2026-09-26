// @vitest-environment happy-dom
//
// Search-tab format filter (issue #822).
//
// The field was labelled "MIME type" with the placeholder "video/mp4", but the
// filter compared that value against the probe-extracted container format, which
// is never a MIME type. Typing the field's OWN placeholder returned an empty
// result set indistinguishable from "no assets match".
//
// This suite drives the REAL Search tab (public/app.js renderSearchTab) through
// the REAL search router, so the UI's vocabulary and the server's match
// semantics are asserted together — the exact seam where the defect lived.
//
// Verified contract (per CLAUDE.md rule 7):
//   - GET /api/v1/search/ query parameter `mimeType`: src/routes/search.ts
//     searchQuerySchema.mimeType; mirrored in openapi.json
//     "/api/v1/search/".get.parameters[] { "name": "mimeType", "in": "query" }.
//   - Response envelope `{ assets, collections, total, collectionTotal, page }`:
//     src/routes/search.ts searchResultSchema.
//   - Asset hit shape: src/routes/search.ts assetSchema — there is NO `mimeType`
//     field; the container lives at `technicalMetadata.containerFormat`
//     (technicalMetadataSchema, src/routes/search.ts:40-49), which is why the
//     results table now reads that path.
//   - Stored container value: ffprobe `format.format_name`, copied verbatim by
//     src/pipeline/metadata-extractor.ts:125 — e.g. "mov,mp4,m4a,3gp,3g2,mj2".
//   - UI request path: apiFetch (public/app.js) supplies the bearer the 401
//     presence gate requires (authGate, src/auth/middleware.ts:76-87).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerAuth } from '../src/auth/middleware.js';
import { searchRouter } from '../src/routes/search.js';
import { InMemoryAssetRepository, type TechnicalMetadata } from '../src/data/asset-repo.js';
import { InMemorySearchRepository } from '../src/data/inmemory-search-repo.js';
import {
  renderSearchTab,
  SEARCH_FORMAT_LABEL,
  SEARCH_FORMAT_PLACEHOLDER,
} from '../public/app.js';

// A probe result as the extractor actually persists it: format_name is a
// comma-separated family, not a tidy single token.
function probed(containerFormat: string): TechnicalMetadata {
  return {
    codec: 'h264',
    width: 1920,
    height: 1080,
    durationSeconds: 10,
    bitrateBps: 5_000_000,
    containerFormat,
    audioTracks: [],
    extractedAt: new Date().toISOString(),
  };
}

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

// Run the tab's search and wait for the results pane to settle.
async function runSearch(section: Element): Promise<void> {
  (section.querySelector('#search-btn') as HTMLButtonElement).click();
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('Search tab format filter (issue #822)', () => {
  let app: FastifyInstance;
  let repo: InMemoryAssetRepository;
  let container: HTMLElement;

  beforeEach(async () => {
    repo = new InMemoryAssetRepository();
    const mp4 = await repo.create({ name: 'Probed MP4' });
    await repo.update(mp4.id, { technicalMetadata: probed('mov,mp4,m4a,3gp,3g2,mj2') });
    const webm = await repo.create({ name: 'Probed WebM' });
    await repo.update(webm.id, { technicalMetadata: probed('matroska,webm') });

    app = await buildApp(repo);
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
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
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it('labels the field for what is actually matched', () => {
    const label = container.querySelector('label[for="search-mime"]') as HTMLLabelElement;
    expect(label.textContent).toBe(SEARCH_FORMAT_LABEL);
    // The old label claimed MIME type alone, which the filter never matched.
    expect(label.textContent).toMatch(/container/i);
    const hint = container.querySelector('#search-mime-hint');
    expect(hint?.textContent).toMatch(/container format/i);
  });

  // The acceptance criterion, driven end to end: type the field's OWN
  // placeholder and get the matching asset back rather than nothing.
  it('returns the MP4 asset when the placeholder value is typed verbatim', async () => {
    const section = container.querySelector('.section') as HTMLElement;
    const input = section.querySelector('#search-mime') as HTMLInputElement;
    expect(input.placeholder).toBe(SEARCH_FORMAT_PLACEHOLDER);
    expect(input.placeholder).toBe('video/mp4');

    input.value = input.placeholder;
    await runSearch(section);

    const results = section.querySelector('#search-results') as HTMLElement;
    expect(results.querySelector('.empty')).toBeNull();
    const rows = results.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Probed MP4');
  });

  it('renders the container format in the results, not an em dash', async () => {
    const section = container.querySelector('.section') as HTMLElement;
    (section.querySelector('#search-mime') as HTMLInputElement).value = 'video/mp4';
    await runSearch(section);

    const results = section.querySelector('#search-results') as HTMLElement;
    const headers = [...results.querySelectorAll('th')].map((th) => th.textContent);
    expect(headers).toContain('Container');
    const cells = [...results.querySelectorAll('tbody tr td')].map((td) => td.textContent);
    expect(cells).toContain('mov,mp4,m4a,3gp,3g2,mj2');
  });

  it('also accepts a bare container token', async () => {
    const section = container.querySelector('.section') as HTMLElement;
    (section.querySelector('#search-mime') as HTMLInputElement).value = 'webm';
    await runSearch(section);

    const rows = section.querySelectorAll('#search-results tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Probed WebM');
  });

  // Acceptance criterion 3: a value that cannot match anything is visibly
  // different from a search that legitimately found nothing. The server rejects
  // the unmatchable value (400 unsupported_mime_type) and the tab surfaces that
  // message instead of the neutral "No results." empty state.
  it('distinguishes an unmatchable value from an empty result set', async () => {
    const section = container.querySelector('.section') as HTMLElement;
    const input = section.querySelector('#search-mime') as HTMLInputElement;

    input.value = 'video/not-a-real-type';
    await runSearch(section);
    const results = section.querySelector('#search-results') as HTMLElement;
    expect(results.querySelector('.empty')).toBeNull();
    expect(results.textContent).toContain('video/not-a-real-type');
    expect(results.textContent).toMatch(/container format/i);

    // Contrast: a legitimate miss still reads as an ordinary empty result.
    input.value = 'avi';
    await runSearch(section);
    expect(results.querySelector('.empty')?.textContent).toBe('No results.');
  });
});
