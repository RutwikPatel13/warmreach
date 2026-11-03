import { NextResponse } from "next/server";
import { readMeta, writeMeta } from "@/src/applied";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// warmreach can't reach Tsenta on its own: a Claude session with Tsenta's
// connector does the pull. This records that you asked; the session sees it
// (npm run applied -- status) and clears it when it imports.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  return NextResponse.json({ meta: writeMeta({ syncRequestedAt: new Date().toISOString() }) });
}

export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  return NextResponse.json({ meta: readMeta() });
}
