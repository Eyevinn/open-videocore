// `statusHistory[].reason` on the HTTP read contract (issue #1085).
//
// The reason exists so an operator can tell an abandoned client upload apart
// from an interrupted URL pull — both of which write the same
// `uploading -> failed` pair. That only works if the reason reaches the API
// CLIENT. The response serializer is schema-driven and STRIPS any key the
// response schema does not list, so "the field is on the asset" and "the field
// is in the response body" are two different claims: the first is pinned in
// src/data/asset-status-reason.test.ts, and only an actually injected request
// can pin the second. A regression here (someone trimming the transition schema
// back) would be invisible to any test that reads the schema object instead of
// the wire bytes.
//
// This file also pins the negative half: `statusReason` is NOT a user-writable
// field. It names a system settle, so a client that forges one on PATCH must not
// get it recorded in the history.
//
// Contract sources (CLAUDE.md rule 7):
//   - Response schema member: `transitionSchema.reason` = `z.string().optional()`
//     inside `assetSchema.statusHistory`, the 200 response of
//     `GET /:id` (src/routes/assets.ts, transitionSchema ~:880).
//   - `UpdateAssetInput.statusReason?: string` — the repository-level field
//     (src/data/asset-repo.ts:732), written by background settles only.
//   - PATCH body contract: `updateSchema` (src/routes/assets.ts:488-498), whose
//     members are exactly name/description/objectKey/status/metadata/tags — no
//     `statusReason`, so zod's default strip behaviour drops it.
//   - Reason constants: `INTERRUPTED_PULL_ASSET_REASON`
//     (src/pipeline/interrupted-ingest-reconciler.ts:143) and
//     `ABANDONED_UPLOAD_REASON` (src/pipeline/abandoned-upload-sweep.ts:71).

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from './assets.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { INTERRUPTED_PULL_ASSET_REASON } from '../pipeline/interrupted-ingest-reconciler.js';
import { ABANDONED_UPLOAD_REASON } from '../pipeline/abandoned-upload-sweep.js';

type TransitionBody = { at: string; from: string | null; to: string; reason?: string };
type AssetBody = { id: string; status: string; statusHistory: TransitionBody[] };

async function buildApp(repo: InMemoryAssetRepository) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo });
  await app.ready();
  return app;
}

describe('GET /api/v1/assets/:id serializes statusHistory[].reason (issue #1085)', () => {
  it('returns the settle reason for an interrupted URL pull', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);
    const created = await repo.create({ name: 'interrupted-pull' });
    await repo.update(created.id, {
      status: 'failed',
      statusReason: INTERRUPTED_PULL_ASSET_REASON
    });

    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${created.id}` });
    expect(res.statusCode).toBe(200);

    const body = res.json<AssetBody>();
    expect(body.status).toBe('failed');
    const settle = body.statusHistory.at(-1) as TransitionBody;
    expect(settle.from).toBe('uploading');
    expect(settle.to).toBe('failed');
    // The whole point: the reason is on the WIRE, not just on the asset.
    expect(settle.reason).toBe(INTERRUPTED_PULL_ASSET_REASON);
    expect(res.payload).toContain(INTERRUPTED_PULL_ASSET_REASON);

    await app.close();
  });

  it('distinguishes an abandoned upload from an interrupted pull in the response', async () => {
    // Same from/to pair, different reason — the one thing a caller can read to
    // know whether to chase the client or the server.
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);
    const abandoned = await repo.create({ name: 'abandoned-upload' });
    await repo.update(abandoned.id, { status: 'failed', statusReason: ABANDONED_UPLOAD_REASON });

    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${abandoned.id}` });
    expect(res.statusCode).toBe(200);
    const settle = res.json<AssetBody>().statusHistory.at(-1) as TransitionBody;
    expect(settle.reason).toBe(ABANDONED_UPLOAD_REASON);
    expect(settle.reason).not.toBe(INTERRUPTED_PULL_ASSET_REASON);

    await app.close();
  });

  it('omits `reason` on a user-driven transition', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);
    const created = await repo.create({ name: 'user-driven' });
    await repo.update(created.id, { status: 'processing' });

    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${created.id}` });
    expect(res.statusCode).toBe(200);
    for (const entry of res.json<AssetBody>().statusHistory) {
      expect(Object.prototype.hasOwnProperty.call(entry, 'reason')).toBe(false);
    }

    await app.close();
  });
});

describe('PATCH /api/v1/assets/:id cannot forge a settle reason (issue #1085)', () => {
  it('strips a client-supplied `statusReason` from the appended history entry', async () => {
    // `statusReason` names a SYSTEM settle. It is not a member of updateSchema,
    // so zod strips it at the boundary and it never reaches
    // repo.update()/applyStatus — a client cannot make a user-driven failure
    // claim to be an interrupted pull.
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);
    const created = await repo.create({ name: 'forgery-attempt' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/assets/${created.id}`,
      payload: { status: 'failed', statusReason: 'forged' }
    });

    // The legal status move still succeeds — the unknown key is stripped, not
    // rejected, so this is not a 400.
    expect(res.statusCode).toBe(200);
    const body = res.json<AssetBody>();
    expect(body.status).toBe('failed');

    const appended = body.statusHistory.at(-1) as TransitionBody;
    expect(appended.from).toBe('uploading');
    expect(appended.to).toBe('failed');
    expect(Object.prototype.hasOwnProperty.call(appended, 'reason')).toBe(false);
    expect(res.payload).not.toContain('forged');

    // And nothing was recorded on the stored asset either.
    const stored = await repo.get(created.id);
    const storedEntry = stored?.statusHistory.at(-1);
    expect(storedEntry?.reason).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(storedEntry ?? {}, 'reason')).toBe(false);

    await app.close();
  });
});
