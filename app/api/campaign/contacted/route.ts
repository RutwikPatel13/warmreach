import { NextResponse } from "next/server";
import { contactedCompanies } from "@/src/tracker";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Companies already reached out to (from data/outreach_log.csv) — normalized
// names + email domains. The Campaigns picker uses this to flag companies done
// in earlier batches. Re-fetched after each draft run so it stays current.
export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  return NextResponse.json(contactedCompanies());
}
