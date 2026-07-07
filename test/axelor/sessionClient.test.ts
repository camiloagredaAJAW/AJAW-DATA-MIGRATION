import { describe, expect, it, vi } from "vitest";
import { createSessionClient } from "../../src/axelor/sessionClient.js";
import type { AxelorConfig } from "../../src/config/env.js";

function baseConfig(): AxelorConfig {
  return {
    baseUrl: "http://axelor.example.test",
    username: "admin",
    password: "secret",
    namespace: "com.ajawmrp3.apps.prospectingai.db",
    modelNameCompanies: "AiSearchResults",
  };
}

function loginResponse(cookies: string[], ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: {
      getSetCookie: () => cookies,
      get: () => null,
    },
  } as unknown as Response;
}

describe("createSessionClient", () => {
  it("logs in with Basic Auth and parses Set-Cookie into a cached session", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        loginResponse(["JSESSIONID=abc123; Path=/; HttpOnly", "CSRF-TOKEN=xyz; Path=/"]),
      );

    const client = createSessionClient(baseConfig(), fetchImpl as unknown as typeof fetch);
    const session = await client.getSession();

    expect(session.cookieHeader).toBe("JSESSIONID=abc123; CSRF-TOKEN=xyz");
    expect(session.authHeader).toBe(`Basic ${Buffer.from("admin:secret").toString("base64")}`);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("http://axelor.example.test/login.jsp");
    expect(calledInit.method).toBe("POST");
    expect((calledInit.headers as Record<string, string>).Authorization).toBe(session.authHeader);
    expect(calledInit.body).toBe("");
  });

  it("caches the session across multiple getSession() calls (only one login request)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(loginResponse(["JSESSIONID=abc123"]));
    const client = createSessionClient(baseConfig(), fetchImpl as unknown as typeof fetch);

    await client.getSession();
    await client.getSession();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-authenticates on the next getSession() call after invalidate()", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(loginResponse(["JSESSIONID=first"]))
      .mockResolvedValueOnce(loginResponse(["JSESSIONID=second"]));
    const client = createSessionClient(baseConfig(), fetchImpl as unknown as typeof fetch);

    const first = await client.getSession();
    client.invalidate();
    const second = await client.getSession();

    expect(first.cookieHeader).toBe("JSESSIONID=first");
    expect(second.cookieHeader).toBe("JSESSIONID=second");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("succeeds despite a non-ok HTTP status as long as JSESSIONID is present", async () => {
    // This deployment's login.jsp can return a non-2xx status with an HTML
    // body (apparently from a downstream template render) while still having
    // correctly committed the session cookies beforehand -- status/body are
    // not reliable signals here, only the cookies are.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(loginResponse(["JSESSIONID=abc123; Path=/; HttpOnly"], false, 500));

    const client = createSessionClient(baseConfig(), fetchImpl as unknown as typeof fetch);
    const session = await client.getSession();

    expect(session.cookieHeader).toBe("JSESSIONID=abc123");
  });

  it("throws when no JSESSIONID cookie comes back, regardless of status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(loginResponse(["TENANTID=main; Path=/"], false, 500));
    const client = createSessionClient(baseConfig(), fetchImpl as unknown as typeof fetch);

    await expect(client.getSession()).rejects.toThrow(/JSESSIONID/);
  });

  it("throws when login returns 200 but no cookies at all", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(loginResponse([], true, 200));
    const client = createSessionClient(baseConfig(), fetchImpl as unknown as typeof fetch);

    await expect(client.getSession()).rejects.toThrow(/JSESSIONID/);
  });
});
