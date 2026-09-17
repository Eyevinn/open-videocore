# Encode-completion event integration guide

**Audience:** the OSC Platform open-media-convert team (token-metering /
plan-token deduction).
**Purpose:** everything an external consumer needs to receive the
`encode.completed` event and attribute encode cost, with no proprietary
dependency on open-videocore internals.

**Status: SHIPPED.** The event is emitted live on `main` as of the merge of
[#698](https://github.com/Eyevinn/open-videocore/pull/698) (commit
`1665f486032a1ef358649014b083eeeecb314432`, 2026-09-15). The payload schema
(#691) and the transport decision (#692 / ADR-022) are also merged and stable.
This guide unblocks open-media-convert#132 and open-media-convert#142.

This document communicates the contract and delivery timeline back to the
open-media-convert team. It intentionally does **not** post to any external
repo; it is the in-repo record of the shipped contract.

---

## At a glance

| | |
|---|---|
| Event name | `encode.completed` |
| Transport | signed outbound HTTP webhook (ADR-022) |
| Subscription | `POST /api/v1/webhooks` with `events: ["encode.completed"]` |
| Delivery guarantee | at-most-once, best-effort, 5s per-attempt timeout |
| Authenticity | optional HMAC-SHA256 in `X-Webhook-Signature` (register a `secret`) |
| Correlation key | `jobId` (the local transcode job id) |
| Primary billable field | `encodeDurationMs` (milliseconds, excluding retries) |

## Contract sources (verified in-branch)

Every claim in this guide is grounded in code merged to `main`. The verified
symbols:

| Fact | Source symbol |
|---|---|
| Event name constant | `ENCODE_COMPLETION_EVENT_TYPE = 'encode.completed'` — `src/pipeline/encode-completion-event.ts:72` |
| Payload schema + inferred type | `encodeCompletionEventSchema` / `EncodeCompletionEvent` — `src/pipeline/encode-completion-event.ts:133,201` |
| Resolution-tier enum + boundaries | `RESOLUTION_TIERS`, `resolutionTierForHeight(...)` — `src/pipeline/encode-completion-event.ts:87,98` |
| Duration derivation | `encodeDurationMsFromAttempt(...)` — `src/pipeline/encode-completion-event.ts:225` |
| Transport decision | ADR-022 — `docs/architecture/ADR-022-encode-completion-event-transport.md` |
| Payload schema doc | `docs/architecture/encode-completion-event.md` |
| Subscribable event registered | `WEBHOOK_EVENT_TYPES` includes `ENCODE_COMPLETION_EVENT_TYPE` — `src/data/webhook-repo.ts:28-36` |
| Emission point | `buildEncodeCompletionEvent(...)` + `dispatch({ type: ENCODE_COMPLETION_EVENT_TYPE, payload })` — `src/routes/internal.ts:242,646` |
| Wire envelope | `{ event, payload, timestamp }` — `src/services/webhook-dispatcher.ts:85-89` |
| HMAC-SHA256 header | `x-webhook-signature: sha256=<hex>` — `src/services/webhook-dispatcher.ts:116-119` |
| Per-delivery timeout | `DELIVERY_TIMEOUT_MS = 5_000` — `src/services/webhook-dispatcher.ts:21,110` |
| Subscription API + validation | `webhooksRouter`, `createBodySchema` — `src/routes/webhooks.ts:37-71` |
| Registration API auth | `Authorization: Bearer <token>` — `src/auth/middleware.ts:28,42` |

---

## 1. Subscribe (endpoint / topic)

The event travels over open-videocore's existing outbound-webhook subsystem
(ADR-022 Option A). There is no separate topic or broker — you register an HTTPS
endpoint of your own and open-videocore POSTs to it when a transcode settles.

Register once against the running open-videocore instance:

```http
POST /api/v1/webhooks
Authorization: Bearer <OSC access token>
Content-Type: application/json

{
  "url": "https://metering.example.osaas.io/hooks/encode-completed",
  "events": ["encode.completed"],
  "secret": "<a shared secret you generate>"
}
```

Request body contract (`createBodySchema`, `src/routes/webhooks.ts:37-41`):

| Field | Required | Rule |
|---|---|---|
| `url` | yes | valid `http`/`https` URL, max 2048 chars |
| `events` | yes | non-empty array; each value must be a known event type. Use `["encode.completed"]`. |
| `secret` | no (strongly recommended) | 1–256 chars; enables HMAC signing of every delivery |

Responses:

- `201 Created` — returns the registration `{ id, url, events, secret?, createdAt }`. The `secret` is echoed **only** in this create response; store it now.
- `400 Bad Request` — body failed validation (e.g. an unknown event type or a non-URL `url`), shape `{ error, message? }`.
- `401 Unauthorized` — missing/invalid bearer token (`WWW-Authenticate: Bearer`).

You can list your registrations with `GET /api/v1/webhooks` and remove one with
`DELETE /api/v1/webhooks/:id` (idempotent; always `204`).

## 2. Payload example

When a transcode job applies its successful completion, open-videocore emits
`encode.completed` **in addition to** the existing `transcode.complete`
lifecycle event. Your endpoint receives the standard webhook envelope; the
`encode.completed` payload sits under `payload`.

Wire envelope (`src/services/webhook-dispatcher.ts:85-89`):

```json
{
  "event": "encode.completed",
  "payload": { "...see below..." },
  "timestamp": "2026-09-16T10:42:07.913Z"
}
```

Concrete `payload` (an `EncodeCompletionEvent`, all fields taken from the real
schema in `src/pipeline/encode-completion-event.ts`):

```json
{
  "eventType": "encode.completed",
  "jobId": "job_01HZY4T3M8QK7V2R9F6BXC0AAB",
  "assetId": "asset_01HZY4S1P0N3E5D7C9B2A4XZ01",
  "encodeDurationMs": 42815,
  "resolutionTier": "fhd",
  "occurredAt": "2026-09-16T10:42:07.902Z",
  "codec": "h264",
  "height": 1080,
  "width": 1920,
  "bitrateBps": 5000000,
  "profile": "abr-vod",
  "renditionCount": 4
}
```

> The example above shows every field the platform emits today. `completedAt`
> and `outputFormat` are permitted by the schema but are **not** currently
> emitted — see the note under the field reference below. Do not build metering
> logic that expects them.

### Field reference

**Always present (required by the schema):**

| Field | Type | Meaning |
|---|---|---|
| `eventType` | `"encode.completed"` literal | route/discriminate on this |
| `jobId` | non-empty string | correlation key for attribution (local transcode `Job.id`) |
| `assetId` | non-empty string | the source asset the encode was produced for |
| `encodeDurationMs` | integer >= 0 | **encode compute time in MILLISECONDS**, excluding retries (see units) |
| `resolutionTier` | `sd` \| `hd` \| `fhd` \| `uhd` \| `unknown` | coarse resolution bucket of the produced variant |
| `occurredAt` | ISO-8601 UTC string | authoritative event time |

**Emitted when derivable at completion (optional, but populated by the emitter today):**

| Field | Type | Meaning |
|---|---|---|
| `codec` | string | e.g. `"h264"`, `"hevc"` (free string; no codec enum) |
| `height` | integer > 0 | produced variant pixel height |
| `width` | integer > 0 | produced variant pixel width |
| `bitrateBps` | integer >= 0 | overall bitrate in **bits per second** |
| `profile` | string | encode profile name used |
| `renditionCount` | integer >= 0 | number of renditions this completion produced |

Each of these is set only when its source value is present at completion
(`buildEncodeCompletionEvent`, `src/routes/internal.ts:255-270`): `codec`,
`height`, `width`, `bitrateBps` come from the produced variant and `profile`
from the job; any absent source value is omitted (not defaulted).

**Schema-permitted but NOT currently emitted by the platform today:**

| Field | Type | Meaning |
|---|---|---|
| `outputFormat` | string | container/segment format, e.g. `"mp4"`, `"fmp4"` |
| `completedAt` | ISO-8601 UTC string | job terminal-transition time |

These two fields are declared **optional** in `encodeCompletionEventSchema`
(`src/pipeline/encode-completion-event.ts:180,198`) so the contract can carry
them in future, but the only emission path,
`buildEncodeCompletionEvent(...)` (`src/routes/internal.ts:242-272`), **never
sets either one** — it derives no `completedAt` and no `outputFormat`. The
emission integration test asserts exactly the emitted-field set and never these
two (`src/routes/internal.encode-completion.test.ts:155-174`). **A consumer will
not receive `outputFormat` or `completedAt` today; do not build metering logic
that depends on them.** Use `occurredAt` (required) as the completion timestamp.

### Units — part of the contract, do not misread

- **`encodeDurationMs` is MILLISECONDS, not seconds.** Divide by 1000 for
  seconds. It is the *excluding-retries* duration (the last successful encode
  attempt's `endedAt - startedAt`, ADR-012 Decision 3).
- **`bitrateBps` is bits per second.**
- **All timestamps are ISO-8601 UTC** (the emitted `occurredAt` and the envelope
  `timestamp`; the schema-declared-but-not-emitted `completedAt` would also be
  ISO-8601 UTC if it were ever populated — see the note above).

### Resolution-tier boundaries (`resolutionTierForHeight`)

| Tier | Height range |
|---|---|
| `sd` | `height < 720` |
| `hd` | `720 <= height < 1080` |
| `fhd` | `1080 <= height < 2160` |
| `uhd` | `height >= 2160` |
| `unknown` | missing / non-positive height |

`unknown` is an explicit bucket — you will never be handed a real tier for a
completion whose resolution could not be measured. Decide your billing policy
for `unknown` explicitly.

### Two edge cases worth knowing

1. **`encodeDurationMs` can be `0`.** The schema helper returns `undefined` when
   the attempt timing pair is missing/unparseable, but the emitter records
   `encodeDurationMs: encodeDurationMs ?? 0` (`src/routes/internal.ts:261`). A
   value of exactly `0` therefore means "duration could not be measured," not "a
   zero-length encode." Treat `0` as unmeasured in your metering logic.
2. **Use `occurredAt` as the completion timestamp — `completedAt` is not
   emitted.** `occurredAt` (required) is the authoritative event time and is what
   you should key on. `completedAt` is schema-permitted but the emitter never
   populates it today (`buildEncodeCompletionEvent`,
   `src/routes/internal.ts:255-270`), so you will not receive it — do not key
   any metering logic on it. If a job's exact terminal-transition instant is
   ever needed and distinct from `occurredAt`, that would be a future emitter
   change, not something the current contract provides.

## 3. Auth

Two distinct auth concerns:

- **Registering a webhook** (calling `POST /api/v1/webhooks`) requires
  `Authorization: Bearer <OSC access token>`; a missing/invalid token gets `401`
  with `WWW-Authenticate: Bearer` (`src/auth/middleware.ts:28,42`). This is the
  same OSC access-token wall that fronts the rest of the API.
- **Verifying an incoming delivery** on your endpoint uses the shared `secret`
  you set at registration. When a `secret` is present, open-videocore signs the
  raw JSON request body with HMAC-SHA256 and sends the lowercase hex digest in
  the `X-Webhook-Signature` header, prefixed `sha256=`
  (`src/services/webhook-dispatcher.ts:116-119`):

  ```
  X-Webhook-Signature: sha256=<hmac_sha256_hex_of_raw_body>
  ```

  Verify by computing `HMAC-SHA256(secret, rawBody)` over the **raw** request
  body (before any JSON re-serialisation) and comparing with a constant-time
  compare. Reject the delivery — and do not deduct tokens — if it does not
  match. Registering a `secret` is optional but **strongly recommended** for a
  billing consumer; without one, deliveries are unsigned.

  No open-videocore client library, SDK, or broker credential is required — only
  the shared secret and an HTTPS endpoint.

## 4. Retry guidance

**open-videocore does not retry deliveries.** Per ADR-022, delivery is
best-effort, fire-and-forget, at-most-once:

- Each delivery attempt has a **5-second timeout**
  (`DELIVERY_TIMEOUT_MS = 5_000`, `src/services/webhook-dispatcher.ts:21`).
- A non-2xx response, a network error, or a timeout is logged and swallowed on
  the open-videocore side; there is **no automatic re-delivery** and no
  exponential-backoff queue.
- Your endpoint should return a `2xx` quickly (well under 5s) and do the heavy
  metering work asynchronously, so a slow consumer never causes a dropped
  delivery.

Because delivery is at-most-once, a metering consumer must not treat the webhook
as the sole source of truth. The recommended pattern (ADR-022 Consequences):

1. **De-duplicate on `jobId`.** Redelivery from open-videocore is guarded by the
   `result.applied` idempotency check (`src/routes/internal.ts:626`), so a
   redelivered Encore callback never double-fires. Still, make your handler
   idempotent by `jobId` so a retried delivery from a proxy in front of you is
   harmless.
2. **Reconcile missed events via REST.** The billable facts are durably retained
   on the job/asset records (encode attempt log per ADR-012, renditions on the
   asset). If your endpoint was down during a delivery window, read the
   job/asset back through the existing REST API to recover the same values —
   the webhook is a push convenience, not the system of record.
3. **`encodeDurationMs == 0` handling** — see edge case 1 above; classify as
   unmeasured rather than free.

If open-media-convert later needs guaranteed, replayable delivery, ADR-022
records the documented upgrade path (a durable broker, Option B), which would be
captured in a follow-up ADR at that time. Until that requirement is
demonstrated, at-most-once webhook + REST reconciliation is the accepted
contract.

## 5. Timeline

- **#691 — payload schema:** merged (PR #696).
- **#692 / ADR-022 — transport (signed outbound webhook):** merged (PR #697).
- **#693 — emission of `encode.completed`:** **shipped to `main`** in PR #698
  (commit `1665f486032a1ef358649014b083eeeecb314432`, 2026-09-15).
- **This guide (#694):** the shape and delivery timeline communicated to the
  open-media-convert team. Review-by deadline 2026-09-27.

The contract above is live and stable now. open-media-convert#132 and
open-media-convert#142 can integrate against it as documented — subscribe with
`POST /api/v1/webhooks`, verify the `X-Webhook-Signature`, meter on
`jobId` + `encodeDurationMs` + `resolutionTier`, and reconcile any missed
deliveries via the REST job/asset records.
