// In-memory profile repository (issue #84).
//
// Local dev / test backend. Mirrors the CouchDB layer's semantics so behaviour
// is identical regardless of backend: profiles are keyed by their name and
// create rejects a duplicate name.

import {
  ProfileExistsError,
  type CreateProfileInput,
  type Profile,
  type ProfileRepository
} from './profile-repo.js';

export class InMemoryProfileRepository implements ProfileRepository {
  private readonly store = new Map<string, Profile>();

  async create(input: CreateProfileInput): Promise<Profile> {
    if (this.store.has(input.name)) {
      throw new ProfileExistsError(input.name);
    }
    const now = new Date().toISOString();
    const profile: Profile = {
      name: input.name,
      yaml: input.yaml,
      createdAt: now,
      updatedAt: now
    };
    this.store.set(profile.name, profile);
    return { ...profile };
  }

  async list(): Promise<Profile[]> {
    return [...this.store.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ ...p }));
  }

  async get(name: string): Promise<Profile | undefined> {
    const profile = this.store.get(name);
    return profile ? { ...profile } : undefined;
  }

  async update(name: string, yaml: string): Promise<Profile | undefined> {
    const existing = this.store.get(name);
    if (!existing) {
      return undefined;
    }
    const updated: Profile = {
      ...existing,
      yaml,
      updatedAt: new Date().toISOString()
    };
    this.store.set(name, updated);
    return { ...updated };
  }

  async delete(name: string): Promise<void> {
    this.store.delete(name);
  }

  async count(): Promise<number> {
    return this.store.size;
  }
}
