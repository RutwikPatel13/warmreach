import { NextResponse } from "next/server";
import { listMatches, setMatchStatus, type MatchStatus } from "@/src/watchlist";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES: MatchStatus[] = ["new", "asked", "dismissed"];

// Scored roles waiting on you. Newest and strongest first — a 40 found this
// morning shouldn't sit above an 85 found this morning.
export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const matches = listMatches().sort((a, b) => {
    const day = (m: typeof a) => (m.foundAt ?? "").slice(0, 10);
    return day(b).localeCompare(day(a)) || b.score - a.score;
  });
  return NextResponse.json({ matches });
}

export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const { id, status } = (await req.json()) as { id?: string; status?: MatchStatus };
    if (!id || !status || !STATUSES.includes(status)) {
      return NextResponse.json({ error: "A match id and a valid status are required." }, { status: 400 });
    }
    setMatchStatus(id, status);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not update the match." }, { status: 500 });
  }
}
