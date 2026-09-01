// Default PackageQueue backed by the OSC Valkey instance (issue #9).
//
// The eyevinn-encore-packager consumes packaging work from the Valkey queue
// provisioned in the stack (valkey-io-valkey). We publish our packaging job as
// a JSON entry onto a Redis sorted set so the packager picks it up via BZPOPMIN.
// ioredis speaks the Redis/Valkey wire protocol, so the same client works
// against OSC Valkey.
//
// CONTRACT (verified from encore-packager redisListener.ts 2026-07-07):
//   - Queue data structure: Redis Sorted Set (NOT a list)
//   - Producer: ZADD key <score> <json>  (score = Date.now() for FIFO ordering)
//   - Consumer: BZPOPMIN key <timeout>   (pops lowest-score member)
//   - Message shape: { jobId: string, url: string }
//     - jobId: our correlation id (we use assetId so the callback resolves back)
//     - url: the full Encore job API URL the packager fetches job details from
//   See docs/osc-feedback/incoming-issue9-packaging.md for friction log.

import type { Redis } from 'ioredis';
import type { PackageQueue, PackagingJob } from './packaging.js';
import { purgeStalePackagingJobs } from './encore-callback-poller.js';

// The minimal slice of the ioredis client surface we use. Declared structurally
// so a real Redis instance satisfies it and tests can pass a lightweight fake.
// Includes the sorted-set read/remove commands purgeStalePackagingJobs needs
// (#498) so the stale-ghost purge runs at this producer too.
export type RedisLike = Pick<Redis, 'zadd' | 'zrangebyscore' | 'zrem'>;

// Minimal logger surface for the best-effort purge (#498). Defaults to a no-op so
// callers that don't wire a logger keep working unchanged.
type QueueLogger = { warn(...a: unknown[]): void };
const NOOP_QUEUE_LOGGER: QueueLogger = { warn() {} };

export function packagerQueueKey(): string {
  return process.env['PACKAGER_QUEUE_KEY'] ?? 'encore-packager:jobs';
}

// Construct the production PackageQueue. Each enqueue serialises the job to JSON
// and ZADDs it onto the sorted set (FIFO with the packager's BZPOPMIN consumer).
export function makeOscPackagerQueue(
  client: RedisLike,
  queueKey: string = packagerQueueKey(),
  logger: QueueLogger = NOOP_QUEUE_LOGGER
): PackageQueue {
  return {
    async enqueue(job: PackagingJob): Promise<void> {
      // #498: purge stale ghost entries before enqueue (shared with the automatic
      // transcode->package handoff — see purgeStalePackagingJobs in
      // encore-callback-poller.ts). The manual package-start path
      // (src/routes/assets.ts) also targets this queue and provisions a packager
      // on-demand, so it shares the ghost-drain exposure. Best-effort: never throws
      // into the enqueue below.
      await purgeStalePackagingJobs(client, queueKey, { logger });
      await client.zadd(queueKey, Date.now(), JSON.stringify(job));
    }
  };
}
