import { describe, expect, it } from "vitest";
import path from "node:path";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { migrate } from "../../../src/db/migrate.js";
import { adminPlugin } from "../../../src/api/admin/adminPlugin.js";
import type { AuthConfig } from "../../../src/api/auth/authGuard.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

const authConfig: AuthConfig = {
  username: "admin",
  password: "s3cret",
  internalApiKey: "internal-key-123",
};

async function buildAdminServer() {
  const fastify = Fastify({ logger: false });
  await fastify.register(adminPlugin, { db: freshDb(), authConfig });
  await fastify.ready();
  return fastify;
}

function setCookieHeader(response: { headers: Record<string, unknown> }): string | undefined {
  const raw = response.headers["set-cookie"];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw.join("; ") : String(raw);
}

describe("POST /admin/login", () => {
  it("sets an HttpOnly SameSite=Strict session cookie on success", async () => {
    const server = await buildAdminServer();

    const response = await server.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: authConfig.username, password: authConfig.password },
    });

    expect(response.statusCode).toBe(204);
    const cookie = setCookieHeader(response);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it("returns 401 with no cookie on wrong password", async () => {
    const server = await buildAdminServer();

    const response = await server.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: authConfig.username, password: "wrong" },
    });

    expect(response.statusCode).toBe(401);
    expect(setCookieHeader(response)).toBeUndefined();
  });

  it("returns 401 with no cookie on wrong username", async () => {
    const server = await buildAdminServer();

    const response = await server.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: "someone-else", password: authConfig.password },
    });

    expect(response.statusCode).toBe(401);
    expect(setCookieHeader(response)).toBeUndefined();
  });

  it("returns 401 with no cookie on a malformed body", async () => {
    const server = await buildAdminServer();

    const response = await server.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: authConfig.username },
    });

    expect(response.statusCode).toBe(401);
    expect(setCookieHeader(response)).toBeUndefined();
  });
});

describe("/admin/api/* session guard", () => {
  it("rejects a request without a session cookie with 401", async () => {
    const server = await buildAdminServer();

    const response = await server.inject({ method: "GET", url: "/admin/api/session" });

    expect(response.statusCode).toBe(401);
  });

  it("authenticates a request carrying the cookie issued by a successful login", async () => {
    const server = await buildAdminServer();

    const login = await server.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: authConfig.username, password: authConfig.password },
    });
    const cookie = setCookieHeader(login);
    expect(cookie).toBeDefined();

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/session",
      headers: { cookie: cookie as string },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { authenticated: true } });
  });

  it("rejects a request carrying an unrelated/garbage cookie with 401", async () => {
    const server = await buildAdminServer();

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/session",
      headers: { cookie: "sessionId=not-a-real-session" },
    });

    expect(response.statusCode).toBe(401);
  });
});
