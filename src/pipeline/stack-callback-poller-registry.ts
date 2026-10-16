// Which Encore callback pollers are running, and for which stacks (#1213).
//
// main.ts runs one encore-callback poller per DISTINCT stack Valkey connection
// (syncStackCallbackPollers, #1074): a stack's completions are written to that
// stack's own Valkey by the callback listener paired with each of its Encore
// instances (#615), so a single poller on the activation Valkey would never
// drain them.
//
// Until this module existed, that bookkeeping was a bare
// `Map<connectionId, stop>` keyed ONLY by the connection, reconciled from the
// enumeration of provisioned stacks. That is sufficient to start pollers, but
// not to STOP one at the right moment: a stack teardown removes the stack's
// Valkey instance first and only reaches the reconcile (which drops the
// connection from the enumeration, and with it the poller) at the very end —
// and never at all when the teardown reports failures. In between, and
// afterwards, the poller's dedicated blocking connection retried the removed
// Valkey about once a second with ECONNREFUSED, which is the symptom #1213 was
// reported from.
//
// Tracking the stacks each connection serves alongside its stop function makes
// the teardown-time stop exact: `stopForStack(name)` releases a poller as soon
// as the LAST stack it was started for is going away, and leaves a poller whose
// connection is still serving another live stack alone. A poller is never
// stopped while a stack still needs it, and never left running for a stack that
// is gone.
//
// This holds no OSC or Valkey contract of its own: the caller supplies both the
// connection identity (src/encore-scaler/valkey-connection-id.ts
// valkeyConnectionId — a non-secret label, never the URL) and the start/stop
// pair (src/pipeline/encore-callback-poller.ts startEncoreCallbackPoller, which
// returns its own idempotent stop function).

// The stop function startEncoreCallbackPoller returns. Idempotent there, and
// this registry additionally calls it at most once per started poller.
export type StopPoller = () => void;

// One provisioned stack and the Valkey connection its poller drains. A subset
// of ScalerStackConnection (src/encore-scaler/workspace-registry.ts:176), so
// the caller can pass the registry's own enumeration straight through.
export type PollerStackConnection = {
  stackKey: string;
  connectionId: string;
};

export type PollerSyncOutcome = {
  // connectionIds a poller was started for by this sync.
  started: string[];
  // connectionIds whose poller was stopped because no live stack uses it.
  stopped: string[];
};

export class StackCallbackPollerRegistry {
  private readonly pollers = new Map<
    string,
    { stop: StopPoller; stackKeys: Set<string> }
  >();

  // How many pollers are running. The assertion a teardown test makes: zero
  // pollers left for a deleted stack.
  get size(): number {
    return this.pollers.size;
  }

  connectionIds(): string[] {
    return [...this.pollers.keys()];
  }

  has(connectionId: string): boolean {
    return this.pollers.has(connectionId);
  }

  // The stacks a running poller is serving. Exposed for diagnostics and tests;
  // empty for a connection with no poller.
  stackKeysFor(connectionId: string): string[] {
    return [...(this.pollers.get(connectionId)?.stackKeys ?? [])];
  }

  // Converge on "one poller per distinct live connection".
  //
  // `start` is called ONLY for a connection that has no poller yet, and its
  // returned stop function is retained. Every live connection's stack set is
  // refreshed from `connections`, so a stack that moved away from a shared
  // connection does not keep a claim on its poller. A poller whose connection
  // is no longer listed is stopped and forgotten.
  sync(
    connections: PollerStackConnection[],
    start: (connection: PollerStackConnection) => StopPoller
  ): PollerSyncOutcome {
    const live = new Map<string, Set<string>>();
    for (const connection of connections) {
      const stacks = live.get(connection.connectionId) ?? new Set<string>();
      stacks.add(connection.stackKey);
      live.set(connection.connectionId, stacks);
    }

    const started: string[] = [];
    for (const connection of connections) {
      if (this.pollers.has(connection.connectionId)) continue;
      this.pollers.set(connection.connectionId, {
        stop: start(connection),
        stackKeys: new Set(live.get(connection.connectionId))
      });
      started.push(connection.connectionId);
    }

    const stopped: string[] = [];
    for (const [connectionId, entry] of [...this.pollers]) {
      const stacks = live.get(connectionId);
      if (!stacks) {
        entry.stop();
        this.pollers.delete(connectionId);
        stopped.push(connectionId);
        continue;
      }
      entry.stackKeys = new Set(stacks);
    }
    return { started, stopped };
  }

  // Stop and unregister every poller that exists only for `stackKey` (#1213).
  //
  // Called at the START of that stack's teardown, before its Valkey instance is
  // removed, so the poller is never left polling a store that is going away. A
  // poller whose connection still serves another stack keeps running; it just
  // drops its claim for this one.
  //
  // Returns the connectionIds actually stopped, so the caller can log exactly
  // what it released.
  stopForStack(stackKey: string): string[] {
    const stopped: string[] = [];
    for (const [connectionId, entry] of [...this.pollers]) {
      if (!entry.stackKeys.delete(stackKey)) continue;
      if (entry.stackKeys.size > 0) continue;
      entry.stop();
      this.pollers.delete(connectionId);
      stopped.push(connectionId);
    }
    return stopped;
  }

  // Stop every poller (process shutdown, scaler deactivation).
  stopAll(): void {
    for (const { stop } of this.pollers.values()) stop();
    this.pollers.clear();
  }
}

// The stacks whose backing Valkey is known to be GONE while their stored
// StackConfig is still there (#1213).
//
// A stack teardown that reports failures deliberately keeps the parameter-store
// entry so the DELETE can be retried — but TEARDOWN_ORDER (services/stack.ts)
// removes the queue (Valkey) SECOND, so a run that removed the Valkey and then
// failed on the database or the storage leaves a stored config whose `redisUrl`
// points at a store that no longer exists. Everything that re-derives a stack's
// Valkey from the enumeration — the scaler reconcile and the callback-poller
// sync above — would happily bind to it again, which is how a poller that was
// correctly stopped at teardown time came straight back as a new poller
// retrying a removed Valkey about once a second.
//
// So the DELETE route reports what each run established about the queue
// instance (routes/provision.ts queueInstancePresentAfterTeardown) and the sync
// consults this set: a stack recorded here is skipped — no poller started, no
// claim on the activation connection — until the stack stops being enumerable
// (the retry finished the teardown and the config was deleted, which is what
// `forgetUnlisted` detects) or its queue is reported present again (its removal
// failed, or the name was re-provisioned).
//
// Deliberately NOT a liveness probe: it records only what a teardown run
// actually observed. A stack nobody reported on is treated as live, exactly as
// before.
export class RemovedStackQueues {
  private readonly stackKeys = new Set<string>();

  get size(): number {
    return this.stackKeys.size;
  }

  // True once a teardown reported this stack's queue instance gone, until
  // something reports otherwise.
  isRemoved(stackKey: string): boolean {
    return this.stackKeys.has(stackKey);
  }

  // Record what a run established. `present: true` clears the record — the
  // queue survived (its removal failed) or the stack was re-provisioned.
  // Returns true when the recorded state actually changed, so the caller can
  // log the transition and nothing else.
  record(stackKey: string, present: boolean): boolean {
    if (present) return this.stackKeys.delete(stackKey);
    if (this.stackKeys.has(stackKey)) return false;
    this.stackKeys.add(stackKey);
    return true;
  }

  // Drop records for stacks that are no longer enumerated at all: their stored
  // config is gone, so the name carries no state worth remembering (and a stack
  // provisioned under it later must start clean). Returns the forgotten keys.
  forgetUnlisted(listedStackKeys: Iterable<string>): string[] {
    const listed = new Set(listedStackKeys);
    const forgotten: string[] = [];
    for (const stackKey of [...this.stackKeys]) {
      if (listed.has(stackKey)) continue;
      this.stackKeys.delete(stackKey);
      forgotten.push(stackKey);
    }
    return forgotten;
  }

  clear(): void {
    this.stackKeys.clear();
  }
}
