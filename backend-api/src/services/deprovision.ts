import {
  Context,
  getInstance,
  removeInstance
} from '@osaas/client-core';
import { STACK_SERVICES, TEARDOWN_ORDER, type StackService } from './stack.js';

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
export type TeardownStatus = 'removed' | 'not_found' | 'failed';

export type ServiceTeardownResult = {
  serviceId: string;
  role: string;
  status: TeardownStatus;
  error?: string;
};

// Aggregate stack-level status.
//   removed     — every service was removed this call
//   not_found   — every service was already absent (nothing to do)
//   partial     — a mix of removed/not_found, but at least one removal happened
//                 and no failures
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

// Aggregate a list of per-service results into a stack-level status.
function aggregate(
  name: string,
  services: ServiceTeardownResult[]
): StackTeardownResult {
  const anyFailed = services.some((s) => s.status === 'failed');
  const anyRemoved = services.some((s) => s.status === 'removed');

  let status: StackTeardownStatus;
  if (anyFailed) {
    status = 'failed';
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
export async function deprovisionStack(
  osc: Context,
  name: string
): Promise<StackTeardownResult> {
  const services: ServiceTeardownResult[] = [];

  // Sequential teardown: respecting dependency order requires that a consumer
  // is fully removed before the producer it depends on, so we do not parallelise.
  for (const service of TEARDOWN_ORDER) {
    services.push(await teardownService(osc, service, name));
  }

  return aggregate(name, services);
}

// Tear down a stack using the service list recorded in the parameter store
// (issue #29). The stored list is the source of truth for what was actually
// provisioned, so teardown removes exactly those instances — even if
// STACK_SERVICES has since changed. Each entry carries its own instanceName.
// Same idempotency and partial-failure semantics as deprovisionStack.
export async function deprovisionStackFromConfig(
  osc: Context,
  name: string,
  stored: readonly StoredService[]
): Promise<StackTeardownResult> {
  const services: ServiceTeardownResult[] = [];

  for (const { service, instanceName } of orderStoredServices(stored)) {
    services.push(await teardownService(osc, service, instanceName));
  }

  return aggregate(name, services);
}
