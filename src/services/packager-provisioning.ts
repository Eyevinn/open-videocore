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
//   RE-VERIFICATION ATTEMPT (issue #1263 part 4): still unreachable. The OSC
//   MCP get-service-schema tool was not invokable in the authoring context, and
//   the direct catalog read (GET /service/<serviceId>) rejected the access
//   token present in the environment with 401 for every header form, so NOTHING
//   below was changed on a guess. What WAS
//   done instead is a static reconciliation, now pinned as a test:
//   test/packager-create-body-field-reconciliation.test.ts cross-checks this
//   field set against the only other in-repo code path that names this
//   service's fields (`packagerCredentialMapping`,
//   src/services/external-storage-credentials.ts:122, field names verified
//   under #212) and asserts the exact key set, so a future live-schema diff is
//   a one-assertion change. The blocker is logged as OSC friction in
//   docs/osc-feedback/incoming-1263-packager-schema-reverification.md (this
//   repo; mirrored into the agent team's own docs/osc-feedback/ for the weekly
//   consolidation, same slug), the follow-up to
//   docs/osc-feedback/incoming-epic226-ondemand-packager-schema.md.
//   Reconciliation result: no drift between the two paths, and no encryption
//   field on any of them — which is what the packaging capability probe
//   (`clearPackagingRunner`, src/pipeline/packaging.ts) reports.
//
//   Fields (eyevinn-encore-packager create body):
//     RedisUrl             — Valkey connection string (the shared stack queue)
//     RedisQueue           — 'encore-packager:jobs' (MUST match packagerQueueKey()
//                            in src/pipeline/osc-packager-queue.ts so this
//                            instance consumes only our pipeline's jobs, #93)
//     OutputFolder         — s3://<packagedBucket>/
//     PersonalAccessToken  — OSC PAT, injected as a {{secrets.*}} reference
//     AwsAccessKeyId       — the stack's object-store access key id (issue
//                            #1094: PackagerStackCoordinates
//                            .objectStoreAccessKeyId; the legacy root user for a
//                            stack provisioned before #1094)
//     AwsSecretAccessKey   — the matching object-store secret, injected as a
//                            {{secrets.*}} ref (never a literal)
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
  listInstances,
  removeInstance,
  restartInstance,
  saveSecret
} from '@osaas/client-core';
// The readiness wait goes through this bounded helper, NOT @osaas/client-core's
// waitForInstanceReady (issue #1055, follow-up to #1038). The SDK helper has no
// deadline and does not wrap its getInstanceHealth probe in a try
// (lib/core.js:343-353, v0.24.0), so ONE dropped poll failed a stack's first
// packaging job even though the packager came up moments later.
import {
  waitForInstanceReadyBounded,
  type InstanceReadinessOptions
} from './instance-readiness.js';
import { PACKAGER_SERVICE_ID, PACKAGER_TEARDOWN_ROLE } from './stack.js';
import {
  confirmInstanceAbsentVia,
  type ServiceTeardownResult
} from './deprovision.js';
import { LEGACY_OBJECT_STORE_ACCESS_KEY_ID } from './object-store-credentials.js';

// Secret purposes (ADR-002 naming: <stackName>.<purpose>), scoped to the
// PACKAGER_SERVICE_ID. Mirror the purposes the eager path used so a re-provision
// of the same stack name overwrites the same secrets rather than orphaning them.
export const PACKAGER_ROOTPASSWORD_PURPOSE = 'rootpassword';
export const PACKAGER_PAT_PURPOSE = 'pat';

// RedisQueue value — must match packagerQueueKey() in osc-packager-queue.ts.
export const PACKAGER_REDIS_QUEUE = 'encore-packager:jobs';

// The queue key a newly provisioned packager for `stackName` consumes. Scoped
// per stack because every packager listens on the same shared Valkey: with one
// common key, a second stack's packager would pop the first stack's jobs (and
// vice versa) and read renditions from the wrong object store. The key is
// recorded on the stack config (StackConfig.packagerQueue) so producers enqueue
// onto exactly the key the packager was created with.
export function packagerQueueForStack(stackName: string): string {
  return `${PACKAGER_REDIS_QUEUE}:${stackName}`;
}

// The stack packaging work targets, out of the provisioned `names`: the ambient
// stack — a request's X-Stack-Name, or a background worker re-entering a job's
// persisted stackName (#1097) — when it names a provisioned stack, else the
// first provisioned stack, which is the single-stack default.
export function packagingStackName(
  names: readonly string[],
  ambientStackName: string | undefined
): string | undefined {
  return ambientStackName && names.includes(ambientStackName)
    ? ambientStackName
    : names[0];
}

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
  // The queue key the packager consumes. Optional: unset keeps the shared
  // PACKAGER_REDIS_QUEUE, the pre-per-stack behaviour.
  redisQueue?: string;
  // The stack's MinIO S3 endpoint URL.
  minioEndpoint: string;
  // The packaged-output bucket name (no scheme/prefix).
  packagedBucket: string;
  // The stack's object-store access key id (issue #1094). NON-SECRET. The
  // packager WRITES packaged output to the stack's object store, so it must
  // authenticate with that stack's own credential rather than the former
  // deployment-wide root user. Optional for back-compat: omitted (or absent
  // from the stack's stored config, i.e. a stack provisioned before #1094)
  // means the legacy root user, so the create body is unchanged for a
  // not-yet-migrated stack (#1096).
  objectStoreAccessKeyId?: string;
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
    RedisQueue: coords.redisQueue ?? PACKAGER_REDIS_QUEUE,
    OutputFolder: `s3://${coords.packagedBucket.replace(/\/+$/, '')}/`,
    PersonalAccessToken: refs.patRef,
    AwsAccessKeyId:
      coords.objectStoreAccessKeyId ?? LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
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
//   saveSecret(serviceId, name, value, ctx)             -> Promise<void>
//   listInstances(ctx, serviceId, token)                -> Promise<any>
// waitForInstanceReady below is NOT the SDK function of the same name: the
// adapter below fulfils it with waitForInstanceReadyBounded (#1055).
export interface PackagerOscApi {
  getServiceAccessToken(serviceId: string): Promise<string>;
  getInstance(
    serviceId: string,
    name: string,
    token: string
  ): Promise<{ name?: string } | undefined>;
  // listInstances(ctx, serviceId, token) -> Promise<any>
  // (@osaas/client-core lib/core.d.ts:65). UNLIKE getInstance it has no catch
  // (lib/core.js:160-170), so it rejects instead of reporting an error as an
  // empty result — which is what makes it usable as the confirming read in
  // teardownOnDemandPackager. Resolves the raw instances payload; callers go
  // through confirmInstanceAbsentVia rather than interpreting it here.
  listInstances(serviceId: string, token: string): Promise<unknown>;
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
  // restartInstance(ctx, serviceId, name, token) -> Promise<void>
  // (@osaas/client-core lib/core.d.ts:95, v0.24.0; POSTs the instance's
  // `restart` _link, lib/core.js:230-238). Rolls a RUNNING packager so it
  // re-reads its {{secrets.*}} values — the only way to get a refreshed
  // `<stack>.pat` into an already-created instance (issue #1335), because OSC
  // resolves secret references into the container environment at start.
  //
  // OPTIONAL on this interface on purpose: every pre-#1335 caller and test fake
  // satisfies PackagerOscApi without it, and an adapter that cannot roll simply
  // skips the roll (the refreshed secret then lands at the packager's next
  // restart) instead of failing the ensure step.
  restartInstance?(
    serviceId: string,
    name: string,
    token: string
  ): Promise<void>;
}

// Adapt an @osaas/client-core Context into the narrow PackagerOscApi. Keeps the
// SDK's positional-arg calling convention isolated behind one place.
//
// `readiness` bounds the readiness wait (issue #1055). Unset uses the shared
// defaults in src/services/instance-readiness.ts — the same 5-minute deadline
// and 1s cadence the provisioning route uses. Tests collapse the cadence.
export function packagerOscApiFromContext(
  osc: Context,
  readiness: InstanceReadinessOptions = {}
): PackagerOscApi {
  return {
    getServiceAccessToken: (serviceId) => osc.getServiceAccessToken(serviceId),
    getInstance: (serviceId, name, token) =>
      getInstance(osc, serviceId, name, token),
    listInstances: (serviceId, token) => listInstances(osc, serviceId, token),
    createInstance: (serviceId, token, body) =>
      createInstance(osc, serviceId, token, body),
    // Bounded (#1055): a transient probe failure is retried until the deadline,
    // and a timeout throws an error naming the service plus the last probe
    // error. ensurePackagerProvisioned logs and rethrows that, so the package
    // step fails loudly instead of hanging.
    waitForInstanceReady: (serviceId, name) =>
      waitForInstanceReadyBounded(osc, serviceId, name, {
        ...readiness,
        label: 'packager'
      }),
    saveSecret: (serviceId, name, value) =>
      saveSecret(serviceId, name, value, osc),
    removeInstance: (serviceId, name, token) =>
      removeInstance(osc, serviceId, name, token),
    restartInstance: (serviceId, name, token) =>
      restartInstance(osc, serviceId, name, token)
  };
}

// The raw secret material the packager needs. Passed separately from the
// non-secret coordinates so a caller can source them from env/OSC without them
// ever landing in the persisted StackConfig.
export type PackagerSecrets = {
  // LEGACY deployment-wide object-store password — reused as the packager's S3
  // secret for a stack provisioned before #1094 (one whose stored config
  // carries no objectStoreAccessKeyId). Superseded by
  // `objectStoreSecretAccessKey` below when that is supplied.
  minioRootPassword: string;
  // The resolved PER-STACK object-store secret access key (issue #1094),
  // matching `PackagerStackCoordinates.objectStoreAccessKeyId`. When present it
  // is what gets saved as the packager's OSC secret and referenced from its
  // create body, so the packager writes to the stack's object store with that
  // stack's own credential. Optional for back-compat: absent falls back to
  // `minioRootPassword`, leaving the pre-#1094 behaviour unchanged.
  objectStoreSecretAccessKey?: string;
  // OSC personal access token — the packager needs it to fetch Encore job data.
  oscPersonalAccessToken: string;
};

// Narrow structured logger the ensure step emits per-phase observability onto
// (issue #335): attempt, ready, failure. Optional so unit tests and callers
// without a logger keep working; when absent the phases still execute, they are
// just not logged. Mirrors the { obj }, msg shape of the app (pino) logger used
// throughout main.ts (e.g. app.log.info({ stackName }, '…')).
export interface PackagerProvisionLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// Per-process record of which stacks' packagers have already been rolled to
// pick up a refreshed `<stack>.pat` (issue #1335).
//
// WHY A LEDGER AT ALL: the ensure step runs on EVERY packaging execution, and
// OSC secrets are write-only (@osaas/client-core exports `saveSecret` only —
// lib/index.d.ts:6 — there is no getSecret), so the ensure step cannot read the
// value the running packager was started with and compare it with the current
// token. Without that comparison the only way to guarantee a rotated token
// reaches an existing packager would be to restart it on every execution, which
// would interrupt whatever that packager is packaging. This ledger bounds it
// instead: the packager for a given stack is rolled AT MOST ONCE per API
// process.
//
// Once per process is exactly the rotation trigger: this API reads its own OSC
// token from the environment (Context#getPersonalAccessToken), so a rotated
// token only reaches this process by restarting it — which empties this ledger
// and makes the next packaging execution roll the stale packager. A process that
// keeps running with an unchanged token rolls its packager once, on the first
// packaging execution, and never again.
export class PackagerPatRollLedger {
  private rolled = new Set<string>();

  // Claim the single roll for `stackName`. Returns true for the first caller in
  // this process (which should then perform the roll) and false afterwards.
  claim(stackName: string): boolean {
    if (this.rolled.has(stackName)) return false;
    this.rolled.add(stackName);
    return true;
  }

  // Give the claim back, so a LATER ensure call retries the roll. Used when the
  // roll could not be completed (restart call failed, or the secret refresh that
  // must precede it failed) — a failed roll must not consume the one chance this
  // process had to get the current token into the packager.
  release(stackName: string): void {
    this.rolled.delete(stackName);
  }

  // Whether `stackName` has been rolled in this process. Read-only; exported for
  // observability/tests.
  hasRolled(stackName: string): boolean {
    return this.rolled.has(stackName);
  }
}

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
  // Optional per-phase logger (issue #335). When provided, ensurePackagerProvisioned
  // logs an attempt line before createInstance, a ready line after readiness, and
  // an error line (before rethrowing) on any createInstance/readiness failure —
  // each tagged with the stack name so a silent no-provision can no longer hide.
  log?: PackagerProvisionLogger;
  // Optional inventory-recording hook (issue #335). Invoked exactly once, AFTER a
  // fresh packager instance is created and (if waitForReady) reported ready, so
  // the stack's service inventory reflects reality (acceptance: "the packager
  // appears in the stack's service inventory"). NOT invoked on the 'exists' path
  // (the instance was recorded by whoever created it) so a reused instance does
  // not re-write the inventory. A failure to record is logged and rethrown so the
  // package step fails loudly rather than leaving an unrecorded packager.
  recordInInventory?: (instanceName: string) => Promise<void>;
  // Per-process roll ledger for the stale-token fix (issue #1335). When present
  // (and the osc adapter can restart), an ensure call that finds an EXISTING
  // packager rolls it once per process so it re-reads the just-refreshed
  // `<stack>.pat`. When absent the secret is still refreshed, but the running
  // packager is left alone and only picks the new value up at its next restart.
  patRollLedger?: PackagerPatRollLedger;
};

// Bring an ALREADY RUNNING packager's `<stack>.pat` up to the current OSC token
// (issue #1335).
//
// Two steps, in this order:
//   1. saveSecret — rewrite `<stack>.pat` with the token this process is holding
//      now. saveSecret is an overwrite (POST /mysecrets/<serviceId>, the same
//      call the create path makes), so this is safe to repeat and needs no
//      delete-then-create. After it, the packager's existing
//      `{{secrets.<stack>.pat}}` reference resolves to the current token.
//   2. restartInstance — roll the instance so it RE-READS that reference. OSC
//      resolves secret references into the container environment when the
//      instance starts, so step 1 alone does not reach a running packager. The
//      roll is claimed through the per-process ledger (see
//      PackagerPatRollLedger) so repeat packaging executions do not keep
//      restarting a healthy packager mid-job.
//
// The OSC-side limitations this works around — a rewritten secret never reaching
// a running instance, no way to detect that an instance is holding a stale
// secret (secrets are write-only), and restart not being supported by every
// service — are logged as friction in the agent team's
// docs/osc-feedback/incoming-1335-secret-rotation-does-not-reach-running-instances.md.
//
// Both steps are NON-FATAL by design. The ensure step cannot tell a rotated
// token from an unchanged one (OSC secrets are write-only), so this runs on
// every exists path — and turning a transient OSC refresh/restart fault into a
// hard packaging failure would break executions whose token was never rotated
// and would have worked. A failure is therefore logged loudly, the ledger claim
// is released so a later execution retries, and the ensure call still reports
// 'exists'. What the caller loses is the refresh, not the packaging run.
async function refreshExistingPackagerPat(args: {
  osc: PackagerOscApi;
  sat: string;
  name: string;
  secrets: PackagerSecrets;
  waitForReady: boolean;
  ledger?: PackagerPatRollLedger;
  log?: PackagerProvisionLogger;
  logCtx: Record<string, unknown>;
}): Promise<void> {
  const { osc, sat, name, secrets, waitForReady, ledger, log, logCtx } = args;
  const patSecretName = `${name}.${PACKAGER_PAT_PURPOSE}`;

  try {
    await osc.saveSecret(
      PACKAGER_SERVICE_ID,
      patSecretName,
      secrets.oscPersonalAccessToken
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // No roll after a failed refresh: restarting would only make the packager
    // re-read the OLD value, costing a restart for nothing.
    log?.error(
      { ...logCtx, phase: 'refresh-pat', error },
      'on-demand packager: failed to refresh access-token secret for existing instance'
    );
    return;
  }

  // Nothing more to do when this caller cannot roll (no ledger wired, or an osc
  // adapter without restartInstance): the refreshed secret is in place and the
  // packager will read it at its next restart.
  if (!ledger || !osc.restartInstance) return;
  if (!ledger.claim(name)) return;

  try {
    log?.info(
      { ...logCtx, phase: 'refresh-pat' },
      'on-demand packager: restarting existing instance to pick up refreshed access token'
    );
    await osc.restartInstance(PACKAGER_SERVICE_ID, name, sat);
    if (waitForReady) {
      await osc.waitForInstanceReady(PACKAGER_SERVICE_ID, name);
    }
    log?.info(
      { ...logCtx, phase: 'refresh-pat' },
      'on-demand packager: existing instance restarted with refreshed access token'
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ledger.release(name);
    log?.error(
      { ...logCtx, phase: 'refresh-pat-roll', error },
      'on-demand packager: failed to restart existing instance after refreshing its access token'
    );
  }
}

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
//
// The 'exists' path is NOT a pure no-op any more (issue #1335): it refreshes the
// packager's `<stack>.pat` secret to the token this process holds now and rolls
// the instance once per process, so a rotated token reaches a packager that was
// created with the old one. See refreshExistingPackagerPat above.
export async function ensurePackagerProvisioned(
  deps: EnsurePackagerDeps
): Promise<EnsurePackagerResult> {
  const { osc, coords, secrets } = deps;
  const waitForReady = deps.waitForReady ?? true;
  const log = deps.log;
  const name = coords.stackName;
  // Common structured context for every log line: the tenant/stack name and the
  // packager serviceId, so a provisioning failure is attributable (issue #335).
  const logCtx = { stackName: name, serviceId: PACKAGER_SERVICE_ID };

  const sat = await osc.getServiceAccessToken(PACKAGER_SERVICE_ID);

  // Ground-truth reconciliation: is the packager already running for this stack?
  const existing = await osc.getInstance(PACKAGER_SERVICE_ID, name, sat);
  if (existing) {
    // Issue #1335: an existing packager used to be returned untouched, so its
    // `<stack>.pat` secret kept whatever value it was given at CREATE time. When
    // this API's own OSC token was rotated (e.g. after a revocation) the running
    // packager went on presenting the revoked one, every packaging job it picked
    // up failed inside the packager, and the step only failed here 15 minutes
    // later on the completion timeout. Refresh the secret to the current token,
    // then roll the instance so it actually re-reads it.
    await refreshExistingPackagerPat({
      osc,
      sat,
      name,
      secrets,
      waitForReady,
      ...(deps.patRollLedger ? { ledger: deps.patRollLedger } : {}),
      ...(log ? { log } : {}),
      logCtx
    });
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
  // The stack's own object-store secret when one was resolved (#1094),
  // otherwise the legacy deployment-wide password. Only ever handed to
  // saveSecret; the create body gets the {{secrets.*}} reference.
  await osc.saveSecret(
    PACKAGER_SERVICE_ID,
    s3SecretName,
    secrets.objectStoreSecretAccessKey ?? secrets.minioRootPassword
  );
  const body = buildPackagerCreateBody(coords, {
    patRef: `{{secrets.${patSecretName}}}`,
    s3SecretRef: `{{secrets.${s3SecretName}}}`
  });

  // Phase: attempt. Logged BEFORE createInstance so an OSC create that hangs or
  // throws leaves a trail identifying the tenant + stack (issue #335).
  log?.info(logCtx, 'on-demand packager: creating instance');

  try {
    await osc.createInstance(PACKAGER_SERVICE_ID, sat, body);
  } catch (err) {
    // A concurrent caller (or a retry) may have created it between our
    // getInstance check and this createInstance. Treat "already taken/exists"
    // as success and reconcile to the running instance rather than erroring —
    // this is the ground-truth safety net beneath the #245 single-flight lock.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already taken') && !msg.includes('already exists')) {
      // Phase: failure. Log with tenant + stack, then rethrow so the caller's
      // package step transitions to `failed` instead of swallowing this and
      // leaving no packager and no error (the issue #335 root symptom).
      log?.error(
        { ...logCtx, phase: 'create', error: msg },
        'on-demand packager: createInstance failed'
      );
      throw err;
    }
    return { status: 'exists', instanceName: name };
  }

  if (waitForReady) {
    try {
      await osc.waitForInstanceReady(PACKAGER_SERVICE_ID, name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Phase: failure (readiness timeout / error). Same surface-and-fail-loud
      // contract as a create failure.
      log?.error(
        { ...logCtx, phase: 'ready', error: msg },
        'on-demand packager: readiness wait failed'
      );
      throw err;
    }
  }

  // Phase: ready. The packager is created and (if awaited) live.
  log?.info(logCtx, 'on-demand packager: ready');

  // Record the freshly created packager in the stack's service inventory so the
  // inventory reflects reality (issue #335 acceptance). A recording failure is
  // logged and rethrown so we never report success while leaving the packager
  // absent from the inventory — the exact invisibility this fix removes.
  if (deps.recordInInventory) {
    try {
      await deps.recordInInventory(name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.error(
        { ...logCtx, phase: 'record-inventory', error: msg },
        'on-demand packager: failed to record instance in stack inventory'
      );
      throw err;
    }
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
// Only the getInstance/listInstances/removeInstance surface of PackagerOscApi is
// used, so a caller can pass the same packagerOscApiFromContext(osc) adapter
// used for the ensure path.
//
// An EMPTY probe is not believed on its own (issue #1056, the same defect
// #1039 fixed in deprovision.ts): osc.getInstance bottoms out in the SDK's
// getInstance (see packagerOscApiFromContext above), which resolves `undefined`
// for every error except a 401 — so a network fault, a 5xx or a DNS failure all
// look exactly like "no packager was ever provisioned". Absence is therefore
// re-checked through the SHARED confirmInstanceAbsentVia (deprovision.ts); when
// it cannot establish absence it throws and the catch below reports `failed`,
// which is retryable, instead of a silent success that leaves the packager
// running and billing.
export async function teardownOnDemandPackager(
  osc: Pick<
    PackagerOscApi,
    | 'getServiceAccessToken'
    | 'getInstance'
    | 'listInstances'
    | 'removeInstance'
  >,
  stackName: string
): Promise<PackagerTeardownResult> {
  const serviceId = PACKAGER_SERVICE_ID;
  try {
    const sat = await osc.getServiceAccessToken(serviceId);
    const existing = await osc.getInstance(serviceId, stackName, sat);
    if (
      !existing &&
      (await confirmInstanceAbsentVia(
        (sid, token) => osc.listInstances(sid, token),
        serviceId,
        stackName,
        sat
      ))
    ) {
      return { serviceId, status: 'not_found' };
    }
    // Either the probe returned the packager, or it came back empty but the
    // instance list still shows it (the empty probe was a swallowed error).
    // Both mean there is something to remove.
    await osc.removeInstance(serviceId, stackName, sat);
    return { serviceId, status: 'removed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { serviceId, status: 'failed', error: message };
  }
}

// Express a packager teardown outcome as per-service teardown results that can
// be folded into the stack-level DELETE result (issue #1056,
// deprovision.ts:foldTeardownResults).
//
// Returns an EMPTY list for two cases, so folding is a no-op for them:
//   - `undefined` — teardownOnDemandPackager was not called at all (the
//     packager was recorded in the stored services[], so the stored-config
//     teardown already covers it and already reports it).
//   - `not_found`  — absence was CONFIRMED, so there is no packager and never
//     was one for this stack. Contributing nothing mirrors how an optional
//     service that was never activated yields no entry
//     (deprovision.ts:optionalStoredServices) and keeps a never-packaged stack
//     reporting `removed` rather than degrading to `partial`.
//
// `removed` and `failed` DO produce an entry: the first so a packager that was
// actually torn down stops being invisible, the second so it lands in the
// result as a leftover and keeps the stack status retryable.
export function packagerTeardownAsServiceResults(
  packager: PackagerTeardownResult | undefined
): ServiceTeardownResult[] {
  if (!packager || packager.status === 'not_found') return [];
  return [
    {
      serviceId: packager.serviceId,
      role: PACKAGER_TEARDOWN_ROLE,
      status: packager.status,
      ...(packager.error ? { error: packager.error } : {})
    }
  ];
}
