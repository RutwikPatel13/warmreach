import { execFile } from "node:child_process";
import { companyJobPostings, type JobPosting } from "./apollo";
import { fetchJobText } from "./jobText";
import { matchRoleToResume } from "./matchResume";
import { titleMatchesAny } from "./roleDefaults";
import {
  listWatches,
  makeMatch,
  markSeen,
  patchWatch,
  readSettings,
  saveMatches,
  seenFor,
  type Match,
  type Watch,
} from "./watchlist";

// ── The daily sweep ─────────────────────────────────────────────────────────
// Same shape as the scheduled-send loop in scheduler.ts: a durable store on disk,
// an interval owned by the running Next server, and an immediate tick on boot so
// a day missed while the laptop was shut is picked up on the next start.
//
// The order of the stages is what keeps this cheap. Apollo's job_postings call is
// free and unmetered, the seen-set diff is free, and the title prefilter is free —
// so by the time anything reaches Claude it is already a posting that is new AND
// plausibly relevant. On a typical morning that's a handful of calls, not a board.
//
// Nothing in this module mutates state owned by another feature. It reads Apollo
// through the existing client and writes only its own three JSON files.

const TICK_MS = 30 * 60 * 1000; // check every half hour whether anything is due
const DUE_AFTER_MS = 20 * 60 * 60 * 1000; // a watch is due ~once a day
const POSTINGS_PER_SWEEP = 250; // explicit — the shared default of 40 is left alone
const MAX_MATCH_CALLS_PER_RUN = 12; // safety valve on model spend per tick
const MAX_FIRST_SWEEP_MATCHES = 3; // a brand-new watch shows a few, not its whole board
const MAX_POSTING_AGE_MS = 45 * 24 * 60 * 60 * 1000;

let sweeping = false;

/** The title/location prefilter. Titles use token matching (see roleDefaults). */
function matchesFilters(posting: JobPosting, watch: Watch): boolean {
  if (!titleMatchesAny(posting.title, watch.titles)) return false;
  if (watch.locations.length > 0) {
    const loc = (posting.location ?? "").toLowerCase();
    if (!watch.locations.some((l) => loc.includes(l))) return false;
  }
  return true;
}

/**
 * Roles the filter would catch right now. Powers the "12 of 154 open roles"
 * preview in the add panel — free, since the postings call costs no credits.
 */
export async function previewMatches(
  orgId: string,
  titles: string[],
  locations: string[],
): Promise<{ total: number; matched: number; examples: string[] }> {
  const postings = await companyJobPostings(orgId, POSTINGS_PER_SWEEP);
  const watch = { titles: titles.map((t) => t.toLowerCase()), locations: locations.map((l) => l.toLowerCase()) } as Watch;
  const hits = postings.filter((p) => matchesFilters(p, watch));
  return { total: postings.length, matched: hits.length, examples: hits.slice(0, 3).map((p) => p.title) };
}

function isRecentEnough(posting: JobPosting): boolean {
  // postedAt is Apollo's first-seen timestamp, not the company's publish date.
  // Anything it has been sitting on for six weeks is not "newly opened" in any
  // sense worth a notification, even if it is new to us.
  if (!posting.postedAt) return true;
  const t = Date.parse(posting.postedAt);
  return Number.isNaN(t) || Date.now() - t < MAX_POSTING_AGE_MS;
}

function newestFirst(a: JobPosting, b: JobPosting): number {
  return Date.parse(b.postedAt ?? "") - Date.parse(a.postedAt ?? "") || 0;
}

/** Sweep one company. Returns the matches produced and the model calls spent. */
async function sweepWatch(watch: Watch, budget: number): Promise<{ found: Match[]; calls: number }> {
  const postings = await companyJobPostings(watch.orgId, POSTINGS_PER_SWEEP);
  const seen = seenFor(watch.id);
  const firstSweep = !watch.baselinedAt;

  const candidates = postings
    .filter((p) => !seen.has(p.id))
    .filter(isRecentEnough)
    .filter((p) => matchesFilters(p, watch))
    .sort(newestFirst);

  // On the very first sweep every posting looks new, so scoring them all would
  // mean dozens of model calls the moment a company is added. Record the whole
  // board as the baseline and score only the few newest matches, so day one
  // shows something useful without the bill.
  const cap = firstSweep ? Math.min(MAX_FIRST_SWEEP_MATCHES, budget) : budget;
  const toScore = candidates.slice(0, Math.max(0, cap));

  const found: Match[] = [];
  let calls = 0;
  for (const posting of toScore) {
    // Re-read the switch before every billed call, not once per run. A sweep can
    // last minutes; turning it off should stop the spend immediately rather than
    // at the end of the current company.
    if (!readSettings().scoringEnabled) break;
    calls++;
    try {
      const jd = await fetchJobText(posting.url);
      const assessment = await matchRoleToResume({
        title: posting.title,
        company: watch.name,
        location: posting.location,
        companyDescription: watch.description ?? null,
        companyKeywords: watch.keywords ?? [],
        jd,
      });
      if (!assessment) continue; // model called it a skip — not worth a referral

      found.push(
        makeMatch({
          watchId: watch.id,
          postingId: posting.id,
          company: watch.name,
          domain: watch.domain ?? null,
          logoUrl: watch.logoUrl ?? null,
          title: posting.title,
          location: posting.location,
          url: posting.url,
          postedAt: posting.postedAt,
          score: assessment.score,
          verdict: assessment.verdict,
          strengths: assessment.strengths,
          gaps: assessment.gaps,
          referralLine: assessment.referralLine,
          groundedInJd: assessment.groundedInJd,
          jdSource: jd?.source ?? null,
          contact: watch.contact,
        }),
      );
    } catch {
      // One bad posting (fetch hiccup, model error) must not abandon the sweep.
      continue;
    }
  }

  saveMatches(found);

  // What counts as "accounted for" differs by sweep:
  //
  // First sweep — the whole board becomes the baseline. That's the point of a
  // watch: you want roles opened from now on, not a backlog of 250.
  //
  // Later sweeps — mark everything EXCEPT candidates we ran out of budget for.
  // Marking those would bury genuinely new roles forever; leaving them unmarked
  // brings them back on the next tick.
  const unscored = new Set(candidates.slice(toScore.length).map((p) => p.id));
  const toMark = firstSweep ? postings.map((p) => p.id) : postings.filter((p) => !unscored.has(p.id)).map((p) => p.id);
  markSeen(watch.id, toMark);

  patchWatch(watch.id, {
    lastSweptAt: new Date().toISOString(),
    baselinedAt: watch.baselinedAt ?? new Date().toISOString(),
    lastError: null,
  });
  return { found, calls };
}

/**
 * Sweep every watch that's due. `force` ignores the once-a-day gate — that's
 * what the "Check now" button uses.
 */
export async function sweepAll(
  force = false,
): Promise<{ swept: number; matches: number; remaining: number; disabled?: boolean }> {
  if (sweeping) return { swept: 0, matches: 0, remaining: 0 };

  const settings = readSettings();

  // Master gate: no scoring means no Claude call, from any caller. force=true
  // ("Check now") does NOT override this — the point of the switch is that
  // nothing can spend while it is off.
  if (!settings.scoringEnabled) return { swept: 0, matches: 0, remaining: 0, disabled: true };

  // The timer calls with force=false; the daily check governs only that path.
  if (!force && !settings.autoSweep) return { swept: 0, matches: 0, remaining: 0 };

  sweeping = true;
  try {
    const now = Date.now();
    const due = listWatches().filter((w) => {
      if (force) return true;
      const last = w.lastSweptAt ? Date.parse(w.lastSweptAt) : 0;
      return Number.isNaN(last) || now - last >= DUE_AFTER_MS;
    });

    let budget = MAX_MATCH_CALLS_PER_RUN;
    let matches = 0;
    let swept = 0;
    for (const watch of due) {
      // Checked BEFORE the call, not after. Sweeping on an exhausted budget used
      // to score nothing and still record the company's whole board as seen —
      // permanently hiding roles that were never looked at.
      if (budget <= 0) break;
      try {
        const { found, calls } = await sweepWatch(watch, budget);
        // Spend is counted in model calls, not matches. A posting the model
        // rejects as a skip still costs a call, and the old accounting let those
        // run free — so a "12 call" cap could quietly make many times that.
        budget -= calls;
        matches += found.length;
        swept++;
      } catch (e: any) {
        // Record it against the watch and carry on to the next company.
        patchWatch(watch.id, {
          lastSweptAt: new Date().toISOString(),
          lastError: e?.message ?? "Sweep failed.",
        });
      }
    }

    if (matches > 0) notify(matches);
    // `swept` is what actually got checked, not what was due — the budget can cut
    // the run short, and the remainder is picked up on the next tick.
    return { swept, matches, remaining: Math.max(0, due.length - swept), disabled: false };
  } finally {
    sweeping = false;
  }
}

// Desktop banner, opt-in via WATCH_NOTIFY=1 in .env. The server already runs
// locally so this costs nothing, but it's off by default — a background process
// that pops system notifications unasked is a surprise, not a feature.
function notify(count: number): void {
  if (process.env.WATCH_NOTIFY !== "1" || process.platform !== "darwin") return;
  try {
    const body = `${count} new role${count === 1 ? "" : "s"} worth a look`;
    execFile("osascript", ["-e", `display notification ${JSON.stringify(body)} with title "warmreach"`], () => {});
  } catch {
    /* notification is decoration — never let it break a sweep */
  }
}

// A timer registered at boot keeps calling the function instance it captured
// then. Hot-reloading this file creates a NEW module but does NOT replace that
// closure — so an edit adding a safety check to sweepAll does not apply to the
// already-running timer, while the globalThis guard blocks a corrected timer
// from taking over. That combination kept a disabled sweep running for days.
//
// Two defences: (1) no timer is created at all while the daily check is off, so
// the common case has nothing running; (2) every tick re-checks a generation
// token, so a stale timer from a previous code version retires itself instead of
// running forever.
const WATCHER_GENERATION = "2026-08-10a";

export function startJobWatcher(): void {
  const g = globalThis as unknown as { __warmreachJobWatch?: NodeJS.Timeout; __warmreachJobWatchGen?: string };

  // Retire a timer left over from an older version of this file.
  if (g.__warmreachJobWatch && g.__warmreachJobWatchGen !== WATCHER_GENERATION) {
    clearInterval(g.__warmreachJobWatch);
    g.__warmreachJobWatch = undefined;
  }
  if (g.__warmreachJobWatch) return;

  if (!readSettings().autoSweep) {
    console.log("[jobWatch] daily check is OFF — no timer started, no Claude calls possible.");
    return;
  }

  g.__warmreachJobWatchGen = WATCHER_GENERATION;
  g.__warmreachJobWatch = setInterval(() => {
    const cur = globalThis as unknown as { __warmreachJobWatch?: NodeJS.Timeout; __warmreachJobWatchGen?: string };
    if (cur.__warmreachJobWatchGen !== WATCHER_GENERATION) {
      if (cur.__warmreachJobWatch) clearInterval(cur.__warmreachJobWatch);
      return;
    }
    void sweepAll().catch(() => {});
  }, TICK_MS);
  void sweepAll().catch(() => {});
}
