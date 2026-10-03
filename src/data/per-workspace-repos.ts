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
// workspace parameter to thread.
//
// There IS a stack to thread (issue #1058). Each call resolves the stack the
// in-flight request named via `X-Stack-Name`, read from the ambient
// request-scoped context (services/request-stack-context.ts) rather than passed
// through every router option. Previously every call here resolved with NO name
// — the first listed stack — while the transcode control plane resolved from the
// header (issue #615), so on a multi-stack installation asset documents and the
// object bytes they describe could be written to two different stacks. Outside a
// request (sweeps, boot wiring) the context is empty and resolution falls back
// to the workspace default, unchanged.

import type {
  AssetReadState,
  AssetRepository,
  AssetReviewState,
  AttachExternalIdInput,
  CreateAssetInput,
  ExternalIdentifier,
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
import type {
  AppendLogInput,
  ListLogsOptions,
  ListLogsResult,
  LogRecord,
  LogStore
} from '../services/log-store.js';
import type { WorkspaceStackResolver } from '../services/workspace-stack.js';
import { currentRequestStackName } from '../services/request-stack-context.js';
import type { AuditEmitter } from './audit-emit.js';
import type { RecordAuditInput } from './audit-repo.js';

export class PerWorkspaceAssetRepository implements AssetRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  private async repo(): Promise<AssetRepository> {
    return (await this.resolver.resolve(currentRequestStackName())).assets;
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
  async detachExternalId(id: string, ref: ExternalIdentifier): Promise<Asset | undefined> {
    return (await this.repo()).detachExternalId(id, ref);
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
  async touchUploadProgress(id: string): Promise<Asset | undefined> {
    return (await this.repo()).touchUploadProgress(id);
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
    return (await this.resolver.resolve(currentRequestStackName())).jobs;
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
    return (await this.resolver.resolve(currentRequestStackName())).pipelines;
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
    const conns = await this.resolver.resolve(currentRequestStackName());
    if (!conns.encore) {
      throw new Error('transcoding (Encore) is not configured for this stack');
    }
    return conns.encore.submit(input);
  }
  async getJobStatus(encoreJobId: string): Promise<string | undefined> {
    const conns = await this.resolver.resolve(currentRequestStackName());
    if (!conns.encore) return undefined;
    return conns.encore.getJobStatus(encoreJobId);
  }
  async cancel(encoreJobId: string): Promise<void> {
    const conns = await this.resolver.resolve(currentRequestStackName());
    // No Encore configured: nothing to cancel — idempotent no-op, matching
    // getJobStatus above.
    if (!conns.encore) return;
    return conns.encore.cancel(encoreJobId);
  }
}

export class PerWorkspaceSearchRepository implements SearchRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  async search(query: SearchQuery): Promise<SearchResult> {
    return (await this.resolver.resolve(currentRequestStackName())).search.search(query);
  }
}

export class PerWorkspaceWebhookRepository implements WebhookRepository {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  private async repo(): Promise<WebhookRepository> {
    return (await this.resolver.resolve(currentRequestStackName())).webhooks;
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
    return (await this.resolver.resolve(currentRequestStackName())).profiles;
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
    return (await this.resolver.resolve(currentRequestStackName())).collections;
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
    return (await this.resolver.resolve(currentRequestStackName())).audit;
  }
  async query(query: AuditQuery): Promise<AuditQueryResult> {
    return (await this.repo()).query(query);
  }
}

// Stack-delegating operational log store (issues #473, #996). Holds no
// connection of its own: every append/read resolves the active stack and
// delegates to that stack's log store — CouchLogStore on a Couch-backed stack
// (durable across restarts), InMemoryLogStore on the env-no-couch / in-memory
// fallback. Mirrors the other PerWorkspace* wrappers so the logs router keeps
// receiving a single `LogStore` regardless of backend.
export class PerWorkspaceLogStore implements LogStore {
  constructor(private readonly resolver: WorkspaceStackResolver) {}
  private async store(): Promise<LogStore> {
    // Resolve the stack the REQUEST names, exactly like every sibling wrapper in
    // this file (issue #1058). Calling `resolve()` with no argument keys the
    // resolver cache on '' and takes its no-stackName branch — the first-listed
    // stack (src/services/workspace-stack.ts:845-846) — so on a multi-stack
    // install the log stream was read from, and appended to, the wrong stack's
    // partition while every other surface honoured X-Stack-Name.
    return (await this.resolver.resolve(currentRequestStackName())).logs;
  }
  async append(input: AppendLogInput): Promise<LogRecord> {
    return (await this.store()).append(input);
  }
  async list(opts?: ListLogsOptions): Promise<ListLogsResult> {
    return (await this.store()).list(opts);
  }
  async size(): Promise<number> {
    return (await this.store()).size();
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
    const audit = (await this.resolver.resolve(currentRequestStackName())).audit;
    if (!audit) {
      // No durable audit store on this stack (in-memory fallback): silently
      // skip. The entry is intentionally not persisted rather than erroring.
      return undefined;
    }
    return audit.record(input);
  }
}
