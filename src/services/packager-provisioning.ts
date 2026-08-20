// On-demand provisioning of the Encore packager (epic #226, issue #244).
//
// The eyevinn-encore-packager is NO LONGER part of the eagerly provisioned
// stack (STACK_SERVICES / issue #243). Instead it is provisioned LAZILY the
// first time a pipeline that includes a `package` step is executed, wired to
// the stack's shared Valkey queue and packaged-output storage, and reused by
// every subsequent packaging execution. It is torn down on stack deprovision
// (issue #246).
//
// This module owns that ensure step as a small, exported, unit-testable
// function. Issue #245 wraps ensurePackagerProvisioned in a per-stack
// single-flight + ground-truth reconciliation guard so N concurrent first
// executions produce exactly one packager.
//
// CONTRACT SOURCE (CLAUDE.md rule 7):
//   The create-service-instance config body for eyevinn-encore-packager below
//   is the EXACT field set the (now-removed) eager provisioning path used in
//   src/routes/provision.ts, which was contract-verified when written. No field
//   name is invented here. The live OSC MCP get-service-schema was unreachable
//   in this context; that friction (and this reuse rationale) is logged in
//   docs/osc-feedback/incoming-epic226-ondemand-packager-schema.md. When the MCP
//   is reachable again, re-verify this body against get-service-schema.
//
//   Fields (eyevinn-encore-packager create body):
//     RedisUrl             — Valkey connection string (the shared stack queue)
//     RedisQueue           — 'encore-packager:jobs' (MUST match packagerQueueKey()
//                            in src/pipeline/osc-packager-queue.ts so this
//                            instance consumes only our pipeline's jobs, #93)
//     OutputFolder         — s3://<packagedBucket>/
//     PersonalAccessToken  — OSC PAT, injected as a {{secrets.*}} reference
//     AwsAccessKeyId       — 'admin' (MinIO root user)
//     AwsSecretAccessKey   — MinIO root password, injected as a {{secrets.*}} ref
//     S3EndpointUrl        — the stack's MinIO endpoint
//     CallbackUrl          — optional; <publicBaseUrl>/api/v1/internal. The
//                            packager POSTs .../packagerCallback/success|failure.
//
// The packager's completion callback is delivered over this HTTP CallbackUrl,
// NOT via a separately provisioned eyevinn-encore-callback-listener. The
// callback-listener instances in this system belong to the Encore (transcode)
// auto-scaler (ADR-006, src/encore-scaler/instance-pool.ts), not the packager,
// so the on-demand packager needs no paired listener and none is provisioned
// here (no double-provisioning).

import {
  Context,
  createInstance,
  getInstance,
  removeInstance,
  saveSecret,
  waitForInstanceReady
} from '@osaas/client-core';
import { PACKAGER_SERVICE_ID } from './stack.js';

// Secret purposes (ADR-002 naming: <stackName>.<purpose>), scoped to the
// PACKAGER_SERVICE_ID. Mirror the purposes the eager path used so a re-provision
// of the same stack name overwrites the same secrets rather than orphaning them.
export const PACKAGER_ROOTPASSWORD_PURPOSE = 'rootpassword';
export const PACKAGER_PAT_PURPOSE = 'pat';

// RedisQueue value — must match packagerQueueKey() in osc-packager-queue.ts.
export const PACKAGER_REDIS_QUEUE = 'encore-packager:jobs';

// The non-secret + secret-reference inputs needed to build the packager create
// body. Secrets themselves are passed as their raw values and turned into
// {{secrets.*}} references by ensurePackagerProvisioned via saveSecret; the
// pure body builder below takes the already-resolved references so it stays
// free of side effects and easy to unit test.
export type PackagerStackCoordinates = {
  // The stack (instance) name — the packager instance shares the stack name,
  // exactly like every STACK_SERVICES instance.
  stackName: string;
  // Valkey connection string for the shared stack queue.
  redisUrl: string;
  // The stack's MinIO S3 endpoint URL.
  minioEndpoint: string;
  // The packaged-output bucket name (no scheme/prefix).
  packagedBucket: string;
  // Public base URL for building the packager's HTTP callback URL. Optional:
  // when omitted (local dev without a tunnel) CallbackUrl is left unset.
  publicBaseUrl?: string;
};

// Build the exact create-service-instance body for the packager. Pure: the two
// secret arguments are already-resolved {{secrets.*}} references. Exported so a
// unit test can assert the field shape without any OSC calls (the concurrency
// test for #245 and body tests for #244 can target this directly).
export function buildPackagerCreateBody(
  coords: PackagerStackCoordinates,
  refs: { patRef: string; s3SecretRef: string }
): Record<string, unknown> {
  const callbackUrl = coords.publicBaseUrl
    ? `${coords.publicBaseUrl.replace(/\/+$/, '')}/api/v1/internal`
    : undefined;
  return {
    name: coords.stackName,
    RedisUrl: coords.redisUrl,
    RedisQueue: PACKAGER_REDIS_QUEUE,
    OutputFolder: `s3://${coords.packagedBucket.replace(/\/+$/, '')}/`,
    PersonalAccessToken: refs.patRef,
    AwsAccessKeyId: 'admin',
    AwsSecretAccessKey: refs.s3SecretRef,
    S3EndpointUrl: coords.minioEndpoint,
    ...(callbackUrl ? { CallbackUrl: callbackUrl } : {})
  };
}

// Outcome of an ensure call.
//   created — the packager did not exist and was provisioned this call
//   exists  — the packager was already running; reused (no re-provision)
export type EnsurePackagerStatus = 'created' | 'exists';

export type EnsurePackagerResult = {
  status: EnsurePackagerStatus;
  instanceName: string;
};

// The OSC client surface ensurePackagerProvisioned depends on. Declared as a
// narrow interface (defaulting to the real @osaas/client-core functions) so
// tests can inject fakes and assert the create/introspect flow without a live
// OSC. Signatures mirror @osaas/client-core lib/core.d.ts (verified 2026-07-13):
//   getInstance(ctx, serviceId, name, token)            -> Promise<any | undefined>
//   createInstance(ctx, serviceId, token, body)         -> Promise<any>
//   waitForInstanceReady(serviceId, name, ctx)          -> Promise<void>
//   saveSecret(serviceId, name, value, ctx)             -> Promise<void>
export interface PackagerOscApi {
  getServiceAccessToken(serviceId: string): Promise<string>;
  getInstance(
    serviceId: string,
    name: string,
    token: string
  ): Promise<{ name?: string } | undefined>;
  createInstance(
    serviceId: string,
    token: string,
    body: Record<string, unknown>
  ): Promise<{ name?: string }>;
  waitForInstanceReady(serviceId: string, name: string): Promise<void>;
  saveSecret(serviceId: string, name: string, value: string): Promise<void>;
  // removeInstance(ctx, serviceId, name, token) -> Promise<void>
  // (@osaas/client-core lib/core.d.ts:46). Used by teardownOnDemandPackager.
  removeInstance(
    serviceId: string,
    name: string,
    token: string
  ): Promise<void>;
}

// Adapt an @osaas/client-core Context into the narrow PackagerOscApi. Keeps the
// SDK's positional-arg calling convention isolated behind one place.
export function packagerOscApiFromContext(osc: Context): PackagerOscApi {
  return {
    getServiceAccessToken: (serviceId) => osc.getServiceAccessToken(serviceId),
    getInstance: (serviceId, name, token) =>
      getInstance(osc, serviceId, name, token),
    createInstance: (serviceId, token, body) =>
      createInstance(osc, serviceId, token, body),
    waitForInstanceReady: (serviceId, name) =>
      waitForInstanceReady(serviceId, name, osc),
    saveSecret: (serviceId, name, value) =>
      saveSecret(serviceId, name, value, osc),
    removeInstance: (serviceId, name, token) =>
      removeInstance(osc, serviceId, name, token)
  };
}

// The raw secret material the packager needs. Passed separately from the
// non-secret coordinates so a caller can source them from env/OSC without them
// ever landing in the persisted StackConfig.
export type PackagerSecrets = {
  // MinIO root password — reused as the packager's AWS S3 secret.
  minioRootPassword: string;
  // OSC personal access token — the packager needs it to fetch Encore job data.
  oscPersonalAccessToken: string;
};

export type EnsurePackagerDeps = {
  osc: PackagerOscApi;
  coords: PackagerStackCoordinates;
  secrets: PackagerSecrets;
  // Whether to wait for the freshly created instance to report ready before
  // returning. Defaults to true. The packager is a background queue-consumer
  // with no synchronous health endpoint; waitForInstanceReady gates on the
  // container health check. Callers that must enqueue only after readiness keep
  // this true. (Issue #244 acceptance: wait for readiness THEN enqueue.)
  waitForReady?: boolean;
};

// Ensure the packager instance for this stack exists, reconciling against OSC
// ground truth: it first introspects the live instance (getInstance) and only
// provisions when absent. This makes the call idempotent and self-healing — a
// retry, or a second concurrent caller that lost the single-flight race
// (issue #245), sees the running instance and returns 'exists' without creating
// a duplicate. Secrets are (re)saved before create so a re-provision of the same
// stack name references valid secrets.
//
// The packager instance shares the stack name (like every STACK_SERVICES
// instance), so getInstance(name = stackName) is the ground-truth existence
// check.
export async function ensurePackagerProvisioned(
  deps: EnsurePackagerDeps
): Promise<EnsurePackagerResult> {
  const { osc, coords, secrets } = deps;
  const waitForReady = deps.waitForReady ?? true;
  const name = coords.stackName;

  const sat = await osc.getServiceAccessToken(PACKAGER_SERVICE_ID);

  // Ground-truth reconciliation: is the packager already running for this stack?
  const existing = await osc.getInstance(PACKAGER_SERVICE_ID, name, sat);
  if (existing) {
    return { status: 'exists', instanceName: name };
  }

  // Save the packager's secrets (scoped to PACKAGER_SERVICE_ID) and build
  // {{secrets.*}} references. saveSecret is write-once/overwrite, so re-running
  // for the same stack name is safe.
  const patSecretName = `${name}.${PACKAGER_PAT_PURPOSE}`;
  const s3SecretName = `${name}.${PACKAGER_ROOTPASSWORD_PURPOSE}`;
  await osc.saveSecret(
    PACKAGER_SERVICE_ID,
    patSecretName,
    secrets.oscPersonalAccessToken
  );
  await osc.saveSecret(
    PACKAGER_SERVICE_ID,
    s3SecretName,
    secrets.minioRootPassword
  );
  const body = buildPackagerCreateBody(coords, {
    patRef: `{{secrets.${patSecretName}}}`,
    s3SecretRef: `{{secrets.${s3SecretName}}}`
  });

  try {
    await osc.createInstance(PACKAGER_SERVICE_ID, sat, body);
  } catch (err) {
    // A concurrent caller (or a retry) may have created it between our
    // getInstance check and this createInstance. Treat "already taken/exists"
    // as success and reconcile to the running instance rather than erroring —
    // this is the ground-truth safety net beneath the #245 single-flight lock.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already taken') && !msg.includes('already exists')) {
      throw err;
    }
    return { status: 'exists', instanceName: name };
  }

  if (waitForReady) {
    await osc.waitForInstanceReady(PACKAGER_SERVICE_ID, name);
  }
  return { status: 'created', instanceName: name };
}

// Per-stack single-flight guard for the ensure step (issue #245).
//
// Two layers make on-demand provisioning idempotent + concurrency-safe:
//
//   1. In-process single-flight (this class): N concurrent first-execution
//      requests for the SAME stack name collapse onto ONE in-flight
//      ensurePackagerProvisioned promise. The other N-1 callers await that same
//      promise instead of each racing to createInstance. This is what stops a
//      burst of concurrent requests within one process from creating duplicate
//      packagers.
//
//   2. Ground-truth reconciliation (inside ensurePackagerProvisioned): the run
//      first getInstance-checks OSC and treats a create "already taken" error as
//      success. An in-process lock alone does NOT survive a process restart mid-
//      provision — but because every run reconciles against the live OSC
//      instance list, a restart (which empties this map) self-heals: the next
//      run sees the running/half-created instance and returns 'exists' rather
//      than orphaning or duplicating it.
//
// The in-flight promise is cleared when it settles (success OR failure) so a
// failed ensure does not wedge the stack — the next request re-attempts. Keyed
// by stack name so different stacks never block each other.
//
// Exported and dependency-injected (the runner is passed in) so it is unit-
// testable without a live OSC: a test can fire many run() calls concurrently
// against a fake runner and assert the runner was invoked exactly once per
// stack. NOTE: issue #245's acceptance asks for a concurrency test; per the
// test-file write-hook policy this agent does NOT author test files — the guard
// is implemented as this injectable single-flight primitive and the test is
// DEFERRED to a human/reviewer (see the PR body).
export class PackagerEnsureSingleFlight {
  // stackName -> the currently in-flight ensure promise for that stack.
  private inFlight = new Map<string, Promise<EnsurePackagerResult>>();

  constructor(
    // The ensure runner to single-flight. Defaults to the real
    // ensurePackagerProvisioned; injectable so tests can supply a counting fake.
    private readonly runner: (
      deps: EnsurePackagerDeps
    ) => Promise<EnsurePackagerResult> = ensurePackagerProvisioned
  ) {}

  // Run the ensure step for deps.coords.stackName under the single-flight guard.
  // Concurrent calls for the same stack name share one runner invocation; the
  // resolved/rejected result is fanned out to every caller. Distinct stack names
  // run independently.
  async run(deps: EnsurePackagerDeps): Promise<EnsurePackagerResult> {
    const key = deps.coords.stackName;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = (async () => this.runner(deps))().finally(() => {
      // Clear only if this promise is still the registered one (a later run
      // that started after we settled must not be evicted).
      if (this.inFlight.get(key) === promise) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}

// Outcome of a teardown attempt (mirrors deprovision.ts TeardownStatus).
//   removed    — the packager existed and was removed this call
//   not_found  — no packager existed (never provisioned, or already gone) —
//                a success from an idempotency standpoint
//   failed     — the OSC call errored; the operation is safe to retry
export type PackagerTeardownStatus = 'removed' | 'not_found' | 'failed';

export type PackagerTeardownResult = {
  serviceId: string;
  status: PackagerTeardownStatus;
  error?: string;
};

// Tear down the on-demand packager for a stack (issue #246).
//
// The packager is NOT recorded in StackConfig.services[] (it is provisioned
// lazily, never persisted there), so the stored-config teardown in
// deprovision.ts never removes it. This function reconciles against OSC ground
// truth instead: the packager instance shares the stack name, so it probes
// getInstance(PACKAGER_SERVICE_ID, stackName) and removes it if present. This is
// safe whether or not packaging was ever executed — a stack that never packaged
// has no packager instance and this returns 'not_found' without error. It is
// idempotent (a retry after removal returns 'not_found') and mirrors the
// probe-then-remove pattern in services/deprovision.ts:teardownService.
//
// Only the getInstance/removeInstance surface of PackagerOscApi is used, so a
// caller can pass the same packagerOscApiFromContext(osc) adapter used for the
// ensure path.
export async function teardownOnDemandPackager(
  osc: Pick<
    PackagerOscApi,
    'getServiceAccessToken' | 'getInstance' | 'removeInstance'
  >,
  stackName: string
): Promise<PackagerTeardownResult> {
  const serviceId = PACKAGER_SERVICE_ID;
  try {
    const sat = await osc.getServiceAccessToken(serviceId);
    const existing = await osc.getInstance(serviceId, stackName, sat);
    if (!existing) {
      return { serviceId, status: 'not_found' };
    }
    await osc.removeInstance(serviceId, stackName, sat);
    return { serviceId, status: 'removed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { serviceId, status: 'failed', error: message };
  }
}
