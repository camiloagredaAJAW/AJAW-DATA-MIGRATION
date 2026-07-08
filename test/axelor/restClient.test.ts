import { describe, expect, it, vi } from "vitest";
import {
  createAiSearch,
  createAiSearchResults,
  getAiSearch,
  updateAiSearch,
} from "../../src/axelor/restClient.js";
import type { AxelorSessionClient } from "../../src/axelor/sessionClient.js";
import type { AxelorConfig } from "../../src/config/env.js";
import type { AiSearchResultsPayload } from "../../src/migration/payloadBuilder.js";

function baseConfig(): AxelorConfig {
  return {
    baseUrl: "http://axelor.example.test",
    username: "admin",
    password: "secret",
    namespace: "com.ajawmrp3.apps.prospectingai.db",
    modelNameCompanies: "AiSearchResults",
  };
}

function fakeSession(): AxelorSessionClient {
  return {
    getSession: vi
      .fn()
      .mockResolvedValue({ authHeader: "Basic xyz", cookieHeader: "JSESSIONID=abc" }),
    invalidate: vi.fn(),
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("createAiSearch", () => {
  it("PUTs to the AiSearch model and returns the created id from a status:0 response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: 0, data: [{ id: 7, statusSelect: 1 }] }));
    const session = fakeSession();

    const result = await createAiSearch(
      session,
      baseConfig(),
      { statusSelect: 1, searchString: "aesthetic clinics", resultsNumber: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ id: 7 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://axelor.example.test/ws/rest/com.ajawmrp3.apps.prospectingai.db.AiSearch",
    );
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      data: { statusSelect: 1, searchString: "aesthetic clinics", resultsNumber: 0 },
    });
  });

  it("throws a descriptive error when Axelor responds with a non-zero status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: 1, data: [] }));
    const session = fakeSession();

    await expect(
      createAiSearch(
        session,
        baseConfig(),
        { statusSelect: 1, searchString: "x", resultsNumber: 0 },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/status 1/);
  });
});

describe("createAiSearchResults", () => {
  it("PUTs to the AJAW_NAMESPACE.MODEL_NAME_COMPANIES model with the full payload as the body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: 0, data: [{ id: 20, title: "ACME" }] }));
    const session = fakeSession();
    const payload: AiSearchResultsPayload = { title: "ACME", aiSearch: { id: 1 } };

    const result = await createAiSearchResults(
      session,
      baseConfig(),
      payload,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ id: 20 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://axelor.example.test/ws/rest/com.ajawmrp3.apps.prospectingai.db.AiSearchResults",
    );
    expect(JSON.parse(init.body as string)).toEqual({ data: payload });
  });

  it("invalidates the session and retries once when the first PUT responds with HTTP 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, false, 401))
      .mockResolvedValueOnce(jsonResponse({ status: 0, data: [{ id: 21 }] }));
    const session = fakeSession();
    const payload: AiSearchResultsPayload = { title: "ACME", aiSearch: { id: 1 } };

    const result = await createAiSearchResults(
      session,
      baseConfig(),
      payload,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ id: 21 });
    expect(session.invalidate).toHaveBeenCalledTimes(1);
    expect(session.getSession).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry more than once when Axelor keeps responding with 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 401));
    const session = fakeSession();
    const payload: AiSearchResultsPayload = { title: "ACME", aiSearch: { id: 1 } };

    await expect(
      createAiSearchResults(session, baseConfig(), payload, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/401/);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(session.invalidate).toHaveBeenCalledTimes(1);
  });
});

describe("getAiSearch", () => {
  it("GETs the AiSearch record by id and returns its full progress fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 0,
        data: [{ id: 7, version: 3, statusSelect: 1, resultsNumber: 12 }],
      }),
    );
    const session = fakeSession();

    const result = await getAiSearch(
      session,
      baseConfig(),
      7,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ id: 7, version: 3, statusSelect: 1, resultsNumber: 12 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://axelor.example.test/ws/rest/com.ajawmrp3.apps.prospectingai.db.AiSearch/7",
    );
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("invalidates the session and retries once when the first GET responds with HTTP 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, false, 401))
      .mockResolvedValueOnce(
        jsonResponse({
          status: 0,
          data: [{ id: 7, version: 3, statusSelect: 1, resultsNumber: 12 }],
        }),
      );
    const session = fakeSession();

    const result = await getAiSearch(
      session,
      baseConfig(),
      7,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ id: 7, version: 3, statusSelect: 1, resultsNumber: 12 });
    expect(session.invalidate).toHaveBeenCalledTimes(1);
    expect(session.getSession).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry more than once when Axelor keeps responding with 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 401));
    const session = fakeSession();

    await expect(
      getAiSearch(session, baseConfig(), 7, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/401/);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(session.invalidate).toHaveBeenCalledTimes(1);
  });

  it("throws a descriptive error on a non-ok, non-401 status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    const session = fakeSession();

    await expect(
      getAiSearch(session, baseConfig(), 7, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/500/);
  });

  it("throws when the response envelope is missing version/statusSelect/resultsNumber", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: 0, data: [{ id: 7 }] }));
    const session = fakeSession();

    await expect(
      getAiSearch(session, baseConfig(), 7, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow();
  });

  it("throws when Axelor responds HTTP 200 but rejects the request (status !== 0)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: 1, data: [] }));
    const session = fakeSession();

    await expect(
      getAiSearch(session, baseConfig(), 7, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/status 1/);
  });
});

describe("updateAiSearch", () => {
  it("POSTs to the AiSearch/:id endpoint with id/version/statusSelect/resultsNumber", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 0,
        data: [{ id: 7, version: 4, statusSelect: 2, resultsNumber: 13 }],
      }),
    );
    const session = fakeSession();

    const result = await updateAiSearch(
      session,
      baseConfig(),
      { id: 7, version: 3, statusSelect: 2, resultsNumber: 13 },
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ id: 7, version: 4, statusSelect: 2, resultsNumber: 13 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://axelor.example.test/ws/rest/com.ajawmrp3.apps.prospectingai.db.AiSearch/7",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      data: { id: 7, version: 3, statusSelect: 2, resultsNumber: 13 },
    });
  });

  it("invalidates the session and retries once when the first POST responds with HTTP 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, false, 401))
      .mockResolvedValueOnce(
        jsonResponse({
          status: 0,
          data: [{ id: 7, version: 4, statusSelect: 2, resultsNumber: 13 }],
        }),
      );
    const session = fakeSession();

    const result = await updateAiSearch(
      session,
      baseConfig(),
      { id: 7, version: 3, statusSelect: 2, resultsNumber: 13 },
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ id: 7, version: 4, statusSelect: 2, resultsNumber: 13 });
    expect(session.invalidate).toHaveBeenCalledTimes(1);
    expect(session.getSession).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry more than once when Axelor keeps responding with 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 401));
    const session = fakeSession();

    await expect(
      updateAiSearch(
        session,
        baseConfig(),
        { id: 7, version: 3, statusSelect: 2, resultsNumber: 13 },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/401/);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(session.invalidate).toHaveBeenCalledTimes(1);
  });

  it("throws a descriptive error on a non-ok, non-401 status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    const session = fakeSession();

    await expect(
      updateAiSearch(
        session,
        baseConfig(),
        { id: 7, version: 3, statusSelect: 2, resultsNumber: 13 },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/500/);
  });

  it("throws when the response envelope is missing version/statusSelect/resultsNumber", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: 0, data: [{ id: 7 }] }));
    const session = fakeSession();

    await expect(
      updateAiSearch(
        session,
        baseConfig(),
        { id: 7, version: 3, statusSelect: 2, resultsNumber: 13 },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow();
  });

  it("throws when Axelor responds HTTP 200 but rejects the request (status !== 0)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: 1, data: [] }));
    const session = fakeSession();

    await expect(
      updateAiSearch(
        session,
        baseConfig(),
        { id: 7, version: 3, statusSelect: 2, resultsNumber: 13 },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/status 1/);
  });
});
