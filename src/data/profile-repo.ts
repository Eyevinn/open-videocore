// Encore transcoding profile repository (issue #84).
//
// A profile is a named Encore transcoding profile whose YAML content is stored
// so operators can customise the available profiles without hosting their own
// remote YAML index. Profiles were previously read at runtime from a remote
// YAML index; they are now persisted (see couch-profile-repo.ts) and surfaced
// through the profiles CRUD API + a public index.yml endpoint.
//
// Two implementations share identical naming semantics (mirroring the
// asset/collection repos):
//   - InMemoryProfileRepository (inmemory-profile-repo.ts): local / tests.
//   - CouchProfileRepository (couch-profile-repo.ts): production, backed by
//     StackCouch (a dedicated CouchDB instance per tenant, ADR-003).
//
// The profile *name* (the map key in an Encore profile index) is the natural,
// human-chosen identifier and is used verbatim as the document id, so a profile
// is addressable at GET/PUT/DELETE /api/v1/profiles/:name.

export type Profile = {
  name: string;
  // Raw Encore profile YAML content. This is what an operator edits and what is
  // served (per-profile) behind the public index.yml.
  yaml: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateProfileInput = {
  name: string;
  yaml: string;
};

export interface ProfileRepository {
  create(input: CreateProfileInput): Promise<Profile>;
  list(): Promise<Profile[]>;
  get(name: string): Promise<Profile | undefined>;
  // Replace the YAML content of an existing profile. Returns undefined when the
  // profile does not exist.
  update(name: string, yaml: string): Promise<Profile | undefined>;
  delete(name: string): Promise<void>;
  // Count of stored profiles — used by the bootstrap guard so a subsequent
  // startup skips seeding when profiles already exist.
  count(): Promise<number>;
}

// Raised when a profile name is already taken on create -> 409.
export class ProfileExistsError extends Error {
  readonly statusCode = 409;
  constructor(name: string) {
    super(`profile already exists: ${name}`);
    this.name = 'ProfileExistsError';
  }
}

// Valid profile-name predicate. Names are used as CouchDB document ids and as
// path segments in GET /api/v1/profiles/:name, so they are restricted to a safe
// character set (letters, digits, dash, underscore, dot).
export function isValidProfileName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name.length > 0 && name.length <= 128;
}
