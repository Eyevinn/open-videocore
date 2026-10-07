/** An image digest is attacker-influenced text (a registry header) that becomes part of a storage key. */
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
export function assertDigest(d) {
  if (!DIGEST.test(String(d))) throw new Error(`refusing malformed image digest: ${String(d).slice(0, 80)}`);
  return d;
}
