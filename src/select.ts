import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from "./config";

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// JD-based people selection: one Claude call ranks the (free) Apollo/Hunter
// search results against the pasted job description, so the likely hiring
// manager / relevant team leads / recruiters bubble up BEFORE any enrichment
// credit is spent. Judged from job titles only — no extra Apollo cost.

export interface Fit {
  priority: "high" | "medium";
  reason: string;
}

export interface SelectCandidate {
  id: string;
  firstName: string;
  title: string;
}

// The model returns list indexes (small integers), not candidate ids — Apollo
// ids are long opaque strings that invite transcription errors.
const SELECT_TOOL: Anthropic.Tool = {
  name: "select_contacts",
  description: "Return the people worth emailing about this specific role.",
  input_schema: {
    type: "object",
    properties: {
      picks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "The person's number from the PEOPLE list." },
            priority: { type: "string", enum: ["high", "medium"] },
            reason: {
              type: "string",
              description: "Why this person, in at most 10 words, grounded in their title.",
            },
          },
          required: ["index", "priority", "reason"],
        },
      },
    },
    required: ["picks"],
  },
};

function buildPrompt(
  companyName: string,
  role: string,
  jobDescription: string,
  candidates: SelectCandidate[],
): string {
  const people = candidates
    .map((c, i) => `${i}. ${c.firstName || "(unknown)"} — ${c.title || "(no title)"}`)
    .join("\n");
  return [
    `You are helping a job applicant decide WHO to email at ${companyName} after applying to their "${role}" role.`,
    "Below are the job description and the people found at the company (names and job titles only).",
    "",
    "Classify who is worth emailing about THIS role:",
    '- "high" — directly involved in hiring for it: recruiters / talent / people ops, the likely hiring manager, leads or managers of the team the JD describes, and founders/execs if the company looks small.',
    '- "medium" — plausibly relevant: engineers or managers in an adjacent area, generalist HR.',
    "- OMIT anyone whose function is clearly unrelated to this role (e.g. sales, marketing, finance, or a different specialty).",
    "",
    "JOB DESCRIPTION:",
    jobDescription,
    "",
    "PEOPLE:",
    people,
    "",
    "RULES:",
    "- Judge ONLY by title vs the job description — never invent facts about a person.",
    '- reason: at most 10 words, grounded in the title (e.g. "technical recruiter — likely owns eng hiring").',
    "- Include at most 40 picks; when unsure between medium and omit, prefer omit.",
    "Return the result by calling the select_contacts tool.",
  ].join("\n");
}

// One Claude call; returns a fit per candidate id (absent = not a match).
// Callers should treat failures as non-fatal — ranking is a nicety on top of
// search, so fail open rather than blocking results.
export async function selectContacts(
  companyName: string,
  role: string,
  jobDescription: string,
  candidates: SelectCandidate[],
): Promise<Record<string, Fit>> {
  if (candidates.length === 0) return {};

  const message = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    tools: [SELECT_TOOL],
    tool_choice: { type: "tool", name: "select_contacts" },
    messages: [
      { role: "user", content: buildPrompt(companyName, role, jobDescription, candidates) },
    ],
  });

  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Model did not return a select_contacts tool call");
  }
  const out = toolUse.input as { picks?: { index: number; priority: string; reason: string }[] };

  const fits: Record<string, Fit> = {};
  for (const pick of out.picks ?? []) {
    const candidate = candidates[pick.index];
    if (!candidate) continue; // index out of range — ignore
    if (pick.priority !== "high" && pick.priority !== "medium") continue;
    if (fits[candidate.id]) continue; // duplicate index — first wins
    fits[candidate.id] = { priority: pick.priority, reason: String(pick.reason ?? "").trim() };
  }
  return fits;
}
