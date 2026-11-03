import { NextResponse } from "next/server";
import { searchPostings } from "@/src/applied";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ids whose posting text contains every word of ?q. The board searches its own
// fields itself; posting text stays on the server so the board stays light.
export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return NextResponse.json({ ids: searchPostings(q) });
}
