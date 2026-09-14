# ADR-022: Encode-completion event transport

**Status:** PROPOSED 2026-09-14
**Date:** 2026-09-14
**Author agent:** claude-opus-4-8
**Issue:** #692 (transport decision). Sub-issue of #690; sibling of #691
(payload schema, PR #696) and #693 (emission). This ADR decides ONLY how the
event travels; it does not define the payload (#691) or wire the emitter (#693).

---

## Context

#690 asks open-videocore to expose an encode-completion event so an external
consumer — OSC Platform's token-metering / money-manager function — can deduct
plan tokens when a transcode settles. The work was split three ways:

- **#691 — payload schema** (already implemented on PR #696). It defines the
  canonical payload (`encodeCompletionEventSchema` / `EncodeCompletionEvent`,
  event name `encode.completed`, constant `ENCODE_COMPLETION_EVENT_TYPE`) in
  `src/pipeline/encode-completion-event.ts`, documented in
  `docs/architecture/encode-completion-event.md`. #691 explicitly deferred the
  transport decision to this ADR.
- **#692 — transport** (this ADR).
- **#693 — emission** (build the payload at the completion boundary and hand it
  to the transport chosen here).

This ADR must answer one question: **by what mechanism does open-videocore
deliver an `encode.completed` event to an external consumer that has no
proprietary dependency on open-videocore's internals?** Per CLAUDE.md rule 7 the
decision is grounded in what this repo already does for outbound notification,
verified in-branch before proposing anything.

## Verified contract sources (CLAUDE.md rule 7)

Every symbol below was read in this branch before citing.

### There is already a first-class outbound-webhook subsystem (issue #13)

open-videocore already ships a complete, consumer-facing outbound event
delivery mechanism. It is not incidental plumbing — it is a documented public
feature:

- **Typed event vocabulary.** `WEBHOOK_EVENT_TYPES` —
  `src/data/webhook-repo.ts:18-25` — a `const` string-union of the events
  open-videocore emits (`asset.ready`, `asset.failed`, `transcode.complete`,
  `transcode.failed`, `package.complete`, `package.failed`). The exported type
  `WebhookEventType` (`webhook-repo.ts:27`) is derived from it.
- **Consumer-facing subscription API.** `webhooksRouter` —
  `src/routes/webhooks.ts:47-103` — exposes, behind the standard auth wall:
  - `POST /api/v1/webhooks` — register `{ url, events, secret? }`
    (`webhooks.ts:58-71`); `events` is validated against `WEBHOOK_EVENT_TYPES`
    (`z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1)`, `webhooks.ts:39`), `url`
    must be a valid http(s) URL (`webhooks.ts:38`).
  - `GET /api/v1/webhooks` — list registrations (`webhooks.ts:73-85`).
  - `DELETE /api/v1/webhooks/:id` — remove one (`webhooks.ts:87-102`).
- **Persistence.** `WebhookRepository` (`src/data/webhook-repo.ts:46-50`) with
  in-memory and CouchDB implementations
  (`inmemory-webhook-repo.ts`, `couch-webhook-repo.ts`), both workspace-scoped.
- **Delivery engine.** `WebhookDispatcher` —
  `src/services/webhook-dispatcher.ts:47-133`:
  - `dispatch(event: WebhookEvent)` (`webhook-dispatcher.ts:67`) looks up the
    registrations subscribed to `event.type` and POSTs to each. `WebhookEvent`
    is `{ type: string; payload: unknown }` (`webhook-dispatcher.ts:23-26`).
  - Delivery is **fire-and-forget and best-effort**: it never throws into the
    caller, a failure is logged and swallowed, and it never fails the
    originating request (`webhook-dispatcher.ts:60-76,91-106`).
  - Each attempt has a **5-second timeout** via `AbortController`
    (`DELIVERY_TIMEOUT_MS = 5_000`, `webhook-dispatcher.ts:21,108-125`).
  - The wire envelope is `{ event, payload, timestamp }` where `timestamp` is
    `new Date().toISOString()` (`webhook-dispatcher.ts:85-89`).
  - When the registration carries a `secret`, the body is signed with
    **HMAC-SHA256** and sent as `X-Webhook-Signature: sha256=<hex>`
    (`webhook-dispatcher.ts:108-119`), so the receiver can verify authenticity
    with a shared secret only — no open-videocore-specific client library.

### The event is already emitted at the transcode-completion boundary

The completion point the metering event must ride is **already firing webhook
events today**:

- `src/routes/internal.ts:567-590` — on a transcode callback that actually
  applied (`result.applied`, so redelivered Encore callbacks never double-fire),
  the handler calls `opts.webhookDispatcher.dispatch(...)` with
  `{ type: 'transcode.complete', payload: { assetId, renditionCount } }` on
  success (`internal.ts:570-573`) and `transcode.failed` on failure
  (`internal.ts:581-584`). The comment at `internal.ts:563-566` documents this
  as the subscriber-notification path and notes the delivery failure never
  affects the 200 response.
- `src/pipeline/transcode.ts:192` — `completeTranscode(...)`, the idempotent
  apply-completion function (duplicate/terminal callbacks no-op,
  `transcode.ts:206-213`), returns `CompleteTranscodeResult { applied,
  renditionCount }` (`transcode.ts:181-186`). This is the same boundary #693
  will emit `encode.completed` from, per the #691 schema doc.
- The dispatcher is already wired into the internal route via
  `opts.webhookDispatcher` (`WebhookDispatcher` imported at
  `internal.ts:42`) and constructed in `src/main.ts` (grep: `webhookDispatcher`
  in `src/main.ts`).

### No competing outbound mechanism exists

There is **no** message-bus / queue producer, no pollable "events feed"
endpoint, and no other outbound-notification abstraction in the codebase for
domain events. The only outbound domain-event path is the issue-#13 webhook
subsystem above. (The Valkey/Redis usage in `src/encore-scaler/*` is internal
scaler/retry state, not a consumer-facing event bus; the packager/Encore
callbacks in `src/routes/internal.ts` are inbound to open-videocore, not
outbound to a metering consumer.) There is therefore no established
queue/polling pattern to extend — only the webhook one.

## Options considered

### Option A — Reuse the existing outbound webhook subsystem *(chosen)*

Add `encode.completed` to `WEBHOOK_EVENT_TYPES` and dispatch the #691 payload
through the existing `WebhookDispatcher` at the completion boundary. A consumer
registers its callback URL (and a shared secret) via `POST /api/v1/webhooks`
subscribing to `encode.completed`.

- **Pros:** zero new runtime dependency; reuses the exact pattern the consumer
  already integrates against for `transcode.complete`; HMAC-signed, timeout- and
  failure-isolated delivery already exists; the subscription API, persistence,
  and validation are all already public; composes trivially with #691 (its
  `payload` is a `WebhookEvent.payload`); gives #693 an unambiguous one-line
  target. Consumable with nothing but an HTTP endpoint + shared secret — no
  proprietary client.
- **Cons:** at-most-once, best-effort delivery — a receiver that is down during
  the 5-second window misses the event (see Consequences for the mitigation
  path and why it does not block metering correctness now).

### Option B — Introduce a durable message/queue service

Publish `encode.completed` to a durable broker (an OSC catalog message/queue
service, referenced by role only — a persistent-subscription broker) and have
the consumer subscribe.

- **Pros:** durable, replayable, decouples producer/consumer availability;
  natural fit if metering must never drop an event.
- **Cons:** introduces a runtime dependency and an operational surface this repo
  does not have today (no producer/consumer code, no broker in ADR-001's stack
  for this purpose). It also changes the consumer's integration shape from "an
  HTTP endpoint" to "a broker subscription", which is a heavier ask than the
  existing webhook contract the consumer already speaks. **Rejected for now** as
  premature: it solves a durability problem we have not yet been shown to have,
  at the cost of a new dependency, contradicting rule 7's "prefer reusing an
  established pattern over inventing a new dependency". It is retained as the
  documented upgrade path (see Consequences).
- **OSC note (rule 7):** I could not introspect any specific OSC catalog
  queue/broker service contract in this session (no live OSC introspection
  available). Per the task rules this ADR therefore references such a service by
  **role only** and does not name or assume its schema. This gap is logged as
  OSC friction (see below).

### Option C — Pollable events endpoint

Expose `GET /api/v1/events?since=...` returning a page of recent
completion events for the consumer to poll.

- **Pros:** consumer pulls on its own schedule; no delivery-availability
  coupling; no outbound egress needed.
- **Cons:** requires a new durable, ordered, queryable event store and cursor
  semantics that do not exist in the repo (a wholly new subsystem); polling adds
  latency and load; it is a second, parallel event mechanism competing with the
  existing webhook subsystem. **Rejected:** highest net-new surface for the least
  reuse.

## Decision

**Deliver `encode.completed` over the existing issue-#13 outbound webhook
subsystem (Option A).** Concretely, the contract #693 implements against:

1. **Transport = signed outbound HTTP webhook** via `WebhookDispatcher.dispatch`
   (`src/services/webhook-dispatcher.ts:67`). The event travels as the existing
   envelope `{ event: "encode.completed", payload: <#691 EncodeCompletionEvent>,
   timestamp: <ISO-8601 UTC> }` (`webhook-dispatcher.ts:85-89`).
2. **Event type registration.** #693 adds the string `encode.completed` to
   `WEBHOOK_EVENT_TYPES` (`src/data/webhook-repo.ts:18-25`). This single change
   makes it a subscribable event: the `POST /api/v1/webhooks` validator
   (`src/routes/webhooks.ts:39`) then accepts it, with **no other route change
   required**. The event-name string is already fixed by #691 as
   `ENCODE_COMPLETION_EVENT_TYPE` (`encode.completed`); #693 must use that
   constant as the `WEBHOOK_EVENT_TYPES` member and as `WebhookEvent.type` so the
   two never drift.
3. **Emission point.** #693 dispatches at the same applied-success boundary that
   already fires `transcode.complete` (`src/routes/internal.ts:567-573`), reusing
   the `result.applied` idempotency guard so a redelivered Encore callback never
   double-meters. `encode.completed` is emitted **in addition to**, not instead
   of, `transcode.complete` — #691 defines it as a billing-oriented superset, not
   a replacement of the lifecycle event.
4. **Authenticity.** Delivery integrity relies on the existing per-registration
   HMAC-SHA256 signature (`X-Webhook-Signature`,
   `webhook-dispatcher.ts:116-119`). A metering consumer SHOULD register with a
   `secret` and verify the signature before deducting tokens.
5. **No proprietary dependency.** The consumer needs only: an HTTPS endpoint, a
   shared secret, and the #691 payload schema. No open-videocore client library,
   no broker, no OSC-specific SDK. This satisfies #690's "consumable by
   downstream token-metering systems without proprietary dependencies".

## How it composes with the #691 payload schema

The transport carries the #691 payload unchanged. `WebhookEvent.payload` is
typed `unknown` (`webhook-dispatcher.ts:24`), so #693 passes an
`EncodeCompletionEvent` (`src/pipeline/encode-completion-event.ts`) straight
through; the dispatcher wraps it in the standard `{ event, payload, timestamp }`
envelope. The envelope's outer `timestamp` is the *delivery* time; the payload's
own `occurredAt` (a required #691 field) remains the authoritative *event* time.
There is intentionally no re-definition of any field here — the schema is #691's
sole responsibility and this ADR does not touch it.

## Consequences

- **#693 has an unambiguous target:** add `encode.completed` to
  `WEBHOOK_EVENT_TYPES`; call `webhookDispatcher.dispatch({ type:
  ENCODE_COMPLETION_EVENT_TYPE, payload })` at the `result.applied` success
  branch in `src/routes/internal.ts`; build `payload` with the #691 schema +
  helpers. No new service, route, dependency, or config is introduced by the
  transport decision.
- **Delivery is best-effort / at-most-once.** A consumer offline during the
  5-second delivery window misses that event. For token metering this is a real
  risk to acknowledge. Two mitigations that do **not** change this transport
  decision: (a) the caller-facing job record already durably retains the billable
  facts (`encodeAttemptLog` / `encodeAttempts` per ADR-012, plus renditions on
  the asset), so a consumer can **reconcile** any missed event by reading the
  job/asset via the existing REST API; (b) if metering later requires
  guaranteed, replayable delivery, the documented upgrade path is Option B (a
  durable broker), which would be recorded in a follow-up ADR at that time. Until
  such a requirement is demonstrated, at-most-once webhook + REST reconciliation
  is the accepted contract.
- **Single source of truth for the event name.** `encode.completed` now lives in
  two places by necessity — `ENCODE_COMPLETION_EVENT_TYPE`
  (`encode-completion-event.ts`, owned by #691) and the `WEBHOOK_EVENT_TYPES`
  member (`webhook-repo.ts`, added by #693). #693 MUST make the latter reference
  the former constant (not a duplicated literal) so they cannot drift; a mismatch
  would silently drop deliveries (dispatcher matches on exact `type` string,
  `webhook-dispatcher.ts:80`).
- **No behaviour change from this ADR alone.** This is a docs-only decision;
  emission is #693. `pnpm typecheck` is unaffected.
- **OSC dependency surface is unchanged.** Option A adds no OSC service. If a
  future move to Option B adopts an OSC catalog message/queue service, that ADR
  must first introspect and cite the concrete service contract (which was not
  available to introspect here).

## Acceptance mapping (issue #692)

- **Transport evaluated and decided** — Options A/B/C above; Decision = reuse the
  existing outbound webhook subsystem.
- **Grounded in what the repo already does** — verified `WEBHOOK_EVENT_TYPES`,
  `webhooksRouter`, `WebhookDispatcher`, and the existing `transcode.complete`
  emission at `src/routes/internal.ts:567-573` before deciding.
- **No proprietary dependency** — consumable with an HTTPS endpoint + shared
  secret + the #691 schema.
- **OSC catalog service referenced by role only** where relevant (Option B),
  with the introspection gap logged as friction.
- **Composes with #691** — carries the `EncodeCompletionEvent` payload unchanged.
- **Gives #693 a concrete target** — see Decision + Consequences.

## Contract sources verified

| Claim | Source symbol / line |
|---|---|
| Typed emittable event vocabulary (`const` union) | `src/data/webhook-repo.ts:18-27` (`WEBHOOK_EVENT_TYPES`, `WebhookEventType`) |
| Consumer-facing subscription API (register/list/delete) | `src/routes/webhooks.ts:47-103`; event validation `webhooks.ts:39` |
| Registration persistence interface + impls | `src/data/webhook-repo.ts:46-50`; `inmemory-webhook-repo.ts`, `couch-webhook-repo.ts` |
| Fire-and-forget, never-throws delivery | `src/services/webhook-dispatcher.ts:60-76,91-106` |
| Per-delivery 5s timeout | `src/services/webhook-dispatcher.ts:21,108-125` |
| Wire envelope `{ event, payload, timestamp }` | `src/services/webhook-dispatcher.ts:85-89` |
| HMAC-SHA256 signature `X-Webhook-Signature` | `src/services/webhook-dispatcher.ts:108-119` |
| Existing `transcode.complete` emission at completion boundary | `src/routes/internal.ts:563-590` |
| Idempotent completion apply (`applied` guard) | `src/pipeline/transcode.ts:181-213` |
| #691 event name / schema this transport carries | `docs/architecture/encode-completion-event.md`; `src/pipeline/encode-completion-event.ts` (`ENCODE_COMPLETION_EVENT_TYPE`, `EncodeCompletionEvent`) |
| Durable billable facts for reconciliation | `docs/architecture/ADR-012-encode-attempt-shape.md` (`encodeAttemptLog`, Decision 3) |
