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
 *
 * Requires `JSESSIONID` specifically (not just "any cookie") — on this
 * deployment, `login.jsp`'s HTTP status and response body are not reliable
 * (it can return a non-2xx status with an HTML page, apparently from a
 * downstream template render, while still correctly committing the session
 * cookies beforehand). The cookies are the only trustworthy success signal;
 * status/body are deliberately never consulted here.
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

  const hasJSessionId = rawCookies.some((raw) => /^JSESSIONID=/i.test(raw.trim()));
  if (!hasJSessionId) {
    throw new Error(
      `Axelor login response did not include a JSESSIONID cookie (status ${response.status})`,
    );
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

    // Deliberately no `response.ok` gate: this deployment's login.jsp can
    // return a non-2xx status (e.g. 500) with an HTML body while still having
    // correctly set the session cookies before that status was produced.
    // extractCookieHeader() is the actual success/failure signal.
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
