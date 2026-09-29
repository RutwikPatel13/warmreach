import fs from "node:fs";
import path from "node:path";

// ── Interview-prep store ────────────────────────────────────────────────────
// Two kinds of file on disk, both owned by this module and read/written nowhere
// else. Same contract as watchlist.ts: read-modify-write whole files, fail open
// on anything unreadable. Nothing here talks to LeetCode — prepSources.ts does
// the fetching and hands results back through writeSet().
//
//   data/prep/<company>.json   the question set for one company
//   data/prep_progress.json    YOUR work: status, solution, notes
//
// The split is the point. A re-sync replaces the question set wholesale, and it
// must never be able to take a solution you wrote down with it. Progress lives
// in its own file keyed "<company>:<id>", so the two operations can't collide.

const PREP_DIR = path.resolve("data/prep");
const PROGRESS_STORE = path.resolve("data/prep_progress.json");

/** LeetCode's own recency buckets, tightest first. Order is load-bearing. */
export const WINDOWS = [
  "thirty-days",
  "three-months",
  "six-months",
  "more-than-six-months",
  "all",
] as const;
export type Window = (typeof WINDOWS)[number];

export const WINDOW_LABEL: Record<Window, string> = {
  "thirty-days": "30 days",
  "three-months": "3 months",
  "six-months": "6 months",
  "more-than-six-months": "6+ months",
  all: "All time",
};

export type Difficulty = "Easy" | "Medium" | "Hard";

/**
 * Company tags and study plans are different animals and must not be rendered
 * with the same furniture. A company list carries recency windows and a
 * frequency ranking; a study plan carries neither — it's an ordered curriculum
 * grouped by topic. Showing "freq #12" or "asked in the last 30 days" over a
 * study plan would be inventing a signal that doesn't exist.
 */
export type SetKind = "company" | "studyplan";

/** todo → doing → done. Seeded from LeetCode once, then yours to drive. */
export type Status = "todo" | "doing" | "done";

export interface PrepQuestion {
  /** LeetCode's frontend question number, the one shown in the UI. */
  id: number;
  slug: string;
  title: string;
  difficulty: Difficulty;
  /** Percent, 0–100. Both mirrors express this differently; normalised here. */
  acceptance: number;
  /**
   * Position in the widest window the question appears in. That ordering is
   * LeetCode's own frequency ranking, so rank IS the frequency signal — there
   * is no per-question magnitude available anywhere, and inventing one would
   * dress a guess up as a measurement.
   */
  rank: number;
  /** Every window this question appears in; windows[0] is the tightest. */
  windows: Window[];
  /** Solved on LeetCode as of the last sync. Provenance, not your status. */
  lcSolved: boolean;
  tags: string[];
  statement: string;
  /** Study plans only: the topic group this question belongs to. */
  section?: string;
  /**
   * Premium-only on LeetCode. The public API withholds `content` for these, so
   * `statement` stays empty no matter how many times you sync — the UI has to
   * say "open it on LeetCode" rather than "a sync will fetch this".
   */
  paidOnly?: boolean;
}

export interface PrepSource {
  repo: string;
  /** When the DATA was last updated, which is not when we fetched it. */
  snapshot: string;
  windows: Window[];
}

export interface PrepSet {
  /** Slug: a company ("linkedin") or a study-plan id ("top-sql-50"). */
  company: string;
  label: string;
  kind: SetKind;
  /** Study plans only: section names in curriculum order. */
  sections?: string[];
  syncedAt: string;
  sources: PrepSource[];
  questions: PrepQuestion[];
}

export interface Progress {
  st: Status;
  code: string;
  lang: string;
  notes: string;
  at: string | null;
}

export interface PrepCompany {
  company: string;
  label: string;
  kind: SetKind;
  total: number;
  syncedAt: string;
}

export const emptyProgress = (): Progress => ({
  st: "todo",
  code: "",
  lang: "python3",
  notes: "",
  at: null,
});

// ── plumbing ────────────────────────────────────────────────────────────────

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    // A corrupt store must not take the page down with it.
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Slugify a company name the way LeetCode does: "Goldman Sachs" → "goldman-sachs". */
export function companySlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// A company slug becomes a filename, so it must not be able to escape the
// directory. Anything that isn't the slug shape is rejected outright.
function setPath(company: string): string {
  const slug = companySlug(company);
  if (!slug) throw new Error("A company is required.");
  return path.join(PREP_DIR, `${slug}.json`);
}

// ── question sets ───────────────────────────────────────────────────────────

export function listPrepCompanies(): PrepCompany[] {
  let files: string[];
  try {
    files = fs.readdirSync(PREP_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no directory yet — nothing synced
  }
  return files
    .map((f) => readJson<PrepSet | null>(path.join(PREP_DIR, f), null))
    .filter((s): s is PrepSet => !!s?.company)
    .map((s) => ({
      company: s.company,
      label: s.label,
      // Sets written before study plans existed have no kind; they're companies.
      kind: s.kind ?? "company",
      total: s.questions?.length ?? 0,
      syncedAt: s.syncedAt,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function readSet(company: string): PrepSet | null {
  return readJson<PrepSet | null>(setPath(company), null);
}

/** Replace a company's question set. Never reads or writes progress. */
export function writeSet(set: PrepSet): void {
  writeJson(setPath(set.company), set);
}

// ── progress ────────────────────────────────────────────────────────────────

type ProgressFile = Record<string, Progress>;

const key = (company: string, id: number) => `${companySlug(company)}:${id}`;

/** Every saved record for one company, keyed by question id. */
export function readProgress(company: string): Record<number, Progress> {
  const all = readJson<ProgressFile>(PROGRESS_STORE, {});
  const prefix = `${companySlug(company)}:`;
  const out: Record<number, Progress> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(prefix)) out[Number(k.slice(prefix.length))] = v;
  }
  return out;
}

/**
 * Merge a patch into one question's record. Read-modify-write the whole file.
 *
 * `at` is stamped here rather than by the caller so it can't drift: a record
 * written by the CLI or a script would otherwise carry a solution but no
 * timestamp, and the UI would show "saved" and "not saved" at once. Status-only
 * changes don't touch it — it means "when the solution was last written".
 */
export function saveProgress(company: string, id: number, patch: Partial<Progress>): Progress {
  const all = readJson<ProgressFile>(PROGRESS_STORE, {});
  const k = key(company, id);
  const next: Progress = { ...emptyProgress(), ...all[k], ...patch };
  if (patch.code !== undefined || patch.notes !== undefined) {
    next.at = new Date().toISOString();
  }
  all[k] = next;
  writeJson(PROGRESS_STORE, all);
  return next;
}

/**
 * Give questions LeetCode already knows you've solved a starting status of
 * "done" — but only for questions with no record yet, so re-syncing can never
 * undo a question you deliberately sent back to "todo" for a re-run.
 */
export function seedProgressFromLeetCode(set: PrepSet): void {
  const all = readJson<ProgressFile>(PROGRESS_STORE, {});
  let touched = false;
  for (const q of set.questions) {
    const k = key(set.company, q.id);
    if (!all[k] && q.lcSolved) {
      all[k] = { ...emptyProgress(), st: "done" };
      touched = true;
    }
  }
  if (touched) writeJson(PROGRESS_STORE, all);
}
