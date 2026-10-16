// Publisher for the OBJECT-STORE-SERVED Encore profile index
// (ADR-026-profiles-url-source.md, decisions D1/D2/D3; issue #1207).
//
// Why this module exists. Each Encore instance the auto-scaler spawns is a
// separate OSC container that HTTP-GETs its configured `profilesUrl` with Java's
// `UrlResource` — a plain, UNAUTHENTICATED GET. Until now that URL pointed at
// this app's own `GET /api/v1/profiles/index.yml`, which is only reachable
// because of an orchestrator-level auth-gate exemption that no OSC contract can
// set, read, or assert (ADR-026 C3). ADR-026 D1 therefore makes a dedicated
// object-store bucket the PRIMARY source of the profile index: this app
// publishes `index.yml` plus one `<name>.yml` per runnable profile into
// `openvideocore-profiles` and hands Encore that bucket's `index.yml` URL. The
// reachability of that origin is a property this app configures itself (the
// anonymous-read `GetObject` policy already shipped for the packaged bucket,
// ADR-026 C6/D3) instead of a standing wager on platform configuration.
//
// Contracts verified before writing any call here (CLAUDE.md rule 7):
//   - `minio` package type declarations, v8.0.7 —
//     node_modules/minio/dist/esm/internal/client.d.mts:
//       `bucketExists(bucketName: string): Promise<boolean>`
//       `putObject(bucketName, objectName, stream: stream.Readable | Buffer | string,
//                  size?: number, metaData?: ItemBucketMetadata): Promise<UploadedObjectInfo>`
//       `setBucketPolicy(bucketName: string, policy: string): Promise<void>`
//     Those three signatures are the entire object-store surface used below, and
//     they are the same client (`WorkspaceConnections.storageClient`,
//     src/services/workspace-stack.ts) the provisioning path already drives.
//   - Encore `profilesUrl` is a bare URL string with NO companion credential,
//     header or token field — live `get-service-schema(serviceId: "encore",
//     verbosity: "detailed")`, `structuredContent.configOptions`, recorded
//     verbatim in ADR-026 C1. Hence: the published objects must be fetchable by
//     an unauthenticated GET of a plain URL, which is exactly what D3's
//     anonymous-read policy provides.
//   - `encore` models its object-store dependency as
//     `serviceAssociations[0] = { parameter: "s3Endpoint", serviceId:
//     "minio-minio", protocol: "http", routing: "INTERNAL" }` and
//     `supportsUpdate: false` (ADR-026 C2) — so the IN-CLUSTER endpoint is the
//     preferred form of the published URL (D2), and a presigned URL is rejected
//     (it could never be refreshed on a running instance).
//
// Scope boundaries (deliberate):
//   - This module NEVER creates the bucket. Provisioning the
//     `openvideocore-profiles` bucket is its own issue (#1208, ADR-026 §5 item
//     2) because it changes src/routes/provision.ts and the teardown path. When
//     the bucket does not exist yet, publishing reports `bucket-missing` and the
//     resolver simply keeps using the pre-ADR-026 tiers — i.e. today's
//     behaviour, as ADR-026 §4 ("Pre-existing stacks") requires.
//   - The app's own `GET /api/v1/profiles/index.yml` and
//     `GET /api/v1/profiles/:name/yaml` are NOT touched: their body, status,
//     `x-profile-count` header (#460) and `{}`-for-empty body (#459) contracts
//     are explicitly out of scope (ADR-026 §6).

import { isProfileRunnable } from './profile-runnability.js';

// The DEDICATED bucket for the published profile index (ADR-026 D1). Dedicated,
// not a prefix on `openvideocore-packaged`, so the profiles policy and the media
// policy stay independently auditable and a profile object can never collide
// with a packaged key. Kept here as the single source of truth so the publisher
// and the provisioning step (#1208) cannot drift; mirrors how
// SOURCE_BUCKET/PACKAGED_BUCKET are pinned in src/routes/provision.ts.
export const PROFILES_BUCKET = 'openvideocore-profiles';

// Object key of the published index, i.e. the tail of the `profilesUrl` handed
// to Encore.
export const PUBLISHED_INDEX_KEY = 'index.yml';

// Content type written on every published object. Matches what the app's own
// profiles router sends for the same bytes (`text/yaml; charset=utf-8`).
export const PUBLISHED_YAML_CONTENT_TYPE = 'text/yaml; charset=utf-8';

/**
 * Object key of one published profile document.
 *
 * ADR-026 D1: the index's relative target changes from `<name>/yaml` (the app
 * route shape) to `<name>.yml` so it resolves correctly against a bucket base
 * URL — a bucket has no route that would serve `<name>/yaml`.
 */
export function publishedProfileObjectKey(name: string): string {
  return `${name}.yml`;
}

/** The minimal profile shape the publisher reads (subset of `Profile`). */
export type PublishableProfile = { name: string; yaml: string };

/**
 * Render the Encore-format index for the PUBLISHED objects.
 *
 * Deliberately the same shape the `GET /index.yml` handler in
 * src/routes/profiles.ts already emits — GPU-only profiles filtered out with
 * {@link isProfileRunnable} (#286), names sorted, and `{}` for an empty store so
 * a YAML parser never sees a zero-byte body (#459) — with the single documented
 * difference from ADR-026 D1: the relative target is `<name>.yml`.
 *
 * This renders the index for the BUCKET. It does not and must not change the
 * HTTP route's rendering (ADR-026 §6).
 */
export function renderPublishedProfileIndex(profiles: PublishableProfile[]): string {
  const lines = profiles
    .filter((p) => isProfileRunnable(p.yaml))
    .map((p) => p.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `${name}: ${publishedProfileObjectKey(name)}`);
  if (lines.length === 0) return '{}\n';
  return lines.join('\n') + '\n';
}

/**
 * Count the profile entries in a PUBLISHED index body.
 *
 * The inverse of {@link renderPublishedProfileIndex}, kept next to it so the
 * writer and the reader cannot drift. Used by the boot-time publish
 * verification (ADR-026 D4, issue #1209): the probe GETs the published
 * `index.yml` and compares the number of entries it actually serves against the
 * number the publisher reported writing (`PublishOutcome.profileCount`), so a
 * stale or partially-written bucket is surfaced loudly instead of silently
 * handing Encore an index that is missing profiles.
 *
 * Mirrors the renderer exactly: `{}` is the empty-store body (#459) and counts
 * as zero, blank lines are ignored, and every other non-blank line is one
 * `name: <name>.yml` entry.
 */
export function countPublishedProfileIndexEntries(indexBody: string): number {
  return indexBody
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== '{}').length;
}

/**
 * The anonymous (public) read-only bucket policy for the profiles bucket
 * (ADR-026 D3).
 *
 * A VERBATIM re-use of the shape already shipped for the packaged bucket
 * (`packagedPolicy` + `setBucketPolicy` in src/routes/provision.ts, issue
 * #199): allow only `s3:GetObject` for principal `*` on this bucket's object
 * prefix. No `ListBucket` and no write — objects are readable by exact key and
 * the bucket is not browsable. `setBucketPolicy` overwrites, so applying it
 * repeatedly converges.
 *
 * Exported so the provisioning step (#1208) applies the IDENTICAL document
 * rather than a hand-copied one.
 */
export function profilesBucketAnonymousReadPolicy(bucket: string = PROFILES_BUCKET): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`]
      }
    ]
  });
}

/**
 * Build the published index URL for an object-store origin.
 *
 * @param objectStoreEndpoint an absolute object-store base URL — either the
 *   in-cluster form `http://<service>.minio-minio.svc.cluster.local:8080`
 *   (preferred, ADR-026 D2 step 1) or the stack's stored public endpoint
 *   (`StackConfig.minioEndpoint`, D2 step 2).
 * @returns `<endpoint>/<bucket>/index.yml`, or `undefined` when the endpoint is
 *   absent or not a usable absolute URL (never throws: a malformed stored
 *   endpoint must degrade to the fallback tiers, not fail boot).
 */
export function publishedProfilesIndexUrl(
  objectStoreEndpoint: string | undefined,
  bucket: string = PROFILES_BUCKET
): string | undefined {
  if (!objectStoreEndpoint) return undefined;
  const base = objectStoreEndpoint.trim().replace(/\/+$/, '');
  if (!base) return undefined;
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }
  return `${base}/${bucket}/${PUBLISHED_INDEX_KEY}`;
}

// The three object-store calls this module makes, typed structurally so a test
// can supply a stub and so the module does not depend on the concrete
// `minio.Client` class. Signatures copied from the v8.0.7 declarations cited in
// the module header.
export type ProfilesBucketClient = {
  bucketExists(bucketName: string): Promise<boolean>;
  putObject(
    bucketName: string,
    objectName: string,
    stream: Buffer | string,
    size?: number,
    metaData?: Record<string, string>
  ): Promise<unknown>;
  setBucketPolicy(bucketName: string, policy: string): Promise<void>;
};

export type PublisherLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type PublishOutcome =
  | {
      ok: true;
      indexUrl: string;
      bucket: string;
      // Count of PUBLISHED profile entries — the runnable profiles actually
      // written to the index. The publish-verification check (#1209, ADR-026
      // D4) compares this against the store.
      profileCount: number;
      // Which D2 form the published URL took, for the boot log.
      endpointKind: 'in-cluster' | 'public';
    }
  | {
      ok: false;
      reason: 'no-object-store' | 'bucket-missing' | 'write-failed';
      bucket?: string;
      err?: unknown;
    };

/**
 * Publish the profile index and the per-profile YAML documents to the dedicated
 * profiles bucket, and report the URL Encore should be handed (ADR-026 D1/D2).
 *
 * Fail-soft by construction — it NEVER throws and never rejects. Every negative
 * result is an `ok: false` outcome the caller turns into "do not use tier 2",
 * which leaves the resolver on exactly the pre-ADR-026 tiers. That is required
 * by ADR-026 D2 reason 2 (an out-of-sync publisher must degrade to the
 * operator-managed app route, never to the remote default seed index) and by
 * ADR-026 §4 (a stack provisioned before this change simply falls through).
 *
 * @param deps.storageClient the resolved stack's object-store client
 *   (`WorkspaceConnections.storageClient`). Absent on the in-memory/no-storage
 *   path → `no-object-store`.
 * @param deps.objectStoreEndpoint the stack's stored PUBLIC object-store
 *   endpoint (`StackConfig.minioEndpoint`, via `stackResolvedMinioEndpoint`).
 *   Absent for the env-override and in-memory paths → `no-object-store`, which
 *   is the exclusion src/routes/assets.ts already records for those paths.
 * @param deps.resolveEndpoint optional in-cluster endpoint seam —
 *   `makeInternalEndpointResolver` (src/services/internal-minio-endpoint.ts),
 *   which is probed before use and fail-soft back to the public endpoint by
 *   construction (ADR-026 C7). When it returns a different endpoint, that
 *   in-cluster form is used for the published URL (D2 step 1).
 * @param deps.listProfiles reads the profile store (the repository's `list()`).
 */
export async function publishProfileIndex(deps: {
  storageClient: ProfilesBucketClient | undefined;
  objectStoreEndpoint: string | undefined;
  resolveEndpoint?: (publicEndpoint: string) => Promise<string>;
  listProfiles: () => Promise<PublishableProfile[]>;
  bucket?: string;
  log?: PublisherLogger;
}): Promise<PublishOutcome> {
  const bucket = deps.bucket ?? PROFILES_BUCKET;
  const { storageClient, objectStoreEndpoint, log } = deps;

  if (!storageClient || !objectStoreEndpoint) {
    return { ok: false, reason: 'no-object-store' };
  }

  try {
    // The bucket is provisioned by the stack-provisioning path (#1208), not
    // here. A pre-ADR-026 stack has no profiles bucket, and that MUST read as
    // "fall through to the existing tiers", not as an error.
    const exists = await storageClient.bucketExists(bucket);
    if (!exists) {
      log?.warn(
        { bucket },
        'profile index publish skipped: the profiles bucket does not exist on this stack (it is created by stack provisioning, issue #1208) — Encore keeps using the pre-existing profilesUrl tiers'
      );
      return { ok: false, reason: 'bucket-missing', bucket };
    }

    const profiles = await deps.listProfiles();
    const index = renderPublishedProfileIndex(profiles);
    const runnable = profiles.filter((p) => isProfileRunnable(p.yaml));

    // Per-profile documents first, then the index, so the index never names an
    // object that is not there yet. (The reverse order would give Encore a
    // window in which a listed profile 404s.)
    for (const profile of runnable) {
      const body = Buffer.from(profile.yaml, 'utf8');
      await storageClient.putObject(
        bucket,
        publishedProfileObjectKey(profile.name),
        body,
        body.byteLength,
        { 'Content-Type': PUBLISHED_YAML_CONTENT_TYPE }
      );
    }
    const indexBody = Buffer.from(index, 'utf8');
    await storageClient.putObject(bucket, PUBLISHED_INDEX_KEY, indexBody, indexBody.byteLength, {
      'Content-Type': PUBLISHED_YAML_CONTENT_TYPE
    });

    // Re-assert the anonymous-read policy (ADR-026 D3) after a successful
    // publish. `setBucketPolicy` overwrites, so this converges rather than
    // accumulating, and a failure here is swallowed: provisioning (#1208) is the
    // authoritative applier, this is only a best-effort re-assertion so a bucket
    // that lost its policy out of band is repaired on the next publish.
    try {
      await storageClient.setBucketPolicy(bucket, profilesBucketAnonymousReadPolicy(bucket));
    } catch (err) {
      log?.warn(
        { err, bucket },
        'profile index publish: could not re-assert the anonymous-read bucket policy (best-effort; stack provisioning applies it authoritatively)'
      );
    }

    // Prefer the in-cluster endpoint (ADR-026 D2 step 1): it matches the
    // `routing: INTERNAL` the platform itself models for Encore -> object store
    // (C2) and never touches the public edge or the auth gate. The resolver
    // probes before use and falls back to the public endpoint it was handed, so
    // a `!==` comparison is the honest test of which form we got.
    let endpoint = objectStoreEndpoint;
    let endpointKind: 'in-cluster' | 'public' = 'public';
    if (deps.resolveEndpoint) {
      try {
        const resolved = await deps.resolveEndpoint(objectStoreEndpoint);
        if (resolved && resolved !== objectStoreEndpoint) {
          endpoint = resolved;
          endpointKind = 'in-cluster';
        }
      } catch (err) {
        // Documented never to throw, but a publish must not fail on it.
        log?.warn(
          { err },
          'profile index publish: in-cluster endpoint resolution failed; using the stack public object-store endpoint'
        );
      }
    }

    const indexUrl = publishedProfilesIndexUrl(endpoint, bucket);
    if (!indexUrl) {
      return { ok: false, reason: 'no-object-store', bucket };
    }

    log?.info(
      { bucket, indexUrl, profileCount: runnable.length, endpointKind },
      'profile index published to the object store (ADR-026 D1)'
    );
    return { ok: true, indexUrl, bucket, profileCount: runnable.length, endpointKind };
  } catch (err) {
    log?.warn(
      { err, bucket },
      'profile index publish FAILED: Encore keeps using the pre-existing profilesUrl tiers (the app-served index, the parameter-store URL, or the remote default)'
    );
    return { ok: false, reason: 'write-failed', bucket, err };
  }
}

/**
 * Everything one publish needs, all of it belonging to ONE stack.
 *
 * This type is the fix for issue #1207 review BLOCKING 1: the write target
 * (`storageClient` + `objectStoreEndpoint`) and the read source
 * (`listProfiles`) are produced together, from a single resolution of a single
 * stack name, so a publish cannot mix two stack scopes.
 */
export type ProfileIndexPublishTarget = {
  /** The stack's object-store client (`WorkspaceConnections.storageClient`). */
  storageClient: ProfilesBucketClient | undefined;
  /** The stack's stored PUBLIC object-store endpoint (`StackConfig.minioEndpoint`). */
  objectStoreEndpoint: string | undefined;
  /** The SAME stack's profile store (`WorkspaceConnections.profiles.list()`). */
  listProfiles: () => Promise<PublishableProfile[]>;
  /** Optional in-cluster endpoint seam for this stack (ADR-026 D2 step 1, C7). */
  resolveEndpoint?: (publicEndpoint: string) => Promise<string>;
};

/**
 * Build the stack-scoped republish entry point used by the app
 * (`publishProfileIndexToObjectStore` in src/main.ts) and by the republish hook
 * the profiles router fires after every mutation.
 *
 * The returned function takes the ONE stack name to publish for and threads it
 * through `resolveTarget`, which must resolve BOTH sides of the publish from
 * that single name. `undefined` means the workspace default stack, exactly as
 * `WorkspaceStackResolver.resolve(stackName?)` defines it (cache key
 * `stackName ?? ''`, src/services/workspace-stack.ts).
 *
 * Why a factory rather than a closure in main.ts (issue #1207 review, BLOCKING
 * 1): the previous closure resolved its WRITE target with no stack name while
 * reading profiles through the request-scoped repository, which the
 * `void`-detached hook inherits via AsyncLocalStorage. A
 * `PUT /api/v1/profiles/:name` with `X-Stack-Name: stack-b` therefore wrote
 * stack-b's profiles into the DEFAULT stack's bucket — clobbering the index
 * Encore fetches and exposing another workspace's profile YAML under D3's
 * anonymous-read policy. With one name feeding both sides that is no longer
 * representable, and it is covered by
 * src/routes/profiles.republish-stack-scope.test.ts.
 *
 * Fail-soft like {@link publishProfileIndex}: a `resolveTarget` rejection
 * (unresolvable stack, broken parameter store) is logged and reported as
 * `no-object-store`, never thrown, so a publish failure can never change the
 * profiles HTTP contract (ADR-026 §6).
 */
export function makeStackScopedProfileIndexPublisher(deps: {
  resolveTarget: (stackName: string | undefined) => Promise<ProfileIndexPublishTarget>;
  bucket?: string;
  log?: PublisherLogger;
}): (stackName: string | undefined) => Promise<PublishOutcome> {
  return async (stackName: string | undefined): Promise<PublishOutcome> => {
    let target: ProfileIndexPublishTarget;
    try {
      target = await deps.resolveTarget(stackName);
    } catch (err) {
      deps.log?.warn(
        { err, stackName },
        'profile index publish skipped: could not resolve the stack object store; Encore keeps the pre-ADR-026 profilesUrl tiers'
      );
      return { ok: false, reason: 'no-object-store' };
    }
    return publishProfileIndex({
      storageClient: target.storageClient,
      objectStoreEndpoint: target.objectStoreEndpoint,
      ...(target.resolveEndpoint ? { resolveEndpoint: target.resolveEndpoint } : {}),
      listProfiles: target.listProfiles,
      ...(deps.bucket ? { bucket: deps.bucket } : {}),
      ...(deps.log ? { log: deps.log } : {})
    });
  };
}
