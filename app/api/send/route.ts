import { NextResponse } from "next/server";
import { getGmailAuth, hasGmailToken, sendDraft } from "@/src/gmail";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sends already-created Gmail drafts (by draft id). The app can send; the user
// can equally send them from Gmail instead.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const { draftIds } = (await req.json().catch(() => ({}))) as { draftIds?: string[] };

  if (!Array.isArray(draftIds) || draftIds.length === 0) {
    return NextResponse.json({ error: "draftIds is required." }, { status: 400 });
  }
  if (!hasGmailToken()) {
    return NextResponse.json(
      { error: "Gmail isn't authorized yet. Run `npm run gmail:auth` once, then retry." },
      { status: 400 },
    );
  }

  const auth = await getGmailAuth();
  const results = await Promise.all(
    draftIds.map(async (id) => {
      try {
        const messageId = await sendDraft(auth, id);
        return { draftId: id, ok: true, messageId };
      } catch (e: any) {
        return { draftId: id, ok: false, error: e?.message ?? "Send failed." };
      }
    }),
  );

  return NextResponse.json({ results });
}
