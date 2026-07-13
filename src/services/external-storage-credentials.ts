// Per-service external-S3-credential mapping (issue #212).
//
// When an operator supplies an external S3-compatible store for the source or
// packaged role at provision time (the `sourceStorage`/`packagedStorage`
// request blocks added by issue #211, see routes/provision.ts:47-68), each
// storage-consuming OSC service must receive those credentials under its OWN
// field names — every service spells them differently — and every SECRET value
// (secretAccessKey, sessionToken) must be injected via an OSC per-service
// secret reference (`{{secrets.<name>}}`), never as a plaintext create-instance
// parameter.
//
// This module is a PURE, side-effect-free mapping layer: given one external
// storage block (source or packaged), it produces, for a target service, the
// non-secret config fields plus a list of secrets that the caller must save
// (scoped to that service's serviceId) and reference. The actual saveSecret /
// createInstance calls live in the provisioning flow; keeping the field-name
// mapping pure here makes it unit-testable in isolation (see the AC note in
// issue #212 — test files cannot be authored by this automation).
//
// VERIFIED per-service field-name conventions (issue #212, each differs):
//   encore                 : s3AccessKeyId, s3SecretAccessKey, s3SessionToken,
//                            s3Region, s3Endpoint            (secret fields sensitive)
//   eyevinn-encore-packager: AwsAccessKeyId, AwsSecretAccessKey, AwsSessionToken,
//                            AwsRegion, S3EndpointUrl, OutputFolder
//                            (OutputFolder = s3://<bucket>/ WITH trailing slash)
//   eyevinn-ffmpeg-s3      : awsAccessKeyId, awsSecretAccessKey, awsSessionToken,
//                            awsRegion, s3EndpointUrl        (per-job ephemeral)

// The shape of one external storage block from the provision request. Mirrors
// (does NOT re-declare) externalStorageSchema in routes/provision.ts:47-54 and
// StorageBackendConfig in services/param-store.ts:33-38. Non-secret coordinates
// (bucket/region/endpointUrl) plus the two secret values (secretAccessKey and
// the optional sessionToken) and the non-secret accessKeyId.
export type ExternalStorageCredentials = {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpointUrl?: string;
  sessionToken?: string;
};

// One secret the caller must persist via saveSecret(serviceId, name, value, osc)
// BEFORE issuing the create-instance / create-job call. `value` is the literal
// credential — it is NEVER placed in config fields; instead `field` receives the
// `{{secrets.<name>}}` reference the caller builds after saving.
export type SecretToSave = {
  // The OSC config field on the target service that must hold the secret
  // REFERENCE (e.g. 's3SecretAccessKey' for encore).
  field: string;
  // The secret purpose/suffix. The caller composes the full secret name (its
  // own convention is <stackName>.<purpose>, see provision.ts:346) and scopes it
  // to the target serviceId. Kept role-qualified so the source and packaged
  // secrets never collide under one serviceId.
  purpose: string;
  // The literal credential value to persist. MUST NOT be logged or written to a
  // plaintext parameter — the caller hands it straight to saveSecret.
  value: string;
};

// The result of mapping one storage block onto one target service: the
// non-secret config fields (safe to place directly in the create body) and the
// secrets the caller must save + reference. The caller merges `configFields`
// into the create body, then for each secret saves it and sets
// body[secret.field] = `{{secrets.<name>}}`.
export type ServiceCredentialMapping = {
  configFields: Record<string, string>;
  secrets: SecretToSave[];
};

// Normalise a bucket name into the packager's required OutputFolder form:
// `s3://<bucket>/` WITH exactly one trailing slash (issue #212). Any leading
// `s3://` scheme and any leading/trailing slashes on the bucket are stripped
// first so a bare name, an `s3://name`, or a `name/` all normalise identically.
export function packagerOutputFolder(bucket: string): string {
  const bare = bucket
    .replace(/^s3:\/\//i, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return `s3://${bare}/`;
}

// Map an external storage block onto Encore's field names. Encore reads the
// SOURCE object for a transcode job, so this is used for the `sourceStorage`
// role. accessKeyId/region/endpoint are non-secret; secretAccessKey and (when
// present) sessionToken are secrets.
//
// `rolePurpose` distinguishes the secret from any same-serviceId secret of a
// different role (kept explicit so callers stay in control of the naming
// convention verified in provision.ts).
export function encoreCredentialMapping(
  creds: ExternalStorageCredentials,
  rolePurpose: string
): ServiceCredentialMapping {
  const configFields: Record<string, string> = {
    s3AccessKeyId: creds.accessKeyId
  };
  if (creds.region) configFields['s3Region'] = creds.region;
  if (creds.endpointUrl) configFields['s3Endpoint'] = creds.endpointUrl;

  const secrets: SecretToSave[] = [
    {
      field: 's3SecretAccessKey',
      purpose: `${rolePurpose}.s3secretaccesskey`,
      value: creds.secretAccessKey
    }
  ];
  if (creds.sessionToken) {
    secrets.push({
      field: 's3SessionToken',
      purpose: `${rolePurpose}.s3sessiontoken`,
      value: creds.sessionToken
    });
  }
  return { configFields, secrets };
}

// Map an external storage block onto the eyevinn-encore-packager field names.
// The packager WRITES packaged output, so this is used for the `packagedStorage`
// role. In addition to the Aws* credential fields it sets S3EndpointUrl and the
// OutputFolder (= s3://<bucket>/, trailing slash enforced).
export function packagerCredentialMapping(
  creds: ExternalStorageCredentials,
  rolePurpose: string
): ServiceCredentialMapping {
  const configFields: Record<string, string> = {
    AwsAccessKeyId: creds.accessKeyId,
    OutputFolder: packagerOutputFolder(creds.bucket)
  };
  if (creds.region) configFields['AwsRegion'] = creds.region;
  if (creds.endpointUrl) configFields['S3EndpointUrl'] = creds.endpointUrl;

  const secrets: SecretToSave[] = [
    {
      field: 'AwsSecretAccessKey',
      purpose: `${rolePurpose}.awssecretaccesskey`,
      value: creds.secretAccessKey
    }
  ];
  if (creds.sessionToken) {
    secrets.push({
      field: 'AwsSessionToken',
      purpose: `${rolePurpose}.awssessiontoken`,
      value: creds.sessionToken
    });
  }
  return { configFields, secrets };
}

// Map an external storage block onto the eyevinn-ffmpeg-s3 job-body field names.
// ffmpeg-s3 READS the source for probe/thumbnail/remux jobs, so this is used for
// the `sourceStorage` role. Instances are per-job ephemeral (created via
// createJob at request time, NOT at stack provision), so the caller wires these
// fields into the job body — see the lifecycle note in issue #212 requirement 4.
export function ffmpegS3CredentialMapping(
  creds: ExternalStorageCredentials,
  rolePurpose: string
): ServiceCredentialMapping {
  const configFields: Record<string, string> = {
    awsAccessKeyId: creds.accessKeyId
  };
  if (creds.region) configFields['awsRegion'] = creds.region;
  if (creds.endpointUrl) configFields['s3EndpointUrl'] = creds.endpointUrl;

  const secrets: SecretToSave[] = [
    {
      field: 'awsSecretAccessKey',
      purpose: `${rolePurpose}.awssecretaccesskey`,
      value: creds.secretAccessKey
    }
  ];
  if (creds.sessionToken) {
    secrets.push({
      field: 'awsSessionToken',
      purpose: `${rolePurpose}.awssessiontoken`,
      value: creds.sessionToken
    });
  }
  return { configFields, secrets };
}

// The OSC serviceIds each mapping targets. Re-declared here as a convenience so
// the caller scopes each saveSecret to the exact serviceId (secrets are
// per-service, ADR-002 / provision.ts:275-282). Mirrors the constants in
// services/stack.ts and encore-scaler/instance-pool.ts.
export const EXTERNAL_STORAGE_SERVICE_IDS = {
  encore: 'encore',
  packager: 'eyevinn-encore-packager',
  ffmpegS3: 'eyevinn-ffmpeg-s3'
} as const;
