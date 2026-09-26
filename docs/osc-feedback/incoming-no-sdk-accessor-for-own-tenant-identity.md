# No SDK accessor for the calling deployment's own tenant identity (issues #776, #804)

**Service / package:** `@osaas/client-core` (OSC SDK), `eyevinn-app-config-svc`
**Observed:** 2026-09-24, read-only introspection against a live account
**Logged for:** issue #804 (a fresh stack could not transcode), issue #776 (the
namespace varied between boots of the same instance)
**Cited from:** `src/services/workspace-stack.ts` (`readTenantIdFromOsc`,
`readTenantIdFromCredential`)

## Friction 1 — the SDK offers no accessor for "which tenant am I?"

An application deployed on OSC needs its own tenant identity as a stable label:
open-videocore uses it as the `<workspaceId>` segment of its parameter-store keys
(`openvideocore/<workspaceId>/<stackName>`, `src/services/param-store.ts:131`), so
every boot of the same deployment must resolve the same value.

`@osaas/client-core` exposes no accessor for this. The `Context` carries the
credential (`getPersonalAccessToken(): string | undefined`,
`lib/context.d.ts:23`) and the SDK sends it as `x-pat-jwt: Bearer <pat>` on every
catalog call (`lib/admin.js`), so the platform knows exactly which tenant the
caller is on every request — but there is no `getTenantId()` / `whoAmI()` /
`getCurrentTenant()` to ask for it back.

Consumers are therefore pushed to one of two workarounds, both unsatisfying:

1. **Infer it from `listSubscriptions()`** — which is what open-videocore did
   first, and which is wrong (see friction 2). The subscription list describes the
   services the deployment is subscribed *to*; the tenant ids on it belong to the
   *publishers* of those services, not to the caller.
2. **Decode the PAT payload in application code** — which is what open-videocore
   does now: split the JWT, base64url-decode the middle segment, read `tenantId`.
   It works and the claim is authoritative, but it requires the application to
   parse a credential it should only ever forward, and it depends on an
   undocumented claim name and token layout that the SDK is free to change.

**Ask:** an accessor on `Context` (or a small `whoAmI(context)` helper alongside
`listSubscriptions`) returning the tenant the supplied credential authenticates
as. A documented, typed answer would remove PAT parsing from every consumer that
needs a per-deployment key namespace.

## Friction 2 — `Subscription.tenantId` is declared non-optional but is usually absent

Declared contract (`@osaas/client-core` `lib/admin.d.ts:2-5,42`):

```ts
type Subscription = { serviceId: string; tenantId: string };
listSubscriptions(context: Context): Promise<Subscription[]>;
```

Observed payload on a live account (2026-09-24), same credential:

- 13 subscriptions returned;
- **10 carried no `tenantId` property at all**, despite the type declaring it
  `string` and not `string | undefined`;
- the 3 that did carry one split across **two distinct values**, each naming the
  publisher/owner tenant of the subscribed service rather than the caller;
- consequently, "first/smallest `tenantId` in the list" — a reasonable reading of
  the declared type — returns a tenant the deployment does not own.

Two consequences hit open-videocore in production:

- **Non-determinism (#776).** The same instance resolved a different namespace on
  different boots, because list membership changes as service instances come and
  go, and an empty/unreachable list fell through to a literal default.
- **A wrong, then persisted, namespace (#804).** Once the derived value was
  persisted for stability, the incorrect derivation was frozen for the life of the
  stack. Reads that still addressed the literal default namespace then missed, and
  the scaler handed Encore no S3 endpoint — so Encore resolved `s3://` inputs
  against AWS and every transcode failed with
  `ffprobe failed ... Server returned 404 Not Found`, with nothing in the error
  naming the real cause.

**Ask:** either make the declaration honest (`tenantId?: string`) so TypeScript
consumers are forced to handle the absent case, or populate it on every entry.
Silently omitting a non-optional field means the compiler actively endorses the
wrong code. Documenting *whose* tenant it is — publisher, not subscriber — would
also help; that is not inferable from the field name.

## Impact / severity

Medium-to-high for any application that needs a stable per-deployment identifier.
The failure mode is not a hard error at the SDK boundary: it returns a plausible
string, the application persists it, and the damage surfaces much later as an
unrelated-looking 404 from a different service.

## Workaround in place

`readTenantIdFromCredential` (`src/services/workspace-stack.ts`) decodes the PAT
payload and reads `tenantId`; the subscription-list read is retained only as a
fallback for when no PAT is present. The signature is deliberately not verified —
the value is never an authorisation decision, only a parameter-store key segment.
The namespace is then pinned in the deployment's own config-service instance so it
cannot drift between boots, and a pin that disagrees with the credential is
reconciled rather than trusted.
