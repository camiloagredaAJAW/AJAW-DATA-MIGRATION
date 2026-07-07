import { createHash } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AuthConfig } from "../auth/authGuard.js";
import type { MigrationController } from "../../migration/controller.js";
import { requireAdminSession, requireCsrfHeader } from "./sessionAuth.js";

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
      secure: process.env.NODE_ENV === "production",
    },
  });

  fastify.post("/admin/login", async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(401).send({
        error: { code: "unauthorized", message: "Invalid credentials" },
      });
    }

    const { username, password } = parsed.data;
    if (username !== options.authConfig.username || password !== options.authConfig.password) {
      return reply.code(401).send({
        error: { code: "unauthorized", message: "Invalid credentials" },
      });
    }

    request.session.authenticated = true;
    return reply.code(204).send();
  });

  await fastify.register(async (admin) => {
    admin.addHook("onRequest", requireAdminSession);
    admin.addHook("preHandler", requireCsrfHeader);

    // Guard-wiring proof for this PR; Phase 3 adds the real BFF routes
    // (status/field-mappings/errors/migration control) into this same scope.
    admin.get("/admin/api/session", async () => ({ data: { authenticated: true } }));
  });
};
