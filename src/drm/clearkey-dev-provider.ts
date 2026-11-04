// `clearkey-dev` key provider — DEVELOPMENT ONLY (ADR-008 D1, §5.3, §10
// "Clear-key adapter", Q5; issue #1260).
//
// Generates content keys locally so the whole DRM path (key acquisition,
// metadata, delivery exposure, a local encrypting packager) can be exercised
// without a provider account, a network endpoint or a credential. It is NOT
// protection: the keys are cleartext to anyone who can read the manifest, which
// is why every signalling document it produces is marked `dev: true` so a
// development stream can never be mistaken for protected content downstream
// (ADR-008 §10).
//
// CONTRACT SOURCES (contract-first, CLAUDE.md rule 7):
//   - ADR-008 §5.1 — the `KeyProvider` interface it implements and the
//     `ContentKey` / `DrmSignalling` shapes it returns, as transcribed in
//     src/drm/key-provider.ts.
//   - ADR-008 §11 — "Key generation for `clearkey-dev` uses `node:crypto`
//     `randomBytes` (never reimplement crypto)".
//   - ADR-008 §10/Q5 — "refuses to start when `NODE_ENV=production`".
//   - DASH-IF Content Protection Identifiers registry (fetched 2026-11-04,
//     https://dashif.org/identifiers/content_protection/) — the registered
//     system id this adapter signals by default, `CLEAR_KEY_SYSTEM_ID`
//     (src/drm/key-provider.ts). A system id, never a product name
//     (CLAUDE.md rule 1, ADR-008 §5.3).

import { randomBytes, randomUUID } from 'node:crypto';

import { CLEAR_KEY_SYSTEM_ID } from './key-provider.js';
import type {
  ContentKey,
  DrmSignalling,
  DrmSystemId,
  KeyProvider,
  KeyRequest
} from './key-provider.js';

// AES-128 content key length (ADR-008 §5.1 `ContentKey.key`: "16 bytes").
export const CONTENT_KEY_BYTES = 16;

export type ClearKeyDevProviderOptions = {
  // Operator-chosen config id (ADR-008 §5.2 `providerId`). Defaults to the
  // same `'primary'` the ADR uses as its example.
  id?: string;
  // System ids to signal. Configuration with a well-known default
  // (`CLEAR_KEY_SYSTEM_ID`), so no id is hardcoded without an override path.
  systemIds?: readonly DrmSystemId[];
  // Optional local clear-key licence endpoint, for a development stack that
  // runs one. Left unset there is no licence service at all and `licenceUrls`
  // is empty — a clear-key player is configured with the key inline.
  licenceUrl?: string;
};

// Thrown by the constructor when the adapter is instantiated in a production
// process. A distinct class so a caller can tell a refusal-to-start apart from
// a runtime key failure, and so the wiring code can fail boot on it.
export class ClearKeyDevNotAllowedError extends Error {
  constructor() {
    // No credential, host or key material in the message (ADR-008 §10).
    super(
      'clearkey-dev key provider is development-only and refuses to start when NODE_ENV=production'
    );
    this.name = 'ClearKeyDevNotAllowedError';
  }
}

export class ClearKeyDevProvider implements KeyProvider {
  readonly id: string;
  readonly kind = 'clearkey-dev' as const;

  private readonly systemIds: readonly DrmSystemId[];
  private readonly licenceUrl: string | undefined;

  constructor(options: ClearKeyDevProviderOptions = {}) {
    // STARTUP-TIME refusal, not call-time (ADR-008 §10/Q5, issue #1260).
    //
    // WHY IN THE CONSTRUCTOR: the provider is built when the stack's DRM
    // configuration is resolved, i.e. before any asset is packaged. Refusing
    // here turns a misconfigured production deployment into a boot failure the
    // operator sees immediately, instead of a per-asset failure discovered
    // after content has already been published — and it makes it impossible to
    // hold a usable instance of this class in a production process at all.
    if (process.env['NODE_ENV'] === 'production') {
      throw new ClearKeyDevNotAllowedError();
    }
    this.id = options.id ?? 'primary';
    this.systemIds =
      options.systemIds && options.systemIds.length > 0
        ? [...options.systemIds]
        : [CLEAR_KEY_SYSTEM_ID];
    this.licenceUrl = options.licenceUrl;
  }

  // Mint one key per requested track group (ADR-008 D3: one key per track type
  // group, single-key profile by default).
  //
  // `req.systems` is deliberately IGNORED for signalling: this adapter has no
  // provider to ask, so it can only speak for the clear-key system it is
  // configured with. A caller that needs real multi-system signalling needs a
  // real provider — which is the point of the `dev: true` marker.
  async acquire(
    req: KeyRequest,
    signal: AbortSignal
  ): Promise<{ keys: ContentKey[]; signalling: DrmSignalling }> {
    // Honoured even though nothing here is remote, so callers behave
    // identically across adapters (see the `KeyProvider.acquire` note).
    signal.throwIfAborted();

    const keys: ContentKey[] = req.trackGroups.map((trackGroup) => ({
      trackGroup,
      // Pinned key ids make a re-package reuse the same kids (ADR-008 §6
      // "Idempotency"); absent a pinned value, mint one.
      keyId: req.keyIds?.[trackGroup] ?? randomUUID(),
      // `randomBytes` — never reimplement crypto (ADR-008 §11). TRANSIENT: the
      // caller hands this to the package job and drops it (ADR-008 D4).
      key: randomBytes(CONTENT_KEY_BYTES)
    }));

    const licenceUrls: Record<DrmSystemId, string> = {};
    if (this.licenceUrl !== undefined) {
      for (const systemId of this.systemIds) licenceUrls[systemId] = this.licenceUrl;
    }

    // MINIMAL signalling (issue #1260): no PSSH box, no DASH
    // ContentProtectionData and no HLS key lines are synthesised here — a
    // locally built clear-key package carries its own in-manifest signalling,
    // and fabricating a PSSH would make this output look like provider
    // signalling. `dev: true` is the load-bearing member (ADR-008 §10).
    return {
      keys,
      signalling: {
        pssh: {},
        licenceUrls,
        dev: true
      }
    };
  }
}
