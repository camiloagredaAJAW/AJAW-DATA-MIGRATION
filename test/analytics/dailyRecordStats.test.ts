import { describe, expect, it } from "vitest";
import { mergeDailyRecordCounts, bucketByIsoWeek } from "../../src/analytics/dailyRecordStats.js";

describe("mergeDailyRecordCounts", () => {
  it("returns an empty array when both inputs are empty", () => {
    expect(mergeDailyRecordCounts([], [])).toEqual([]);
  });

  it("gives a day present only in saved an error count of 0", () => {
    const result = mergeDailyRecordCounts([{ day: "2026-07-08", count: 5 }], []);

    expect(result).toEqual([{ period: "2026-07-08", saved: 5, error: 0 }]);
  });

  it("gives a day present only in errors a saved count of 0", () => {
    const result = mergeDailyRecordCounts([], [{ day: "2026-07-08", count: 3 }]);

    expect(result).toEqual([{ period: "2026-07-08", saved: 0, error: 3 }]);
  });

  it("merges a day present in both into one entry", () => {
    const result = mergeDailyRecordCounts(
      [{ day: "2026-07-08", count: 5 }],
      [{ day: "2026-07-08", count: 3 }],
    );

    expect(result).toEqual([{ period: "2026-07-08", saved: 5, error: 3 }]);
  });

  it("returns the union of days sorted ascending, regardless of input order", () => {
    const result = mergeDailyRecordCounts(
      [
        { day: "2026-07-09", count: 2 },
        { day: "2026-07-07", count: 1 },
      ],
      [{ day: "2026-07-08", count: 4 }],
    );

    expect(result).toEqual([
      { period: "2026-07-07", saved: 1, error: 0 },
      { period: "2026-07-08", saved: 0, error: 4 },
      { period: "2026-07-09", saved: 2, error: 0 },
    ]);
  });
});

describe("bucketByIsoWeek", () => {
  it("returns an empty array for empty input", () => {
    expect(bucketByIsoWeek([])).toEqual([]);
  });

  it("buckets a Sunday into the same ISO week as the Monday before it", () => {
    // 2026-07-06 is a Monday; 2026-07-12 is the Sunday ending that same
    // ISO week.
    const daily = [
      { period: "2026-07-06", saved: 3, error: 1 },
      { period: "2026-07-12", saved: 2, error: 0 },
    ];

    const buckets = bucketByIsoWeek(daily);

    expect(buckets).toEqual([{ period: "2026-07-06", saved: 5, error: 1 }]);
  });

  it("buckets a week spanning a month and year boundary correctly (Dec 29 Mon - Jan 4 Sun)", () => {
    const daily = [
      { period: "2025-12-29", saved: 1, error: 0 },
      { period: "2025-12-31", saved: 2, error: 1 },
      { period: "2026-01-01", saved: 0, error: 3 },
      { period: "2026-01-04", saved: 4, error: 0 },
    ];

    const buckets = bucketByIsoWeek(daily);

    expect(buckets).toEqual([{ period: "2025-12-29", saved: 7, error: 4 }]);
  });

  it("keeps separate weeks separate and sorted ascending by that week's Monday", () => {
    const daily = [
      { period: "2026-07-12", saved: 1, error: 0 }, // week of 2026-07-06
      { period: "2026-07-06", saved: 1, error: 0 }, // week of 2026-07-06
      { period: "2026-07-13", saved: 1, error: 0 }, // Monday of next week
    ];

    const buckets = bucketByIsoWeek(daily);

    expect(buckets).toEqual([
      { period: "2026-07-06", saved: 2, error: 0 },
      { period: "2026-07-13", saved: 1, error: 0 },
    ]);
  });
});
