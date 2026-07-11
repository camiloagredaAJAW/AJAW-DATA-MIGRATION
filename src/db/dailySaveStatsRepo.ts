import type Database from "better-sqlite3";

export interface DailySaveCount {
  readonly day: string;
  readonly count: number;
}

/**
 * Bumps `daily_save_stats.saved_count` for `day` by 1, creating the row on
 * the first save of that day. Purely additive telemetry — see the migration
 * this table was introduced in for why there is no historical backfill: it
 * only starts accumulating from whenever this migration is deployed.
 * `ON CONFLICT DO UPDATE` keeps this a single atomic statement rather than a
 * read-then-write, so concurrent saves within the same day never race.
 */
export function incrementSavedCount(db: Database.Database, day: string): void {
  db.prepare(`
    INSERT INTO daily_save_stats (day, saved_count)
    VALUES (?, 1)
    ON CONFLICT(day) DO UPDATE SET saved_count = saved_count + 1
  `).run(day);
}

/**
 * Reads saved-record counts per day, ascending, optionally starting at
 * `sinceDay` — mirrors `getErrorCountsByDay` in importErrorRepo.ts so the two
 * can be merged by `mergeDailyRecordCounts`.
 */
export function getSavedCountsByDay(db: Database.Database, sinceDay?: string): DailySaveCount[] {
  const sql =
    sinceDay === undefined
      ? `SELECT day, saved_count AS count FROM daily_save_stats ORDER BY day ASC`
      : `SELECT day, saved_count AS count FROM daily_save_stats WHERE day >= ? ORDER BY day ASC`;

  const rows =
    sinceDay === undefined
      ? db.prepare(sql).all()
      : db.prepare(sql).all(sinceDay);

  return rows as DailySaveCount[];
}
