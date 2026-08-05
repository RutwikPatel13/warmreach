import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { enrichPerson } from "@/src/apollo";
import type { Variant, Email } from "@/src/personalize";
import { getGmailAuth, getFromAddress, hasGmailToken, createDraft, updateDraft } from "@/src/gmail";
import { hunterConfigured, findEmail } from "@/src/hunter";
import { logOutreach, lastDraftIdFor } from "@/src/tracker";
import { profile } from "@/src/profile";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CAP = 500; // safety bound only — no longer a user-facing limit

interface Person {
  id: string;
  firstName: string;
  lastName?: string | null;
  title?: string;
  variant: Variant;
  source?: "apollo" | "hunter" | "careers";
  email?: string | null;
  confidence?: number | null;
  // Set when this run REPLACES an earlier draft for the same person (a re-draft):
  // the old Gmail draft is deleted and the already-contacted guard is bypassed.
  replaceDraftId?: string | null;
}

interface DraftRequest {
  company?: { name?: string; domain?: string | null };
  role?: string;
  people?: Person[];
  templates?: Record<Variant, Email>;
  resumePath?: string;
}

interface ResultLine {
  id: string;
  name?: string;
  title?: string;
  email?: string | null;
  status: "drafted" | "skipped" | "error";
  reason?: string;
  subject?: string;
  bodyPreview?: string;
  draftId?: string;
  emailSource?: "apollo" | "hunter" | "careers";
  emailScore?: number;
  resumeAttached?: boolean;
  creditSpent?: boolean; // true when this row hit Apollo enrichment (1 credit) — client decrements the meter
}

export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as DraftRequest;
  const role = body.role?.trim();
  const company = body.company;
  const templates = body.templates;
  const people = (body.people ?? []).slice(0, MAX_CAP);

  if (!company?.name || !role) {
    return NextResponse.json({ error: "company and role are required." }, { status: 400 });
  }
  if (!templates?.recruiter?.body || !templates?.engineering?.body) {
    return NextResponse.json({ error: "Both email templates are required. Generate them first." }, { status: 400 });
  }
  if (people.length === 0) {
    return NextResponse.json({ error: "Select at least one person." }, { status: 400 });
  }
  if (!hasGmailToken()) {
    return NextResponse.json(
      { error: "Gmail isn't authorized yet. Run `npm run gmail:auth` once in the terminal, then retry." },
      { status: 400 },
    );
  }

  // Resolve auth + the From address once per batch. A stored token can still be
  // expired/revoked (Google's `invalid_grant`), which hasGmailToken() can't detect
  // since it only checks the file exists — surface a clear re-auth prompt instead
  // of a raw 500.
  let auth: any;
  let from: string;
  try {
    auth = await getGmailAuth();
    from = await getFromAddress(auth); // once per batch, not per draft
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    if (msg.includes("invalid_grant")) {
      return NextResponse.json(
        {
          error:
            "Gmail authorization expired. Re-run `npm run gmail:auth` in the terminal to refresh the token, then retry.",
        },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: `Gmail auth failed: ${msg || "unknown error"}` }, { status: 400 });
  }
  const domain = company.domain ?? undefined;
  // Use the per-tab chosen resume, falling back to the profile default. Only PDFs.
  const resumePath =
    body.resumePath && body.resumePath.toLowerCase().endsWith(".pdf")
      ? body.resumePath
      : profile.resumePath;
  const resumeAttached = existsSync(resumePath); // surfaced per row if false
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: ResultLine) =>
        controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));

      for (const person of people) {
        let creditSpent = false; // set once Apollo enrichment actually runs for this person
        try {
          const firstName = person.firstName;
          let fullName: string;
          let title: string;
          let email: string | null;
          let emailSource: "apollo" | "hunter" | "careers" = "apollo";
          let emailScore: number | undefined;
          let emailStatus = "";

          if ((person.source === "hunter" || person.source === "careers") && person.email) {
            // Email already known — Hunter domain search, or a generic careers inbox.
            // Either way no Apollo enrichment, so no credit spent.
            email = person.email;
            const last = person.lastName ?? "";
            fullName = `${firstName}${last ? " " + last : ""}`.trim() || person.email;
            title = person.title ?? "";
            if (person.source === "careers") {
              emailSource = "careers";
              emailStatus = "careers";
            } else {
              emailSource = "hunter";
              emailScore = person.confidence ?? undefined;
              emailStatus = `hunter:${person.confidence ?? ""}`;
            }
          } else {
            // Apollo person — enrich (1 credit); Hunter Email Finder fallback if no email.
            const contact = await enrichPerson(person.id, domain);
            creditSpent = true; // Apollo charged for the match — reflect it in the meter
            fullName = contact.fullName;
            title = contact.title;
            email = contact.email;
            emailStatus = contact.emailStatus ?? "";
            if (!email && hunterConfigured() && domain) {
              const found = await findEmail(domain, firstName || contact.firstName, contact.lastName);
              if (found) {
                email = found.email;
                emailSource = "hunter";
                emailScore = found.score;
                emailStatus = `hunter:${found.score}`;
              }
            }
          }

          if (!email) {
            send({ id: person.id, name: fullName, title, status: "skipped", reason: "no email (Apollo or Hunter)", creditSpent });
            continue;
          }

          const template = templates[person.variant] ?? templates.recruiter;
          // Careers inboxes are a team queue, not a person — address the company.
          const greeting = person.source === "careers" ? `Hi ${company.name} team,` : `Hi ${firstName},`;
          const fullBody = `${greeting}\n\n${template.body}`;
          const draftArgs = {
            to: email,
            subject: template.subject,
            body: fullBody,
            attachmentPath: resumePath,
          };

          // Re-draft = EDIT in place. Find the existing draft — this tab's live one
          // if we have it, else the most recent one recorded in the log for this
          // email (covers drafts made in a previous session) — and update it. That
          // keeps the draft id (so a scheduled send tied to it stays valid) and
          // never leaves a duplicate. If that draft is gone (already sent/deleted),
          // fall back to a fresh draft.
          const priorDraftId = person.replaceDraftId || lastDraftIdFor(email);
          let draftId: string;
          let reason: string | undefined;
          if (priorDraftId) {
            try {
              draftId = await updateDraft(auth, priorDraftId, draftArgs, from);
              reason = "updated existing draft";
            } catch {
              draftId = await createDraft(auth, draftArgs, from);
              reason = "earlier draft was gone — created a new one";
            }
          } else {
            draftId = await createDraft(auth, draftArgs, from);
          }

          // Log only when a NEW draft id was minted (brand-new person, or the
          // fallback above). An in-place edit keeps the id already on record, so
          // the log stays accurate without ballooning.
          if (draftId !== priorDraftId) {
            logOutreach({
              company: company.name!,
              role,
              name: fullName,
              title,
              email,
              emailStatus,
              subject: template.subject,
              draftStatus: `draft:${draftId}`,
            });
          }

          send({
            id: person.id,
            name: fullName,
            title,
            email,
            status: "drafted",
            reason,
            subject: template.subject,
            bodyPreview: fullBody,
            draftId,
            emailSource,
            emailScore,
            resumeAttached,
            creditSpent,
          });
        } catch (e: any) {
          send({ id: person.id, status: "error", reason: e?.message ?? "Failed to draft.", creditSpent });
        }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
