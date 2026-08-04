import { NextResponse } from "next/server";
import { rejectNonLocal } from "@/src/localGuard";
import { setDismissed } from "@/src/followups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dismiss ("don't follow up here") or un-dismiss a company by its companyKey.
// Persisted, so it stays out of the queue on future scans + the cached result.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const { companyKey, dismissed } = (await req.json().catch(() => ({}))) as {
    companyKey?: string;
    dismissed?: boolean;
  };
  if (!companyKey) return NextResponse.json({ error: "companyKey is required." }, { status: 400 });

  setDismissed(companyKey, dismissed !== false); // default: dismiss
  return NextResponse.json({ ok: true });
}
