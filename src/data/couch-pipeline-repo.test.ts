// CouchDB pipeline-repository round-trip for the structured step failure
// detail (issue #1060).
//
// WHAT THIS PROVES
// ----------------
// `CouchPipelineRepository` is the repository wired in PRODUCTION
// (src/services/workspace-stack.ts). Its `fromDoc` does NOT spread the stored
// step object: it rebuilds every step field by field, so a new step field only
// reaches callers if the mapper names it explicitly. The #1060 `errorDetail`
// hydration line is therefore the single thing standing between a persisted
// structured failure and a GET that silently drops it — and the #1060 suite
// otherwise exercises `InMemoryPipelineRepository`, whose `clone()`
// deep-copies the whole step and so passes no matter what the Couch mapper
// does. These tests cover the read path that actually serves the API:
//
//   1. create -> update a FAILED `transcode` step carrying a full
//      `errorDetail` -> read back through `get()` and
//      `findRunningByAssetAndStep()`; the detail, including the nested
//      `source`, survives both.
//   2. a stored `errorDetail` that is NOT a usable detail (string, array,
//      null, `{}`, bad `code`, non-string `message`, `source` without `url`)
//      hydrates the step with NO `errorDetail` — degrading to the pre-#1060
//      behaviour instead of turning a GET of that one document into a 500 on
//      response serialization.
//
// CONTRACTS VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
// ----------------------------------------------------
//   - `CouchPipelineRepository(couchFor: () => StackCouch)` with
//     `.create({ assetId, pipelineName, steps, destinationBucket? })`,
//     `.get(id)`, `.update(id, patch)`, `.listByAsset(assetId)` and
//     `.findRunningByAssetAndStep(assetId, step)` — src/data/couch-pipeline-repo.ts.
//     NOTE: the read-by-id method is `get`, not `findById`.
//   - Documents are stored flat (no partitioning) under `localId` with
//     `resourceType: 'pipeline_execution'`, and `steps` is persisted as whole
//     step objects by `toDoc` — src/data/couch-pipeline-repo.ts.
//   - `StackCouch.get(localId) => Promise<StoredDoc | undefined>`,
//     `StackCouch.put(localId, body) => Promise<{ id; rev }>`,
//     `StackCouch.find(selector, opts?) => Promise<StoredDoc[]>`, and
//     `StoredDoc = { _id; _rev?; resourceType; [key: string]: unknown }` —
//     src/data/couchdb.ts.
//   - `StepExecution = { name; status; jobId?; encoreJobId?; error?;
//     errorDetail?; skipReason?; startedAt?; completedAt?; progress? }` —
//     src/data/pipeline-repo.ts.
//   - `StepErrorDetail = { code; message; storageError?; httpStatus?;
//     source?: { url; bucket?; key? }; encoreJobId?; assetId? }` and the
//     response schema `stepErrorDetailSchema` (code constrained to
//     `STEP_ERROR_CODES`, `message` a required string, `source.url` a required
//     string when `source` is present) — src/pipeline/step-error-detail.ts.
//     Both route copies of `stepExecutionSchema` embed that exact schema
//     (src/routes/pipelines.ts, src/routes/assets.ts), which is why the
//     malformed-document cases below assert against it: anything that hydrates
//     must be something the response can actually carry.
//   - `PIPELINE_STEPS` includes `transcode` and `package` —
//     src/pipeline/pipelines.ts.

import { describe, it, expect } from 'vitest';

import { CouchPipelineRepository } from './couch-pipeline-repo.js';
import type { StepExecution } from './pipeline-repo.js';
import type { StoredDoc, StackCouch } from './couchdb.js';
import { stepErrorDetailSchema } from '../pipeline/step-error-detail.js';

// A minimal multi-document in-memory StackCouch, following the fake-StackCouch
// harness pattern in ./couch-job-repo.test.ts (`makeCouch`): the same
// get/put-over-a-plain-object approach, extended with `find` (a selector match
// on top-level equality, which is all this repository asks Mango for) and a
// document map because pipeline reads go through `find`. `seed` lets a test
// plant a hand-written document — the only way to exercise the mapper against
// a shape the typed write path cannot produce.
function makeCouch(): {
  couch: StackCouch;
  seed: (doc: StoredDoc) => void;
  raw: (id: string) => StoredDoc | undefined;
} {
  const docs = new Map<string, StoredDoc>();
  let revCounter = 0;

  const bumpRev = (): string => {
    revCounter += 1;
    return `${revCounter}-${revCounter.toString(16)}`;
  };

  const couch = {
    async get(id: string): Promise<StoredDoc | undefined> {
      const doc = docs.get(id);
      return doc ? structuredClone(doc) : undefined;
    },
    async put(id: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
      const rev = bumpRev();
      docs.set(id, {
        ...(structuredClone(body) as StoredDoc),
        _id: id,
        resourceType: String(body['resourceType'] ?? 'asset'),
        _rev: rev
      });
      return { id, rev };
    },
    async find(selector: Record<string, unknown>): Promise<StoredDoc[]> {
      return [...docs.values()]
        .filter((doc) => Object.entries(selector).every(([k, v]) => doc[k] === v))
        .map((doc) => structuredClone(doc));
    }
  } as unknown as StackCouch;

  return {
    couch,
    seed: (doc: StoredDoc) => {
      docs.set(doc._id, structuredClone(doc));
    },
    raw: (id: string) => {
      const doc = docs.get(id);
      return doc ? structuredClone(doc) : undefined;
    }
  };
}

// A full structured failure for a source read that 404'd, in the exact shape
// buildSourceReadErrorDetail produces (src/pipeline/encore-source-read-failure.ts):
// every optional field populated, including the nested redacted `source`.
const FULL_DETAIL: NonNullable<StepExecution['errorDetail']> = {
  code: 'source_read_failed',
  message:
    'the transcode source could not be read: storage answered 404 (the object does not exist) ' +
    'for bucket "ovc-media", key "src/missing.mov"',
  storageError:
    'dropped by Encore: ffprobe failed for input s3://ovc-media/src/missing.mov: ' +
    'Server returned 404 Not Found',
  httpStatus: 404,
  source: {
    url: 's3://ovc-media/src/missing.mov',
    bucket: 'ovc-media',
    key: 'src/missing.mov'
  },
  encoreJobId: 'encore-job-7f3c',
  assetId: 'asset-1060'
};

describe('CouchPipelineRepository errorDetail round-trip (#1060)', () => {
  it('preserves a failed transcode step errorDetail through put/get', async () => {
    const { couch, raw } = makeCouch();
    const repo = new CouchPipelineRepository(() => couch);

    const created = await repo.create({
      assetId: 'asset-1060',
      pipelineName: 'full',
      steps: ['transcode', 'package']
    });

    const failedSteps: StepExecution[] = created.steps.map((step) =>
      step.name === 'transcode'
        ? {
            ...step,
            status: 'failed',
            encoreJobId: 'encore-job-7f3c',
            error: FULL_DETAIL.storageError!,
            errorDetail: FULL_DETAIL,
            startedAt: '2026-10-08T07:00:00.000Z',
            completedAt: '2026-10-08T07:01:00.000Z'
          }
        : step
    );
    const updated = await repo.update(created.id, { status: 'failed', steps: failedSteps });
    expect(updated?.steps.find((s) => s.name === 'transcode')?.errorDetail).toEqual(FULL_DETAIL);

    // The write side persisted it (toDoc stores whole step objects)...
    const storedSteps = raw(created.id)?.['steps'] as Record<string, unknown>[] | undefined;
    const storedTranscode = storedSteps?.find((s) => s['name'] === 'transcode');
    expect(storedTranscode?.['errorDetail']).toEqual(FULL_DETAIL);

    // ...and the READ side — fromDoc, which rebuilds steps field by field —
    // hands it back intact, nested `source` included. Without the errorDetail
    // hydration line in fromDoc this is `undefined`.
    const read = await repo.get(created.id);
    const step = read?.steps.find((s) => s.name === 'transcode');
    expect(step?.status).toBe('failed');
    expect(step?.error).toBe(FULL_DETAIL.storageError);
    expect(step?.errorDetail).toEqual(FULL_DETAIL);
    expect(step?.errorDetail?.source).toEqual({
      url: 's3://ovc-media/src/missing.mov',
      bucket: 'ovc-media',
      key: 'src/missing.mov'
    });
    // The step that did not fail stays clean.
    expect(read?.steps.find((s) => s.name === 'package')?.errorDetail).toBeUndefined();
  });

  it('preserves errorDetail on the find-based read paths', async () => {
    const { couch } = makeCouch();
    const repo = new CouchPipelineRepository(() => couch);

    const created = await repo.create({
      assetId: 'asset-1060',
      pipelineName: 'full',
      steps: ['transcode', 'package']
    });

    // transcode has failed and carries the detail; `package` is still running,
    // so the execution is still `running` and findRunningByAssetAndStep can
    // reach this document (Mango cannot select into `steps`, so the repository
    // narrows on status/assetId and filters in JS).
    await repo.update(created.id, {
      steps: created.steps.map((step) =>
        step.name === 'transcode'
          ? { ...step, status: 'failed' as const, errorDetail: FULL_DETAIL }
          : { ...step, status: 'running' as const }
      )
    });

    const viaFind = await repo.findRunningByAssetAndStep('asset-1060', 'package');
    expect(viaFind?.id).toBe(created.id);
    expect(viaFind?.steps.find((s) => s.name === 'transcode')?.errorDetail).toEqual(FULL_DETAIL);

    const viaList = await repo.listByAsset('asset-1060');
    expect(viaList).toHaveLength(1);
    expect(viaList[0]?.steps.find((s) => s.name === 'transcode')?.errorDetail).toEqual(FULL_DETAIL);

    const viaListAll = await repo.listAll();
    expect(viaListAll.total).toBe(1);
    expect(
      viaListAll.items[0]?.steps.find((s) => s.name === 'transcode')?.errorDetail
    ).toEqual(FULL_DETAIL);
  });

  // A document written by an older build, a partial/hand-edited document, or
  // anything that drifts from the contract must NOT reach the response. Each of
  // these would pass a bare "is it an object" (or in the non-object cases, be
  // cast straight onto the step) and then fail `stepErrorDetailSchema` during
  // response serialization — a 500 on a GET that should simply report a failed
  // step with no structured detail.
  const MALFORMED: Array<[string, unknown]> = [
    ['a string', 'source_read_failed'],
    ['an array', [{ code: 'source_read_failed', message: 'nope' }]],
    ['null', null],
    ['a number', 404],
    ['an empty object', {}],
    ['an object with no code', { message: 'the source could not be read' }],
    ['an object with no message', { code: 'source_read_failed' }],
    ['an unknown code', { code: 'something_else', message: 'the source could not be read' }],
    ['a non-string message', { code: 'source_read_failed', message: 42 }],
    [
      'a source without url',
      { code: 'source_read_failed', message: 'the source could not be read', source: {} }
    ],
    [
      'a non-string source.url',
      { code: 'source_read_failed', message: 'the source could not be read', source: { url: 7 } }
    ]
  ];

  for (const [label, stored] of MALFORMED) {
    it(`hydrates no errorDetail when the stored value is ${label}`, async () => {
      // Seed the document by hand: the typed write path cannot produce these.
      const harness = makeCouch();
      harness.seed({
        _id: 'exec-malformed',
        _rev: '1-seed',
        resourceType: 'pipeline_execution',
        localId: 'exec-malformed',
        assetId: 'asset-1060',
        pipelineName: 'full',
        status: 'failed',
        steps: [
          {
            name: 'transcode',
            status: 'failed',
            error: 'dropped by Encore: ffprobe failed for input',
            errorDetail: stored
          }
        ],
        createdAt: '2026-10-08T07:00:00.000Z',
        updatedAt: '2026-10-08T07:01:00.000Z'
      });
      const repoOverSeed = new CouchPipelineRepository(() => harness.couch);

      const read = await repoOverSeed.get('exec-malformed');
      const step = read?.steps.find((s) => s.name === 'transcode');
      // The step still reads back, with its free-text error intact...
      expect(step?.status).toBe('failed');
      expect(step?.error).toBe('dropped by Encore: ffprobe failed for input');
      // ...and no structured detail, rather than a detail the response schema
      // would reject.
      expect(step?.errorDetail).toBeUndefined();
      expect(Object.keys(step ?? {})).not.toContain('errorDetail');

      // Same verdict on the find-based paths.
      const listed = await repoOverSeed.listByAsset('asset-1060');
      expect(listed[0]?.steps[0]?.errorDetail).toBeUndefined();
    });
  }

  it('only ever hydrates a detail the response contract can serialize', async () => {
    // The invariant behind the two cases above: whatever fromDoc puts on a step
    // must round-trip through the schema both route copies of
    // stepExecutionSchema embed, so a read can never 500 on serialization.
    const harness = makeCouch();
    harness.seed({
      _id: 'exec-mixed',
      _rev: '1-seed',
      resourceType: 'pipeline_execution',
      localId: 'exec-mixed',
      assetId: 'asset-1060',
      pipelineName: 'full',
      status: 'failed',
      steps: [
        { name: 'transcode', status: 'failed', errorDetail: FULL_DETAIL },
        // Extra stored keys are not part of the contract and must not leak.
        {
          name: 'package',
          status: 'failed',
          errorDetail: { ...FULL_DETAIL, unknownKey: 'leak-me' }
        }
      ],
      createdAt: '2026-10-08T07:00:00.000Z',
      updatedAt: '2026-10-08T07:01:00.000Z'
    });
    const repo = new CouchPipelineRepository(() => harness.couch);

    const read = await repo.get('exec-mixed');
    for (const step of read?.steps ?? []) {
      if (step.errorDetail === undefined) continue;
      expect(stepErrorDetailSchema.safeParse(step.errorDetail).success).toBe(true);
      expect(Object.keys(step.errorDetail)).not.toContain('unknownKey');
    }
    expect(read?.steps.find((s) => s.name === 'package')?.errorDetail).toEqual(FULL_DETAIL);
  });
});
