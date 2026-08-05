import { NextResponse } from "next/server";
import { sweepAll } from "@/src/jobWatch";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Check now" — runs the same sweep the background timer runs, ignoring the
// once-a-day gate. Apollo's side is free; the model calls it may trigger are
// bounded by the per-run cap in jobWatch.ts.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const result = await sweepAll(true);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Sweep failed." }, { status: 500 });
  }
}
