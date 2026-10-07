// GET /scaler/status must report across the SAME Valkey connections the scaler
// loops use (issue #1074).
//
// The scaler's loops are spread over one Valkey per provisioned stack: each loop
// resolves its stack's own StackConfig.redisUrl and opens a connection for it
// (WorkspaceEncoreScalerRegistry.resolveStackRedis, issue #615). The status route
// read ONE connection — the process-global one main.ts assigns on activation — so
// a pool living on a per-stack Valkey was ABSENT from the response rather than
// reported as empty, and a queue depth could be read from a different physical
// store than the loop that owns the queue ever evaluated.
//
// The two failure modes pinned here, because both are silent:
//   1. A pool on a second Valkey missing from `workspaces` entirely. "Not
//      reported" and "empty" are indistinguishable to an operator, so the
//      response has to carry both pools, and an unqueryable one has to say so
//      (observed:false) rather than disappear.
//   2. A depth read from the wrong store. stack-b's queue is deliberately given
//      DIFFERENT lengths on the two connections below; reporting the
//      process-global number for stack-b is the exact bug.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Route options: `ScalerRouterOptions` in src/routes/scaler.ts — redis?,
//     redisConnectionId?, listStackConnections?, maxInstances, minInstances?,
//     idleTimeoutMs, onConfigChange?.
//   - Response schema: `scalerStatusSchema` / `workspaceSchema` /
//     `connectionSchema` in src/routes/scaler.ts — workspaces[] carry
//     { workspaceId, connectionId?, observed, unobservedReason?, queueDepth?,
//       inflightDepth?, instances, spawnFailure? }; the envelope adds
//     `connections[]`.
//   - `ScalerStackConnection` = { stackKey: string; connectionId?: string;
//     redis?: Redis; unobservedReason?: string } and
//     `WorkspaceEncoreScalerRegistry.listStackConnections(): Promise<
//     ScalerStackConnection[]>` (src/encore-scaler/workspace-registry.ts), which
//     resolves through the registry's own resolveStackRedis() — the identical
//     connection object the loop uses.
//   - Valkey key schema: `keys` (src/encore-scaler/types.ts:319) — queue
//     `encore:queue:{id}` and inflight `encore:inflight:{id}` are lists (LLEN),
//     pool `encore:pool:{id}` is a hash of EncoreInstanceRecord, spawnFailure
//     `encore:spawn-failure:{id}` (types.ts:406) is a JSON string.
//   - listInstances(redis, workspaceId): Promise<EncoreInstanceRecord[]>
//     (src/encore-scaler/instance-pool.ts:118) — reads hgetall(keys.pool(id)).
//   - readSpawnFailure(redis: Pick<Redis,'get'>, workspaceId)
//     (src/encore-scaler/spawn-failure.ts:395).
//   - valkeyConnectionId(redisUrl): string
//     (src/encore-scaler/valkey-connection-id.ts).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';

import { scalerRouter } from '../src/routes/scaler.js';
import { keys } from '../src/encore-scaler/types.js';
import { valkeyConnectionId } from '../src/encore-scaler/valkey-connection-id.js';
import {
  WorkspaceEncoreScalerRegistry,
  type ScalerStackConnection
} from '../src/encore-scaler/workspace-registry.js';

// Minimal Valkey stand-in covering the exact commands the status read issues:
// scan (keyspace discovery), hgetall (pool), llen (queue/inflight), get
// (spawn-failure). One instance per PHYSICAL store, so a read against the wrong
// store returns the wrong store's numbers — which is what the depth assertions
// below detect.
class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();
  private lists = new Map<string, string[]>();
  private strings = new Map<string, string>();
  // When set, every command rejects — a Valkey that cannot be read at all.
  failing = false;

  hset(key: string, field: string, value: string): void {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    hash.set(field, value);
  }

  rpush(key: string, ...values: string[]): void {
    this.lists.set(key, [...(this.lists.get(key) ?? []), ...values]);
  }

  set(key: string, value: string): void {
    this.strings.set(key, value);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.guard();
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }

  async llen(key: string): Promise<number> {
    this.guard();
    return (this.lists.get(key) ?? []).length;
  }

  async get(key: string): Promise<string | null> {
    this.guard();
    return this.strings.get(key) ?? null;
  }

  async scan(
    _cursor: string,
    _match: 'MATCH',
    pattern: string,
    _count: 'COUNT',
    _n: number
  ): Promise<[string, string[]]> {
    this.guard();
    const prefix = pattern.replace(/\*$/, '');
    const allKeys = [
      ...this.hashes.keys(),
      ...this.lists.keys(),
      ...this.strings.keys()
    ];
    return ['0', allKeys.filter((key) => key.startsWith(prefix))];
  }

  private guard(): void {
    if (this.failing) throw new Error('connection refused');
  }

  asRedis(): Redis {
    return this as unknown as Redis;
  }
}

function poolRecord(instanceId: string) {
  return JSON.stringify({
    instanceId,
    url: `https://${instanceId}.example`,
    activeJobs: 1,
    readyAt: 1_800_000_000_000
  });
}

const VALKEY_A_URL = 'redis://user:pw-a@valkey-a.internal:6379';
const VALKEY_B_URL = 'redis://user:pw-b@valkey-b.internal:6379';
const CONNECTION_A = valkeyConnectionId(VALKEY_A_URL);
const CONNECTION_B = valkeyConnectionId(VALKEY_B_URL);

describe('GET /scaler/status across two stacks on two Valkeys (issue #1074)', () => {
  let app: FastifyInstance;
  let valkeyA: FakeRedis;
  let valkeyB: FakeRedis;
  let stackConnections: ScalerStackConnection[];

  async function start(): Promise<void> {
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(scalerRouter, {
      prefix: '/scaler',
      // The process-global connection: stack-a's Valkey, exactly as main.ts
      // assigns it on activation (the first-provisioned stack's store).
      redis: valkeyA.asRedis(),
      redisConnectionId: CONNECTION_A,
      listStackConnections: async () => stackConnections,
      maxInstances: 3,
      minInstances: 0,
      idleTimeoutMs: 300_000
    });
    await app.ready();
  }

  beforeEach(() => {
    valkeyA = new FakeRedis();
    valkeyB = new FakeRedis();

    // stack-a lives on connection A: one instance, two queued, one in flight.
    valkeyA.hset(keys.pool('stack-a'), 'inst-a', poolRecord('inst-a'));
    valkeyA.rpush(keys.queue('stack-a'), 'job-a1', 'job-a2');
    valkeyA.rpush(keys.inflight('stack-a'), 'job-a0');

    // stack-b lives on connection B: one instance, five queued.
    valkeyB.hset(keys.pool('stack-b'), 'inst-b', poolRecord('inst-b'));
    valkeyB.rpush(keys.queue('stack-b'), 'j1', 'j2', 'j3', 'j4', 'j5');

    // A DECOY on connection A under stack-b's key. stack-b's loop never reads
    // this store, so any response reporting 1 for stack-b's queue has read the
    // process-global Valkey instead of the one the loop evaluated.
    valkeyA.rpush(keys.queue('stack-b'), 'decoy');

    stackConnections = [
      { stackKey: 'stack-a', connectionId: CONNECTION_A, redis: valkeyA.asRedis() },
      { stackKey: 'stack-b', connectionId: CONNECTION_B, redis: valkeyB.asRedis() }
    ];
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports both pools, each with the depths its own loop would see', async () => {
    await start();

    const res = await app.inject({ method: 'GET', url: '/scaler/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const byKey = new Map<string, Record<string, unknown>>(
      (body.workspaces as Array<Record<string, unknown>>).map((ws) => [
        `${ws['workspaceId']}@${ws['connectionId']}`,
        ws
      ])
    );

    const stackA = byKey.get(`stack-a@${CONNECTION_A}`);
    const stackB = byKey.get(`stack-b@${CONNECTION_B}`);
    expect(stackA).toBeDefined();
    expect(stackB).toBeDefined();

    expect(stackA).toMatchObject({ observed: true, queueDepth: 2, inflightDepth: 1 });
    expect((stackA?.['instances'] as unknown[]).map((i) => (i as { instanceId: string }).instanceId))
      .toEqual(['inst-a']);

    // The whole point: stack-b's numbers come from stack-b's Valkey.
    expect(stackB).toMatchObject({ observed: true, queueDepth: 5, inflightDepth: 0 });
    expect((stackB?.['instances'] as unknown[]).map((i) => (i as { instanceId: string }).instanceId))
      .toEqual(['inst-b']);

    // Coverage is stated, not implied: both connections reported, each with the
    // stack bound to it.
    const connections = body.connections as Array<Record<string, unknown>>;
    expect(connections).toHaveLength(2);
    expect(
      connections.map((c) => ({
        connectionId: c['connectionId'],
        stacks: c['stacks'],
        observed: c['observed']
      }))
    ).toEqual(
      expect.arrayContaining([
        { connectionId: CONNECTION_A, stacks: ['stack-a'], observed: true },
        { connectionId: CONNECTION_B, stacks: ['stack-b'], observed: true }
      ])
    );
    expect(body.scalerActive).toBe(true);
  });

  it('never leaks a connection string or credential while identifying a connection', async () => {
    await start();

    const res = await app.inject({ method: 'GET', url: '/scaler/status' });
    const raw = res.payload;

    expect(raw).not.toContain('redis://');
    expect(raw).not.toContain('pw-a');
    expect(raw).not.toContain('pw-b');
    expect(raw).not.toContain('valkey-a.internal');
    expect(raw).not.toContain('valkey-b.internal');
    expect(raw).not.toContain('6379');
    // Identifying the connection is still possible — that is all the label owes.
    expect(raw).toContain(CONNECTION_B);
  });

  it('reports a provisioned stack with no keys at all as EMPTY, not missing', async () => {
    // stack-c is provisioned on its own (completely empty) Valkey.
    const valkeyC = new FakeRedis();
    const connectionC = valkeyConnectionId('redis://valkey-c.internal:6379');
    stackConnections = [
      ...stackConnections,
      { stackKey: 'stack-c', connectionId: connectionC, redis: valkeyC.asRedis() }
    ];
    await start();

    const res = await app.inject({ method: 'GET', url: '/scaler/status' });
    const stackC = (res.json().workspaces as Array<Record<string, unknown>>).find(
      (ws) => ws['workspaceId'] === 'stack-c'
    );

    expect(stackC).toMatchObject({
      connectionId: connectionC,
      observed: true,
      queueDepth: 0,
      inflightDepth: 0,
      instances: []
    });
    expect(stackC?.['unobservedReason']).toBeUndefined();
  });

  it('reports a stack whose Valkey cannot be read as UNOBSERVED, not as empty', async () => {
    valkeyB.failing = true;
    await start();

    const res = await app.inject({ method: 'GET', url: '/scaler/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const stackB = (body.workspaces as Array<Record<string, unknown>>).find(
      (ws) => ws['workspaceId'] === 'stack-b' && ws['connectionId'] === CONNECTION_B
    );
    // Present, flagged, and carrying NO depths — a 0 here would read as "empty".
    expect(stackB).toBeDefined();
    expect(stackB?.['observed']).toBe(false);
    expect(stackB?.['unobservedReason']).toBeTruthy();
    expect(stackB?.['queueDepth']).toBeUndefined();
    expect(stackB?.['inflightDepth']).toBeUndefined();

    // stack-a is unaffected: one unreachable store must not blank the others.
    const stackA = (body.workspaces as Array<Record<string, unknown>>).find(
      (ws) => ws['workspaceId'] === 'stack-a'
    );
    expect(stackA).toMatchObject({ observed: true, queueDepth: 2 });

    const connectionB = (body.connections as Array<Record<string, unknown>>).find(
      (c) => c['connectionId'] === CONNECTION_B
    );
    expect(connectionB).toMatchObject({ observed: false, stacks: ['stack-b'] });
  });

  it('reports a stack whose connection could not be resolved as UNOBSERVED', async () => {
    stackConnections = [
      { stackKey: 'stack-a', connectionId: CONNECTION_A, redis: valkeyA.asRedis() },
      { stackKey: 'stack-d', unobservedReason: "this stack's Valkey connection could not be resolved" }
    ];
    await start();

    const res = await app.inject({ method: 'GET', url: '/scaler/status' });
    const body = res.json();

    const stackD = (body.workspaces as Array<Record<string, unknown>>).find(
      (ws) => ws['workspaceId'] === 'stack-d'
    );
    expect(stackD).toMatchObject({ observed: false, instances: [] });
    expect(stackD?.['connectionId']).toBeUndefined();
    expect(body.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stacks: ['stack-d'], observed: false })
      ])
    );
  });

  it('collapses two stacks sharing one Valkey into a single observation', async () => {
    // Both stacks resolve to the SAME store, so resolveStackRedis hands out the
    // same connection object. The workspace must not be reported twice.
    stackConnections = [
      { stackKey: 'stack-a', connectionId: CONNECTION_A, redis: valkeyA.asRedis() },
      { stackKey: 'stack-a2', connectionId: CONNECTION_A, redis: valkeyA.asRedis() }
    ];
    await start();

    const res = await app.inject({ method: 'GET', url: '/scaler/status' });
    const body = res.json();

    const stackARows = (body.workspaces as Array<Record<string, unknown>>).filter(
      (ws) => ws['workspaceId'] === 'stack-a'
    );
    expect(stackARows).toHaveLength(1);
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({
      connectionId: CONNECTION_A,
      stacks: ['stack-a', 'stack-a2'],
      observed: true
    });
    // stack-a2 has no keys on the shared store: reported empty, not missing.
    const stackA2 = (body.workspaces as Array<Record<string, unknown>>).find(
      (ws) => ws['workspaceId'] === 'stack-a2'
    );
    expect(stackA2).toMatchObject({ observed: true, queueDepth: 0, instances: [] });
  });
});

describe('scaler status with no per-stack enumeration wired (issue #1074)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('still reports the process-global connection, labelled', async () => {
    const redis = new FakeRedis();
    redis.hset(keys.pool('ws-1'), 'inst-1', poolRecord('inst-1'));
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(scalerRouter, {
      prefix: '/scaler',
      redis: redis.asRedis(),
      maxInstances: 3,
      idleTimeoutMs: 300_000
    });
    await app.ready();

    const body = (await app.inject({ method: 'GET', url: '/scaler/status' })).json();
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toMatchObject({ workspaceId: 'ws-1', observed: true });
    // Labelled even without main.ts's identifier, so a client never has to guess
    // which store a number came from.
    expect(typeof body.workspaces[0].connectionId).toBe('string');
    expect(body.connections).toEqual([
      expect.objectContaining({ stacks: [], observed: true })
    ]);
  });

  it('reports scalerActive:false with no connections when the scaler is off', async () => {
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(scalerRouter, {
      prefix: '/scaler',
      maxInstances: 4,
      idleTimeoutMs: 300_000
    });
    await app.ready();

    const body = (await app.inject({ method: 'GET', url: '/scaler/status' })).json();
    expect(body).toMatchObject({
      workspaces: [],
      connections: [],
      scalerActive: false,
      maxInstances: 4
    });
  });
});

describe('WorkspaceEncoreScalerRegistry.listStackConnections (issue #1074)', () => {
  // The registry side of the fan-out: the connections it hands an observer must be
  // the SAME objects its loops use, one per distinct store, and a stack it cannot
  // resolve must come back flagged rather than dropped.
  //
  // Contract: WorkspaceEncoreScalerConfig fields exercised here are
  // { redis, redisUrl, oscContext, maxInstances, idleTimeoutMs, resolveRedisUrl,
  //   makeRedis, listStackKeys } (src/encore-scaler/workspace-registry.ts).
  function makeRegistry(options: {
    urls: Record<string, string>;
    stackKeys: string[];
    onMakeRedis?: (url: string) => void;
    listStackKeysImpl?: () => Promise<string[]>;
  }) {
    const globalRedis = new FakeRedis().asRedis();
    const created = new Map<string, Redis>();
    const registry = new WorkspaceEncoreScalerRegistry({
      redis: globalRedis,
      redisUrl: VALKEY_A_URL,
      oscContext: {} as never,
      maxInstances: 2,
      idleTimeoutMs: 300_000,
      resolveRedisUrl: async (stackKey: string) => options.urls[stackKey],
      makeRedis: (url: string) => {
        options.onMakeRedis?.(url);
        const redis = new FakeRedis().asRedis();
        created.set(url, redis);
        return redis;
      },
      listStackKeys: options.listStackKeysImpl ?? (async () => options.stackKeys)
    });
    return { registry, globalRedis, created };
  }

  it('resolves one connection per stack, labelled by store', async () => {
    const { registry } = makeRegistry({
      urls: { 'stack-a': VALKEY_A_URL, 'stack-b': VALKEY_B_URL },
      stackKeys: ['stack-a', 'stack-b']
    });

    const connections = await registry.listStackConnections();

    expect(
      connections
        .map((c) => ({ stackKey: c.stackKey, connectionId: c.connectionId }))
        .sort((a, b) => a.stackKey.localeCompare(b.stackKey))
    ).toEqual([
      { stackKey: 'stack-a', connectionId: CONNECTION_A },
      { stackKey: 'stack-b', connectionId: CONNECTION_B }
    ]);
    // stack-a's URL is the process-global one, so it must reuse that connection
    // rather than open a second socket to the same store.
    const stackA = connections.find((c) => c.stackKey === 'stack-a');
    const stackB = connections.find((c) => c.stackKey === 'stack-b');
    expect(stackA?.redis).toBeDefined();
    expect(stackB?.redis).toBeDefined();
    expect(stackB?.redis).not.toBe(stackA?.redis);
  });

  it('hands out the same connection object on a repeat observation', async () => {
    const opened: string[] = [];
    const { registry } = makeRegistry({
      urls: { 'stack-b': VALKEY_B_URL },
      stackKeys: ['stack-b'],
      onMakeRedis: (url) => opened.push(url)
    });

    const first = await registry.listStackConnections();
    const second = await registry.listStackConnections();

    expect(second[0]?.redis).toBe(first[0]?.redis);
    // One socket per distinct store, no matter how often the status is polled.
    expect(opened).toEqual([VALKEY_B_URL]);
    registry.stopAll();
  });

  it('reports a stack whose connection cannot be opened, rather than dropping it', async () => {
    const globalRedis = new FakeRedis().asRedis();
    const registry = new WorkspaceEncoreScalerRegistry({
      redis: globalRedis,
      redisUrl: VALKEY_A_URL,
      oscContext: {} as never,
      maxInstances: 2,
      idleTimeoutMs: 300_000,
      resolveRedisUrl: async () => VALKEY_B_URL,
      makeRedis: () => {
        // ioredis throws on an unparseable connection string, and the message
        // quotes it — hence the reason text carried out of here must not.
        throw new Error(`invalid connection string ${VALKEY_B_URL}`);
      },
      listStackKeys: async () => ['stack-broken']
    });

    const connections = await registry.listStackConnections();

    expect(connections).toHaveLength(1);
    expect(connections[0]?.stackKey).toBe('stack-broken');
    expect(connections[0]?.redis).toBeUndefined();
    expect(connections[0]?.unobservedReason).toBeTruthy();
    expect(connections[0]?.unobservedReason).not.toContain('redis://');
    expect(connections[0]?.unobservedReason).not.toContain('valkey-b.internal');
  });

  it('falls back to known stacks when the enumeration itself fails', async () => {
    let calls = 0;
    const { registry } = makeRegistry({
      urls: { 'stack-b': VALKEY_B_URL },
      stackKeys: [],
      listStackKeysImpl: async () => {
        calls += 1;
        throw new Error('parameter store unreachable');
      }
    });

    const connections = await registry.listStackConnections();

    expect(calls).toBe(1);
    // Nothing resolved yet and no enumeration: an empty list, not a throw.
    expect(connections).toEqual([]);
  });
});

describe('valkeyConnectionId (issue #1074)', () => {
  it('is stable across a credential rotation and distinct per store', () => {
    expect(valkeyConnectionId('redis://user:old@valkey-a.internal:6379')).toBe(
      valkeyConnectionId('redis://user:new@valkey-a.internal:6379')
    );
    expect(valkeyConnectionId('redis://valkey-a.internal:6379')).not.toBe(
      valkeyConnectionId('redis://valkey-b.internal:6379')
    );
  });

  it('reveals nothing about where the store is', () => {
    const id = valkeyConnectionId('redis://user:secret@valkey-a.internal:6379/2');
    expect(id).toMatch(/^valkey-[0-9a-f]{8}$/);
    expect(id).not.toContain('secret');
    expect(id).not.toContain('valkey-a.internal');
    expect(id).not.toContain('6379');
  });
});
