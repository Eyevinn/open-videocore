// Minimal HTTP client for the suite. Never logs or returns the token.

/**
 * Calls to an OSC service instance go through the platform ingress, which authenticates the header
 * `x-jwt: Bearer <service access token>` (the same header the platform's own call-service-endpoint tool sends;
 * osaas-ai src/mcp/tools/services.ts). Anonymous calls get nginx's 401 for every path, /health included.
 * @param {{ baseUrl: string, token?: string, authHeader?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export function createClient({ baseUrl, token, authHeader = 'x-jwt', fetchImpl = fetch, timeoutMs = 30_000 }) {
  const root = baseUrl.replace(/\/+$/, '');
  return {
    /**
     * @param {string} method
     * @param {string} path  e.g. /api/v1/assets/
     * @param {{ json?: unknown, query?: Record<string, string | number | undefined> }} [opts]
     * @returns {Promise<{ status: number, body: any, text: string }>}
     */
    async request(method, path, { json, query } = {}) {
      const url = new URL(root + path);
      for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
      const headers = { accept: 'application/json' };
      if (token) headers[authHeader] = `Bearer ${token}`;
      if (json !== undefined) headers['content-type'] = 'application/json';
      const res = await fetchImpl(url, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let body;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
      return { status: res.status, body, text };
    },
  };
}
