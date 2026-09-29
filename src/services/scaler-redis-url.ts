// Valkey URL resolution for the Encore auto-scaler (issue #780).
//
// The scaler has no REDIS_URL env var: the URL only exists once a stack has
// been provisioned (POST /api/v1/provision writes it to the parameter store as
// StackConfig.redisUrl). main.ts resolves it at boot and again on every
// stack change, and activates the scaler when it resolves.
//
// Before #780 this resolution open-coded its own parameter-store read, which
// disagreed with the namespace the rest of the app used. It found nothing,
// returned undefined, and the scaler never activated — with no error and no
// warning, so the only symptom was `scalerActive: false` and no transcoding at
// all.
//
// This module resolves through WorkspaceStackResolver.resolveStackConfig()
// instead — the SAME read path every other consumer uses — and classifies the
// outcome so an inactive scaler is always logged. Since #804 that read path is
// the constant STACK_CONFIG_NAMESPACE on both the read and the write side, so
// there is no longer a second derivation that could disagree with it.
//
// Contract sources verified (CLAUDE.md rule 7):
//   - WorkspaceStackResolver.resolveStackConfig(stackName?):
//     Promise<StackConfig | undefined> — src/services/workspace-stack.ts.
//     It reads under the constant STACK_CONFIG_NAMESPACE through
//     loadStackConfigWithMigration / listStackNamesWithMigration
//     (workspace-stack.ts — the bounded one-shot #804 migration helpers).
//   - StackConfig.redisUrl: string — src/services/param-store.ts:63.
//   - ParamStore.loadStackConfig / listStackNames — src/services/param-store.ts:108-125.

import type { StackConfig } from './param-store.js';

// The single capability this module needs from WorkspaceStackResolver. Declared
// structurally (rather than importing the class) so the scaler path depends on
// the resolver's read contract only, and tests can drive it with a stub.
export type StackConfigSource = {
  resolveStackConfig(stackName?: string): Promise<StackConfig | undefined>;
};

// Why the scaler did or did not get a Valkey URL. The distinction matters for
// logging: "no stack provisioned yet" is an ordinary pre-provision state, while
// a stack config that exists but yields no URL is a real fault that used to be
// invisible.
export type StackRedisResolution =
  | { outcome: 'resolved'; redisUrl: string }
  // No parameter store configured, or no stack provisioned for this namespace.
  | { outcome: 'no-stack' }
  // A stack config resolved, but it carries no usable redisUrl.
  | { outcome: 'no-redis-url' }
  // The parameter-store read itself failed.
  | { outcome: 'error'; err: unknown };

// Resolve the provisioned stack's Valkey URL, namespace-aware and with the
// legacy fallback. Never throws: a read failure is returned as an `error`
// outcome so the caller decides how to react.
export async function resolveStackRedisUrl(
  source: StackConfigSource
): Promise<StackRedisResolution> {
  try {
    const config = await source.resolveStackConfig();
    if (!config) return { outcome: 'no-stack' };
    const redisUrl = config.redisUrl;
    if (typeof redisUrl !== 'string' || redisUrl.length === 0) {
      return { outcome: 'no-redis-url' };
    }
    return { outcome: 'resolved', redisUrl };
  } catch (err) {
    return { outcome: 'error', err };
  }
}

// The subset of the Fastify/pino logger surface used below.
export type ScalerLogger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
};

// Log the reason the scaler was NOT activated (issue #780). Previously this
// branch was entirely silent, so an inactive scaler looked like a healthy
// deployment until someone noticed nothing ever transcoded.
//
// A missing stack is ordinary at boot on a fresh deployment, so it is logged at
// info; anything else means a stack config exists (or the store is unreachable)
// yet no URL could be resolved, which is a fault and is logged at warn.
export function logScalerNotActivated(
  log: ScalerLogger,
  resolution: StackRedisResolution
): void {
  switch (resolution.outcome) {
    case 'resolved':
      return;
    case 'no-stack':
      log.info(
        { outcome: resolution.outcome },
        'encore-scaler: not activated — no provisioned stack found in the parameter store'
      );
      return;
    case 'no-redis-url':
      log.warn(
        { outcome: resolution.outcome },
        'encore-scaler: not activated — resolved stack config carries no Valkey URL'
      );
      return;
    case 'error':
      log.warn(
        {
          outcome: resolution.outcome,
          err:
            resolution.err instanceof Error
              ? { message: resolution.err.message, stack: resolution.err.stack }
              : String(resolution.err)
        },
        'encore-scaler: not activated — failed to resolve the stack Valkey URL from the parameter store'
      );
      return;
  }
}
