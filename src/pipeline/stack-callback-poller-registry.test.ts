// The per-stack callback-poller bookkeeping (issue #1213).
//
// main.ts runs one encore-callback poller per DISTINCT stack Valkey connection.
// Stopping one at teardown time has to be exact in both directions: a poller
// must be released as soon as the last stack it was started for is going away
// (otherwise it polls a removed Valkey once a second with ECONNREFUSED), and a
// poller whose connection still serves a live stack must keep running
// (otherwise that stack's completions are never drained and its jobs are later
// failed as "dropped by Encore").
//
// CONTRACT SOURCES (verified before writing, CLAUDE.md rule 7):
//   - src/pipeline/stack-callback-poller-registry.ts — StackCallbackPollerRegistry
//     .sync(connections, start) => { started, stopped }, .stopForStack(stackKey)
//     => string[], .stopAll(), .size, .has(), .connectionIds(), .stackKeysFor();
//     PollerStackConnection = { stackKey: string; connectionId: string }.
//   - src/encore-scaler/workspace-registry.ts:176 ScalerStackConnection —
//     { stackKey; connectionId?; redis?; unobservedReason? }, the enumeration
//     main.ts narrows into PollerStackConnection.

import { describe, expect, it } from 'vitest';
import {
  RemovedStackQueues,
  StackCallbackPollerRegistry
} from './stack-callback-poller-registry.js';

type Started = { connectionId: string; running: boolean; stops: number };

function fleet(): {
  registry: StackCallbackPollerRegistry;
  started: Started[];
  start: (c: { stackKey: string; connectionId: string }) => () => void;
} {
  const registry = new StackCallbackPollerRegistry();
  const started: Started[] = [];
  const start = (c: { stackKey: string; connectionId: string }) => {
    const entry: Started = { connectionId: c.connectionId, running: true, stops: 0 };
    started.push(entry);
    return () => {
      entry.running = false;
      entry.stops += 1;
    };
  };
  return { registry, started, start };
}

describe('StackCallbackPollerRegistry (#1213)', () => {
  it('starts one poller per distinct connection and stops the ones no longer listed', () => {
    const { registry, started, start } = fleet();

    const first = registry.sync(
      [
        { stackKey: 'a', connectionId: 'conn-a' },
        { stackKey: 'b', connectionId: 'conn-b' }
      ],
      start
    );
    expect(first.started).toEqual(['conn-a', 'conn-b']);
    expect(registry.size).toBe(2);

    // Re-syncing the same enumeration must not start a second poller.
    const again = registry.sync(
      [
        { stackKey: 'a', connectionId: 'conn-a' },
        { stackKey: 'b', connectionId: 'conn-b' }
      ],
      start
    );
    expect(again.started).toEqual([]);
    expect(started).toHaveLength(2);

    // 'b' is gone from the enumeration: its poller is stopped and forgotten.
    const third = registry.sync([{ stackKey: 'a', connectionId: 'conn-a' }], start);
    expect(third.stopped).toEqual(['conn-b']);
    expect(registry.connectionIds()).toEqual(['conn-a']);
    expect(started.find((s) => s.connectionId === 'conn-b')!.running).toBe(false);
    expect(started.find((s) => s.connectionId === 'conn-a')!.running).toBe(true);
  });

  it('stopForStack releases the poller of the stack being torn down', () => {
    const { registry, started, start } = fleet();
    registry.sync([{ stackKey: 'doomed', connectionId: 'conn-doomed' }], start);

    expect(registry.stopForStack('doomed')).toEqual(['conn-doomed']);
    expect(started[0].running).toBe(false);
    expect(started[0].stops).toBe(1);
    expect(registry.size).toBe(0);

    // Idempotent: the reconcile that follows the teardown must not double-stop.
    expect(registry.stopForStack('doomed')).toEqual([]);
    expect(started[0].stops).toBe(1);
  });

  it('keeps a shared connection polling while another stack still uses it', () => {
    const { registry, started, start } = fleet();
    registry.sync(
      [
        { stackKey: 'one', connectionId: 'shared' },
        { stackKey: 'two', connectionId: 'shared' }
      ],
      start
    );
    expect(started).toHaveLength(1);

    // Deleting 'one' must NOT stop the poller 'two' still needs.
    expect(registry.stopForStack('one')).toEqual([]);
    expect(started[0].running).toBe(true);
    expect(registry.stackKeysFor('shared')).toEqual(['two']);

    // Deleting the last stack on that connection releases it.
    expect(registry.stopForStack('two')).toEqual(['shared']);
    expect(started[0].running).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('does not stop a poller for an unrelated stack name', () => {
    const { registry, started, start } = fleet();
    registry.sync([{ stackKey: 'keep', connectionId: 'conn-keep' }], start);

    expect(registry.stopForStack('never-provisioned')).toEqual([]);
    expect(started[0].running).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('stopAll releases every poller', () => {
    const { registry, started, start } = fleet();
    registry.sync(
      [
        { stackKey: 'a', connectionId: 'conn-a' },
        { stackKey: 'b', connectionId: 'conn-b' }
      ],
      start
    );

    registry.stopAll();
    expect(started.every((s) => !s.running)).toBe(true);
    expect(registry.size).toBe(0);
  });
});

// The other half of the bookkeeping: WHICH stacks must not be polled at all,
// because a teardown that kept their stored config has already removed the
// Valkey that config points at.
describe('RemovedStackQueues', () => {
  it('treats a stack nobody reported on as pollable', () => {
    const removed = new RemovedStackQueues();
    expect(removed.isRemoved('mystack')).toBe(false);
    expect(removed.size).toBe(0);
  });

  it('records a removed queue once and clears it when the queue is present again', () => {
    const removed = new RemovedStackQueues();

    expect(removed.record('mystack', false)).toBe(true);
    expect(removed.isRemoved('mystack')).toBe(true);
    // Re-reporting the same state is not a transition.
    expect(removed.record('mystack', false)).toBe(false);
    expect(removed.size).toBe(1);

    // A later run finds the Valkey still there (or the name is re-provisioned).
    expect(removed.record('mystack', true)).toBe(true);
    expect(removed.isRemoved('mystack')).toBe(false);
    expect(removed.record('mystack', true)).toBe(false);
  });

  it('forgets records for stacks that are no longer enumerated', () => {
    const removed = new RemovedStackQueues();
    removed.record('gone', false);
    removed.record('still-there', false);

    expect(removed.forgetUnlisted(['still-there', 'untouched'])).toEqual([
      'gone'
    ]);
    expect(removed.isRemoved('gone')).toBe(false);
    expect(removed.isRemoved('still-there')).toBe(true);
  });

  it('clear drops every record', () => {
    const removed = new RemovedStackQueues();
    removed.record('a', false);
    removed.record('b', false);

    removed.clear();
    expect(removed.size).toBe(0);
  });
});
