// Strip credentials from text before it is stored, printed or returned in a result.
const PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\b(?:authorization|token|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?[^\s"',}]+/gi,
];

/** @param {unknown} text @param {string[]} [secrets] exact values to mask (tokens from env) */
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const v of secrets) if (v && v.length >= 6) s = s.split(v).join('[redacted]');
  for (const p of PATTERNS) s = s.replace(p, '[redacted]');
  return s;
}

/**
 * `redact` applied to every string inside a value, in place of its structure: objects and arrays are walked, numbers,
 * booleans, null and undefined come back unchanged. For structured facts that are copied out of an upstream response
 * body (the `observed` block of a case result), which `redact` alone would flatten into one string.
 * @param {unknown} value @param {string[]} [secrets]
 */
export function redactValue(value, secrets = []) {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, secrets)]));
  }
  return value;
}
