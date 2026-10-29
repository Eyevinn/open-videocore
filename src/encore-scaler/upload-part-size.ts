// Operator-tunable multipart part size for a spawned transcoder's OUTPUT upload
// (issue #1221).
//
// WHAT THIS IS
// ------------
// A tunable, not a fix. Unset (the default) the option is NOT sent and every
// instance keeps the transcoder service's own default (104 857 600 bytes,
// 100 MB), i.e. no behaviour change on upgrade. An operator who sets
// ENCORE_S3_MULTIPART_PART_SIZE_BYTES gets that value sent on every newly spawned
// instance.
//
// WHY IT EXISTS (OBSERVATION, NOT CAUSE)
// --------------------------------------
// An archive-class profile writes ONE very large output (a single mastering-codec
// file, ~3.4 GiB from a 740 MB 4K source). The encode succeeds, and then the
// upload of that output to the stack's object store fails — 3 of 3 attempts,
// nothing written to the bucket — about 10 seconds after the encode finishes, with:
//
//   SdkClientException: Unable to execute HTTP request: Acquire operation took
//   longer than the configured maximum time. This indicates that a request
//   cannot get a connection from the pool within the specified maximum time.
//   ("Acquire operation took longer than 10000 milliseconds")
//
// A delivery-class profile on the SAME source, stack and object store uploads in
// about a second (re-observed 2026-10-28: `program` passes, `archive` fails twice,
// same source). The discriminator is output size or output shape, not
// connectivity: the endpoint is the in-cluster Service address (issue #991).
//
// THE HYPOTHESIS THIS WAS BUILT ON, AND WHY IT IS NOT ESTABLISHED
// ---------------------------------------------------------------
// The first version of this change argued that the service's 100 MB default part
// size leaves too few buffer slots, so part requests starve for a connection. That
// is a hypothesis; it was never reproduced. The deployed service's own source
// argues against it applying here:
//   - the credentialed upload path builds the CRT client
//     (`S3AsyncClient.crtBuilder()` + transfer manager) and passes
//     `minimumPartSizeInBytes` AND `thresholdInBytes` to it;
//   - the "Acquire operation took longer than ..." text is the Netty standard
//     async HTTP client's connectionAcquisitionTimeout message, and that client is
//     built only on the ANONYMOUS branch, which sets `multipartEnabled(false)` and
//     never reads any multipart property.
// So on the path the error text points at, this option may be a no-op. Which
// branch a provisioned instance actually takes is unanswered here and is tracked
// on #1221; it needs a reproduction on a real provisioned instance or an OSC-side
// answer. Do not read this module as having fixed #1221.
//
// THRESHOLD COUPLING (operators: read this before lowering the value)
// ------------------------------------------------------------------
// The service passes `thresholdInBytes(multipart.threshold)` with `threshold`
// defaulting to null, and OSC exposes no option for it, so the threshold takes the
// CRT default, which equals the minimum part size (AWS SDK `S3CrtAsyncClientBuilder
// .thresholdInBytes`: "By default, it is the same as `minimumPartSizeInBytes`").
// Lowering this value therefore also lowers the size at which an output goes
// multipart. With the 100 MB default, outputs under 100 MB are single PUTs; set to
// 16 MiB, every output from 16 MiB up goes multipart. Outputs that upload
// reliably today would move onto the multipart path. Lower it only to test the
// hypothesis above on a scratch instance, not as a blanket setting.
//
// The connection pool size and the acquisition timeout themselves are NOT
// reachable from a consumer: they are built inside the transcoder image. The part
// size is the one upload tunable the service exposes. The remaining gap is logged
// in the agents repo under docs/osc-feedback/.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7, all fetched live
// 2026-10-16)
// ----------------------------------------------------------------------------
//   - The instance-create option name and type: `POST /encoreinstance` request
//     body property `s3MultipartMinPartsize` — "(Optional) S3 multipart minimum
//     part size in bytes", `"type": "string"`, `"default": "104857600"` — in the
//     transcoder service's own live instance API contract
//     (https://api-encore.prod-se.osaas.io/docs/json, the `apiUrl` published for
//     this service by GET https://catalog.svc.prod.osaas.io/mysubscriptions).
//     NOTE: this property is NOT in that catalogue entry's
//     `availableServiceInstanceOptions` list (which carries only name,
//     profilesUrl, s3AccessKeyId, s3SecretAccessKey, s3SessionToken, s3Region,
//     s3Endpoint) — the instance API schema is the authoritative one, and the
//     option is accepted because the body is validated against it. Hence the
//     string type: the value is sent as a decimal byte count, like the default.
//   - The body reaches that schema verbatim: `createInstance(context, serviceId,
//     token, body)` JSON-stringifies `body` and POSTs it to `service.apiUrl`
//     with no filtering against the catalogue option list
//     (@osaas/client-core lib/core.js:76-90, v0.24.0; lib/core.d.ts:32).
//   - What the option configures on the transcoder side: `@ConfigurationProperties
//     ("remote-files.s3")` `S3Properties.multipart:
//     MultipartUploadProperties(minimumPartSize, threshold,
//     targetThroughputGbps, maxConcurrency)`, all four defaulting to null
//     (Eyevinn/encore v0.2.11-3, encore-common/src/main/kotlin/se/svt/oss/encore/
//     service/remotefiles/s3/S3Properties.kt), passed into the upload client as
//     `.minimumPartSizeInBytes(...)` alongside `.maxConcurrency(null)` and
//     `.targetThroughputInGbps(null)` (same tag, S3RemoteFilesConfiguration.kt),
//     and used for the credentialed output upload path
//     (S3RemoteFileHandler.upload() -> transferManagerUpload(), same tag).
//     `uploadTimeoutSeconds` on the same properties class defaults to one hour.
//   - The per-job document has no upload tunable at all: `EncoreJobRequestBody`
//     in the service's published job API contract
//     (https://eyevinn.github.io/encore-api-docs/swagger-encore-0.2.11-3.yaml)
//     carries externalId/profile/profileParams/outputFolder/baseName/
//     progressCallbackUri/priority/segmentLength/audioEncodingMode/debugOverlay/
//     logContext/seekTo/duration/thumbnailTime/inputs — the whole document
//     matches nothing for pool|concurren|acquire|partSize|multipart|upload.
//   - S3 multipart bounds the values below are clamped to: part size 5 MiB
//     minimum (except the last part), 5 GiB maximum, at most 10 000 parts per
//     upload — the same bounds this repo already encodes for its own
//     browser-facing multipart upload (src/routes/asset-upload.ts:112, "S3/MinIO
//     multipart part numbers are 1..10000").

// The instance-create option name, verbatim from the instance API schema above.
// Declared here so the spelling (lower-case "size") lives in exactly one place:
// a typo would be silently dropped by the service rather than rejected, which is
// the failure mode this module exists to end.
export const UPLOAD_PART_SIZE_OPTION = 's3MultipartMinPartsize';

// S3 multipart bounds. A part size outside these cannot produce a valid upload,
// so a configured value is refused (and the default used) rather than sent.
export const S3_MIN_PART_SIZE_BYTES = 5 * 1024 * 1024; // 5 MiB
export const S3_MAX_PART_SIZE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB
export const S3_MAX_PARTS = 10_000;

// Largest single output this part size can carry, for log/error text.
export function maxUploadBytesForPartSize(partSizeBytes: number): number {
  return partSizeBytes * S3_MAX_PARTS;
}

// Resolve the configured part size, in bytes, from a raw env value.
//
// Absent/blank => undefined: the option is not sent and the service keeps its own
// default. An unparseable or out-of-bounds value => undefined too, with
// `onInvalid` called naming the reason: an upload tunable that silently did
// something other than what the operator wrote is how #1221 cost three full 4K
// encodes to diagnose in the first place, so the fallback is always announced. It
// does NOT throw: a typo'd tunable must not stop an API that transcodes correctly
// on the service default.
export function resolveUploadPartSizeBytes(
  raw: string | undefined,
  onInvalid?: (reason: string) => void
): number | undefined {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return undefined;

  // Strict decimal byte count: the option is sent to the service as a decimal
  // string, so anything parseInt would silently truncate ("16MiB" -> 16) is
  // rejected instead of becoming a part size below the S3 floor.
  if (!/^\d+$/.test(trimmed)) {
    onInvalid?.(`"${trimmed}" is not a whole number of bytes — using the service default`);
    return undefined;
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    onInvalid?.(`${trimmed} bytes is not a representable byte count — using the service default`);
    return undefined;
  }
  if (parsed < S3_MIN_PART_SIZE_BYTES || parsed > S3_MAX_PART_SIZE_BYTES) {
    onInvalid?.(
      `${parsed} bytes is outside the S3 multipart part-size bounds ` +
        `[${S3_MIN_PART_SIZE_BYTES}, ${S3_MAX_PART_SIZE_BYTES}] — using the service default`
    );
    return undefined;
  }
  return parsed;
}
