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
const { escapeHtml, describeRetryOutcome, computeControlGating, formatRefreshCatalogResult } =
  require(appJsPath) as {
    escapeHtml: (value: unknown) => string;
    describeRetryOutcome: (status: number, body: unknown) => string;
    computeControlGating: (runStatus: string | null) => {
      startDisabled: boolean;
      pauseDisabled: boolean;
      resumeDisabled: boolean;
      stopDisabled: boolean;
    };
    formatRefreshCatalogResult: (result: { totalCatalogEntries: number; newPairs: unknown[] }) => string;
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
