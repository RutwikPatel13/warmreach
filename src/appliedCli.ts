import fs from "node:fs";
import {
  creditsFor,
  importApplications,
  importDetails,
  importInbox,
  isDay,
  listApplications,
  prepareMany,
  readMeta,
  resumesWanted,
  tsentaOutbox,
  updateApplication,
  writeMeta,
  type Application,
  type TsentaRow,
} from "./applied";
import { fetchJobText } from "./jobText";

// The Tsenta bridge's command line. warmreach can't reach Tsenta itself, so a
// Claude session with the Tsenta connector pulls pages of rows, saves each to a
// JSON file, and runs:
//
//   npm run applied -- status                  last sync, a pending "Sync Tsenta" request, what's owed
//   npm run applied -- import <file.json>…     list-applications / list-tracked-applications pages
//                                              (every tab, not just submitted). Prints "unchanged":
//                                              when a whole page is unchanged, stop paging.
//   npm run applied -- total <n>               Tsenta's own count, for the board's header
//   npm run applied -- inbox <file.json>       list-inbox-messages rows
//   npm run applied -- details <file.json>     get-job-details results
//   npm run applied -- resumes [--since D]     résumés to fetch: started rows waiting on one, then
//                                              submitted rows since D (saved as the default) (JSON)
//   npm run applied -- outbox                  notes to write to Tsenta's tracker (JSON)
//   npm run applied -- noted <id…>             mark those notes written
//   npm run applied -- jd [--limit N]          read postings for rows without one (free, local fetch)
//   npm run applied -- prepare <id…>|--new     find + pick people (free: no credits, no Claude)
//   npm run applied -- list                    what's here
//
// Nothing is started by an import: rows wait on the Applied board until you
// Start them there. Writes the same store the web app reads, so it works with
// the server off.

function report(a: Application) {
  const { picked, credits } = creditsFor(a);
  const who = `${a.org?.name ?? a.company} · ${a.role ?? "?"}`;
  console.log(a.status === "review" ? `ready   ${who} — ${picked} people, ${credits} credits to draft` : `${a.status.padEnd(7)} ${who} — ${a.error ?? ""}`);
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

// A saved tool result may be the rows, { applications }, { result: { applications } } or { messages }.
function rowsOf(parsed: any, keys: string[]): any[] {
  if (Array.isArray(parsed)) return parsed;
  for (const k of keys) {
    if (Array.isArray(parsed?.[k])) return parsed[k];
    if (Array.isArray(parsed?.result?.[k])) return parsed.result[k];
  }
  if (parsed?.result && !Array.isArray(parsed.result) && typeof parsed.result === "object") return [parsed.result];
  return [];
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "status") {
    const m = readMeta();
    const apps = listApplications();
    console.log(JSON.stringify({
      lastSyncAt: m.lastSyncAt,
      syncRequestedAt: m.syncRequestedAt,
      resumeSince: m.resumeSince,
      tsentaTotal: m.tsentaTotal,
      applications: apps.length,
      resumesWanted: resumesWanted().length,
      notesToWrite: tsentaOutbox().length,
      withoutPosting: apps.filter((a) => !a.jd).length,
    }, null, 1));
    return;
  }

  if (cmd === "import") {
    if (!args.length) throw new Error("usage: applied import <file.json>…");
    let unchangedPages = 0;
    for (const file of args) {
      const rows = rowsOf(readJson(file), ["applications"]) as TsentaRow[];
      const r = await importApplications(rows);
      if (rows.length && r.unchanged === rows.length) unchangedPages++;
      console.log(`${file}: ${r.added} new, ${r.updated} updated, ${r.unchanged} unchanged, ${r.skipped} skipped. Résumés saved: ${r.resumes}.`);
      for (const e of r.resumeErrors) console.log(`  résumé not saved — ${e}`);
    }
    writeMeta({ syncRequestedAt: null });
    if (unchangedPages) console.log(`${unchangedPages} page(s) had nothing new: older pages can be skipped.`);
    return;
  }

  if (cmd === "total") {
    const n = Number(args[0]);
    if (!Number.isFinite(n)) throw new Error("usage: applied total <n>");
    writeMeta({ tsentaTotal: n });
    return;
  }

  if (cmd === "inbox") {
    if (!args[0]) throw new Error("usage: applied inbox <file.json>");
    const r = importInbox(rowsOf(readJson(args[0]), ["messages", "items", "inbox"]));
    console.log(`Inbox: ${r.matched} matched, ${r.unmatched} unmatched.`);
    return;
  }

  if (cmd === "details") {
    if (!args[0]) throw new Error("usage: applied details <file.json>");
    const r = importDetails(rowsOf(readJson(args[0]), ["details", "jobs"]));
    console.log(`Job details: ${r.matched} matched, ${r.unmatched} unmatched.`);
    return;
  }

  if (cmd === "resumes") {
    const i = args.indexOf("--since");
    if (i >= 0) {
      if (!isDay(args[i + 1])) throw new Error("usage: applied resumes [--since YYYY-MM-DD]");
      writeMeta({ resumeSince: args[i + 1] });
    }
    console.log(JSON.stringify(resumesWanted(), null, 1));
    return;
  }

  if (cmd === "outbox") {
    console.log(JSON.stringify(tsentaOutbox(), null, 1));
    return;
  }

  if (cmd === "noted") {
    if (!args.length) throw new Error("usage: applied noted <applicationId…>");
    const at = new Date().toISOString();
    for (const id of args) updateApplication(id, (a) => { a.notedAt = at; });
    console.log(`Marked ${args.length} note(s) written.`);
    return;
  }

  if (cmd === "jd") {
    const i = args.indexOf("--limit");
    const limit = i >= 0 ? Number(args[i + 1]) || 50 : 50;
    const todo = listApplications().filter((a) => !a.jd && a.url && (a.bucket ?? "submitted") === "submitted").slice(0, limit);
    let got = 0;
    const queue = [...todo];
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        const f = await fetchJobText(a.url).catch(() => null);
        if (!f) continue;
        got++;
        updateApplication(a.id, (x) => { x.jd = f.text; x.jdSource = f.source; x.role = x.role || f.title || null; });
      }
    }));
    console.log(`Postings read: ${got} of ${todo.length}. The rest need Tsenta's fetch-job-description.`);
    return;
  }

  if (cmd === "prepare") {
    const ids = args.includes("--new")
      ? listApplications().filter((a) => a.status === "new" && (a.bucket ?? "submitted") === "submitted").map((a) => a.id)
      : args;
    if (!ids.length) throw new Error("usage: applied prepare <id…> | --new");
    await prepareMany(ids, report);
    return;
  }

  if (cmd === "list" || !cmd) {
    for (const a of listApplications()) {
      const { picked, credits } = creditsFor(a);
      console.log(`${a.status.padEnd(9)} ${a.id}  ${(a.org?.name ?? a.company).padEnd(28)} ${a.role ?? ""}${a.status === "review" ? `  (${picked} people, ${credits} cr)` : ""}`);
    }
    return;
  }

  throw new Error(`unknown command "${cmd}" — see the list at the top of src/appliedCli.ts`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
