# No way to DELETE (or read) an OSC secret, so per-stack credentials outlive their stack

- **Logged by:** `surface-infra`
- **Date:** 2026-10-03
- **Context:** issue #1094 — "issue per-stack object-store credentials at provision
  time and store them as OSC secrets" (core fix from #1089), implemented in
  `eng-open-videocore` on `issue-1094/per-stack-object-store-credentials`.

## Relationship to already-submitted feedback

This is a NEW, concrete consequence of a gap we have already submitted — do not
re-submit the general ask, extend it:

- `submitted-2026-06-02-06-readable-secret-api-gap.md` asked for a
  tenant-scoped secret API with create + **read** + list + delete. Still open.
- `incoming-shared-minio-root-credential-across-stacks.md` (#1089) is the
  security finding this issue fixes.

What #1094 adds to the picture: now that there is **one secret per stack**
rather than one per deployment, the missing **delete** is no longer a tidiness
problem — it is an unbounded leak of orphaned secret names, one set per stack
ever provisioned, and it makes a documented acceptance criterion
("the secret is deleted on teardown") impossible to satisfy from the SDK.

## What we were doing

Each provisioned stack's object store is now created with its own access key id
and secret access key instead of a single process-global `admin` + deployment
password. The secret is persisted as an OSC secret per consuming `serviceId`,
using the same mechanism as the external-backend credentials in #212:

```
saveSecret(serviceId, `${stackName}.${purpose}`, value, ctx)
// then reference it in the create body as {{secrets.<name>}}
```

Issue #1094's acceptance criteria include: *"Secret lifecycle is covered: it is
created on provision and deleted on teardown."*

## The friction

`@osaas/client-core` (v. vendored in this repo) exposes exactly **one** secret
operation:

- `saveSecret(serviceId: string, name: string, value: string, ctx: Context): Promise<void>`
  — `lib/core.d.ts:154`; implementation `lib/core.js:355-369`, a
  `POST https://deploy.svc.<env>.osaas.io/mysecrets/<serviceId>` with
  `{ secretName, secretData }` and an `x-pat-jwt` bearer.
- `valueOrSecret(value: string): string` — `lib/core.d.ts:152`, a *display*
  helper that masks a `{{secrets}}`-prefixed value as `***`.

`lib/index.d.ts` exports nothing else secret-related. There is:

- **no delete** — no `removeSecret`/`deleteSecret`, and no documented
  `DELETE /mysecrets/<serviceId>/<name>`;
- **no read-back** — a saved secret cannot be fetched, only referenced from a
  create-instance body;
- **no list** — a deployment cannot enumerate the secret names it owns, so it
  cannot even reconcile orphans it forgot about.

Consequences for us:

1. **Teardown cannot complete.** `DELETE /api/v1/provision/:name` removes every
   OSC instance in the stack and deletes the stored stack config, but the secret
   entries (`<stackName>.rootpassword` under `minio-minio`,
   `<stackName>.objectstore.s3secretaccesskey` under `encore`,
   `<stackName>.objectstore.awssecretaccesskey` under `eyevinn-ffmpeg-s3`)
   remain in the OSC secret store forever, referenced by nothing. Secret names
   accumulate one set per stack ever provisioned. We deliberately did **not**
   guess a delete endpoint — doing so would have meant inventing an OSC contract
   (CLAUDE.md rule 7).
2. **A credential cannot be rotated out of existence**, only overwritten — and
   only if the deployment still knows the exact secret name.
3. **The secret cannot be the source of truth.** Because a saved secret is never
   readable again, the API process cannot recover a *randomly generated*
   per-stack credential for its own S3 client (presigned uploads, bucket reads).
   We therefore derive the credential (HMAC-SHA256 of a deployment seed, keyed
   on the stack's non-secret access key id) so every reader can recompute it,
   and use `saveSecret` only to make the value injectable into other services as
   a `{{secrets.*}}` reference. A read-back (or a platform-generated credential
   we could reference by name from *our own* process) would have let the secret
   store be authoritative instead.

## What would help

- `deleteSecret(serviceId, name, ctx)` — or, better, a documented secret
  lifecycle tied to the instance/stack that references the secret, so removing
  the last referencing instance can garbage-collect it.
- `listSecrets(serviceId, ctx)` returning secret **names** only (no values), so
  a deployment can reconcile and clean up orphans after a crashed teardown.
- Confirmation of whether `POST /mysecrets/<serviceId>` with an existing
  `secretName` is an idempotent overwrite (we rely on this for retried
  provisioning) and whether there is any per-`serviceId` secret-count limit a
  long-lived deployment would eventually hit.

## Where this lands in the code

- `src/routes/provision.ts` — the DELETE route's credential-lifecycle comment
  records exactly what teardown can and cannot remove.
- `src/services/object-store-credentials.ts` — the module header explains why the
  credential is derived rather than randomly generated and stored, with the
  write-only `saveSecret` contract cited.
