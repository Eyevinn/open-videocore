// Default PackageQueue backed by the OSC Valkey instance (issue #9).
//
// The eyevinn-encore-packager consumes packaging work from the Valkey queue
// provisioned in the stack (valkey-io-valkey). We publish our packaging job as
// a JSON entry onto a Redis list so the packager picks it up. ioredis speaks
// the Redis/Valkey wire protocol, so the same client works against OSC Valkey.
//
// OSC FRICTION (logged): the exact queue key + job envelope the packager reads
// is not formally documented in the OSC catalog. We push onto a configurable
// list key (PACKAGER_QUEUE_KEY) and keep the envelope injectable/overridable so
// the contract can be corrected without touching the orchestration in
// packaging.ts. See docs/osc-feedback/incoming-issue9-packaging.md.

import type { Redis } from 'ioredis';
import type { PackageQueue, PackagingJob } from './packaging.js';

// The minimal slice of the ioredis client surface we use. Declared structurally
// so a real Redis instance satisfies it and tests can pass a lightweight fake.
export type RedisLike = Pick<Redis, 'rpush'>;

export function packagerQueueKey(): string {
  return process.env['PACKAGER_QUEUE_KEY'] ?? 'encore-packager:jobs';
}

// Construct the production PackageQueue. Each enqueue serialises the job to JSON
// and RPUSHes it onto the packager's queue list (FIFO with the packager's
// LPOP/BLPOP consumer).
export function makeOscPackagerQueue(client: RedisLike, queueKey: string = packagerQueueKey()): PackageQueue {
  return {
    async enqueue(job: PackagingJob): Promise<void> {
      await client.rpush(queueKey, JSON.stringify(job));
    }
  };
}
