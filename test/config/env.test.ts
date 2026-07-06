import { describe, expect, it } from "vitest";
import { loadAxelorConfig, loadLeadsPageConfig } from "../../src/config/env.js";

function fullEnv(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    AXELOR_BASE_URL: "https://axelor.example.test",
    AXELOR_USERNAME: "admin",
    AXELOR_PASSWORD: "secret",
    AJAW_NAMESPACE: "com.ajaw",
    MODEL_NAME_COMPANIES: "Company",
    LEADS_DB_PAGE_LIMIT: "100",
    ...overrides,
  };
}

describe("loadAxelorConfig", () => {
  it("returns a typed config object when all required vars are present", () => {
    const config = loadAxelorConfig(fullEnv());

    expect(config).toEqual({
      baseUrl: "https://axelor.example.test",
      username: "admin",
      password: "secret",
      namespace: "com.ajaw",
      modelNameCompanies: "Company",
    });
  });

  it.each([
    "AXELOR_BASE_URL",
    "AXELOR_USERNAME",
    "AXELOR_PASSWORD",
    "AJAW_NAMESPACE",
    "MODEL_NAME_COMPANIES",
  ])("throws when %s is missing", (missingKey) => {
    const env = fullEnv({ [missingKey]: undefined });
    delete env[missingKey];

    expect(() => loadAxelorConfig(env)).toThrow(new RegExp(missingKey));
  });
});

describe("loadLeadsPageConfig", () => {
  it("returns a typed config object with the parsed integer page limit", () => {
    const config = loadLeadsPageConfig(fullEnv());

    expect(config).toEqual({ pageLimit: 100 });
  });

  it("throws when LEADS_DB_PAGE_LIMIT is missing", () => {
    const env = fullEnv();
    delete env.LEADS_DB_PAGE_LIMIT;

    expect(() => loadLeadsPageConfig(env)).toThrow(/LEADS_DB_PAGE_LIMIT/);
  });

  it("throws when LEADS_DB_PAGE_LIMIT is not a positive integer", () => {
    expect(() => loadLeadsPageConfig(fullEnv({ LEADS_DB_PAGE_LIMIT: "not-a-number" }))).toThrow(
      /LEADS_DB_PAGE_LIMIT/,
    );
    expect(() => loadLeadsPageConfig(fullEnv({ LEADS_DB_PAGE_LIMIT: "0" }))).toThrow(
      /LEADS_DB_PAGE_LIMIT/,
    );
    expect(() => loadLeadsPageConfig(fullEnv({ LEADS_DB_PAGE_LIMIT: "-5" }))).toThrow(
      /LEADS_DB_PAGE_LIMIT/,
    );
  });
});
