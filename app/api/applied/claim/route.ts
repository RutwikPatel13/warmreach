import { NextResponse } from "next/server";
import { claimPending } from "@/src/applied";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Called by the Applications page on load: every prepared application it hasn't
// taken yet, as ready-made workspaces (stopped at step 2). Claiming marks them
// opened in the same step, so they're handed out exactly once. Free.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  try {
    return NextResponse.json({ items: claimPending() });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Couldn’t load applications." }, { status: 500 });
  }
}
