// Regression coverage for issue #1097 — a job/asset must carry its own stack
// identity, so work that outlives the request (or the PROCESS) re-enters the
// stack the document was created against.
//
// Issue #1058 put the request's `X-Stack-Name` into AsyncLocalStorage, which is
// enough while the request's async chain is alive. It is not enough for:
//   - a URL pull detached from the request and re-driven later;
//   - a transcode completion message drained from the queue after a restart
//     (encore-callback-poller `recoverProcessingQueue` returns in-flight
//     messages to the queue on startup, with no ambient context at all).
// In both cases every repository/storage resolution fell back to the
// FIRST-LISTED stack (`workspace-stack.ts resolve()`, no-stackName branch), so
// documents and bytes for a non-default stack went to the wrong instance.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - `Job.stackName?: string` + `CreateJobInput.stackName?: string`
//     (src/data/job-repo.ts); written/read by InMemoryJobRepository.create and
//     CouchJobRepository toDoc/fromDoc (src/data/couch-job-repo.ts).
//   - `Asset.stackName?: string` + `CreateAssetInput.stackName?: string`
//     (src/data/asset-repo.ts); persisted at `administrative.stackName`
//     (AssetDocumentSchema, src/data/asset-document.ts) via
//     toAssetDocument/fromAssetDocument.
//   - `runWithRequestStack` / `currentRequestStackName` /
//     `runWithPersistedStack` / `makeRequestScopedStorageFactory`
//     (src/services/request-stack-context.ts).
//   - `PullParams.stackName` consumed by `runPull`
//     (src/pipeline/url-pull-worker.ts).
//   - `stackForQueueMessage(deps, raw)` and `keys.uuidToExternalId`
//     (src/pipeline/encore-callback-poller.ts, src/encore-scaler/types.ts).
//   - `StackCouch.get/put` (src/data/couchdb.ts).
//
// Only the resolver/storage/Valkey boundaries are stubbed; the repositories, the
// document mapping, the worker and the ALS context are production code.

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';

import {
  InMemoryAssetRepository,
  type Asset,
  type AssetRepository
} from '../src/data/asset-repo.js';
import { InMemoryJobRepository, encodeEncoreJobId, type JobRepository } from '../src/data/job-repo.js';
import { CouchJobRepository } from '../src/data/couch-job-repo.js';
import type { StackCouch, StoredDoc } from '../src/data/couchdb.js';
import {
  AssetDocumentSchema,
  fromAssetDocument,
  toAssetDocument
} from '../src/data/asset-document.js';
import {
  PerWorkspaceAssetRepository,
  PerWorkspaceJobRepository
} from '../src/data/per-workspace-repos.js';
import {
  adoptResolvedStackName,
  currentDocumentStackName,
  currentRequestStackName,
  makeRequestScopedStorageFactory,
  requestStackNameFromHeaders,
  runWithRequestStack,
  runWithRequestedStack,
  PERSISTED_STACK_FALLBACK_MESSAGE
} from '../src/services/request-stack-context.js';
import { runPull } from '../src/pipeline/url-pull-worker.js';
import {
  extractTechnicalMetadata,
  type ProbeRunner
} from '../src/pipeline/metadata-extractor.js';
import { stackForQueueMessage, type PollerDeps } from '../src/pipeline/encore-callback-poller.js';
import { keys } from '../src/encore-scaler/types.js';
import type { WorkspaceConnections, WorkspaceStackResolver } from '../src/services/workspace-stack.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

// Every provisioned stack's source bucket carries the same literal name
// (src/routes/provision.ts), which is what made the #1058/#1097 divergence
// silent: only the INSTANCE differs.
const SOURCE_BUCKET = 'openvideocore-source';

// ---------------------------------------------------------------------------
// Two-stack harness: ['alpha', 'beta'], 'alpha' is the first-listed (default)
// ---------------------------------------------------------------------------

class FakeStackStorage {
  readonly stored: string[] = [];
  constructor(readonly stack: string) {}
  async putStream(
    key: string,
    source: Readable,
    opts: { maxBytes?: number; totalBytes?: number; onProgress?: (b: number, t?: number) => void }
  ): Promise<{ etag: string; bytesTransferred: number }> {
    let transferred = 0;
    for await (const chunk of source) {
      transferred += (chunk as Buffer).length;
      opts.onProgress?.(transferred, opts.totalBytes);
    }
    this.stored.push(key);
    return { etag: `etag-${this.stack}`, bytesTransferred: transferred };
  }
  async abortIncompleteMultipartUploads(): Promise<number> {
    return 0;
  }
}

type Stack = {
  name: string;
  assets: InMemoryAssetRepository;
  jobs: InMemoryJobRepository;
  storage: FakeStackStorage;
  connections: WorkspaceConnections;
};

function makeStack(name: string): Stack {
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const storage = new FakeStackStorage(name);
  const connections = {
    assets,
    jobs,
    storageFor: () => storage,
    sourceBucket: SOURCE_BUCKET,
    packagedBucket: 'openvideocore-packaged',
    stackName: name
  } as unknown as WorkspaceConnections;
  return { name, assets, jobs, storage, connections };
}

type Harness = {
  stacks: Record<string, Stack>;
  resolver: WorkspaceStackResolver;
  assets: AssetRepository;
  jobs: JobRepository;
  storageFactory: () => WorkspaceStorage;
};

// Resolver stub keyed exactly like WorkspaceStackResolver: a known name wins
// verbatim, anything else (no name, unknown name) falls back to the FIRST
// listed stack — the behaviour #1097's fallback has to preserve.
function buildHarness(names: string[] = ['alpha', 'beta']): Harness {
  const stacks: Record<string, Stack> = {};
  for (const n of names) stacks[n] = makeStack(n);
  const pick = (requested?: string): Stack => (requested && stacks[requested]) || stacks[names[0]!]!;
  const resolver = {
    resolve: async (stackName?: string) => pick(stackName).connections,
    resolveCached: (stackName?: string) => pick(stackName).connections,
    resolveStackName: async (requested?: string) =>
      requested && stacks[requested] ? requested : names[0],
    listStackNames: async () => names
  } as unknown as WorkspaceStackResolver;
  return {
    stacks,
    resolver,
    assets: new PerWorkspaceAssetRepository(resolver),
    jobs: new PerWorkspaceJobRepository(resolver),
    storageFactory: makeRequestScopedStorageFactory(resolver)
  };
}

// ---------------------------------------------------------------------------
// Persistence of the field itself
// ---------------------------------------------------------------------------

describe('a document records the stack it was created against (issue #1097)', () => {
  it('stamps the request stack on a job created while serving a request', async () => {
    const h = buildHarness();

    const job = await runWithRequestStack('beta', async () =>
      h.jobs.create({ type: 'ingest-url', assetId: 'asset-1', sourceUrl: 'https://e/x.mp4' })
    );

    expect(job.stackName).toBe('beta');
    // And it is readable back out of the repository, not just returned by create.
    const readBack = await runWithRequestStack('beta', async () => h.jobs.get(job.id));
    expect(readBack?.stackName).toBe('beta');
  });

  it('stamps the request stack on an asset created OUTSIDE any job (direct upload)', async () => {
    const h = buildHarness();

    const asset = await runWithRequestStack('beta', async () => h.assets.create({ name: 'clip' }));

    expect(asset.stackName).toBe('beta');
    const readBack = await runWithRequestStack('beta', async () => h.assets.get(asset.id));
    expect(readBack?.stackName).toBe('beta');
  });

  it('leaves the field absent when there is no request stack (boot, sweeps, watch-folder)', async () => {
    const h = buildHarness();

    // No ambient context at all — the pre-#1097 world, and still the world of
    // every non-request path.
    expect(currentRequestStackName()).toBeUndefined();
    const asset = await h.assets.create({ name: 'dropped-in' });
    const job = await h.jobs.create({ type: 'ingest-url', assetId: asset.id });

    expect(asset.stackName).toBeUndefined();
    expect(job.stackName).toBeUndefined();
  });

  it('round-trips the job stack through the CouchDB job document', async () => {
    const docs = new Map<string, StoredDoc>();
    const couch = {
      async get(id: string) {
        return docs.get(id);
      },
      async put(id: string, body: Record<string, unknown>) {
        docs.set(id, { ...(body as StoredDoc), _id: id, _rev: '1-x' });
        return { id, rev: '1-x' };
      }
    } as unknown as StackCouch;
    const repo = new CouchJobRepository(() => couch);

    const created = await runWithRequestStack('beta', async () =>
      repo.create({ type: 'transcode', assetId: 'asset-1' })
    );
    expect(created.stackName).toBe('beta');
    // Persisted on the stored document, so it survives the process.
    expect(docs.get(created.id)?.['stackName']).toBe('beta');
    // And a cold read (no ambient context) returns it.
    expect((await repo.get(created.id))?.stackName).toBe('beta');

    // A patch must not drop the field (toDoc is a full rewrite).
    await repo.update(created.id, { status: 'running' });
    expect((await repo.get(created.id))?.stackName).toBe('beta');
  });

  it('round-trips the asset stack through the ADR-005 administrative namespace', () => {
    const asset = {
      id: 'asset-1',
      name: 'clip',
      status: 'uploading',
      statusHistory: [],
      stackName: 'beta',
      createdAt: '2026-10-03T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z'
    } as unknown as Asset;

    const doc = AssetDocumentSchema.parse(toAssetDocument(asset));
    // System-owned provenance lives under `administrative`, never `descriptive`.
    expect(doc.administrative.stackName).toBe('beta');
    expect(fromAssetDocument(doc).stackName).toBe('beta');
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: documents written before #1097
// ---------------------------------------------------------------------------

describe('documents with no stackName keep today’s behaviour (issue #1097)', () => {
  it('reads a legacy job document back with stackName undefined', async () => {
    const docs = new Map<string, StoredDoc>([
      [
        'job-legacy',
        {
          _id: 'job-legacy',
          _rev: '1-x',
          resourceType: 'job',
          localId: 'job-legacy',
          type: 'ingest-url',
          status: 'running',
          assetId: 'asset-legacy',
          sourceUrl: 'https://e/x.mp4',
          progress: 0,
          bytesTransferred: 0,
          attempts: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        } as unknown as StoredDoc
      ]
    ]);
    const couch = {
      async get(id: string) {
        return docs.get(id);
      },
      async put(id: string, body: Record<string, unknown>) {
        docs.set(id, { ...(body as StoredDoc), _id: id, _rev: '2-x' });
        return { id, rev: '2-x' };
      }
    } as unknown as StackCouch;
    const repo = new CouchJobRepository(() => couch);

    const job = await repo.get('job-legacy');
    expect(job).toBeDefined();
    expect(job?.stackName).toBeUndefined();
    // Still fully usable: the lifecycle patch applies as before.
    expect((await repo.update('job-legacy', { status: 'done' }))?.status).toBe('done');
  });

  it('deserializes a legacy asset document with no administrative.stackName', () => {
    const base = toAssetDocument({
      id: 'asset-legacy',
      name: 'clip',
      status: 'ready',
      statusHistory: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    } as unknown as Asset);
    expect(base.administrative.stackName).toBeUndefined();

    const doc = AssetDocumentSchema.parse(base);
    expect(fromAssetDocument(doc).stackName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The URL-pull worker re-enters the job's stack
// ---------------------------------------------------------------------------

// Storage handle that re-resolves through the PRODUCTION request-scoped factory
// on every write, so what it records is the stack the worker's ambient context
// actually resolves — the object-storage half of the acceptance criterion.
function resolvingStorage(
  factory: () => WorkspaceStorage,
  resolvedIn: string[]
): WorkspaceStorage {
  return {
    async putStream(key: string, src: Readable, opts: Record<string, unknown>) {
      const live = factory() as unknown as FakeStackStorage;
      resolvedIn.push(live.stack);
      return live.putStream(key, src, opts as { totalBytes?: number });
    },
    async abortIncompleteMultipartUploads() {
      return 0;
    }
  } as unknown as WorkspaceStorage;
}

const openS3For = (totalBytes: number) => async () => ({
  stream: Readable.from([Buffer.alloc(totalBytes)]),
  totalBytes
});

describe('the URL-pull worker re-enters the job stack (issue #1097)', () => {
  it('a job created on a non-default stack and picked up after a process restart resolves THAT stack', async () => {
    const h = buildHarness();

    // --- while the request is in flight: asset + job are created on 'beta' ---
    const { asset, job } = await runWithRequestStack('beta', async () => {
      const a = await h.assets.create({ name: 'clip', sourceMethod: 'url-pull' });
      const j = await h.jobs.create({
        type: 'ingest-url',
        assetId: a.id,
        sourceUrl: 's3://remote/clip.mp4'
      });
      return { asset: a, job: j };
    });
    expect(job.stackName).toBe('beta');

    // --- process restart: NOTHING is left of the request context ------------
    expect(currentRequestStackName()).toBeUndefined();
    const resolvedIn: string[] = [];
    await runPull(
      {
        jobId: job.id,
        assetId: asset.id,
        objectKey: `ingest/${asset.id}`,
        sourceUrl: 's3://remote/clip.mp4',
        // The only identity available after a restart: the one on the record.
        stackName: job.stackName
      },
      {
        jobs: h.jobs,
        assets: h.assets,
        storage: resolvingStorage(h.storageFactory, resolvedIn),
        openS3: openS3For(64)
      }
    );

    // Repositories: the job settled, and the asset advanced, on 'beta'.
    const betaJob = await h.stacks['beta']!.jobs.get(job.id);
    expect(betaJob?.status).toBe('done');
    expect((await h.stacks['beta']!.assets.get(asset.id))?.status).toBe('processing');
    // Nothing leaked onto the first-listed stack.
    expect(await h.stacks['alpha']!.jobs.get(job.id)).toBeUndefined();
    expect(await h.stacks['alpha']!.assets.get(asset.id)).toBeUndefined();
    // Object storage: resolved through the production request-scoped factory
    // from inside the worker, so bytes and documents landed together.
    expect(resolvedIn).toEqual(['beta']);
    expect(h.stacks['beta']!.storage.stored).toEqual([`ingest/${asset.id}`]);
    expect(h.stacks['alpha']!.storage.stored).toEqual([]);
  });

  it('a legacy job with no stackName falls back to the first-listed stack and says so at debug level', async () => {
    const h = buildHarness();

    // A pre-#1097 record: created with no ambient stack, so no stackName. It
    // lives on the default stack, which is where the fallback resolves.
    const asset = await h.assets.create({ name: 'clip' });
    const job = await h.jobs.create({
      type: 'ingest-url',
      assetId: asset.id,
      sourceUrl: 's3://remote/clip.mp4'
    });
    expect(job.stackName).toBeUndefined();

    const debug = vi.fn();
    const resolvedIn: string[] = [];
    await runPull(
      {
        jobId: job.id,
        assetId: asset.id,
        objectKey: `ingest/${asset.id}`,
        sourceUrl: 's3://remote/clip.mp4',
        stackName: job.stackName
      },
      {
        jobs: h.jobs,
        assets: h.assets,
        storage: resolvingStorage(h.storageFactory, resolvedIn),
        openS3: openS3For(32),
        stackLog: { debug }
      }
    );

    // Unchanged behaviour: the first-listed stack, exactly as before #1097.
    expect(resolvedIn).toEqual(['alpha']);
    expect((await h.stacks['alpha']!.jobs.get(job.id))?.status).toBe('done');
    expect(h.stacks['alpha']!.storage.stored).toEqual([`ingest/${asset.id}`]);
    // ...and the fallback is visible to an operator at DEBUG level only.
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]?.[1])).toMatch(/no persisted stackName/i);
  });

  it('does not clear an ambient stack when the job predates the field', async () => {
    const h = buildHarness();

    // Legacy job, but the caller DOES have a stack context (a pull detached
    // from a live request). Re-entering `undefined` would have thrown that away
    // and silently retargeted the write at the first-listed stack.
    const { asset, job } = await runWithRequestStack('beta', async () => {
      const a = await h.assets.create({ name: 'clip' });
      const j = await h.jobs.create({ type: 'ingest-url', assetId: a.id, sourceUrl: 's3://r/c.mp4' });
      return { asset: a, job: j };
    });

    const resolvedIn: string[] = [];
    await runWithRequestStack('beta', () =>
      runPull(
        {
          jobId: job.id,
          assetId: asset.id,
          objectKey: `ingest/${asset.id}`,
          sourceUrl: 's3://remote/clip.mp4',
          // Simulate the legacy record: identity missing on the document.
          stackName: undefined
        },
        {
          jobs: h.jobs,
          assets: h.assets,
          storage: resolvingStorage(h.storageFactory, resolvedIn),
          openS3: openS3For(16)
        }
      )
    );

    expect(resolvedIn).toEqual(['beta']);
    expect((await h.stacks['beta']!.jobs.get(job.id))?.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// The transcode completion queue (the restart/resume drain path)
// ---------------------------------------------------------------------------

describe('a completion message drained after a restart resolves the job stack (issue #1097)', () => {
  function pollerDeps(h: Harness, mapping: Record<string, string>): PollerDeps {
    return {
      redis: {
        async get(key: string) {
          return mapping[key] ?? null;
        }
      },
      jobRepository: h.jobs,
      assetRepository: h.assets,
      oscContext: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    } as unknown as PollerDeps;
  }

  it('resolves the persisted stack of a job whose completion is picked up with no ambient context', async () => {
    const h = buildHarness();
    const { job, externalId } = await runWithRequestStack('beta', async () => {
      const a = await h.assets.create({ name: 'clip' });
      const j = await h.jobs.create({ type: 'transcode', assetId: a.id });
      const ext = encodeEncoreJobId('beta', j.id);
      await h.jobs.update(j.id, { encoreJobId: ext, status: 'running' });
      return { job: j, externalId: ext };
    });
    expect(job.stackName).toBe('beta');

    // recoverProcessingQueue returned this message to the queue on startup.
    const raw = JSON.stringify({ jobId: 'encore-uuid-1', url: 'https://encore/encoreJobs/x' });
    const deps = pollerDeps(h, { [keys.uuidToExternalId('encore-uuid-1')]: externalId });

    expect(currentRequestStackName()).toBeUndefined();
    await expect(stackForQueueMessage(deps, raw)).resolves.toBe('beta');
  });

  it('returns undefined (today’s first-listed-stack behaviour) when nothing identifies the stack', async () => {
    const h = buildHarness();
    const raw = JSON.stringify({ jobId: 'encore-uuid-unknown' });
    // No UUID->externalId mapping: the key expired, or the job was dispatched by
    // another deployment sharing the queue.
    await expect(stackForQueueMessage(pollerDeps(h, {}), raw)).resolves.toBeUndefined();
  });

  it('never throws on a corrupt message or an unreachable store', async () => {
    const h = buildHarness();
    const broken = {
      redis: {
        async get() {
          throw new Error('valkey unreachable');
        }
      },
      jobRepository: h.jobs,
      assetRepository: h.assets,
      oscContext: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    } as unknown as PollerDeps;

    await expect(stackForQueueMessage(broken, 'not json')).resolves.toBeUndefined();
    await expect(
      stackForQueueMessage(broken, JSON.stringify({ jobId: 'u' }))
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Only a RESOLVER-CONFIRMED identity is persisted (issue #1097 review,
// BLOCKING 2). `X-Stack-Name` is client-supplied; before this split the raw
// header was written into `administrative.stackName` / `Job.stackName` verbatim,
// and that stored string is then fed back into a parameter-store lookup key and
// into the resolver's per-name cache (`workspace-stack.ts` resolve cache key
// `stackName ?? ''`). Contracts verified:
//   - `requestStackNameFromHeaders(headers)`, `runWithRequestedStack`,
//     `adoptResolvedStackName`, `currentDocumentStackName`,
//     `currentRequestStackName` (src/services/request-stack-context.ts).
//   - `WorkspaceConnections.stackName: string | undefined` — "the stack identity
//     these connections were built from ... the same identity resolveStackName()
//     returns" (src/services/workspace-stack.ts).
// ---------------------------------------------------------------------------

describe('the stack name persisted on a document is resolver-confirmed, not client-supplied', () => {
  it('drops a header that cannot name a stack instead of letting it reach storage', () => {
    // The exact value the review proved reached a stored document verbatim.
    expect(
      requestStackNameFromHeaders({ 'x-stack-name': 'stack-that-does-not-exist$(whoami)' })
    ).toBeUndefined();
    // Path traversal / separators / whitespace / overlong: all unroutable.
    expect(requestStackNameFromHeaders({ 'x-stack-name': '../../etc/passwd' })).toBeUndefined();
    expect(requestStackNameFromHeaders({ 'x-stack-name': 'a/b' })).toBeUndefined();
    expect(requestStackNameFromHeaders({ 'x-stack-name': 'two words' })).toBeUndefined();
    expect(requestStackNameFromHeaders({ 'x-stack-name': '-leading-hyphen' })).toBeUndefined();
    expect(requestStackNameFromHeaders({ 'x-stack-name': 'x'.repeat(64) })).toBeUndefined();
    expect(requestStackNameFromHeaders({ 'x-stack-name': '' })).toBeUndefined();
    // A repeated header names no single stack, so it names none.
    expect(
      requestStackNameFromHeaders({ 'x-stack-name': ['alpha', 'beta'] })
    ).toBeUndefined();
  });

  it('accepts and normalises a well-formed stack name', () => {
    expect(requestStackNameFromHeaders({ 'x-stack-name': 'stack-beta' })).toBe('stack-beta');
    expect(requestStackNameFromHeaders({ 'x-stack-name': '  Stack-Beta ' })).toBe('stack-beta');
    expect(requestStackNameFromHeaders({ 'x-stack-name': 'x'.repeat(63) })).toBe('x'.repeat(63));
    expect(requestStackNameFromHeaders({})).toBeUndefined();
  });

  it('persists the stack the document was WRITTEN to, not the name the caller asked for', async () => {
    // 'beta' is NOT provisioned here, so the resolver routes this request to the
    // first-listed stack 'alpha' — `resolveStackName`'s documented "a stale UI
    // selection must not break routing" fallback. The document therefore lives
    // in alpha and must be LABELLED alpha; labelling it 'beta' is what would
    // send a background worker to the wrong stack once a real 'beta' appears.
    const h = buildHarness(['alpha']);

    const { asset, job } = await runWithRequestedStack('beta', async () => {
      // What the resolver preHandler does: resolve, then adopt the identity the
      // connections were actually built from.
      const conns = await h.resolver.resolve(currentRequestStackName());
      adoptResolvedStackName(conns.stackName);
      return {
        asset: await h.assets.create({ name: 'clip' }),
        job: await h.jobs.create({ type: 'ingest-url', assetId: 'asset-1' })
      };
    });

    expect(asset.stackName).toBe('alpha');
    expect(job.stackName).toBe('alpha');
    // The bytes/documents really are in alpha, so the label agrees with reality.
    expect(await h.stacks['alpha']!.assets.get(asset.id)).toBeTruthy();
  });

  it('still routes on the name the caller asked for when that stack exists', async () => {
    const h = buildHarness(['alpha', 'beta']);

    const asset = await runWithRequestedStack('beta', async () => {
      const conns = await h.resolver.resolve(currentRequestStackName());
      adoptResolvedStackName(conns.stackName);
      return h.assets.create({ name: 'clip' });
    });

    expect(asset.stackName).toBe('beta');
    expect(await h.stacks['beta']!.assets.get(asset.id)).toBeTruthy();
    expect(await h.stacks['alpha']!.assets.get(asset.id)).toBeUndefined();
  });

  it('writes NO stack name when the request is served before any identity is confirmed', async () => {
    // The resolver preHandler failed (degraded connections) or has not run yet.
    // Routing still uses the requested name; nothing is persisted, which is the
    // documented legacy behaviour rather than a guess.
    const h = buildHarness(['alpha', 'beta']);

    const asset = await runWithRequestedStack('beta', async () => {
      expect(currentRequestStackName()).toBe('beta');
      expect(currentDocumentStackName()).toBeUndefined();
      return h.assets.create({ name: 'clip' });
    });

    expect(asset.stackName).toBeUndefined();
    // It was still WRITTEN to beta — routing is unaffected by the split.
    expect(await h.stacks['beta']!.assets.get(asset.id)).toBeTruthy();
  });

  it('treats an internal caller’s name as persistable, because it is already resolved', async () => {
    // Sweeps/boot (src/main.ts), the poller, and `runWithPersistedStack` pass a
    // name that came from `listStackNames()` or off a document — not from a
    // client — so `runWithRequestStack` makes it both routable and persistable.
    const h = buildHarness(['alpha', 'beta']);

    const asset = await runWithRequestStack('beta', async () => {
      expect(currentDocumentStackName()).toBe('beta');
      return h.assets.create({ name: 'swept' });
    });

    expect(asset.stackName).toBe('beta');
  });
});

// ---------------------------------------------------------------------------
// Metadata extraction re-enters the asset's persisted stack (review suggestion:
// this contract was introduced by the PR and had no direct coverage).
// Contracts verified: `ExtractParams.stackName`, `ExtractDeps`,
// `ProbeRunner = (source: string | ExternalProbeSource) => Promise<FfprobeResult>`
// (src/pipeline/metadata-extractor.ts).
// ---------------------------------------------------------------------------

describe('metadata extraction re-enters the asset stack (issue #1097)', () => {
  // `ProbeRunner = (source: string | ExternalProbeSource) => Promise<FfprobeResult>`
  // (src/pipeline/metadata-extractor.ts).
  const probeStub: ProbeRunner = async () =>
    ({
      format: { duration: '12.5', format_name: 'mov,mp4', bit_rate: '800000' },
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }]
    }) as unknown as Awaited<ReturnType<ProbeRunner>>;

  // The only storage call the default (OSC-managed) extraction path makes is
  // `presignedGet(objectKey, ttl)` (WorkspaceStorage, src/data/storage.ts:142).
  const storageStub = {
    presignedGet: async () => 'https://example.invalid/signed'
  } as unknown as WorkspaceStorage;

  it('writes technical metadata to the asset’s OWN stack with no ambient context', async () => {
    const h = buildHarness(['alpha', 'beta']);
    // The asset exists only on beta — the restart case: no ambient context.
    const asset = await runWithRequestStack('beta', async () =>
      h.assets.create({ name: 'on-beta' })
    );
    expect(currentRequestStackName()).toBeUndefined();

    await extractTechnicalMetadata(
      { assetId: asset.id, objectKey: 'k.mp4', stackName: asset.stackName },
      { assets: h.assets, storage: storageStub, probe: probeStub }
    );

    // Resolved beta, not the first-listed alpha.
    const onBeta = await h.stacks['beta']!.assets.get(asset.id);
    expect(onBeta?.technicalMetadata?.durationSeconds).toBeCloseTo(12.5);
    expect(onBeta?.technicalMetadataError).toBeFalsy();
  });

  it('falls back to the first-listed stack for a legacy asset and says so at debug level', async () => {
    const h = buildHarness(['alpha', 'beta']);
    // Pre-#1097 asset: lives on alpha, carries no stackName.
    const asset = await h.assets.create({ name: 'legacy' });
    expect(asset.stackName).toBeUndefined();
    const debug = vi.fn();

    await extractTechnicalMetadata(
      { assetId: asset.id, objectKey: 'k.mp4', stackName: asset.stackName },
      { assets: h.assets, storage: storageStub, probe: probeStub, stackLog: { debug } }
    );

    const onAlpha = await h.stacks['alpha']!.assets.get(asset.id);
    expect(onAlpha?.technicalMetadata?.durationSeconds).toBeCloseTo(12.5);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: asset.id }),
      expect.stringContaining(PERSISTED_STACK_FALLBACK_MESSAGE)
    );
  });
});
