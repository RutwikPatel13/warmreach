import fs from "node:fs";
import { creditsFor, importApplications, listApplications, prepareMany, type Application, type TsentaRow } from "./applied";

// The Tsenta bridge's command line. A Claude session with the Tsenta connector
// saves what it pulled to a JSON file and runs:
//
//   npm run applied -- import <file.json>   add new applications, then prepare them
//                                           (--no-prepare to skip)
//   npm run applied -- prepare <id…>|--new  find + pick people (free: no credits, no Claude)
//   npm run applied -- list                 what's in the queue
//
// Prepared applications show up in the Applications page as workspaces, at
// step 2, the next time it loads.
//
// Writes the same store the web app reads, so it works with the server off.
// Drafting is deliberately NOT here: spending credits happens on the page.

function report(a: Application) {
  const { picked, credits } = creditsFor(a);
  const who = `${a.org?.name ?? a.company} · ${a.role ?? "?"}`;
  console.log(a.status === "review" ? `ready   ${who} — ${picked} people, ${credits} credits to draft` : `${a.status.padEnd(7)} ${who} — ${a.error ?? ""}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "import") {
    const file = args[0];
    if (!file) throw new Error("usage: applied import <file.json>");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { applications?: TsentaRow[] } | TsentaRow[];
    const rows = Array.isArray(parsed) ? parsed : parsed.applications ?? [];
    const r = await importApplications(rows);
    console.log(`Imported: ${r.added} new, ${r.updated} updated, ${r.skipped} skipped (not submitted). Résumés saved: ${r.resumes}.`);
    for (const e of r.resumeErrors) console.log(`  résumé not saved — ${e}`);
    if (r.addedIds.length && !args.includes("--no-prepare")) {
      console.log(`Preparing ${r.addedIds.length} new…`);
      await prepareMany(r.addedIds, report);
    }
    return;
  }

  if (cmd === "prepare") {
    const ids = args.includes("--new")
      ? listApplications().filter((a) => a.status === "new").map((a) => a.id)
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

  throw new Error(`unknown command "${cmd}" — use import, prepare or list`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
