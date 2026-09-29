import { NextResponse } from "next/server";
import { rejectNonLocal } from "@/src/localGuard";
import {
  companySlug,
  listPrepCompanies,
  readProgress,
  readSet,
  saveProgress,
  seedProgressFromLeetCode,
  writeSet,
  type Status,
} from "@/src/prep";
import { SEEDS } from "@/src/prepSeed";
import { listWatches } from "@/src/watchlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The prep store. Local disk only — no LeetCode request, no Apollo call, no
// credits. Syncing a question set is a separate route (./sync) precisely so
// that reading the page can never trigger a network fetch.

const STATUSES = new Set<Status>(["todo", "doing", "done"]);

export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const company = companySlug(new URL(req.url).searchParams.get("company") ?? "linkedin");

  // First visit for a company we ship a transcribed set for: materialise it so
  // the page is useful before any sync has run.
  let set = readSet(company);
  if (!set && SEEDS[company]) {
    set = SEEDS[company];
    writeSet(set);
    seedProgressFromLeetCode(set);
  }

  // Companies you're already chasing are the ones you'll prep for, so offer the
  // watchlist as suggestions rather than making you type them again.
  const known = new Set(listPrepCompanies().map((c) => c.company));
  const suggestions = listWatches()
    .map((w) => ({ company: companySlug(w.name), label: w.name }))
    .filter((s) => s.company && !known.has(s.company))
    .filter((s, i, a) => a.findIndex((x) => x.company === s.company) === i);

  // Everything the page needs in one request, so it never renders half-built.
  return NextResponse.json({
    set,
    progress: set ? readProgress(company) : {},
    companies: listPrepCompanies(),
    suggestions,
  });
}

export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const body = (await req.json()) as {
      company?: string;
      id?: number;
      st?: Status;
      code?: string;
      lang?: string;
      notes?: string;
    };

    const company = companySlug(body.company ?? "");
    if (!company) return NextResponse.json({ error: "A company is required." }, { status: 400 });
    if (typeof body.id !== "number" || !Number.isFinite(body.id)) {
      return NextResponse.json({ error: "A question id is required." }, { status: 400 });
    }
    if (body.st !== undefined && !STATUSES.has(body.st)) {
      return NextResponse.json({ error: `Unknown status "${body.st}".` }, { status: 400 });
    }

    // Only the keys actually present are written, so saving a solution can't
    // blank out notes and changing status can't blank out code.
    const patch: Record<string, unknown> = {};
    if (body.st !== undefined) patch.st = body.st;
    if (body.code !== undefined) patch.code = body.code;
    if (body.lang !== undefined) patch.lang = body.lang;
    if (body.notes !== undefined) patch.notes = body.notes;
    // `at` is stamped by the store, not here — see saveProgress.

    return NextResponse.json({ progress: saveProgress(company, body.id, patch) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not save your progress." }, { status: 500 });
  }
}
