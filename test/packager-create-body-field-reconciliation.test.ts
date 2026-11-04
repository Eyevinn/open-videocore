// Static reconciliation of the eyevinn-encore-packager create body
// (issue #1263 part 4).
//
// WHAT THIS IS, AND WHAT IT IS NOT
// --------------------------------
// Issue #1263 asks for `get-service-schema` to be called for
// eyevinn-encore-packager and `buildPackagerCreateBody()`
// (src/services/packager-provisioning.ts:139-158) reconciled against it. The
// live OSC MCP tool is NOT reachable from the context this was written in (no
// OSC MCP tools, no OSC token), so NO field name here is taken from a live
// schema and none is invented (CLAUDE.md rule 7: guessing is not allowed, and
// the remaining blocker is named in the PR body and in
// docs/osc-feedback/incoming-1263-packager-schema-reverification.md).
//
// What IS verified is a STATIC cross-check between the two independent in-repo
// code paths that each name this service's create-body fields, which until now
// could drift from one another silently:
//   - `buildPackagerCreateBody()` — src/services/packager-provisioning.ts:139,
//     the on-demand provisioning body (field set inherited verbatim from the
//     contract-verified eager path, see that file's CONTRACT SOURCE header).
//   - `packagerCredentialMapping()` — src/services/external-storage-credentials.ts:122,
//     the external-storage field mapping, whose header records the per-service
//     field-name conventions verified under issue #212.
// Both must spell the object-store fields identically, or an external-storage
// stack and a default stack would configure the same service with different
// field names.
//
// It also PINS the exact field set, so the day the live schema is reachable the
// diff to reconcile is this one assertion rather than a re-reading of the whole
// provisioning flow.

import { describe, expect, it } from 'vitest';
import {
  PACKAGER_REDIS_QUEUE,
  buildPackagerCreateBody
} from '../src/services/packager-provisioning.js';
import { packagerCredentialMapping } from '../src/services/external-storage-credentials.js';

const REFS = { patRef: '{{secrets.pat}}', s3SecretRef: '{{secrets.s3}}' };
const COORDS = {
  stackName: 'stack1',
  redisUrl: 'redis://valkey:6379',
  minioEndpoint: 'https://minio.example',
  packagedBucket: 'openvideocore-packaged',
  publicBaseUrl: 'https://api.example'
};

describe('packager create body field reconciliation (issue #1263)', () => {
  it('emits exactly the recorded field set, with no field added or dropped', () => {
    const body = buildPackagerCreateBody(COORDS, REFS);
    expect(Object.keys(body).sort()).toEqual(
      [
        'AwsAccessKeyId',
        'AwsSecretAccessKey',
        'CallbackUrl',
        'OutputFolder',
        'PersonalAccessToken',
        'RedisQueue',
        'RedisUrl',
        'S3EndpointUrl',
        'name'
      ].sort()
    );
    expect(body['RedisQueue']).toBe(PACKAGER_REDIS_QUEUE);
    // OutputFolder must be the s3://<bucket>/ form WITH the trailing slash.
    expect(body['OutputFolder']).toBe('s3://openvideocore-packaged/');
    // Secrets are passed as {{secrets.*}} references, never literals.
    expect(body['AwsSecretAccessKey']).toBe(REFS.s3SecretRef);
    expect(body['PersonalAccessToken']).toBe(REFS.patRef);
  });

  it('agrees with the external-storage mapping on every shared field name', () => {
    const body = buildPackagerCreateBody(COORDS, REFS);
    const mapping = packagerCredentialMapping(
      {
        bucket: 'openvideocore-packaged',
        accessKeyId: 'key-id',
        secretAccessKey: 'secret',
        endpointUrl: 'https://minio.example'
      },
      'packaged'
    );
    const mappingFields = [
      ...Object.keys(mapping.configFields),
      ...mapping.secrets.map((s) => s.field)
    ];
    for (const field of mappingFields) {
      expect(Object.keys(body)).toContain(field);
    }
  });

  it('declares no encryption-related field anywhere in the create body', () => {
    // The capability probe in src/pipeline/packaging.ts answers
    // `encryption: false` for this service; this is the provisioning-side half
    // of that claim. If a future schema adds such a field, this fails and the
    // probe must be revisited together with it.
    const keys = Object.keys(buildPackagerCreateBody(COORDS, REFS)).map((k) =>
      k.toLowerCase()
    );
    // `key` itself is NOT a needle: the object-store credential fields
    // (AwsAccessKeyId / AwsSecretAccessKey) legitimately contain it and are
    // storage auth, not content keys.
    for (const needle of ['encrypt', 'contentkey', 'drm', 'pssh', 'scheme', 'cenc', 'cbcs']) {
      expect(keys.filter((k) => k.includes(needle))).toEqual([]);
    }
  });
});
