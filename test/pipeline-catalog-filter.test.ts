// @vitest-environment happy-dom
//
// Pipelines tab — the catalog pills FILTER the executions list (issue #831).
//
// The strip at the top of the Pipelines tab rendered each pipeline as an inert
// <span> that still lit up on hover and carried a tooltip: an affordance with
// nothing behind it, and unreachable by keyboard. These tests drive the REAL
// renderer (renderPipelinesTab, public/app.js) against a stubbed fetch and
// assert the pills are buttons, that activating one narrows the list, that the
// choice rides in the URL under the shared table-url-state namespace, and that
// a filter matching nothing explains itself instead of looking broken.
//
// CONTRACT GROUNDING (CLAUDE.md rule 7) — every field and param below was read
// from this repo's own route source and generated spec before the test was
// written, never from the issue text:
//
//   GET /api/v1/pipelines/ — querystring schema, src/routes/pipelines.ts:105-109:
//     status? (running|done|failed), limit? (int 1..200), offset? (int >=0).
//     Mirrored in openapi.json .paths["/api/v1/pipelines/"].get.parameters,
//     which declares exactly those three (the spec assigns this operation no
//     operationId; it is keyed by path + method). There is NO pipeline-name
//     parameter, which is why the pill narrows the already-fetched page
//     client-side instead of sending a key the route would reject.
//   200 body — { items: PipelineExecution[], total: number }
//     (listResponseSchema, src/routes/pipelines.ts:65-68).
//   PipelineExecution — pipelineExecutionSchema, src/routes/pipelines.ts:54-63;
//     the generated 200 item schema lists required: id, assetId, pipelineName,
//     status, steps, createdAt, updatedAt, with additionalProperties: false and
//     pipelineName: { type: 'string' }. So `pipelineName` is always present —
//     the field the filter compares on.
//   steps[] — stepExecutionSchema, src/routes/pipelines.ts:25-52: required
//     name + status; name enum includes extract-metadata | thumbnail |
//     subtitles | scene-detect | transcode | package.
//   GET /api/v1/provision/{name} — the stored stack config read by
//     loadOptionalStepAvailability() (public/app.js): `options.autoSubtitles` /
//     `options.sceneDetect`, falling back to autoSubtitlesInstanceName /
//     sceneDetectInstanceName (storedConfigSchema, src/routes/provision.ts).
//     Used here only to produce the is-unavailable pill state of issue #790.
//
//   URL state — public/table-url-state.js: the fixed key schema PARAM_KEYS
//   (table-url-state.js:72-84) and encodeTableState()'s per-namespace delete
//   loop (table-url-state.js:452-453), which is why the catalog's own
//   `pipelines.pipeline` key survives a re-encode, exactly as the audit table's
//   extra keys do (public/audit-table.js:144-150, 574-579).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  renderPipelinesTab,
  normalizePipelineFilter,
  readPipelineFilterFromUrl,
  applyPipelineFilterToUrl,
  filterExecutionsByPipeline,
  pipelineFilterSummary,
  pipelineFilterEmptyText,
  PIPELINE_FILTER_PARAM,
  PIPELINES_NS,
  EXEC_LIST_LIMIT,
  PIPELINE_CATALOG,
} from '../public/app.js';

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// Executions in the exact shape of the 200 above: two `abr-vod` runs and one
// `transcode` run. No `running` status, so the renderer does not arm its poll.
function execution(id: string, pipelineName: string, status = 'done') {
  return {
    id,
    assetId: '01J9BBBBBBBBBBBBBBBBBBBB' + id.slice(-2),
    assetName: 'clip-' + id + '.mov',
    pipelineName,
    status,
    steps: [{ name: 'transcode', status: status === 'failed' ? 'failed' : 'done' }],
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:05:00.000Z',
  };
}

const ITEMS = [
  execution('01J9AAAAAAAAAAAAAAAAAAAA01', 'abr-vod'),
  execution('01J9AAAAAAAAAAAAAAAAAAAA02', 'transcode', 'failed'),
  execution('01J9AAAAAAAAAAAAAAAAAAAA03', 'abr-vod'),
];

type StubOpts = {
  items?: unknown[];
  // Stored stack config for GET /provision/{name}. `null` -> no stack selected
  // at all (localStorage untouched), so availability fails open.
  config?: Record<string, unknown> | null;
};

function stubFetch(opts: StubOpts = {}) {
  const items = opts.items ?? ITEMS;
  const urls: string[] = [];
  const fetchStub = vi.fn(async (url: unknown) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('/provision/')) return json(opts.config ?? {});
    if (u.includes('/pipelines')) return json({ items, total: items.length });
    return json({});
  });
  vi.stubGlobal('fetch', fetchStub);
  return { fetchStub, urls };
}

function pipelineRequests(urls: string[]) {
  return urls.filter((u) => u.includes('/pipelines'));
}

async function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  await renderPipelinesTab(container);
  await flush();
  return container;
}

function pills(root: ParentNode) {
  return [...root.querySelectorAll('.pipeline-catalog-pill')] as HTMLElement[];
}

function pill(root: ParentNode, name: string) {
  const found = pills(root).find((p) => p.dataset.pipeline === name);
  if (!found) throw new Error('no pill for pipeline ' + name);
  return found;
}

function renderedPipelineNames(root: ParentNode) {
  return [...root.querySelectorAll('.pipeline-exec-row .pipeline-exec-name')].map(
    (el) => el.textContent
  );
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('pipeline catalog filter helpers (issue #831)', () => {
  it('accepts only a pipeline the catalog can show a pill for', () => {
    expect(normalizePipelineFilter('abr-vod')).toBe('abr-vod');
    expect(normalizePipelineFilter('  ingest  ')).toBe('ingest');
    // Tolerant like every other param in the shared contract: a value with no
    // pill to light up degrades to "all" rather than stranding the operator on
    // an empty list with no visible control to clear.
    expect(normalizePipelineFilter('not-a-pipeline')).toBeNull();
    expect(normalizePipelineFilter('')).toBeNull();
    expect(normalizePipelineFilter(null as unknown as string)).toBeNull();
    expect(normalizePipelineFilter(42 as unknown as string)).toBeNull();
  });

  it('filters a fetched page on the contract field `pipelineName`', () => {
    expect(filterExecutionsByPipeline(ITEMS, 'abr-vod').map((e) => e.id)).toEqual([
      ITEMS[0].id,
      ITEMS[2].id,
    ]);
    // No filter means the whole page, and a hostile input never throws.
    expect(filterExecutionsByPipeline(ITEMS, null)).toHaveLength(3);
    expect(filterExecutionsByPipeline(undefined as unknown as [], 'abr-vod')).toEqual([]);
  });

  it('summarises the filter as a count AND a name, not a colour', () => {
    expect(pipelineFilterSummary(null, 3, 3)).toContain('all 3');
    const text = pipelineFilterSummary('abr-vod', 2, 3);
    expect(text).toContain('2 of 3');
    // The catalog label, not the raw name, so the line reads like the pill.
    expect(text).toContain('ABR VOD');
  });

  it('explains an empty filtered view, naming the unconfigured step when there is one', () => {
    const lines = pipelineFilterEmptyText('abr-vod', {});
    expect(lines[0]).toBe('No executions for this pipeline.');
    // Honest about the bound it actually searched: the page the tab fetched.
    expect(lines[1]).toContain(String(EXEC_LIST_LIMIT));

    // `subtitles` is a single optional step; with it unconfigured the whole
    // pipeline is unavailable, and the empty state says so.
    const unavail = pipelineFilterEmptyText('subtitles', { subtitles: false });
    expect(unavail.join(' ')).toContain('not configured for this stack');
  });

  it('writes the filter into the URL under the shared table-url-state namespace', () => {
    // Injected window: pure assertion on the relative URL produced, with a
    // foreign namespace's param and the hash both present.
    let applied: string | null = null;
    const win = {
      location: { pathname: '/ops', search: '?assets.q=promo', hash: '#panel' },
      history: {
        state: null,
        replaceState: (_s: unknown, _t: unknown, url: string) => {
          applied = url;
        },
      },
    };

    applyPipelineFilterToUrl('ingest', win as unknown as Window);
    expect(applied).not.toBeNull();
    expect(applied!).toContain(PIPELINES_NS + '.' + 'pipeline=ingest');
    expect(PIPELINE_FILTER_PARAM).toBe('pipelines.pipeline');
    // Other tables' params and the path/hash survive untouched.
    expect(applied!).toContain('assets.q=promo');
    expect(applied!.startsWith('/ops?')).toBe(true);
    expect(applied!.endsWith('#panel')).toBe(true);

    // Clearing removes only this key.
    const win2 = {
      location: { pathname: '/ops', search: '?assets.q=promo&pipelines.pipeline=ingest', hash: '' },
      history: {
        state: null,
        replaceState: (_s: unknown, _t: unknown, url: string) => {
          applied = url;
        },
      },
    };
    applyPipelineFilterToUrl(null, win2 as unknown as Window);
    expect(applied!).toContain('assets.q=promo');
    expect(applied!).not.toContain('pipelines.pipeline');
  });

  it('is SSR/sandbox safe: no window means no filter and no throw', () => {
    expect(readPipelineFilterFromUrl({} as unknown as Window)).toBeNull();
    expect(applyPipelineFilterToUrl('ingest', {} as unknown as Window)).toBe('');
  });
});

// ─── The rendered tab ────────────────────────────────────────────────────────

describe('renderPipelinesTab catalog pills (issue #831)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    window.history.replaceState(null, '', '/');
    localStorage.clear();
  });

  it('renders every pipeline as a keyboard-reachable button, not a clickable span', async () => {
    stubFetch();
    const container = await render();

    const rendered = pills(container);
    expect(rendered).toHaveLength(PIPELINE_CATALOG.length);
    // The regression this issue is about: no inert <span> wearing the pill class.
    expect(container.querySelectorAll('span.pipeline-catalog-pill')).toHaveLength(0);
    for (const p of rendered) {
      expect(p.tagName).toBe('BUTTON');
      // type=button: a native button is activated by Enter AND Space with no
      // key handler of our own, and must not submit anything.
      expect((p as HTMLButtonElement).type).toBe('button');
      expect((p as HTMLButtonElement).disabled).toBe(false);
      // In the tab order (never tabindex=-1) and actually focusable.
      expect(p.getAttribute('tabindex')).toBeNull();
      p.focus();
      expect(document.activeElement).toBe(p);
      // Toggle semantics are exposed to assistive tech, so the active state is
      // not conveyed by styling alone.
      expect(p.getAttribute('aria-pressed')).toBe('false');
      expect(p.dataset.pipeline).toBeTruthy();
    }
    // The strip announces what the buttons are for.
    const bar = container.querySelector('.pipeline-catalog-bar')!;
    expect(bar.getAttribute('role')).toBe('group');
    expect(bar.getAttribute('aria-label')).toContain('pipeline');
  });

  it('clicking a pill filters the executions list and marks that pill active', async () => {
    const { urls } = stubFetch();
    const container = await render();
    expect(renderedPipelineNames(container)).toHaveLength(3);

    pill(container, 'abr-vod').click();
    await flush();

    expect(renderedPipelineNames(container)).toEqual(['abr-vod', 'abr-vod']);
    // Visually distinct from hover (hover is CSS-only; the active state is a
    // class + aria-pressed), and exclusive.
    const active = pills(container).filter((p) => p.classList.contains('is-active'));
    expect(active.map((p) => p.dataset.pipeline)).toEqual(['abr-vod']);
    expect(pill(container, 'abr-vod').getAttribute('aria-pressed')).toBe('true');
    expect(pill(container, 'transcode').getAttribute('aria-pressed')).toBe('false');
    // Filtering is client-side over the page already fetched — no second
    // request, because the route has no pipeline-name parameter to send.
    expect(pipelineRequests(urls)).toHaveLength(1);
    expect(pipelineRequests(urls)[0]).toContain('limit=' + EXEC_LIST_LIMIT);
    expect(pipelineRequests(urls)[0]).not.toContain('pipeline=');
  });

  it('clicking the active pill again clears the filter without reloading', async () => {
    const { urls } = stubFetch();
    const container = await render();

    pill(container, 'abr-vod').click();
    await flush();
    expect(renderedPipelineNames(container)).toHaveLength(2);

    pill(container, 'abr-vod').click();
    await flush();

    expect(renderedPipelineNames(container)).toHaveLength(3);
    expect(pills(container).some((p) => p.classList.contains('is-active'))).toBe(false);
    expect(window.location.search).not.toContain(PIPELINE_FILTER_PARAM);
    expect(pipelineRequests(urls)).toHaveLength(1);
  });

  it('offers an explicit "show all" control while a filter is in force', async () => {
    stubFetch();
    const container = await render();

    const clear = container.querySelector('.pipeline-exec-filter-clear') as HTMLButtonElement;
    expect(clear.tagName).toBe('BUTTON');
    // Nothing to clear yet.
    expect(clear.hidden).toBe(true);

    pill(container, 'transcode').click();
    await flush();
    expect(clear.hidden).toBe(false);
    const status = container.querySelector('.pipeline-exec-filter-text')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toContain('1 of 3');

    clear.click();
    await flush();
    expect(renderedPipelineNames(container)).toHaveLength(3);
    expect(clear.hidden).toBe(true);
  });

  it('reflects the filter in the URL and restores it on a fresh render (reload)', async () => {
    stubFetch();
    const container = await render();

    pill(container, 'transcode').click();
    await flush();
    expect(window.location.search).toContain('pipelines.pipeline=transcode');

    // Simulate the reload: the URL persists, the DOM does not.
    const url = window.location.pathname + window.location.search;
    document.body.innerHTML = '';
    window.history.replaceState(null, '', url);

    const reloaded = await render();
    expect(renderedPipelineNames(reloaded)).toEqual(['transcode']);
    expect(pill(reloaded, 'transcode').getAttribute('aria-pressed')).toBe('true');
  });

  it('ignores a garbled filter param rather than rendering an uncontrollable empty list', async () => {
    stubFetch();
    window.history.replaceState(null, '', '/?pipelines.pipeline=<script>');
    const container = await render();

    expect(renderedPipelineNames(container)).toHaveLength(3);
    expect(pills(container).some((p) => p.classList.contains('is-active'))).toBe(false);
  });

  it('explains an empty filtered view instead of looking broken, and offers a way back', async () => {
    stubFetch();
    const container = await render();

    // `ingest` is in the catalog but has no run in the fetched page.
    pill(container, 'ingest').click();
    await flush();

    expect(container.querySelectorAll('.pipeline-exec-row')).toHaveLength(0);
    const empty = container.querySelector('.pipeline-exec-empty')!;
    expect(empty).toBeTruthy();
    expect(empty.textContent).toContain('No executions for this pipeline.');
    // Not the "nothing has ever run" message, which would be a different claim.
    expect(container.textContent).not.toContain('No pipeline executions yet.');

    const back = [...empty.querySelectorAll('button')].find((b) =>
      /show all/i.test(b.textContent || '')
    ) as HTMLButtonElement;
    expect(back).toBeTruthy();
    back.click();
    await flush();
    expect(renderedPipelineNames(container)).toHaveLength(3);
  });

  it('hands focus back to the cleared pill, so a keyboard user is not dropped on <body>', async () => {
    stubFetch();
    const container = await render();

    // Clearing from the status line: that button hides itself.
    pill(container, 'abr-vod').click();
    await flush();
    const clear = container.querySelector('.pipeline-exec-filter-clear') as HTMLButtonElement;
    clear.click();
    await flush();
    expect(document.activeElement).toBe(pill(container, 'abr-vod'));

    // Clearing from the empty state: that button is re-rendered away.
    pill(container, 'ingest').click();
    await flush();
    const back = [
      ...container.querySelectorAll('.pipeline-exec-empty button'),
    ].find((b) => /show all/i.test(b.textContent || '')) as HTMLButtonElement;
    back.click();
    await flush();
    expect(document.activeElement).toBe(pill(container, 'ingest'));
  });

  it('still says "no executions yet" when the whole page is empty', async () => {
    stubFetch({ items: [] });
    const container = await render();
    expect(container.textContent).toContain('No pipeline executions yet.');
    expect(container.querySelector('.pipeline-exec-empty')).toBeNull();
  });

  it('keeps an unconfigured pipeline filterable, and says why it has no runs', async () => {
    // A stack whose optional services were never provisioned: `options` is
    // absent and both *InstanceName fields are empty, which is the
    // GET /provision/{name} shape loadOptionalStepAvailability() reads.
    localStorage.setItem('ovc_stack', 'demo-stack');
    stubFetch({ config: { name: 'demo-stack' } });
    const container = await render();

    const subtitles = pill(container, 'subtitles');
    expect(subtitles.classList.contains('is-unavailable')).toBe(true);
    // Dimmed, never disabled: "has this stack ever run it?" is a fair question.
    expect((subtitles as HTMLButtonElement).disabled).toBe(false);

    subtitles.click();
    await flush();

    expect(subtitles.getAttribute('aria-pressed')).toBe('true');
    expect(window.location.search).toContain('pipelines.pipeline=subtitles');
    const empty = container.querySelector('.pipeline-exec-empty')!;
    expect(empty.textContent).toContain('No executions for this pipeline.');
    expect(empty.textContent).toContain('not configured for this stack');
  });
});
