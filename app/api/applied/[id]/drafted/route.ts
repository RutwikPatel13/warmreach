import { NextResponse } from "next/server";
import { getApplication, recordDrafts, recordSent, type BoardDraft } from "@/src/applied";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// The review queue reports back here after /api/draft and /api/send, so the
// board knows what's drafted and sent, and the spend log has the credits.
export async function POST(req: Request, { params }: Ctx) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  const { id } = await params;
  if (!getApplication(id)) return NextResponse.json({ error: "No application with that id." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as {
    drafts?: Omit<BoardDraft, "at" | "sentAt">[];
    credits?: number;
    sent?: string[];
  };
  if (body.drafts?.length) recordDrafts(id, body.drafts, Math.max(0, Number(body.credits) || 0));
  if (body.sent?.length) recordSent(id, body.sent);
  return NextResponse.json({ ok: true });
}
