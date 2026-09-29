import { NextResponse } from "next/server";
import { creditsFor, draftCounts, listApplications } from "@/src/applied";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Applied list. "opened" and "drafted" aren't stored: drafting happens on
// the Applications page, so they're derived from openedAt and the outreach log.
export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const drafts = draftCounts();
  const rows = listApplications().map((a) => {
    const { picked, credits } = creditsFor(a);
    const n = drafts(a);
    return {
      id: a.id,
      company: a.org?.name ?? a.company,
      role: a.role,
      appliedAt: a.appliedAt,
      status: n > 0 ? "drafted" : a.openedAt || a.status === "drafted" ? "opened" : a.status,
      error: a.error,
      needs: a.status === "stuck" && !a.org ? "website" : null,
      picked,
      credits,
      drafts: n,
    };
  });
  return NextResponse.json({ rows });
}
