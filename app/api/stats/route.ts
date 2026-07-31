import { NextResponse } from "next/server";
import { outreachStats } from "@/src/tracker";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lifetime outreach totals from data/outreach_log.csv — the Applications page
// shows these before any search this session. Read-only, no Apollo/Gmail cost.
export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  return NextResponse.json(outreachStats());
}
