// Stable, non-secret identifier for a physical Valkey connection (issue #1074).
//
// GET /scaler/status reports across every Valkey the scaler loops use, which
// means each reported workspace has to say WHICH store its queue/in-flight
// depths were read from — otherwise two stacks on two Valkeys produce numbers an
// operator cannot attribute. The endpoint is deliberately unauthenticated
// (routes/scaler.ts header), so the label must not be the connection string: no
// credentials, no host, no port, no database index.
//
// A hash of the credential-stripped URL satisfies both: identical for every
// reader of the same store, different for different stores, and it reveals
// nothing about where the store is. Credentials are stripped BEFORE hashing so a
// password rotation does not silently rename the connection an operator has been
// watching. Same construction and width as scalerOwnerTag
// (instance-pool.ts:184): 8 hex chars is a disambiguator between the handful of
// stacks in one tenant, not a security boundary.

import { createHash } from 'node:crypto';

// Drop any `user:password@` userinfo segment so the hash depends only on the
// store's location, never on the credential used to reach it. Mirrors
// stripCredentials (services/param-store.ts:138) but kept local: the scaler owns
// no dependency on the parameter-store module.
function withoutCredentials(redisUrl: string): string {
  try {
    const url = new URL(redisUrl);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return redisUrl.replace(/(^[a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
  }
}

export function valkeyConnectionId(redisUrl: string): string {
  const digest = createHash('sha256')
    .update(withoutCredentials(redisUrl))
    .digest('hex')
    .slice(0, 8);
  return `valkey-${digest}`;
}
