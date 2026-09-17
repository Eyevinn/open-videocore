// Provision-boundary profile bootstrap regression (issue #701).
//
// Repro + fix guard for the bug where the startup profile bootstrap seeded the
// PRE-provision no-storage in-memory fallback (because the profile repository
// resolves the *active stack* on every call, and before any stack is provisioned
// that resolve drops to `buildInMemoryConnections()`), leaving the eventually
// provisioned stack's profile store empty by construction. GET
// /api/v1/profiles/index.yml then served `{}` and Encore failed every job with
// "Could not find location for profile program! Profiles: {}".
//
// This exercises the seed path through the REAL PerWorkspaceProfileRepository
// across a provision boundary — the exact seam the existing profile tests (which
// construct InMemoryProfileRepository directly) could not observe (issue #701
// "Test gap"). It is deliberately backend-light: it does not stand up OSC,
// CouchDB, or MinIO. It drives a fake WorkspaceStackResolver whose resolved
// connections FLIP from the pre-provision in-memory fallback to a distinct
// provisioned store at the "provision boundary", which is precisely the
// behaviour WorkspaceStackResolver.resolve() exhibits (workspace-stack.ts:
// buildInMemoryConnections() before a ready stack exists, a real per-stack
// profile store after — invalidated via onStackChange).
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - PerWorkspaceProfileRepository resolves `.profiles` from the resolver on
//     every call: src/data/per-workspace-repos.ts:271-294 (repo() ->
//     (await resolver.resolve()).profiles).
//   - resolve() returns buildInMemoryConnections() when no ready stack exists:
//     src/services/workspace-stack.ts:563-578 (built = null -> in-memory).
//   - bootstrapProfiles seeds built-ins then the remote index, skipping the
//     remote seed only when NON-built-in profiles already exist (idempotent):
//     src/services/profile-bootstrap.ts:128-183.
//   - ProfileRepository surface (list/get/create/update/count):
//     src/data/profile-repo.ts:33-44.

import { describe, it, expect, afterEach, vi } from 'vitest';

import { bootstrapProfiles } from '../services/profile-bootstrap.js';
import { PerWorkspaceProfileRepository } from '../data/per-workspace-repos.js';
import { InMemoryProfileRepository } from '../data/inmemory-profile-repo.js';
import { BUILTIN_PROFILES } from '../services/builtin-profiles.js';
import type { WorkspaceStackResolver } from '../services/workspace-stack.js';

// A deterministic remote Encore profile index + per-profile YAML, served by a
// stubbed fetch so the test never touches the network. Twelve profiles mirrors
// the real default index the issue describes; the exact count is asserted below.
const REMOTE_INDEX_URL = 'https://profiles.test.invalid/profiles.yml';
const REMOTE_PROFILE_NAMES = Array.from({ length: 12 }, (_, i) => `remote-${i + 1}`);
const REMOTE_INDEX_BODY = REMOTE_PROFILE_NAMES.map((n) => `${n}: ${n}.yml`).join('\n') + '\n';

function makeRes(body: string): Response {
  return {
    ok: true,
    status: 200,
    async text() {
      return body;
    }
  } as unknown as Response;
}

// Stub fetch: the index URL returns the flat map; any per-profile YAML ref
// returns a minimal valid profile body. Both resolve relative to REMOTE_INDEX_URL.
function stubProfileFetch(): void {
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    if (url === REMOTE_INDEX_URL) return makeRes(REMOTE_INDEX_BODY);
    return makeRes('name: p\nversion: 1\n');
  }) as typeof fetch;
}

// A fake resolver that only implements the one method PerWorkspaceProfileRepository
// uses (resolve()), returning whatever connections it currently points at. The
// `.profiles` store is swapped at the provision boundary to model resolve()
// flipping from the in-memory fallback to the provisioned stack's real store.
class FlippingResolver {
  private current: { profiles: InMemoryProfileRepository };
  constructor(initial: InMemoryProfileRepository) {
    this.current = { profiles: initial };
  }
  provision(provisionedStore: InMemoryProfileRepository): void {
    // Mirrors onStackChange -> resolver.invalidate(): the next resolve() now
    // returns the newly-provisioned stack's real profile store.
    this.current = { profiles: provisionedStore };
  }
  async resolve(): Promise<{ profiles: InMemoryProfileRepository }> {
    return this.current;
  }
}

const asResolver = (r: FlippingResolver): WorkspaceStackResolver =>
  r as unknown as WorkspaceStackResolver;

describe('profile bootstrap across a provision boundary (issue #701)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('reproduces the bug: startup bootstrap seeds the pre-provision fallback, NOT the provisioned stack store', async () => {
    stubProfileFetch();

    // Pre-provision: resolve() yields the no-storage in-memory fallback.
    const preProvisionStore = new InMemoryProfileRepository();
    const resolver = new FlippingResolver(preProvisionStore);
    const profileRepository = new PerWorkspaceProfileRepository(asResolver(resolver));

    // Startup bootstrap runs against the stack-delegating repository (main.ts).
    await bootstrapProfiles({
      repository: profileRepository,
      indexUrl: REMOTE_INDEX_URL
    });

    // The startup seed landed in the pre-provision fallback.
    expect(await preProvisionStore.count()).toBeGreaterThan(0);

    // Now a stack is provisioned: resolve() flips to the new stack's own store,
    // which provisioning never seeded — it is empty by construction. THIS is the
    // bug: GET /profiles/index.yml would serve `{}` for the live stack.
    const provisionedStore = new InMemoryProfileRepository();
    resolver.provision(provisionedStore);

    expect(await provisionedStore.count()).toBe(0);
    expect(await profileRepository.count()).toBe(0);
  });

  it('the fix: re-running bootstrap through the same repository AFTER the provision boundary seeds the provisioned stack store', async () => {
    stubProfileFetch();

    const preProvisionStore = new InMemoryProfileRepository();
    const resolver = new FlippingResolver(preProvisionStore);
    const profileRepository = new PerWorkspaceProfileRepository(asResolver(resolver));

    // Startup bootstrap (seeds only the fallback, as above).
    await bootstrapProfiles({
      repository: profileRepository,
      indexUrl: REMOTE_INDEX_URL
    });

    // Provision boundary: resolve() now points at the new stack's empty store.
    const provisionedStore = new InMemoryProfileRepository();
    resolver.provision(provisionedStore);
    expect(await provisionedStore.count()).toBe(0);

    // This is what the provision route's `seedProfiles` callback does (main.ts
    // wires it to bootstrapProfiles against the SAME profileRepository, run after
    // onStackChange invalidates the resolver cache). It resolves the provisioned
    // stack and seeds it.
    const result = await bootstrapProfiles({
      repository: profileRepository,
      indexUrl: REMOTE_INDEX_URL
    });

    // The provisioned stack's store is now non-empty: built-ins + the 12 remote
    // profiles. The empty-index-serves-`{}` failure mode can no longer occur.
    const expected = BUILTIN_PROFILES.length + REMOTE_PROFILE_NAMES.length;
    expect(await provisionedStore.count()).toBe(expected);
    expect(await profileRepository.count()).toBe(expected);
    expect(result.seeded).toBe(REMOTE_PROFILE_NAMES.length);
    // A concrete remote profile and a built-in are both retrievable from the
    // provisioned stack's store.
    expect(await provisionedStore.get(REMOTE_PROFILE_NAMES[0])).toBeDefined();
    expect(await provisionedStore.get(BUILTIN_PROFILES[0].name)).toBeDefined();
  });

  it('the seed is idempotent: a second run against an already-seeded provisioned stack does not duplicate or clear profiles', async () => {
    stubProfileFetch();

    const provisionedStore = new InMemoryProfileRepository();
    const resolver = new FlippingResolver(provisionedStore);
    const profileRepository = new PerWorkspaceProfileRepository(asResolver(resolver));

    const first = await bootstrapProfiles({
      repository: profileRepository,
      indexUrl: REMOTE_INDEX_URL
    });
    const countAfterFirst = await provisionedStore.count();
    expect(first.skipped).toBe(false);
    expect(countAfterFirst).toBe(BUILTIN_PROFILES.length + REMOTE_PROFILE_NAMES.length);

    // Re-running (a retried provision hitting the same ready stack) is safe: the
    // remote seed is skipped because non-built-in profiles already exist, and the
    // count is unchanged.
    const second = await bootstrapProfiles({
      repository: profileRepository,
      indexUrl: REMOTE_INDEX_URL
    });
    expect(second.skipped).toBe(true);
    expect(await provisionedStore.count()).toBe(countAfterFirst);
  });
});
