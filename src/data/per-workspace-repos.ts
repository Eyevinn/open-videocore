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
  AssetReadState,
  AssetRepository,
  AssetReviewState,
  AttachExternalIdInput,
  CreateAssetInput,
  RehydratePhase,
  SetDeleteLockInput,
  StorageByteClass,
  StorageTier,
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
import type { MessageFailureClass } from '../encore-scaler/retry-policy.js';
import type { SearchRepository, SearchQuery, SearchResult } from './search-repo.js';
import type {
  WebhookRepository,
  CreateWebhookInput,
  WebhookRegistration
} from './webhook-repo.js';
import type {
  CollectionRepository,
  CreateCollectionInput,
  UpdateCollectionInput,
  Collection
} from './collection-repo.js';
import type {
  AuditRepository,
  AuditQuery,
  AuditQueryResult
} from './audit-repo.js';
import type {
  ProfileRepository,
  CreateProfileInput,
  Profile
} from './profile-repo.js';
import type {
  PipelineRepository,
  PipelineExecution
} from './pipeline-repo.js';
import type { PipelineStepName } from '../pipeline/pipelines.js';
import type {
  EncoreClient,
  EncoreSubmitInput,
  EncoreSubmitResult
} from '../pipeline/encore-client.js';
import { decodeEncoreJobId } from './job-repo.js';
import type { WorkspaceStackResolver } from '../services/workspace-stack.js';
import type { AuditEmitter } from './audit-emit.js';
import type { RecordAuditInput } from './audit-repo.js';

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
  async getState(id: string): Promise<AssetReadState> {
    return (await this.repo()).getState(id);
  }
  async getBySlug(slug: string): Promise<Asset | undefined> {
    return (await this.repo()).getBySlug(slug);
  }
  async getByExternalId(namespace: string, id: string): Promise<Asset | undefined> {
    return (await this.repo()).getByExternalId(namespace, id);
  }
  async attachExternalId(id: string, input: AttachExternalIdInput): Promise<Asset | undefined> {
    return (await this.repo()).attachExternalId(id, input);
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
  async setDeleteLock(id: string, input: SetDeleteLockInput): Promise<Asset | undefined> {
    return (await this.repo()).setDeleteLock(id, input);
  }
  async setStorageTier(
    id: string,
    overrides: Partial<Record<StorageByteClass, StorageTier>>
  ): Promise<Asset | undefined> {
    return (await this.repo()).setStorageTier(id, overrides);
  }
  async setRehydrateState(
    id: string,
    byteClass: StorageByteClass,
    phase: RehydratePhase
  ): Promise<Asset | undefined> {
    return (await this.repo()).setRehydrateState(id, byteClass, phase);
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
  async restore(id: string): Promise<Asset | undefined> {
    return (await this.repo()).restore(id);
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
  async findActiveByAssetId(assetId: string): Promise<Job[]> {
    return (await this.repo()).findActiveByAssetId(assetId);
  }
  async update(id: string, patch: UpdateJobInput): Promise<Job | undefined> {
    return (await this.repo()).update(id, patch);
  }
  async findByEncoreJobId(encoreJobId: string): Promise<{ job: Job } | undefined> {
    return (await this.repo()).findByEncoreJobId(encoreJobId);
  }
  async appendEncodeAttempt(
    id: string,
    attempt: { index?: number; startedAt?: string; endedAt?: string; classification?: MessageFailureClass }
  ): Promise<Job | undefined> {
    return (await this.repo()).appendEncodeAttempt(id, attempt);
  }
  async finalizeEncodeAttempt(
    id: string,
    patch: { endedAt?: string; classification?: MessageFailureClass }
  ): Promise<Job | undefined> {
    return (await this.repo()).finalizeEncodeAttempt(id, patch);
  }
}

// Encore transcode client that resolves the stack's Encore at call time. Throws
// when the resolved stack has no Encore configured — the transcode route maps
// the throw to 502.
export class PerWorkspacePipelineRepository implements PipelineRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  private async repo(): Promise<PipelineRepository> {
    return (await this.resolver.resolve()).pipelines;
  }
  async create(input: {
    assetId: string;
    pipelineName: string;
    steps: PipelineStepName[];
  }): Promise<PipelineExecution> {
    return (await this.repo()).create(input);
  }
  async get(id: string): Promise<PipelineExecution | undefined> {
    return (await this.repo()).get(id);
  }
  async update(
    id: string,
    patch: Partial<
      Pick<
        PipelineExecution,
        'status' | 'steps' | 'resolvedOutputLocation' | 'relocatedPackagingIds'
      >
    >
  ): Promise<PipelineExecution | undefined> {
    return (await this.repo()).update(id, patch);
  }
  async listByAsset(assetId: string): Promise<PipelineExecution[]> {
    return (await this.repo()).listByAsset(assetId);
  }
  async listAll(opts?: {
    status?: 'running' | 'done' | 'failed';
    limit?: number;
    offset?: number;
  }): Promise<{ items: PipelineExecution[]; total: number }> {
    return (await this.repo()).listAll(opts);
  }
  async findRunningByAssetAndStep(
    assetId: string,
    step: PipelineStepName
  ): Promise<PipelineExecution | undefined> {
    return (await this.repo()).findRunningByAssetAndStep(assetId, step);
  }
}

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
  async cancel(encoreJobId: string): Promise<void> {
    const conns = await this.resolver.resolve();
    // No Encore configured: nothing to cancel — idempotent no-op, matching
    // getJobStatus above.
    if (!conns.encore) return;
    return conns.encore.cancel(encoreJobId);
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
  async collectionsContainingAsset(assetId: string): Promise<string[]> {
    return (await this.repo()).collectionsContainingAsset(assetId);
  }
  async update(id: string, patch: UpdateCollectionInput): Promise<Collection> {
    return (await this.repo()).update(id, patch);
  }
  async addAsset(id: string, assetId: string): Promise<Collection> {
    return (await this.repo()).addAsset(id, assetId);
  }
  async removeAsset(id: string, assetId: string): Promise<Collection> {
    return (await this.repo()).removeAsset(id, assetId);
  }
  async setDeleteLock(id: string, input: SetDeleteLockInput): Promise<Collection> {
    return (await this.repo()).setDeleteLock(id, input);
  }
  async delete(id: string): Promise<void> {
    return (await this.repo()).delete(id);
  }
}

// Read-only audit query surface (issue #565). Resolves the stack's audit repo
// at call time and delegates. Read-only: exposes only `query`, never a write.
export class PerWorkspaceAuditRepository implements AuditRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  private async repo(): Promise<AuditRepository> {
    return (await this.resolver.resolve()).audit;
  }
  async query(query: AuditQuery): Promise<AuditQueryResult> {
    return (await this.repo()).query(query);
  }
}

// Stack-delegating audit emitter (issue #564). Holds no connection of its own:
// on each `record()` it resolves the active stack and delegates to that stack's
// audit store (CouchAuditRepository), or no-ops when the resolved stack has no
// durable audit store (in-memory fallback). Mirrors the other PerWorkspace*
// wrappers so the routers receive a single `AuditEmitter` regardless of backend.
//
// Emission is only ever invoked through `emitAudit` (src/data/audit-emit.ts),
// which is fire-and-forget: a resolve/write failure here is caught and logged by
// the caller, never propagated into the primary operation.
export class PerWorkspaceAuditEmitter implements AuditEmitter {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  async record(input: RecordAuditInput): Promise<unknown> {
    const audit = (await this.resolver.resolve()).audit;
    if (!audit) {
      // No durable audit store on this stack (in-memory fallback): silently
      // skip. The entry is intentionally not persisted rather than erroring.
      return undefined;
    }
    return audit.record(input);
  }
}
