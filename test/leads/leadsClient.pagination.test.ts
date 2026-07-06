import { describe, expect, it, vi } from "vitest";
import { fetchCompaniesPage, type LeadsClientConfig } from "../../src/leads/leadsClient.js";

function baseConfig(fetchImpl: typeof fetch): LeadsClientConfig {
  return {
    baseUrl: "http://leads.example.test",
    dbsPath: "dbs",
    companiesPath: "companies",
    keyValue: "ajaw_live_2026",
    fetchImpl,
  };
}

function textResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

describe("fetchCompaniesPage", () => {
  it("requests the companies endpoint with country/has_phone/has_email/format/limit/offset and parses JSONL", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(textResponse('{"legal_name":"ACME"}\n{"legal_name":"OTHER"}'));

    const rows = await fetchCompaniesPage(
      baseConfig(fetchImpl as unknown as typeof fetch),
      "AR",
      100,
      200,
    );

    expect(rows).toEqual([{ legal_name: "ACME" }, { legal_name: "OTHER" }]);
    const [calledUrl] = fetchImpl.mock.calls[0] as [string];
    expect(calledUrl).toContain("/companies");
    expect(calledUrl).toContain("country=AR");
    expect(calledUrl).toContain("has_phone=1");
    expect(calledUrl).toContain("has_email=1");
    expect(calledUrl).toContain("format=jsonl");
    expect(calledUrl).toContain("limit=100");
    expect(calledUrl).toContain("offset=200");
    expect(calledUrl).toContain("key=ajaw_live_2026");
  });

  it("returns a partial page (fewer rows than limit) without error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('{"legal_name":"ACME"}'));

    const rows = await fetchCompaniesPage(baseConfig(fetchImpl as unknown as typeof fetch), "BO", 100, 0);

    expect(rows).toEqual([{ legal_name: "ACME" }]);
  });

  it("returns an empty page for a country with zero rows at the given offset", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(""));

    const rows = await fetchCompaniesPage(baseConfig(fetchImpl as unknown as typeof fetch), "NI", 100, 500);

    expect(rows).toEqual([]);
  });

  it("throws a descriptive error when the companies request responds with a non-ok status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse("", false, 500));

    await expect(
      fetchCompaniesPage(baseConfig(fetchImpl as unknown as typeof fetch), "NI", 100, 0),
    ).rejects.toThrow(/NI.*500/);
  });
});
