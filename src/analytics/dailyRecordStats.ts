/**
 * Pure functions for the admin dashboard's "saved vs error" chart — no DB
 * import, so these are unit-testable without a database (mirrors the pure
 * function extractions in public/app.js, e.g. `computeErrorsPaginationState`).
 */

export interface DailyRecordCount {
  readonly period: string; // "YYYY-MM-DD" — a day, or a week's Monday date, depending on caller
  readonly saved: number;
  readonly error: number;
}

interface DayCount {
  readonly day: string;
  readonly count: number;
}

/**
 * Merges saved/error per-day counts into the union of every day present in
 * either input, ascending. A day missing from one side reads as 0 on that
 * side rather than being dropped — the whole point of this chart is showing
 * "saved but no errors" and "errors but nothing saved yet" days alike.
 */
export function mergeDailyRecordCounts(saved: DayCount[], errors: DayCount[]): DailyRecordCount[] {
  const byDay = new Map<string, { saved: number; error: number }>();

  for (const { day, count } of saved) {
    byDay.set(day, { saved: count, error: byDay.get(day)?.error ?? 0 });
  }
  for (const { day, count } of errors) {
    byDay.set(day, { saved: byDay.get(day)?.saved ?? 0, error: count });
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([period, counts]) => ({ period, ...counts }));
}

/**
 * The Monday (UTC, "YYYY-MM-DD") of the ISO-8601 week containing `day`. Uses
 * UTC `Date` getters exclusively (no external date library) — mirrors the
 * manual-getter style of `formatTimestamp`/`getTodayUtcDateString` in
 * public/app.js, but this file is server-side TS, not that one.
 */
function isoWeekMonday(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const utcDate = new Date(Date.UTC(year, month - 1, date));

  // getUTCDay(): 0=Sunday..6=Saturday. ISO weeks start Monday, so shift the
  // scale to 0=Monday..6=Sunday and step back that many days.
  const daysSinceMonday = (utcDate.getUTCDay() + 6) % 7;
  utcDate.setUTCDate(utcDate.getUTCDate() - daysSinceMonday);

  const pad = (value: number) => String(value).padStart(2, "0");
  return `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())}`;
}

/**
 * Groups already-merged daily rows into ISO-8601 weeks (Monday start),
 * summing `saved`/`error` within each week. `period` becomes that week's
 * Monday. Result is sorted ascending by that Monday.
 */
export function bucketByIsoWeek(daily: readonly DailyRecordCount[]): DailyRecordCount[] {
  const byWeek = new Map<string, { saved: number; error: number }>();

  for (const { period, saved, error } of daily) {
    const monday = isoWeekMonday(period);
    const existing = byWeek.get(monday) ?? { saved: 0, error: 0 };
    byWeek.set(monday, { saved: existing.saved + saved, error: existing.error + error });
  }

  return Array.from(byWeek.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([period, counts]) => ({ period, ...counts }));
}
