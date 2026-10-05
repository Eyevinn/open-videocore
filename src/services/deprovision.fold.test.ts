// foldTeardownResults: folding an out-of-band teardown outcome into a stack
// result and RE-AGGREGATING the stack status over the combined list (#1056).
//
// This is the mechanism that stops the on-demand packager being torn down
// "outside" the reported result. It is pure, so no OSC surface is mocked here;
// the aggregation rule it must reuse is documented on StackTeardownStatus in
// deprovision.ts:40-44 (removed | not_found | partial | failed).

import { describe, it, expect } from 'vitest';
import {
  foldTeardownResults,
  type ServiceTeardownResult,
  type StackTeardownResult
} from './deprovision.js';

const NAME = 'mystack';

function removed(serviceId: string): ServiceTeardownResult {
  return { serviceId, role: 'storage', status: 'removed' };
}

function base(services: ServiceTeardownResult[]): StackTeardownResult {
  return {
    name: NAME,
    // Deliberately the status the stack reported WITHOUT the extra outcome,
    // so a test failure shows whether re-aggregation actually happened.
    status: 'removed',
    services
  };
}

const PACKAGER = 'eyevinn-encore-packager';

describe('foldTeardownResults (issue #1056)', () => {
  it('is a no-op for an empty extra list', () => {
    const result = base([removed('minio-minio')]);
    expect(foldTeardownResults(result, [])).toBe(result);
  });

  it('turns a fully removed stack into failed when the folded outcome failed', () => {
    const folded = foldTeardownResults(
      base([removed('minio-minio'), removed('valkey-io-valkey')]),
      [
        {
          serviceId: PACKAGER,
          role: 'packaging',
          status: 'failed',
          error: 'fetch failed'
        }
      ]
    );

    // The whole point: the stack no longer reads as cleanly torn down.
    expect(folded.status).toBe('failed');
    // And the surviving instance is NAMED, not just logged.
    expect(
      folded.services.find((s) => s.serviceId === PACKAGER)
    ).toMatchObject({ status: 'failed', error: 'fetch failed' });
  });

  it('prepends the folded outcome (teardown-only consumers come first)', () => {
    const folded = foldTeardownResults(base([removed('minio-minio')]), [
      { serviceId: PACKAGER, role: 'packaging', status: 'removed' }
    ]);

    expect(folded.services.map((s) => s.serviceId)).toEqual([
      PACKAGER,
      'minio-minio'
    ]);
    expect(folded.status).toBe('removed');
  });

  it('merges onto an existing entry for the same serviceId, keeping the worst status', () => {
    // The store-less DELETE path tears the packager down twice: once via the
    // static TEARDOWN_ORDER (which contains PACKAGER_SERVICE_ID) and once via
    // the ground-truth reconciliation. One packager must be reported, not two,
    // and a failure on either attempt must win.
    const folded = foldTeardownResults(
      base([
        { serviceId: PACKAGER, role: 'packaging', status: 'not_found' },
        removed('minio-minio')
      ]),
      [
        {
          serviceId: PACKAGER,
          role: 'packaging',
          status: 'failed',
          error: 'fetch failed'
        }
      ]
    );

    expect(folded.services.filter((s) => s.serviceId === PACKAGER)).toHaveLength(
      1
    );
    expect(folded.status).toBe('failed');
  });

  it('does not downgrade an existing failed entry to a weaker folded status', () => {
    const folded = foldTeardownResults(
      base([
        {
          serviceId: PACKAGER,
          role: 'packaging',
          status: 'failed',
          error: 'boom'
        }
      ]),
      [{ serviceId: PACKAGER, role: 'packaging', status: 'not_found' }]
    );

    expect(folded.services).toHaveLength(1);
    expect(folded.services[0]?.status).toBe('failed');
    expect(folded.status).toBe('failed');
  });

  it('reports partial when the folded removal is the only removal', () => {
    const folded = foldTeardownResults(
      {
        name: NAME,
        status: 'not_found',
        services: [
          { serviceId: 'minio-minio', role: 'storage', status: 'not_found' }
        ]
      },
      [{ serviceId: PACKAGER, role: 'packaging', status: 'removed' }]
    );

    expect(folded.status).toBe('partial');
  });
});
