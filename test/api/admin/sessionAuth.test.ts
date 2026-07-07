import { describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  isAdminSessionAuthenticated,
  requireAdminSession,
  requireCsrfHeader,
  requiresCsrfHeader,
} from "../../../src/api/admin/sessionAuth.js";

function fakeReply(): FastifyReply {
  const reply = {
    code: vi.fn(() => reply),
    send: vi.fn(() => reply),
  };
  return reply as unknown as FastifyReply;
}

function fakeRequest(overrides: {
  session?: { authenticated?: boolean };
  method?: string;
  headers?: Record<string, string>;
  url?: string;
}): FastifyRequest {
  return {
    session: overrides.session,
    method: overrides.method ?? "GET",
    headers: overrides.headers ?? {},
    url: overrides.url ?? "/admin/api/session",
    log: { warn: vi.fn() },
  } as unknown as FastifyRequest;
}

describe("isAdminSessionAuthenticated", () => {
  it("is true only when authenticated is explicitly true", () => {
    expect(isAdminSessionAuthenticated({ authenticated: true })).toBe(true);
  });

  it("is false for a missing session", () => {
    expect(isAdminSessionAuthenticated(undefined)).toBe(false);
  });

  it("is false for a session that was never authenticated", () => {
    expect(isAdminSessionAuthenticated({})).toBe(false);
    expect(isAdminSessionAuthenticated({ authenticated: false })).toBe(false);
  });
});

describe("requireAdminSession", () => {
  it("rejects a missing session with 401", async () => {
    const reply = fakeReply();
    await requireAdminSession(fakeRequest({ session: undefined }), reply);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({
      error: { code: "unauthorized", message: "Authentication required" },
    });
  });

  it("rejects an unauthenticated session with 401", async () => {
    const reply = fakeReply();
    await requireAdminSession(fakeRequest({ session: { authenticated: false } }), reply);

    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it("allows an authenticated session through without touching the reply", async () => {
    const reply = fakeReply();
    await requireAdminSession(fakeRequest({ session: { authenticated: true } }), reply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });
});

describe("requiresCsrfHeader", () => {
  it("is true for state-changing methods", () => {
    expect(requiresCsrfHeader("POST")).toBe(true);
    expect(requiresCsrfHeader("PUT")).toBe(true);
    expect(requiresCsrfHeader("DELETE")).toBe(true);
    expect(requiresCsrfHeader("post")).toBe(true);
  });

  it("is false for safe methods", () => {
    expect(requiresCsrfHeader("GET")).toBe(false);
    expect(requiresCsrfHeader("HEAD")).toBe(false);
  });
});

describe("requireCsrfHeader", () => {
  it("rejects a POST without X-Requested-With with 403", async () => {
    const reply = fakeReply();
    await requireCsrfHeader(fakeRequest({ method: "POST", headers: {} }), reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({
      error: { code: "csrf_header_required", message: "X-Requested-With header required" },
    });
  });

  it("rejects a PUT without X-Requested-With with 403", async () => {
    const reply = fakeReply();
    await requireCsrfHeader(fakeRequest({ method: "PUT", headers: {} }), reply);

    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it("allows a POST with X-Requested-With through", async () => {
    const reply = fakeReply();
    await requireCsrfHeader(
      fakeRequest({ method: "POST", headers: { "x-requested-with": "fetch" } }),
      reply,
    );

    expect(reply.code).not.toHaveBeenCalled();
  });

  it("does not require the header for GET requests", async () => {
    const reply = fakeReply();
    await requireCsrfHeader(fakeRequest({ method: "GET", headers: {} }), reply);

    expect(reply.code).not.toHaveBeenCalled();
  });
});
