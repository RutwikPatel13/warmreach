import { NextResponse } from "next/server";
import { outreachRows } from "@/src/tracker";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The full outreach history (data/outreach_log.csv) as structured rows for the
// Database page. Read-only — no Apollo/Gmail cost. The client computes stats,
// aggregates, search, and sorting from these rows.
export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  return NextResponse.json({ rows: outreachRows() });
}
