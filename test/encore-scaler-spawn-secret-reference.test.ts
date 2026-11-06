// The scaler spawn path must send the object store's SECRET access key as an
// OSC per-service secret REFERENCE, never as a literal create-instance
// parameter (issue #1287).
//
// Before this, `spawnInstance` put `s3SecretAccessKey: <literal>` straight into
// the transcoder's create body, while the provisioning path for the very same
// credential already saved it with `saveSecret` and sent
// `{{secrets.<name>}}`. The literal therefore lived on in the instance
// configuration of every scaler-spawned instance.
//
// CONTRACT SOURCES (verified before writing, CLAUDE.md rule 7):
//   - saveSecret(serviceId, name, value, ctx): Promise<void> —
//     @osaas/client-core lib/core.d.ts:154 (also re-exported from lib/index.d.ts:6).
//   - createInstance(context, serviceId, token, body): Promise<any> —
//     @osaas/client-core lib/core.d.ts:32; the body is argument index 3, which is
//     what transcoderCreateBody() below reads.
//   - Encore's field names and WHICH of them are secret come from
//     `encoreCredentialMapping` (src/services/external-storage-credentials.ts:89-116):
//     config fields `s3AccessKeyId` / `s3Region` / `s3Endpoint`; secrets
//     `s3SecretAccessKey` (purpose `<rolePurpose>.s3secretaccesskey`) and
//     `s3SessionToken` when a session token is present.
//   - The reference form and the `<name>.<purpose>` secret-naming convention are
//     the provisioning path's: src/routes/provision.ts:1366-1373 (`secretRef`:
//     `${name}.${purpose}` + `{{secrets.${secretName}}}`), applied for the
//     per-stack object store at provision.ts:1900-1912 with purpose
//     `objectstore` (provision.ts:892). The same pattern appears at
//     src/routes/optional-services.ts:256-268.
//   - ENCORE_SERVICE_ID ('encore') — src/encore-scaler/instance-pool.ts:66,
//     matching EXTERNAL_STORAGE_SERVICE_IDS.encore
//     (src/services/external-storage-credentials.ts:186-190).
//   - EncoreS3Config { endpoint, accessKeyId, secretAccessKey, region? } —
//     src/encore-scaler/types.ts:24-35 (no session token field exists today).
//   - spawnInstance(config, maxAttempts = 3) and
//     forgetEncoreS3CreateFields(workspaceId?) —
//     src/encore-scaler/instance-pool.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const createInstanceMock = vi.fn();
const getInstanceHealthMock = vi.fn(async () => 'running');
const removeInstanceMock = vi.fn(async () => undefined);
const getInstanceMock = vi.fn(async () => undefined);
const oscListInstancesMock = vi.fn(async () => [] as unknown[]);
const saveSecretMock = vi.fn(async () => undefined);
vi.mock('@osaas/client-core', async () => {
  const actual = await vi.importActual<typeof import('@osaas/client-core')>(
    '@osaas/client-core'
  );
  return {
    ...actual,
    createInstance: (...args: unknown[]) => createInstanceMock(...args),
    getInstance: (...args: unknown[]) => getInstanceMock(...args),
    getInstanceHealth: (...args: unknown[]) => getInstanceHealthMock(...args),
    removeInstance: (...args: unknown[]) => removeInstanceMock(...args),
    listInstances: (...args: unknown[]) => oscListInstancesMock(...args),
    saveSecret: (...args: unknown[]) => saveSecretMock(...(args as []))
  };
});

import {
  ENCORE_SERVICE_ID,
  forgetEncoreS3CreateFields,
  spawnInstance
} from '../src/encore-scaler/instance-pool.js';
import type { EncoreScalerConfig } from '../src/encore-scaler/types.js';

const WORKSPACE = 'wssecretref';
const STORE_SECRET = 'object-store-secret-must-not-be-sent-0001';
const STORE_KEY_ID = 'object-store-key-id';

// In-memory Valkey covering only what the spawn path (and its failure
// bookkeeping) touches.
class TinyRedis {
  private hashes = new Map<string, Map<string, string>>();
  private strings = new Map<string, string>();

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hash(key));
  }
  async hset(key: string, field: string, value: string): Promise<number> {
    this.hash(key).set(field, value);
    return 1;
  }
  async hdel(key: string, ...fields: string[]): Promise<number> {
    let removed = 0;
    for (const f of fields) if (this.hash(key).delete(f)) removed += 1;
    return removed;
  }
  async del(key: string): Promise<number> {
    const had = this.hashes.delete(key) || this.strings.delete(key);
    return had ? 1 : 0;
  }
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }
  async pexpire(): Promise<number> {
    return 1;
  }
}

const OSC_CONTEXT_STUB = {
  getServiceAccessToken: async () => 'sat-test-0123456789'
} as unknown as EncoreScalerConfig['oscContext'];

function makeConfig(overrides: Partial<EncoreScalerConfig> = {}): EncoreScalerConfig {
  return {
    workspaceId: WORKSPACE,
    maxInstances: 2,
    minInstances: 0,
    idleTimeoutMs: 10_000,
    redisUrl: 'redis://fake-valkey:6379',
    oscContext: OSC_CONTEXT_STUB,
    redis: new TinyRedis() as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'sat-test-0123456789',
    s3Config: {
      endpoint: 'https://objectstore.example',
      accessKeyId: STORE_KEY_ID,
      secretAccessKey: STORE_SECRET
    },
    spawnReadyTimeoutMs: 1_000,
    spawnReadyPollIntervalMs: 1,
    ...overrides
  };
}

// The body of the create call that targeted the transcoder service. A spawn may
// also create the paired callback listener, which is a different serviceId.
function transcoderCreateBody(): Record<string, string> | undefined {
  const call = createInstanceMock.mock.calls.find(
    (args) => args[1] === ENCORE_SERVICE_ID
  );
  return call?.[3] as Record<string, string> | undefined;
}

describe('scaler spawn sends the object-store secret as an OSC secret reference (#1287)', () => {
  beforeEach(() => {
    createInstanceMock.mockReset();
    getInstanceMock.mockReset();
    getInstanceMock.mockResolvedValue(undefined);
    getInstanceHealthMock.mockReset();
    getInstanceHealthMock.mockResolvedValue('running');
    removeInstanceMock.mockReset();
    removeInstanceMock.mockResolvedValue(undefined);
    oscListInstancesMock.mockReset();
    oscListInstancesMock.mockResolvedValue([]);
    saveSecretMock.mockReset();
    saveSecretMock.mockResolvedValue(undefined);
    // The per-workspace secret cache is module state; each test starts from a
    // workspace that has never had its secret written.
    forgetEncoreS3CreateFields();
    // A non-transient refusal: the create body is already built and recorded by
    // then, and failing there keeps each test to the one call under inspection
    // (no readiness polling, no listener, no dispatch).
    createInstanceMock.mockRejectedValue(new Error('refused by test'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('puts a {{secrets.<name>}} reference in the create body and the literal only in saveSecret', async () => {
    await expect(spawnInstance(makeConfig(), 1)).rejects.toThrow();

    const body = transcoderCreateBody();
    expect(body).toBeDefined();

    // The secret field carries a reference, built from the same
    // `<name>.<purpose>` convention the provisioning path uses.
    const expectedSecretName = `${WORKSPACE}.objectstore.s3secretaccesskey`;
    expect(body?.['s3SecretAccessKey']).toBe(`{{secrets.${expectedSecretName}}}`);

    // ...and the literal appears NOWHERE in the create body, under any field
    // name or nested in a URL-shaped value.
    expect(JSON.stringify(body)).not.toContain(STORE_SECRET);

    // The literal went to the OSC secret store instead, scoped to the
    // transcoder's serviceId.
    expect(saveSecretMock).toHaveBeenCalledWith(
      ENCORE_SERVICE_ID,
      expectedSecretName,
      STORE_SECRET,
      OSC_CONTEXT_STUB
    );

    // The non-secret coordinates stay plain config fields, exactly as
    // encoreCredentialMapping spells them.
    expect(body?.['s3AccessKeyId']).toBe(STORE_KEY_ID);
    expect(body?.['s3Endpoint']).toBe('https://objectstore.example');
    expect(body?.['s3Region']).toBe('us-east-1');
  });

  it('writes the secret once per workspace and reuses the same reference on the next spawn', async () => {
    const config = makeConfig();

    await expect(spawnInstance(config, 1)).rejects.toThrow();
    const firstBody = transcoderCreateBody();
    const writesAfterFirstSpawn = saveSecretMock.mock.calls.length;
    expect(writesAfterFirstSpawn).toBe(1);

    createInstanceMock.mockClear();
    await expect(spawnInstance(config, 1)).rejects.toThrow();
    const secondBody = transcoderCreateBody();

    // No second write: the secret already exists under this workspace's name.
    expect(saveSecretMock.mock.calls.length).toBe(writesAfterFirstSpawn);
    // And the second spawn sends the identical reference, not a new name and
    // not the literal.
    expect(secondBody?.['s3SecretAccessKey']).toBe(firstBody?.['s3SecretAccessKey']);
    expect(secondBody?.['s3SecretAccessKey']).toBe(
      `{{secrets.${WORKSPACE}.objectstore.s3secretaccesskey}}`
    );
    expect(JSON.stringify(secondBody)).not.toContain(STORE_SECRET);
  });

  it('leaves a spawn with no object-store config untouched: no secret write, no s3 fields', async () => {
    await expect(
      spawnInstance(makeConfig({ s3Config: undefined }), 1)
    ).rejects.toThrow();

    const body = transcoderCreateBody();
    expect(body).toBeDefined();
    expect(saveSecretMock).not.toHaveBeenCalled();
    expect('s3SecretAccessKey' in (body ?? {})).toBe(false);
    expect('s3AccessKeyId' in (body ?? {})).toBe(false);
    expect('s3Endpoint' in (body ?? {})).toBe(false);
    expect('s3Region' in (body ?? {})).toBe(false);
    expect(typeof body?.['name']).toBe('string');
  });

  it('re-writes the secret under the same name when the resolved credential is rotated', async () => {
    await expect(spawnInstance(makeConfig(), 1)).rejects.toThrow();
    expect(saveSecretMock.mock.calls.length).toBe(1);

    const rotated = 'object-store-secret-rotated-0002';
    await expect(
      spawnInstance(
        makeConfig({
          s3Config: {
            endpoint: 'https://objectstore.example',
            accessKeyId: STORE_KEY_ID,
            secretAccessKey: rotated
          }
        }),
        1
      )
    ).rejects.toThrow();

    // A rotated credential must not keep serving the previous value's
    // reference: the same deterministic name is written again with the new
    // value, and no literal reaches the body either way.
    expect(saveSecretMock.mock.calls.length).toBe(2);
    expect(saveSecretMock).toHaveBeenLastCalledWith(
      ENCORE_SERVICE_ID,
      `${WORKSPACE}.objectstore.s3secretaccesskey`,
      rotated,
      OSC_CONTEXT_STUB
    );
    expect(JSON.stringify(transcoderCreateBody())).not.toContain(rotated);
  });

  // #1287 REVIEW FINDING (head 05cd97fb). The provisioning path already mints
  // `${stackName}.objectstore.s3secretaccesskey` for serviceId 'encore'
  // (src/routes/provision.ts, applyCredentialMapping over
  // encoreCredentialMapping(objectStoreCreds, OBJECT_STORE)), and OSC service
  // secrets are write-once with no update path and no read-back
  // (docs/architecture/ADR-002-credential-storage.md:46,48,155,174; the pinned
  // @osaas/client-core 0.24.0 `saveSecret` is a bare POST to
  // /mysecrets/<serviceId> that rejects on any non-2xx — lib/core.d.ts:154,
  // lib/core.js:355-369, no PUT/update/delete counterpart). So when the stack's
  // resolved config carries that pre-minted name as
  // `EncoreS3Config.secretAccessKeyRef` (set by
  // src/services/encore-s3-config.ts resolveEncoreS3Config), the spawn path
  // must REFERENCE it and write nothing.
  it('references the pre-minted secret name without writing it when the resolved config carries one', async () => {
    const preMinted = `${WORKSPACE}.objectstore.s3secretaccesskey`;
    await expect(
      spawnInstance(
        makeConfig({
          s3Config: {
            endpoint: 'https://objectstore.example',
            accessKeyId: STORE_KEY_ID,
            secretAccessKey: STORE_SECRET,
            secretAccessKeyRef: preMinted
          }
        }),
        1
      )
    ).rejects.toThrow();

    const body = transcoderCreateBody();
    expect(body?.['s3SecretAccessKey']).toBe(`{{secrets.${preMinted}}}`);
    // No POST on a name that already exists: nothing was written at all.
    expect(saveSecretMock).not.toHaveBeenCalled();
    // And the literal is still absent from the create body.
    expect(JSON.stringify(body)).not.toContain(STORE_SECRET);
    expect(body?.['s3AccessKeyId']).toBe(STORE_KEY_ID);
  });

  // FAIL CLOSED. For a credential with no pre-minted secret the scaler still
  // owns the write, and a rejected write must fail the spawn rather than fall
  // back to sending the literal.
  it('fails the spawn closed when the secret write rejects, never falling back to the literal', async () => {
    const writeFailure = new Error('osc refused the secret write');
    saveSecretMock.mockRejectedValue(writeFailure);
    // Let createInstance succeed if it were ever reached, so the only thing
    // that can fail this spawn is the secret write itself.
    createInstanceMock.mockResolvedValue({ name: 'should-never-be-created' });

    await expect(spawnInstance(makeConfig(), 1)).rejects.toThrow(
      'osc refused the secret write'
    );

    // The transcoder was never created — not with the literal, not with a
    // reference to a secret that does not exist.
    expect(transcoderCreateBody()).toBeUndefined();
    const everySentArg = JSON.stringify(createInstanceMock.mock.calls);
    expect(everySentArg).not.toContain(STORE_SECRET);

    // A later spawn retries the write rather than serving a cached field set
    // built from a failed one.
    saveSecretMock.mockResolvedValue(undefined);
    createInstanceMock.mockRejectedValue(new Error('refused by test'));
    await expect(spawnInstance(makeConfig(), 1)).rejects.toThrow();
    expect(transcoderCreateBody()?.['s3SecretAccessKey']).toBe(
      `{{secrets.${WORKSPACE}.objectstore.s3secretaccesskey}}`
    );
  });
});
