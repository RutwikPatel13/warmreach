import type Anthropic from "@anthropic-ai/sdk";
import { callTool, parseRef } from "./llm";
import { profile } from "./profile";
import type { Contact } from "./apollo";
import { HUMAN_EMAIL_RULES, humanize } from "./humanRules";

export interface Email {
  subject: string;
  body: string;
}

function buildPrompt(contact: Contact, role: string, jobDescription?: string): string {
  const company = contact.company;
  const jd = jobDescription?.trim();
  return [
    `You are drafting a short, sincere job-outreach email on behalf of ${profile.fullName}.`,
    `He recently APPLIED to the "${role}" role at ${company.name} and is now reaching out directly to a person there.`,
    "",
    "RECIPIENT:",
    `- Name: ${contact.firstName}`,
    `- Title: ${contact.title}`,
    `- Seniority: ${contact.seniority ?? "unknown"}`,
    "",
    "COMPANY CONTEXT (use ONLY these facts for personalization — never invent details):",
    `- Name: ${company.name}`,
    company.description ? `- About: ${company.description}` : "",
    company.keywords.length ? `- Keywords: ${company.keywords.join(", ")}` : "",
    "",
    jd
      ? `JOB DESCRIPTION for the "${role}" role (use to ground the personalization sentence and make the relevance specific to what this role actually needs — do NOT copy text from it verbatim, do NOT invent anything not supported by it or the company context):\n${jd}\n`
      : "",
    "WRITE the email body in EXACTLY this structure:",
    `1. Greeting: "Hi ${contact.firstName},"`,
    `2. Opening: introduce himself by name, say he recently applied for the "${role}" position at ${company.name}, and that he wanted to reach out to express interest. If the recipient is an engineer (e.g. SWE/CTO), you may add a brief "as a fellow engineer" framing; if a founder/recruiter, keep it warm and professional.`,
    `3. This exact sentence, followed immediately by ONE personalized sentence grounded in the company context above (genuine, specific, no buzzword soup):\n"${profile.educationLine}"`,
    `4. The line "Relevant experience for this role:" then these four bullets, VERBATIM, each on its own line prefixed with "- ":\n${profile.experienceBullets.map((b) => "- " + b).join("\n")}`,
    `5. Closing: he'd love to learn more about the team and how he could contribute; happy to share more or walk through projects; mention the resume is attached.`,
    `6. A thank-you line.`,
    `7. This signature, VERBATIM:\n${profile.signature}`,
    "",
    "RULES:",
    "- Keep it concise (~200-240 words before the signature).",
    "- Do NOT modify the bullets or signature.",
    "- The personalization sentence must reflect real facts from the company context; if context is thin, keep it modest and honest.",
    "- No markdown except the **bold** allowed below.",
    "",
    `Also produce a subject line in this format: "Software Engineer application — ${profile.fullName}${profile.subjectTag ? ` (${profile.subjectTag})` : ""}". You may lightly adapt the role name to match "${role}".`,
    HUMAN_EMAIL_RULES,
    "Return the result by calling the compose_email tool.",
  ]
    .filter(Boolean)
    .join("\n");
}

const EMAIL_TOOL: Anthropic.Tool = {
  name: "compose_email",
  description: "Return the composed outreach email.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "The email subject line." },
      body: { type: "string", description: "The full plain-text email body." },
    },
    required: ["subject", "body"],
  },
};

export interface PersonalizeResult {
  email: Email;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  ms: number;
}

// Lower-level: get usage/latency back (for benchmarking). `model` pins one
// provider ("gemini:gemini-3.5-flash", or a bare Claude id); omitted, the
// configured provider chain is used.
export async function personalizeWith(
  contact: Contact,
  role: string,
  model?: string,
  jobDescription?: string,
): Promise<PersonalizeResult> {
  const start = Date.now();
  const r = await callTool<{ subject: string; body: string }>({
    tool: EMAIL_TOOL,
    prompt: buildPrompt(contact, role, jobDescription),
    maxTokens: 2048,
    only: model ? parseRef(model) : undefined,
  });
  return {
    email: { subject: humanize(r.output.subject), body: humanize(r.output.body) },
    model: `${r.provider}:${r.model}`,
    usage: r.usage,
    ms: Date.now() - start,
  };
}

export async function personalize(
  contact: Contact,
  role: string,
  jobDescription?: string,
): Promise<Email> {
  return (await personalizeWith(contact, role, undefined, jobDescription)).email;
}

// ───────────────────────────────────────────────────────────────────────────
// Company-level templates (web app): generate ONE email per audience for the
// whole company, then merge each recipient's name at draft time. Two variants.
// ───────────────────────────────────────────────────────────────────────────

export type Variant = "recruiter" | "engineering";

export interface CompanyFacts {
  name: string;
  description: string | null;
  keywords: string[];
}

const VARIANT_TONE: Record<Variant, string> = {
  recruiter:
    "You are writing to a RECRUITER, talent/people-ops person, or FOUNDER at the company. Keep the tone warm, professional, and concise.",
  engineering:
    'You are writing to an ENGINEER or engineering manager. You may use a brief "as a fellow engineer" framing and a light, genuine nod to the kind of technical work the team does — never fawning or buzzword-y.',
};

// Decide which template a person should receive, from their job title.
export function classifyVariant(title: string): Variant {
  const t = (title ?? "").toLowerCase();
  const eng = /\b(engineer|engineering|swe|software|developer|programmer|cto|architect|tech lead)\b/;
  return eng.test(t) ? "engineering" : "recruiter";
}

function buildVariantPrompt(
  facts: CompanyFacts,
  role: string,
  variant: Variant,
  jobDescription?: string,
  extraInstructions?: string,
): string {
  const jd = jobDescription?.trim();
  const extra = extraInstructions?.trim();
  return [
    `You are drafting a short, sincere job-outreach email TEMPLATE on behalf of ${profile.fullName}.`,
    `He recently APPLIED to the "${role}" role at ${facts.name} and is now reaching out directly to people there.`,
    `This is a TEMPLATE sent to several people at the same company, so do NOT mention any recipient's name.`,
    "",
    `AUDIENCE: ${VARIANT_TONE[variant]}`,
    "",
    "COMPANY CONTEXT (use ONLY these facts for personalization — never invent details):",
    `- Name: ${facts.name}`,
    facts.description ? `- About: ${facts.description}` : "",
    facts.keywords.length ? `- Keywords: ${facts.keywords.join(", ")}` : "",
    "",
    jd
      ? `JOB DESCRIPTION for the "${role}" role (use to ground the personalization sentence and make the relevance specific to what this role actually needs — do NOT copy text from it verbatim, do NOT invent anything not supported by it or the company context):\n${jd}\n`
      : "",
    "WRITE the email body in EXACTLY this structure (NO greeting/salutation — the email will start directly with the opening paragraph; a 'Hi <name>,' line is added separately):",
    `1. Opening: introduce himself by name, say he recently applied for the "${role}" position at ${facts.name}, and that he wanted to reach out to express interest, in the tone described under AUDIENCE.`,
    `2. This exact sentence, followed immediately by ONE personalized sentence grounded in the company context above (genuine, specific, no buzzword soup):\n"${profile.educationLine}"`,
    `3. The line "Relevant experience for this role:" then these four bullets, VERBATIM, each on its own line prefixed with "- ":\n${profile.experienceBullets.map((b) => "- " + b).join("\n")}`,
    `4. Closing: he'd love to learn more about the team and how he could contribute; happy to share more or walk through projects; mention the resume is attached.`,
    `5. A thank-you line.`,
    `6. This signature, VERBATIM:\n${profile.signature}`,
    "",
    "RULES:",
    "- Do NOT include any greeting or salutation line (no 'Hi ...,' / 'Dear ...,'). Start with the opening paragraph.",
    "- Do NOT reference a recipient name anywhere.",
    "- Keep it concise (~200-240 words before the signature).",
    "- Do NOT modify the bullets or signature.",
    "- The personalization sentence must reflect real facts from the company context; if context is thin, keep it modest and honest.",
    "- No markdown except the **bold** allowed below.",
    "",
    extra
      ? `CUSTOM INSTRUCTIONS from the applicant — follow them; where they conflict with the structure or rules above, the custom instructions win:\n${extra}\n`
      : "",
    `Also produce a subject line in this format: "Software Engineer application — ${profile.fullName}${profile.subjectTag ? ` (${profile.subjectTag})` : ""}". You may lightly adapt the role name to match "${role}".`,
    HUMAN_EMAIL_RULES,
    "Return the result by calling the compose_email tool.",
  ]
    .filter(Boolean)
    .join("\n");
}

// Variant prompt when a SAVED TEMPLATE is the starting point: Claude keeps the
// template's structure/tone/wording and rewrites only what is company- or
// role-specific (above all the personalization sentence), grounded in the new
// company's facts. Placeholders are merged before this is called.
function buildAdaptVariantPrompt(
  facts: CompanyFacts,
  role: string,
  variant: Variant,
  baseTemplate: Email,
  jobDescription?: string,
  extraInstructions?: string,
): string {
  const jd = jobDescription?.trim();
  const extra = extraInstructions?.trim();
  return [
    `You are adapting a SAVED outreach email template on behalf of ${profile.fullName}.`,
    `He recently APPLIED to the "${role}" role at ${facts.name} and is now reaching out directly to people there.`,
    `This is a TEMPLATE sent to several people at the same company, so do NOT mention any recipient's name.`,
    "",
    `AUDIENCE: ${VARIANT_TONE[variant]}`,
    "",
    "COMPANY CONTEXT (use ONLY these facts for personalization — never invent details):",
    `- Name: ${facts.name}`,
    facts.description ? `- About: ${facts.description}` : "",
    facts.keywords.length ? `- Keywords: ${facts.keywords.join(", ")}` : "",
    "",
    jd
      ? `JOB DESCRIPTION for the "${role}" role (use to ground the personalization and make the relevance specific to what this role actually needs — do NOT copy text from it verbatim, do NOT invent anything not supported by it or the company context):\n${jd}\n`
      : "",
    "SAVED TEMPLATE to adapt:",
    `Subject: ${baseTemplate.subject}`,
    "Body:",
    baseTemplate.body,
    "",
    "ADAPT the template for this company:",
    "- Keep its structure, tone, and wording wherever they are NOT company- or role-specific.",
    "- Rewrite anything company- or role-specific — especially the personalization sentence — so it is grounded ONLY in the company context (and job description) above; if context is thin, keep it modest and honest.",
    "- Keep the experience bullets and the signature VERBATIM as they appear in the template.",
    "- Do NOT include any greeting or salutation line (no 'Hi ...,' / 'Dear ...,'). Start with the opening paragraph — a 'Hi <name>,' line is added separately.",
    "- No markdown except the **bold** allowed below. Keep it concise (~200-240 words before the signature).",
    "- Adapt the subject line to this company/role while keeping its format.",
    "",
    extra
      ? `CUSTOM INSTRUCTIONS from the applicant — follow them; where they conflict with the rules above, the custom instructions win:\n${extra}\n`
      : "",
    HUMAN_EMAIL_RULES,
    "Return the result by calling the compose_email tool.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateVariant(
  facts: CompanyFacts,
  role: string,
  variant: Variant,
  jobDescription?: string,
  extraInstructions?: string,
  baseTemplate?: Email,
): Promise<Email> {
  const prompt = baseTemplate
    ? buildAdaptVariantPrompt(facts, role, variant, baseTemplate, jobDescription, extraInstructions)
    : buildVariantPrompt(facts, role, variant, jobDescription, extraInstructions);
  const { output: out } = await callTool<{ subject: string; body: string }>({ tool: EMAIL_TOOL, prompt, maxTokens: 2048 });
  return { subject: humanize(out.subject), body: humanize(out.body) };
}

// Two model calls (in parallel) — one template per audience for the whole company.
export async function generateVariants(
  facts: CompanyFacts,
  role: string,
  jobDescription?: string,
  extraInstructions?: string,
  baseVariants?: Record<Variant, Email>,
): Promise<Record<Variant, Email>> {
  const [recruiter, engineering] = await Promise.all([
    generateVariant(facts, role, "recruiter", jobDescription, extraInstructions, baseVariants?.recruiter),
    generateVariant(facts, role, "engineering", jobDescription, extraInstructions, baseVariants?.engineering),
  ]);
  return { recruiter, engineering };
}
