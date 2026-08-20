// Integration-style tests for the TAMS "ready"-transition indexing hook
// (issue #172). These exercise the real InMemoryAssetRepository through the
// `withTamsReadyIndexing` decorator with a MOCK indexer, asserting the three
// acceptance behaviours: fires once when configured, never when unconfigured,
// and is failure-tolerant (an indexer throw does not block the lifecycle).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { InMemoryAssetRepository, type Asset } from '../data/asset-repo.js';
import {
  withTamsReadyIndexing,
  isTamsConfigured,
  type AssetIndexer,
  type HookLogger
} from './tams-ready-hook.js';

// A logger stub capturing warn calls so we can assert failure logging.
function makeLog(): { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } & HookLogger {
  const warn = vi.fn();
  const info = vi.fn();
  return { warn, info } as unknown as {
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  } & HookLogger;
}

// Drive an asset from creation to `ready` through the (decorated) repository:
// uploading -> processing -> ready. Returns the ready asset.
async function driveToReady(repo: {
  create: InMemoryAssetRepository['create'];
  update: InMemoryAssetRepository['update'];
}): Promise<Asset> {
  const created = await repo.create({ name: 'clip' });
  await repo.update(created.id, { status: 'processing' });
  const ready = await repo.update(created.id, { status: 'ready' });
  return ready!;
}

describe('withTamsReadyIndexing', () => {
  const prevEnv = process.env['TAMS_STORE_URL'];

  beforeEach(() => {
    delete process.env['TAMS_STORE_URL'];
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env['TAMS_STORE_URL'];
    } else {
      process.env['TAMS_STORE_URL'] = prevEnv;
    }
  });

  it('isTamsConfigured follows the ADR-009 non-empty-string rule', () => {
    expect(isTamsConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isTamsConfigured({ TAMS_STORE_URL: '' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isTamsConfigured({ TAMS_STORE_URL: '   ' } as NodeJS.ProcessEnv)).toBe(false);
    expect(
      isTamsConfigured({ TAMS_STORE_URL: 'https://tams.example/' } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it('when configured, transitioning to ready invokes the indexer exactly once with the asset', async () => {
    process.env['TAMS_STORE_URL'] = 'https://tams.example/';
    const indexer = vi.fn<AssetIndexer>().mockResolvedValue(undefined);
    const repo = withTamsReadyIndexing(new InMemoryAssetRepository(), {
      indexer,
      log: makeLog()
    });

    const ready = await driveToReady(repo);

    expect(ready.status).toBe('ready');
    expect(indexer).toHaveBeenCalledTimes(1);
    const asset = indexer.mock.calls[0]![0];
    expect(asset.id).toBe(ready.id);
    expect(asset.status).toBe('ready');
  });

  it('does not double-fire when an already-ready asset is updated again', async () => {
    process.env['TAMS_STORE_URL'] = 'https://tams.example/';
    const indexer = vi.fn<AssetIndexer>().mockResolvedValue(undefined);
    const repo = withTamsReadyIndexing(new InMemoryAssetRepository(), {
      indexer,
      log: makeLog()
    });

    const ready = await driveToReady(repo);
    expect(indexer).toHaveBeenCalledTimes(1);

    // A no-op ready->ready update and a non-status annotation must NOT re-fire.
    await repo.update(ready.id, { status: 'ready' });
    await repo.update(ready.id, { tags: ['x'] });
    expect(indexer).toHaveBeenCalledTimes(1);
  });

  it('does not fire on non-ready transitions (processing)', async () => {
    process.env['TAMS_STORE_URL'] = 'https://tams.example/';
    const indexer = vi.fn<AssetIndexer>().mockResolvedValue(undefined);
    const repo = withTamsReadyIndexing(new InMemoryAssetRepository(), {
      indexer,
      log: makeLog()
    });

    const created = await repo.create({ name: 'clip' });
    await repo.update(created.id, { status: 'processing' });
    expect(indexer).not.toHaveBeenCalled();
  });

  it('when unconfigured, the indexer is never called and the asset still becomes ready', async () => {
    // TAMS_STORE_URL is unset by beforeEach.
    const indexer = vi.fn<AssetIndexer>().mockResolvedValue(undefined);
    const repo = withTamsReadyIndexing(new InMemoryAssetRepository(), {
      indexer,
      log: makeLog()
    });

    const ready = await driveToReady(repo);

    expect(ready.status).toBe('ready');
    expect(indexer).not.toHaveBeenCalled();
  });

  it('when the indexer throws, the asset still reaches ready and the failure is logged (no throw propagates)', async () => {
    process.env['TAMS_STORE_URL'] = 'https://tams.example/';
    const indexer = vi.fn<AssetIndexer>().mockRejectedValue(new Error('gateway 503'));
    const log = makeLog();
    const repo = withTamsReadyIndexing(new InMemoryAssetRepository(), { indexer, log });

    // The transition must resolve (not reject) despite the indexer failure.
    let ready: Asset | undefined;
    await expect(
      (async () => {
        ready = await driveToReady(repo);
      })()
    ).resolves.toBeUndefined();

    expect(ready?.status).toBe('ready');
    expect(indexer).toHaveBeenCalledTimes(1);
    // Failure logged as a structured, retryable warning.
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [payload] = log.warn.mock.calls[0]!;
    expect(payload).toMatchObject({
      event: 'tams.index.failed',
      assetId: ready?.id,
      retryable: true
    });

    // The persisted asset really is `ready` — indexing did not roll it back.
    const persisted = await repo.get(ready!.id);
    expect(persisted?.status).toBe('ready');
  });

  it('re-reading env per update lets configuration flip between transitions', async () => {
    const indexer = vi.fn<AssetIndexer>().mockResolvedValue(undefined);
    const repo = withTamsReadyIndexing(new InMemoryAssetRepository(), {
      indexer,
      log: makeLog()
    });

    // First asset: unconfigured -> no index.
    const a = await repo.create({ name: 'a' });
    await repo.update(a.id, { status: 'processing' });
    await repo.update(a.id, { status: 'ready' });
    expect(indexer).not.toHaveBeenCalled();

    // Configure, then a second asset DOES index.
    process.env['TAMS_STORE_URL'] = 'https://tams.example/';
    const b = await repo.create({ name: 'b' });
    await repo.update(b.id, { status: 'processing' });
    await repo.update(b.id, { status: 'ready' });
    expect(indexer).toHaveBeenCalledTimes(1);
  });
});
