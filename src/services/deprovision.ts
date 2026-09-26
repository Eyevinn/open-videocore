import {
  Context,
  getInstance,
  removeInstance
} from '@osaas/client-core';
import {
  AUTO_SUBTITLES_SERVICE_ID,
  SCENE_DETECT_SERVICE_ID,
  STACK_SERVICES,
  TEARDOWN_ORDER,
  type StackService
} from './stack.js';

// A stored service entry as persisted in the parameter store (StackConfig
// .services[]). Carries the serviceId and the instance name actually
// provisioned, but not the descriptive role — that is resolved from
// STACK_SERVICES so teardown ordering and reporting stay consistent.
export type StoredService = { serviceId: string; instanceName: string };

// Per-service outcome of a teardown attempt.
//   removed    — instance existed and was removed this call
//   not_found  — instance did not exist (already gone / never created) — this
//                is a success from an idempotency standpoint
//   failed     — the OSC call errored; the operation should be retried
//   skipped    — the caller explicitly asked to KEEP this service (issue #738,
//                selective teardown): it was never probed and never removed, so
//                the instance is still live. Distinct from `failed` on purpose —
//                "kept deliberately" must not read as "could not be removed".
export type TeardownStatus = 'removed' | 'not_found' | 'failed' | 'skipped';

export type ServiceTeardownResult = {
  serviceId: string;
  role: string;
  status: TeardownStatus;
  error?: string;
};

// Aggregate stack-level status.
//   removed     — every service was removed this call
//   not_found   — every service was already absent (nothing to do)
//   partial     — the stack is not fully gone but nothing failed: either a mix
//                 of removed/not_found with at least one removal, or one or
//                 more services were deliberately kept (issue #738 selective
//                 teardown — a `skipped` service always means partial, since a
//                 live instance remains)
//   failed      — at least one service failed to tear down (retryable)
export type StackTeardownStatus =
  | 'removed'
  | 'not_found'
  | 'partial'
  | 'failed';

export type StackTeardownResult = {
  name: string;
  status: StackTeardownStatus;
  services: ServiceTeardownResult[];
};

// Tear down a single OSC service instance, tolerating the already-removed case.
// We probe with getInstance first (returns undefined on 404) so a retry of a
// partially-completed teardown reports not_found rather than re-erroring.
async function teardownService(
  osc: Context,
  service: StackService,
  name: string
): Promise<ServiceTeardownResult> {
  const { serviceId, role } = service;
  try {
    const sat = await osc.getServiceAccessToken(serviceId);

    const existing = await getInstance(osc, serviceId, name, sat);
    if (!existing) {
      return { serviceId, role, status: 'not_found' };
    }

    await removeInstance(osc, serviceId, name, sat);
    return { serviceId, role, status: 'removed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { serviceId, role, status: 'failed', error: message };
  }
}

// Order the stored service list into dependency-safe teardown order. The stored
// list (StackConfig.services[]) records what was actually provisioned but in
// provision order and without a role. We sort it by each serviceId's position
// in TEARDOWN_ORDER (consumers first) and resolve its role from STACK_SERVICES.
// Any serviceId not recognised in STACK_SERVICES is placed first (torn down
// before known producers) with role 'unknown', so an evolving stack still tears
// down cleanly rather than silently skipping an instance.
function orderStoredServices(
  stored: readonly StoredService[]
): { service: StackService; instanceName: string }[] {
  const teardownIndex = new Map<string, number>();
  TEARDOWN_ORDER.forEach((s, i) => teardownIndex.set(s.serviceId, i));
  const roleFor = new Map<string, string>(
    STACK_SERVICES.map((s) => [s.serviceId, s.role])
  );

  return [...stored]
    .sort(
      (a, b) =>
        (teardownIndex.get(a.serviceId) ?? -1) -
        (teardownIndex.get(b.serviceId) ?? -1)
    )
    .map((entry) => ({
      service: {
        serviceId: entry.serviceId,
        role: roleFor.get(entry.serviceId) ?? 'unknown'
      } as StackService,
      instanceName: entry.instanceName
    }));
}

// Selective teardown (issue #738). The caller may name OSC serviceIds to KEEP:
// every named service is left untouched and reported `skipped`, while the rest
// of the stack is torn down normally. Opt-in — an empty/absent list is exactly
// the pre-#738 whole-stack teardown.
//
// Matching is by serviceId (e.g. 'minio-minio'), the same identifier the stored
// StackConfig.services[] and GET /:name expose, so a caller can name a service
// without knowing its descriptive role.
export type SkipServiceIds = readonly string[];

// Which of the requested skip ids match none of the services this teardown would
// otherwise touch. A caller that typos a serviceId must NOT get a silent
// whole-stack teardown (the exact failure mode a "keep storage" feature cannot
// afford), so callers reject the request when this is non-empty instead of
// proceeding. Duplicates are collapsed; order follows the request.
export function unknownSkipServiceIds(
  requested: SkipServiceIds,
  candidateServiceIds: readonly string[]
): string[] {
  const known = new Set(candidateServiceIds);
  const unknown: string[] = [];
  for (const id of new Set(requested)) {
    if (!known.has(id)) unknown.push(id);
  }
  return unknown;
}

// A per-service result for a service the caller asked to keep. No OSC call is
// made — the instance is deliberately left running.
function skippedResult(service: StackService): ServiceTeardownResult {
  return { serviceId: service.serviceId, role: service.role, status: 'skipped' };
}

// Aggregate a list of per-service results into a stack-level status.
function aggregate(
  name: string,
  services: ServiceTeardownResult[]
): StackTeardownResult {
  const anyFailed = services.some((s) => s.status === 'failed');
  const anyRemoved = services.some((s) => s.status === 'removed');
  const anySkipped = services.some((s) => s.status === 'skipped');

  let status: StackTeardownStatus;
  if (anyFailed) {
    status = 'failed';
  } else if (anySkipped) {
    // A deliberately kept service means a live instance remains, so the stack
    // was NOT fully torn down however the rest of the services resolved. Report
    // partial rather than removed/not_found so the aggregate never claims the
    // stack is gone while part of it is still running.
    status = 'partial';
  } else if (!anyRemoved) {
    status = 'not_found';
  } else if (services.every((s) => s.status === 'removed')) {
    status = 'removed';
  } else {
    status = 'partial';
  }

  return { name, status, services };
}

// Tear down an entire stack in dependency-safe order using the hardcoded
// STACK_SERVICES list (legacy / fallback path). Failures do not abort the run:
// every service is attempted so a single transient error does not strand the
// rest of the stack. The whole operation is safe to retry (idempotent) because
// each step probes for existence first and treats a missing instance as success.
//
// `skipServiceIds` (issue #738) names services to KEEP: they are reported
// `skipped` and never touched. Omitted/empty means whole-stack teardown.
export async function deprovisionStack(
  osc: Context,
  name: string,
  skipServiceIds: SkipServiceIds = []
): Promise<StackTeardownResult> {
  const services: ServiceTeardownResult[] = [];
  const skip = new Set(skipServiceIds);

  // Sequential teardown: respecting dependency order requires that a consumer
  // is fully removed before the producer it depends on, so we do not parallelise.
  for (const service of TEARDOWN_ORDER) {
    if (skip.has(service.serviceId)) {
      services.push(skippedResult(service));
      continue;
    }
    services.push(await teardownService(osc, service, name));
  }

  return aggregate(name, services);
}

// The OPTIONAL, opt-in service instances a stack may have activated (issue #215
// data model; #218 teardown/report). These are long-lived services that are NOT
// part of STACK_SERVICES (they are provisioned on their own) but are recorded on
// the stored config so whole-stack teardown can remove them too.
//   autoSubtitlesInstanceName → eyevinn-auto-subtitles (AUTO_SUBTITLES_SERVICE_ID)
//   sceneDetectInstanceName   → eyevinn-function-scenes (SCENE_DETECT_SERVICE_ID)
export type OptionalStackInstances = {
  autoSubtitlesInstanceName?: string;
  sceneDetectInstanceName?: string;
};

// Map the optional instance-name fields onto StoredService entries so they can
// be enumerated for teardown alongside the core services[]. Only fields that
// carry a non-empty instance name yield an entry — an inactive optional service
// contributes nothing. The serviceIds are NOT in TEARDOWN_ORDER, so
// orderStoredServices places them first (they depend on nothing else in the
// stack) and resolves their role to 'unknown'.
function optionalStoredServices(
  optional: OptionalStackInstances | undefined
): StoredService[] {
  if (!optional) return [];
  const entries: StoredService[] = [];
  if (
    typeof optional.autoSubtitlesInstanceName === 'string' &&
    optional.autoSubtitlesInstanceName.length > 0
  ) {
    entries.push({
      serviceId: AUTO_SUBTITLES_SERVICE_ID,
      instanceName: optional.autoSubtitlesInstanceName
    });
  }
  if (
    typeof optional.sceneDetectInstanceName === 'string' &&
    optional.sceneDetectInstanceName.length > 0
  ) {
    entries.push({
      serviceId: SCENE_DETECT_SERVICE_ID,
      instanceName: optional.sceneDetectInstanceName
    });
  }
  return entries;
}

// Tear down a stack using the service list recorded in the parameter store
// (issue #29). The stored list is the source of truth for what was actually
// provisioned, so teardown removes exactly those instances — even if
// STACK_SERVICES has since changed. Each entry carries its own instanceName.
// Same idempotency and partial-failure semantics as deprovisionStack.
//
// Optional opt-in services (issue #218) are merged in from `optional`: when a
// stack activated auto-subtitles or scene-detect their instances are removed
// alongside the core services. Entries are deduped by serviceId+instanceName so
// an optional instance that was ALSO recorded in `stored` (a #216 provision that
// pushed it onto services[]) is torn down exactly once. Optional services depend
// on nothing else in the stack, so they are ordered first (unknown serviceIds
// sort ahead of the known producers in orderStoredServices) and torn down early.
// Idempotency is unchanged: a not-found optional instance during a retry reports
// not_found rather than erroring, so a partial teardown converges on retry.
//
// `skipServiceIds` (issue #738) names services to KEEP: a matching entry —
// whether it came from services[] or from an optional instance field — is
// reported `skipped` and its instance is never probed or removed, while the rest
// of the stack tears down in the usual dependency-safe order. Omitted/empty
// means whole-stack teardown, byte-for-byte the pre-#738 behaviour.
export async function deprovisionStackFromConfig(
  osc: Context,
  name: string,
  stored: readonly StoredService[],
  optional?: OptionalStackInstances,
  skipServiceIds: SkipServiceIds = []
): Promise<StackTeardownResult> {
  // Merge the optional instances into the stored list, deduped by
  // serviceId+instanceName so an instance recorded in BOTH places (services[]
  // and an optional field) is not enumerated — and thus not torn down — twice.
  const seen = new Set(
    stored.map((s) => `${s.serviceId} ${s.instanceName}`)
  );
  const merged: StoredService[] = [...stored];
  for (const entry of optionalStoredServices(optional)) {
    const dedupeKey = `${entry.serviceId} ${entry.instanceName}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    merged.push(entry);
  }

  const services: ServiceTeardownResult[] = [];
  const skip = new Set(skipServiceIds);

  for (const { service, instanceName } of orderStoredServices(merged)) {
    if (skip.has(service.serviceId)) {
      services.push(skippedResult(service));
      continue;
    }
    services.push(await teardownService(osc, service, instanceName));
  }

  return aggregate(name, services);
}
