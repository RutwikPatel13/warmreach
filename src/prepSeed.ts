import type { PrepSet } from "./prep";
import { SQL50_SET, sqlSeedIntegrity } from "./prepSeedSql";

// ── Seed question sets ──────────────────────────────────────────────────────
// Sets the page can show before any sync has run. Only public material ships
// in the repo: LeetCode's free "SQL 50" study plan. Company question lists are
// synced into data/ (see ./prepSources) and never committed — they come from
// LeetCode Premium, which isn't ours to redistribute.

export const SEEDS: Record<string, PrepSet> = {
  "top-sql-50": SQL50_SET,
};

/** Arithmetic checks on the shipped sets, so a hand-edit can't silently drift. */
export function prepSeedIntegrity(): string[] {
  return sqlSeedIntegrity();
}
