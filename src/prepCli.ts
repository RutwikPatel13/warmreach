import { readSet, seedProgressFromLeetCode, writeSet } from "./prep";
import { PrepSessionError, buildPrepSet } from "./prepSources";

// Sync a company's question set from the terminal, so you can pull Tesla before
// you open the page rather than waiting on a spinner in the UI.
//
//   npm run prep -- tesla
//   npm run prep -- tesla --premium        also replay your captured session
//   npm run prep -- "goldman sachs" --refresh --no-enrich
//
// Default is mirrors-only, which makes no request to LeetCode whatsoever.

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const company = argv.find((a) => !a.startsWith("--"));

  if (!company) {
    console.error('Usage: npm run prep -- <company> [--premium] [--refresh] [--no-enrich]');
    process.exit(1);
  }

  const mode = flags.has("--premium") ? "premium" : "mirrors";
  console.log(`Syncing "${company}" (${mode})…`);

  try {
    const { set, warnings } = await buildPrepSet({
      company,
      mode,
      refresh: flags.has("--refresh"),
      enrich: !flags.has("--no-enrich"),
    });

    const existing = readSet(set.company);
    if (existing) set.label = existing.label;
    writeSet(set);
    seedProgressFromLeetCode(set);

    const byWindow = new Map<string, number>();
    for (const q of set.questions) {
      for (const w of q.windows) byWindow.set(w, (byWindow.get(w) ?? 0) + 1);
    }

    console.log(`\n✅ ${set.questions.length} questions → data/prep/${set.company}.json`);
    for (const w of ["thirty-days", "three-months", "six-months", "more-than-six-months", "all"]) {
      // Say "none" out loud rather than omitting the row — an empty recent
      // window is a real answer for most companies, not a failed fetch.
      console.log(`   ${w.padEnd(21)} ${byWindow.get(w) ?? "none"}`);
    }
    console.log(`   sources: ${set.sources.map((s) => `${s.repo} (${s.snapshot})`).join(", ")}`);
    for (const w of warnings) console.log(`   ⚠ ${w}`);
    console.log(`\nYour saved solutions were not touched — they live in data/prep_progress.json.`);
  } catch (e) {
    if (e instanceof PrepSessionError) {
      console.error(`\n✗ ${e.message}`);
      process.exit(2);
    }
    console.error(`\n✗ ${(e as Error).message}`);
    process.exit(1);
  }
}

void main();
