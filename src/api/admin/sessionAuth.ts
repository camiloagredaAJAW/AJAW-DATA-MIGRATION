import type { FastifyReply, FastifyRequest } from "fastify";

export interface AdminSessionState {
  readonly authenticated?: boolean;
}

/**
 * Pure predicate mirroring `checkAuth` in `authGuard.ts`: the session is
 * considered authenticated only when `authenticated` was explicitly set to
 * `true` by `POST /admin/login`. A missing session, a freshly-issued
 * unauthenticated session, or any other value is rejected.
 */
export function isAdminSessionAuthenticated(session: AdminSessionState | undefined): boolean {
  return session?.authenticated === true;
}

/**
 * `onRequest` preHandler for the `/admin/api/*` scope: rejects with a generic
 * 401 unless `POST /admin/login` has previously set `session.authenticated`.
 * Relies on `@fastify/session`'s own `onRequest` hook (registered by
 * `adminPlugin`) having already parsed the session cookie into
 * `request.session` before this hook runs.
 */
export async function requireAdminSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isAdminSessionAuthenticated(request.session)) {
    request.log.warn(
      { route: `${request.method} ${request.url}`, reason: "no_authenticated_session" },
      "admin session guard rejected request",
    );
    reply.code(401).send({
      error: { code: "unauthorized", message: "Authentication required" },
    });
  }
}

const CSRF_HEADER = "x-requested-with";
const CSRF_PROTECTED_METHODS = new Set(["POST", "PUT", "DELETE"]);

/** Pure predicate so the method allowlist can be unit-tested without a Fastify request. */
export function requiresCsrfHeader(method: string): boolean {
  return CSRF_PROTECTED_METHODS.has(method.toUpperCase());
}

/**
 * `preHandler` for the `/admin/api/*` scope: state-changing requests
 * (POST/PUT/DELETE) must carry a custom `X-Requested-With` header or are
 * rejected with 403. Combined with the SameSite=Strict + HttpOnly session
 * cookie (`adminPlugin`), this defeats classic cross-site form CSRF without
 * the full CSRF-token machinery — a simple cross-site request cannot set
 * arbitrary headers, so its absence signals a forged request.
 */
export async function requireCsrfHeader(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requiresCsrfHeader(request.method)) {
    return;
  }
  if (request.headers[CSRF_HEADER] === undefined) {
    request.log.warn(
      { route: `${request.method} ${request.url}`, reason: "missing_csrf_header" },
      "admin CSRF guard rejected request",
    );
    reply.code(403).send({
      error: { code: "csrf_header_required", message: "X-Requested-With header required" },
    });
  }
}
