import { NextResponse } from "next/server";
import { targetRows } from "@/src/harvest";
import { getIndex } from "@/src/contactDb";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The ranked target table plus whatever scans already exist. Read-only: no
// Apollo call, no credit — this is just the store and the cached scan files.
export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  const idx = getIndex();
  return NextResponse.json({
    rows: targetRows(),
    store: { ...idx.counts, bySource: idx.bySource },
  });
}
