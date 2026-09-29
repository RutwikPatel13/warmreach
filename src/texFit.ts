// ── Does it fit? Asked of TeX, not guessed ─────────────────────────────────
// Rutwik's two hard layout rules are the whole reason this feature exists:
//
//   1. a rewritten bullet must not spill onto another line (that's what turns
//      a one-page résumé into a two-page one), and
//   2. a two-line bullet must fill at least ~75% of its second line, or the
//      page looks gap-toothed.
//
// Both are questions about line breaking, and line breaking is TeX's job. So
// we build a throwaway document that re-enters the REAL environments (same
// preamble, same \begin{itemize} options, same \parfillskip — which differs
// inside a list and silently changes the answer), typesets each fragment into
// a \vbox of the true \linewidth, then pops the finished paragraph apart box
// by box to count lines and measure the last one.
//
// One compile measures every fragment at once (~0.4s), so the tailoring loop
// can check a model's proposed rewrites BEFORE touching the document, and
// re-ask only for the ones that miss.

import fs from "node:fs";
import path from "node:path";
import { compile } from "./latexEngine";
import { plainText, validateFragment, type ParsedResume } from "./texDoc";

export interface Measurable {
  id: string;
  /** Which environment to measure inside — geometry differs per section. */
  context: "list" | "plain";
  /** For `list`: the entry's own \begin{itemize}[...] line, replayed verbatim. */
  listDecl?: string;
  /** The LaTeX to measure. For projects this includes the un-editable prefix. */
  tex: string;
}

export interface Fit {
  id: string;
  lines: number;
  linewidthPt: number;
  /** Natural width of the last line as a fraction of the full line width. */
  lastFill: number;
  /** Total natural width / (lines × linewidth). Over 1.0 means TeX had to squeeze. */
  tightness: number;
  /** Characters of visible text this fragment can hold, at its measured density. */
  budget: { min: number; max: number; current: number };
  status: "ok" | "tight" | "overflow" | "loose" | "short";
}

const PROBE_MARK = "RFIT";

// Aim a rewrite at 92-99% of the available width: under 100% so ordinary
// variation in the model's output doesn't tip it onto a new line, and not so
// far under that we waste the line.
const MAX_USE = 0.99;
const MIN_LAST_FILL = 0.75; // rule 2, as stated
const SHORT_SINGLE_LINE = 0.55; // a lone line this empty is wasting the slot

// Natural width can exceed the line width without anything spilling: TeX
// shrinks interword space first, and a typical line has ~3% of give. So a
// measured tightness just over 1.0 means "packed, no room to add a word",
// NOT "broken" — calling that an overflow would condemn bullets that render
// perfectly well today. Past the shrink budget, the line genuinely runs into
// the margin and TeX says so in the log.
const TIGHT_FROM = 0.995;
const OVERFLOW_FROM = 1.03;

function macros(): string {
  return String.raw`
\newcount\rfitlines \newdimen\rfitlast \newdimen\rfitnat
\newbox\rfa \newbox\rfb \newbox\rfc \newbox\rflast
% Typeset #2 at the live \linewidth, then dismantle it: \lastbox pops the
% finished lines off the vertical list one at a time (newest first), which is
% the only way to learn how many there were and how full the last one is.
% \unhbox + \unskip re-measures a line at its NATURAL width, so a line TeX had
% to shrink reports wider than \linewidth — that is the overflow signal.
\def\rfitprobe#1#2{%
  \begingroup
  \global\rfitlines=0 \global\rfitnat=0pt
  \setbox\rfa=\vbox{\hsize=\linewidth \parindent=0pt \noindent #2\par}%
  \setbox\rfb=\vbox{\unvbox\rfa
    \loop \setbox\rfc=\lastbox
      \ifhbox\rfc
        \global\advance\rfitlines by 1
        \setbox\rflast=\hbox{\unhcopy\rfc \unskip\unskip\unskip}%
        \global\advance\rfitnat by \wd\rflast
        \ifnum\rfitlines=1 \global\rfitlast=\wd\rflast \fi
        \unskip\unpenalty
    \repeat}%
  \typeout{` + PROBE_MARK + String.raw`|#1|\the\rfitlines|\the\rfitlast|\the\rfitnat|\the\linewidth}%
  \endgroup}
`;
}

/** Split a .tex into everything before \begin{document} and the font line after it. */
function preambleOf(tex: string): { preamble: string; fontLine: string } {
  const i = tex.indexOf("\\begin{document}");
  if (i === -1) return { preamble: tex, fontLine: "" };
  const preamble = tex.slice(0, i);
  const after = tex.slice(i + "\\begin{document}".length);
  const fm = /^\s*(\\fontsize\{[^}]*\}\{[^}]*\}\\selectfont)/.exec(after);
  return { preamble, fontLine: fm ? fm[1] : "" };
}

function buildProbeDoc(baseTex: string, items: Measurable[]): string {
  const { preamble, fontLine } = preambleOf(baseTex);
  const out: string[] = [preamble, macros(), "\\begin{document}", fontLine];

  const lists = items.filter((i) => i.context === "list");
  const plains = items.filter((i) => i.context === "plain");

  // Group list probes by their \begin{itemize} declaration: two entries with
  // different leftmargins have different line widths, and mixing them would
  // measure some bullets against the wrong width.
  const byDecl = new Map<string, Measurable[]>();
  for (const it of lists) {
    const decl = it.listDecl || "\\begin{itemize}";
    if (!byDecl.has(decl)) byDecl.set(decl, []);
    byDecl.get(decl)!.push(it);
  }

  if (byDecl.size) {
    out.push("\\begin{rSection}{Experience}");
    for (const [decl, group] of byDecl) {
      out.push(decl, "\\item[]");
      for (const it of group) out.push(`\\rfitprobe{${it.id}}{${it.tex}}`);
      out.push("\\end{itemize}");
    }
    out.push("\\end{rSection}");
  }

  if (plains.length) {
    out.push("\\begin{rSection}{Academic Projects}");
    for (const it of plains) out.push(`\\rfitprobe{${it.id}}{${it.tex}}`);
    out.push("\\end{rSection}");
  }

  out.push("\\end{document}");
  return out.join("\n");
}

function fitFrom(src: Measurable, lines: number, lastPt: number, naturalPt: number, width: number): Fit | null {
  if (!lines || !width) return null;

  const lastFill = lastPt / width;
  const visible = plainText(src.tex).length;
  const charsPerPt = naturalPt > 0 ? visible / naturalPt : 0;
  const tightness = naturalPt / (lines * width);

  // Budget for a rewrite that keeps the same number of lines and obeys rule 2.
  const maxPt = lines * width * MAX_USE;
  const minPt = lines === 1 ? width * SHORT_SINGLE_LINE : (lines - 1 + MIN_LAST_FILL) * width;

  let status: Fit["status"] = "ok";
  if (tightness > OVERFLOW_FROM) status = "overflow";
  else if (lines > 1 && lastFill < MIN_LAST_FILL) status = "loose";
  else if (lines === 1 && lastFill < SHORT_SINGLE_LINE) status = "short";
  else if (tightness > TIGHT_FROM) status = "tight";

  return {
    id: src.id,
    lines,
    linewidthPt: width,
    lastFill: Math.min(lastFill, 1),
    tightness,
    budget: { min: Math.round(minPt * charsPerPt), max: Math.round(maxPt * charsPerPt), current: visible },
    status,
  };
}

function pt(s: string): number {
  return Number(s.replace(/pt$/, "")) || 0;
}

/**
 * Measure every fragment in one compile. `dir` needs resume.cls in it.
 * Fragments that fail to typeset are simply absent from the result — callers
 * treat a missing measurement as "unknown", never as "fits".
 */
export async function measure(
  dir: string,
  baseTex: string,
  items: Measurable[],
): Promise<{ fits: Map<string, Fit>; log: string; ok: boolean }> {
  const fits = new Map<string, Fit>();
  if (!items.length) return { fits, log: "", ok: true };

  const probeDir = path.join(dir, ".fit");
  fs.mkdirSync(probeDir, { recursive: true });
  const cls = path.join(dir, "resume.cls");
  if (fs.existsSync(cls)) fs.copyFileSync(cls, path.join(probeDir, "resume.cls"));

  // One compile measures everything, which is fast but all-or-nothing: a
  // fragment TeX chokes on aborts the run and every later fragment goes
  // unmeasured. Screening first removes the realistic causes; anything that
  // still breaks gets isolated by the retry pass below.
  const safe = items.filter((i) => !validateFragment(i.tex));
  const result = await compile(probeDir, buildProbeDoc(baseTex, safe), "fit");
  const byId = new Map(items.map((i) => [i.id, i]));

  for (const m of result.log.matchAll(
    new RegExp(`^${PROBE_MARK}\\|([^|]*)\\|(\\d+)\\|([-\\d.]+pt)\\|([-\\d.]+pt)\\|([-\\d.]+pt)$`, "gm"),
  )) {
    const [, id, linesRaw, lastRaw, natRaw, widthRaw] = m;
    const src = byId.get(id);
    if (!src) continue;

    const fit = fitFrom(src, Number(linesRaw), pt(lastRaw), pt(natRaw), pt(widthRaw));
    if (fit) fits.set(id, fit);
  }

  // If the batch died partway, measure the stragglers one at a time so a single
  // poisonous fragment costs one measurement instead of all of them.
  const missing = safe.filter((i) => !fits.has(i.id));
  if (missing.length && missing.length < safe.length) {
    for (const item of missing.slice(0, ISOLATE_LIMIT)) {
      const one = await measureOne(probeDir, baseTex, item);
      if (one) fits.set(item.id, one);
    }
  }

  return { fits, log: result.log, ok: result.ok };
}

const ISOLATE_LIMIT = 12;

async function measureOne(probeDir: string, baseTex: string, item: Measurable): Promise<Fit | null> {
  const r = await compile(probeDir, buildProbeDoc(baseTex, [item]), "fit1");
  const m = new RegExp(`^${PROBE_MARK}\\|([^|]*)\\|(\\d+)\\|([-\\d.]+pt)\\|([-\\d.]+pt)\\|([-\\d.]+pt)$`, "m").exec(
    r.log,
  );
  if (!m) return null;
  return fitFrom(item, Number(m[2]), pt(m[3]), pt(m[4]), pt(m[5]));
}

/** Every rewritable fragment of a parsed résumé, in the context it lives in. */
export function measurablesFor(parsed: ParsedResume): Measurable[] {
  const out: Measurable[] = [];
  for (const entry of parsed.experience) {
    for (const item of entry.items) {
      out.push({ id: item.id, context: "list", listDecl: entry.listDecl, tex: item.text });
    }
  }
  for (const p of parsed.projects) {
    // Measured WITH the name and links: they sit on line 1 and eat into it.
    out.push({ id: p.id, context: "plain", tex: p.prefix + p.blurb });
  }
  for (const c of parsed.skillChunks) {
    out.push({ id: c.id, context: "plain", tex: skillChunkTex(c.tex) });
  }
  return out;
}

/**
 * A skills chunk as a measurable fragment. Leading \vspace is vertical
 * material and would derail the probe's \vbox, so it comes off — it affects
 * the space above the line, never the line's width.
 */
export function skillChunkTex(tex: string): string {
  return tex.replace(/^\s*(?:\\vspace\*?\{[^}]*\}\s*)*/, "").replace(/\s+/g, " ").trim();
}
