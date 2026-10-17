// Multipart part size for a spawned transcoder's OUTPUT upload (issue #1221).
//
// WHY THIS EXISTS
// ---------------
// An archive-class profile writes ONE very large output (a single mastering-codec
// file, ~3.4 GiB from a 740 MB 4K source). The encode succeeds, and then the
// upload of that output to the stack's object store fails deterministically —
// 3 of 3 attempts, nothing written to the bucket — about 10 seconds after the
// encode finishes, with:
//
//   SdkClientException: Unable to execute HTTP request: Acquire operation took
//   longer than the configured maximum time. This indicates that a request
//   cannot get a connection from the pool within the specified maximum time.
//   ("Acquire operation took longer than 10000 milliseconds")
//
// A delivery-class profile on the SAME source, stack and object store uploads in
// about a second. The discriminator is output size, not connectivity: the
// endpoint is the in-cluster Service address (issue #991), so no ingress is in
// the path, and the small-output upload proves the route works.
//
// ~10 s to failure is the connection-acquisition timeout elapsing with NO
// progress: the upload client never got going, rather than stalling partway
// through a long queue of parts. The one thing that distinguishes the failing
// upload is that it is the only one big enough to engage MULTIPART at all — and
// the part size it engages with is the transcoder service's default of
// 104 857 600 bytes (100 MB), 12.5x the upload SDK's own 8 MiB default. At that
// part size each in-flight part reserves a 100 MB buffer from the upload client's
// default memory budget (the client is built with no concurrency and no
// throughput override — see the contract sources below), which leaves very few
// slots, so part requests sit waiting on connection acquisition and trip the
// 10 s bound before the first part lands.
//
// So: send a part size in the range the upload SDK itself defaults to and is
// tested at. Smaller parts mean smaller per-part buffers, many admissible
// in-flight slots, and short part requests that acquire a connection
// immediately; the transfer as a whole stays inside the service's one-hour
// upload timeout.
//
// The connection pool size and the acquisition timeout themselves are NOT
// reachable from a consumer: they are built inside the transcoder image. The
// part size is the one upload tunable the service does expose, which is why the
// fix is shaped this way and why it is also operator-overridable — if a
// deployment's object store prefers fewer, larger parts, an operator can raise
// this without a release. The remaining gap is logged in the agents repo under
// docs/osc-feedback/.
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

// Default part size handed to every spawned transcoder (16 MiB).
//
// Chosen as the smallest value that is comfortably inside the upload SDK's own
// default range (8 MiB) while keeping the part count low for a realistic archive
// master: 16 MiB x 10 000 parts is a 160 GB ceiling, so no plausible single
// output can exhaust the part limit, and a 3.4 GiB output becomes a few hundred
// short part requests whose buffers are ~6x smaller than the service default's.
// It is deliberately NOT the 5 MiB floor: that would triple the request count
// for no buffer-pressure benefit.
export const DEFAULT_UPLOAD_PART_SIZE_BYTES = 16 * 1024 * 1024;

// Largest single output this part size can carry, for log/error text.
export function maxUploadBytesForPartSize(partSizeBytes: number): number {
  return partSizeBytes * S3_MAX_PARTS;
}

// Resolve the configured part size, in bytes, from a raw env value.
//
// Absent/blank => the default above. An unparseable or out-of-bounds value =>
// the default, with `onInvalid` called naming the reason: an upload tunable that
// silently did something other than what the operator wrote is how #1221 cost
// three full 4K encodes to diagnose in the first place, so the fallback is
// always announced. It does NOT throw: a typo'd tunable must not stop an API
// that transcodes correctly on the default.
export function resolveUploadPartSizeBytes(
  raw: string | undefined,
  onInvalid?: (reason: string) => void
): number {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return DEFAULT_UPLOAD_PART_SIZE_BYTES;

  // Strict decimal byte count: the option is sent to the service as a decimal
  // string, so anything parseInt would silently truncate ("16MiB" -> 16) is
  // rejected instead of becoming a part size below the S3 floor.
  if (!/^\d+$/.test(trimmed)) {
    onInvalid?.(
      `"${trimmed}" is not a whole number of bytes — using the default ${DEFAULT_UPLOAD_PART_SIZE_BYTES}`
    );
    return DEFAULT_UPLOAD_PART_SIZE_BYTES;
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    onInvalid?.(
      `${trimmed} bytes is not a representable byte count — using the default ${DEFAULT_UPLOAD_PART_SIZE_BYTES}`
    );
    return DEFAULT_UPLOAD_PART_SIZE_BYTES;
  }
  if (parsed < S3_MIN_PART_SIZE_BYTES || parsed > S3_MAX_PART_SIZE_BYTES) {
    onInvalid?.(
      `${parsed} bytes is outside the S3 multipart part-size bounds ` +
        `[${S3_MIN_PART_SIZE_BYTES}, ${S3_MAX_PART_SIZE_BYTES}] — using the default ${DEFAULT_UPLOAD_PART_SIZE_BYTES}`
    );
    return DEFAULT_UPLOAD_PART_SIZE_BYTES;
  }
  return parsed;
}
