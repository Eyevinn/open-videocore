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
