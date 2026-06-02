// Per-workspace delegating repositories.
//
// Each wrapper implements one repository interface but holds NO connection of
// its own. On every call it asks the WorkspaceStackResolver for the
// connections that belong to the given workspace (resolved per request from the
// parameter store / env override) and delegates to the concrete repository in
// that stack.
//
// This keeps the router option interfaces and route handlers unchanged — they
// still receive a single repository object and call `repo.method(workspaceId,
// ...)` — while the actual backing service is selected lazily, per workspace,
// at call time rather than wired as a global singleton at startup.

import type {
  AssetRepository,
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
  EncoreClient,
  EncoreSubmitInput,
  EncoreSubmitResult
} from '../pipeline/encore-client.js';
import { decodeEncoreJobId } from './job-repo.js';
import type { WorkspaceStackResolver } from '../services/workspace-stack.js';

export class PerWorkspaceAssetRepository implements AssetRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  private async repo(wid: string): Promise<AssetRepository> {
    return (await this.resolver.resolve(wid)).assets;
  }
  async create(wid: string, input: CreateAssetInput): Promise<Asset> {
    return (await this.repo(wid)).create(wid, input);
  }
  async get(wid: string, id: string): Promise<Asset | undefined> {
    return (await this.repo(wid)).get(wid, id);
  }
  async list(wid: string, opts?: ListOptions): Promise<ListResult> {
    return (await this.repo(wid)).list(wid, opts);
  }
  async search(wid: string, query: string): Promise<Asset[]> {
    return (await this.repo(wid)).search(wid, query);
  }
  async update(wid: string, id: string, patch: UpdateAssetInput): Promise<Asset | undefined> {
    return (await this.repo(wid)).update(wid, id, patch);
  }
  async countChildren(wid: string, id: string): Promise<number> {
    return (await this.repo(wid)).countChildren(wid, id);
  }
  async remove(wid: string, id: string): Promise<Asset | undefined> {
    return (await this.repo(wid)).remove(wid, id);
  }
}

export class PerWorkspaceJobRepository implements JobRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  private async repo(wid: string): Promise<JobRepository> {
    return (await this.resolver.resolve(wid)).jobs;
  }
  async create(wid: string, input: CreateJobInput): Promise<Job> {
    return (await this.repo(wid)).create(wid, input);
  }
  async get(wid: string, id: string): Promise<Job | undefined> {
    return (await this.repo(wid)).get(wid, id);
  }
  async update(wid: string, id: string, patch: UpdateJobInput): Promise<Job | undefined> {
    return (await this.repo(wid)).update(wid, id, patch);
  }
  // No workspace context: the unauthenticated Encore callback looks a transcode
  // job up by its opaque encoreJobId. The id embeds the owning workspace
  // (see encodeEncoreJobId), so decode it, resolve that workspace's stack, and
  // delegate. Returns undefined when the id is undecodable or unknown.
  async findByEncoreJobId(
    encoreJobId: string
  ): Promise<{ workspaceId: string; job: Job } | undefined> {
    const decoded = decodeEncoreJobId(encoreJobId);
    if (!decoded) return undefined;
    const repo = await this.repo(decoded.workspaceId);
    return repo.findByEncoreJobId(encoreJobId);
  }
}

// Per-workspace Encore transcode client. submit() has no explicit workspace
// argument, but the EncoreSubmitInput.externalId embeds the owning workspace +
// job id (see job-repo.encodeEncoreJobId), so we decode it to select the right
// stack's Encore. Throws when the workspace cannot be derived or the resolved
// stack has no Encore configured — the transcode route maps the throw to 502.
export class PerWorkspaceEncoreClient implements EncoreClient {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  async submit(input: EncoreSubmitInput): Promise<EncoreSubmitResult> {
    const decoded = decodeEncoreJobId(input.externalId);
    if (!decoded) {
      throw new Error('cannot derive workspace from encore externalId');
    }
    const conns = await this.resolver.resolve(decoded.workspaceId);
    if (!conns.encore) {
      throw new Error('transcoding (Encore) is not configured for this workspace');
    }
    return conns.encore.submit(input);
  }
}

export class PerWorkspaceSearchRepository implements SearchRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  async search(wid: string, query: SearchQuery): Promise<SearchResult> {
    return (await this.resolver.resolve(wid)).search.search(wid, query);
  }
}

export class PerWorkspaceWebhookRepository implements WebhookRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  private async repo(wid: string): Promise<WebhookRepository> {
    return (await this.resolver.resolve(wid)).webhooks;
  }
  async create(wid: string, input: CreateWebhookInput): Promise<WebhookRegistration> {
    return (await this.repo(wid)).create(wid, input);
  }
  async list(wid: string): Promise<WebhookRegistration[]> {
    return (await this.repo(wid)).list(wid);
  }
  async delete(wid: string, id: string): Promise<void> {
    return (await this.repo(wid)).delete(wid, id);
  }
}

export class PerWorkspaceCollectionRepository implements CollectionRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  private async repo(wid: string): Promise<CollectionRepository> {
    return (await this.resolver.resolve(wid)).collections;
  }
  async create(wid: string, input: CreateCollectionInput): Promise<Collection> {
    return (await this.repo(wid)).create(wid, input);
  }
  async list(wid: string): Promise<Collection[]> {
    return (await this.repo(wid)).list(wid);
  }
  async get(wid: string, id: string): Promise<Collection | undefined> {
    return (await this.repo(wid)).get(wid, id);
  }
  async addAsset(wid: string, id: string, assetId: string): Promise<Collection> {
    return (await this.repo(wid)).addAsset(wid, id, assetId);
  }
  async removeAsset(wid: string, id: string, assetId: string): Promise<Collection> {
    return (await this.repo(wid)).removeAsset(wid, id, assetId);
  }
  async delete(wid: string, id: string): Promise<void> {
    return (await this.repo(wid)).delete(wid, id);
  }
}
