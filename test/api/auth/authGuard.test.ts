import { describe, expect, it } from "vitest";
import { checkAuth, type AuthConfig } from "../../../src/api/auth/authGuard.js";

const config: AuthConfig = {
  username: "admin",
  password: "s3cret",
  internalApiKey: "internal-key-123",
};

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("checkAuth", () => {
  it("authenticates when Basic Auth and the internal API key both match", () => {
    const result = checkAuth(
      {
        authorization: basicAuthHeader("admin", "s3cret"),
        "x-internal-api-key": "internal-key-123",
      },
      config,
    );

    expect(result).toEqual({ authenticated: true });
  });

  it("rejects a missing Authorization header", () => {
    const result = checkAuth({ "x-internal-api-key": "internal-key-123" }, config);

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe("missing_basic_auth");
  });

  it("rejects a malformed Authorization header (not Basic scheme)", () => {
    const result = checkAuth(
      { authorization: "Bearer sometoken", "x-internal-api-key": "internal-key-123" },
      config,
    );

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe("missing_basic_auth");
  });

  it("rejects an invalid Basic Auth password", () => {
    const result = checkAuth(
      {
        authorization: basicAuthHeader("admin", "wrong-password"),
        "x-internal-api-key": "internal-key-123",
      },
      config,
    );

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe("invalid_basic_auth");
  });

  it("rejects an invalid Basic Auth username", () => {
    const result = checkAuth(
      {
        authorization: basicAuthHeader("someone-else", "s3cret"),
        "x-internal-api-key": "internal-key-123",
      },
      config,
    );

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe("invalid_basic_auth");
  });

  it("rejects a missing X-Internal-Api-Key header even with valid Basic Auth", () => {
    const result = checkAuth({ authorization: basicAuthHeader("admin", "s3cret") }, config);

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe("missing_api_key");
  });

  it("rejects an invalid X-Internal-Api-Key value even with valid Basic Auth", () => {
    const result = checkAuth(
      {
        authorization: basicAuthHeader("admin", "s3cret"),
        "x-internal-api-key": "wrong-key",
      },
      config,
    );

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe("invalid_api_key");
  });

  it("requires BOTH Basic Auth and the API key — neither alone is sufficient", () => {
    const onlyApiKey = checkAuth({ "x-internal-api-key": "internal-key-123" }, config);
    const onlyBasicAuth = checkAuth({ authorization: basicAuthHeader("admin", "s3cret") }, config);

    expect(onlyApiKey.authenticated).toBe(false);
    expect(onlyBasicAuth.authenticated).toBe(false);
  });
});
