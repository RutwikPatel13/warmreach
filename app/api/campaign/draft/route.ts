import { NextResponse } from "next/server";
import { enrichPerson } from "@/src/apollo";
import { generateCampaignVariant, type Variant, type Email } from "@/src/campaignPersonalize";
import { classifyVariant } from "@/src/personalize";
import { getGmailAuth, getFromAddress, hasGmailToken, createDraft, updateDraft } from "@/src/gmail";
import { logOutreach, alreadyContacted, lastDraftIdFor } from "@/src/tracker";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PEOPLE = 1000; // safety bound for one campaign draft run

interface InPerson {
  id: string;
  firstName: string;
  lastName?: string | null;
  name?: string | null; // full name from a prior result row (regeneration)
  title?: string;
  variant?: Variant;
  source?: "apollo" | "csv"; // "csv" = already on file (no enrichment credit)
  email?: string | null; // present for csv people OR when regenerating a known person
  // When set (regeneration), the email is already known so enrichment is SKIPPED
  // (no credit) and this existing Gmail draft is UPDATED in place instead of duped.
  replaceDraftId?: string | null;
}
interface InCompany {
  name: string;
  domain?: string | null;
  description?: string | null;
  keywords?: string[];
  people: InPerson[];
}
interface Body {
  companies?: InCompany[];
  instructions?: string;
  template?: Email | null; // optional base template Claude adapts per company
  skipContacted?: boolean;
}

interface ResultLine {
  id: string;
  company: string;
  name?: string;
  title?: string;
  email?: string | null;
  status: "drafted" | "skipped" | "error";
  reason?: string;
  subject?: string;
  bodyPreview?: string;
  draftId?: string;
}

// Bulk cold-outreach drafting for a campaign. For each company it generates the
// cold-intro email ONCE per audience (cached, no Apollo cost), then per selected
// person: enriches for a verified email (1 Apollo credit), skips anyone already
// contacted, and creates a Gmail draft (NO resume attachment). Streams one NDJSON
// line per person. Nothing is sent — the drip scheduler / manual send does that.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as Body;
  const companies = (body.companies ?? []).filter((c) => c?.name && c.people?.length);
  const instructions = body.instructions?.trim() || undefined;
  const baseTemplate = body.template?.body?.trim() ? body.template! : undefined;
  const skipContacted = body.skipContacted !== false; // default on

  const totalPeople = companies.reduce((n, c) => n + c.people.length, 0);
  if (companies.length === 0 || totalPeople === 0) {
    return NextResponse.json({ error: "Select at least one person to draft." }, { status: 400 });
  }
  if (totalPeople > MAX_PEOPLE) {
    return NextResponse.json(
      { error: `That's ${totalPeople} drafts in one run (max ${MAX_PEOPLE}). Narrow the selection.` },
      { status: 400 },
    );
  }
  if (!hasGmailToken()) {
    return NextResponse.json(
      { error: "Gmail isn't authorized yet. Run `npm run gmail:auth` once in the terminal, then retry." },
      { status: 400 },
    );
  }

  let auth: any;
  let from: string;
  try {
    auth = await getGmailAuth();
    from = await getFromAddress(auth);
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    const hint = msg.includes("invalid_grant")
      ? "Gmail authorization expired. Re-run `npm run gmail:auth`, then retry."
      : `Gmail auth failed: ${msg || "unknown error"}`;
    return NextResponse.json({ error: hint }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: ResultLine) => controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));

      for (const company of companies) {
        const facts = {
          name: company.name,
          description: company.description ?? null,
          keywords: company.keywords ?? [],
        };
        // One generated email per audience, reused across this company's people.
        const cache = new Map<Variant, Email>();
        const emailFor = async (variant: Variant): Promise<Email> => {
          const hit = cache.get(variant);
          if (hit) return hit;
          const generated = await generateCampaignVariant(facts, variant, { instructions, baseTemplate });
          cache.set(variant, generated);
          return generated;
        };

        for (const person of company.people) {
          try {
            const variant = person.variant ?? classifyVariant(person.title ?? "");
            let email: string | null;
            let firstName = person.firstName;
            let fullName: string;
            let title: string;
            let emailStatus: string;

            if (person.email) {
              // Email already in hand — a CSV contact, or regenerating a known person.
              // No Apollo enrichment, so no credit spent.
              email = person.email;
              fullName = person.name || `${person.firstName}${person.lastName ? " " + person.lastName : ""}`.trim() || person.email;
              title = person.title ?? "";
              emailStatus = person.source === "csv" ? "csv" : "";
            } else {
              const contact = await enrichPerson(person.id, company.domain ?? undefined);
              email = contact.email;
              firstName = person.firstName || contact.firstName;
              fullName = contact.fullName;
              title = contact.title;
              emailStatus = contact.emailStatus ?? "";
            }

            if (!email) {
              send({ id: person.id, company: company.name, name: fullName, title, status: "skipped", reason: "no verified email" });
              continue;
            }
            if (skipContacted && alreadyContacted(email) && !lastDraftIdFor(email) && !person.replaceDraftId) {
              send({ id: person.id, company: company.name, name: fullName, title, email, status: "skipped", reason: "already contacted (in outreach log)" });
              continue;
            }

            const tpl = await emailFor(variant);
            const fullBody = `Hi ${firstName},\n\n${tpl.body}`;
            const draftArgs = { to: email, subject: tpl.subject, body: fullBody };

            // Re-draft = UPDATE the existing Gmail draft in place (keeps its id so a
            // scheduled send stays valid, and never leaves a duplicate). Fall back to a
            // fresh draft only if that draft is gone (already sent/deleted).
            const priorDraftId = person.replaceDraftId || lastDraftIdFor(email);
            let draftId: string;
            let reason: string | undefined;
            if (priorDraftId) {
              try {
                draftId = await updateDraft(auth, priorDraftId, draftArgs, from);
                reason = "updated existing draft";
              } catch {
                draftId = await createDraft(auth, draftArgs, from);
                reason = "earlier draft was gone, created a new one";
              }
            } else {
              draftId = await createDraft(auth, draftArgs, from);
            }

            // Only log when a NEW draft id was minted; an in-place edit keeps the id on record.
            if (draftId !== priorDraftId) {
              logOutreach({
                company: company.name,
                role: "campaign",
                name: fullName,
                title,
                email,
                emailStatus,
                subject: tpl.subject,
                draftStatus: `draft:${draftId}`,
              });
            }

            send({ id: person.id, company: company.name, name: fullName, title, email, status: "drafted", reason, subject: tpl.subject, bodyPreview: fullBody, draftId });
          } catch (e: any) {
            send({
              id: person.id,
              company: company.name,
              status: "error",
              reason: e?.message ?? "Failed to draft.",
            });
          }
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
