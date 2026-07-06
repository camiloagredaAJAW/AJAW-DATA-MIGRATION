import type { AxelorConfig } from "../config/env.js";
import type { AiSearchResultsPayload } from "../migration/payloadBuilder.js";
import { parsePutEnvelope } from "./putEnvelope.js";
import type { AxelorSessionClient } from "./sessionClient.js";

export interface CreateAiSearchInput {
  readonly statusSelect: number;
  readonly searchString: string;
  readonly resultsNumber: number;
}

/**
 * Performs one Axelor `PUT /ws/rest/{modelName}` create call, attaching the
 * cached session's auth/cookie headers. On HTTP 401 (session expired), it
 * invalidates the session and retries exactly once with a freshly
 * re-authenticated session before giving up.
 */
async function putRecord(
  session: AxelorSessionClient,
  config: AxelorConfig,
  modelName: string,
  data: Record<string, unknown>,
  fetchImpl: typeof fetch,
  hasRetried = false,
): Promise<{ id: number }> {
  const { authHeader, cookieHeader } = await session.getSession();
  const url = `${config.baseUrl}/ws/rest/${modelName}`;

  const response = await fetchImpl(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
      Cookie: cookieHeader,
    },
    body: JSON.stringify({ data }),
  });

  if (response.status === 401) {
    if (hasRetried) {
      throw new Error(
        `Axelor PUT to ${modelName} failed with status 401 after re-authenticating once`,
      );
    }
    session.invalidate();
    return putRecord(session, config, modelName, data, fetchImpl, true);
  }

  if (!response.ok) {
    throw new Error(`Axelor PUT to ${modelName} failed with status ${response.status}`);
  }

  const body = await response.json();
  return parsePutEnvelope(body, modelName);
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
