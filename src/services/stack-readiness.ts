// Packaging-aware stack readiness computation (issue #338).
//
// PROBLEM: GET /api/v1/provision/:name reported "status":"ready" purely from the
// stored StackConfig.status, which is set to 'ready' the moment the core stack
// (storage + database + queue) finishes provisioning. But a stack whose service
// inventory (StackConfig.services[]) cannot complete PACKAGING must not report
// ready — the full ingest -> transcode -> package -> deliver flow is broken.
//
// PACKAGING CAPABILITY MODEL (see src/services/stack.ts and
// src/services/packager-provisioning.ts):
//   - The Encore packager (PACKAGER_SERVICE_ID) is deliberately NOT in
//     STACK_SERVICES. It is provisioned LAZILY at first package-step execution
//     (ensurePackagerProvisioned) and torn down on deprovision.
//   - Therefore "ready" must NOT require the packager to be eagerly present in
//     the inventory. Instead readiness reflects whether the stack CAN package:
//       (a) the packager is already recorded in services[] (e.g. after issue
//           #335 records a successfully-created on-demand packager), OR
//       (b) the on-demand packager capability is provably available: the
//           dependencies the on-demand ensure step wires the packager to are
//           present in the inventory. buildPackagerCreateBody() shows the
//           packager consumes the shared Valkey QUEUE (RedisUrl) and writes CMAF
//           to the packaged STORAGE (OutputFolder / S3EndpointUrl). With those
//           present, and PACKAGER_SERVICE_ID being a statically-known permitted
//           service, the packager can always be provisioned on demand.
//
// So a stack is ready for the full flow when its inventory contains every core
// capability (storage + database + queue) AND the packaging capability holds by
// rule (a) or (b). The queue+storage requirement is exactly the on-demand
// packager's dependency set, so a stack missing them cannot package even lazily.
//
// The reason field is MACHINE-READABLE (a stable enum of reason codes plus the
// missing capability name) so a consumer can act on it programmatically.

import type { StackConfig } from './param-store.js';
import { STACK_SERVICES, PACKAGER_SERVICE_ID } from './stack.js';

// The capabilities a stack must expose in its service inventory to complete the
// full ingest -> transcode -> package -> deliver flow. Derived from
// STACK_SERVICES (the single source of truth) so this never drifts from the
// actual provisioned service set. Each capability maps to the role of a
// STACK_SERVICES entry.
//
// NOTE the packaging capability is NOT a member of this set: packaging is
// on-demand (the packager is not in STACK_SERVICES). Packaging capability is
// evaluated separately (see packagerCapability) precisely because it can be
// satisfied lazily.
export type StackCapability = (typeof STACK_SERVICES)[number]['role'];

// Machine-readable readiness state exposed on the status response. 'ready' means
// the stack can complete the full flow; 'degraded' means a required capability
// is missing and the stack cannot (a non-ready state distinct from the
// lifecycle states 'provisioning'/'failed', which mean the stack never finished
// coming up in the first place).
export type ReadinessState = 'ready' | 'provisioning' | 'failed' | 'degraded';

// Stable machine-readable reason codes for a non-ready readiness result. A
// consumer switches on `code`; `capability` names the specific missing
// capability for the *_capability_missing codes.
export type ReadinessReasonCode =
  // The stored StackConfig.status is 'provisioning' — the stack never finished
  // coming up. (Lifecycle state, not an inventory gap.)
  | 'stack_provisioning'
  // The stored StackConfig.status is 'failed' — provisioning did not complete.
  | 'stack_provisioning_failed'
  // A core capability (storage/database/queue) is absent from services[].
  | 'core_capability_missing'
  // The stack cannot package: the on-demand packager's dependencies
  // (queue + packaged storage) are not both present in services[], AND the
  // packager itself is not recorded in services[]. capability === 'packaging'.
  | 'packaging_capability_missing';

export type ReadinessReason = {
  code: ReadinessReasonCode;
  // The missing capability, when the code names one: a StackCapability
  // ('storage'|'database'|'queue') for core_capability_missing, or the literal
  // 'packaging' for packaging_capability_missing. Absent for lifecycle codes.
  capability?: StackCapability | 'packaging';
  // Human-readable explanation. Complements (never replaces) the machine-
  // readable code/capability above.
  message: string;
};

export type ReadinessResult = {
  status: ReadinessState;
  // Present only when status !== 'ready'. Names the machine-readable cause.
  reason?: ReadinessReason;
};

// Map a StackConfig.services[] inventory to the set of core capabilities it
// covers, by matching each STACK_SERVICES entry's serviceId to a stored service.
function coveredCapabilities(config: StackConfig): Set<StackCapability> {
  const present = new Set(config.services.map((s) => s.serviceId));
  const covered = new Set<StackCapability>();
  for (const svc of STACK_SERVICES) {
    if (present.has(svc.serviceId)) covered.add(svc.role);
  }
  return covered;
}

// True when the stack's inventory already records the on-demand packager
// (e.g. after issue #335 persists a successfully-created packager into
// services[]). Uses PACKAGER_SERVICE_ID as the single source of truth for the
// packager's serviceId — never a hardcoded string.
function inventoryHasPackager(config: StackConfig): boolean {
  return config.services.some((s) => s.serviceId === PACKAGER_SERVICE_ID);
}

// The capabilities the on-demand packager is wired to depend on
// (buildPackagerCreateBody in packager-provisioning.ts): the shared Valkey
// QUEUE (RedisUrl) and the packaged-output STORAGE (OutputFolder/S3EndpointUrl).
// When both are present in the inventory the packager can be provisioned on
// demand, so the packaging capability is provably available even though the
// packager is not eagerly present.
const ON_DEMAND_PACKAGER_DEPENDENCIES: readonly StackCapability[] = [
  'queue',
  'storage'
];

// Compute the packaging-aware readiness of a stored stack config.
//
// Order of checks:
//   1. Lifecycle: a config still 'provisioning' or 'failed' is reported as such
//      (it never became a live stack; there is no point asking about packaging).
//      A missing status is treated as 'ready' for lifecycle purposes, matching
//      isReadyStack back-compat — but the capability checks below still apply.
//   2. Core capability: every STACK_SERVICES role must be present in services[].
//   3. Packaging capability: the packager is in services[] OR the on-demand
//      packager's dependencies (queue + storage) are all present.
//
// The first failing check wins and its machine-readable reason is returned.
export function computeStackReadiness(config: StackConfig): ReadinessResult {
  // 1. Lifecycle state from the stored config. Absent status is back-compat
  // 'ready' (see isReadyStack).
  if (config.status === 'provisioning') {
    return {
      status: 'provisioning',
      reason: {
        code: 'stack_provisioning',
        message: 'stack is still provisioning'
      }
    };
  }
  if (config.status === 'failed') {
    return {
      status: 'failed',
      reason: {
        code: 'stack_provisioning_failed',
        message: 'stack provisioning did not complete'
      }
    };
  }

  const covered = coveredCapabilities(config);

  // 2. Packaging capability — the specific gap issue #338 is about. The stack
  // can package when the packager is ALREADY recorded in the inventory (rule a,
  // e.g. after issue #335), OR when every on-demand packager dependency is
  // present so the packager can be provisioned lazily at package time (rule b).
  // A stack that satisfies neither structurally cannot complete packaging and
  // must NOT report ready. We surface the packaging gap with the specific
  // missing dependency named, so the reason is actionable — the packager
  // consumes the shared queue and writes to packaged storage, so a stack lacking
  // either cannot package even on demand.
  if (!inventoryHasPackager(config)) {
    const missingDep = ON_DEMAND_PACKAGER_DEPENDENCIES.find(
      (cap) => !covered.has(cap)
    );
    if (missingDep) {
      return {
        status: 'degraded',
        reason: {
          code: 'packaging_capability_missing',
          capability: 'packaging',
          message:
            `stack cannot package: the packager is not in the inventory and its ` +
            `on-demand dependency "${missingDep}" is absent, so no packager can ` +
            `be provisioned`
        }
      };
    }
  }

  // 3. Remaining core capabilities not covered by the packaging check above
  // (currently just the database, which packaging does not depend on but the
  // full ingest -> transcode -> package -> deliver flow does). Any missing role
  // downgrades the stack and names the specific capability.
  for (const svc of STACK_SERVICES) {
    if (!covered.has(svc.role)) {
      return {
        status: 'degraded',
        reason: {
          code: 'core_capability_missing',
          capability: svc.role,
          message: `stack inventory is missing the required ${svc.role} capability`
        }
      };
    }
  }

  return { status: 'ready' };
}
