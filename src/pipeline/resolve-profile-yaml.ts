// Profile YAML resolution for the transcode call site (issue #392).
//
// Reading a profile's YAML from the operator-managed profile store has THREE
// distinct outcomes that the caller must be able to tell apart:
//   - found            — the profile exists; its YAML was read.
//   - not-found        — the store is reachable but has no such profile. This is
//                        the ordinary case for a custom / operator-added profile
//                        that simply is not in the store.
//   - store-unreachable — the store threw (e.g. a CouchDB outage). We must NOT
//                        let this bubble up as a 500 at the transcode call site;
//                        the intended behaviour there is permissive (submit
//                        anyway), so we capture the error and label the outcome
//                        instead of throwing.
//
// Previously the call site collapsed both non-`found` outcomes into a single
// `undefined` YAML, which meant a store outage turned a transcode submit into an
// uncaught throw / 500. This resolver keeps the permissive behaviour but makes
// the distinction reachable so sibling issues can consume it:
//   - #393 will log the store-unreachable case, and
//   - #394 will surface a response warning field.
// Both need to tell store-unreachable apart from not-found; that distinction is
// what this resolver produces.
//
// CONTRACT SOURCE (CLAUDE.md rule 7):
//   src/data/profile-repo.ts — `interface ProfileRepository { get(name): Promise<Profile | undefined>; ... }`,
//   `Profile = { name; yaml; createdAt; updatedAt }`. `get()` returns `undefined`
//   for not-found. src/data/couch-profile-repo.ts lines 61-68 do not catch
//   errors from `couch.get()`, so a store outage propagates as a thrown error —
//   which is the store-unreachable signal captured here.

import type { ProfileRepository } from '../data/profile-repo.js';

export type ProfileYamlResolution =
  | { status: 'found'; yaml: string }
  | { status: 'not-found' }
  | { status: 'store-unreachable'; error: unknown };

// Resolve a profile's YAML from the (optional) profile store, distinguishing a
// genuine not-found from an unreachable store.
//
//   - `repository` absent            -> not-found (nothing to resolve).
//   - `repository.get()` returns
//     undefined                      -> not-found (store reachable, no such profile).
//   - `repository.get()` returns a
//     profile                        -> found (its YAML).
//   - `repository.get()` throws      -> store-unreachable (the error is captured,
//                                       never rethrown, so the call site stays
//                                       permissive rather than 500-ing).
export async function resolveProfileYaml(
  repository: ProfileRepository | undefined,
  profileName: string
): Promise<ProfileYamlResolution> {
  if (!repository) {
    return { status: 'not-found' };
  }
  try {
    const stored = await repository.get(profileName);
    if (stored === undefined) {
      return { status: 'not-found' };
    }
    return { status: 'found', yaml: stored.yaml };
  } catch (error) {
    return { status: 'store-unreachable', error };
  }
}
