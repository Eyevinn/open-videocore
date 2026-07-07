// CouchDB-backed profile repository (issue #84).
//
// Implements ProfileRepository on top of StackCouch, reusing the same document
// access layer as the asset/collection repositories (src/data/couchdb.ts). A
// profile is stored as a document with resourceType 'profile'; the profile name
// is the natural key, stored as the document id under a `profile-` prefix so it
// never collides with other resource ids sharing the database.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - src/data/couchdb.ts:29-93 — StackCouch.put/get/find/remove/count signatures.
//   - src/data/couch-collection-repo.ts — structural template (CouchFactory,
//     resourceType guard, toDoc/fromDoc, _rev carry-through on update).

import type { StoredDoc, StackCouch } from './couchdb.js';
import {
  ProfileExistsError,
  type CreateProfileInput,
  type Profile,
  type ProfileRepository
} from './profile-repo.js';

const RESOURCE_TYPE = 'profile';

// Document ids are namespaced so a profile called "assets" cannot collide with
// another resource's flat id in the shared database.
function docId(name: string): string {
  return `profile-${name}`;
}

export type CouchFactory = () => StackCouch;

export class CouchProfileRepository implements ProfileRepository {
  constructor(private readonly couchFor: CouchFactory) {}

  async create(input: CreateProfileInput): Promise<Profile> {
    const couch = this.couchFor();
    const existing = await couch.get(docId(input.name));
    if (existing && existing.resourceType === RESOURCE_TYPE) {
      throw new ProfileExistsError(input.name);
    }
    const now = new Date().toISOString();
    const profile: Profile = {
      name: input.name,
      yaml: input.yaml,
      createdAt: now,
      updatedAt: now
    };
    await couch.put(docId(input.name), toDoc(profile));
    return profile;
  }

  async list(): Promise<Profile[]> {
    const couch = this.couchFor();
    const docs = await couch.find({ resourceType: RESOURCE_TYPE }, { limit: 1000 });
    return docs
      .filter((d) => d.resourceType === RESOURCE_TYPE)
      .map(fromDoc)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<Profile | undefined> {
    const couch = this.couchFor();
    const doc = await couch.get(docId(name));
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    return fromDoc(doc);
  }

  async update(name: string, yaml: string): Promise<Profile | undefined> {
    const couch = this.couchFor();
    const doc = await couch.get(docId(name));
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    const existing = fromDoc(doc);
    const updated: Profile = {
      ...existing,
      yaml,
      updatedAt: new Date().toISOString()
    };
    // Carry _rev so CouchDB accepts the update in place of a create.
    await couch.put(docId(name), { ...toDoc(updated), _rev: doc._rev });
    return updated;
  }

  async delete(name: string): Promise<void> {
    const couch = this.couchFor();
    const doc = await couch.get(docId(name));
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return;
    }
    await couch.remove(docId(name));
  }

  async count(): Promise<number> {
    const couch = this.couchFor();
    return couch.count({ resourceType: RESOURCE_TYPE });
  }
}

function toDoc(profile: Profile): Record<string, unknown> {
  return {
    resourceType: RESOURCE_TYPE,
    name: profile.name,
    yaml: profile.yaml,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

function fromDoc(doc: StoredDoc): Profile {
  return {
    name: String(doc['name'] ?? ''),
    yaml: String(doc['yaml'] ?? ''),
    createdAt: String(doc['createdAt'] ?? ''),
    updatedAt: String(doc['updatedAt'] ?? '')
  };
}
