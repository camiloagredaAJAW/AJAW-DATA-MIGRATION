import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import fastifyStatic from "@fastify/static";
import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AuthConfig } from "../auth/authGuard.js";
import type { MigrationController } from "../../migration/controller.js";
import { requireAdminSession, requireCsrfHeader } from "./sessionAuth.js";
import { registerAdminBffRoutes } from "./adminBffRoutes.js";

/**
 * `<repo>/public`, matching `server.ts`'s `REPO_ROOT` computation: this file
 * lives at `src/api/admin/`, three levels below the repo root.
 */
const PUBLIC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "public",
);

declare module "fastify" {
  interface Session {
    authenticated?: boolean;
  }
}

export interface AdminPluginOptions {
  readonly db: Database.Database;
  readonly authConfig: AuthConfig;
  /** Shared migration-control state machine; wired through for the Phase 3 BFF routes. */
  readonly controller?: MigrationController;
}

const loginBodySchema = z
  .object({
    username: z.string(),
    password: z.string(),
  })
  .strict();

/**
 * Session cookie lifetime: 12 hours. No existing env var convention for
 * durations in this codebase (`src/config/env.ts` only reads connection and
 * pagination config), so this is hardcoded rather than introducing a new
 * single-use env var.
 */
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** `@fastify/session`'s default `cookieName`; not overridden by this plugin's registration. */
const SESSION_COOKIE_NAME = "sessionId";

/**
 * Environments where the session cookie is intentionally sent over plain
 * HTTP (local dev / test runners). Every other value — including an unset
 * or misspelled `NODE_ENV` — fails CLOSED to `secure: true`, since silently
 * defaulting to non-secure would leak the session cookie over HTTP in any
 * real deployment that forgets to set `NODE_ENV=production` exactly.
 */
const INSECURE_COOKIE_ENVIRONMENTS = new Set(["development", "test"]);

/**
 * Pure predicate so the fail-closed `NODE_ENV` logic can be unit-tested
 * directly: `@fastify/session` silently drops `Set-Cookie` entirely for a
 * `secure` cookie served over the plain-HTTP connection `fastify.inject()`
 * simulates, which would make the fail-open regression this guards against
 * untestable through an end-to-end login request alone.
 */
export function isSecureCookieEnvironment(nodeEnv: string | undefined): boolean {
  return !INSECURE_COOKIE_ENVIRONMENTS.has(nodeEnv ?? "");
}

/**
 * Derives the session-signing secret from `INTERNAL_API_KEY` instead of
 * introducing a new env var: `@fastify/session` requires >=32 chars, and
 * hashing (rather than reusing the raw key) keeps the key's own value out of
 * the cookie-signing material.
 */
function deriveSessionSecret(authConfig: AuthConfig): string {
  return createHash("sha256").update(authConfig.internalApiKey).digest("hex");
}

/**
 * `/admin/*` scope: session-cookie auth, sibling to the `/api/*` Basic Auth
 * scope registered in `buildServer()`. Owns its own `@fastify/cookie` +
 * `@fastify/session` registration so the session-parsing `onRequest` hook
 * stays confined to this plugin's encapsulation context — it never touches
 * `/api/*` requests, and `/api/*` credentials never authenticate here either
 * (see spec "API credentials do not unlock admin scope").
 *
 * Sessions are the `@fastify/session` default in-memory `MemoryStore` only —
 * PRD §13 forbids persisting session data to SQLite, so no `store` option is
 * set here.
 */
export const adminPlugin: FastifyPluginAsync<AdminPluginOptions> = async (fastify, options) => {
  // Static admin UI (design Decision 4): `@fastify/static` registers a
  // wildcard GET route under this prefix. It never shadows the explicit
  // routes below (`/admin/login`, `/admin/api/*`) — find-my-way always
  // prefers a literal route match over a wildcard one, and this plugin
  // never serves anything under `/admin/api/*` from disk.
  await fastify.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: "/admin/",
  });

  await fastify.register(fastifyCookie);
  await fastify.register(fastifySession, {
    secret: deriveSessionSecret(options.authConfig),
    // saveUninitialized:false is required for spec compliance: a failed
    // login must not set ANY cookie. Without this, @fastify/session's
    // default onSend hook issues a Set-Cookie for every unauthenticated
    // request too, since it creates a fresh session object per request.
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      path: "/admin",
      secure: isSecureCookieEnvironment(process.env.NODE_ENV),
      maxAge: SESSION_MAX_AGE_MS,
    },
  });

  fastify.post("/admin/login", async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn({ route: "POST /admin/login", reason: "malformed_body" }, "admin login rejected");
      return reply.code(401).send({
        error: { code: "unauthorized", message: "Invalid credentials" },
      });
    }

    const { username, password } = parsed.data;
    if (username !== options.authConfig.username || password !== options.authConfig.password) {
      request.log.warn(
        { route: "POST /admin/login", reason: "invalid_credentials", username },
        "admin login rejected",
      );
      return reply.code(401).send({
        error: { code: "unauthorized", message: "Invalid credentials" },
      });
    }

    request.session.authenticated = true;
    return reply.code(204).send();
  });

  // Intentionally NOT nested under the `requireAdminSession`-guarded scope
  // below: that hook 401s any request without an authenticated session,
  // which would make logout impossible to call idempotently (the whole
  // point of "log out" on an already-expired/missing/unauthenticated
  // session is that it still succeeds, mirroring the DELETE-on-missing-
  // resource idempotency convention rather than erroring). Still runs
  // through `requireCsrfHeader` directly since it's a state-changing POST.
  fastify.post("/admin/logout", { preHandler: requireCsrfHeader }, async (request, reply) => {
    await request.session.destroy();
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/admin" });
    return reply.code(200).send();
  });

  await fastify.register(async (admin) => {
    admin.addHook("onRequest", requireAdminSession);
    admin.addHook("preHandler", requireCsrfHeader);

    // Guard-wiring proof route from PR2, kept as a lightweight liveness check.
    admin.get("/admin/api/session", async () => ({ data: { authenticated: true } }));

    registerAdminBffRoutes(admin, options.db, options.controller);
  });
};
