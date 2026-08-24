// Aggregate degraded-resolution signal for the workspace stack resolver
// (issue #422).
//
// Individual resolution failures are visible in logs, but there was no
// aggregate, alertable signal that an instance had entered a degraded
// resolution state. A reported incident ran ~2h fully degraded (across ~25
// five-minute refresh cycles) with no queryable signal. This module provides a
// small, self-contained in-process signal that the resolver mutates and the
// /health endpoint reads, so operators can detect a degraded-but-not-crashed
// instance without reading logs.
//
// The signal covers two degraded fallback states the resolver can serve:
//   - no-storage fallback: the resolver could not build a live stack and
//     dropped to no-op in-memory connections (no object storage / no database).
//   - stale last-known-good fallback: a refresh failed and the resolver served
//     previously cached, now-stale, ready-stack connections.
//
// It is deliberately framework-free (the service has no metrics framework
// today; verified against package.json — no prom-client) and process-local:
// gauges reflect the CURRENT state, counters accumulate transitions since boot
// so an alert can fire on either a persisted degraded gauge or a rising counter.

// The current degraded fallback mode the resolver is serving, or 'none' when
// resolution is healthy (a live stack, an env-override stack, or an intended
// no-store dev configuration is NOT degraded — see markHealthy/markNoStorage).
export type DegradedMode = 'none' | 'no-storage' | 'stale-last-known-good';

export type ResolverHealthSnapshot = {
  // True when the resolver last served either degraded fallback. Convenience
  // boolean for a simple liveness-style alert.
  degraded: boolean;
  // Current degraded mode (gauge-like): the last fallback served, or 'none'.
  mode: DegradedMode;
  // Monotonic counters (since process start) of how many times each degraded
  // fallback was selected. Alertable on rate-of-change even if the gauge later
  // recovers to 'none'.
  noStorageFallbackTotal: number;
  staleFallbackTotal: number;
  // Epoch millis when the resolver last entered a degraded mode, or null if it
  // has never been degraded since boot. Lets an operator see how long an
  // instance has been degraded.
  lastDegradedAt: number | null;
};

// Process-local resolver-health signal. One instance is shared between the
// resolver (writer) and the /health endpoint (reader). Not exported as a
// singleton so tests can construct isolated instances.
export class ResolverHealthSignal {
  private mode: DegradedMode = 'none';
  private noStorageFallbackTotal = 0;
  private staleFallbackTotal = 0;
  private lastDegradedAt: number | null = null;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  // Record that the resolver dropped to the no-storage (in-memory no-op)
  // fallback because it could not build a live stack. Increments the counter
  // and sets the gauge on every occurrence, so a persistent degraded state
  // keeps the counter climbing across refresh cycles.
  markNoStorageFallback(): void {
    this.noStorageFallbackTotal += 1;
    this.mode = 'no-storage';
    this.lastDegradedAt = this.now();
  }

  // Record that the resolver served stale last-known-good connections after a
  // failed refresh. Defined here so the signal is ready for the last-known-good
  // path (issue #420) even before that path lands in this branch.
  markStaleLastKnownGood(): void {
    this.staleFallbackTotal += 1;
    this.mode = 'stale-last-known-good';
    this.lastDegradedAt = this.now();
  }

  // Record that the resolver served healthy (non-degraded) connections: a live
  // stack or an explicit env-override. Clears the current degraded gauge but
  // leaves the accumulated counters intact.
  markHealthy(): void {
    this.mode = 'none';
  }

  snapshot(): ResolverHealthSnapshot {
    return {
      degraded: this.mode !== 'none',
      mode: this.mode,
      noStorageFallbackTotal: this.noStorageFallbackTotal,
      staleFallbackTotal: this.staleFallbackTotal,
      lastDegradedAt: this.lastDegradedAt
    };
  }
}
