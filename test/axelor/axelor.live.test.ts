import "dotenv/config";
import { describe, expect, it } from "vitest";
import { loadAxelorConfig } from "../../src/config/env.js";
import { createSessionClient } from "../../src/axelor/sessionClient.js";
import { createAiSearch, createAiSearchResults } from "../../src/axelor/restClient.js";

/**
 * Live integration tier (design's testing-strategy `--live` row) — exercises
 * a real Axelor dev environment end to end: `login.jsp` authentication, then
 * one real `AiSearch` parent create and one real `AiSearchResults` child
 * create. Skipped by default; `npx vitest run` (CI) never runs this file.
 *
 * To opt in with real dev credentials:
 *   1. Populate `.env` with AXELOR_BASE_URL / AXELOR_USERNAME /
 *      AXELOR_PASSWORD / AJAW_NAMESPACE / MODEL_NAME_COMPANIES pointing at a
 *      real Axelor dev instance.
 *   2. Run: RUN_LIVE_AXELOR=1 npx vitest run test/axelor/axelor.live.test.ts
 *
 * This tier does not attempt automated cleanup — the created records are
 * tagged with a `[live-test]` prefix in `searchString`/`title` so they are
 * easy to find and remove manually afterward in the dev environment. Axelor
 * REST delete semantics were out of scope for this slice (see design's open
 * questions: login.jsp cookie shape/lifetime and the AiSearch model suffix
 * are both unconfirmed against a real instance until this tier is run).
 */
describe.skipIf(!process.env.RUN_LIVE_AXELOR)("Axelor live integration", () => {
  it("logs in and creates a real AiSearch parent + AiSearchResults child record", async () => {
    const axelorConfig = loadAxelorConfig();
    const session = createSessionClient(axelorConfig);

    const parent = await createAiSearch(session, axelorConfig, {
      statusSelect: 1,
      searchString: "[live-test] migration-engine-core smoke test",
      resultsNumber: 0,
    });
    expect(typeof parent.id).toBe("number");

    const child = await createAiSearchResults(session, axelorConfig, {
      title: "[live-test] smoke test company",
      aiSearch: { id: parent.id },
    });
    expect(typeof child.id).toBe("number");
  });
});
