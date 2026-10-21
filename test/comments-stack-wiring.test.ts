// Issue #1046, review follow-up: the DURABLE comment store must be reachable on
// the parameter-store path, not only under the COUCHDB_URL env override.
//
// The first fix selected the Couch-backed comment repository in main.ts on
// `process.env['COUCHDB_URL']` alone. That env var activates only
// buildEnvConnections — the deployment-global override that bypasses the
// parameter store. A deployment that provisions its stack with
// POST /api/v1/provision sets no COUCHDB_URL: the stack's CouchDB URL arrives
// from the parameter store through buildConnectionsFromStack, so the selection
// fell to the in-memory repository and #1046 reproduced (comments lost on
// restart). These tests pin the resolved repository on each path.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - WorkspaceConnections.comments: CommentRepository —
//     src/services/workspace-stack.ts (field added beside `pipelines`).
//   - WorkspaceStackResolver.resolve(stackName?): Promise<WorkspaceConnections>
//     and its constructor options { paramStore, oscContext, minioPassword,
//     couchPassword, log? } — src/services/workspace-stack.ts:724-756, 806.
//   - ParamStore.loadStackConfig / listStackNames / storeStackConfig /
//     deleteStackConfig — src/services/param-store.ts:108-125.
//   - isReadyStack(config): status undefined | 'ready' —
//     src/services/param-store.ts:102.
//   - CommentRepository.create / listByAsset and InMemoryCommentRepository —
//     src/data/comment-repo.ts:29-33, 35.
//   - CouchCommentRepository(couchFor, log?) — src/data/couch-comment-repo.ts.
//   - PerWorkspaceCommentRepository(resolver, log?) —
//     src/data/per-workspace-repos.ts (mirrors
//     PerWorkspacePipelineRepository:185-227).
//   - readyConfig shape copied from test/workspace-stack-last-known-good.test.ts:31-39.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceStackResolver } from '../src/services/workspace-stack.js';
import type { ParamStore, StackConfig } from '../src/services/param-store.js';
import type { Context } from '@osaas/client-core';
import { CouchCommentRepository } from '../src/data/couch-comment-repo.js';
import {
  InMemoryCommentRepository,
  type Comment,
  type CommentRepository,
  type CreateCommentInput
} from '../src/data/comment-repo.js';
import { PerWorkspaceCommentRepository } from '../src/data/per-workspace-repos.js';

// A ready stack config with parseable absolute URLs, so
// buildConnectionsFromStack takes its non-null (storage-enabled) path. nano and
// the MinIO client are constructed lazily and open no socket here.
const readyConfig: StackConfig = {
  status: 'ready',
  minioEndpoint: 'https://minio.example.osaas.io',
  couchdbUrl: 'https://couch.example.osaas.io',
  redisUrl: 'redis://valkey.example.osaas.io:6379',
  sourceBucket: 'openvideocore-source',
  packagedBucket: 'openvideocore-packaged',
  services: [{ serviceId: 'minio-minio', instanceName: 'mystack' }]
};

const oscContext = {} as unknown as Context;

function readyStackStore(): ParamStore {
  return {
    loadStackConfig: vi.fn(async () => readyConfig),
    listStackNames: vi.fn(async () => ['mystack']),
    storeStackConfig: vi.fn(),
    deleteStackConfig: vi.fn()
  } as unknown as ParamStore;
}

function makeResolver(store: ParamStore | undefined) {
  return new WorkspaceStackResolver({
    paramStore: store,
    oscContext,
    minioPassword: 'minio-pw',
    couchPassword: 'couch-pw'
  });
}

describe('comment store selection per resolved stack (#1046)', () => {
  beforeEach(() => {
    // The env override wins for ALL workspaces when either is set; clear both so
    // the parameter-store path is the one under test — this is exactly the
    // provisioned-deployment configuration the first fix missed.
    delete process.env['COUCHDB_URL'];
    delete process.env['MINIO_URL'];
  });

  it('resolves the Couch-backed comment repo for a ready stack with COUCHDB_URL unset', async () => {
    const resolver = makeResolver(readyStackStore());

    const conns = await resolver.resolve();

    expect(process.env['COUCHDB_URL']).toBeUndefined();
    expect(conns.comments).toBeInstanceOf(CouchCommentRepository);
    expect(conns.comments).not.toBeInstanceOf(InMemoryCommentRepository);
  });

  it('resolves the Couch-backed comment repo on the COUCHDB_URL env-override path too', async () => {
    process.env['COUCHDB_URL'] = 'https://admin:pw@couch.env.example.osaas.io';
    try {
      const conns = await makeResolver(undefined).resolve();
      expect(conns.comments).toBeInstanceOf(CouchCommentRepository);
    } finally {
      delete process.env['COUCHDB_URL'];
    }
  });

  it('falls back to the in-memory comment repo when no stack resolves', async () => {
    // No parameter store and no env override: the resolver serves no-storage
    // in-memory connections, where comments are ephemeral by necessity.
    const conns = await makeResolver(undefined).resolve();
    expect(conns.comments).toBeInstanceOf(InMemoryCommentRepository);
  });

  it('PerWorkspaceCommentRepository delegates to the resolved stack repository', async () => {
    const created: CreateCommentInput[] = [];
    const listed: string[] = [];
    const inner: CommentRepository = {
      async create(input) {
        created.push(input);
        return {
          id: 'ULID1',
          assetId: input.assetId,
          body: input.body,
          createdAt: '2026-01-01T00:00:00.000Z'
        } satisfies Comment;
      },
      async listByAsset(assetId) {
        listed.push(assetId);
        return [];
      }
    };
    const resolver = {
      resolve: async () => ({ comments: inner })
    } as unknown as WorkspaceStackResolver;
    const repo = new PerWorkspaceCommentRepository(resolver);

    const comment = await repo.create({ assetId: 'a1', body: 'hello' });
    await repo.listByAsset('a1');

    expect(comment.id).toBe('ULID1');
    expect(created).toEqual([{ assetId: 'a1', body: 'hello' }]);
    expect(listed).toEqual(['a1']);
  });

  it('warns once when the resolved comment store is in-memory, and not when it is durable', async () => {
    const warn = vi.fn();

    const ephemeral = {
      resolve: async () => ({ comments: new InMemoryCommentRepository() })
    } as unknown as WorkspaceStackResolver;
    const ephemeralRepo = new PerWorkspaceCommentRepository(ephemeral, { warn });
    await ephemeralRepo.listByAsset('a1');
    await ephemeralRepo.listByAsset('a1');

    expect(warn).toHaveBeenCalledTimes(1);
    const [payload, message] = warn.mock.calls[0];
    expect(payload).toMatchObject({ reason: 'no CouchDB in the resolved stack' });
    expect(String(message)).toContain('IN-MEMORY');

    warn.mockClear();
    const durable = {
      resolve: async () => ({
        comments: new CouchCommentRepository(() => {
          throw new Error('not used: listByAsset is stubbed below');
        })
      })
    } as unknown as WorkspaceStackResolver;
    const durableRepo = new PerWorkspaceCommentRepository(durable, { warn });
    await expect(durableRepo.listByAsset('a1')).rejects.toThrow('not used');
    expect(warn).not.toHaveBeenCalled();
  });
});
