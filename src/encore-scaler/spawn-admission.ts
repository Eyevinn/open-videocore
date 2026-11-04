// Scale-up admission control (#1322): how many Encore spawns this deployment is
// allowed to have in flight at once, and why a spawn that is not admitted was
// held.
//
// WHY THIS EXISTS. Each spawn creates TWO OSC instances (the transcoder and its
// paired callback listener, instance-pool.ts spawnPooledInstance), so it creates
// two ingresses, each of which goes through the cluster's ingress admission
// webhook — observed at 15-19s apiece when the platform is busy. The scale-up
// gate (scaler-loop.ts tick step 3) is PER WORKSPACE: one EncoreScalerLoop per
// stack, each on its own interval (workspace-registry.ts getOrCreate), each
// deciding to spawn without any knowledge of the others. Two workspaces with
// queued work therefore start their creates in the same few hundred
// milliseconds, which is exactly the overlapping burst that #1223/#1286 traced
// to OOMKilled controllers — and the existing hold-off could not damp it,
// because it is also keyed per workspace and only lengthens AFTER a failure.
//
// So the limit here is PROCESS-WIDE and counted BEFORE the create: at most N
// spawns in flight across every workspace this API instance serves. It is
// deliberately in-process memory rather than a Valkey lease:
//   - the thing being limited is this process' own outbound create concurrency,
//     and it must be correct for a spawn that is in flight RIGHT NOW, which is a
//     fact only this process holds (a lease would have to be renewed and
//     reclaimed, and a stale one would park scale-up for the whole deployment);
//   - a slot is released in a `finally`, so a crash forgets the counter along
//     with the loops it was limiting — the state cannot outlive its owner;
//   - the hold-off (spawn-failure.ts) stays in Valkey precisely because it MUST
//     survive a restart and be shared between replicas. The two gates answer
//     different questions and are stored accordingly.
//
// Nothing here is on the HTTP surface: no response field and no change to the
// scaler's config shape (#1322 acceptance criterion 4). The reason a spawn was
// held goes to the scaler log instead (holdReasonMessage below), so support can
// read it from a pod tail without a log-aggregation query.

import type { EncoreInstanceRecord } from './types.js';

// Default ceiling on concurrent spawns per API instance.
//
// ONE, deliberately. The slot covers only a spawn's CREATE phase — it is
// released as soon as both halves of the spawn exist and before the readiness
// wait is awaited (instance-pool.ts SpawnHooks.onCreatesSettled), because the
// readiness wait is a health poll against an existing instance and puts no
// create pressure on the admission webhook. So what a second workspace waits
// for is the first workspace's creates, not its node provisioning: typically
// the two creates back to back (seconds), and in the worst case a spawn whose
// creates are all timing out — up to maxAttempts gateway timeouts per half plus
// the adopt probe (DEFAULT_SPAWN_ADOPT_PROBE_TIMEOUT_MS, 90s), a few minutes —
// rather than the 15-minute DEFAULT_SPAWN_READY_TIMEOUT_MS. The pool only ever
// grows by one instance per tick per workspace anyway, and a workspace that
// misses a slot keeps the rest of its tick. Set against that: the failure this
// bounds took out the platform's controllers for every tenant, and the create
// that is 504'd is usually still running behind the gateway, so a second
// concurrent create is often a second instance nobody asked for. Operators who
// have verified their cluster can take more can raise it
// (ENCORE_MAX_CONCURRENT_SPAWNS); documented in the README env table.
export const DEFAULT_MAX_CONCURRENT_SPAWNS = 1;

// Resolve the operator override for the cap.
//
// Same convention as every other scaler bound in main.ts (e.g.
// ENCORE_SPAWN_ADOPT_PROBE_TIMEOUT_MS): parseInt, and an absent, unparseable or
// out-of-range value falls back to the built-in default rather than disabling
// the gate. 0 and negatives are NOT honoured — "no spawns at all" is not a
// configuration anyone wants from a typo, and there is no useful meaning for an
// unlimited cap here (that is the behaviour this issue exists to remove).
// `onInvalid` is called with a human reason so the boot log can say the value
// was ignored, exactly as resolveUploadPartSizeBytes does.
export function resolveMaxConcurrentSpawns(
  raw: string | undefined,
  onInvalid?: (reason: string) => void
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CONCURRENT_SPAWNS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    onInvalid?.(`"${raw}" is not an integer`);
    return DEFAULT_MAX_CONCURRENT_SPAWNS;
  }
  if (parsed < 1) {
    onInvalid?.(`${parsed} is below the minimum of 1`);
    return DEFAULT_MAX_CONCURRENT_SPAWNS;
  }
  return parsed;
}

// A held slot. `release()` is idempotent so a caller may release in a `finally`
// and again on an error path without double-crediting the counter.
export type SpawnSlot = {
  readonly workspaceId: string;
  release: () => void;
};

// Process-wide spawn concurrency counter, shared by every per-workspace loop in
// this API instance (wired once in workspace-registry.ts and handed to each
// EncoreScalerConfig).
//
// Not a queue: a loop that cannot get a slot does NOT wait. It logs why and
// moves on with the rest of its tick (scale-down, the orphan sweep, dispatch all
// still run), and tries again on its next tick. Waiting inside the tick would
// hold the tick open for minutes behind another workspace's node provisioning,
// which is the opposite of what the pool needs.
export class SpawnConcurrencyLimiter {
  readonly limit: number;
  // workspaceId -> how many slots that workspace currently holds. A count, not a
  // set: nothing stops one workspace from being granted two slots when the cap
  // allows it, and the holders are only ever used for the log line.
  private readonly held = new Map<string, number>();

  constructor(limit: number = DEFAULT_MAX_CONCURRENT_SPAWNS) {
    // A caller that passes nonsense gets the default rather than a cap of 0,
    // which would stop the deployment scaling up at all.
    this.limit = Number.isFinite(limit) && limit >= 1 ? Math.trunc(limit) : DEFAULT_MAX_CONCURRENT_SPAWNS;
  }

  get inFlight(): number {
    let total = 0;
    for (const count of this.held.values()) total += count;
    return total;
  }

  // Which workspaces currently hold a slot, for the log line that explains the
  // hold ("waiting on ws-a"). Sorted so the message is stable between ticks and
  // in tests.
  holders(): string[] {
    return [...this.held.keys()].sort();
  }

  // Take a slot for `workspaceId`, or return undefined when the deployment is
  // already at its cap. Synchronous and single-threaded by construction: Node
  // runs this to completion, so the check and the increment cannot interleave
  // with another loop's tick.
  tryAcquire(workspaceId: string): SpawnSlot | undefined {
    if (this.inFlight >= this.limit) return undefined;
    this.held.set(workspaceId, (this.held.get(workspaceId) ?? 0) + 1);
    let released = false;
    return {
      workspaceId,
      release: () => {
        if (released) return;
        released = true;
        const remaining = (this.held.get(workspaceId) ?? 1) - 1;
        if (remaining > 0) this.held.set(workspaceId, remaining);
        else this.held.delete(workspaceId);
      }
    };
  }
}

// #1322 expected behaviour 3: is this instance a spawn that has not landed yet?
//
// Two states count, both of them "a spawn for this workspace has not landed yet":
//
//   - `pendingReadySince` set — the spawn gave up waiting for OSC to report the
//     instance `running` and left it alive for resolvePendingSpawns to adopt
//     (instance-pool.ts). OSC is, as far as anyone knows, still provisioning a
//     node for it.
//   - no `callbackListenerUrl` — the instance exists but its paired callback
//     listener does not, so resolvePendingSpawns is still creating (or adopting)
//     one. Until it does, the instance cannot be dispatched to usefully: it would
//     complete jobs into nowhere (instance-pool.ts:1203-1210).
//
// Reconcile-adopted records are not affected: reconcilePoolFromOsc writes them
// with no pendingReadySince, and it sets callbackListenerUrl once the listener is
// known (instance-pool.ts:313 notes it is unknown until the next reconcile pass),
// which is why only a MISSING listener on a record that also has no readyAt
// counts as "still being finished".
export function isAdoptionPending(inst: EncoreInstanceRecord): boolean {
  return (
    inst.pendingReadySince !== undefined ||
    (inst.callbackListenerUrl === undefined && inst.readyAt === undefined)
  );
}

// The instance whose unfinished spawn should hold THIS workspace's next create,
// or undefined when nothing should.
//
// SCOPE, and why it is narrower than "any pending instance at all". #1071 already
// settled that a pending instance must not freeze a workspace's growth: it is
// extra capacity on its way, it counts against maxInstances, and a pool whose
// usable instances are all busy with a deep queue still has to be allowed to
// grow beside it (test/encore-scaler-spawn-504-node-provisioning.test.ts
// "holds one slot, not the whole pool: scale-up still fires with headroom").
// Holding on any pending instance would reverse that decision and starve a busy
// workspace for the whole readiness budget — up to 15 minutes.
//
// So the hold applies only when the workspace has NOTHING ELSE: every instance
// in its pool is a spawn that has not landed. That is the #1223 failure exactly —
// no usable capacity, nothing to dispatch to, and the loop asking the platform
// for yet another instance while it is still failing to finish the first one, so
// the second create's load is what times out the first one's adopt probe. When
// the workspace does have working instances, another create buys real
// throughput and the deployment-wide cap above is what bounds the load.
//
// The hold is also short by construction: resolvePendingSpawns (tick step 1b)
// runs BEFORE this gate on every tick and either promotes the instance or
// destroys it on its own deadline.
export function adoptionPendingInstance(
  instances: readonly EncoreInstanceRecord[]
): EncoreInstanceRecord | undefined {
  if (instances.length === 0) return undefined;
  if (!instances.every(isAdoptionPending)) return undefined;
  return instances[0];
}

// Why a spawn was not started on this tick. One of these, in the order the gate
// checks them.
export type SpawnHoldReason =
  | { kind: 'concurrency-cap'; limit: number; inFlight: number; holders: string[] }
  | { kind: 'failure-backoff'; remainingMs: number; consecutiveFailures: number; httpCode?: number }
  | { kind: 'adoption-pending'; instanceId: string };

// The operator-facing sentence for a hold (#1322 expected behaviour 4).
//
// Deliberately self-contained: it names the gate, the numbers behind it and what
// has to change for the spawn to go ahead, so "why is this pool not growing?" is
// answerable from a single line in a pod tail — no log-aggregation query and no
// cross-referencing GET /scaler/status.
export function holdReasonMessage(reason: SpawnHoldReason): string {
  switch (reason.kind) {
    case 'concurrency-cap':
      return (
        `spawn cap reached: ${reason.inFlight} of ${reason.limit} spawn slot(s) in use ` +
        `across all workspaces (holding: ${reason.holders.join(', ') || 'none'}) — ` +
        'each spawn creates two ingresses through the cluster admission webhook, so ' +
        'this deployment starts them one batch at a time; retrying on a later tick ' +
        '(raise ENCORE_MAX_CONCURRENT_SPAWNS to allow more)'
      );
    case 'failure-backoff':
      return (
        `spawn hold-off active: ${reason.remainingMs}ms left after ` +
        `${reason.consecutiveFailures} consecutive failed spawn(s) ` +
        `(last status: ${reason.httpCode ?? 'none — transport failure'}); the hold-off ` +
        'doubles per consecutive failure up to its cap and resets on the first success'
      );
    case 'adoption-pending':
      return (
        `adoption pending: instance ${reason.instanceId} from an earlier spawn is still ` +
        'being adopted or is still waiting for its callback listener, so no sibling is ' +
        'started for it'
      );
  }
}
