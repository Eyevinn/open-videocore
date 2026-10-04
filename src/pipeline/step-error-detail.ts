// Structured, machine-readable failure detail for a pipeline step (issue #1060).
//
// WHY THIS EXISTS
// ---------------
// A failed `transcode` step has, until now, carried exactly one piece of
// information: a free-text `error` string copied verbatim from the Encore job
// document's `message` field. For a source-read failure that string is
//
//   dropped by Encore: ffprobe failed for input s3://<bucket>/<key>:
//   Server returned 404 Not Found
//
// which tells a caller that something 404'd but not, in any machine-readable
// form, WHAT: they have to open the Encore job and then the bucket to discover
// that the source key is simply absent (#1060, broken out of #1057). This type
// is the structured half of that answer. It sits ALONGSIDE `error` — the free
// text is unchanged, so nothing that reads it today breaks — and carries the
// code, the redacted source location and the correlation ids as fields.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
// -----------------------------------------------------------
//   - `StepExecution` is the step record this detail hangs off:
//     `{ name; status; jobId?; encoreJobId?; error?; skipReason?; startedAt?;
//        completedAt?; progress? }` — src/data/pipeline-repo.ts:43-56.
//   - The response contract it must appear in is `stepExecutionSchema`, declared
//     twice (deliberately duplicated in this codebase) at
//     src/routes/pipelines.ts:17-30 (GET /api/v1/pipelines[/:executionId]) and
//     src/routes/assets.ts:1134-1144 (POST /:id/execute, GET /:id/executions,
//     GET /:id/pipelines).
//   - The precedent for an ADDITIVE, OPTIONAL annotation on a step is
//     `skipReason` (#789, src/data/pipeline-repo.ts:50-53): a new optional field
//     that explains a status without changing the status enum. `errorDetail`
//     follows it exactly.
//
// The zod schema lives here next to the type so the two route copies of
// `stepExecutionSchema` share ONE definition and cannot drift (the surrounding
// step schema is duplicated for historical reasons; this part is not).

import { z } from 'zod';

// The stable, machine-readable error codes a failed step may carry.
//
// `source_read_failed` (#1060): the step failed because the SOURCE object could
// not be read — the storage answered 404/403, or the connection to it failed.
// This is distinct from every other transcode failure (a bad profile, a codec
// error, a lost worker) because the remedy is different and is entirely about
// the input: the key is missing, or the credentials/permissions on it are wrong.
//
// Kept as a `const` tuple so the route schemas derive their enum from it and a
// new code cannot be added without the response contract following.
export const STEP_ERROR_CODES = ['source_read_failed'] as const;
export type StepErrorCode = (typeof STEP_ERROR_CODES)[number];

// Where the failing read was pointed. `url` is ALWAYS redacted before it lands
// here (see redactUrlsInText in ./encore-source-read-failure.ts): a source
// location can be a presigned URL whose query string carries a live SigV4
// signature, or carry userinfo, and this field is served to API callers.
//
// `bucket`/`key` are present when the location was an `s3://bucket/key` URI,
// which is what the transcode path always submits (`inputUri` =
// `s3://${sourceBucket}/${sourceObjectKey}`, src/pipeline/transcode.ts:140).
// They are the two values an operator needs to check the object by hand, which
// is the whole point of #1060, so they are broken out rather than left for the
// caller to re-parse out of `url`.
export type StepErrorSource = {
  url: string;
  bucket?: string;
  key?: string;
};

// The structured failure detail. Every field beyond `code` and `message` is
// optional: the detail is built by parsing text produced inside the Encore
// container (nothing between there and here can add fields to it — see
// ./encore-source-read-failure.ts), so a recognisable failure whose text omits,
// say, the HTTP status still yields a useful code + location.
export type StepErrorDetail = {
  // The stable code a caller branches on.
  code: StepErrorCode;
  // One human-readable sentence. NOT the underlying storage error — that is
  // `storageError` — and not a substitute for the step's `error` field either.
  message: string;
  // The underlying error text from the storage/transcode layer, redacted and
  // length-bounded. #1060 asks for "the underlying storage error" to be part of
  // the structured answer so a caller does not have to scrape `error`.
  storageError?: string;
  // The HTTP status the storage answered, when the failure text carried one
  // (404 for a missing key, 403 for a permissions/credentials verdict). Absent
  // for a connection-class failure, which never gets as far as a status.
  httpStatus?: number;
  // The (redacted) source location the failing read was pointed at.
  source?: StepErrorSource;
  // Correlation ids, so the structured error is self-contained (#1060
  // acceptance criterion: "a structured error with the code, the redacted
  // source location and the Encore job id"). Both are also present elsewhere on
  // the execution response — `encoreJobId` on the step
  // (src/routes/pipelines.ts:24) and `assetId` on the execution
  // (src/routes/pipelines.ts:34) — and are repeated here deliberately so an
  // error forwarded on its own (into a log, an alert, a bug report) still
  // identifies the Encore job and the asset it belongs to.
  encoreJobId?: string;
  assetId?: string;
};

// THE response schema for the detail, shared by both copies of
// `stepExecutionSchema`. `.describe()` text is what shows up in the generated
// OpenAPI document, so it carries the caller-facing explanation of each field.
export const stepErrorDetailSchema = z.object({
  code: z
    .enum(STEP_ERROR_CODES)
    .describe(
      'Stable, machine-readable failure code. `source_read_failed`: the step ' +
        'could not READ its source object — the storage answered 404 (the key ' +
        'is absent) or 403 (a permissions/credentials verdict), or the ' +
        'connection to the storage failed. Branch on this rather than on the ' +
        'free-text `error`.'
    ),
  message: z.string().describe('One human-readable sentence describing the failure.'),
  storageError: z
    .string()
    .optional()
    .describe(
      'The underlying error text from the storage/transcode layer, with ' +
        'credentials redacted (userinfo and query strings stripped) and length ' +
        'bounded.'
    ),
  httpStatus: z
    .number()
    .optional()
    .describe(
      'HTTP status the storage answered (404 = key absent, 403 = denied). ' +
        'Absent for a connection-class failure, which never reaches a status.'
    ),
  source: z
    .object({
      url: z
        .string()
        .describe(
          'The source location the failing read was pointed at, with ' +
            'credentials redacted. Never contains userinfo or a presigned query ' +
            'string.'
        ),
      bucket: z.string().optional().describe('Bucket, when the location was an s3:// URI.'),
      key: z.string().optional().describe('Object key, when the location was an s3:// URI.')
    })
    .optional()
    .describe('Where the failing read was pointed (credentials redacted).'),
  encoreJobId: z
    .string()
    .optional()
    .describe('The transcoder job id this failure came from, for correlation.'),
  assetId: z.string().optional().describe('The asset this failure belongs to, for correlation.')
});

// Compile-time guard: fails `tsc --noEmit` if the schema and the type drift.
// Same technique the jobs router uses for FAILURE_CLASSES (src/routes/jobs.ts:33-39).
type _AssertDetailSchemaInSync = z.infer<typeof stepErrorDetailSchema> extends StepErrorDetail
  ? StepErrorDetail extends z.infer<typeof stepErrorDetailSchema>
    ? true
    : never
  : never;
const _detailSchemaInSync: _AssertDetailSchemaInSync = true;
void _detailSchemaInSync;
