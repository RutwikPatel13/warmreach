// ── Tailoring a résumé to one job description ──────────────────────────────
// Two rules govern everything here, and they pull against each other:
//
//   NOTHING NEW. Every bullet must trace to something Rutwik already wrote —
//   either the live one-pager or the master résumé. The model rewords and
//   reorders; it never invents an achievement, a number, or a technology. The
//   tool schema enforces this structurally: a bullet has to name the bank entry
//   it came from, and a bullet whose source id isn't in the bank is dropped
//   before it can reach the document.
//
//   THE PAGE DOESN'T MOVE. Each bullet occupies a slot with a measured line
//   count, and a rewrite must land in that slot's character budget. Keeping the
//   per-entry line total fixed is what keeps the résumé on one page — so the
//   budgets are computed from a real TeX measurement, not a guess, and the
//   result is measured again before anything is applied.
//
// Cost: the bank and the rules are a stable prefix and get cached, so a refit
// against a second JD pays for the JD and the output only.

import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "./config";
import { friendlyLlmError } from "./apiErrors";
import { plainText, sanitizeTex, validateFragment, type ParsedResume } from "./texDoc";
import type { Fit } from "./texFit";

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Sonnet 5 for the same reason it was chosen over Haiku: hitting a character
// budget while preserving meaning and staying inside the bank is constraint
// work, and the cheaper tier drops constraints under that load. Overridable.
export const TAILOR_MODEL = process.env.RESUME_TAILOR_MODEL || "claude-sonnet-5";
const EFFORT = (process.env.RESUME_TAILOR_EFFORT || "medium") as "low" | "medium" | "high";

export interface Slot {
  id: string; // the TexItem id this slot corresponds to
  entryId: string;
  lines: number;
  budget: { min: number; max: number };
  current: string;
  currentChars: number;
}

export interface ProposedBullet {
  id: string;
  text: string;
  sourceId: string;
  rationale: string;
  changed: boolean;
  /**
   * The bullet as it stood when this suggestion was made. Slot ids are
   * positional, so if the .tex is edited between tailoring and applying, id
   * "exp:2:0" can point at a different bullet than the one the model rewrote.
   * Apply checks this before splicing and skips anything that moved.
   */
  before: string;
}

export interface TailorProposal {
  strategy: string;
  bullets: ProposedBullet[];
  projects: { id: string; blurb: string; rationale: string; before: string }[];
  skills: { id: string; text: string; rationale: string; before: string }[];
  keywords: string[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface BankBullet {
  id: string;
  source: string;
  text: string;
}
interface BankEntry {
  id: string;
  company: string;
  role: string;
  dates: string;
  bullets: BankBullet[];
}
interface BankProject {
  id: string;
  name: string;
  inOnePager: boolean;
  blurb: string;
  facts: string[];
}
export interface Bank {
  experience: BankEntry[];
  projects: BankProject[];
  skills: { available: Record<string, string[]> };
}

const TOOL: Anthropic.Tool = {
  name: "tailor_resume",
  description:
    "Return the tailored résumé: one entry per bullet slot, plus project blurbs and skills lines. Every slot must be filled.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      strategy: {
        type: "string",
        description:
          "2-3 sentences: the story this résumé now tells for THIS role, and what you led with in each job and why.",
      },
      bullets: {
        type: "array",
        description:
          "Exactly one object per slot id you were given. Whatever you put in a slot is what appears at that position — to REORDER a job's bullets, move the content between its slots. The slot's line count and character budget apply to whatever you put there.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            slot_id: { type: "string", description: "The slot id, copied exactly." },
            source_id: {
              type: "string",
              description:
                "The bullet-bank id this content comes from. MUST be an id from the bank for this same job entry. Never invent one.",
            },
            text: {
              type: "string",
              description:
                "The bullet as LaTeX, no leading \\item. Keep \\textbf{} on metrics and technologies. Escape % as \\%, & as \\&, _ as \\_. Must be inside the slot's character budget.",
            },
            changed: {
              type: "boolean",
              description:
                "false ONLY if the text you are returning is character-for-character what is already in THIS slot. Moving a bullet from another slot is a change.",
            },
            rationale: { type: "string", description: "One short clause: why this bullet, here, for this role." },
          },
          required: ["slot_id", "source_id", "text", "changed", "rationale"],
        },
      },
      projects: {
        type: "array",
        description: "Project blurbs to change. Omit a project to leave it exactly as it is.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            slot_id: { type: "string" },
            source_id: { type: "string", description: "Bank project id the content comes from." },
            blurb: {
              type: "string",
              description:
                "Paragraph form, LaTeX, continuing after the project name and links. Inside the character budget.",
            },
            rationale: { type: "string" },
          },
          required: ["slot_id", "source_id", "blurb", "rationale"],
        },
      },
      skills: {
        type: "array",
        description:
          "Skills lines to change — reorder so the job's own vocabulary reads first. Only skills already in the bank.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            slot_id: { type: "string" },
            text: { type: "string", description: "Comma-separated list, LaTeX-escaped. Inside the budget." },
            rationale: { type: "string" },
          },
          required: ["slot_id", "text", "rationale"],
        },
      },
      keywords: {
        type: "array",
        description: "Terms from the job description you worked into the résumé, using the posting's own wording.",
        items: { type: "string" },
      },
    },
    required: ["strategy", "bullets", "projects", "skills", "keywords"],
  },
  strict: true,
} as Anthropic.Tool;

function rules(): string {
  return [
    "You tailor one specific résumé to one specific job description. You are editing a document that already works; your job is selection and emphasis, not creation.",
    "",
    "ABSOLUTE RULES",
    "1. Invent nothing. Every claim, number, technology and outcome must already appear in the bullet bank below. You may reword, compress, merge two bank bullets about the same work, and change emphasis. You may not add a skill he never listed, inflate a number, or imply seniority he doesn't have.",
    "2. Numbers are load-bearing, and they are the first thing a recruiter's eye stops on. Keep every metric the source bullet has (58,000+ profiles, 2.5x, 97%, 60+ organizations, 15+ hours per week, 20%). NEVER delete a number to make a bullet fit — cut adjectives, connectives, and generic phrases like 'end-to-end' or 'across production services' first. If a bullet only fits by dropping a metric, it is the wrong bullet for that slot: pick a shorter one from the bank instead. If two bank bullets give different numbers for the same work, use the one from the bullet you are sourcing from and never blend them.",
    "3. Fit the budget. Each slot gives a character range and a number to AIM FOR. Going over the maximum pushes the résumé onto a second page; landing under the minimum leaves a visibly half-empty line. Aim for the target, which sits high in the range — running slightly long is easy to trim, while a short bullet wastes a line. Count characters of visible text; LaTeX markup like \\textbf{} does not count, so a bullet with three \\textbf{} pairs needs ~30 more raw characters than its budget.",
    "4. Order is argument. Within each job, the first bullet should be the one a recruiter for THIS role most needs to see. Then build: scope, then technical depth, then breadth. The entry should read as one story, not a pile of facts.",
    "5. Mirror the posting's vocabulary. If it says 'distributed systems', use that phrase rather than 'scalable backend' — exact-match filters do not infer synonyms. Only where the underlying work genuinely matches.",
    "6. You are writing LaTeX, and the bullets you are shown ARE LaTeX. Return LaTeX the same way — keep \\textbf{} around metrics and the technologies that matter for this role, roughly as densely as the current bullets do. A bullet returned as plain prose silently strips the résumé's emphasis.",
    "7. Escape LaTeX specials every time: % as \\%, & as \\&, _ as \\_, # as \\#. A bare % comments out the rest of the line and a bare & breaks the compile.",
    "8. Every bullet starts with a strong past-tense verb. No first person, no 'responsible for'.",
    "",
    "CHANGE LESS THAN YOU WANT TO. If a slot's current bullet already says the right thing for this role, return it byte-for-byte with changed=false. Every bullet in this résumé was already written and fitted by hand, so a rewrite has to earn its place: it should add a keyword the posting asks for, lead with something more relevant, or surface a better metric. Rewording for its own sake makes the bullet shorter, emptier, and worse — a tailored résumé that changes four bullets well beats one that churns all sixteen. Reordering costs nothing and is often the whole job.",
  ].join("\n");
}

function bankBlock(bank: Bank): string {
  const lines: string[] = ["BULLET BANK — the complete set of material you may draw from.", ""];
  for (const e of bank.experience) {
    lines.push(`ENTRY ${e.id} — ${e.company}, ${e.role} (${e.dates})`);
    for (const b of e.bullets) lines.push(`  [${b.id}] (${b.source}) ${b.text}`);
    lines.push("");
  }
  lines.push("PROJECT BANK — blurb is the current paragraph; facts are everything true about the project.");
  for (const p of bank.projects) {
    lines.push(`  [${p.id}] ${p.name}${p.inOnePager ? "" : "  (not currently on the résumé)"}`);
    lines.push(`     current: ${p.blurb}`);
    for (const f of p.facts) lines.push(`     fact: ${f}`);
  }
  lines.push("");
  lines.push("SKILLS HE HAS LISTED (nothing outside this may appear):");
  for (const [k, v] of Object.entries(bank.skills.available)) lines.push(`  ${k}: ${v.join(", ")}`);
  return lines.join("\n");
}

function slotsBlock(
  parsed: ParsedResume,
  fits: Map<string, Fit>,
  bank: Bank,
  focus: Set<string> | null = null,
): { text: string; slots: Slot[] } {
  const slots: Slot[] = [];
  const lines: string[] = ["THE RÉSUMÉ AS IT STANDS — fill every bullet slot.", ""];

  for (const entry of parsed.experience) {
    const wanted = entry.items.filter((i) => !focus || focus.has(i.id));
    if (!wanted.length) continue;
    const label = [entry.primary, entry.secondary].filter(Boolean).join(" · ");
    const bankEntry = matchBankEntry(entry, bank);
    lines.push(
      `JOB ${entry.id} — ${label} (${entry.dates})   draw from bank entry: ${bankEntry?.id ?? "(none matched)"}`,
    );
    for (const item of wanted) {
      const fit = fits.get(item.id);
      const budget = fit?.budget ?? { min: 60, max: 110, current: plainText(item.text).length };
      slots.push({
        id: item.id,
        entryId: entry.id,
        lines: fit?.lines ?? 1,
        budget: { min: budget.min, max: budget.max },
        current: item.text,
        currentChars: plainText(item.text).length,
      });
      const target = Math.round(budget.min + (budget.max - budget.min) * 0.75);
      lines.push(
        `  SLOT ${item.id} — ${fit?.lines ?? 1} line(s), ${budget.min}-${budget.max} chars, AIM FOR ${target} (now ${budget.current})`,
      );
      lines.push(`    current: ${item.text}`);
    }
    lines.push("");
  }

  lines.push("PROJECT SLOTS — paragraph form. The name and links are fixed; you write what follows.");
  for (const p of parsed.projects.filter((p) => !focus || focus.has(p.id))) {
    const fit = fits.get(p.id);
    const budget = fit?.budget ?? { min: 200, max: 340, current: plainText(p.blurb).length };
    const bankProject = matchBankProject(p.name, bank);
    lines.push(
      `  SLOT ${p.id} — ${p.name} — ${fit?.lines ?? 2} line(s), budget ${budget.min}-${budget.max} chars total INCLUDING the ${plainText(p.prefix).length} chars of name and links (now ${budget.current}). Use ONLY the facts listed for bank project [${bankProject?.id ?? "?"}] — the project's name and links are fixed, so another project's content here would sit under the wrong title.`,
    );
    lines.push(`    current: ${p.blurb}`);
  }
  lines.push("");

  lines.push(
    "SKILLS SLOTS — reorder each list so the posting's own vocabulary reads first. Return ONLY the comma-separated values. Do NOT repeat the label: the résumé already prints \"Languages:\" and your text goes after it.",
  );
  for (const s of parsed.skills.filter((x) => !focus || focus.has(x.id))) {
    const chunk = parsed.skillChunks.find((c) => c.skillIds.includes(s.id));
    const fit = chunk ? fits.get(chunk.id) : undefined;
    const shares = chunk && chunk.skillIds.length > 1 ? ` — shares one line with ${chunk.skillIds.filter((i) => i !== s.id).join(", ")}` : "";
    const room = fit ? `, that whole line has ${fit.budget.max} chars of room and uses ${fit.budget.current}` : "";
    lines.push(`  SLOT ${s.id} — label is "${s.label}"${shares}${room}`);
    lines.push(`    current values: ${s.text}`);
  }

  return { text: lines.join("\n"), slots };
}

/** Match a parsed entry to a bank entry. Header field order varies, so try both. */
export function matchBankEntry(
  entry: { primary: string; secondary: string; dates: string },
  bank: Bank,
): BankEntry | null {
  const byDate = bank.experience.find((b) => norm(b.dates) === norm(entry.dates));
  if (byDate) return byDate;
  const fields = [entry.primary, entry.secondary].map(norm).filter(Boolean);
  return (
    bank.experience.find((b) => fields.some((f) => norm(b.company) === f)) ??
    bank.experience.find((b) => fields.some((f) => norm(b.company).includes(f) || f.includes(norm(b.company)))) ??
    null
  );
}

/** Slot → bank project, by name. Used to keep a blurb with its own project. */
export function matchBankProject(name: string, bank: Bank): BankProject | null {
  const n = norm(name);
  return (
    bank.projects.find((p) => norm(p.name) === n) ??
    bank.projects.find((p) => norm(p.name).startsWith(n.split(" ")[0])) ??
    null
  );
}

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function stripLabel(text: string, label?: string): string {
  if (!label) return text;
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/&/g, "(?:\\\\)?&");
  return text.replace(new RegExp(`^\\s*(?:\\\\textbf\\{)?${esc}:?\\}?\\s*:?\\s*`, "i"), "").trim();
}

export interface TailorInput {
  parsed: ParsedResume;
  fits: Map<string, Fit>;
  bank: Bank;
  jd: string;
  company: string;
  role: string;
  notes?: string;
  /** Slots that missed their budget last round, with what actually happened. */
  retry?: { slotId: string; text: string; problem: string }[];
}

/**
 * A retry is a narrow, mechanical fix to two or three bullets — not a fresh
 * read of the whole résumé. Sending the full slot list again would re-price the
 * entire job (thinking tokens are billed as output and dominate the cost), so
 * retries carry only the slots that missed and run at low effort.
 */

export async function tailor(input: TailorInput): Promise<TailorProposal> {
  const { parsed, fits, bank, jd, company, role, notes, retry } = input;
  const focus = retry?.length ? new Set(retry.map((r) => r.slotId)) : null;
  const { text: slotsText, slots } = slotsBlock(parsed, fits, bank, focus);
  const slotIds = new Set(slots.map((s) => s.id));
  const bankIds = new Set(bank.experience.flatMap((e) => e.bullets.map((b) => b.id)));

  // Stable prefix first (rules + bank), volatile content after the breakpoint,
  // so a second job description reuses the cache instead of repaying for it.
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: rules() },
    { type: "text", text: bankBlock(bank), cache_control: { type: "ephemeral" } },
  ];

  const userParts = [
    `TARGET ROLE: ${role || "(unspecified)"}${company ? ` at ${company}` : ""}`,
    "",
    "JOB DESCRIPTION",
    jd.trim() || "(none provided — tailor toward the role title alone)",
    "",
    notes?.trim() ? `WHAT RUTWIK WANTS EMPHASISED\n${notes.trim()}\n` : "",
    slotsText,
  ];

  if (retry?.length) {
    userParts.push(
      "",
      `FIX ONLY THESE ${retry.length} SLOT(S) AND RETURN ONLY THEM. Everything else in the résumé is already settled — do not re-send it. These lengths are measured from the real typeset page, not estimated, so trust them over your own count:`,
      ...retry.map((r) => `  ${r.slotId}: ${r.problem}\n    you wrote: ${r.text}`),
    );
  }

  // Streamed, not awaited as a single response. Adaptive thinking over sixteen
  // simultaneous character budgets is a genuinely long turn, and a non-streaming
  // request that runs past the SDK's ten-minute ceiling doesn't fail fast — it
  // times out and silently retries, so the caller waits three times as long for
  // an answer that was nearly ready. Streaming has no such ceiling.
  let msg: Anthropic.Message;
  try {
    const stream = client.messages.stream({
      model: TAILOR_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      // A retry is a length adjustment on a couple of bullets; the reasoning
      // budget that the first pass needs is pure waste here.
      output_config: { effort: retry?.length ? "low" : EFFORT },
      system,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "tailor_resume" },
      messages: [{ role: "user", content: userParts.join("\n") }],
    });
    msg = await stream.finalMessage();
  } catch (e) {
    throw new Error(friendlyLlmError(e));
  }

  const call = msg.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "tailor_resume",
  );
  if (!call) throw new Error("The model returned no tailored résumé. Try again.");

  const raw = call.input as {
    strategy?: string;
    bullets?: { slot_id: string; source_id: string; text: string; changed: boolean; rationale: string }[];
    projects?: { slot_id: string; source_id: string; blurb: string; rationale: string }[];
    skills?: { slot_id: string; text: string; rationale: string }[];
    keywords?: string[];
  };

  // Drop anything that doesn't name a real slot, and anything sourced from a
  // bullet that isn't in the bank — that is the "invent nothing" rule, enforced
  // rather than requested.
  const currentById = new Map(parsed.experience.flatMap((e) => e.items).map((i) => [i.id, i.text]));

  const bullets: ProposedBullet[] = (raw.bullets ?? [])
    .filter((b) => slotIds.has(b.slot_id))
    .filter((b) => bankIds.has(b.source_id) || !b.changed)
    .map((b) => {
      const text = sanitizeTex(b.text);
      const problem = validateFragment(text);
      // A fragment that would break the compile falls back to what is already
      // in the document. Losing one suggestion beats losing the whole run.
      const before = currentById.get(b.slot_id) ?? "";
      const final = problem ? before : text;
      return {
        id: b.slot_id,
        text: final,
        sourceId: b.source_id,
        rationale: problem ? `(kept the original — the suggestion was ${problem})` : b.rationale,
        // Computed, never taken from the model. It reports changed=false to mean
        // "I didn't reword this" — including when it has MOVED that bullet into
        // a different slot, which is the single highest-value edit this feature
        // makes. Trusting the flag silently threw every reorder away.
        changed: final !== before,
        before,
      };
    })
    .filter((b) => b.text);

  const projectIds = new Set(parsed.projects.map((p) => p.id));
  const skillIds = new Set(parsed.skills.map((s) => s.id));

  return {
    strategy: raw.strategy ?? "",
    bullets,
    projects: (raw.projects ?? [])
      .filter((p) => projectIds.has(p.slot_id))
      // A project's name and links are not rewritable, so a blurb sourced from a
      // different project would render as that project's text under this
      // project's title. Drop those outright.
      .filter((p) => {
        const slot = parsed.projects.find((x) => x.id === p.slot_id);
        const owner = slot ? matchBankProject(slot.name, bank) : null;
        return !owner || !p.source_id || p.source_id === owner.id;
      })
      .map((p) => ({
        id: p.slot_id,
        blurb: sanitizeTex(p.blurb),
        rationale: p.rationale,
        before: parsed.projects.find((x) => x.id === p.slot_id)?.blurb ?? "",
      }))
      .filter((p) => !validateFragment(p.blurb)),
    skills: (raw.skills ?? [])
      .filter((s) => skillIds.has(s.slot_id))
      .map((s) => {
        const slot = parsed.skills.find((x) => x.id === s.slot_id);
        return {
          id: s.slot_id,
          // The résumé prints the label itself. A returned "Languages: Python,
          // …" would render as "Languages: Languages: Python, …" and wrap the
          // line, so strip a repeated label rather than trusting the prompt.
          text: stripLabel(sanitizeTex(s.text), slot?.label),
          rationale: s.rationale,
          before: slot?.text ?? "",
        };
      })
      .filter((s) => !validateFragment(s.text)),
    keywords: raw.keywords ?? [],
    usage: {
      input: msg.usage.input_tokens,
      output: msg.usage.output_tokens,
      cacheRead: msg.usage.cache_read_input_tokens ?? 0,
      cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/** What a tailoring run cost, at Sonnet 5 list prices. */
export function costOf(u: TailorProposal["usage"]): number {
  const IN = 2 / 1_000_000;
  const OUT = 10 / 1_000_000;
  return u.input * IN + u.cacheWrite * IN * 1.25 + u.cacheRead * IN * 0.1 + u.output * OUT;
}
