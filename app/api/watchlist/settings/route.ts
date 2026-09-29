import { NextResponse } from "next/server";
import { readSettings, writeSettings } from "@/src/watchlist";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The daily-check switch. Off means the background timer does nothing at all —
// no Apollo call, no model call. "Check now" still works either way, so turning
// this off makes the feature manual rather than disabling it.
export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  return NextResponse.json({ settings: readSettings() });
}

export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const { autoSweep } = (await req.json()) as { autoSweep?: boolean };
    if (typeof autoSweep !== "boolean") {
      return NextResponse.json({ error: "autoSweep must be true or false." }, { status: 400 });
    }
    return NextResponse.json({ settings: writeSettings({ autoSweep }) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not save the setting." }, { status: 500 });
  }
}
