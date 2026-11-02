// Per-stack resolution of the Encore `profilesUrl`, VALID ACROSS A RESTART
// (issue #1271).
//
// Why this module exists. Each Encore instance the auto-scaler spawns fetches
// its configured `profilesUrl` with a plain, header-less, tokenless GET
// (src/encore-scaler/instance-pool.ts, `instanceBody['profilesUrl']`), so the
// stack it belongs to cannot travel in `X-Stack-Name` — it has to be in the URL
// itself. #1164 established that for the APP-SERVED index tier by rewriting
// `/api/v1/profiles/index.yml` to `/api/v1/profiles/stacks/<stack>/index.yml`
// (`stackScopedProfilesIndexUrl`, src/services/public-base-url.ts).
//
// ADR-026 D1/D2 (#1207) then inserted a new PRIMARY tier above it: the index
// this app publishes into each stack's own `openvideocore-profiles` bucket. The
// boot-time publish in src/main.ts is deliberately scoped to the DEFAULT (first
// listed) stack, because its URL seeds the process-global `profilesUrl`. On a
// FRESH instance no stack has the bucket yet, so that publish reports
// `bucket-missing`, the resolver stays on the app-path tier and #1164's rewrite
// keeps every stack on its own profiles — which is exactly why #1164 tested
// green. After a RESTART the buckets exist, the boot publish succeeds, and the
// process-global URL becomes `<default-stack-object-store>/openvideocore-profiles/index.yml`.
// `stackScopedProfilesIndexUrl` leaves that URL untouched by design (a bucket
// URL has no `/api/v1/profiles/index.yml` path to rewrite), so EVERY stack's
// Encore was handed the FIRST-listed stack's bucket index and a job using a
// profile that exists only on its own stack failed with
// "Could not find location for profile" (#1271).
//
// The fix: resolve the tier chain PER STACK instead of rewriting one
// process-global URL. For the stack a loop is being created for, the stack's own
// index is (re)published into the stack's OWN bucket and that URL is offered as
// tier 2, so the resolved URL is derived from this stack end to end. The chain
// is re-run per stack, which means a stack whose own publish is unavailable
// falls through to the app-path / parameter-store / remote-default tiers —
// never to another stack's bucket. "Another stack's profiles" is not
// representable here.
//
// Contracts verified before writing any call (CLAUDE.md rule 7):
//   - `resolveEncoreProfilesUrlWithOrigin(defaultProfilesUrl, paramStoreProfilesUrl?,
//     publishedIndexUrl?): ResolvedProfilesUrl` and
//     `stackScopedProfilesIndexUrl(profilesIndexUrl, stackKey?): string`
//     — src/services/public-base-url.ts.
//   - `PublishOutcome` (`{ ok: true; indexUrl: string; ... } | { ok: false; reason: ... }`)
//     and `makeStackScopedProfileIndexPublisher({ resolveTarget })(stackName?)`
//     — src/services/profile-index-publisher.ts.
//   - `normaliseStackName(raw?): string | undefined`
//     — src/services/request-stack-context.ts.
//   - `WorkspaceEncoreScalerConfig.resolveProfilesUrl?: (stackKey: string) =>
//     string | undefined | Promise<string | undefined>` and
//     `resolveLoopProfilesUrl` — src/encore-scaler/workspace-registry.ts (the
//     consumer; `undefined` means "use the process-global `profilesUrl`").

import { normaliseStackName } from './request-stack-context.js';
import {
  resolveEncoreProfilesUrlWithOrigin,
  stackScopedProfilesIndexUrl,
  type ProfilesUrlOrigin
} from './public-base-url.js';

// The subset of `PublishOutcome` (src/services/profile-index-publisher.ts) this
// resolver reads: the published index URL on success, nothing on failure.
export type StackPublishResult =
  | { ok: true; indexUrl: string }
  | { ok: false; reason?: string };

export type PerStackProfilesUrlLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type PerStackProfilesUrlResolution = {
  url: string;
  origin: ProfilesUrlOrigin;
};

/**
 * Build the per-stack `profilesUrl` resolver handed to the scaler registry as
 * `resolveProfilesUrl` (issue #1271).
 *
 * The returned function takes the scaler's loop key — the EFFECTIVE stack
 * identity a transcode request resolved to (issue #615) — and returns the URL
 * the Encore instances spawned for THAT stack must fetch, or `undefined` when
 * there is no per-stack form (the loop key is not a stack name, e.g. the fixed
 * deployment context of a single-stack env-override deployment). `undefined`
 * leaves the registry on the process-global `profilesUrl`, byte-identical to
 * the pre-#1271 behaviour for those deployments.
 *
 * Fail-soft end to end: `publishForStack` is expected to be
 * `makeStackScopedProfileIndexPublisher`'s result, which never throws, and a
 * rejection is caught here anyway. A stack with no publishable bucket resolves
 * through the remaining tiers (app path, parameter store, remote default), with
 * #1164's stack-scoped rewrite applied to the app-path form.
 *
 * @param deps.defaultProfilesUrl the remote default seed index (`ENCORE_PROFILES_URL`).
 * @param deps.paramStoreProfilesUrl optional operator-supplied full index URL
 *   read from the parameter store at boot (issue #315).
 * @param deps.publishForStack publishes the NAMED stack's profile index into the
 *   NAMED stack's own profiles bucket and reports its URL (ADR-026 D1/D2).
 *   Re-running it at loop-creation time is what reconstructs the per-stack
 *   mapping after a restart, instead of inheriting the boot-time default-stack
 *   URL.
 */
export function makePerStackProfilesUrlResolver(deps: {
  defaultProfilesUrl: string;
  paramStoreProfilesUrl?: string;
  publishForStack: (stackName: string) => Promise<StackPublishResult>;
  log?: PerStackProfilesUrlLogger;
}): (stackKey: string) => Promise<string | undefined> {
  // Resolved URLs, keyed per stack. Only a resolution that reached the stack's
  // OWN published bucket is cached: that outcome cannot silently become wrong
  // while the process lives (the publish is re-asserted on every profile
  // mutation through the router's republish hook). A FALLBACK outcome is
  // deliberately NOT cached, for the same reason resolveStackRedis does not
  // cache its fallback (workspace-registry.ts): a stack read mid-provision —
  // before its profiles bucket exists — must not stay pinned to the fallback
  // tier for the lifetime of the process.
  const cache = new Map<string, string>();

  return async (stackKey: string): Promise<string | undefined> => {
    const stackName = normaliseStackName(stackKey);
    if (!stackName) return undefined;

    const cached = cache.get(stackName);
    if (cached) return cached;

    const resolution = await resolveProfilesUrlForStack({
      stackName,
      defaultProfilesUrl: deps.defaultProfilesUrl,
      ...(deps.paramStoreProfilesUrl ? { paramStoreProfilesUrl: deps.paramStoreProfilesUrl } : {}),
      publishForStack: deps.publishForStack,
      ...(deps.log ? { log: deps.log } : {})
    });

    if (resolution.origin === 'object-store') cache.set(stackName, resolution.url);

    deps.log?.info(
      { stack: stackName, profilesUrl: resolution.url, origin: resolution.origin },
      'Encore profilesUrl resolved for this stack (issue #1271: resolved per stack, not inherited from the first-listed stack)'
    );
    return resolution.url;
  };
}

/**
 * Resolve the full tier chain for ONE stack (issue #1271).
 *
 * Exported for the test seam and for any future caller that needs the chosen
 * tier as well as the URL; {@link makePerStackProfilesUrlResolver} is the form
 * the scaler consumes.
 *
 * Tier order is unchanged from `resolveEncoreProfilesUrlWithOrigin` (ADR-026
 * D2) — override, published object-store index, derived app path, parameter
 * store, remote default — with two stack-aware substitutions:
 *   - tier 2 is THIS stack's published index, not the boot-time default stack's;
 *   - the app-path tier is rewritten to this stack's scoped route (#1164).
 */
export async function resolveProfilesUrlForStack(deps: {
  stackName: string;
  defaultProfilesUrl: string;
  paramStoreProfilesUrl?: string;
  publishForStack: (stackName: string) => Promise<StackPublishResult>;
  log?: PerStackProfilesUrlLogger;
}): Promise<PerStackProfilesUrlResolution> {
  let publishedIndexUrl: string | undefined;
  try {
    const outcome = await deps.publishForStack(deps.stackName);
    if (outcome.ok) {
      publishedIndexUrl = outcome.indexUrl;
    } else {
      deps.log?.warn(
        { stack: deps.stackName, reason: outcome.reason },
        'profile index for this stack is not published to its own object store; falling back to the remaining profilesUrl tiers for THIS stack (never another stack’s bucket)'
      );
    }
  } catch (err) {
    // Documented never to throw; a resolution must not fail on it either.
    deps.log?.warn(
      { err, stack: deps.stackName },
      'publishing the profile index for this stack failed; falling back to the remaining profilesUrl tiers for THIS stack'
    );
  }

  const resolved = resolveEncoreProfilesUrlWithOrigin(
    deps.defaultProfilesUrl,
    deps.paramStoreProfilesUrl,
    publishedIndexUrl
  );
  // Only the app-path tier has a stack-scoped form; every other tier is
  // returned unchanged by this helper (#1164), and tier 2 is already this
  // stack's own bucket.
  return {
    url: stackScopedProfilesIndexUrl(resolved.url, deps.stackName),
    origin: resolved.origin
  };
}
