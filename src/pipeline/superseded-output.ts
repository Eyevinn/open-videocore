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
//
// BUCKET AND KEY SPELLING ARE NOT IDENTITY (#1044 review, CRITICAL 1 + 2).
//
// The same physical object/location is recorded in more than one spelling, and
// every guard above is only as safe as the comparison it rests on:
//
//   - `bucket` is OPTIONAL on the persisted `PackagedOutput`
//     (src/data/asset-repo.ts:438) and on a rendition's `objectKey` (a plain
//     bucket-relative key, src/data/asset-repo.ts:450), while the DELETE path
//     resolves an absent bucket to the stack's default output bucket
//     (`resolveStorage(undefined)` -> `conns.packagedBucket`, src/main.ts). A raw
//     string compare of the two `bucket` fields therefore reported "different
//     bucket" for two records that both address the SAME bucket, which skipped
//     the equality/ancestor guards and would have deleted the replacement: the
//     legacy `{ prefix: '<assetId>/' }` (no bucket) vs a new
//     `{ bucket: '<packaged>', prefix: '<assetId>/<jobId>/' }` is exactly the
//     ancestor case the comment above claims is protected.
//   - `objectKey` is taken VERBATIM from the encoder callback
//     (`normaliseRenditions`, src/routes/internal.ts and
//     src/pipeline/encore-callback-poller.ts — `objectKey: o.file`), so
//     `transcode/a/j1/720p.mp4` and `s3://<bucket>/transcode/a/j1/720p.mp4` are
//     the same object in two spellings. Compared verbatim, the live rendition
//     classified as superseded and would have been deleted.
//
// So EVERY comparison here runs on a resolved location: the `s3://<bucket>/`
// scheme+bucket is stripped off into an explicit bucket, an absent bucket
// resolves to the caller's `defaultBucket` (the same default the delete path
// uses), and two buckets only count as DIFFERENT when both are known and
// disagree. An unknown default therefore makes the guards fire, never skip —
// "might be the same object/location" always means KEEP.

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

// A resolved storage location: the bucket it addresses (undefined only when
// NEITHER the record nor the caller's default names one — i.e. "the stack
// default, whose name we do not know here") plus a scheme-free key/prefix.
type ResolvedLocation = { bucket?: string; key: string };

// Resolve a record's optional bucket against the default the DELETE path uses
// (`resolveStorage(undefined)`). An empty/blank name counts as absent.
function resolveBucketName(
  bucket: string | undefined,
  defaultBucket: string | undefined
): string | undefined {
  const explicit = (bucket ?? '').trim();
  if (explicit.length > 0) return explicit;
  const fallback = (defaultBucket ?? '').trim();
  return fallback.length > 0 ? fallback : undefined;
}

// Could these two resolved buckets be the SAME bucket? Two buckets differ only
// when both are known and disagree; an unknown bucket (no explicit name, no
// caller default) could be any bucket, so it compares as "possibly the same".
// Every caller uses this to decide whether a KEEP guard applies, so "possibly"
// resolving to true is the conservative direction: it keeps data.
function mayBeSameBucket(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return a === b;
}

// Identity of a rendition object for comparison: the bucket it lives in plus its
// key, with any `s3://<bucket>/` scheme+bucket prefix stripped into the bucket.
// The recorded `objectKey` is either a plain bucket-relative key or an
// `s3://bucket/key` URI — both shapes are produced today, from the SAME encoder
// callback field (`o.file`, normaliseRenditions in src/routes/internal.ts and
// src/pipeline/encore-callback-poller.ts), so the two spellings must compare
// equal or a live rendition reads as superseded (#1044 review, CRITICAL 2).
function objectIdentity(
  objectKey: string,
  defaultBucket?: string
): ResolvedLocation | undefined {
  const raw = objectKey.trim();
  if (raw.length === 0) return undefined;
  const s3 = parseS3Uri(raw);
  if (s3) {
    return s3.key.length > 0
      ? { bucket: resolveBucketName(s3.bucket, defaultBucket), key: s3.key }
      : undefined;
  }
  const key = raw.replace(/^\/+/, '');
  // Reject traversal outright — WorkspaceStorage.scopedKey would throw on it,
  // and a key we cannot reason about is never a delete candidate.
  if (key.length === 0 || key.includes('..')) return undefined;
  return { bucket: resolveBucketName(undefined, defaultBucket), key };
}

// Are these two resolved locations possibly the SAME object/location? Key
// equality plus a bucket that cannot be proven different. Used for every KEEP
// decision, so an unknown bucket keeps rather than deletes.
function mayBeSameLocation(a: ResolvedLocation, b: ResolvedLocation): boolean {
  return a.key === b.key && mayBeSameBucket(a.bucket, b.bucket);
}

// The location a `PackagedOutput` addresses, as a resolved bucket + a
// slash-trimmed prefix. `prefix` is normally already scheme-free
// (`normalizePackagedPrefix`, src/pipeline/packaging.ts strips scheme+bucket),
// but a lazily-resolved or hand-written record can carry an `s3://` URI, so it
// goes through the same stripping as a rendition key: one spelling rule for
// both. Returns undefined when there is no usable prefix (nothing to delete and
// nothing to compare).
function packagedLocation(
  output: PackagedOutput | undefined,
  defaultBucket?: string
): { resolved: ResolvedLocation; explicitBucket?: string } | undefined {
  const raw = (output?.prefix ?? '').trim();
  if (raw.length === 0) return undefined;
  const s3 = parseS3Uri(raw);
  const explicitFromUri = s3?.bucket;
  const prefix = normalisePrefix(s3 ? s3.key : raw);
  if (prefix.length === 0 || prefix.includes('..')) return undefined;
  const explicitBucket = explicitFromUri ?? ((output?.bucket ?? '').trim() || undefined);
  return {
    resolved: { bucket: resolveBucketName(explicitBucket, defaultBucket), key: prefix },
    ...(explicitBucket ? { explicitBucket } : {})
  };
}

// Do these two packaged records address the SAME location (same bucket as far as
// can be proven, same prefix)? Exported for the run-identity guards in
// packaging.ts (#1044 review, MAJOR 3), so "is this callback proposing the
// generation the asset already points at?" is answered by the ONE comparison
// this module uses for its own KEEP decisions rather than a second spelling.
export function samePackagedLocation(
  a: PackagedOutput | undefined,
  b: PackagedOutput | undefined,
  defaultBucket?: string
): boolean {
  const left = packagedLocation(a, defaultBucket);
  const right = packagedLocation(b, defaultBucket);
  if (!left || !right) return false;
  return mayBeSameLocation(left.resolved, right.resolved);
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
//
// `defaultBucket` is the name of the bucket the DELETE path resolves an absent
// bucket to (the stack's default output bucket). Pass it whenever it is known:
// both sides' buckets resolve against it before being compared, so a record that
// omits `bucket` — the persisted schema makes it optional, while
// `packagedOutputFromCallback` always sets it — is treated as the default rather
// than as a DIFFERENT bucket that skips the guards below (#1044 review,
// CRITICAL 1). When it is unknown, an unnamed bucket compares as "possibly the
// same", so the guards still fire.
export function supersededPackagedPrefix(
  previous: PackagedOutput | undefined,
  next: PackagedOutput | undefined,
  defaultBucket?: string
): SupersededPrefix | undefined {
  const old = packagedLocation(previous, defaultBucket);
  const replacement = packagedLocation(next, defaultBucket);
  if (!old || !replacement) return undefined;
  const oldPrefix = old.resolved.key;
  const newPrefix = replacement.resolved.key;
  // The guards are keyed on "could these be the same bucket?", NOT on a raw
  // string compare of two optional fields: a missing bucket that resolves to the
  // delete path's default (or that cannot be resolved at all) must still reach
  // the equality + ancestor checks below, because skipping them is what deletes
  // the replacement.
  if (mayBeSameBucket(old.resolved.bucket, replacement.resolved.bucket)) {
    if (oldPrefix === newPrefix) return undefined;
    if (newPrefix.startsWith(`${oldPrefix}/`)) return undefined;
  }
  return {
    // Only an EXPLICIT bucket is carried onto the delete target: when the record
    // named none, the removal must keep resolving to the delete path's own
    // default rather than to a name this comparison resolved for it.
    ...(old.explicitBucket ? { bucket: old.explicitBucket } : {}),
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
//
// Identity is the RESOLVED location, never the recorded spelling: the same
// physical object recorded as `transcode/a/j1/720p.mp4` by one callback and as
// `s3://<bucket>/transcode/a/j1/720p.mp4` by another is ONE object, still
// referenced, and must never be deleted (#1044 review, CRITICAL 2).
// `defaultBucket` resolves a bucket-relative key exactly as in
// `supersededPackagedPrefix`; when it is unknown, a key with no bucket matches a
// scheme-qualified key with the same key path, which keeps the object.
export function supersededRenditionObjects(
  previous: Rendition[] | undefined,
  next: Rendition[] | undefined,
  alsoReferenced: Array<string | undefined> = [],
  defaultBucket?: string
): SupersededObject[] {
  if (!previous || previous.length === 0) return [];
  const referenced: ResolvedLocation[] = [];
  for (const rendition of next ?? []) {
    const identity = objectIdentity(rendition.objectKey, defaultBucket);
    if (identity) referenced.push(identity);
  }
  for (const key of alsoReferenced) {
    if (!key) continue;
    const identity = objectIdentity(key, defaultBucket);
    if (identity) referenced.push(identity);
  }

  const superseded: SupersededObject[] = [];
  // Pairwise rather than a set lookup: with an unresolvable default bucket,
  // "same object" is a MAY-match (an unnamed bucket could be any bucket), which
  // is not a hashable equality. The lists are one ABR ladder each, so the cost
  // is irrelevant next to deleting a live rendition.
  const kept: ResolvedLocation[] = [];
  for (const rendition of previous) {
    const identity = objectIdentity(rendition.objectKey, defaultBucket);
    if (!identity) continue;
    if (referenced.some((ref) => mayBeSameLocation(ref, identity))) continue;
    if (kept.some((already) => mayBeSameLocation(already, identity))) continue;
    kept.push(identity);
    // As above: only a bucket the record named EXPLICITLY (via an `s3://` URI)
    // is carried onto the delete target, so a plain key keeps resolving to the
    // delete path's own default bucket.
    const explicit = parseS3Uri(rendition.objectKey.trim())?.bucket;
    superseded.push({
      ...(explicit ? { bucket: explicit } : {}),
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
