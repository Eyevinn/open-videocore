// A single large transcode output must be uploadable (issue #1221).
//
// An archive-class profile produces ONE multi-GB output. The encode succeeded
// every time; the upload of that output to the stack object store failed every
// time — 3 of 3 attempts, 0 files in the bucket — about 10 s after the encode
// finished, with "Acquire operation took longer than the configured maximum
// time ... cannot get a connection from the pool". A many-small-outputs profile
// on the same source, stack and object store uploaded in ~1 s, so the
// discriminator is output size: only the large output is big enough to engage
// multipart, and it engaged it with the transcoder service's default part size
// of 104 857 600 bytes.
//
// The scaler now sends an explicit part size on every spawn, so the upload
// client inside the transcoder is configured by this API rather than left on a
// default that cannot carry an archive master.
//
// Contract sources verified before writing (CLAUDE.md rule 7, fetched live
// 2026-10-16):
//   - `POST /encoreinstance` request-body property `s3MultipartMinPartsize`,
//     "(Optional) S3 multipart minimum part size in bytes", `"type": "string"`,
//     `"default": "104857600"` — the transcoder service's own live instance API
//     contract at https://api-encore.prod-se.osaas.io/docs/json (the `apiUrl`
//     published for serviceId `encore` by GET
//     https://catalog.svc.prod.osaas.io/mysubscriptions). The option is absent
//     from that catalogue entry's `availableServiceInstanceOptions`; the
//     instance API schema is what the request body is validated against.
//   - `createInstance(context, serviceId, token, body)` JSON-stringifies `body`
//     and POSTs it to `service.apiUrl` unfiltered (@osaas/client-core
//     lib/core.js:76-90, v0.24.0) — so what this test asserts about the body is
//     what the service receives.
//   - Transcoder side: `S3Properties.multipart.minimumPartSize` ->
//     `.minimumPartSizeInBytes(...)` on the credentialed upload client
//     (Eyevinn/encore v0.2.11-3, S3Properties.kt /
//     S3RemoteFilesConfiguration.kt), used by `S3RemoteFileHandler.upload()`'s
//     transfer-manager path.
//   - `spawnInstance(config, maxAttempts)` builds the create body at
//     src/encore-scaler/instance-pool.ts (the `instanceBody` block) and calls
//     `createInstance(ctx, ENCORE_SERVICE_ID, sat, instanceBody)`.
//   - S3 multipart bounds: 5 MiB minimum part size, 5 GiB maximum, 10 000 parts
//     maximum — the same bounds this repo already encodes for its own
//     browser-facing multipart upload (src/routes/asset-upload.ts:112).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createInstanceMock = vi.fn();
const getInstanceHealthMock = vi.fn(async () => 'running');
const removeInstanceMock = vi.fn(async () => undefined);
const getInstanceMock = vi.fn(async () => undefined);
const oscListInstancesMock = vi.fn(async () => [] as unknown[]);
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
    listInstances: (...args: unknown[]) => oscListInstancesMock(...args)
  };
});

import { spawnInstance, ENCORE_SERVICE_ID } from '../src/encore-scaler/instance-pool.js';
import type { EncoreScalerConfig } from '../src/encore-scaler/types.js';
import {
  DEFAULT_UPLOAD_PART_SIZE_BYTES,
  S3_MAX_PART_SIZE_BYTES,
  S3_MAX_PARTS,
  S3_MIN_PART_SIZE_BYTES,
  UPLOAD_PART_SIZE_OPTION,
  maxUploadBytesForPartSize,
  resolveUploadPartSizeBytes
} from '../src/encore-scaler/upload-part-size.js';

// The part size the transcoder service defaults to when the option is omitted —
// verbatim from the instance API schema's `"default": "104857600"`. This is the
// value #1221's uploads actually ran on, so it is what a spawn must no longer
// leave in place.
const SERVICE_DEFAULT_PART_SIZE_BYTES = 104_857_600;

// Only the commands spawnInstance's create + failure-recording path touches.
class TinyRedis {
  private strings = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }
  async set(key: string, value: string, ..._options: unknown[]): Promise<'OK'> {
    this.strings.set(key, String(value));
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async del(...keyList: string[]): Promise<number> {
    let removed = 0;
    for (const key of keyList) if (this.strings.delete(key)) removed += 1;
    return removed;
  }
  async hset(key: string, field: string, value: string): Promise<number> {
    this.hash(key).set(field, value);
    return 1;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }
  async hdel(key: string, ...fields: string[]): Promise<number> {
    let removed = 0;
    for (const field of fields) if (this.hash(key).delete(field)) removed += 1;
    return removed;
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
    workspaceId: 'ws-upload',
    maxInstances: 2,
    minInstances: 0,
    idleTimeoutMs: 10_000,
    redisUrl: 'redis://fake-valkey:6379',
    oscContext: OSC_CONTEXT_STUB,
    redis: new TinyRedis() as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'sat-test-0123456789',
    s3Config: {
      endpoint: 'http://objectstore.internal:8080',
      accessKeyId: 'stack-key',
      secretAccessKey: 'stack-secret'
    },
    spawnReadyTimeoutMs: 1_000,
    spawnReadyPollIntervalMs: 1,
    ...overrides
  };
}

// The body of the create call that targeted the transcoder service (a spawn may
// also create the paired callback listener, which is a different serviceId).
function transcoderCreateBody(): Record<string, string> | undefined {
  const call = createInstanceMock.mock.calls.find((args) => args[1] === ENCORE_SERVICE_ID);
  return call?.[3] as Record<string, string> | undefined;
}

describe('resolveUploadPartSizeBytes (issue #1221)', () => {
  it('defaults to a part size well below the service default that stranded large uploads', () => {
    expect(resolveUploadPartSizeBytes(undefined)).toBe(DEFAULT_UPLOAD_PART_SIZE_BYTES);
    expect(resolveUploadPartSizeBytes('')).toBe(DEFAULT_UPLOAD_PART_SIZE_BYTES);
    expect(resolveUploadPartSizeBytes('   ')).toBe(DEFAULT_UPLOAD_PART_SIZE_BYTES);
    expect(DEFAULT_UPLOAD_PART_SIZE_BYTES).toBeLessThan(SERVICE_DEFAULT_PART_SIZE_BYTES);
    expect(DEFAULT_UPLOAD_PART_SIZE_BYTES).toBeGreaterThanOrEqual(S3_MIN_PART_SIZE_BYTES);
  });

  it('keeps the default part count for a realistic archive master far under the 10 000-part cap', () => {
    // The reported output: a 740 MB 4K source encoded to one ~3.4 GiB file.
    const archiveOutputBytes = 3.4 * 1024 * 1024 * 1024;
    const parts = Math.ceil(archiveOutputBytes / DEFAULT_UPLOAD_PART_SIZE_BYTES);
    expect(parts).toBeLessThan(S3_MAX_PARTS);
    expect(maxUploadBytesForPartSize(DEFAULT_UPLOAD_PART_SIZE_BYTES)).toBeGreaterThan(
      archiveOutputBytes
    );
  });

  it('accepts an operator override inside the S3 part-size bounds', () => {
    const onInvalid = vi.fn();
    expect(resolveUploadPartSizeBytes(String(64 * 1024 * 1024), onInvalid)).toBe(
      64 * 1024 * 1024
    );
    expect(resolveUploadPartSizeBytes(String(S3_MIN_PART_SIZE_BYTES), onInvalid)).toBe(
      S3_MIN_PART_SIZE_BYTES
    );
    expect(resolveUploadPartSizeBytes(` ${S3_MAX_PART_SIZE_BYTES} `, onInvalid)).toBe(
      S3_MAX_PART_SIZE_BYTES
    );
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it('falls back to the default and SAYS SO on a value that cannot be a part size', () => {
    for (const bad of [
      '16MiB', // a unit suffix parseInt would silently truncate to 16 bytes
      '-1',
      '0',
      String(S3_MIN_PART_SIZE_BYTES - 1),
      String(S3_MAX_PART_SIZE_BYTES + 1),
      '1e9',
      'not-a-number'
    ]) {
      const onInvalid = vi.fn();
      expect(resolveUploadPartSizeBytes(bad, onInvalid)).toBe(DEFAULT_UPLOAD_PART_SIZE_BYTES);
      expect(onInvalid).toHaveBeenCalledTimes(1);
      expect(String(onInvalid.mock.calls[0]?.[0])).toContain(
        String(DEFAULT_UPLOAD_PART_SIZE_BYTES)
      );
    }
  });

  it('never throws, so a typo cannot stop an API that transcodes fine on the default', () => {
    expect(() => resolveUploadPartSizeBytes('garbage')).not.toThrow();
  });
});

describe('spawned transcoder output-upload configuration (issue #1221)', () => {
  beforeEach(() => {
    createInstanceMock.mockReset();
    getInstanceMock.mockReset();
    removeInstanceMock.mockReset();
    oscListInstancesMock.mockReset();
    oscListInstancesMock.mockResolvedValue([]);
    // A non-transient refusal: the create body is already built and recorded by
    // then, and failing here keeps the test to the one call under inspection
    // (no readiness polling, no listener, no dispatch).
    createInstanceMock.mockRejectedValue(new Error('refused by test'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the configured part size as the decimal-string option the service declares', async () => {
    const config = makeConfig({ uploadPartSizeBytes: DEFAULT_UPLOAD_PART_SIZE_BYTES });
    await expect(spawnInstance(config, 1)).rejects.toThrow();

    const body = transcoderCreateBody();
    expect(body).toBeDefined();
    // The option's declared type is string, not number: a JSON number would be
    // rejected by the instance API's body schema.
    expect(body?.[UPLOAD_PART_SIZE_OPTION]).toBe(String(DEFAULT_UPLOAD_PART_SIZE_BYTES));
    expect(typeof body?.[UPLOAD_PART_SIZE_OPTION]).toBe('string');
    // ...and it is NOT the service default the failing uploads ran on.
    expect(body?.[UPLOAD_PART_SIZE_OPTION]).not.toBe(String(SERVICE_DEFAULT_PART_SIZE_BYTES));
  });

  it('carries an operator override through to the create body', async () => {
    const override = 32 * 1024 * 1024;
    const config = makeConfig({ uploadPartSizeBytes: override });
    await expect(spawnInstance(config, 1)).rejects.toThrow();
    expect(transcoderCreateBody()?.[UPLOAD_PART_SIZE_OPTION]).toBe(String(override));
  });

  it('sends it independently of where the object-store credentials came from', async () => {
    // A deployment on the static env-var pair has no resolved stack config; the
    // part size is a transport tunable, not a credential, so it must still be
    // sent. (Here s3Config is absent entirely, the narrowest case.)
    const config = makeConfig({
      s3Config: undefined,
      uploadPartSizeBytes: DEFAULT_UPLOAD_PART_SIZE_BYTES
    });
    await expect(spawnInstance(config, 1)).rejects.toThrow();
    const body = transcoderCreateBody();
    expect(body?.[UPLOAD_PART_SIZE_OPTION]).toBe(String(DEFAULT_UPLOAD_PART_SIZE_BYTES));
    expect(body?.['s3Endpoint']).toBeUndefined();
  });

  it('omits the option when no part size is configured, leaving the service default', async () => {
    const config = makeConfig();
    await expect(spawnInstance(config, 1)).rejects.toThrow();
    const body = transcoderCreateBody();
    expect(body).toBeDefined();
    expect(UPLOAD_PART_SIZE_OPTION in (body ?? {})).toBe(false);
  });

  it('does not disturb the options a spawn already sets', async () => {
    const config = makeConfig({
      profilesUrl: 'https://api.example/api/v1/profiles/index.yml',
      uploadPartSizeBytes: DEFAULT_UPLOAD_PART_SIZE_BYTES
    });
    await expect(spawnInstance(config, 1)).rejects.toThrow();
    const body = transcoderCreateBody();
    expect(body?.['s3Endpoint']).toBe('http://objectstore.internal:8080');
    expect(body?.['s3AccessKeyId']).toBe('stack-key');
    expect(body?.['s3Region']).toBe('us-east-1');
    expect(body?.['profilesUrl']).toBe('https://api.example/api/v1/profiles/index.yml');
    expect(typeof body?.['name']).toBe('string');
  });
});
