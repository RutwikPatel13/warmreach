// ── Compile, measure, audit — and the loop that makes tailoring trustworthy ─
// The model is asked to hit a character budget. Sometimes it misses. Rather
// than hoping, every proposed bullet is typeset by the real engine before it is
// allowed near the document; the ones that miss go back with the measured
// reason ("came out 3 lines, needs 2"), and only those. One extra compile is
// ~0.4s and the retry only re-prices the slots that failed, which is far
// cheaper than a human noticing a two-page PDF later.

import { parseResume, applyEdits, plainText, type ParsedResume, type TexEdit } from "./texDoc";
import { measure, measurablesFor, skillChunkTex, type Fit, type Measurable } from "./texFit";
import { compile, extractText, type TexProblem } from "./latexEngine";
import { auditResume, type AtsReport } from "./resumeAts";
import { tailor, costOf, type Bank, type TailorProposal } from "./resumeTailor";

export interface RenderReport {
  ok: boolean;
  pages: number | null;
  ms: number;
  problems: TexProblem[];
  fits: Record<string, Fit>;
  ats: AtsReport;
  parsed: ParsedResume;
}

/** Compile the document, measure every fragment, and run the ATS checks. */
export async function renderAndAudit(
  dir: string,
  tex: string,
  opts: { jd?: string; keywords?: string[] } = {},
): Promise<RenderReport> {
  const parsed = parseResume(tex);
  const [result, measured] = await Promise.all([
    compile(dir, tex, "main"),
    measure(dir, tex, measurablesFor(parsed)),
  ]);

  const extracted = result.pdfPath ? await extractText(result.pdfPath) : null;
  const ats = auditResume({
    tex,
    extracted,
    pages: result.pages,
    jd: opts.jd,
    extraKeywords: opts.keywords,
  });

  return {
    ok: result.ok,
    pages: result.pages,
    ms: result.ms,
    problems: result.problems,
    fits: Object.fromEntries(measured.fits),
    ats,
    parsed,
  };
}

/** Turn an accepted proposal into character-offset edits against the source. */
export function editsFor(
  parsed: ParsedResume,
  proposal: Pick<TailorProposal, "bullets" | "projects" | "skills">,
  accepted: Set<string>,
): TexEdit[] {
  const edits: TexEdit[] = [];

  // Slot ids are positional. If the source changed since the suggestion was
  // made — a hand edit, a bullet added — the id can now point somewhere else,
  // and splicing on it would overwrite the wrong line. So each suggestion
  // carries the text it was based on, and anything that no longer matches is
  // skipped rather than applied to whatever happens to be there now.
  const stale = (currentText: string, before: string | undefined): boolean =>
    before !== undefined && before !== "" && currentText !== before;

  const items = new Map(parsed.experience.flatMap((e) => e.items).map((i) => [i.id, i]));
  for (const b of proposal.bullets) {
    if (!accepted.has(b.id)) continue;
    const item = items.get(b.id);
    if (!item || !b.text || item.text === b.text) continue;
    if (stale(item.text, b.before)) continue;
    edits.push({ start: item.start, end: item.end, replacement: b.text });
  }
  const projects = new Map(parsed.projects.map((p) => [p.id, p]));
  for (const p of proposal.projects) {
    if (!accepted.has(p.id)) continue;
    const target = projects.get(p.id);
    if (!target || !p.blurb || target.blurb === p.blurb) continue;
    if (stale(target.blurb, p.before)) continue;
    edits.push({ start: target.start, end: target.end, replacement: p.blurb });
  }
  const skills = new Map(parsed.skills.map((s) => [s.id, s]));
  for (const s of proposal.skills) {
    if (!accepted.has(s.id)) continue;
    const target = skills.get(s.id);
    if (!target || !s.text || target.text === s.text) continue;
    if (stale(target.text, s.before)) continue;
    edits.push({ start: target.start, end: target.end, replacement: s.text });
  }
  return edits;
}

/** Measure what the proposed text would actually do on the page. */
export async function measureProposal(
  dir: string,
  tex: string,
  parsed: ParsedResume,
  proposal: Pick<TailorProposal, "bullets" | "projects" | "skills">,
): Promise<Map<string, Fit>> {
  const entryOf = new Map<string, string>();
  for (const e of parsed.experience) for (const i of e.items) entryOf.set(i.id, e.listDecl);
  const projects = new Map(parsed.projects.map((p) => [p.id, p]));

  const items: Measurable[] = [];
  for (const b of proposal.bullets) {
    const decl = entryOf.get(b.id);
    if (!decl || !b.text) continue;
    items.push({ id: b.id, context: "list", listDecl: decl, tex: b.text });
  }
  for (const p of proposal.projects) {
    const target = projects.get(p.id);
    if (!target || !p.blurb) continue;
    items.push({ id: p.id, context: "plain", tex: target.prefix + p.blurb });
  }

  // Skills are measured as whole physical lines with the proposed values spliced
  // in. Measuring a value on its own would miss the case that actually bit us:
  // two labels share a line, and a longer list wraps it onto a second one.
  const proposedSkill = new Map((proposal.skills ?? []).map((s) => [s.id, s.text]));
  for (const chunk of parsed.skillChunks) {
    if (!chunk.skillIds.some((id) => proposedSkill.has(id))) continue;
    const edits = parsed.skills
      .filter((s) => chunk.skillIds.includes(s.id) && proposedSkill.has(s.id))
      .map((s) => ({ start: s.start - chunk.start, end: s.end - chunk.start, replacement: proposedSkill.get(s.id)! }));
    let next = chunk.tex;
    for (const e of [...edits].sort((a, b) => b.start - a.start)) {
      next = next.slice(0, e.start) + e.replacement + next.slice(e.end);
    }
    items.push({ id: chunk.id, context: "plain", tex: skillChunkTex(next) });
  }

  if (!items.length) return new Map();
  const { fits } = await measure(dir, tex, items);
  return fits;
}

// Two passes, then fall back. A third round almost never converts a miss, and
// it costs another model call to find that out — the revert below is a better
// answer than a third try anyway.
const MAX_ROUNDS = 2;

export interface TailorRun {
  proposal: TailorProposal;
  fits: Record<string, Fit>;
  rounds: number;
  stillMissing: string[];
  /** Slots whose rewrite never fit and were put back to the original text. */
  reverted: string[];
  costUsd: number;
}

/**
 * Tailor, then verify against the typeset page, then re-ask for the misses.
 * Slots that still miss after the last round are returned marked rather than
 * quietly applied — a bullet that doesn't fit is the one thing the user asked
 * this feature never to produce.
 */
export async function tailorWithFit(args: {
  dir: string;
  tex: string;
  parsed: ParsedResume;
  fits: Map<string, Fit>;
  bank: Bank;
  jd: string;
  company: string;
  role: string;
  notes?: string;
}): Promise<TailorRun> {
  const { dir, tex, parsed, fits, bank } = args;

  let proposal = await tailor({ parsed, fits, bank, jd: args.jd, company: args.company, role: args.role, notes: args.notes });
  let cost = costOf(proposal.usage);
  let measured = await measureProposal(dir, tex, parsed, proposal);
  let rounds = 1;

  const targetLines = new Map<string, number>();
  for (const [id, f] of fits) targetLines.set(id, f.lines);

  while (rounds < MAX_ROUNDS) {
    const misses = findMisses(proposal, measured, targetLines, parsed);
    if (!misses.length) break;

    const next = await tailor({
      parsed,
      fits,
      bank,
      jd: args.jd,
      company: args.company,
      role: args.role,
      notes: args.notes,
      retry: misses,
    });
    cost += costOf(next.usage);
    rounds++;

    // Keep what already fit and take the retry ONLY for the slots that missed.
    // Written field by field on purpose: a retry is narrowed to the failing
    // slots, so it comes back with no skills and no keywords. Spreading it over
    // the proposal would silently throw away round one's skills rewrite.
    const missIds = new Set(misses.map((m) => m.slotId));
    proposal = {
      strategy: proposal.strategy || next.strategy,
      bullets: proposal.bullets.map((b) => (missIds.has(b.id) ? next.bullets.find((n) => n.id === b.id) ?? b : b)),
      projects: proposal.projects.map((p) => (missIds.has(p.id) ? next.projects.find((n) => n.id === p.id) ?? p : p)),
      skills: proposal.skills,
      keywords: proposal.keywords.length ? proposal.keywords : next.keywords,
      usage: next.usage,
    };
    measured = await measureProposal(dir, tex, parsed, proposal);
  }

  // Anything still missing goes back to what was already there. The original
  // bullet fits by definition — it is what we measured the budget from — so
  // reverting is always safe, and it is a better outcome than handing the user
  // a suggestion that would push the résumé onto a second page. The caller is
  // told which ones, because silently dropping a change would be worse still.
  const unfixed = findMisses(proposal, measured, targetLines, parsed);
  const reverted: string[] = [];
  if (unfixed.length) {
    const originals = new Map<string, string>();
    for (const e of parsed.experience) for (const i of e.items) originals.set(i.id, i.text);
    for (const p of parsed.projects) originals.set(p.id, p.blurb);
    for (const s of parsed.skills) originals.set(s.id, s.text);

    for (const miss of unfixed) {
      const original = originals.get(miss.slotId);
      if (original === undefined) continue;
      reverted.push(miss.slotId);
      const note = "(kept your original — the rewrite wouldn't fit the line)";
      proposal.bullets = proposal.bullets.map((b) =>
        b.id === miss.slotId ? { ...b, text: original, changed: false, rationale: note } : b,
      );
      proposal.projects = proposal.projects.filter((p) => p.id !== miss.slotId);
      proposal.skills = proposal.skills.filter((s) => s.id !== miss.slotId);
    }
    measured = await measureProposal(dir, tex, parsed, proposal);
  }

  return {
    proposal,
    fits: Object.fromEntries(measured),
    rounds,
    stillMissing: findMisses(proposal, measured, targetLines, parsed).map((m) => m.slotId),
    reverted,
    costUsd: cost,
  };
}

function findMisses(
  proposal: Pick<TailorProposal, "bullets" | "projects" | "skills">,
  measured: Map<string, Fit>,
  targetLines: Map<string, number>,
  parsed: ParsedResume,
): { slotId: string; text: string; problem: string }[] {
  const out: { slotId: string; text: string; problem: string }[] = [];
  const candidates: { id: string; text: string }[] = [
    ...proposal.bullets.map((b) => ({ id: b.id, text: b.text })),
    ...proposal.projects.map((p) => ({ id: p.id, text: p.blurb })),
  ];

  // Skills chunks have no per-slot target, they simply have to stay on one line.
  for (const [id, fit] of measured) {
    if (!id.startsWith("skillline:") || fit.lines <= 1) continue;
    const chunk = parsed.skillChunks.find((c) => c.id === id);
    const trim = Math.max(6, Math.round(fit.budget.current - fit.budget.max));
    // Report it against the skill slots that are actually editable — the chunk
    // id names a physical line, and nothing can be written back to that.
    for (const skillId of chunk?.skillIds ?? []) {
      out.push({
        slotId: skillId,
        text: proposal.skills?.find((s) => s.id === skillId)?.text ?? "",
        problem: `this skills line now wraps onto ${fit.lines} lines, which lengthens the page. Between the labels sharing that line, cut about ${trim} characters.`,
      });
    }
  }

  // A bullet that came out SHORTER than its slot is not a miss: the page only
  // gets shorter, which breaks nothing. Chasing it would burn a paid round to
  // fix something the user never asked us to prevent. Only growth and gaps are
  // real failures.
  for (const c of candidates) {
    const fit = measured.get(c.id);
    if (!fit) continue;
    const target = targetLines.get(c.id);
    const chars = plainText(c.text).length;

    if (target && fit.lines > target) {
      out.push({
        slotId: c.id,
        text: c.text,
        problem: `came out ${fit.lines} lines but the slot holds ${target}. Cut about ${Math.max(
          8,
          Math.round(chars - fit.budget.max),
        )} characters.`,
      });
    } else if (fit.status === "overflow") {
      out.push({ slotId: c.id, text: c.text, problem: `runs past the margin. Cut about 10 characters.` });
    } else if (fit.status === "loose") {
      out.push({
        slotId: c.id,
        text: c.text,
        problem: `last line is only ${Math.round(fit.lastFill * 100)}% full (needs 75%+). Add about ${Math.max(
          8,
          Math.round(fit.budget.min - chars),
        )} characters.`,
      });
    }
  }
  return out;
}
