# OSC friction — the `encore` management API host serves the ingress controller's default self-signed certificate

**Date:** 2026-09-26
**Surface:** backend-api (`src/encore-scaler`)
**Service:** `encore` (management API host, not per-instance hosts)
**Tenant/workspace observed in:** `oscaidev`
**Found while:** fetching contracts for `Eyevinn/open-videocore#814`

## What we needed

The Encore auto-scaler drives the `encore` service's management API through
`@osaas/client-core` (`createInstance` / `listInstances` / `removeInstance` —
`src/encore-scaler/instance-pool.ts`), which resolves to
`https://api-encore.auto.prod-se.osaas.io/encoreinstance`. Reading that endpoint
is also the normal way to discover a live instance URL in order to fetch the
Encore OpenAPI contract, which CLAUDE.md rule 7 requires before touching the job
payload.

## Friction

`https://api-encore.auto.prod-se.osaas.io` terminates TLS with the nginx ingress
controller's **built-in placeholder certificate** rather than a real one, so
every client with default certificate verification fails to connect:

```
* TLSv1.3 (IN), TLS handshake, Certificate (11):
* TLSv1.3 (OUT), TLS alert, unknown CA (560):
* SSL certificate problem: self-signed certificate
```

```
issuer=O = Acme Co, CN = Kubernetes Ingress Controller Fake Certificate
subject=O = Acme Co, CN = Kubernetes Ingress Controller Fake Certificate
```

Reproduced on three consecutive handshakes, and it is specific to this host —
the other OSC hosts reached in the same session all present valid publicly
trusted certificates:

| Host | Certificate issuer |
|---|---|
| `api-encore.auto.prod-se.osaas.io` | **`O = Acme Co, CN = Kubernetes Ingress Controller Fake Certificate`** |
| `api-eyevinn-encore-callback-listener.auto.prod-se.osaas.io` | `O = Google Trust Services, CN = WR1` |
| `api-valkey-io-valkey.auto.prod-se.osaas.io` | `O = Let's Encrypt, CN = YR1` |
| `catalog.svc.prod.osaas.io` | `O = Let's Encrypt, CN = YR2` |
| `<workspace>-<instance>.encore.auto.prod-se.osaas.io` (per-instance) | `O = Let's Encrypt, CN = YR2` |

So it is not a local trust-store problem, not a proxy interposing on this
network, and not the `encore` service as a whole — only the `encore` **service
management API** hostname. Per-instance `encore` hosts are fine.

Impact, in increasing order of seriousness:

1. Any scaler operation that calls the `encore` management API — including
   `spawnInstance` — fails at the TLS layer while this persists, with an error
   (`self-signed certificate` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) that reads
   like a client misconfiguration rather than a platform fault.
2. It is unclear whether this is a permanent misconfiguration or a
   certificate-renewal window. If it is a renewal window, it is the same class
   of problem as `#457`/`#463` and
   `incoming-callback-listener-ingress-auth-window-fresh-instance.md`: an OSC
   ingress serving traffic before its TLS configuration is complete.
3. The obvious workaround — disabling certificate verification to get past it —
   is exactly the wrong reflex for a host that authenticates with a bearer
   service access token, since it would expose that token to any interposing
   party. **No credential was sent over the unverified connection in this
   session**, and none should be.

## Requested capability

1. Issue `api-encore.auto.prod-se.osaas.io` a publicly trusted certificate, as
   every other `api-*.auto.prod-se.osaas.io` host already has.
2. If this is a renewal window rather than a standing misconfiguration, do not
   let the ingress serve the placeholder certificate on a hostname that is
   already in DNS and already receiving authenticated API traffic — fail closed
   (refuse the connection) instead, so clients see a connection error rather
   than a certificate that a careless client might be told to ignore.

## Workaround in this repo

None applied, and none should be: the contract this session needed was fetched
from a per-instance `encore` host (`GET <instance>/v3/api-docs`, valid Let's
Encrypt certificate) using a service access token, which avoids the affected
hostname entirely. No verification flag was relaxed anywhere in the repo.

## Contract sources verified (this session, live)

- `openssl s_client -connect <host>:443 -servername <host>` → `x509 -noout
  -issuer -subject`, for each host in the table above.
- `curl -v https://api-encore.auto.prod-se.osaas.io/` → `SSL certificate
  problem: self-signed certificate`, exit before any request was sent; three
  repeats of `GET /encoreinstance` with a valid `x-jwt: Bearer <SAT>` all
  returned curl status `000` (no connection).
- `getent hosts api-encore.auto.prod-se.osaas.io` → `88.80.0.65` (DNS resolves;
  the failure is at TLS, not name resolution).
- The management-API URL and header contract come from
  `@osaas/client-core@0.24.0` `lib/core.js` (instance API, `x-jwt: Bearer <SAT>`)
  and `lib/context.js` (`x-pat-jwt: Bearer <PAT>`, `/servicetoken`), the package
  `src/encore-scaler/instance-pool.ts` already depends on.
