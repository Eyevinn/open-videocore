// The on-demand packager writes with the STACK's object-store credential
// (issue #1094).
//
// The packager writes packaged output into the stack's object store, so when a
// stack's object store is created with its own credential (replacing the former
// process-global root pair) the packager must be provisioned with THAT
// credential — otherwise every packaging job on a migrated stack fails to write.
// Coverage:
//   - the create body carries the stack's access key id and a {{secrets.*}}
//     REFERENCE for the secret (never the literal);
//   - the secret saved under the packager's serviceId is the stack's secret;
//   - a stack provisioned before #1094 keeps the legacy pair unchanged.
//
// Contract sources (CLAUDE.md rule 7):
//   - saveSecret(serviceId, name, value, ctx) — @osaas/client-core
//     lib/core.d.ts:154, adapted as PackagerOscApi.saveSecret(serviceId, name,
//     value) in src/services/packager-provisioning.ts.
//   - The packager create-body field set (RedisUrl / RedisQueue / OutputFolder /
//     PersonalAccessToken / AwsAccessKeyId / AwsSecretAccessKey / S3EndpointUrl
//     / CallbackUrl) — src/services/packager-provisioning.ts header, carried
//     over verbatim from the contract-verified eager provisioning path.

import { describe, it, expect, vi } from 'vitest';
import {
  buildPackagerCreateBody,
  ensurePackagerProvisioned,
  PACKAGER_ROOTPASSWORD_PURPOSE,
  type PackagerOscApi
} from '../src/services/packager-provisioning.js';
import { PACKAGER_SERVICE_ID } from '../src/services/stack.js';
import {
  LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
  deriveObjectStoreCredential
} from '../src/services/object-store-credentials.js';

const SEED = 'deployment-wide-object-store-password';
const CRED = deriveObjectStoreCredential(SEED, 'stack-1');

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

const coords = {
  stackName: 'stack-1',
  redisUrl: 'redis://queue:6379',
  minioEndpoint: 'https://stack-1-objectstore.example.test',
  packagedBucket: 'openvideocore-packaged'
};

describe('packager object-store credential (issue #1094)', () => {
  it('puts the stack access key id in the create body, with a reference for the secret', () => {
    const body = buildPackagerCreateBody(
      { ...coords, objectStoreAccessKeyId: CRED.accessKeyId },
      { patRef: '{{secrets.stack-1.pat}}', s3SecretRef: '{{secrets.stack-1.rootpassword}}' }
    );

    expect(body['AwsAccessKeyId']).toBe(CRED.accessKeyId);
    expect(body['AwsSecretAccessKey']).toBe('{{secrets.stack-1.rootpassword}}');
    expect(JSON.stringify(body)).not.toContain(CRED.secretAccessKey);
    expect(JSON.stringify(body)).not.toContain(SEED);
  });

  it('keeps the legacy root user for a stack provisioned before #1094', () => {
    const body = buildPackagerCreateBody(coords, {
      patRef: '{{secrets.stack-1.pat}}',
      s3SecretRef: '{{secrets.stack-1.rootpassword}}'
    });
    expect(body['AwsAccessKeyId']).toBe(LEGACY_OBJECT_STORE_ACCESS_KEY_ID);
  });

  it("saves the stack's own secret for the packager, not the deployment-wide one", async () => {
    const osc = makeOscApi();
    await ensurePackagerProvisioned({
      osc,
      coords: { ...coords, objectStoreAccessKeyId: CRED.accessKeyId },
      secrets: {
        minioRootPassword: SEED,
        objectStoreSecretAccessKey: CRED.secretAccessKey,
        oscPersonalAccessToken: 'pat'
      },
      waitForReady: false
    });

    expect(osc.saveSecret).toHaveBeenCalledWith(
      PACKAGER_SERVICE_ID,
      `stack-1.${PACKAGER_ROOTPASSWORD_PURPOSE}`,
      CRED.secretAccessKey
    );
    const createBody = (osc.createInstance as ReturnType<typeof vi.fn>).mock
      .calls[0]![2] as Record<string, unknown>;
    expect(createBody['AwsAccessKeyId']).toBe(CRED.accessKeyId);
    expect(JSON.stringify(createBody)).not.toContain(CRED.secretAccessKey);
  });

  it('falls back to the deployment-wide secret when no per-stack one is supplied', async () => {
    const osc = makeOscApi();
    await ensurePackagerProvisioned({
      osc,
      coords,
      secrets: { minioRootPassword: SEED, oscPersonalAccessToken: 'pat' },
      waitForReady: false
    });

    expect(osc.saveSecret).toHaveBeenCalledWith(
      PACKAGER_SERVICE_ID,
      `stack-1.${PACKAGER_ROOTPASSWORD_PURPOSE}`,
      SEED
    );
  });
});
