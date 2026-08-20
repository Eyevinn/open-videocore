import { describe, it, expect } from 'vitest';
import { computeStackReadiness } from './stack-readiness.js';
import {
  STACK_SERVICES,
  PACKAGER_SERVICE_ID
} from './stack.js';
import type { StackConfig } from './param-store.js';

// A base StackConfig whose services[] cover every core STACK_SERVICES role.
// Derived from STACK_SERVICES so it never drifts from the real service set.
function fullyCapableConfig(overrides: Partial<StackConfig> = {}): StackConfig {
  return {
    status: 'ready',
    minioEndpoint: 'https://minio.example.osaas.io',
    couchdbUrl: 'https://couch.example.osaas.io',
    redisUrl: 'redis://valkey.svc.cluster.local:6379',
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    services: STACK_SERVICES.map((s) => ({
      serviceId: s.serviceId,
      instanceName: 'mystack'
    })),
    ...overrides
  };
}

describe('computeStackReadiness (issue #338)', () => {
  it('reports ready for a fully capable stack (packaging available on demand)', () => {
    // The packager is deliberately NOT in services[] (on-demand design), but the
    // queue + packaged storage it depends on ARE present, so it can be
    // provisioned lazily — the stack CAN package and is therefore ready.
    const result = computeStackReadiness(fullyCapableConfig());
    expect(result.status).toBe('ready');
    expect(result.reason).toBeUndefined();
  });

  it('reports ready when the packager is already recorded in the inventory', () => {
    // After issue #335 records a successfully-created packager into services[],
    // the packaging capability is satisfied directly.
    const config = fullyCapableConfig();
    config.services = [
      ...config.services,
      { serviceId: PACKAGER_SERVICE_ID, instanceName: 'mystack' }
    ];
    const result = computeStackReadiness(config);
    expect(result.status).toBe('ready');
    expect(result.reason).toBeUndefined();
  });

  it('reports degraded packaging reason when the stack cannot package (no queue)', () => {
    // Inventory has storage + database but NO queue. The on-demand packager
    // depends on the queue, so the stack cannot package even lazily — the
    // packaging capability is the named gap.
    const config = fullyCapableConfig({
      services: STACK_SERVICES.filter((s) => s.role !== 'queue').map((s) => ({
        serviceId: s.serviceId,
        instanceName: 'mystack'
      }))
    });
    const result = computeStackReadiness(config);
    expect(result.status).toBe('degraded');
    expect(result.reason?.code).toBe('packaging_capability_missing');
    expect(result.reason?.capability).toBe('packaging');
    expect(result.status).not.toBe('ready');
  });

  it('reports packaging degraded when storage (a packager dependency) is absent', () => {
    const config = fullyCapableConfig();
    config.services = config.services.filter(
      (s) => s.serviceId !== 'minio-minio'
    );
    const result = computeStackReadiness(config);
    expect(result.status).toBe('degraded');
    expect(result.reason?.code).toBe('packaging_capability_missing');
    expect(result.reason?.capability).toBe('packaging');
  });

  it('stays ready-blocked on a missing non-packaging core capability (database)', () => {
    // Database is required for the full flow but is NOT an on-demand packager
    // dependency, so a stack missing only the database passes the packaging
    // check and is caught by the core-capability check, which names 'database'.
    const config = fullyCapableConfig({
      services: STACK_SERVICES.filter((s) => s.role !== 'database').map((s) => ({
        serviceId: s.serviceId,
        instanceName: 'mystack'
      }))
    });
    const result = computeStackReadiness(config);
    expect(result.status).toBe('degraded');
    expect(result.reason?.code).toBe('core_capability_missing');
    expect(result.reason?.capability).toBe('database');
  });

  it('reports provisioning lifecycle state with a reason', () => {
    const result = computeStackReadiness(
      fullyCapableConfig({ status: 'provisioning' })
    );
    expect(result.status).toBe('provisioning');
    expect(result.reason?.code).toBe('stack_provisioning');
  });

  it('reports failed lifecycle state with a reason', () => {
    const result = computeStackReadiness(
      fullyCapableConfig({ status: 'failed' })
    );
    expect(result.status).toBe('failed');
    expect(result.reason?.code).toBe('stack_provisioning_failed');
  });

  it('treats an absent status as ready when capable (back-compat)', () => {
    const config = fullyCapableConfig();
    delete config.status;
    const result = computeStackReadiness(config);
    expect(result.status).toBe('ready');
  });
});
