import { NextResponse } from "next/server";
import { getIndex } from "@/src/contactDb";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every contact warmreach holds, from every source, for the Database page.
// Read-only over the derived index — no Apollo call, no credit. The client does
// its own search/sort/filter over these rows.
export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  const idx = getIndex();
  return NextResponse.json({
    people: idx.people,
    counts: idx.counts,
    bySource: idx.bySource,
  });
}
