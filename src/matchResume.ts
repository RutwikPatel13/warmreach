import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "./config";
import { profile } from "./profile";
import type { JobText } from "./jobText";

// ── Résumé ↔ role matching ──────────────────────────────────────────────────
// One Claude call per candidate posting. The résumé PDF goes in as a document
// block so the model reads the real thing rather than a summary of it, and the
// verdict comes back through a forced tool call — the same structured-output
// pattern personalize.ts uses, so no new SDK surface is involved.
//
// The load-bearing rule is in the tool schema: every strength must carry a
// VERBATIM quote from the résumé. Without it the model happily credits you with
// skills you never listed, which would make the score worse than useless.
//
// Its own model constant, deliberately: ANTHROPIC_MODEL drives the email writing
// and changing that would alter existing behaviour. Override with WATCH_MATCH_MODEL.

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

export const MATCH_MODEL = process.env.WATCH_MATCH_MODEL || "claude-opus-5";

export interface MatchAssessment {
  score: number;
  verdict: "strong" | "worth_a_look" | "stretch" | "skip";
  strengths: { claim: string; resumeQuote: string }[];
  gaps: string[];
  referralLine: string;
  groundedInJd: boolean;
}

export interface JobFacts {
  title: string;
  company: string;
  location?: string | null;
  companyDescription?: string | null;
  companyKeywords?: string[];
  jd: JobText | null;
}

const MATCH_TOOL: Anthropic.Tool = {
  name: "record_match",
  description: "Record the assessment of how well this candidate fits this specific role.",
  input_schema: {
    type: "object",
    properties: {
      score: {
        type: "integer",
        description: "0-100. How well the candidate fits THIS role, judged only on evidence in the résumé.",
      },
      verdict: {
        type: "string",
        enum: ["strong", "worth_a_look", "stretch", "skip"],
        description:
          "strong = clearly qualified; worth_a_look = real overlap with gaps; stretch = reachable but a real climb; skip = not a serious fit.",
      },
      strengths: {
        type: "array",
        maxItems: 3,
        description: "Up to 3 concrete reasons this fits. Omit rather than pad.",
        items: {
          type: "object",
          properties: {
            claim: { type: "string", description: "What the role needs, in one clause." },
            resume_quote: {
              type: "string",
              description:
                "A VERBATIM span copied from the résumé that evidences the claim. Never paraphrase, never invent. If no such span exists, do not make the claim.",
            },
          },
          required: ["claim", "resume_quote"],
        },
      },
      gaps: {
        type: "array",
        maxItems: 2,
        items: { type: "string" },
        description: "Up to 2 honest gaps between the résumé and the role. Say the real ones.",
      },
      referral_line: {
        type: "string",
        description:
          "One sentence a friend at the company could forward internally, naming the strongest concrete evidence. No adjectives about enthusiasm.",
      },
      grounded_in_jd: {
        type: "boolean",
        description: "True only if a real job description was provided. False when judging from the title alone.",
      },
    },
    required: ["score", "verdict", "strengths", "gaps", "referral_line", "grounded_in_jd"],
  },
};

const SCORING_RULES = [
  `You assess how well ${profile.fullName} fits a specific open role, from their résumé.`,
  "",
  "RULES:",
  "- Judge ONLY on what the résumé actually shows. Never credit a skill it doesn't evidence.",
  "- Every strength needs a verbatim résumé quote. No quote, no claim — drop it instead.",
  "- Gaps are for the candidate's benefit, not politeness. Name the real ones plainly.",
  "- When no job description is supplied you are judging from a job title and company profile alone:",
  "  set grounded_in_jd false and keep the score conservative — you are guessing at requirements.",
  "- Scoring: 80+ clearly qualified today. 60-79 real overlap, some gaps. 40-59 a genuine stretch.",
  "  Below 40 use verdict \"skip\" — the candidate should not spend a referral on it.",
  "- The referral line is read by a busy friend, not a recruiter. One sentence, concrete, no filler.",
  "",
  "CANDIDATE BACKGROUND (context for the résumé, not a substitute for it):",
  profile.educationLine,
  ...profile.experienceBullets.map((b) => `- ${b}`),
].join("\n");

function jobBlock(job: JobFacts): string {
  const lines = [
    `ROLE: ${job.title}`,
    `COMPANY: ${job.company}`,
    job.location ? `LOCATION: ${job.location}` : "",
    job.companyDescription ? `ABOUT THE COMPANY: ${job.companyDescription}` : "",
    job.companyKeywords?.length ? `COMPANY KEYWORDS: ${job.companyKeywords.slice(0, 12).join(", ")}` : "",
    "",
  ];
  lines.push(
    job.jd
      ? `JOB DESCRIPTION (fetched from ${job.jd.source}):\n${job.jd.text}`
      : "JOB DESCRIPTION: not available — this posting is on a site that blocks fetching.\nJudge from the title and company context above, and set grounded_in_jd to false.",
  );
  return lines.filter(Boolean).join("\n");
}

// The résumé PDF, base64'd. Read per call but cheap (a few hundred KB off local
// disk) and cached on the API side via cache_control, so a morning's worth of
// matches pays for the résumé tokens once.
function resumeDocument(resumePath: string): Record<string, unknown> | null {
  try {
    const data = fs.readFileSync(resumePath);
    if (!data.length) return null;
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") },
      cache_control: { type: "ephemeral" },
    };
  } catch {
    return null; // no résumé on disk — fall back to the profile bullets alone
  }
}

/**
 * Score one posting against the résumé. Returns null when the model judges it a
 * skip, so a below-the-bar role never becomes a notification.
 */
export async function matchRoleToResume(
  job: JobFacts,
  resumePath: string = profile.resumePath,
): Promise<MatchAssessment | null> {
  const doc = resumeDocument(resumePath);
  const content: Record<string, unknown>[] = [];
  if (doc) content.push(doc);
  content.push({ type: "text", text: jobBlock(job) });

  const message = await client.messages.create({
    model: MATCH_MODEL,
    // Adaptive thinking is ON by default on Opus 5 and draws from this same
    // budget, so a value sized for the JSON alone truncates the tool call
    // mid-object. Leave real headroom: the assessment itself is well under 1k.
    max_tokens: 8192,
    system: [
      {
        type: "text",
        text: SCORING_RULES,
        cache_control: { type: "ephemeral" },
      },
    ] as unknown as Anthropic.MessageCreateParams["system"],
    tools: [MATCH_TOOL],
    tool_choice: { type: "tool", name: "record_match" },
    messages: [{ role: "user", content: content as unknown as Anthropic.MessageParam["content"] }],
  });

  // A truncated turn leaves the tool input as half-parsed JSON — fields missing
  // or the wrong type. Better no match than a mangled one, so bail outright.
  if (message.stop_reason === "max_tokens") return null;

  const block = message.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") return null;

  const raw = block.input as {
    score?: number;
    verdict?: MatchAssessment["verdict"];
    strengths?: { claim?: string; resume_quote?: string }[];
    gaps?: string[];
    referral_line?: string;
    grounded_in_jd?: boolean;
  };

  const verdict = raw.verdict ?? "skip";
  if (verdict === "skip") return null;

  return {
    score: Math.max(0, Math.min(100, Math.round(raw.score ?? 0))),
    verdict,
    // Drop any strength that arrived without its quote — the schema asks for one,
    // and an unevidenced claim is exactly what this feature must not surface.
    // Array.isArray rather than ?? [] : a partial parse can leave these as an
    // object or a string, and .filter would throw on both.
    strengths: (Array.isArray(raw.strengths) ? raw.strengths : [])
      .filter((s) => s?.claim?.trim() && s?.resume_quote?.trim())
      .slice(0, 3)
      .map((s) => ({ claim: s.claim!.trim(), resumeQuote: s.resume_quote!.trim() })),
    gaps: (Array.isArray(raw.gaps) ? raw.gaps : []).filter((g) => typeof g === "string" && g.trim()).slice(0, 2),
    referralLine: raw.referral_line?.trim() ?? "",
    // Trust the fetch, not the model, on whether a description existed.
    groundedInJd: Boolean(job.jd) && raw.grounded_in_jd !== false,
  };
}
