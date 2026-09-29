import { NextResponse } from "next/server";
import { rejectNonLocal } from "@/src/localGuard";
import { companySlug, readSet, seedProgressFromLeetCode, writeSet } from "@/src/prep";
import { PrepSessionError, buildPrepSet, refreshSetMeta, type SyncMode } from "@/src/prepSources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rebuild a company's question set.
//
//   mode "mirrors" — public GitHub CSVs only. Makes no request to LeetCode.
//   mode "premium" — additionally replays your captured Premium request, which
//                    is the only way to get current company tags.
//
// Writing the set never touches data/prep_progress.json, so a re-sync cannot
// lose a solution you've written. That's enforced by the store, not by care
// here: writeSet() has no access to the progress file.

export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const body = (await req.json()) as {
      company?: string;
      label?: string;
      mode?: SyncMode;
      refresh?: boolean;
      enrich?: boolean;
    };

    const company = companySlug(body.company ?? "");
    if (!company) return NextResponse.json({ error: "A company is required." }, { status: 400 });

    const mode: SyncMode = body.mode === "premium" ? "premium" : "mirrors";

    // A study plan has no mirror and no company tag to rebuild from — its
    // membership is fixed by LeetCode's curriculum. Refresh the metadata in
    // place instead of trying (and failing) to find it in a CSV.
    const existingSet = readSet(company);
    if (existingSet?.kind === "studyplan") {
      const refreshed = await refreshSetMeta(existingSet, !!body.refresh);
      writeSet(refreshed.set);
      return NextResponse.json({ set: refreshed.set, warnings: refreshed.warnings, windows: [] });
    }

    const { set, warnings } = await buildPrepSet({
      company,
      label: body.label,
      mode,
      refresh: !!body.refresh,
      enrich: body.enrich !== false,
    });

    // Keep the label already on file if the caller didn't send a better one —
    // re-syncing "linkedin" shouldn't rename it from "LinkedIn" to "linkedin".
    if (existingSet && !body.label) set.label = existingSet.label;

    writeSet(set);
    seedProgressFromLeetCode(set);

    const windows = [...new Set(set.questions.flatMap((q) => q.windows))];
    return NextResponse.json({ set, warnings, windows });
  } catch (e: any) {
    // An expired or missing capture is the common case and has a specific fix,
    // so it gets its own status rather than being flattened into a generic 500.
    if (e instanceof PrepSessionError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    return NextResponse.json({ error: e?.message ?? "Could not sync that company." }, { status: 500 });
  }
}
