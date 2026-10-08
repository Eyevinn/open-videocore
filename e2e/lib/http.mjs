// Minimal HTTP client for the suite. Never logs or returns the token.

/**
 * Two layers authenticate a call to an OSC service instance:
 *  - the platform ingress (nginx) wants `x-jwt: Bearer <service access token>` (the header the platform's own
 *    call-service-endpoint tool sends; osaas-ai src/mcp/tools/services.ts) and answers every anonymous call with its
 *    own 401, /health included;
 *  - the application then wants `Authorization: Bearer <non-empty>` (src/auth/middleware.ts extractToken, a pure
 *    presence check in src/auth/workspace.ts) and answers 401 {"error":"unauthorized","message":"missing access
 *    token"} without it. The ingress does NOT turn x-jwt into Authorization (verified through the platform's own
 *    call-service-endpoint on /api/v1/assets/). /health needs no Authorization.
 * `appToken` defaults to the same token; pass '' to send x-jwt alone and reach the application's own gate.
 * @param {{ baseUrl: string, token?: string, appToken?: string, authHeader?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export function createClient({ baseUrl, token, appToken = token, authHeader = 'x-jwt', fetchImpl = fetch, timeoutMs = 30_000 }) {
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
      if (appToken) headers.authorization = `Bearer ${appToken}`;
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
