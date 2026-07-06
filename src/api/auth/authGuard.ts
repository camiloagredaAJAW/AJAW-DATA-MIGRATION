import type { FastifyInstance } from "fastify";

export interface AuthConfig {
  readonly username: string;
  readonly password: string;
  readonly internalApiKey: string;
}

export interface AuthRequestHeaders {
  readonly authorization?: string;
  readonly "x-internal-api-key"?: string;
}

export type AuthFailureReason =
  | "missing_basic_auth"
  | "invalid_basic_auth"
  | "missing_api_key"
  | "invalid_api_key";

export interface AuthResult {
  readonly authenticated: boolean;
  readonly reason?: AuthFailureReason;
}

function decodeBasicAuth(
  header: string | undefined,
): { username: string; password: string } | null {
  if (header === undefined || !header.startsWith("Basic ")) {
    return null;
  }

  const base64Credentials = header.slice("Basic ".length);
  const decoded = Buffer.from(base64Credentials, "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

/**
 * Validates BOTH Basic Auth AND the `X-Internal-Api-Key` header. Both checks
 * must pass on every request.
 *
 * Basic Auth is a direct comparison against the AXELOR_USERNAME/AXELOR_PASSWORD
 * env vars (per PRD §6) — this is NOT a live call to Axelor's login.jsp, it
 * just reuses the same credential pair as a shared secret for this internal
 * tool. The API key is compared against INTERNAL_API_KEY.
 *
 * Pure and side-effect free so it can be unit-tested without a running
 * server; `registerAuthGuard` below wires it into Fastify.
 */
export function checkAuth(headers: AuthRequestHeaders, config: AuthConfig): AuthResult {
  const credentials = decodeBasicAuth(headers.authorization);
  if (credentials === null) {
    return { authenticated: false, reason: "missing_basic_auth" };
  }
  if (credentials.username !== config.username || credentials.password !== config.password) {
    return { authenticated: false, reason: "invalid_basic_auth" };
  }

  const apiKey = headers["x-internal-api-key"];
  if (apiKey === undefined) {
    return { authenticated: false, reason: "missing_api_key" };
  }
  if (apiKey !== config.internalApiKey) {
    return { authenticated: false, reason: "invalid_api_key" };
  }

  return { authenticated: true };
}

/**
 * Registers an `onRequest` hook that rejects any request failing `checkAuth`
 * with a generic 401 before it reaches route handlers — no data is ever
 * returned for an unauthenticated request.
 */
export function registerAuthGuard(fastify: FastifyInstance, config: AuthConfig): void {
  fastify.addHook("onRequest", async (request, reply) => {
    const result = checkAuth(
      {
        authorization: request.headers.authorization,
        "x-internal-api-key": request.headers["x-internal-api-key"] as string | undefined,
      },
      config,
    );

    if (!result.authenticated) {
      return reply.code(401).send({
        error: { code: "unauthorized", message: "Authentication required" },
      });
    }

    return undefined;
  });
}
