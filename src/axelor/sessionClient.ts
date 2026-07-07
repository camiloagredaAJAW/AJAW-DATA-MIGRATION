import type { AxelorConfig } from "../config/env.js";

/**
 * A live Axelor session: the Basic Auth header (constant, derived once from
 * config) plus the session cookie header captured from `login.jsp`'s
 * `Set-Cookie` response headers (e.g. `CSRF-TOKEN=...; JSESSIONID=...;
 * TENANTID=...`). Never persisted to disk or the database.
 */
export interface AxelorSession {
  readonly authHeader: string;
  readonly cookieHeader: string;
}

export interface AxelorSessionClient {
  /** Returns the cached session, logging in first if none is cached yet. */
  getSession(): Promise<AxelorSession>;
  /** Drops the cached session so the next `getSession()` call re-authenticates. */
  invalidate(): void;
}

function buildAuthHeader(config: AxelorConfig): string {
  const credentials = Buffer.from(`${config.username}:${config.password}`).toString("base64");
  return `Basic ${credentials}`;
}

/**
 * Extracts the session cookie header from an Axelor `login.jsp` response.
 * Prefers the standard `Headers.getSetCookie()` (each `Set-Cookie` header as
 * its own array entry) and falls back to a single combined `set-cookie`
 * value for fetch implementations that don't expose `getSetCookie`. Each raw
 * `Set-Cookie` string is trimmed down to its `name=value` pair (dropping
 * `Path`/`HttpOnly`/etc. attributes) and joined with `; ` for reuse as a
 * request `Cookie` header.
 */
function extractCookieHeader(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const rawCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (() => {
          const combined = headers.get("set-cookie");
          return combined ? [combined] : [];
        })();

  if (rawCookies.length === 0) {
    throw new Error("Axelor login response did not include a session cookie");
  }

  return rawCookies.map((raw) => raw.split(";")[0]!.trim()).join("; ");
}

/**
 * Creates an Axelor session client: obtains a session by POSTing Basic Auth
 * credentials to `login.jsp` and caches the resulting cookie header for
 * reuse by `restClient.ts`. Callers detecting an expired session (HTTP 401
 * on a REST call) should call `invalidate()` and then `getSession()` again
 * to transparently re-authenticate.
 */
export function createSessionClient(
  config: AxelorConfig,
  fetchImpl: typeof fetch = fetch,
): AxelorSessionClient {
  const authHeader = buildAuthHeader(config);
  let cached: AxelorSession | null = null;

  async function login(): Promise<AxelorSession> {
    const response = await fetchImpl(`${config.baseUrl}/login.jsp`, {
      method: "POST",
      headers: { Authorization: authHeader },
      // A POST with no body at all omits Content-Length, which some
      // Java/JSP stacks (login.jsp is a servlet) reject outright rather
      // than treating as a zero-length body — an explicit empty body
      // avoids that ambiguity. Confirmed against a working sibling
      // integration (ajaw-insta-data) that always sends one.
      body: "",
    });

    if (!response.ok) {
      // login.jsp is a servlet endpoint — a non-2xx response body (HTML error
      // page, stack trace, JSON error) almost always carries the actual
      // reason a generic status code hides. Best-effort: response bodies
      // aren't guaranteed readable twice, so a read failure here must never
      // mask the original status-code error.
      const bodyPreview = await response
        .text()
        .then((text) => text.slice(0, 500))
        .catch(() => "<unreadable response body>");
      throw new Error(`Axelor login failed with status ${response.status}: ${bodyPreview}`);
    }

    return { authHeader, cookieHeader: extractCookieHeader(response) };
  }

  return {
    async getSession(): Promise<AxelorSession> {
      if (cached === null) {
        cached = await login();
      }
      return cached;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
