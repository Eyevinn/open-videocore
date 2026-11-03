// Custom source/packaged bucket support (issue #1301, follow-up to #1299/#1300).
//
// `POST /api/v1/provision` accepts a `sourceStorage`/`packagedStorage` block in
// which `bucket` is a REQUIRED field, but historically the value never reached
// the bucket the pipeline reads or writes: the three `storeStackConfig` call
// sites in `src/routes/provision.ts` wrote the stack defaults unconditionally,
// so a stack provisioned with `sourceStorage.bucket: <operator bucket>`
// reported that bucket and emitted delivery URLs under it while every job read
// and wrote the default buckets (#1299).
//
// SCOPE (ADR-021 C1/C2). Only the BUCKET NAME is honoured, and only against the
// stack's OWN object-storage endpoint and credentials. A custom `endpointUrl`
// stays rejected by the #640 guard in provision.ts: the transcode/packaging path
// forms bucket-only `s3://<bucket>/...` URIs against one fixed endpoint and has
// no per-job endpoint or credential override, so an external endpoint still
// cannot be honoured (#641). The bucket is therefore created on, and read from,
// the same object store the stack already owns.
//
// FLAG. Honouring the field changes WHERE jobs read and write, so it ships
// behind `HONOUR_CUSTOM_BUCKETS`, OFF by default. With the flag off, bucket
// resolution returns the stack defaults — byte-identical to the pre-#1301
// behaviour — and `validateCustomBucketSupport` supplies the #1300 fail-loud
// finding for a bucket the pipeline will not use.

// The buckets a zero-config stack is provisioned with. These are the names the
// provision route creates on the stack's own object store and the values that
// land in `StackConfig.sourceBucket` / `StackConfig.packagedBucket` when the
// operator supplies no storage block (or the flag is off).
export const DEFAULT_SOURCE_BUCKET = 'openvideocore-source';
export const DEFAULT_PACKAGED_BUCKET = 'openvideocore-packaged';

// One finding about a requested bucket the current configuration will not
// honour: the dotted request path of the offending field and a human-readable
// reason. Structurally identical to provision.ts's `StorageRedirectionError` so
// the route can return both kinds in the same 400 `unsupported` array.
export type BucketSupportError = {
  field: string;
  message: string;
};

// The part of a storage block this module needs. Deliberately narrower than
// provision.ts's `ExternalStorage` (which also carries credentials) so no
// credential can reach this module by accident.
export type BucketRequest = { bucket: string } | undefined;

// Is custom-bucket honouring enabled for this process?
//
// `HONOUR_CUSTOM_BUCKETS` is read per call rather than captured at module load
// so a test (and a re-read after a config change) sees the current value. Only
// the explicit opt-in strings enable it; anything else — including an unset
// variable, the empty string and any unrecognised value — leaves the flag OFF,
// because the safe state is "jobs keep using the stack's own buckets".
export function honourCustomBucketsEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env['HONOUR_CUSTOM_BUCKETS'];
  if (raw === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

// The buckets THIS provision run must create, bind and persist.
//
// Flag ON: an operator-supplied `bucket` wins for its role; an omitted block
// keeps that role's default. Flag OFF: both roles get the stack default,
// exactly as before #1301 — the supplied value is not silently mixed in.
//
// A blank/whitespace-only bucket cannot reach here through the route
// (`externalStorageSchema` requires `min(1)`), but it is normalised to the
// default anyway so no caller can end up addressing an empty bucket name.
export function resolveStackBuckets(
  input: { sourceStorage?: BucketRequest; packagedStorage?: BucketRequest },
  opts: { honourCustomBuckets: boolean }
): { sourceBucket: string; packagedBucket: string } {
  const pick = (block: BucketRequest, fallback: string): string => {
    if (!opts.honourCustomBuckets) return fallback;
    const bucket = block?.bucket?.trim();
    return bucket && bucket.length > 0 ? bucket : fallback;
  };
  return {
    sourceBucket: pick(input.sourceStorage, DEFAULT_SOURCE_BUCKET),
    packagedBucket: pick(input.packagedStorage, DEFAULT_PACKAGED_BUCKET)
  };
}

// The buckets THIS run must bind, given BOTH what the caller supplied and what
// the stack is ALREADY bound to (review finding 2 on #1301).
//
// `resolveStackBuckets` above answers "what does this request alone ask for",
// which is the right input for a FIRST provision. It is the wrong input for a
// re-provision: provisioning converges, so a second call that omits the storage
// blocks (the zero-config call in the docs) or re-supplies the identical bucket
// must keep the stack on the bucket it is already bound to — otherwise the
// zero-config retry that resumes a partially failed custom-bucket provision
// either gets rejected as a "rebind" naming fields it never sent, or silently
// repoints the stack at the defaults.
//
// Per role, in order:
//   - A supplied bucket that DIFFERS from the stored binding is returned as-is,
//     under EITHER flag state, so `bucketRebindRejections` sees the caller's own
//     value and rejects it (issue #1301 AC3) with a truthful message.
//   - A supplied bucket IDENTICAL to the stored binding, and an OMITTED block,
//     keep the binding: not a rebind, no change, regardless of the flag.
//   - With no binding recorded (a first provision, or a config written before
//     these fields existed) the answer is `resolveStackBuckets`'s: the supplied
//     bucket with the flag on, the default with it off.
export function bindStackBuckets(
  input: { sourceStorage?: BucketRequest; packagedStorage?: BucketRequest },
  existing: { sourceBucket?: string; packagedBucket?: string },
  opts: { honourCustomBuckets: boolean }
): { sourceBucket: string; packagedBucket: string } {
  const bind = (
    block: BucketRequest,
    boundRaw: string | undefined,
    fallback: string
  ): string => {
    const requested = block?.bucket?.trim();
    const bound = boundRaw && boundRaw.length > 0 ? boundRaw : undefined;
    if (requested !== undefined && requested.length > 0) {
      if (bound !== undefined && requested !== bound) return requested;
      if (opts.honourCustomBuckets) return requested;
    }
    return bound ?? fallback;
  };
  return {
    sourceBucket: bind(input.sourceStorage, existing.sourceBucket, DEFAULT_SOURCE_BUCKET),
    packagedBucket: bind(
      input.packagedStorage,
      existing.packagedBucket,
      DEFAULT_PACKAGED_BUCKET
    )
  };
}

// One bucket for BOTH roles is rejected (review finding 1 on #1301).
//
// The packaged bucket is made anonymously readable at provision time — the
// `s3:GetObject` / `Principal {AWS: ['*']}` policy in provision.ts step 1d —
// so players can fetch manifests and segments without a bearer token (#199).
// The source bucket holds ingested masters and MUST stay private, which is why
// that policy loop targets the packaged bucket alone. If both roles resolve to
// the SAME bucket, that one policy publishes every source master to anyone who
// can guess an object key, and `POST /api/v1/provision` is not caller
// authenticated. `requiredBucketsFor` de-duplicates the pair, so nothing
// downstream notices the collapse. The defined outcome is therefore REJECT,
// before any bucket is created, bound or policied.
//
// The finding names the role path(s) the CALLER actually supplied, so the
// message never points at a field that was not in the request.
export function identicalBucketRejections(
  input: { sourceStorage?: BucketRequest; packagedStorage?: BucketRequest },
  buckets: { sourceBucket: string; packagedBucket: string }
): BucketSupportError[] {
  if (buckets.sourceBucket !== buckets.packagedBucket) return [];
  const message =
    `the source and packaged roles both resolve to the single bucket ` +
    `"${buckets.sourceBucket}", which is not supported: the packaged bucket ` +
    `is made anonymously readable (s3:GetObject for principal "*") so players ` +
    `can fetch manifests and segments without a token, so one shared bucket ` +
    `would make every ingested source master world-readable. Name a ` +
    `different bucket for each role, or omit a block to take that role's ` +
    `zero-config default.`;
  const supplied = (['sourceStorage', 'packagedStorage'] as const).filter(
    (role) => input[role] !== undefined
  );
  const fields = supplied.length > 0 ? supplied : (['sourceStorage'] as const);
  return fields.map((role) => ({ field: `${role}.bucket`, message }));
}

// The #1300 fail-loud finding set: a `bucket` that differs from the stack
// default is NOT used by the pipeline while `HONOUR_CUSTOM_BUCKETS` is off, so
// accepting the request would be the accept-but-ignore failure #1299 describes.
// Returns a finding per offending role. Empty when the flag is on (the buckets
// are honoured) or when every supplied bucket already equals the default.
export function validateCustomBucketSupport(
  input: { sourceStorage?: BucketRequest; packagedStorage?: BucketRequest },
  opts: { honourCustomBuckets: boolean }
): BucketSupportError[] {
  if (opts.honourCustomBuckets) return [];
  const findings: BucketSupportError[] = [];
  const roles: Array<[string, BucketRequest, string]> = [
    ['sourceStorage', input.sourceStorage, DEFAULT_SOURCE_BUCKET],
    ['packagedStorage', input.packagedStorage, DEFAULT_PACKAGED_BUCKET]
  ];
  for (const [role, block, expected] of roles) {
    if (!block) continue;
    if (block.bucket === expected) continue;
    findings.push({
      field: `${role}.bucket`,
      message:
        `${role}.bucket requests a bucket the pipeline does not read or ` +
        `write while HONOUR_CUSTOM_BUCKETS is off: jobs use the stack's own ` +
        `"${expected}". Set HONOUR_CUSTOM_BUCKETS=1 on the API to have the ` +
        `stack create and use "${block.bucket}" on its own object-storage ` +
        `endpoint, or supply "${expected}" (or omit the block) for the ` +
        `zero-config default.`
    });
  }
  return findings;
}

// Re-provision with a CHANGED bucket is rejected (issue #1301 acceptance
// criterion 3).
//
// Provisioning is idempotent and converges on an existing stack, so a second
// call naming a different bucket would repoint every future job at a bucket
// that holds none of the stack's existing objects. Nothing migrates them: the
// objects stay in the previously bound bucket, assets keep object keys that
// resolve against it, and already-emitted delivery URLs keep pointing at it.
// The defined outcome is therefore REJECT — the operator must provision a new
// stack (or restore the original bucket name) rather than silently split a
// stack's media across two buckets.
//
// `existing` is the stored StackConfig's bound buckets (absent for a config
// written before these fields existed, which is treated as "nothing bound yet"
// and never rejected). Comparison is exact: bucket names are case-sensitive in
// S3, so a case difference IS a different bucket.
//
// `desired` MUST be `bindStackBuckets`'s output, not `resolveStackBuckets`'s:
// the question this guard answers is "did the CALLER ask to move this stack to
// a different bucket", so an omitted block and an identical re-supply must
// arrive here already equal to the binding and produce no finding (review
// finding 2). Passing the flag-resolved set instead rejects the zero-config
// re-provision of a custom-bound stack, which also blocks resuming a partially
// failed one.
export function bucketRebindRejections(
  existing: { sourceBucket?: string; packagedBucket?: string },
  desired: { sourceBucket: string; packagedBucket: string }
): BucketSupportError[] {
  const findings: BucketSupportError[] = [];
  const roles: Array<[string, string | undefined, string]> = [
    ['sourceStorage', existing.sourceBucket, desired.sourceBucket],
    ['packagedStorage', existing.packagedBucket, desired.packagedBucket]
  ];
  for (const [role, bound, want] of roles) {
    if (bound === undefined || bound.length === 0) continue;
    if (bound === want) continue;
    findings.push({
      field: `${role}.bucket`,
      message:
        `${role}.bucket would rebind this stack from "${bound}" to "${want}". ` +
        `Existing objects are NOT migrated, so the stack's media would be ` +
        `split across two buckets and previously emitted delivery URLs would ` +
        `keep pointing at "${bound}". Re-provision with "${bound}", or ` +
        `provision a new stack for "${want}".`
    });
  }
  return findings;
}
