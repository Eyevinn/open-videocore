// On-demand packager provisioning error-surfacing + inventory-recording tests
// (issue #335).
//
// Regression coverage for the silent-failure bug: on the affected tenant the
// on-demand packager path never created a packager instance, no error was
// raised, and nothing was logged, so packaging hung invisibly. These tests pin
// the fixed contract of ensurePackagerProvisioned:
//   - a createInstance failure is logged (attempt + failure) with the stack name
//     and RETHROWN so the caller's package step can transition to `failed`
//   - a readiness-wait failure is logged and rethrown for the same reason
//   - a successful create logs attempt + ready and records the packager in the
//     stack service inventory via recordInInventory
//   - a reused ('exists') instance does NOT re-record the inventory
//   - an inventory-recording failure is surfaced (rethrown), never swallowed

import { describe, it, expect, vi } from 'vitest';
import {
  ensurePackagerProvisioned,
  type PackagerOscApi,
  type EnsurePackagerDeps
} from '../src/services/packager-provisioning.js';
import { PACKAGER_SERVICE_ID } from '../src/services/stack.js';

// Minimal fake OSC surface. Each method is a vi.fn so tests can assert call
// order / arguments and inject failures. Defaults describe the happy path
// (no existing instance, create + wait succeed).
function makeOscApi(overrides: Partial<PackagerOscApi> = {}): PackagerOscApi {
  return {
    getServiceAccessToken: vi.fn(async () => 'sat-token'),
    getInstance: vi.fn(async () => undefined),
    createInstance: vi.fn(async () => ({ name: 'stack-1' })),
    waitForInstanceReady: vi.fn(async () => undefined),
    saveSecret: vi.fn(async () => undefined),
    removeInstance: vi.fn(async () => undefined),
    ...overrides
  };
}

function makeLog() {
  return { info: vi.fn(), error: vi.fn() };
}

function baseDeps(osc: PackagerOscApi): EnsurePackagerDeps {
  return {
    osc,
    coords: {
      stackName: 'stack-1',
      redisUrl: 'redis://valkey:6379',
      minioEndpoint: 'https://minio.example',
      packagedBucket: 'openvideocore-packaged'
    },
    secrets: {
      minioRootPassword: 'rootpw',
      oscPersonalAccessToken: 'pat'
    }
  };
}

describe('ensurePackagerProvisioned error surfacing (issue #335)', () => {
  it('rethrows createInstance failure and logs it with the stack name', async () => {
    const osc = makeOscApi({
      createInstance: vi.fn(async () => {
        throw new Error('OSC create rejected: quota exceeded');
      })
    });
    const log = makeLog();

    await expect(
      ensurePackagerProvisioned({ ...baseDeps(osc), log })
    ).rejects.toThrow(/quota exceeded/);

    // Attempt phase logged before create.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'stack-1', serviceId: PACKAGER_SERVICE_ID }),
      expect.stringContaining('creating instance')
    );
    // Failure phase logged with the stack name and the cause.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        stackName: 'stack-1',
        phase: 'create',
        error: expect.stringContaining('quota exceeded')
      }),
      expect.any(String)
    );
    // Never falsely reported ready.
    expect(log.info).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('ready')
    );
  });

  it('rethrows a readiness-wait failure and logs it (readiness timeout path)', async () => {
    const osc = makeOscApi({
      waitForInstanceReady: vi.fn(async () => {
        throw new Error('readiness timeout after 300s');
      })
    });
    const log = makeLog();

    await expect(
      ensurePackagerProvisioned({ ...baseDeps(osc), log })
    ).rejects.toThrow(/readiness timeout/);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'stack-1', phase: 'ready' }),
      expect.any(String)
    );
  });

  it('treats an "already taken" create error as an existing instance (no throw)', async () => {
    const osc = makeOscApi({
      createInstance: vi.fn(async () => {
        throw new Error('instance name already taken');
      })
    });

    const result = await ensurePackagerProvisioned(baseDeps(osc));
    expect(result).toEqual({ status: 'exists', instanceName: 'stack-1' });
  });
});

describe('ensurePackagerProvisioned inventory recording (issue #335)', () => {
  it('records the packager in the inventory after a successful create', async () => {
    const osc = makeOscApi();
    const log = makeLog();
    const recordInInventory = vi.fn(async () => undefined);

    const result = await ensurePackagerProvisioned({
      ...baseDeps(osc),
      log,
      recordInInventory
    });

    expect(result).toEqual({ status: 'created', instanceName: 'stack-1' });
    // Inventory recorded exactly once, with the created instance name.
    expect(recordInInventory).toHaveBeenCalledTimes(1);
    expect(recordInInventory).toHaveBeenCalledWith('stack-1');
    // Ready phase logged.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'stack-1' }),
      expect.stringContaining('ready')
    );
  });

  it('does NOT record inventory when the packager already exists (reused)', async () => {
    const osc = makeOscApi({
      getInstance: vi.fn(async () => ({ name: 'stack-1' }))
    });
    const recordInInventory = vi.fn(async () => undefined);

    const result = await ensurePackagerProvisioned({
      ...baseDeps(osc),
      recordInInventory
    });

    expect(result).toEqual({ status: 'exists', instanceName: 'stack-1' });
    expect(recordInInventory).not.toHaveBeenCalled();
    expect(osc.createInstance).not.toHaveBeenCalled();
  });

  it('surfaces (rethrows) an inventory-recording failure rather than swallowing it', async () => {
    const osc = makeOscApi();
    const log = makeLog();
    const recordInInventory = vi.fn(async () => {
      throw new Error('parameter store write failed: 503');
    });

    await expect(
      ensurePackagerProvisioned({ ...baseDeps(osc), log, recordInInventory })
    ).rejects.toThrow(/parameter store write failed/);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'stack-1', phase: 'record-inventory' }),
      expect.any(String)
    );
  });
});
