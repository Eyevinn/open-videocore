// Stack-delegating repositories.
//
// Each wrapper implements one repository interface but holds NO connection of
// its own. On every call it asks the WorkspaceStackResolver for the stack's
// connections (resolved from the parameter store / env override) and delegates
// to the concrete repository in that stack.
//
// This keeps the router option interfaces and route handlers unchanged — they
// still receive a single repository object — while the actual backing service is
// selected lazily at call time rather than wired as a global singleton at
// startup. OSC provides structural tenant isolation (ADR-003), so there is no
// workspace parameter to thread; the resolver returns the deployment's stack.

import type {
  AssetRepository,
  AssetReviewState,
  CreateAssetInput,
  UpdateAssetInput,
  ListOptions,
  ListResult,
  Asset
} from './asset-repo.js';
import type {
  JobRepository,
  CreateJobInput,
  UpdateJobInput,
  Job
} from './job-repo.js';
import type { SearchRepository, SearchQuery, SearchResult } from './search-repo.js';
import type {
  WebhookRepository,
  CreateWebhookInput,
  WebhookRegistration
} from './webhook-repo.js';
import type {
  CollectionRepository,
  CreateCollectionInput,
  Collection
} from './collection-repo.js';
import type {
  ProfileRepository,
  CreateProfileInput,
  Profile
} from './profile-repo.js';
import type {
  EncoreClient,
  EncoreSubmitInput,
  EncoreSubmitResult
} from '../pipeline/encore-client.js';
import { decodeEncoreJobId } from './job-repo.js';
import type { WorkspaceStackResolver } from '../services/workspace-stack.js';

export class PerWorkspaceAssetRepository implements AssetRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  private async repo(): Promise<AssetRepository> {
    return (await this.resolver.resolve()).assets;
  }
  async create(input: CreateAssetInput): Promise<Asset> {
    return (await this.repo()).create(input);
  }
  async get(id: string): Promise<Asset | undefined> {
    return (await this.repo()).get(id);
  }
  async getBySlug(slug: string): Promise<Asset | undefined> {
    return (await this.repo()).getBySlug(slug);
  }
  async list(opts?: ListOptions): Promise<ListResult> {
    return (await this.repo()).list(opts);
  }
  async search(query: string): Promise<Asset[]> {
    return (await this.repo()).search(query);
  }
  async update(id: string, patch: UpdateAssetInput): Promise<Asset | undefined> {
    return (await this.repo()).update(id, patch);
  }
  async transitionReviewState(id: string, to: AssetReviewState): Promise<Asset | undefined> {
    return (await this.repo()).transitionReviewState(id, to);
  }
  async countChildren(id: string): Promise<number> {
    return (await this.repo()).countChildren(id);
  }
  async listVersions(id: string): Promise<Asset[] | undefined> {
    return (await this.repo()).listVersions(id);
  }
  async remove(id: string): Promise<Asset | undefined> {
    return (await this.repo()).remove(id);
  }
}

export class PerWorkspaceJobRepository implements JobRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  private async repo(): Promise<JobRepository> {
    return (await this.resolver.resolve()).jobs;
  }
  async create(input: CreateJobInput): Promise<Job> {
    return (await this.repo()).create(input);
  }
  async get(id: string): Promise<Job | undefined> {
    return (await this.repo()).get(id);
  }
  async list(opts?: { limit?: number; offset?: number }): Promise<{ items: Job[]; total: number }> {
    return (await this.repo()).list(opts);
  }
  async update(id: string, patch: UpdateJobInput): Promise<Job | undefined> {
    return (await this.repo()).update(id, patch);
  }
  async findByEncoreJobId(encoreJobId: string): Promise<{ job: Job } | undefined> {
    return (await this.repo()).findByEncoreJobId(encoreJobId);
  }
}

// Encore transcode client that resolves the stack's Encore at call time. Throws
// when the resolved stack has no Encore configured — the transcode route maps
// the throw to 502.
export class PerWorkspaceEncoreClient implements EncoreClient {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  async submit(input: EncoreSubmitInput): Promise<EncoreSubmitResult> {
    if (!decodeEncoreJobId(input.externalId)) {
      throw new Error('cannot decode encore externalId');
    }
    const conns = await this.resolver.resolve();
    if (!conns.encore) {
      throw new Error('transcoding (Encore) is not configured for this stack');
    }
    return conns.encore.submit(input);
  }
  async getJobStatus(encoreJobId: string): Promise<string | undefined> {
    const conns = await this.resolver.resolve();
    if (!conns.encore) return undefined;
    return conns.encore.getJobStatus(encoreJobId);
  }
}

export class PerWorkspaceSearchRepository implements SearchRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  async search(query: SearchQuery): Promise<SearchResult> {
    return (await this.resolver.resolve()).search.search(query);
  }
}

export class PerWorkspaceWebhookRepository implements WebhookRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  private async repo(): Promise<WebhookRepository> {
    return (await this.resolver.resolve()).webhooks;
  }
  async create(input: CreateWebhookInput): Promise<WebhookRegistration> {
    return (await this.repo()).create(input);
  }
  async list(): Promise<WebhookRegistration[]> {
    return (await this.repo()).list();
  }
  async delete(id: string): Promise<void> {
    return (await this.repo()).delete(id);
  }
}

export class PerWorkspaceProfileRepository implements ProfileRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  private async repo(): Promise<ProfileRepository> {
    return (await this.resolver.resolve()).profiles;
  }
  async create(input: CreateProfileInput): Promise<Profile> {
    return (await this.repo()).create(input);
  }
  async list(): Promise<Profile[]> {
    return (await this.repo()).list();
  }
  async get(name: string): Promise<Profile | undefined> {
    return (await this.repo()).get(name);
  }
  async update(name: string, yaml: string): Promise<Profile | undefined> {
    return (await this.repo()).update(name, yaml);
  }
  async delete(name: string): Promise<void> {
    return (await this.repo()).delete(name);
  }
  async count(): Promise<number> {
    return (await this.repo()).count();
  }
}

export class PerWorkspaceCollectionRepository implements CollectionRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  private async repo(): Promise<CollectionRepository> {
    return (await this.resolver.resolve()).collections;
  }
  async create(input: CreateCollectionInput): Promise<Collection> {
    return (await this.repo()).create(input);
  }
  async list(): Promise<Collection[]> {
    return (await this.repo()).list();
  }
  async get(id: string): Promise<Collection | undefined> {
    return (await this.repo()).get(id);
  }
  async addAsset(id: string, assetId: string): Promise<Collection> {
    return (await this.repo()).addAsset(id, assetId);
  }
  async removeAsset(id: string, assetId: string): Promise<Collection> {
    return (await this.repo()).removeAsset(id, assetId);
  }
  async delete(id: string): Promise<void> {
    return (await this.repo()).delete(id);
  }
}
