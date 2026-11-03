import { NextResponse } from "next/server";
import { cancelWaiting, kick, queueView, setPaused } from "@/src/appliedRun";
import { reviewCount } from "@/src/applied";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Start queue: progress for the board, plus pause / resume / cancel.
export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  kick();
  // `review` feeds the sidebar's Review queue badge.
  return NextResponse.json({ ...queueView(), review: reviewCount() });
}

export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  if (action === "pause") setPaused(true);
  else if (action === "resume") setPaused(false);
  else if (action === "cancel") cancelWaiting();
  else return NextResponse.json({ error: "action must be pause, resume or cancel." }, { status: 400 });
  return NextResponse.json(queueView());
}
