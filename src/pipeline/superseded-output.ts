// Deleting the output a pipeline re-run SUPERSEDED (issue #1044).
//
// THE RULE — CONFIRM THE REPLACEMENT, THEN DELETE WHAT IT REPLACED.
//
// Re-running a pipeline over an asset replaces what the asset POINTS AT, not
// what is in the bucket:
//
//   - packaged output is written under a per-run subfolder
//     (`<assetId>/<packagerJobId>/`, ADR-011: the packager's instance
//     `OutputFolder` + the default `OutputSubfolderTemplate` `$INPUTNAME$/$JOBID$`),
//     so run 2 lands BESIDE run 1 and `PackagingService.handleSuccess` simply
//     repoints `manifestUrls`/`packagedOutput` at the new subfolder;
//   - transcode output is written under `transcode/<assetId>/<jobId>/`
//     (`transcodeOutputPrefix`, src/pipeline/transcode.ts), and
//     `completeTranscode` replaces the asset's `renditions` array wholesale.
//
// Either way the previous generation stays in storage: unreferenced, not
// reachable through the API, and never deleted. This module is the ONE place
// that removes it.
//
// Two invariants the callers must honour, and that this module enforces as far
// as it can on its own:
//
//   1. ORDER — the new generation must be CONFIRMED WRITTEN first. Callers only
//      invoke this after the asset record has been updated to point at the new
//      output AND re-read back, so a re-encode that fails (or an update that did
//      not apply) can never destroy the working output. This module never
//      deletes anything it is not explicitly handed.
//   2. ONLY WHAT IS NO LONGER REFERENCED — a re-run that writes to the SAME
//      keys (overwriting in place) orphans nothing, so nothing is deleted.
//      `supersededRenditionObjects` is a set difference against the new
//      rendition keys, and `supersededPackagedPrefix` returns nothing when the
//      new prefix equals the old one, or when the old prefix is an ANCESTOR of
//      the new one (deleting it would take the replacement with it — this is
//      the real case for a legacy asset whose lazily-resolved prefix is just
//      `<assetId>/`).
//
// Everything here is BEST EFFORT: a storage error is collected and returned,
// never thrown. A re-run must not fail because the cleanup of the previous
// generation failed — the worst outcome of a swallowed error is the orphan the
// caller already had, retryable later.
//
// Issue #1243 (the retroactive sweep over output orphaned by EARLIER re-runs)
// is deliberately NOT implemented here; it is expected to reuse
// `deleteSupersededOutput` as its delete path.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - `WorkspaceStorage.removeObject(localKey: string): Promise<void>` and
//     `WorkspaceStorage.removeObjectsUnderPrefix(prefix: string): Promise<void>`
//     — src/data/storage.ts:158 and :378 (the two removal primitives; the second
//     pages listObjectsV2 under the prefix and batches removeObjects). The
//     structural subset declared below mirrors `PurgeStorage`,
//     src/pipeline/archived-asset-purge-sweep.ts:64.
//   - `Rendition` (`{ id, label, width, height, objectKey, codec?, bitrateBps? }`)
//     and `PackagedOutput` (`{ bucket?, prefix?, masterHlsKey?, masterDashKey? }`)
//     — src/data/asset-repo.ts:438 and :450.
//   - `parseS3Uri(uri): { bucket, key } | null` — src/routes/assets.ts:1738 (the
//     same resolver the archived-asset purge sweep uses to decide which bucket a
//     rendition's `objectKey` lives in).
//   - Packaged subfolder shape `<assetId>/<packagerJobId>/` — ADR-011
//     (docs/architecture/ADR-011-per-execution-packaged-output-destination.md),
//     `OutputSubfolderTemplate` default `$INPUTNAME$/$JOBID$`; derived in
//     `packagedOutputFromCallback`, src/pipeline/packaging.ts.

import type { PackagedOutput, Rendition } from '../data/asset-repo.js';
import { parseS3Uri } from '../routes/assets.js';

// The minimal object-storage surface this module needs: a structural subset of
// WorkspaceStorage (src/data/storage.ts), declared here so the rule is testable
// without a live object store — exactly as `PurgeStorage`
// (archived-asset-purge-sweep.ts) and `CancelledJobOutputStorage`
// (cancelled-transcode-completion.ts) do for their own removals.
export type SupersededOutputStorage = {
  removeObject(localKey: string): Promise<void>;
  removeObjectsUnderPrefix(prefix: string): Promise<void>;
};

// Resolve storage for one bucket. `undefined` bucket means "this stack's default
// output bucket" (the packaged/transcode-output bucket). Returning undefined
// means object storage is not configured for the stack — the deletion then
// degrades to "nothing removed, reason recorded", never to a thrown error.
export type ResolveSupersededStorage = (
  bucket?: string
) => Promise<SupersededOutputStorage | undefined> | SupersededOutputStorage | undefined;

// One object to remove. `bucket` is undefined when the key is a plain,
// bucket-relative key (it then lives in the stack's default output bucket).
export type SupersededObject = {
  bucket?: string;
  key: string;
};

// A whole packaged-output subfolder to remove (segments + manifests).
export type SupersededPrefix = {
  bucket?: string;
  prefix: string;
};

export type SupersededOutputTarget = {
  // The previous packaged subfolder, when the re-run wrote a different one.
  packagedPrefix?: SupersededPrefix;
  // Previous rendition objects whose keys the new generation no longer uses.
  renditionObjects?: SupersededObject[];
};

export type SupersededOutputDeps = {
  resolveStorage: ResolveSupersededStorage;
  // Best-effort warn sink. Optional; absent => failures are reported only
  // through the returned result.
  logWarn?: (detail: Record<string, unknown>) => void;
};

export type SupersededOutputDeletion = {
  // The packaged prefix that was removed, when one was and the removal succeeded.
  prefixRemoved?: string;
  // How many previous rendition objects were removed.
  objectsRemoved: number;
  // Non-fatal reasons something was not removed. Never thrown.
  errors: string[];
};

// Trim an object-key prefix to a comparable form: no leading or trailing
// slashes. Returns '' for a prefix that addresses the whole bucket — which this
// module NEVER deletes.
function normalisePrefix(prefix: string | undefined): string {
  return (prefix ?? '').trim().replace(/^\/+|\/+$/g, '');
}

// Identity of a rendition object for set comparison: bucket (or '' for the
// default output bucket) plus key. Built from the recorded `objectKey`, which is
// either a plain bucket-relative key or an `s3://bucket/key` URI (both shapes are
// produced today — see the archived-asset purge sweep's handling of the same
// field).
function objectIdentity(objectKey: string): { bucket?: string; key: string } | undefined {
  const raw = objectKey.trim();
  if (raw.length === 0) return undefined;
  const s3 = parseS3Uri(raw);
  if (s3) {
    return s3.key.length > 0 ? { bucket: s3.bucket, key: s3.key } : undefined;
  }
  const key = raw.replace(/^\/+/, '');
  // Reject traversal outright — WorkspaceStorage.scopedKey would throw on it,
  // and a key we cannot reason about is never a delete candidate.
  if (key.length === 0 || key.includes('..')) return undefined;
  return { key };
}

function identityToken(identity: { bucket?: string; key: string }): string {
  return `${identity.bucket ?? ''}\u0000${identity.key}`;
}

// Which packaged subfolder the re-run SUPERSEDED, if any.
//
// Returns undefined — i.e. delete nothing — when:
//   - the previous generation recorded no prefix (nothing verified to delete);
//   - the new generation recorded no prefix (nothing confirmed written, so the
//     previous output is still the only output and must be kept);
//   - the prefixes are the same location (the re-run overwrote in place);
//   - the previous prefix CONTAINS the new one (deleting it would delete the
//     replacement too).
export function supersededPackagedPrefix(
  previous: PackagedOutput | undefined,
  next: PackagedOutput | undefined
): SupersededPrefix | undefined {
  const oldPrefix = normalisePrefix(previous?.prefix);
  const newPrefix = normalisePrefix(next?.prefix);
  if (oldPrefix.length === 0 || newPrefix.length === 0) return undefined;
  const oldBucket = previous?.bucket;
  const newBucket = next?.bucket;
  const sameBucket = (oldBucket ?? '') === (newBucket ?? '');
  if (sameBucket) {
    if (oldPrefix === newPrefix) return undefined;
    if (newPrefix.startsWith(`${oldPrefix}/`)) return undefined;
  }
  return {
    ...(oldBucket ? { bucket: oldBucket } : {}),
    // Restore the trailing slash so the removal is scoped to the subfolder and
    // can never match a sibling whose name merely starts with it.
    prefix: `${oldPrefix}/`
  };
}

// Which of the PREVIOUS renditions the new generation no longer references.
//
// A same-key re-encode (the encoder overwriting the same object keys) yields an
// empty list: every previous key is still referenced, so nothing is deleted and
// the live output is never touched. A re-run that wrote to new keys (a different
// profile, or a run-nested output prefix) yields exactly the keys that fell out
// of the asset record.
//
// `alsoReferenced` carries keys that are NOT renditions but must never be
// deleted (the asset's own source `objectKey`), so a record that points a
// rendition at the source file cannot make a re-run delete the master.
export function supersededRenditionObjects(
  previous: Rendition[] | undefined,
  next: Rendition[] | undefined,
  alsoReferenced: Array<string | undefined> = []
): SupersededObject[] {
  if (!previous || previous.length === 0) return [];
  const referenced = new Set<string>();
  for (const rendition of next ?? []) {
    const identity = objectIdentity(rendition.objectKey);
    if (identity) referenced.add(identityToken(identity));
  }
  for (const key of alsoReferenced) {
    if (!key) continue;
    const identity = objectIdentity(key);
    if (identity) referenced.add(identityToken(identity));
  }

  const superseded: SupersededObject[] = [];
  const seen = new Set<string>();
  for (const rendition of previous) {
    const identity = objectIdentity(rendition.objectKey);
    if (!identity) continue;
    const token = identityToken(identity);
    if (referenced.has(token) || seen.has(token)) continue;
    seen.add(token);
    superseded.push({
      ...(identity.bucket ? { bucket: identity.bucket } : {}),
      key: identity.key
    });
  }
  return superseded;
}

// Remove the superseded output described by `target`. THE SHARED DELETE PATH:
// every caller that has confirmed a replacement generation is written funnels
// through here, and issue #1243's retroactive sweep is expected to reuse it
// rather than growing a second spelling of these removals.
//
// Best effort throughout: every failure is collected into `errors` and the
// remaining targets are still attempted. Never throws.
export async function deleteSupersededOutput(
  target: SupersededOutputTarget,
  deps: SupersededOutputDeps
): Promise<SupersededOutputDeletion> {
  const result: SupersededOutputDeletion = { objectsRemoved: 0, errors: [] };
  const { packagedPrefix, renditionObjects } = target;
  if (!packagedPrefix && (!renditionObjects || renditionObjects.length === 0)) {
    return result;
  }

  // One storage handle per distinct bucket, resolved lazily so a target with
  // nothing to delete in a bucket never builds a client for it.
  const handles = new Map<string, SupersededOutputStorage | undefined>();
  const storageFor = async (bucket?: string): Promise<SupersededOutputStorage | undefined> => {
    const cacheKey = bucket ?? '';
    if (handles.has(cacheKey)) return handles.get(cacheKey);
    let handle: SupersededOutputStorage | undefined;
    try {
      handle = await deps.resolveStorage(bucket);
    } catch (err) {
      handle = undefined;
      result.errors.push(
        `could not resolve object storage${bucket ? ` for bucket ${bucket}` : ''}: ${messageOf(err)}`
      );
    }
    handles.set(cacheKey, handle);
    return handle;
  };

  if (packagedPrefix) {
    const storage = await storageFor(packagedPrefix.bucket);
    if (!storage) {
      result.errors.push('object storage is not configured for this stack');
    } else {
      try {
        await storage.removeObjectsUnderPrefix(packagedPrefix.prefix);
        result.prefixRemoved = packagedPrefix.prefix;
      } catch (err) {
        result.errors.push(
          `could not remove superseded packaged prefix ${packagedPrefix.prefix}: ${messageOf(err)}`
        );
      }
    }
  }

  for (const object of renditionObjects ?? []) {
    const storage = await storageFor(object.bucket);
    if (!storage) {
      result.errors.push('object storage is not configured for this stack');
      continue;
    }
    try {
      await storage.removeObject(object.key);
      result.objectsRemoved += 1;
    } catch (err) {
      result.errors.push(
        `could not remove superseded rendition object ${object.key}: ${messageOf(err)}`
      );
    }
  }

  if (result.errors.length > 0) {
    deps.logWarn?.({
      msg: 'pipeline re-run: superseded output could not be fully removed',
      ...(packagedPrefix ? { packagedPrefix: packagedPrefix.prefix } : {}),
      renditionObjectCount: renditionObjects?.length ?? 0,
      errors: result.errors
    });
  }
  return result;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
