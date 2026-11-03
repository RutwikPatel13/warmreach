import { NextResponse } from "next/server";
import { boardRows, readMeta } from "@/src/applied";
import { kick, queueView, queuedIds, writerLabel } from "@/src/appliedRun";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Applied board: every application as a light row (no posting text, no
// people), plus sync status and the Start queue. Loading it also restarts the
// queue's workers after a server restart. Free: reads local files only.
export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  try {
    kick();
    return NextResponse.json({ rows: boardRows(queuedIds()), meta: readMeta(), queue: queueView(), writer: writerLabel() });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Couldn’t load the board." }, { status: 500 });
  }
}
