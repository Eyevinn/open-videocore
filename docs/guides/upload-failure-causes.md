# Upload failure causes

*Contract for issue #771. Consumed by the ops UI work in #772.*

Every error response from the ingest upload surface carries a machine-readable
`cause` alongside the `error` code and the human `message`. A client can branch
on `cause` alone to decide what to tell the user and whether a retry is worth
attempting — it no longer has to infer intent from the HTTP status or parse
prose.

That holds for framework-level rejections too: a request that fails schema
validation (400) or arrives with a content type the API cannot stream (415) is
classified into the same envelope rather than falling through to the web
framework's own error shape.

## Response shape

```jsonc
{
  "error": "payload_too_large",          // machine code, unchanged from before #771
  "cause": "body_size_limit_exceeded",   // NEW: the failure cause (always present)
  "message": "source exceeds maximum allowed size of 10737418240 bytes",
  "code": "NoSuchUpload"                 // optional: non-secret S3 / errno code, when known
}
```

Defined by `uploadErrorSchema` in
[`src/routes/upload-failure-cause.ts`](../../src/routes/upload-failure-cause.ts)
and declared as the response schema for every non-2xx status on every route in
[`src/routes/asset-upload.ts`](../../src/routes/asset-upload.ts), so it also
appears in the generated `openapi.json`.

* `error` and `message` are **unchanged** from the pre-#771 shape — existing
  consumers that branch on `error` keep working.
* `cause` is **always present** on every non-2xx answered by the upload router.
  Its error handler (`src/routes/asset-upload.ts`) is terminal: it classifies
  the domain errors, then the framework rejections (400/413/415), and maps
  anything still unrecognised to `unknown` at 500 — nothing is rethrown into a
  different envelope. Every one of those statuses is declared on the routes, so
  they all appear in `openapi.json`.
  * The one exception is **401**, the app-wide authentication gate
    (`registerAuth` in `src/auth/middleware.ts`). It answers *before* the upload
    router runs and returns the envelope shared with every other router,
    `{ "error": "unauthorized", "message": … }`, with no `cause`. Treat a 401 as
    `not_authorized` — which is what `causeFromResponse()` in `public/upload.js`
    already does.
* `code` is present only when the underlying failure carried one. It is the raw
  S3 error code (e.g. `NoSuchUpload`, `AccessDenied`) or a Node errno
  (e.g. `ECONNREFUSED`). It never contains a credential; `message` is generated
  by the API and never echoes the underlying error text, which can carry
  endpoint or credential detail.

## Cause codes

| `cause` | Status | `error` | What happened | Retry? |
|---|---|---|---|---|
| `body_size_limit_exceeded` | 413 | `payload_too_large` | A body-size limit rejected the payload: the proxied `PUT`'s own 10 GiB stream cap, the buffered-body limit on the JSON routes (e.g. an oversized `parts` list), or a proxy in front of the API enforcing its own `client_max_body_size`. | Not as-is — use the presigned or multipart tier so no single request carries the whole payload. |
| `network_error` | 502 | `storage_unreachable` | The connection carrying the bytes broke or was never established — the caller hung up mid-stream, or the API could not reach object storage (DNS/TCP/TLS). | Yes, usually transient. |
| `storage_backend_error` | 502 | `storage_error` | Object storage was reached and refused or failed the operation (`AccessDenied`, `NoSuchBucket`, `NoSuchUpload`, `InvalidPart`, …). `code` carries the S3 code. | Only for session-scoped codes (restart the upload); a permission/bucket error needs an operator. |
| `storage_not_configured` | 501 | `not_configured` | No object storage is wired on this deployment. | No — configuration issue. |
| `quota_exceeded` | 409 | `quota_exceeded` | The deployment-wide storage cap would be exceeded (issue #579). | No — free space or raise the cap. |
| `asset_not_found` | 404 | `not_found` | No such asset in the caller's workspace. Existence is never leaked, so an asset in another workspace looks identical. | No. |
| `invalid_asset_state` | 422 | `invalid_state_transition` | The asset is not in a state that allows this step (e.g. finalizing an upload that already completed). | No. |
| `not_authorized` | 403 | `forbidden` | The caller may not touch this asset. | No. |
| `invalid_request` | 400 | `invalid_request` | The request did not satisfy the route's schema — an out-of-range `partNumber`, an empty or malformed `parts` body, a body that is not valid JSON. `code` carries the framework's validation code. | Not as-is — fix the request. |
| `unsupported_media_type` | 415 | `unsupported_media_type` | The body's `Content-Type` is not one the API can stream. Send `application/octet-stream` or one of the media types the ingest surface accepts. | Not as-is — resend with an accepted content type. |
| `unknown` | 500 | `upload_failed` | Reserved fallback: a fault the API could not classify. `message` is generic; the detail stays in the server log. | Retry once; if it persists it needs an operator. |

Clients **must** treat an unrecognised `cause` value as `unknown` rather than
failing to render: the enum may grow.

## Which causes each upload path can produce

The transport is chosen by file size in
[`public/upload.js`](../../public/upload.js) (`chooseUploadStrategy`, issue
#747), and the reachable causes differ per tier.

**Proxied stream — `PUT /api/v1/assets/:id/upload`** (small files)

The bytes transit the API, so the API sees (and classifies) the failure:
`body_size_limit_exceeded`, `network_error`, `storage_backend_error`,
plus `quota_exceeded` / `asset_not_found` / `storage_not_configured`, and
`unsupported_media_type` when the body's `Content-Type` has no stream parser.

On this route the 10 GiB cap is enforced by `SourceTooLargeError` inside
`putStream` (`src/data/storage.ts`), not by the framework's buffered-body limit:
the custom stream parser hands the body straight through without buffering it.
The buffered-body limit is what rejects an oversized JSON body on the multipart
routes instead. Both surface as `body_size_limit_exceeded`.

One case never reaches the API: a proxy in front of it enforcing a request-body
limit answers the 413 itself, typically with an HTML body and no `cause` field.
That is the exact failure #747 worked around. Clients must therefore map **any
413 without a structured body to `body_size_limit_exceeded`** — which is what
`causeFromResponse()` in `public/upload.js` does.

**Presigned single-part and multipart** (medium/large files)

`POST /:id/upload-url`, `POST /:id/multipart/initiate`,
`GET /:id/multipart/:uploadId/part-url`,
`POST /:id/multipart/:uploadId/complete`, `DELETE /:id/multipart/:uploadId`,
`POST /:id/upload-complete` all return the envelope above — including their
`invalid_request` (400) rejections, such as `partNumber=0` on the part-url route
or an empty `parts` list on multipart complete.

The bytes themselves go **browser → object storage**, so a failure on a part PUT
never reaches the API at all. The client classifies those: an XHR `error` event
(no status) is `network_error`; a non-2xx from object storage is
`storage_backend_error`, except a 413, which keeps its body-size meaning.

## Client-side contract

`public/upload.js` exports the mirror of the enum and the classifier:

* `UPLOAD_FAILURE_CAUSE` — the same codes as constants.
* `causeFromResponse(status, body, origin)` — cause for a non-2xx response;
  prefers the API's `cause` field, then falls back to the status.
* `uploadAssetFile(...)` — every Error it rejects with carries `failureCause`
  (one of the codes above) and, where known, `status` and `code`.

The property is `failureCause`, not `cause`, because `Error.cause` is the
standard field for the originating error and is left alone. The same split
applies server-side: `UploadFailureError.failureCause` is the code,
`toResponseBody()` serialises it as `cause`.

## What the ops UI shows (issue #772)

`public/upload.js` also owns the user-facing text, so the cause codes and the
sentences that explain them stay in one place:

* `UPLOAD_FAILURE_MESSAGE` — one sentence per cause, e.g.
  `body_size_limit_exceeded` → "the file exceeds the upload size limit enforced
  on this deployment".
* `resolveFailureCause(err)` — the cause of a thrown error: its `failureCause`
  first, then its HTTP status via `causeFromResponse()`, then `undefined`.
* `describeUploadFailure(err)` — the display string. It always leads with the
  cause ("Upload failed: …") and appends the API's `message` as
  "Details: …" when that adds anything; a message that only restates the
  transport status ("Upload failed: HTTP 413") is dropped. An error with no
  cause and no status — or an unrecognised cause code — falls back to the
  `unknown` sentence rather than rendering a raw token or throwing.

The upload modal in `public/app.js` renders exactly that string, so a failed
upload now reads "Upload failed: the file exceeds the upload size limit enforced
on this deployment." instead of "Error: Upload failed: HTTP 413".

Guidance the wording follows:

* Branch on `cause`; use `message` as the fallback display string.
* `network_error` is the only routinely retryable cause.
* `invalid_request` and `unsupported_media_type` are caller bugs, not transient
  failures — never offer a bare "retry" for them.
* For `body_size_limit_exceeded` on the stream tier, the actionable advice is
  that the file needs the presigned/multipart tier — which the size router
  already picks above 32 MiB, so seeing this on a small file means a proxy limit
  below that threshold.
* Do not show `code` to end users; keep it for the diagnostics/detail view.
