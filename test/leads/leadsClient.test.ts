import { describe, expect, it, vi } from "vitest";
import {
  fetchCatalog,
  fetchTableSample,
  sampleTables,
  type LeadsClientConfig,
} from "../../src/leads/leadsClient.js";

function baseConfig(fetchImpl: typeof fetch): LeadsClientConfig {
  return {
    baseUrl: "http://leads.example.test",
    dbsPath: "dbs",
    exportPath: "export",
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
  it("flattens the /dbs databases map into source_db/source_table pairs", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        countries: { AR: "ar" },
        databases: { ar: ["companies", "ar_extra"], ar_sipro: ["sipro"] },
      }),
    );

    const entries = await fetchCatalog(baseConfig(fetchImpl as unknown as typeof fetch));

    expect(entries).toEqual([
      { sourceDb: "ar", sourceTable: "companies" },
      { sourceDb: "ar", sourceTable: "ar_extra" },
      { sourceDb: "ar_sipro", sourceTable: "sipro" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchImpl.mock.calls[0] as [string];
    expect(calledUrl).toContain("/dbs");
    expect(calledUrl).toContain("key=ajaw_live_2026");
  });

  it("throws when the catalog request responds with a non-ok status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));

    await expect(fetchCatalog(baseConfig(fetchImpl as unknown as typeof fetch))).rejects.toThrow(
      /503/,
    );
  });
});

describe("fetchTableSample", () => {
  it("requests the export endpoint with db/table/format/limit/offset and parses JSONL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      textResponse('{"legal_name":"ACME"}\n{"legal_name":"OTHER"}'),
    );

    const rows = await fetchTableSample(
      baseConfig(fetchImpl as unknown as typeof fetch),
      "ar",
      "companies",
      3,
    );

    expect(rows).toEqual([{ legal_name: "ACME" }, { legal_name: "OTHER" }]);
    const [calledUrl] = fetchImpl.mock.calls[0] as [string];
    expect(calledUrl).toContain("db=ar");
    expect(calledUrl).toContain("table=companies");
    expect(calledUrl).toContain("format=jsonl");
    expect(calledUrl).toContain("limit=3");
    expect(calledUrl).toContain("offset=0");
  });

  it("returns an empty array for a table with zero rows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(""));

    const rows = await fetchTableSample(
      baseConfig(fetchImpl as unknown as typeof fetch),
      "bo",
      "companies",
      3,
    );

    expect(rows).toEqual([]);
  });

  it("uses a generous per-request timeout (default well above the observed 45s worst case)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(""));
    const config = baseConfig(fetchImpl as unknown as typeof fetch);

    await fetchTableSample(config, "brazil_cnpj", "contacts", 3);

    const [, options] = fetchImpl.mock.calls[0] as [string, { signal: AbortSignal }];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("sampleTables", () => {
  it("continues sampling remaining tables when one table's request fails, and reports the failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(textResponse('{"legal_name":"ACME"}'));

    const outcomes = await sampleTables(
      baseConfig(fetchImpl as unknown as typeof fetch),
      [
        { sourceDb: "brazil_cnpj", sourceTable: "contacts" },
        { sourceDb: "ar", sourceTable: "companies" },
      ],
      3,
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({
      sourceDb: "brazil_cnpj",
      sourceTable: "contacts",
      rows: [],
      error: "timeout",
    });
    expect(outcomes[1]).toMatchObject({
      sourceDb: "ar",
      sourceTable: "companies",
      rows: [{ legal_name: "ACME" }],
    });
    expect(outcomes[1]?.error).toBeUndefined();
  });

  it("returns an empty outcomes array for an empty pair list", async () => {
    const fetchImpl = vi.fn();

    const outcomes = await sampleTables(baseConfig(fetchImpl as unknown as typeof fetch), [], 3);

    expect(outcomes).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
