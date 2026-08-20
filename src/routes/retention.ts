// Archive retention config router (issue #325, foundation for #323).
//
// Exposes an instance-global retention window that governs how long archived
// objects are kept before the retention sweep may purge them. Modelled on the
// Encore auto-scaler config mechanism (src/routes/scaler.ts): a live mutable
// module-scoped var plus an `onConfigChange` callback, so PATCH /config hot-
// swaps the window with no server restart. Intentionally NOT behind
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
  const raw = process.env['ARCHIVE_RETENTION_MS'];
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
  // The boot-time retention window in milliseconds. 0 = never purge.
  retentionMs: number;
  // Callback to propagate a live retention-config change to the sweep at
  // runtime, mirroring scaler's onConfigChange (src/routes/scaler.ts:40).
  onConfigChange?: (cfg: { retentionMs: number }) => void;
};

const retentionConfigSchema = z.object({
  // 0 = retention disabled (never purge); any positive value is a window in ms.
  retentionMs: z.number().int().min(0)
});

export const retentionRouter: FastifyPluginAsync<RetentionRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Mutable runtime config — updated by PATCH /config (no restart), exactly as
  // scaler.ts holds `liveIdleTimeoutMs` (src/routes/scaler.ts:92-94).
  let liveRetentionMs = opts.retentionMs;

  app.get(
    '/config',
    {
      schema: {
        tags: ['admin'],
        response: { 200: retentionConfigSchema }
      }
    },
    async () => ({ retentionMs: liveRetentionMs })
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
      const { retentionMs } = request.body;
      if (retentionMs !== undefined) liveRetentionMs = retentionMs;
      opts.onConfigChange?.({ retentionMs: liveRetentionMs });
      return { retentionMs: liveRetentionMs };
    }
  );
};
