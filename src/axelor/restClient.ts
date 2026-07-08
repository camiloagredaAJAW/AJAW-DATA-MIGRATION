import type { AxelorConfig } from "../config/env.js";
import type { AiSearchResultsPayload } from "../migration/payloadBuilder.js";
import { parseAiSearchEnvelope, parsePutEnvelope, type AiSearchEnvelopeRecord } from "./putEnvelope.js";
import type { AxelorSessionClient } from "./sessionClient.js";

export interface CreateAiSearchInput {
  readonly statusSelect: number;
  readonly searchString: string;
  readonly resultsNumber: number;
}

/**
 * Shared GET/PUT/POST-with-401-retry-once skeleton behind `putRecord`,
 * `getRecord`, and `postUpdateRecord`: attaches the cached session's
 * auth/cookie headers and performs the request. On HTTP 401 (session
 * expired), it invalidates the session and retries the whole request exactly
 * once with a freshly re-authenticated session before giving up — any other
 * non-ok response throws immediately. `body` is omitted (no `Content-Type`
 * header, no JSON body) for GET requests; PUT/POST requests always send
 * `{ data: body }`. `errorLabel` (e.g. `PUT to ${modelName}`) is interpolated
 * into both error messages so each caller keeps its own exact wording.
 */
async function axelorRequest<T>(
  session: AxelorSessionClient,
  method: "PUT" | "GET" | "POST",
  url: string,
  body: Record<string, unknown> | undefined,
  parseBody: (responseBody: unknown) => T,
  errorLabel: string,
  fetchImpl: typeof fetch,
  hasRetried = false,
): Promise<T> {
  const { authHeader, cookieHeader } = await session.getSession();

  const response = await fetchImpl(url, {
    method,
    headers:
      body !== undefined
        ? { "Content-Type": "application/json", Authorization: authHeader, Cookie: cookieHeader }
        : { Authorization: authHeader, Cookie: cookieHeader },
    ...(body !== undefined ? { body: JSON.stringify({ data: body }) } : {}),
  });

  if (response.status === 401) {
    if (hasRetried) {
      throw new Error(`Axelor ${errorLabel} failed with status 401 after re-authenticating once`);
    }
    session.invalidate();
    return axelorRequest(session, method, url, body, parseBody, errorLabel, fetchImpl, true);
  }

  if (!response.ok) {
    throw new Error(`Axelor ${errorLabel} failed with status ${response.status}`);
  }

  const responseBody = await response.json();
  return parseBody(responseBody);
}

/**
 * Performs one Axelor `PUT /ws/rest/{modelName}` create call. See
 * `axelorRequest` for the shared auth/401-retry-once/error skeleton.
 */
async function putRecord(
  session: AxelorSessionClient,
  config: AxelorConfig,
  modelName: string,
  data: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<{ id: number }> {
  const url = `${config.baseUrl}/ws/rest/${modelName}`;
  return axelorRequest(
    session,
    "PUT",
    url,
    data,
    (responseBody) => parsePutEnvelope(responseBody, modelName),
    `PUT to ${modelName}`,
    fetchImpl,
  );
}

/**
 * Creates one `AiSearch` parent record for a country. There is no env var
 * for this model's suffix — it is hardcoded per design, unlike
 * `AiSearchResults` which reads `MODEL_NAME_COMPANIES`.
 */
export async function createAiSearch(
  session: AxelorSessionClient,
  config: AxelorConfig,
  input: CreateAiSearchInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number }> {
  return putRecord(session, config, `${config.namespace}.AiSearch`, { ...input }, fetchImpl);
}

/**
 * Creates one `AiSearchResults` child record referencing its `AiSearch`
 * parent via `payload.aiSearch.id` (attached by `buildAiSearchResultsPayload`).
 */
export async function createAiSearchResults(
  session: AxelorSessionClient,
  config: AxelorConfig,
  payload: AiSearchResultsPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number }> {
  return putRecord(
    session,
    config,
    `${config.namespace}.${config.modelNameCompanies}`,
    { ...payload },
    fetchImpl,
  );
}

/**
 * Performs one Axelor `GET /ws/rest/{modelName}/{id}` read call. See
 * `axelorRequest` for the shared auth/401-retry-once/error skeleton.
 */
async function getRecord(
  session: AxelorSessionClient,
  config: AxelorConfig,
  modelName: string,
  id: number,
  fetchImpl: typeof fetch,
): Promise<AiSearchEnvelopeRecord> {
  const url = `${config.baseUrl}/ws/rest/${modelName}/${id}`;
  return axelorRequest(
    session,
    "GET",
    url,
    undefined,
    (responseBody) => parseAiSearchEnvelope(responseBody, modelName),
    `GET to ${modelName}/${id}`,
    fetchImpl,
  );
}

/**
 * Performs one Axelor `POST /ws/rest/{modelName}/{id}` update call
 * (Axelor's REST convention for updates — see `AXELOR_INTEGRATION.md`'s
 * "Actualizar un registro" row). See `axelorRequest` for the shared
 * auth/401-retry-once/error skeleton.
 */
async function postUpdateRecord(
  session: AxelorSessionClient,
  config: AxelorConfig,
  modelName: string,
  id: number,
  data: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<AiSearchEnvelopeRecord> {
  const url = `${config.baseUrl}/ws/rest/${modelName}/${id}`;
  return axelorRequest(
    session,
    "POST",
    url,
    data,
    (responseBody) => parseAiSearchEnvelope(responseBody, modelName),
    `POST to ${modelName}/${id}`,
    fetchImpl,
  );
}

/** A fully-populated `AiSearch` record, including its optimistic-lock `version`. */
export interface AiSearchRecord {
  readonly id: number;
  readonly version: number;
  readonly statusSelect: number;
  readonly resultsNumber: number;
}

export interface UpdateAiSearchInput {
  readonly id: number;
  readonly version: number;
  readonly statusSelect: number;
  readonly resultsNumber: number;
}

/**
 * Reads the current state of one `AiSearch` parent record. Callers pushing
 * progress updates must call this immediately before `updateAiSearch` every
 * time — never cache/reuse a previously-read `version` — since Axelor's
 * optimistic lock on this record can be advanced concurrently (e.g. a retry
 * from the Errors page, or a prior attempt of the same push).
 */
export async function getAiSearch(
  session: AxelorSessionClient,
  config: AxelorConfig,
  id: number,
  fetchImpl: typeof fetch = fetch,
): Promise<AiSearchRecord> {
  return getRecord(session, config, `${config.namespace}.AiSearch`, id, fetchImpl);
}

/**
 * Updates one `AiSearch` parent record's progress fields (`statusSelect`,
 * `resultsNumber`), sending back the `version` the caller must have just read
 * via `getAiSearch`.
 */
export async function updateAiSearch(
  session: AxelorSessionClient,
  config: AxelorConfig,
  input: UpdateAiSearchInput,
  fetchImpl: typeof fetch = fetch,
): Promise<AiSearchRecord> {
  return postUpdateRecord(session, config, `${config.namespace}.AiSearch`, input.id, { ...input }, fetchImpl);
}
