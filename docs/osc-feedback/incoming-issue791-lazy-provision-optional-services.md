# OSC friction — lazy provisioning of the optional pipeline services (issue #791)

**Date:** 2026-09-24
**Reporter:** surface-infra agent
**Context:** Evaluating whether `eyevinn-function-scenes` (scene detection) and
`eyevinn-auto-subtitles` (subtitles) can be provisioned on demand, at first use,
instead of eagerly at stack-provisioning time. Decision recorded in
`docs/architecture/ADR-023-lazy-provisioning-optional-osc-services.md`.

Issue #791's third bullet asks explicitly: *"If not feasible today, log the gap to
`docs/osc-feedback/`."* One of the two services is not feasible today, so this is
that log. It also records two platform-level frictions that made the evaluation
harder than it needed to be.

---

## 1. `eyevinn-auto-subtitles` cannot be lazily provisioned, and cannot be repaired in place

**What we wanted.** Provision the subtitle service the first time a pipeline runs
a `subtitles` step, so an operator who did not opt in at stack-provision time does
not have to re-provision the stack to enable subtitles.

**Why we cannot.** Two properties of the service, in combination:

1. The create-service-instance config requires `openaikey` — an operator-supplied
   OpenAI/Whisper key — in addition to `name`. At an arbitrary first-use moment
   the API has no way to obtain that key unless the operator already supplied it
   out of band, so lazy provisioning cannot be unconditional.
2. The service reports `supportsUpdate: false` (recorded in this repo as *"No
   config update support (delete + create to change config)"*). So an instance
   created with a missing, stale or wrong key **cannot be patched**. It has to be
   destroyed and recreated.

Property 2 is what turns property 1 from an inconvenience into a blocker. A lazy
path that guessed, or that provisioned optimistically and hoped to fix the key
later, would leave a **billable, unusable instance** that only an explicit
deprovision can clear. Skipping the step is strictly safer than provisioning
speculatively.

**What would unblock this from the OSC side**, in rough order of usefulness:

- **`update-service-instance` support for `eyevinn-auto-subtitles`** (even
  restricted to the secret fields). Being able to patch `openaikey` on a running
  instance would make an optimistic lazy provision safe, and would also fix key
  **rotation**, which today requires a full deprovision + reprovision cycle
  through `DELETE`/`POST /api/v1/optional-services/auto-subtitles`.
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

## 3. OSC MCP tooling was unreachable, so the contract could not be re-verified

CLAUDE.md rule 7 requires fetching the live contract before asserting a service
schema. In the execution context available for #791 that was impossible:

- `ToolSearch` — the documented mechanism for loading
  `mcp__OSC__get-service-schema` / `mcp__OSC__list-available-services` — returned
  *"No such tool available: ToolSearch. ToolSearch is disabled for this session,
  in subagents as well as here."*
- No OSC MCP tool was directly invokable.
- `node_modules/@osaas` contains only `client-core`, which ships no generated
  per-service schema or types, so the contract was not reachable offline either.

This is the **third** time this has blocked contract verification for a
provisioning task in this project — see
`docs/osc-feedback/incoming-epic226-ondemand-packager-schema.md` for the same
symptom during the on-demand packager work. It is a recurring tax on exactly the
kind of work (service provisioning) where guessing a field name is least
acceptable.

**How we stayed grounded without inventing anything.** Every catalog fact in
ADR-023 is cited to a `get-service-schema` verification already recorded *in this
repository* at the time the eager provisioning path was written
(`src/services/optional-services.ts:20-26`, `src/routes/provision.ts:1089-1096`
and `:1118-1120`, `src/pipeline/scene-detector.ts:32-37`,
`src/pipeline/osc-scene-detect.ts:11-29` — dated 2026-07-12/13), cross-checked
against the independent OSC verification carried out on the #791 issue thread on
2026-09-24. The two agree on every field. No field name, type or requirement in
ADR-023 is asserted from memory.

**Ask:** either a reliably available `get-service-schema` in automated/agent
contexts, or a published, versioned, fetchable schema document per service
(something a plain HTTP GET can retrieve) so a build or an agent can verify a
create body without an interactive MCP session.

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
