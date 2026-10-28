// @vitest-environment happy-dom
//
// Pipeline execution detail — per-step timeline (issue #964).
//
// The detail used to end in a raw JSON dump that buried the step-level values an
// operator needs to trace a run. These tests drive the REAL renderer
// (renderPipelineDetailBody — the same code path used by the pipelines tab and
// the detached detail window, public/app.js) against a stubbed fetch, and assert
// the curated timeline exists, that both job identifiers are copyable, and that
// the raw document is still present but collapsed.
//
// CONTRACT GROUNDING (CLAUDE.md rule 7) — every field name below was read from
// this repo's route source and generated spec before the test was written,
// never from the issue text:
//
//   GET /api/v1/pipelines/{executionId} — `pipelineExecutionSchema`,
//   src/routes/pipelines.ts:32-41, mirrored in openapi.json
//   .paths["/api/v1/pipelines/{executionId}"].get.responses["200"]:
//     required: id, assetId, pipelineName, status, steps, createdAt, updatedAt
//     optional: assetName
//     status enum: running | done | failed
//     additionalProperties: false
//
//   steps[] — `stepExecutionSchema`, src/routes/pipelines.ts:17-30:
//     required: name, status
//     optional: jobId, encoreJobId, error, skipReason, startedAt, completedAt,
//               progress
//     name enum:   extract-metadata | thumbnail | subtitles | scene-detect |
//                  transcode | package
//     status enum: pending | running | done | failed | skipped
//   So `jobId`, `encoreJobId`, `startedAt` and `completedAt` are each OPTIONAL:
//   a pending step carries none of them, and the row must still render.
//
//   The copy control is the shared one (public/copy-id.js): button class
//   COPY_ID_BTN_CLASS, value on `data-copy-id`, wired by wireCopyIdButtons().

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPipelineDetailBody } from '../public/app.js';
import { COPY_ID_BTN_CLASS } from '../public/copy-id.js';

const EXEC_ID = '01J9AAAAAAAAAAAAAAAAAAAAAA';
const ASSET_ID = '01J9BBBBBBBBBBBBBBBBBBBBBB';

// Fixture in the exact shape of the 200 above. `extract-metadata` is finished,
// `transcode` is running with both job handles, `package` has not started.
const EXEC = {
  id: EXEC_ID,
  assetId: ASSET_ID,
  assetName: 'promo-cut.mov',
  pipelineName: 'transcode-and-package',
  status: 'running',
  steps: [
    {
      name: 'extract-metadata',
      status: 'done',
      jobId: 'job-metadata-1',
      startedAt: '2026-09-30T10:00:00.000Z',
      completedAt: '2026-09-30T10:00:12.000Z',
    },
    {
      name: 'transcode',
      status: 'running',
      jobId: 'job-transcode-2',
      encoreJobId: 'enc-7f3c9a21',
      progress: 42,
      startedAt: '2026-09-30T10:00:12.000Z',
    },
    {
      name: 'package',
      status: 'pending',
    },
  ],
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:03:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function stubExec(body: unknown = EXEC, status = 200) {
  const spy = vi.fn(async () => json(body, status));
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function settle(ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function timeline(root: ParentNode): HTMLTableElement | null {
  return root.querySelector('#pipeline-step-timeline');
}

/** Text of each cell of the step rows (error rows excluded). */
function stepRowCells(root: ParentNode): string[][] {
  return Array.from(root.querySelectorAll('#pipeline-step-timeline tbody tr.step-row')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())
  );
}

function copyValues(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('.' + COPY_ID_BTN_CLASS)).map(
    (b) => b.getAttribute('data-copy-id') || ''
  );
}

describe('pipeline execution detail — per-step timeline (issue #964)', () => {
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

  it('renders one row per step, not only a JSON dump', async () => {
    stubExec();
    await renderPipelineDetailBody(EXEC_ID, container);
    await settle();

    const table = timeline(container);
    expect(table).not.toBeNull();

    const headers = Array.from(table!.querySelectorAll('thead th')).map((th) =>
      (th.textContent || '').trim()
    );
    // Every field the issue names has its own column.
    expect(headers).toEqual([
      'Step',
      'Status',
      'Progress',
      'Job',
      'Encore job',
      'Started',
      'Completed',
    ]);

    const rows = stepRowCells(container);
    expect(rows).toHaveLength(EXEC.steps.length);
    expect(rows.map((r) => r[0])).toEqual(['extract-metadata', 'transcode', 'package']);
    expect(rows.map((r) => r[1])).toEqual(['done', 'running', 'pending']);
  });

  it('shows each step its jobId, encoreJobId and both timestamps', async () => {
    stubExec();
    await renderPipelineDetailBody(EXEC_ID, container);
    await settle();

    const rows = stepRowCells(container);
    const transcode = rows[1];
    expect(transcode[2]).toBe('42%');
    expect(transcode[3]).toContain('job-transcode-2');
    expect(transcode[4]).toContain('enc-7f3c9a21');
    // Timestamps are locale-formatted by fmtDate(); assert they are populated
    // and not the em-dash placeholder rather than pinning a locale string.
    expect(transcode[5]).not.toBe('—');
    expect(transcode[5]).not.toBe('');
    // A running step has no completedAt in the contract — the cell degrades.
    expect(transcode[6]).toBe('—');

    const done = rows[0];
    expect(done[3]).toContain('job-metadata-1');
    expect(done[5]).not.toBe('—');
    expect(done[6]).not.toBe('—');
  });

  it('tolerates a step carrying only the two required fields', async () => {
    stubExec();
    await renderPipelineDetailBody(EXEC_ID, container);
    await settle();

    // `package` has name + status only: jobId, encoreJobId, startedAt,
    // completedAt and progress are all optional and absent here.
    const pending = stepRowCells(container)[2];
    expect(pending[0]).toBe('package');
    expect(pending.slice(2)).toEqual(['—', '—', '—', '—', '—']);
  });

  it('makes the encoreJobId copyable with the shared copy control', async () => {
    stubExec();
    await renderPipelineDetailBody(EXEC_ID, container);
    await settle();

    expect(copyValues(container)).toContain('enc-7f3c9a21');

    const btn = Array.from(
      container.querySelectorAll('.' + COPY_ID_BTN_CLASS)
    ).find((b) => b.getAttribute('data-copy-id') === 'enc-7f3c9a21') as HTMLButtonElement;
    expect(btn).toBeDefined();
    // Wired by wireCopyIdButtons() — an unwired button would copy nothing.
    expect(btn.dataset.copyIdWired).toBe('1');
    // The accessible name distinguishes this row's control from the next one's.
    expect(btn.getAttribute('aria-label')).toContain('transcode');
    expect(btn.getAttribute('aria-label')).toContain('enc-7f3c9a21');

    const writeText = vi.fn(() => Promise.resolve());
    // happy-dom's navigator has no clipboard by default; provide one.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    btn.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith('enc-7f3c9a21');
  });

  it('keeps the raw JSON, collapsed, below the timeline', async () => {
    stubExec();
    await renderPipelineDetailBody(EXEC_ID, container);
    await settle();

    const details = container.querySelector('details.raw-disclosure') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe('Raw');

    const pre = details.querySelector('pre.code-block');
    expect(pre).not.toBeNull();
    // The full document is intact, not a trimmed copy.
    expect(JSON.parse(pre!.textContent || '{}')).toEqual(EXEC);

    // Raw sits AFTER the timeline in document order.
    const table = timeline(container)!;
    expect(table.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps an expanded Raw disclosure open across a poll re-render', async () => {
    stubExec();
    await renderPipelineDetailBody(EXEC_ID, container);
    await settle();

    const first = container.querySelector('details.raw-disclosure') as HTMLDetailsElement;
    first.open = true;

    // detail.js tick() calls the renderer again into the same element while the
    // execution is `running`; that must not snap the dump shut under the operator.
    await renderPipelineDetailBody(EXEC_ID, container);
    await settle();

    const second = container.querySelector('details.raw-disclosure') as HTMLDetailsElement;
    expect(second).not.toBe(first);
    expect(second.open).toBe(true);
  });

  it('renders an empty-steps execution without a timeline table', async () => {
    stubExec({ ...EXEC, steps: [] });
    await renderPipelineDetailBody(EXEC_ID, container);
    await settle();

    expect(timeline(container)).toBeNull();
    expect(container.textContent).toContain('No steps.');
    // Raw is still offered, still collapsed.
    const details = container.querySelector('details.raw-disclosure') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
  });

  it('shows a failed step its full error text inline, spanning the row', async () => {
    const failing = {
      ...EXEC,
      status: 'failed',
      steps: [
        {
          name: 'transcode',
          status: 'failed',
          jobId: 'job-transcode-2',
          encoreJobId: 'enc-7f3c9a21',
          error: 'encode failed: no audio stream in source',
          startedAt: '2026-09-30T10:00:12.000Z',
          completedAt: '2026-09-30T10:00:30.000Z',
        },
      ],
    };
    stubExec(failing);
    await renderPipelineDetailBody(EXEC_ID, container);
    await settle();

    const errCell = container.querySelector('tr.step-error-row td') as HTMLTableCellElement;
    expect(errCell).not.toBeNull();
    expect(errCell.textContent).toBe('encode failed: no audio stream in source');
    // The spanning row must cover every column of the widened timeline.
    const headerCount = container.querySelectorAll('#pipeline-step-timeline thead th').length;
    expect(errCell.getAttribute('colspan')).toBe(String(headerCount));
  });
});
