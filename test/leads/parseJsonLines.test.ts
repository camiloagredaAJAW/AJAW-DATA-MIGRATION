import { describe, expect, it } from "vitest";
import { parseJsonLines } from "../../src/leads/parseJsonLines.js";

describe("parseJsonLines", () => {
  it("parses compact newline-delimited JSON objects", () => {
    const text = '{"a":1}\n{"a":2}\n{"a":3}';

    const result = parseJsonLines(text);

    expect(result).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it("parses pretty-printed, multi-line concatenated JSON objects (no separators between them)", () => {
    const text = `{
      "company_id": "ar_1",
      "legal_name": "ACME"
    }
    {
      "company_id": "ar_2",
      "legal_name": "OTHER"
    }`;

    const result = parseJsonLines(text);

    expect(result).toEqual([
      { company_id: "ar_1", legal_name: "ACME" },
      { company_id: "ar_2", legal_name: "OTHER" },
    ]);
  });

  it("does not get confused by braces inside string values", () => {
    const text = '{"note":"contains a { brace } inside a string"}';

    const result = parseJsonLines(text);

    expect(result).toEqual([{ note: "contains a { brace } inside a string" }]);
  });

  it("returns an empty array for blank input (0-row table)", () => {
    expect(parseJsonLines("")).toEqual([]);
    expect(parseJsonLines("   \n  ")).toEqual([]);
  });
});
