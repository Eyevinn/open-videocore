// Build identity for a running deployment (issue #827).
//
// Problem this solves: `package.json`'s `version` is only bumped at release, so
// every build between two tags reports the earlier tag's number. Two instances
// running different images — one from the released channel, one from the
// rolling channel — reported the identical string (`info.version` in
// src/main.ts), which is worse than reporting nothing because it answers
// confidently and wrongly.
//
// The container has no `.git`, so build identity cannot be derived at runtime.
// It is therefore injected by the image build (see Dockerfile) as environment
// variables and read back here at startup:
//
//   BUILD_VERSION       `git describe --tags --always --dirty`, e.g.
//                       "v1.5.0-56-g92a13cc". Empty when the builder has no
//                       git metadata in its build context.
//   BUILD_COMMIT        full or abbreviated commit SHA the image was built from.
//   BUILD_SOURCE_DIGEST content digest of the exact source the image was built
//                       from, produced by scripts/source-digest.sh. This is the
//                       fallback identifier: it needs no git metadata, so it is
//                       always available, and it is reproducible from a
//                       checkout — running the same script at a candidate
//                       commit yields the same digest, which is how a build is
//                       mapped back to a commit when BUILD_COMMIT is absent.
//   BUILT_AT            ISO-8601 build timestamp.
//
// Anything not supplied reads back as UNKNOWN / null rather than as a
// misleading value — reporting "unknown" is the honest answer, and is
// distinguishable from a real identifier by any consumer.

export const UNKNOWN = 'unknown';

export type BuildInfo = {
  // `git describe --tags --always --dirty` at build time, or "unknown".
  version: string;
  // Commit SHA the image was built from, or "unknown".
  commit: string;
  // Digest of the source tree the image was built from, or "unknown".
  sourceDigest: string;
  // ISO-8601 build timestamp, or null when the build did not supply one.
  builtAt: string | null;
  // package.json version. Kept alongside (not instead of) the build identity:
  // it is the release-line label, not the build identity, and it is what the
  // OpenAPI document's info.version reports (src/main.ts).
  packageVersion: string;
};

// Treat empty/whitespace-only env values as absent. Container runtimes and
// `docker build --build-arg X=` both readily produce empty strings, and an
// empty string is not an identifier.
function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the build identity from an environment bag.
 *
 * Pure and env-injected so it is testable without a process-level mutation and
 * so the values stay 12-factor config rather than baked-in constants.
 */
export function resolveBuildInfo(
  env: NodeJS.ProcessEnv,
  packageVersion: string
): BuildInfo {
  return {
    version: readEnv(env, 'BUILD_VERSION') ?? UNKNOWN,
    commit: readEnv(env, 'BUILD_COMMIT') ?? UNKNOWN,
    sourceDigest: readEnv(env, 'BUILD_SOURCE_DIGEST') ?? UNKNOWN,
    builtAt: readEnv(env, 'BUILT_AT'),
    packageVersion
  };
}
