import { NextResponse } from "next/server";
import { rejectNonLocal } from "@/src/localGuard";
import { getGmailAuth, hasGmailToken } from "@/src/gmail";
import { outreachRows, normCompany } from "@/src/tracker";
import { generateFollowupDraft, findThreadForPerson, followupsFor, type FollowupTone } from "@/src/followups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  email?: string;
  company?: string;
  role?: string;
  tone?: FollowupTone;
}

const TONES: FollowupTone[] = ["gentle", "direct", "add_value"];

// `email` anchors the draft to one person's original outreach (subject, role,
// timestamp) — the composed subject+body is a company-level TEMPLATE, with no
// recipient name in it, so the same text can be reused for every quiet person
// at that company (the caller prepends "Hi <firstName>," per recipient at
// send time, same as the Applications/Campaigns flows). The returned Gmail
// thread info is the anchor person's own thread; /api/followups/schedule
// resolves each OTHER recipient's thread independently since they each have
// their own conversation. Editable + regenerate on the client just calls
// this again.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as Body;
  const email = body.email?.trim();
  const company = body.company?.trim();
  const tone: FollowupTone = TONES.includes(body.tone as FollowupTone) ? (body.tone as FollowupTone) : "gentle";

  if (!email || !company) {
    return NextResponse.json({ error: "email and company are required." }, { status: 400 });
  }

  const companyKey = normCompany(company);
  const rows = outreachRows().filter(
    (r) => r.role !== "campaign" && r.email.toLowerCase() === email.toLowerCase() && normCompany(r.company) === companyKey,
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: "No prior outreach found for that email at that company." }, { status: 404 });
  }
  const latest = rows[0]; // outreachRows() is newest-first
  const nudgeNumber = Math.min(3, followupsFor(email, companyKey).length + 1) as 1 | 2 | 3;

  try {
    const { subject, body: text } = await generateFollowupDraft(
      {
        company: latest.company,
        role: body.role?.trim() || latest.role,
        originalSubject: latest.subject,
      },
      tone,
    );

    // Best-effort threading — a draft without it just starts a fresh thread.
    let thread: { threadId: string; lastMessageId: string; references: string } | null = null;
    if (hasGmailToken()) {
      try {
        const auth = await getGmailAuth();
        thread = await findThreadForPerson(auth, email, latest.timestamp);
      } catch {
        thread = null;
      }
    }

    return NextResponse.json({
      subject,
      body: text,
      nudgeNumber,
      threadId: thread?.threadId ?? null,
      inReplyTo: thread?.lastMessageId ?? null,
      references: thread?.references ?? null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Draft generation failed." }, { status: 500 });
  }
}
