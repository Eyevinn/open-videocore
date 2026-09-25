# OSC friction — lazy provisioning of the optional pipeline services (issue #791)

**Date:** 2026-09-24
**Reporter:** surface-infra agent
**Context:** Evaluating whether `eyevinn-function-scenes` (scene detection) and
`eyevinn-auto-subtitles` (subtitles) can be provisioned on demand, at first use,
instead of eagerly at stack-provisioning time. Decision recorded in
`docs/architecture/ADR-023-lazy-provisioning-optional-osc-services.md`.

Issue #791's third bullet asks explicitly: *"If not feasible today, log the gap to
`docs/osc-feedback/`."* One of the two services is not feasible today, so this is
that log.

**Scope note (revised 2026-09-25).** All catalog facts below were re-verified
against the **live** `get-service-schema`, not against memory or repo comments.
That re-verification changed this log: §1's second premise is downgraded from an
asserted fact to an open question, and a third item claiming the OSC MCP was
unreachable has been **retracted** (§3) — it was our own tooling, not OSC. What
remains for Eyevinn is one genuine gap (§1) and one genuine SDK ask (§2).

---

## 1. `eyevinn-auto-subtitles` cannot be lazily provisioned, and cannot be repaired in place

**What we wanted.** Provision the subtitle service the first time a pipeline runs
a `subtitles` step, so an operator who did not opt in at stack-provision time does
not have to re-provision the stack to enable subtitles.

**Why we cannot.** One verified blocker, plus one risk we cannot size:

1. **Verified against the live catalog (`get-service-schema`, 2026-09-25).** The
   create-service-instance config requires `openaikey` — an operator-supplied
   OpenAI/Whisper key — in addition to `name`. At an arbitrary first-use moment
   the API has no way to obtain that key unless the operator already supplied it
   out of band, so lazy provisioning cannot be unconditional. **This alone is
   sufficient**; it is the whole of the gap we are reporting.
2. **Not verified — and we could not verify it from the catalog.** Whether an
   instance created with a missing, stale or wrong key can be **patched** is
   unknown. `get-service-schema` returns *"Update Support: Not confirmed at
   schema-query time"* for this service (and, identically, for
   `eyevinn-function-scenes` and `eyevinn-encore-packager`). Our own repo
   recorded *"No config update support (delete + create to change config)"* back
   on 2026-07-12, but we cannot reproduce that from the catalog today, and we
   have not attempted `update-service-instance` against a live instance to
   settle it.

Because the downside of guessing wrong on (2) is unbounded — a lazy path that
provisioned optimistically and hoped to fix the key later would leave a
**billable, unusable instance** that only an explicit deprovision can clear — we
designed for the worst case. Skipping the step is strictly safer than
provisioning speculatively, regardless of how (2) resolves.

**What would unblock this from the OSC side**, in rough order of usefulness:

- **Expose update support in `get-service-schema`.** Today the only way to learn
  whether `eyevinn-auto-subtitles` supports `update-service-instance` is to
  attempt one and read the error — i.e. a **write** against a live, billable
  instance, which is not something an orchestrator can do speculatively just to
  plan. Reporting the flag in the read-only schema response would let a caller
  decide statically. (We note the tool description already anticipates this:
  *"absence means update support is unknown at schema-query time"*.)
- **Then: confirm whether `eyevinn-auto-subtitles` actually supports update**
  (even restricted to the secret fields), and if it does not, consider adding it.
  Being able to patch `openaikey` on a running instance would make an optimistic
  lazy provision safe, and would also fix key **rotation**, which today requires
  a full deprovision + reprovision cycle through
  `DELETE`/`POST /api/v1/optional-services/auto-subtitles`.
- **Deferred/late secret binding**: the ability to create an instance that
  references a secret name which does not exist yet, and have the instance become
  functional once the secret is populated. That would let a deployment provision
  the shape eagerly at zero marginal operator effort and bind the key whenever the
  operator supplies it.
- **A capability flag in `get-service-schema` for "can this be created from
  deployment-known inputs alone"**. Our whole evaluation reduced to: *does this
  service's create config require anything the deployment does not already know?*
  `eyevinn-function-scenes` needs only `name`, so the answer is no and lazy
  provisioning is trivial. `eyevinn-auto-subtitles` needs an operator secret, so
  the answer is yes. Today that distinction has to be derived by hand from the
  required-field list of every service. A machine-readable marker (e.g. which
  required fields are operator-supplied secrets vs. derivable) would let an
  orchestrator decide lazily-provisionable vs. not without a human reading
  schemas.

**Workaround shipped / confirmed durable.** Explicit operator provisioning stays
the primary path (`POST /api/v1/optional-services/auto-subtitles/provision
{name, openaikey, ...}`), and a `subtitles` step on a stack with no instance
settles as `skipped` with a reason naming the missing configuration rather than
failing the run. ADR-023 §5 records this as durable behaviour, not a stopgap.

---

## 2. `waitForInstanceReady` has no deadline parameter

`waitForInstanceReady(serviceId, name, ctx)` from `@osaas/client-core` accepts no
timeout, deadline or abort signal. Every call site in open-videocore therefore
waits an unbounded amount of time on instance readiness.

That is tolerable for a stack provision (a long-running operation the operator
already polls) and for the on-demand packager (packaging is an asynchronous,
callback-advanced step). It is **not** tolerable for a lazily provisioned service
consumed by a step that settles inside an HTTP request — which is exactly the case
for scene detection: an unbounded readiness wait would hold
`POST /api/v1/assets/:id/execute` open for the whole cold start.

The design in ADR-023 §4.5 works around it by racing the ensure step against a
hand-rolled `SCENE_DETECT_PROVISION_TIMEOUT_MS` deadline and, on timeout, leaving
the instance to finish coming up so a later execution adopts it. That is a
reasonable workaround, but every consumer of the SDK that has a request-scoped
deadline has to reinvent it (we already do so for the Encore callback-trust probe
via `ENCORE_CALLBACK_TRUST_TIMEOUT_MS`).

**Ask:** an optional `timeoutMs` / `AbortSignal` parameter on
`waitForInstanceReady`, with a clear contract for whether a timeout leaves the
instance running (it should — that is what makes adoption-on-retry safe).

---

## 3. NOT OSC friction — a retracted item, kept for honesty

An earlier revision of this log reported, as a third OSC friction item, that the
OSC MCP was *"unreachable from automated/agent contexts"* and asked Eyevinn for
*"a reliably available `get-service-schema` in automated/agent contexts."*

**That was wrong and is retracted. It was our tooling problem, not OSC's.** The
authoring session had its local tool-discovery mechanism (`ToolSearch`) disabled
and reasoned from that to "the contract is unreachable", without trying the MCP
endpoint directly. On re-checking, `https://mcp.osaas.io/mcp` was reachable and
working from exactly the kind of automated agent context we claimed it was not:
`initialize` returns `osc-remote-mcp` 8.10.0, and `get-service-schema` via the
`osc_call_tool` envelope returned full schemas for all three services we needed.
ADR-023 §2.1 now records the working method.

Nothing is being asked of Eyevinn here. The item is left in place rather than
deleted so that anyone who already read the earlier version sees the retraction,
and so the mistake does not get re-reported next time the local harness misleads
us. The prior packager-era report in
`docs/osc-feedback/incoming-epic226-ondemand-packager-schema.md` should be
re-checked against the same endpoint before it is acted on — it may have the same
root cause.

The lesson for us, not for OSC: a disabled local tool wrapper is not evidence
that a remote contract is unreachable. Probe the endpoint before escalating.

---

## 4. What DID work well

Worth recording, since this log is otherwise all friction:
`eyevinn-function-scenes` requiring **only** `name` is precisely what makes lazy
provisioning trivial for it. No secret, no wiring to sibling services, no
operator input — the create body is a pure function of the stack name. Every
optional, opt-in OSC service that can be designed this way gets on-demand
provisioning essentially for free, and the difference in implementation cost
between it and `eyevinn-auto-subtitles` is stark. That is a useful design
principle for new catalog entries: **if a service can derive its whole create
config from the deployment's own coordinates, it becomes lazily provisionable and
therefore zero-cost-until-used.**

Two more things the schema response gets right, worth keeping:

- **The platform instance-naming constraints are stated inline** in every
  `get-service-schema` response (`^[a-z0-9]+$`, `maxLength: 20`
  post-sanitization, with the K8s DNS-1035 reason given). That caught a real
  latent mismatch in our own code — we validate stack names at `max(63)` and use
  the stack name as the instance name — which we would otherwise have shipped
  into the lazy path. Stating the constraint *and its underlying reason* in the
  read-only response is exactly the right call.
- **`Service Dependencies` is machine-actionable**: *"Parameter `s3Endpoint`
  requires a `minio-minio` instance"* names the dependency, the protocol and the
  routing, and tells the caller which `create-service-instance` call satisfies
  it. That is the shape the capability marker asked for in §1 should take.
