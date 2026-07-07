import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// `public/app.js` is plain browser JS (no build step, loaded directly via
// `<script src="/admin/app.js">`), not part of this project's TypeScript/ESM
// source tree. It exports its pure, DOM-independent functions via a
// `typeof module !== "undefined"` guard (see bottom of app.js) specifically
// so they can be exercised here with a plain Node `require()` — no jsdom/
// happy-dom dependency needed, since none of the functions tested below
// touch the DOM.
const require = createRequire(import.meta.url);
const appJsPath = path.join(process.cwd(), "public", "app.js");
const {
  escapeHtml,
  describeRetryOutcome,
  computeControlGating,
  formatRefreshCatalogResult,
  computeErrorsPaginationState,
  computeCorrectedErrorsOffset,
} = require(appJsPath) as {
  escapeHtml: (value: unknown) => string;
  describeRetryOutcome: (status: number, body: unknown) => string;
  computeControlGating: (runStatus: string | null) => {
    startDisabled: boolean;
    pauseDisabled: boolean;
    resumeDisabled: boolean;
    stopDisabled: boolean;
  };
  formatRefreshCatalogResult: (result: { totalCatalogEntries: number; newPairs: unknown[] }) => string;
  computeErrorsPaginationState: (
    offset: number,
    rowCount: number,
    total: number,
  ) => { prevDisabled: boolean; nextDisabled: boolean; indicatorText: string };
  computeCorrectedErrorsOffset: (
    offset: number,
    rowCount: number,
    total: number,
    pageSize: number,
  ) => number | null;
};

describe("escapeHtml", () => {
  it("escapes &, <, > for safe use in an HTML text node", () => {
    expect(escapeHtml("<script>alert('x')</script>")).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;",
    );
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes double quotes so the value cannot break out of a double-quoted HTML attribute", () => {
    const escaped = escapeHtml('a"b');
    expect(escaped).toBe("a&quot;b");
    // Simulate the exact call-site pattern used in renderMappingsTable:
    // value="${escapeHtml(...)}"
    const html = `<input value="${escaped}" />`;
    // The escaped output must not contain a literal `"` that would close
    // the attribute early.
    expect(escaped).not.toContain('"');
    expect(html).toBe('<input value="a&quot;b" />');
  });

  it("escapes single quotes so the value cannot break out of a single-quoted HTML attribute", () => {
    const escaped = escapeHtml("a'b");
    expect(escaped).toBe("a&#39;b");
    const html = `<input value='${escaped}' />`;
    expect(escaped).not.toContain("'");
    expect(html).toBe("<input value='a&#39;b' />");
  });

  it("treats null/undefined as an empty string", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("describeRetryOutcome", () => {
  it("maps 404 to 'not found'", () => {
    expect(describeRetryOutcome(404, {})).toBe("not found");
  });

  it("maps 409 to the response's error message, falling back to 'conflict'", () => {
    expect(describeRetryOutcome(409, { error: { message: "run is active" } })).toBe("run is active");
    expect(describeRetryOutcome(409, {})).toBe("conflict");
  });

  it("maps 200 to 'resolved'", () => {
    expect(describeRetryOutcome(200, {})).toBe("resolved");
  });

  it("maps 422 to a failure message including the reason, falling back to 'unknown reason'", () => {
    expect(describeRetryOutcome(422, { data: { reason: "record missing in Axelor" } })).toBe(
      "failed: record missing in Axelor",
    );
    expect(describeRetryOutcome(422, {})).toBe("failed: unknown reason");
  });

  it("falls back to a generic 'unexpected status' label for any other status", () => {
    expect(describeRetryOutcome(500, {})).toBe("unexpected status 500");
    expect(describeRetryOutcome(418, {})).toBe("unexpected status 418");
  });
});

describe("formatRefreshCatalogResult", () => {
  it("summarizes total entries and newly discovered pairs", () => {
    expect(
      formatRefreshCatalogResult({
        totalCatalogEntries: 17,
        newPairs: [{ sourceDb: "BR", sourceTable: "companies" }, { sourceDb: "PE", sourceTable: "companies" }, {}],
      }),
    ).toBe("Catalog refreshed: 17 countries total, 3 newly discovered.");
  });

  it("handles zero newly discovered pairs", () => {
    expect(formatRefreshCatalogResult({ totalCatalogEntries: 5, newPairs: [] })).toBe(
      "Catalog refreshed: 5 countries total, 0 newly discovered.",
    );
  });
});

describe("computeControlGating", () => {
  it("enables only start when there is no run (null status)", () => {
    expect(computeControlGating(null)).toEqual({
      startDisabled: false,
      pauseDisabled: true,
      resumeDisabled: true,
      stopDisabled: true,
    });
  });

  it("enables pause and stop, disables start and resume, when running", () => {
    expect(computeControlGating("running")).toEqual({
      startDisabled: true,
      pauseDisabled: false,
      resumeDisabled: true,
      stopDisabled: false,
    });
  });

  it("enables resume and stop, disables start and pause, when paused", () => {
    expect(computeControlGating("paused")).toEqual({
      startDisabled: true,
      pauseDisabled: true,
      resumeDisabled: false,
      stopDisabled: false,
    });
  });

  it("falls back to the same gating as no run for an unrecognized/unexpected status", () => {
    // e.g. "completed", "failed", or any future backend status value not in
    // RUN_ACTIVE_STATUSES: this is currently-undocumented fallback behavior,
    // asserted here as-is rather than changed.
    expect(computeControlGating("completed")).toEqual({
      startDisabled: false,
      pauseDisabled: true,
      resumeDisabled: true,
      stopDisabled: true,
    });
  });
});

describe("computeErrorsPaginationState", () => {
  it("disables Prev at offset 0 and enables Next when more rows remain", () => {
    expect(computeErrorsPaginationState(0, 50, 234)).toEqual({
      prevDisabled: true,
      nextDisabled: false,
      indicatorText: "Showing 1-50 of 234",
    });
  });

  it("enables Prev once past the first page", () => {
    expect(computeErrorsPaginationState(50, 50, 234)).toEqual({
      prevDisabled: false,
      nextDisabled: false,
      indicatorText: "Showing 51-100 of 234",
    });
  });

  it("disables Next on the last page (offset + rowCount >= total)", () => {
    expect(computeErrorsPaginationState(200, 34, 234)).toEqual({
      prevDisabled: false,
      nextDisabled: true,
      indicatorText: "Showing 201-234 of 234",
    });
  });

  it("shows a zero-rows indicator and disables both buttons when there are no matching rows", () => {
    expect(computeErrorsPaginationState(0, 0, 0)).toEqual({
      prevDisabled: true,
      nextDisabled: true,
      indicatorText: "No errors",
    });
  });

  it("produces an inverted 'Showing 51-50 of 49' indicator for rowCount=0 with offset>0 and total>0 — this function is not the layer that fixes that; `loadErrors` (via `computeCorrectedErrorsOffset`) detects this exact condition and retries at a corrected offset before this function is ever asked to render it", () => {
    expect(computeErrorsPaginationState(50, 0, 49)).toEqual({
      prevDisabled: false,
      nextDisabled: true,
      indicatorText: "Showing 51-50 of 49",
    });
  });
});

describe("computeCorrectedErrorsOffset", () => {
  it("steps back one page when the page emptied out but earlier pages still have rows", () => {
    // The scenario this exists for: viewing resolved=false errors on page 2
    // (offset 50), the last unresolved error on that page gets retried, the
    // next fetch at offset 50 returns 0 rows even though 49 rows remain.
    expect(computeCorrectedErrorsOffset(50, 0, 49, 50)).toBe(50 - 50);
  });

  it("clamps the corrected offset to 0 rather than going negative", () => {
    expect(computeCorrectedErrorsOffset(50, 0, 49, 100)).toBe(0);
  });

  it("returns null when the page has rows (no correction needed)", () => {
    expect(computeCorrectedErrorsOffset(50, 3, 53, 50)).toBeNull();
  });

  it("returns null when offset is already 0 (nowhere earlier to step back to)", () => {
    expect(computeCorrectedErrorsOffset(0, 0, 0, 50)).toBeNull();
  });

  it("returns null when total is also 0 (there really are no matching rows at all)", () => {
    expect(computeCorrectedErrorsOffset(50, 0, 0, 50)).toBeNull();
  });
});
