// Tests for the object-store-served profile index publisher and the new
// PRIMARY `profilesUrl` tier (ADR-026 D1/D2/D3, issue #1207).
//
// Purely additive: no existing test or assertion is touched. The object-store
// client is stubbed against the `minio` v8.0.7 signatures cited in the module
// header of profile-index-publisher.ts (bucketExists / putObject /
// setBucketPolicy).

import { describe, it, expect, afterEach } from 'vitest';
import {
  PROFILES_BUCKET,
  PUBLISHED_INDEX_KEY,
  publishProfileIndex,
  publishedProfileObjectKey,
  publishedProfilesIndexUrl,
  profilesBucketAnonymousReadPolicy,
  renderPublishedProfileIndex,
  countPublishedProfileIndexEntries,
  type ProfilesBucketClient
} from './profile-index-publisher.js';
import {
  resolveEncoreProfilesUrl,
  resolveEncoreProfilesUrlWithOrigin,
  stackScopedProfilesIndexUrl
} from './public-base-url.js';

const RUNNABLE_YAML = 'name: program\nvideoEncodes:\n  - codec: libx264\n';
const GPU_YAML = 'name: gpu\nvideoEncodes:\n  - codec: h264_nvenc\n';

type Put = { bucket: string; key: string; body: string; contentType?: string };

function stubClient(opts?: { exists?: boolean; failPut?: boolean; failPolicy?: boolean }) {
  const puts: Put[] = [];
  const policies: { bucket: string; policy: string }[] = [];
  const client: ProfilesBucketClient = {
    bucketExists: async () => opts?.exists ?? true,
    putObject: async (bucket, key, body, _size, meta) => {
      if (opts?.failPut) throw new Error('put failed');
      puts.push({
        bucket,
        key,
        body: typeof body === 'string' ? body : body.toString('utf8'),
        contentType: meta?.['Content-Type']
      });
      return {};
    },
    setBucketPolicy: async (bucket, policy) => {
      if (opts?.failPolicy) throw new Error('policy failed');
      policies.push({ bucket, policy });
    }
  };
  return { client, puts, policies };
}

const ENV_KEYS = ['PUBLIC_BASE_URL', 'ENCORE_PROFILES_URL_OVERRIDE'] as const;
const savedEnv = new Map<string, string | undefined>();
afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = savedEnv.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
    savedEnv.delete(key);
  }
});
function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('published profile index rendering (ADR-026 D1)', () => {
  it('maps each runnable profile to a <name>.yml object key, sorted', () => {
    const index = renderPublishedProfileIndex([
      { name: 'zeta', yaml: RUNNABLE_YAML },
      { name: 'alpha', yaml: RUNNABLE_YAML }
    ]);
    expect(index).toBe('alpha: alpha.yml\nzeta: zeta.yml\n');
  });

  it('excludes GPU-only profiles, as the app-served index does (#286)', () => {
    const index = renderPublishedProfileIndex([
      { name: 'cpu', yaml: RUNNABLE_YAML },
      { name: 'gpu', yaml: GPU_YAML }
    ]);
    expect(index).toBe('cpu: cpu.yml\n');
  });

  it('renders an empty store as the empty YAML mapping (#459 shape)', () => {
    expect(renderPublishedProfileIndex([])).toBe('{}\n');
  });

  it('keys per-profile documents as <name>.yml', () => {
    expect(publishedProfileObjectKey('program')).toBe('program.yml');
  });
});

describe('published index URL', () => {
  it('is <endpoint>/<bucket>/index.yml with a trailing slash normalised away', () => {
    expect(publishedProfilesIndexUrl('https://minio.example.com/')).toBe(
      `https://minio.example.com/${PROFILES_BUCKET}/${PUBLISHED_INDEX_KEY}`
    );
  });

  it('supports the in-cluster http form (ADR-026 D2 step 1)', () => {
    expect(
      publishedProfilesIndexUrl('http://stack.minio-minio.svc.cluster.local:8080')
    ).toBe(
      `http://stack.minio-minio.svc.cluster.local:8080/${PROFILES_BUCKET}/${PUBLISHED_INDEX_KEY}`
    );
  });

  it('returns undefined rather than throwing for an absent or unusable endpoint', () => {
    expect(publishedProfilesIndexUrl(undefined)).toBeUndefined();
    expect(publishedProfilesIndexUrl('')).toBeUndefined();
    expect(publishedProfilesIndexUrl('not a url')).toBeUndefined();
    expect(publishedProfilesIndexUrl('s3://bucket')).toBeUndefined();
  });
});

describe('anonymous-read bucket policy (ADR-026 D3)', () => {
  it('grants only s3:GetObject to * on the profiles bucket prefix', () => {
    const policy = JSON.parse(profilesBucketAnonymousReadPolicy());
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0]).toEqual({
      Effect: 'Allow',
      Principal: { AWS: ['*'] },
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${PROFILES_BUCKET}/*`]
    });
    // No ListBucket and no write: readable by exact key, not browsable.
    expect(JSON.stringify(policy)).not.toContain('ListBucket');
    expect(JSON.stringify(policy)).not.toContain('PutObject');
  });
});

describe('publishProfileIndex', () => {
  it('publishes per-profile objects AND the index, and reports the URL', async () => {
    const { client, puts, policies } = stubClient();
    const outcome = await publishProfileIndex({
      storageClient: client,
      objectStoreEndpoint: 'https://minio.example.com',
      listProfiles: async () => [
        { name: 'program', yaml: RUNNABLE_YAML },
        { name: 'gpu', yaml: GPU_YAML }
      ]
    });
    expect(outcome).toMatchObject({
      ok: true,
      bucket: PROFILES_BUCKET,
      profileCount: 1,
      endpointKind: 'public',
      indexUrl: `https://minio.example.com/${PROFILES_BUCKET}/${PUBLISHED_INDEX_KEY}`
    });
    // Per-profile object first, index last, so the index never names a missing
    // object. GPU-only profile is not published.
    expect(puts.map((p) => p.key)).toEqual(['program.yml', PUBLISHED_INDEX_KEY]);
    expect(puts[0]?.body).toBe(RUNNABLE_YAML);
    expect(puts[0]?.contentType).toBe('text/yaml; charset=utf-8');
    expect(puts[1]?.body).toBe('program: program.yml\n');
    expect(policies).toHaveLength(1);
    expect(policies[0]?.bucket).toBe(PROFILES_BUCKET);
  });

  it('prefers the probed in-cluster endpoint for the published URL (D2 step 1)', async () => {
    const { client } = stubClient();
    const outcome = await publishProfileIndex({
      storageClient: client,
      objectStoreEndpoint: 'https://minio.example.com',
      resolveEndpoint: async () => 'http://stack.minio-minio.svc.cluster.local:8080',
      listProfiles: async () => [{ name: 'program', yaml: RUNNABLE_YAML }]
    });
    expect(outcome).toMatchObject({
      ok: true,
      endpointKind: 'in-cluster',
      indexUrl: `http://stack.minio-minio.svc.cluster.local:8080/${PROFILES_BUCKET}/${PUBLISHED_INDEX_KEY}`
    });
  });

  it('falls back to the public endpoint when the in-cluster seam fails soft', async () => {
    const { client } = stubClient();
    const outcome = await publishProfileIndex({
      storageClient: client,
      objectStoreEndpoint: 'https://minio.example.com',
      resolveEndpoint: async () => {
        throw new Error('probe exploded');
      },
      listProfiles: async () => [{ name: 'program', yaml: RUNNABLE_YAML }]
    });
    expect(outcome).toMatchObject({ ok: true, endpointKind: 'public' });
  });

  it('reports bucket-missing without creating the bucket (provisioning is #1208)', async () => {
    const { client, puts } = stubClient({ exists: false });
    const outcome = await publishProfileIndex({
      storageClient: client,
      objectStoreEndpoint: 'https://minio.example.com',
      listProfiles: async () => [{ name: 'program', yaml: RUNNABLE_YAML }]
    });
    expect(outcome).toEqual({ ok: false, reason: 'bucket-missing', bucket: PROFILES_BUCKET });
    expect(puts).toEqual([]);
  });

  it('reports no-object-store for the env-override / in-memory paths', async () => {
    const { client } = stubClient();
    await expect(
      publishProfileIndex({
        storageClient: undefined,
        objectStoreEndpoint: 'https://minio.example.com',
        listProfiles: async () => []
      })
    ).resolves.toEqual({ ok: false, reason: 'no-object-store' });
    await expect(
      publishProfileIndex({
        storageClient: client,
        objectStoreEndpoint: undefined,
        listProfiles: async () => []
      })
    ).resolves.toEqual({ ok: false, reason: 'no-object-store' });
  });

  it('never throws on a write failure; reports write-failed', async () => {
    const { client } = stubClient({ failPut: true });
    const outcome = await publishProfileIndex({
      storageClient: client,
      objectStoreEndpoint: 'https://minio.example.com',
      listProfiles: async () => [{ name: 'program', yaml: RUNNABLE_YAML }]
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'write-failed' });
  });

  it('still succeeds when the best-effort policy re-assertion fails', async () => {
    const { client } = stubClient({ failPolicy: true });
    const outcome = await publishProfileIndex({
      storageClient: client,
      objectStoreEndpoint: 'https://minio.example.com',
      listProfiles: async () => [{ name: 'program', yaml: RUNNABLE_YAML }]
    });
    expect(outcome).toMatchObject({ ok: true, profileCount: 1 });
  });
});

describe('resolveEncoreProfilesUrlWithOrigin tier order (ADR-026 D2)', () => {
  const PUBLISHED = `https://minio.example.com/${PROFILES_BUCKET}/${PUBLISHED_INDEX_KEY}`;

  it('puts the published object-store index ABOVE the derived app path', () => {
    setEnv('ENCORE_PROFILES_URL_OVERRIDE', undefined);
    setEnv('PUBLIC_BASE_URL', 'https://app.example.com');
    expect(resolveEncoreProfilesUrlWithOrigin('https://remote/profiles.yml', undefined, PUBLISHED)).toEqual({
      url: PUBLISHED,
      origin: 'object-store'
    });
  });

  it('keeps ENCORE_PROFILES_URL_OVERRIDE as tier 1', () => {
    setEnv('ENCORE_PROFILES_URL_OVERRIDE', 'https://override.example.com/index.yml');
    setEnv('PUBLIC_BASE_URL', 'https://app.example.com');
    expect(resolveEncoreProfilesUrlWithOrigin('https://remote/profiles.yml', undefined, PUBLISHED)).toEqual({
      url: 'https://override.example.com/index.yml',
      origin: 'override'
    });
  });

  it('falls back to the derived app path when nothing is published', () => {
    setEnv('ENCORE_PROFILES_URL_OVERRIDE', undefined);
    setEnv('PUBLIC_BASE_URL', 'https://app.example.com');
    expect(resolveEncoreProfilesUrlWithOrigin('https://remote/profiles.yml')).toEqual({
      url: 'https://app.example.com/api/v1/profiles/index.yml',
      origin: 'app-path'
    });
  });

  it('falls back to the parameter-store URL, then the remote default', () => {
    setEnv('ENCORE_PROFILES_URL_OVERRIDE', undefined);
    setEnv('PUBLIC_BASE_URL', undefined);
    expect(
      resolveEncoreProfilesUrlWithOrigin('https://remote/profiles.yml', 'https://stored/index.yml')
    ).toEqual({ url: 'https://stored/index.yml', origin: 'param-store' });
    expect(resolveEncoreProfilesUrlWithOrigin('https://remote/profiles.yml')).toEqual({
      url: 'https://remote/profiles.yml',
      origin: 'remote-default'
    });
  });

  it('string-returning resolveEncoreProfilesUrl agrees with the tier-reporting form', () => {
    setEnv('ENCORE_PROFILES_URL_OVERRIDE', undefined);
    setEnv('PUBLIC_BASE_URL', 'https://app.example.com');
    expect(resolveEncoreProfilesUrl('https://remote/profiles.yml', undefined, PUBLISHED)).toBe(PUBLISHED);
    // No published URL supplied => byte-identical to the pre-ADR-026 behaviour.
    expect(resolveEncoreProfilesUrl('https://remote/profiles.yml')).toBe(
      'https://app.example.com/api/v1/profiles/index.yml'
    );
  });

  it('leaves a published bucket URL unscoped by the stack-scoping rewrite (#1164)', () => {
    expect(stackScopedProfilesIndexUrl(PUBLISHED, 'mystack')).toBe(PUBLISHED);
  });
});

// The index COUNTER used by the boot-time publish verification (ADR-026 D4,
// issue #1209). It is the inverse of renderPublishedProfileIndex, so the two are
// tested as a round trip: whatever the publisher writes, the probe must count
// back to the same number the publisher reported — otherwise the verification
// would raise false "stale bucket" alarms (or miss real ones).
describe('countPublishedProfileIndexEntries (ADR-026 D4, issue #1209)', () => {
  it('round-trips the rendered index: counted entries == published profile count', () => {
    const profiles = [
      { name: 'b', yaml: RUNNABLE_YAML },
      { name: 'a', yaml: RUNNABLE_YAML },
      // Filtered out of the index by isProfileRunnable (#286), so it must NOT be
      // counted — this is exactly the number PublishOutcome.profileCount carries.
      { name: 'gpu', yaml: GPU_YAML }
    ];
    const body = renderPublishedProfileIndex(profiles);
    expect(countPublishedProfileIndexEntries(body)).toBe(2);
  });

  it('counts the empty-store body ({}, issue #459) as zero', () => {
    expect(countPublishedProfileIndexEntries(renderPublishedProfileIndex([]))).toBe(0);
    expect(countPublishedProfileIndexEntries('{}\n')).toBe(0);
    expect(countPublishedProfileIndexEntries('')).toBe(0);
  });

  it('ignores blank lines and a missing trailing newline', () => {
    expect(countPublishedProfileIndexEntries('a: a.yml\n\nb: b.yml')).toBe(2);
  });
});
