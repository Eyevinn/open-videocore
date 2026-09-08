// Unified source-object resolution (issue #612).
//
// PROBLEM this module fixes: every operation that needs an asset's SOURCE
// object (metadata extraction, transcode, package, thumbnails, clip, export)
// used to independently read `asset.objectKey` and, when it was absent, return
// a `409 no_object` with its own ad-hoc message — except the fire-and-forget
// metadata path, which was handed an objectKey out-of-band and so silently
// survived a missing key. That divergence meant one operation could succeed
// while the rest failed for the SAME asset, and any newly added operation would
// re-introduce the same class of bug.
//
// CONTRACT (verified, cited in the PR note):
//   - Authoritative field: `Asset.objectKey?: string`
//     (src/data/asset-repo.ts:420 — "MinIO object key (workspace-local) for the
//     asset payload, if any").
//   - Persisted location: `administrative.storage.key`
//     (src/data/asset-document.ts:284) mapped to/from `Asset.objectKey`
//     (src/data/asset-document.ts:464-470 write, :611 read). This is the ONE
//     authoritative field; no operation may list the bucket or infer the key.
//
// Every source-consuming operation MUST resolve the source location through
// `resolveSourceObject` (or the reply helper `requireSourceObject`) so that a
// missing source fails the SAME way everywhere: a `409 no_object`.

import type { Asset } from '../data/asset-repo.js';

// The stable, well-defined error code every source-consuming operation returns
// when the authoritative source field is absent. Kept as a single constant so
// the code is identical across all callers (metadata, transcode, package,
// thumbnails, clip, export).
export const NO_SOURCE_OBJECT_ERROR = 'no_object' as const;

// The single, consistent client message. A per-operation suffix (e.g.
// "to transcode") is intentionally NOT part of the contract: the failure is the
// same regardless of which operation asked, so the message is the same too.
export const NO_SOURCE_OBJECT_MESSAGE = 'asset has no stored source object to process' as const;

// The resolved source location of an asset. Only the authoritative object key
// is returned; the bucket is supplied by the operation's storage wiring (the
// resolver never lists a bucket or infers a key — issue #612 scope).
export type ResolvedSourceObject = {
  objectKey: string;
};

// Thrown when the authoritative source field (`Asset.objectKey`) is absent.
// Carries the shared 409 shape so a route can translate it into an identical
// HTTP response no matter which operation raised it.
export class NoSourceObjectError extends Error {
  readonly statusCode = 409;
  readonly error = NO_SOURCE_OBJECT_ERROR;
  constructor(message: string = NO_SOURCE_OBJECT_MESSAGE) {
    super(message);
    this.name = 'NoSourceObjectError';
  }
}

// THE single source-object resolver. Derives the source location from the ONE
// authoritative field on the asset document (`Asset.objectKey`). Throws a
// `NoSourceObjectError` (409 `no_object`) when that field is absent or empty, so
// every operation fails identically for a source-less asset.
export function resolveSourceObject(asset: Pick<Asset, 'objectKey'>): ResolvedSourceObject {
  const key = asset.objectKey;
  if (typeof key !== 'string' || key.length === 0) {
    throw new NoSourceObjectError();
  }
  return { objectKey: key };
}

// Non-throwing variant for callers that prefer a branch to a try/catch. Returns
// the resolved source, or `undefined` when the authoritative field is absent.
export function tryResolveSourceObject(
  asset: Pick<Asset, 'objectKey'>
): ResolvedSourceObject | undefined {
  const key = asset.objectKey;
  if (typeof key !== 'string' || key.length === 0) {
    return undefined;
  }
  return { objectKey: key };
}

// Minimal shape of a Fastify reply this module needs — declared locally so the
// pipeline layer does not take a hard dependency on Fastify types.
type ReplyLike = {
  code(statusCode: number): { send(payload: unknown): unknown };
};

// Route helper: resolve the source object or send the ONE consistent 409 and
// return `undefined`. Collapses the six copy-pasted `if (!asset.objectKey)`
// blocks (metadata, transcode, package, thumbnails, clip, export) into a single
// code path so they can never drift apart again.
//
// Usage in a handler:
//   const source = requireSourceObject(asset, reply);
//   if (!source) return reply; // 409 already sent, identically for every op
//   ... use source.objectKey ...
export function requireSourceObject(
  asset: Pick<Asset, 'objectKey'>,
  reply: ReplyLike
): ResolvedSourceObject | undefined {
  const resolved = tryResolveSourceObject(asset);
  if (!resolved) {
    reply.code(409).send({ error: NO_SOURCE_OBJECT_ERROR, message: NO_SOURCE_OBJECT_MESSAGE });
    return undefined;
  }
  return resolved;
}
