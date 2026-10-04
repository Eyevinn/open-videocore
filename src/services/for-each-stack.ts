// Run a background sweep once per provisioned stack (issue #1098).
//
// Every sweep wired in src/main.ts runs OUTSIDE a request, so the ambient
// request-stack context is empty (services/request-stack-context.ts: "Outside a
// request (boot wiring, sweeps, watch-folder) the store is empty and
// `currentRequestStackName()` returns undefined"). A sweep whose dependencies
// resolve the ambient stack therefore only ever saw the FIRST listed stack
// (`WorkspaceStackResolver.resolve()`, no-stackName branch -> cache key `''` ->
// `listStackNames()[0]`). On an installation with more than one provisioned
// stack, retention purges, audit expiry, abandoned-upload settling and quota
// accounting silently skipped stacks 2..N.
//
// ARCHITECT DECISION (issue #1098): sweeps are PER-STACK. One deployed instance
// is one tenant (ADR-018 §3 "One deployed stack == one tenant's workspace";
// ADR-020 Decision 1 "per-deployment cost guardrail"), and the stacks of that
// one deployment all belong to that one tenant — `X-Stack-Name` "partitions one
// tenant's own storage rather than crossing a trust boundary"
// (ADR-018, scope note on `X-Stack-Name`). So iterating every stack does not
// introduce a tenant dimension; it simply stops the sweeps from ignoring most of
// the tenant's own data. In a single-stack deployment the loop below runs
// exactly once, so the two framings do not conflict. Recorded as
// docs/architecture/ADR-020-addendum-per-stack-sweeps.md.
//
// This mirrors the per-stack reconciler loop already wired into the scaler tick
// (src/main.ts, `reconcileFailedTranscodes`, issue #1058/#1062) and replaces
// that inline copy with this single helper.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - WorkspaceStackResolver.listStackNames(): src/services/workspace-stack.ts:1186-1202
//     (returns [] when no parameter store is configured; a read failure is
//     logged and reported as "no stacks" rather than thrown)
//   - WorkspaceStackResolver.resolve(stackName?): src/services/workspace-stack.ts:906
//     (cache key `stackName ?? ''`; warms the entry `resolveCached` reads)
//   - WorkspaceStackResolver.resolveCached(stackName?): src/services/workspace-stack.ts:1208-1213
//   - runWithRequestStack(stackName, fn): src/services/request-stack-context.ts:46-48

import { runWithRequestStack } from './request-stack-context.js';

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
  error?(...a: unknown[]): void;
};

// The minimal resolver surface this helper needs. Declared structurally (as
// request-stack-context.ts's CachedStackResolver is) so tests can drive the
// production helper against a stub resolver without live CouchDB/MinIO clients.
export type StackSweepResolver = {
  listStackNames(): Promise<string[]>;
  resolve(stackName?: string): Promise<unknown>;
};

export type ForEachStackOptions = {
  resolver: StackSweepResolver;
  // Names the sweep in the per-stack failure log line, e.g. 'archived-asset-purge'.
  label: string;
  logger?: Logger;
};

export type ForEachStackResult = {
  // How many stack contexts this pass covered. 1 on a single-stack deployment
  // and on the no-parameter-store path (the single `undefined` context).
  stacks: number;
  // How many of those contexts threw (resolve or sweep). Reported so a caller
  // whose write must not be based on a partial pass — the deployment-wide
  // storage-quota total, src/data/storage-quota-stack-sum.ts — can skip it.
  failed: number;
};

// Run `fn` once inside EACH provisioned stack's request-stack context.
//
// The stack list is re-read on EVERY call (never cached), so a stack provisioned
// after boot is swept from its next tick onwards. When no stack is listed (no
// parameter store — env override or a bare local run) the single `undefined`
// context runs, which is byte-identical to the previous no-name behaviour.
//
// Each stack's connections are warmed with `resolve(name)` before `fn` runs, so
// a sweep dependency that reads `resolveCached(currentRequestStackName())`
// synchronously sees THIS stack's connections — the same warming the global
// request preHandler performs (src/main.ts `request.connections = await
// stackResolver.resolve(stackName)`).
//
// Failures are ISOLATED per stack: one stack's error is logged and the remaining
// stacks are still swept, so an unreachable stack cannot starve the others.
export async function forEachStack(
  opts: ForEachStackOptions,
  fn: (stackName: string | undefined) => Promise<void>
): Promise<ForEachStackResult> {
  const names = await opts.resolver.listStackNames();
  const stackContexts: Array<string | undefined> = names.length > 0 ? names : [undefined];
  let failed = 0;
  for (const stackName of stackContexts) {
    try {
      await opts.resolver.resolve(stackName);
      await runWithRequestStack(stackName, () => fn(stackName));
    } catch (err) {
      failed += 1;
      opts.logger?.warn?.(
        { err, stackName, stacks: stackContexts.length },
        `${opts.label}: sweep failed for this stack; continuing with the remaining stacks`
      );
    }
  }
  return { stacks: stackContexts.length, failed };
}

// Bind `forEachStack` into the shape the sweep loops accept: a function that
// takes the loop's per-tick sweep body and runs it once per stack. Used in
// src/main.ts to wire each loop with one line.
export function perStackSweepRunner(
  opts: ForEachStackOptions
): (run: () => Promise<void>) => Promise<void> {
  return async (run) => {
    await forEachStack(opts, () => run());
  };
}
