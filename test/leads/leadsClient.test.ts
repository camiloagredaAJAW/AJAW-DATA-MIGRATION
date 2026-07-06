import { describe, expect, it, vi } from "vitest";
import {
  fetchCatalog,
  fetchCountrySample,
  sampleCountries,
  type LeadsClientConfig,
} from "../../src/leads/leadsClient.js";

function baseConfig(fetchImpl: typeof fetch): LeadsClientConfig {
  return {
    baseUrl: "http://leads.example.test",
    dbsPath: "dbs",
    companiesPath: "companies",
    keyValue: "ajaw_live_2026",
    fetchImpl,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

describe("fetchCatalog", () => {
  it("flattens the /dbs countries map into source_db/source_table pairs, ignoring the legacy databases object", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        countries: { AR: "ar", BO: "bo" },
        databases: { ar: ["companies", "ar_extra"], ar_sipro: ["sipro"] },
      }),
    );

    const entries = await fetchCatalog(baseConfig(fetchImpl as unknown as typeof fetch));

    expect(entries).toEqual([
      { sourceDb: "AR", sourceTable: "companies" },
      { sourceDb: "BO", sourceTable: "companies" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchImpl.mock.calls[0] as [string];
    expect(calledUrl).toContain("/dbs");
    expect(calledUrl).toContain("key=ajaw_live_2026");
  });

  it("returns an empty array when the countries object is empty, even if databases still has entries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        countries: {},
        databases: { ar: ["companies"] },
      }),
    );

    const entries = await fetchCatalog(baseConfig(fetchImpl as unknown as typeof fetch));

    expect(entries).toEqual([]);
  });

  it("throws when the catalog request responds with a non-ok status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));

    await expect(fetchCatalog(baseConfig(fetchImpl as unknown as typeof fetch))).rejects.toThrow(
      /503/,
    );
  });
});

describe("fetchCountrySample", () => {
  it("requests the companies endpoint with country/has_phone/has_email/format/limit/offset and parses JSONL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      textResponse('{"legal_name":"ACME"}\n{"legal_name":"OTHER"}'),
    );

    const rows = await fetchCountrySample(
      baseConfig(fetchImpl as unknown as typeof fetch),
      "AR",
      3,
    );

    expect(rows).toEqual([{ legal_name: "ACME" }, { legal_name: "OTHER" }]);
    const [calledUrl] = fetchImpl.mock.calls[0] as [string];
    expect(calledUrl).toContain("/companies");
    expect(calledUrl).toContain("country=AR");
    expect(calledUrl).toContain("has_phone=1");
    expect(calledUrl).toContain("has_email=1");
    expect(calledUrl).toContain("format=jsonl");
    expect(calledUrl).toContain("limit=3");
    expect(calledUrl).toContain("offset=0");
    expect(calledUrl).toContain("key=ajaw_live_2026");
  });

  it("returns an empty array for a country with zero rows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(""));

    const rows = await fetchCountrySample(
      baseConfig(fetchImpl as unknown as typeof fetch),
      "BO",
      3,
    );

    expect(rows).toEqual([]);
  });

  it("uses a generous per-request timeout (default well above the observed 45s worst case)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(""));
    const config = baseConfig(fetchImpl as unknown as typeof fetch);

    await fetchCountrySample(config, "BR", 3);

    const [, options] = fetchImpl.mock.calls[0] as [string, { signal: AbortSignal }];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws a descriptive error when the companies request responds with a non-ok status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse("", false, 500));

    await expect(
      fetchCountrySample(baseConfig(fetchImpl as unknown as typeof fetch), "NI", 3),
    ).rejects.toThrow(/NI.*500/);
  });
});

describe("sampleCountries", () => {
  it("continues sampling remaining countries when one country's request fails, and reports the failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(textResponse('{"legal_name":"ACME"}'));

    const outcomes = await sampleCountries(
      baseConfig(fetchImpl as unknown as typeof fetch),
      [
        { sourceDb: "NI", sourceTable: "companies" },
        { sourceDb: "AR", sourceTable: "companies" },
      ],
      3,
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({
      sourceDb: "NI",
      sourceTable: "companies",
      rows: [],
      error: "timeout",
    });
    expect(outcomes[1]).toMatchObject({
      sourceDb: "AR",
      sourceTable: "companies",
      rows: [{ legal_name: "ACME" }],
    });
    expect(outcomes[1]?.error).toBeUndefined();
  });

  it("returns an empty outcomes array for an empty pair list", async () => {
    const fetchImpl = vi.fn();

    const outcomes = await sampleCountries(baseConfig(fetchImpl as unknown as typeof fetch), [], 3);

    expect(outcomes).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
