import { NextResponse } from "next/server";
import { getApplication, outreachNote, updateApplication } from "@/src/applied";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// "Add note to Tsenta": queues a note for this job's row in Tsenta's tracker.
// warmreach can't write to Tsenta itself, so the next Claude session with the
// Tsenta connector writes it (npm run applied -- outbox) and marks it done.
export async function POST(req: Request, { params }: Ctx) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  const { id } = await params;
  if (!getApplication(id)) return NextResponse.json({ error: "No application with that id." }, { status: 404 });
  const app = updateApplication(id, (a) => { a.noteQueuedAt = new Date().toISOString(); a.notedAt = null; });
  return NextResponse.json({ note: outreachNote(app), queuedAt: app.noteQueuedAt });
}
