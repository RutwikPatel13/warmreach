import { NextResponse } from "next/server";
import { importApplications, importDetails, importInbox, writeMeta, type DetailsRow, type InboxRow, type TsentaRow } from "@/src/applied";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Where the Tsenta bridge lands. Accepts a bare array of rows, or any of
// { applications, tracked, inbox, details, total } from Tsenta's
// list-applications, list-tracked-applications, list-inbox-messages and
// get-job-details. Nothing is prepared here: rows wait on the board until you
// Start them.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => null)) as
    | TsentaRow[]
    | { applications?: TsentaRow[]; tracked?: TsentaRow[]; inbox?: InboxRow[]; details?: DetailsRow[]; total?: number }
    | null;
  if (!body) return NextResponse.json({ error: "Send rows from Tsenta as JSON." }, { status: 400 });
  const b = Array.isArray(body) ? { applications: body } : body;
  try {
    const rows = [...(b.applications ?? []), ...(b.tracked ?? [])];
    const applications = rows.length ? await importApplications(rows) : null;
    const inbox = b.inbox?.length ? importInbox(b.inbox) : null;
    const details = b.details?.length ? importDetails(b.details) : null;
    if (typeof b.total === "number") writeMeta({ tsentaTotal: b.total });
    if (applications) writeMeta({ syncRequestedAt: null });
    return NextResponse.json({ applications, inbox, details });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Import failed." }, { status: 500 });
  }
}
