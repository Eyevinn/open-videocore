# Contract note: does `POST /api/v1/assets/{id}/export` report success truthfully? — issue #944

**Verdict: it did NOT. The export endpoint carried two of the four defects behind
the #781/#783/#786 false-success pattern, plus a weaker version of a third. All
three are fixed in this change. `201` from export now means the output object has
been confirmed present and non-empty in storage; every other status code means it
has not.**

This is the precondition #796 asked for before an export UI is built. Every shape
below was read from this tree's source and from the installed OSC SDK typings
(CLAUDE.md rule 7). Nothing is taken from issue text.

## 1. The root cause the three closed issues actually share

The three issues are frequently cited together, but they are not one bug. Reading
the commits that closed them:

| Issue | Closing commit | What was actually wrong |
|---|---|---|
| #781 | `92ba9aa` — *report skipped (not done) for unconfigured optional pipeline steps* | A pipeline step that **could not run** (no optional service configured) settled as `done` and wrote nothing. Fix: a distinct `skipped` `StepStatus` plus `skipReason` (`src/data/pipeline-repo.ts`). |
| #783 | `011ac38` / `a7e5d86` — *call the scene-detect function on its real job API* | The call to the scene-detection function was **malformed** (POST + JSON body against a GET-only endpoint → 405 on every run). Fix: the real contract, now recorded in `docs/contracts/eyevinn-function-scenes-api.json` and `docs/investigations/797-function-scenes-runtime-contract.md`. |
| #786 | `d142985` — *verify clip object exists and fix ffmpeg s3 output so a failed clip 502s instead of a fake-ready child* | `POST /:id/clip` returned `201` + a `ready` child whose object answered `NoSuchKey`. Four sub-defects: (a) ffmpeg output pointed at a presigned HTTPS PUT URL, which its muxer cannot write; (b) the runner classified the job outcome with a **deny-list** of two failure values, so every other terminal value passed as success; (c) nothing verified the output object existed; (d) `getLogsForInstance` was injected and never called, and the job was reaped in a `finally`, destroying the evidence. |

So there is no single shared line of code. What #781 and #786 share — and what
this ticket is really about — is one **structural** pattern:

> **An operation's reported outcome is derived from "the code path finished
> without throwing" rather than from "the artefact the operation promised
> exists".**

#781 is the degenerate case (the work never started). #786 is the interesting
case (the work started, the external service reported a terminal status, and no
artefact appeared). #783 is a different class — a wrong call, not a wrong
verdict — and is relevant here only in that its *reporting* was already honest:
the failure was detected and recorded.

The #786 fix therefore establishes a four-part checklist for any awaited
operation that dispatches an OSC ephemeral job. Applied to export:

| # | Property | Export before this change |
|---|---|---|
| 1 | ffmpeg output is a native `s3://bucket/key` URI, not a presigned PUT URL | **Already correct** — fixed for export first, in #316 (`rewrapCmdLine`, `src/pipeline/osc-rewrap.ts:103`). Clip copied this fix. |
| 2 | The written object is verified before success is reported | **Partially correct** — existence was checked (#316) but a 0-byte object passed. Clip also rejects empty (`src/pipeline/clip.ts:181`). |
| 3 | Job outcome uses a success **allow-list**, not a failure deny-list | **DEFECTIVE — same defect as #786(b)** |
| 4 | Job logs captured before `removeJob` | **DEFECTIVE — same defect as #786(d)** |

## 2. Defect 3 in detail: `'Stopped'` was reported as a successful export

`src/pipeline/osc-rewrap.ts:makeOscRewrapRunner` classified the job like this:

```js
const status = await pollOscJobUntilDone(api, FFPROBE_SERVICE_ID, name, sat, {
  failFastOnUnknownStatus: true
});
if (status === 'Failed' || status === 'Error') throw new Error(...);
```

That is a closed deny-list of two values, and the poller's terminal set has five:

```js
// src/pipeline/osc-job-poll.ts:19
const TERMINAL_STATUS = new Set(['SuccessCriteriaMet', 'Complete', 'Failed', 'Error', 'Stopped']);
```

`pollOscJobUntilDone` (`src/pipeline/osc-job-poll.ts:113`) **returns** any member
of that set (`:126`). So a job that ended `'Stopped'` — a killed container, an
evicted pod, an operator-cancelled job — returned normally from the runner and
was treated as a completed export. `failFastOnUnknownStatus` does not help: it
only covers statuses the poller classifies as *neither* terminal *nor* active
(`:127`), and `'Stopped'` is terminal.

The same call also returns a synthesised `'Complete'` when the instance is
already gone (`if (job === undefined) return 'Complete'`, `:124`). That is an
assumption — "instance gone = completed and cleaned up" — shared with clip, and
it is only safe *because* layer 2 independently verifies the object. Worth
knowing when reading a success.

## 3. Defect 4 in detail: the diagnostic was thrown away on every failure

`OscJobApi` declared `getLogsForInstance` and `src/main.ts:762` wired the real
SDK function into the export runner — but nothing ever called it. The runner
reaped the instance in a `finally`, unconditionally. OSC serves a job's logs only
while its ephemeral instance exists (`getLogsForInstance` is an instance call —
`@osaas/client-core/lib/core.d.ts:85`), so every failed export destroyed the only
record of why ffmpeg failed. This is verbatim #786 finding 4;
`docs/osc-feedback/incoming-issue786-ffmpeg-s3-terminal-status-without-output.md`
gap 3 already claimed we fetch logs before `removeJob`, which was true of clip
only.

## 4. The 0-byte gap

`rewrap()` checked `if (!stat)` but not `stat.size`. `statObject` returns the size
(`src/data/storage.ts:136` — `Promise<{ size: number; etag: string } | undefined>`),
and ffmpeg creates its output target before writing any packets, so a muxer that
fails after opening the destination leaves an object that exists and contains
nothing. That would have produced a `ready` child asset whose download is a
zero-byte file — a false success with a plausible-looking `/files` URL. `clip()`
already rejected this case; export now matches.

## 5. What export got right, and is worth relying on

- **Unconfigured is not silent (contrast #781).** No runner, or no storage, or a
  runner factory that cannot resolve the workspace's S3 config, is an explicit
  `501 not_configured` (`src/routes/assets.ts:4904` handler; factory resolution
  via `resolveConfiguredRunner`, `src/routes/assets.ts:1982`). There is no
  skip-that-looks-like-success path in export.
- **No source object is `409 no_object`**, through the shared resolver
  (`requireSourceObject`, `src/pipeline/source-object.ts:96`;
  `NO_SOURCE_OBJECT_ERROR`, `:31`).
- **A failed export leaves a `failed` child with no `objectKey`.** `rewrap()`
  records `objectKey` only *after* verification (`src/pipeline/rewrap.ts` — the
  `update` calls follow the `statObject` guard), so a broken export can never
  serve a `/files` URL for an object that does not exist.
- **The source asset is never mutated.** An export is a pure read of the source.

## 6. The contract an export UI can now build on

`POST /api/v1/assets/{id}/export` — request body `exportBodySchema`
(`src/routes/assets.ts:718`): `{ targetFormat: 'mp4'|'mkv'|'mov'|'mxf'|'ts'` (required)`, outputName?: string(1..256), asVersion?: boolean }`.
Verified against `openapi.json` → `paths./api/v1/assets/{id}/export.post`, whose
declared responses are exactly `201, 400, 404, 409, 501, 502`.

| Status | Meaning for the UI |
|---|---|
| `201` | Export succeeded. Body is the new child asset (`assetSchema`), `status: "ready"`, `parentId` = the source, `objectKey` = `exports/<childId>.<format>` (`rewrapObjectKey`, `src/pipeline/rewrap.ts:62`). **The output object has been confirmed present and non-empty.** Safe to offer a download. |
| `400` | Unsupported `targetFormat` (Zod enum at the edge, `UnsupportedFormatError` defensively in the pipeline). |
| `404` | Unknown or foreign asset — existence is not leaked. |
| `409` | `error: "no_object"` — the source asset has no stored object to export. |
| `501` | `error: "not_configured"` — export is not available on this deployment. A UI should treat this as "hide or disable the action with an explanation", which is the #796 acceptance criterion about explaining rather than failing opaquely. |
| `502` | `error: "rewrap_failed"` — the export failed. The child asset exists under the source with `status: "failed"` and **no** `objectKey`. `message` is a single status-bearing sentence; it deliberately does **not** contain the ffmpeg log. |

Two properties the UI can rely on without polling:

- **Synchronous.** The route awaits the runner, so the response *is* the outcome.
  There is no `processing` state for the client to poll and no callback.
  (`201` is only ever sent after verification; a `processing` child asset visible
  in a list is a request still in flight.)
- **`201` is falsifiable.** Three independent layers must all agree before it is
  sent: the job-status allow-list (`SUCCESS_STATUSES`,
  `src/pipeline/osc-rewrap.ts:85`), the object HEAD + non-empty check
  (`src/pipeline/rewrap.ts:173`), and only then the `ready` transition. A UI does
  not need to re-verify by fetching the object.

**Where the failure explanation lives.** The ffmpeg log is server-side only. The
route logs it at `warn` with `oscJobLog(err)` on the `'export/re-wrap job failed'`
line; the response body carries only `message`. This is the #786 round-2 security
position (the log is third-party output and can carry storage endpoints, bucket
names and container paths), and it means **an export UI cannot show the operator
the ffmpeg reason** — it can show the status sentence and should point at the
server log. If per-operation failure detail in the UI is wanted, that needs its
own ticket and its own decision about what is safe to return; it is not something
to improvise in the UI ticket.

## 7. What changed in this commit

| File | Change |
|---|---|
| `src/pipeline/osc-job-log.ts` (new) | Shared failure diagnostics for the two awaited ffmpeg-job pipelines: `redactLogQueryStrings`, `captureJobLogs`, `OscJobError` (carries `jobLog` as data, never in `message`), `oscJobLog`. Extracted from `osc-clip.ts` rather than copied, so clip and export cannot drift again. |
| `src/pipeline/osc-rewrap.ts` | Deny-list → `SUCCESS_STATUSES` allow-list (`:85`); capture the job log **before** `removeJob` on any non-success outcome; throw `OscRewrapJobError` carrying it as data. |
| `src/pipeline/rewrap.ts` | Reject a 0-byte output object as well as a missing one. |
| `src/pipeline/osc-clip.ts` | Now imports the shared helpers; `OscClipJobError` becomes a thin subclass of `OscJobError`. `redactLogQueryStrings` / `oscClipJobLog` are re-exported unchanged, so existing importers and `test/clip.test.ts` are unaffected. |
| `src/routes/assets.ts` | The export `502` path now logs the job's ffmpeg output server-side, exactly as the clip route does; the response body is unchanged. The route's doc comment records the outcome contract above. |

## 8. Regression coverage — GAP, needs a follow-up

**No tests were added for the behaviour above.** The `protect-test-oracle` hook in
this engagement denies writes to test paths, so `test/rewrap.test.ts` could not be
extended. The same constraint is recorded in the #786 commit (`d142985`), where
coverage landed in a follow-up round.

The behaviour was verified out-of-band before this commit, with a throwaway script
against the real modules (since removed), which confirmed: `'SuccessCriteriaMet'`
still resolves; `'Stopped'` now rejects as `OscRewrapJobError`;
`getLogsForInstance` is called before `removeJob`; the captured log carries the
ffmpeg text with its SigV4 query string redacted and does **not** appear in
`message`; a 0-byte output rejects and leaves the child `failed` with no
`objectKey`; and a non-empty output still produces a `ready` child. That is not a
substitute for committed tests.

The cases `test/rewrap.test.ts` should gain, mirroring what
`test/clip.test.ts`/`test/osc-job-poll.test.ts` gained for #786:

1. `makeOscRewrapRunner` rejects on `'Stopped'` (and on any status outside
   `SUCCESS_STATUSES`), not just on `'Failed'`/`'Error'`.
2. `getLogsForInstance` is called **before** `removeJob` on a failing export, and
   not at all on a succeeding one.
3. The thrown error's `message` does not contain the log; `jobLog` does, with
   query strings redacted.
4. `rewrap()` fails the child and throws when `statObject` reports `size: 0`.
5. `POST /:id/export` returns `502` with `error: "rewrap_failed"` for a
   `'Stopped'` job, and the child under the source is `failed` with no
   `objectKey`.

## 9. OSC friction

No new OSC gap was found — this is the same `eyevinn-ffmpeg-s3` contract gap
already filed for #786 (no per-job result document; an undocumented `job.status`
vocabulary; logs that vanish with the instance). A dated addendum recording that
the gap bit a **second** endpoint, and that the friction log's own claim about log
capture was only true of clip, is appended to
`docs/osc-feedback/incoming-issue786-ffmpeg-s3-terminal-status-without-output.md`.
