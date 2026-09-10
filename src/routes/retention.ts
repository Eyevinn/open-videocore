// Retention config router (issue #325, foundation for #323; extended for the
// audit-log retention window in #566).
//
// Exposes instance-global retention windows that govern how long resources are
// kept before their retention sweep may purge them:
//   - `retentionMs`      — the ARCHIVED-ASSET window (#325/#327).
//   - `auditRetentionMs` — the AUDIT-LOG window (#566). Default off (0 =
//     indefinite retention); when set, the audit purge sweep expires whole
//     audit entries aged past it. See docs/architecture/ADR-021-audit-log-retention.md.
// Both share this ONE config surface (not a parallel endpoint): GET /config
// reports both effective windows so an operator can see the current policy at a
// glance, and PATCH /config can hot-swap either independently.
//
// Modelled on the Encore auto-scaler config mechanism (src/routes/scaler.ts): a
// live mutable module-scoped var plus an `onConfigChange` callback, so PATCH
// /config hot-swaps the window with no server restart. Intentionally NOT behind
// `authenticate` — like the scaler config endpoints it reports/adjusts
// aggregate operational state, not workspace data.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Live-mutable-var + onConfigChange PATCH pattern: src/routes/scaler.ts:88-152
//     (`let liveIdleTimeoutMs = opts.idleTimeoutMs`, PATCH '/config' assigns the
//     live var then calls `opts.onConfigChange?.(...)`).
//   - Route registration by reference so main.ts can mutate opts live:
//     src/main.ts:1071-1084 (scalerRouterOptions held by reference, registered
//     with a `prefix`).
//   - Env-var boot read convention: src/main.ts:468-469
//     (`parseInt(process.env['ENCORE_...'] || 'default', 10)`).

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

// A retention window of 0 (or unset) means "never purge" — this preserves the
// existing behaviour for every deployment that does not opt in.
export const RETENTION_DISABLED_MS = 0;

// Resolve the boot-time retention window (12-factor: config via env). Unset,
// non-numeric, or negative all resolve to disabled (0 = never purge), matching
// the acceptance criterion that an unset/`0` value is behaviourally identical to
// today. Mirrors the parseInt env convention in src/main.ts:468-469.
export function archiveRetentionMsFromEnv(): number {
  return retentionMsFromEnv('ARCHIVE_RETENTION_MS');
}

// Resolve the boot-time AUDIT-LOG retention window (issue #566). Default off:
// unset/non-numeric/negative all resolve to 0 = indefinite retention (never
// purge), so #563's behaviour is preserved for every deployment that does not
// opt in. Same parse rules as the archived-asset window (12-factor: env config).
export function auditRetentionMsFromEnv(): number {
  return retentionMsFromEnv('AUDIT_RETENTION_MS');
}

// Shared env parse for a retention window: unset/non-numeric/negative -> 0
// (disabled). Mirrors the parseInt env convention in src/main.ts:468-469.
function retentionMsFromEnv(name: string): number {
  const raw = process.env[name];
  if (!raw) {
    return RETENTION_DISABLED_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return RETENTION_DISABLED_MS;
  }
  return parsed;
}

type RetentionRouterOptions = {
  // The boot-time archived-asset retention window in milliseconds. 0 = never purge.
  retentionMs: number;
  // The boot-time audit-log retention window in milliseconds (issue #566).
  // 0 = indefinite retention (never purge). Optional so existing callers that
  // only manage the archived-asset window keep working; defaults to 0.
  auditRetentionMs?: number;
  // Callback to propagate a live retention-config change to the sweeps at
  // runtime, mirroring scaler's onConfigChange (src/routes/scaler.ts:40). Fires
  // with BOTH effective windows so main.ts can update the two instance globals.
  onConfigChange?: (cfg: { retentionMs: number; auditRetentionMs: number }) => void;
};

const retentionConfigSchema = z.object({
  // 0 = retention disabled (never purge); any positive value is a window in ms.
  retentionMs: z.number().int().min(0),
  // The audit-log window (issue #566). 0 = indefinite retention (never purge).
  auditRetentionMs: z.number().int().min(0)
});

export const retentionRouter: FastifyPluginAsync<RetentionRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Mutable runtime config — updated by PATCH /config (no restart), exactly as
  // scaler.ts holds `liveIdleTimeoutMs` (src/routes/scaler.ts:92-94).
  let liveRetentionMs = opts.retentionMs;
  let liveAuditRetentionMs = opts.auditRetentionMs ?? RETENTION_DISABLED_MS;

  app.get(
    '/config',
    {
      schema: {
        tags: ['admin'],
        response: { 200: retentionConfigSchema }
      }
    },
    // Report BOTH effective windows so an operator can see the current policy,
    // including the audit-log retention window (issue #566).
    async () => ({ retentionMs: liveRetentionMs, auditRetentionMs: liveAuditRetentionMs })
  );

  app.patch(
    '/config',
    {
      schema: {
        tags: ['admin'],
        body: retentionConfigSchema.partial(),
        response: { 200: retentionConfigSchema }
      }
    },
    async (request) => {
      const { retentionMs, auditRetentionMs } = request.body;
      if (retentionMs !== undefined) liveRetentionMs = retentionMs;
      if (auditRetentionMs !== undefined) liveAuditRetentionMs = auditRetentionMs;
      opts.onConfigChange?.({
        retentionMs: liveRetentionMs,
        auditRetentionMs: liveAuditRetentionMs
      });
      return { retentionMs: liveRetentionMs, auditRetentionMs: liveAuditRetentionMs };
    }
  );
};
