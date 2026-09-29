import { NextResponse } from "next/server";
import { importApplications, prepareMany, type TsentaRow } from "@/src/applied";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Where the Tsenta bridge lands. Accepts { applications: [...] } or a bare array
// of rows from Tsenta's list-applications / list-tracked-applications. New
// applications are then prepared in the background — free, no Claude — and the
// Applications page picks them up as workspaces on its next load.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => null)) as { applications?: TsentaRow[] } | TsentaRow[] | null;
  const rows = Array.isArray(body) ? body : body?.applications;
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "Send { applications: [...] } from Tsenta." }, { status: 400 });
  }
  try {
    const result = await importApplications(rows);
    void prepareMany(result.addedIds); // not awaited: the import answers now
    return NextResponse.json({ ...result, preparing: result.addedIds.length });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Import failed." }, { status: 500 });
  }
}
