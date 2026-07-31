import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from "./config";
import { profile } from "./profile";
import { classifyVariant, type Variant, type Email, type CompanyFacts } from "./personalize";
import { HUMAN_EMAIL_RULES, humanize } from "./humanRules";

// ── Campaign (cold) personalization ─────────────────────────────────────────
// The Applications flow (src/personalize.ts) assumes the user APPLIED to a role
// and attaches a resume. Campaigns are different: a cold, warm-toned intro to a
// startup the user admires — "I'd love to help you build" — with NO application,
// NO role, NO resume, and NO forced experience bullets. This module keeps that
// prompt separate so the application flow is never affected. Personalization is
// grounded ONLY in the company's Apollo facts (never invented).

export { classifyVariant, type Variant, type Email, type CompanyFacts };

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const EMAIL_TOOL: Anthropic.Tool = {
  name: "compose_email",
  description: "Return the composed cold-intro email.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "The email subject line." },
      body: { type: "string", description: "The full plain-text email body (no greeting line)." },
    },
    required: ["subject", "body"],
  },
};

const TONE: Record<Variant, string> = {
  recruiter:
    "You are writing to a FOUNDER, CEO, recruiter, or people/talent person. Keep it warm, human, and confident — peer to peer, not fawning.",
  engineering:
    'You are writing to an ENGINEER or engineering leader (CTO / VP Eng / eng manager). A brief "as a fellow engineer" framing and a genuine, specific nod to the kind of technical work the team does is welcome — never buzzword-y.',
};

// A compact "who I am" seed drawn from the profile — the model may paraphrase
// this into one tight line (unlike the Applications flow, bullets are NOT verbatim).
function aboutSeed(): string {
  const bits = [profile.educationLine, ...(profile.experienceBullets ?? [])].filter(Boolean);
  return bits.join(" ");
}

function buildPrompt(
  facts: CompanyFacts,
  variant: Variant,
  opts: { instructions?: string; baseTemplate?: Email },
): string {
  const extra = opts.instructions?.trim();
  const base = opts.baseTemplate;
  const links = [profile.portfolio && `Portfolio: ${profile.portfolio}`, profile.linkedin && `LinkedIn: ${profile.linkedin}`]
    .filter(Boolean)
    .join("\n");

  return [
    `You are drafting a SHORT, sincere cold-intro email on behalf of ${profile.fullName}.`,
    `He is NOT applying to a job. He admires ${facts.name} and is reaching out to offer to help build — open to any role, whether or not they are actively hiring.`,
    `This is a TEMPLATE sent to several people at ${facts.name}, so do NOT mention any recipient's name.`,
    "",
    `AUDIENCE: ${TONE[variant]}`,
    "",
    "COMPANY CONTEXT (personalize ONLY from these facts — never invent products, funding, or details):",
    `- Name: ${facts.name}`,
    facts.description ? `- About: ${facts.description}` : "",
    facts.keywords.length ? `- Keywords: ${facts.keywords.join(", ")}` : "",
    "",
    `ABOUT ${profile.fullName} (source material — paraphrase into ONE tight line; do not dump verbatim):`,
    aboutSeed(),
    "",
    base
      ? [
          "BASE TEMPLATE to adapt (keep its voice and structure; rewrite only the company-specific personalization so it fits the company context above):",
          `Subject: ${base.subject}`,
          "Body:",
          base.body,
        ].join("\n")
      : [
          "WRITE the body with this shape (NO greeting/salutation — a 'Hi <name>,' line is added separately):",
          `1. Opening (1–2 sentences): introduce himself by name and say, specifically and genuinely, what he admires about ${facts.name} — grounded in the company context above.`,
          "2. The offer (1–2 sentences): he'd love to help them build and is reaching out directly; open to any role where he'd be useful, whether or not they're hiring right now. Weave in ONE tight line about who he is.",
          `3. Close: point to his work with these links, each on its own line:\n${links}`,
          `4. This signature, VERBATIM:\n${profile.signature}`,
        ].join("\n"),
    "",
    "RULES:",
    "- Keep it SHORT — 90–150 words before the signature. Cold emails earn replies by being brief.",
    "- No greeting/salutation line (no 'Hi ...,' / 'Dear ...,'). Start with the opening sentence.",
    "- Do NOT mention applying, a specific role, or an attached resume.",
    "- The personalized line must reflect REAL facts from the company context; if context is thin, keep it modest and honest rather than inventing.",
    "- Keep the signature VERBATIM. No markdown except the **bold** allowed below.",
    "",
    extra
      ? `CUSTOM INSTRUCTIONS from ${profile.fullName} — follow them; where they conflict with the above, they win:\n${extra}\n`
      : "",
    base
      ? `Also adapt the subject line to ${facts.name} while keeping the base template's format.`
      : `Also produce a short, non-spammy subject line that references ${facts.name} (e.g. "Loved what ${facts.name} is building"). Avoid ALL CAPS and clickbait.`,
    HUMAN_EMAIL_RULES,
    "Return the result by calling the compose_email tool.",
  ]
    .filter(Boolean)
    .join("\n");
}

// One Claude call — a cold-intro template for one audience at one company.
// No Apollo cost. Grounded in the company facts captured during campaign search.
export async function generateCampaignVariant(
  facts: CompanyFacts,
  variant: Variant,
  opts: { instructions?: string; baseTemplate?: Email } = {},
): Promise<Email> {
  const message = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1536,
    tools: [EMAIL_TOOL],
    tool_choice: { type: "tool", name: "compose_email" },
    messages: [{ role: "user", content: buildPrompt(facts, variant, opts) }],
  });
  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Model did not return a compose_email tool call");
  }
  const out = toolUse.input as { subject: string; body: string };
  return { subject: humanize(out.subject), body: humanize(out.body) };
}
