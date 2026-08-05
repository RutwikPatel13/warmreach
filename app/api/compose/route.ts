import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import {
  getGmailAuth,
  getFromAddress,
  hasGmailToken,
  createDraft,
  updateDraft,
  deleteDraft,
} from "@/src/gmail";
import { profile } from "@/src/profile";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The one-off compose dock: a hand-written email to a single address (someone
// revealed on /people, or any address pasted in). Deliberately separate from
// /api/draft — there's no AI here, so this route spends NO Apollo credits and
// never touches the personalization pipeline.
//
// The Gmail draft is the source of truth: POST creates it on first save and
// updates it in place after that, so an unsent compose survives a refresh and
// can equally be finished from Gmail. Sending and scheduling reuse the existing
// /api/send and /api/schedule routes with the returned draftId.

interface ComposeBody {
  draftId?: string; // present after the first save — update instead of create
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  resumePath?: string; // absolute path from the resume picker; "" = no attachment
}

function gmailNotReady() {
  return NextResponse.json(
    { error: "Gmail isn't authorized yet. Run `npm run gmail:auth` once, then retry." },
    { status: 400 },
  );
}

export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as ComposeBody;
  const to = (body.to ?? "").trim();

  if (!to) return NextResponse.json({ error: "A recipient is required." }, { status: 400 });
  if (!hasGmailToken()) return gmailNotReady();

  // Only attach when the picker actually chose a PDF. An empty string means the
  // user removed the attachment chip, so we must NOT fall back to the default.
  const resumePath =
    body.resumePath === undefined
      ? profile.resumePath
      : body.resumePath.toLowerCase().endsWith(".pdf")
        ? body.resumePath
        : "";
  const resumeAttached = Boolean(resumePath) && existsSync(resumePath);

  const auth = await getGmailAuth();
  const from = await getFromAddress(auth);
  const args = {
    to,
    cc: (body.cc ?? "").trim() || undefined,
    bcc: (body.bcc ?? "").trim() || undefined,
    subject: body.subject ?? "",
    body: body.body ?? "",
    attachmentPath: resumeAttached ? resumePath : undefined,
  };

  try {
    let draftId: string;
    if (body.draftId) {
      try {
        draftId = await updateDraft(auth, body.draftId, args, from);
      } catch {
        // The draft was deleted in Gmail behind our back — start a fresh one
        // rather than losing what's in the composer.
        draftId = await createDraft(auth, args, from);
      }
    } else {
      draftId = await createDraft(auth, args, from);
    }
    return NextResponse.json({ draftId, resumeAttached });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not save the draft." }, { status: 500 });
  }
}

// Discard: removes the Gmail draft this composer created.
export async function DELETE(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const { draftId } = (await req.json().catch(() => ({}))) as { draftId?: string };
  if (!draftId) return NextResponse.json({ error: "draftId is required." }, { status: 400 });
  if (!hasGmailToken()) return gmailNotReady();

  try {
    const auth = await getGmailAuth();
    await deleteDraft(auth, draftId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not discard the draft." }, { status: 500 });
  }
}
