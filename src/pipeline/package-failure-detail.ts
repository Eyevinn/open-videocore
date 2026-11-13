// Structured, machine-readable failure detail for a failed `package` step
// (issue #1338, broken out of #1336).
//
// WHY THIS EXISTS
// ---------------
// A failed `package` step has, until now, carried exactly one piece of
// information: free text. Either the packager's own callback message, relayed
// as `packager failure: <message>` (src/routes/internal.ts:709), or the stall
// sweep's diagnostic, `packager never signalled completion within 15 minutes;
// ...` (buildDiagnostic, src/pipeline/stalled-package-reconciler.ts:215).
// A caller reading that text cannot branch on it, and the three failures a
// caller would act on differently are indistinguishable without scraping:
//   - media the packager cannot parse  -> re-ingest a supported mezzanine
//   - a rejected service credential    -> an operator fix, retry is pointless
//   - no completion signal at all      -> retry is the right move
// This module classifies the failure into one of the `packager_*`
// STEP_ERROR_CODES and produces the `errorDetail` the step carries alongside
// its unchanged `error` text.
//
// WHAT THE DETAIL MAY CONTAIN (issue #1338, hard requirement)
// -----------------------------------------------------------
// `errorDetail` for these codes carries the CODE and a FIXED user-safe sentence
// and nothing else. The messages below are constants, never interpolated from
// the packager's text, because that text routinely carries the transcoder job
// URL the packager was pointed at and the host it ran against — and the detail
// is served to API callers (GET /api/v1/pipelines[/:executionId] and the three
// asset execution routes). The raw text keeps going to the server logs and to
// the step's own `error` field, which is where it already was; nothing here
// widens its audience. The `source`/`storageError`/`httpStatus`/`encoreJobId`
// members of StepErrorDetail are deliberately left absent.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
// -----------------------------------------------------------
//   - `StepErrorDetail` / `STEP_ERROR_CODES` — the shape and enum this returns:
//     src/pipeline/step-error-detail.ts:60-66 (`STEP_ERROR_CODES`) and
//     :95-121 (`StepErrorDetail`, `code` + `message` required, every other
//     member optional). The response schema deriving its enum from the tuple is
//     `stepErrorDetailSchema` (same file, :126), embedded as the `errorDetail`
//     member of `stepExecutionSchema` at src/routes/pipelines.ts:41 and
//     src/routes/assets.ts:1798.
//   - `StepExecution.errorDetail` — the persisted/served field:
//     src/data/pipeline-repo.ts:72, hydrated through
//     `toStepErrorDetail` (src/data/couch-pipeline-repo.ts:295), which parses
//     stored values with `stepErrorDetailSchema`, so a code absent from the
//     tuple would silently degrade to "no detail".
//   - The failure callback whose `message` is classified here: POST
//     /packagerCallback/failure, body `packagerFailureSchema` = `{ message }`
//     ONLY (src/routes/internal.ts:101, handler at :673). The packager
//     sends no id and no structured reason, so the message text — which is
//     where it relays its own log line — is the only signal available.
//   - The completion watchdog that produces the timeout:
//     `reconcileStalledPackages` with `DEFAULT_PACKAGE_STALL_TIMEOUT_MS =
//     15 * 60 * 1000` (src/pipeline/stalled-package-reconciler.ts:46, 98).
//   - The precedent for a builder shared by every settle path:
//     `buildSourceReadErrorDetail` (src/pipeline/encore-source-read-failure.ts:297).

import type { StepErrorCode, StepErrorDetail } from './step-error-detail.js';

// The codes this module can produce. A subset of STEP_ERROR_CODES: the
// source-read class belongs to the transcode step and is built elsewhere.
export type PackageStepErrorCode = Extract<
  StepErrorCode,
  'packager_timeout' | 'packager_unsupported_media' | 'packager_auth' | 'packager_failed'
>;

// The user-safe sentence each code carries. FIXED strings — see the header: no
// packager text, no job URL, no hostname, no credential may be interpolated
// into these. Each one states what happened and what the caller can do about
// it, which is the whole reason the codes are distinguished.
export const PACKAGE_ERROR_MESSAGES: Readonly<Record<PackageStepErrorCode, string>> =
  Object.freeze({
    packager_timeout:
      'packaging did not signal completion within the allowed time and was declared failed; the run can be retried.',
    packager_unsupported_media:
      'the packager could not parse the media: the input uses a container or codec it cannot read. Re-ingest the asset in a supported format.',
    packager_auth:
      'packaging could not be authorised: the credential used to reach the packaging service was rejected. An operator must refresh it; retrying will not help.',
    packager_failed: 'packaging failed; the underlying detail was recorded in the server logs.'
  });

// Does the packager's text indicate the media could not be parsed?
//
// The packager relays its underlying tool's error code verbatim in the callback
// message and in its log, and the parse failure surfaces there as the token
// `PARSER_FAILURE` (issue #1338 names exactly this token). Matched
// case-insensitively and allowing a space or hyphen in place of the underscore,
// because the token reaches us inside prose the packager composed and has been
// observed both as the bare enum name and inside `Error: ... (parser failure)`.
const PARSER_FAILURE_PATTERN = /parser[\s_-]?failure/i;

// Does the packager's text indicate the credential it was given was rejected?
//
// An invalid service token fails the fetch of the transcoder job the packager
// was pointed at, so what comes back in the message is an HTTP 401 / the word
// `Unauthorized`, or the service's own "invalid token" wording. 403 is
// deliberately NOT matched: on this path it is an object-storage permissions
// verdict on the media, not a verdict on the token, and misclassifying it would
// send an operator after a credential that is fine.
const AUTH_FAILURE_PATTERN =
  /\b401\b|unauthori[sz]ed|invalid[\s_-]+(?:access[\s_-]+)?token|token[\s_-]+(?:is[\s_-]+)?(?:invalid|expired|rejected)|authentication[\s_-]+failed/i;

// Classify a packager failure text into a code.
//
// Precedence follows issue #1338: an unparseable media first (the most
// specific, and the one whose remedy sits with the caller), then a rejected
// credential, then the catch-all. `packager_timeout` is NOT reachable from text
// — it is a verdict only the completion watchdog can reach, since it is defined
// by the ABSENCE of any packager signal — so it has its own builder below.
//
// `undefined`/empty text classifies as `packager_failed`: a failure we were
// told about but cannot classify is still a packaging failure.
export function classifyPackageFailure(failureText: string | undefined): PackageStepErrorCode {
  const text = failureText ?? '';
  if (PARSER_FAILURE_PATTERN.test(text)) return 'packager_unsupported_media';
  if (AUTH_FAILURE_PATTERN.test(text)) return 'packager_auth';
  return 'packager_failed';
}

// Build the detail for one code. The single place a `packager_*` detail is
// constructed, so every path that fails a `package` step emits an identical,
// scrubbed shape: `{ code, message }` and nothing else.
export function packageErrorDetail(code: PackageStepErrorCode): StepErrorDetail {
  return { code, message: PACKAGE_ERROR_MESSAGES[code] };
}

// The detail for a `package` step the completion watchdog declared failed
// (src/pipeline/stalled-package-reconciler.ts). The sweep's own free-text
// diagnostic — which names the probed packager presence — stays on `error`.
export function buildPackageTimeoutErrorDetail(): StepErrorDetail {
  return packageErrorDetail('packager_timeout');
}

// The detail for a `package` step failed by a packager-reported failure: the
// POST /packagerCallback/failure message (src/routes/internal.ts:673) or, where
// the packager's log line was captured instead, that log. `failureText` may
// carry anything the packager wrote, including URLs — it is only ever MATCHED
// against here, never copied into the returned detail.
export function buildPackageFailureErrorDetail(
  failureText: string | undefined
): StepErrorDetail {
  return packageErrorDetail(classifyPackageFailure(failureText));
}
