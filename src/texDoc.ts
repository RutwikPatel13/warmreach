// ── Reading the résumé as structure, without giving up the source ───────────
// The .tex file stays the source of truth. It is what renders, what Overleaf
// round-trips, and what carries every hand-tuned \vspace that makes the page
// fit — so tailoring must never "regenerate" it from a model of the résumé.
// Instead we locate each bullet by character offset and splice replacements in.
// Everything not addressed by an edit comes through byte-identical.
//
// Consequence worth stating: ids here are positional and only valid for the
// parse that produced them. Re-parse after applying edits; never persist an id.

export interface TexItem {
  id: string;
  /** Offsets of the item's CONTENT — after "\item ", excluding trailing newline. */
  start: number;
  end: number;
  text: string;
  line: number; // 1-based source line, for matching TeX log warnings
}

/**
 * Visible text of a LaTeX fragment — what a reader (or a résumé parser) sees.
 * Used for character budgets, keyword matching, and the ATS checks, none of
 * which should count markup. Deliberately small: this handles the commands
 * this résumé actually uses, not LaTeX in general.
 */
export function plainText(tex: string): string {
  return tex
    .replace(/\\href\{[^}]*\}\{([\s\S]*?)\}/g, "$1")
    .replace(/\\text(bf|it|rm|sf|tt)\{([\s\S]*?)\}/g, "$2")
    .replace(/\\textcolor\{[^}]*\}\{([\s\S]*?)\}/g, "$1")
    .replace(/\\emph\{([\s\S]*?)\}/g, "$1")
    .replace(/\$\\vert\$/g, "|")
    .replace(/\\&/g, "&")
    .replace(/\\%/g, "%")
    .replace(/\\_/g, "_")
    .replace(/\\#/g, "#")
    .replace(/\\\$/g, "$")
    .replace(/\\[a-zA-Z]+\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TexEntry {
  id: string;
  /** Raw header text above the bullet list, e.g. "\textbf{Sigma Computing} ...". */
  heading: string;
  /**
   * The two header fields, NOT labelled company/role — this résumé uses both
   * orders (USC puts the school in \textbf, Sigma puts the job title there),
   * so calling either one "company" would be wrong half the time. Matching to
   * the bullet bank searches both fields instead of trusting a position.
   */
  primary: string;
  secondary: string;
  dates: string;
  items: TexItem[];
  /** The entry's own `\begin{itemize}[...]`, replayed verbatim when measuring. */
  listDecl: string;
  /** Span covering the whole itemize body, used when reordering bullets. */
  itemsStart: number;
  itemsEnd: number;
}

export interface TexProject {
  id: string;
  name: string;
  /** The prose after the links — the part tailoring may rewrite. */
  start: number;
  end: number;
  blurb: string;
  /** "\textbf{Name} (links) $\vert$ " — not editable, but it occupies line 1. */
  prefix: string;
  line: number;
}

export interface TexSkillLine {
  id: string;
  label: string; // "Languages", "Databases", ...
  start: number;
  end: number;
  text: string; // the value list, without the trailing \\
  line: number;
}

/**
 * One physical line of the skills block. Two labels often share a line
 * ("Languages: … $\vert$ Databases: …"), so the unit that has to fit on one
 * line is the chunk, not the individual skill value — measuring the values
 * separately would miss a wrap and quietly add a line to the page.
 */
export interface TexSkillChunk {
  id: string;
  start: number;
  end: number;
  tex: string;
  skillIds: string[];
  line: number;
}

export interface ParsedResume {
  experience: TexEntry[];
  projects: TexProject[];
  skills: TexSkillLine[];
  skillChunks: TexSkillChunk[];
}

export interface TexEdit {
  start: number;
  end: number;
  replacement: string;
}

function lineAt(tex: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < tex.length; i++) if (tex[i] === "\n") line++;
  return line;
}

/** Body span of `\begin{rSection}{name}` … `\end{rSection}`, case-insensitive. */
function sectionBody(tex: string, name: RegExp): { start: number; end: number } | null {
  const re = /\\begin\{rSection\}\{([^}]*)\}/g;
  for (const m of tex.matchAll(re)) {
    if (!name.test(m[1])) continue;
    const start = m.index! + m[0].length;
    const end = tex.indexOf("\\end{rSection}", start);
    if (end === -1) continue;
    return { start, end };
  }
  return null;
}

// A bullet runs from "\item" to the next "\item" or the end of the list. Taking
// the span rather than the line lets a hand-wrapped bullet parse correctly.
function parseItems(tex: string, bodyStart: number, bodyEnd: number, idPrefix: string): TexItem[] {
  const items: TexItem[] = [];
  const re = /\\item\s+/g;
  re.lastIndex = bodyStart;
  const bounds: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(tex)) !== null) {
    if (m.index >= bodyEnd) break;
    bounds.push(m.index + m[0].length);
  }
  for (let i = 0; i < bounds.length; i++) {
    const start = bounds[i];
    const nextItem = i + 1 < bounds.length ? tex.lastIndexOf("\\item", bounds[i + 1]) : bodyEnd;
    let end = Math.min(nextItem, bodyEnd);
    while (end > start && /\s/.test(tex[end - 1])) end--; // drop trailing whitespace
    items.push({
      id: `${idPrefix}:${i}`,
      start,
      end,
      text: tex.slice(start, end),
      line: lineAt(tex, start),
    });
  }
  return items;
}

export function parseResume(tex: string): ParsedResume {
  const experience: TexEntry[] = [];
  const projects: TexProject[] = [];
  const skills: TexSkillLine[] = [];
  const skillChunks: TexSkillChunk[] = [];

  // ── Experience ────────────────────────────────────────────────────────────
  // Each entry is a header blob followed by one itemize. Anchoring on the
  // itemize (rather than on \textbf) is what makes the two-stint USC block
  // parse correctly: its second entry has only an \textit role line.
  const exp = sectionBody(tex, /experience/i);
  if (exp) {
    const listRe = /\\begin\{itemize\}[^\n]*\n/g;
    listRe.lastIndex = exp.start;
    let m: RegExpExecArray | null;
    let headerFrom = exp.start;
    let idx = 0;
    while ((m = listRe.exec(tex)) !== null) {
      if (m.index >= exp.end) break;
      const bodyStart = m.index + m[0].length;
      const bodyEnd = tex.indexOf("\\end{itemize}", bodyStart);
      if (bodyEnd === -1 || bodyEnd > exp.end) break;

      const heading = tex.slice(headerFrom, m.index).trim();
      const id = `exp:${idx}`;
      const items = parseItems(tex, bodyStart, bodyEnd, id);

      experience.push({
        id,
        heading,
        primary: pick(heading, /\\textbf\{([^}]*)\}/),
        secondary: pick(heading, /\\textit\{([^}]*)\}/),
        dates: pick(heading, /\\hfill\s*([A-Z][a-z]+ \d{4}\s*-\s*[A-Z][a-z]+ \d{4})/),
        items,
        listDecl: m[0].trim(),
        itemsStart: items.length ? tex.lastIndexOf("\\item", items[0].start) : bodyStart,
        itemsEnd: items.length ? items[items.length - 1].end : bodyStart,
      });

      headerFrom = bodyEnd + "\\end{itemize}".length;
      listRe.lastIndex = headerFrom;
      idx++;
    }
  }

  // ── Projects ──────────────────────────────────────────────────────────────
  // Paragraph form, by design: "\textbf{Name} (links) $\vert$ prose". Only the
  // prose after the $\vert$ is rewritable — name and links are never touched.
  const proj = sectionBody(tex, /project/i);
  if (proj) {
    const body = tex.slice(proj.start, proj.end);
    const re = /\\textbf\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}([^\n]*?)\$\\vert\$\s*/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(body)) !== null) {
      const start = proj.start + m.index + m[0].length;
      // The blurb ends at the blank line before the next \vspace or \textbf.
      const rest = tex.slice(start, proj.end);
      const stop = rest.search(/\n\s*\n|\n\s*\\vspace|\n\s*\\textbf/);
      let end = stop === -1 ? proj.end : start + stop;
      while (end > start && /\s/.test(tex[end - 1])) end--;
      projects.push({
        id: `proj:${idx}`,
        name: m[1].replace(/\\[a-zA-Z]+/g, "").trim(),
        start,
        end,
        blurb: tex.slice(start, end),
        prefix: m[0],
        line: lineAt(tex, start),
      });
      idx++;
    }
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  // Parsed twice over: once into `\\`-delimited chunks (what must fit on a
  // line) and once into individual label/value pairs (what may be rewritten).
  const sk = sectionBody(tex, /skill/i);
  if (sk) {
    let idx = 0;
    let cursor = sk.start;
    let chunkIdx = 0;

    while (cursor < sk.end) {
      const rest = tex.slice(cursor, sk.end);
      const brk = rest.indexOf("\\\\");
      const chunkEnd = brk === -1 ? sk.end : cursor + brk;
      const chunkTex = tex.slice(cursor, chunkEnd);

      if (/\\textbf\{[^}]*:\}/.test(chunkTex)) {
        const skillIds: string[] = [];
        const re = /\\textbf\{([^}]*):\}\s*/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(chunkTex)) !== null) {
          const start = cursor + m.index + m[0].length;
          const after = tex.slice(start, chunkEnd);
          // A value ends at the next label or at the chunk's own end.
          const stop = after.search(/\$\\vert\$|\\textbf\{[^}]*:\}/);
          let end = stop === -1 ? chunkEnd : start + stop;
          while (end > start && /\s/.test(tex[end - 1])) end--;
          const id = `skill:${idx++}`;
          skillIds.push(id);
          skills.push({
            id,
            label: m[1].replace(/\\&/g, "&").trim(),
            start,
            end,
            text: tex.slice(start, end),
            line: lineAt(tex, start),
          });
        }
        let trimmedStart = cursor;
        while (trimmedStart < chunkEnd && /\s/.test(tex[trimmedStart])) trimmedStart++;
        skillChunks.push({
          id: `skillline:${chunkIdx++}`,
          start: trimmedStart,
          end: chunkEnd,
          tex: tex.slice(trimmedStart, chunkEnd),
          skillIds,
          line: lineAt(tex, trimmedStart),
        });
      }

      cursor = brk === -1 ? sk.end : chunkEnd + 2;
    }
  }

  return { experience, projects, skills, skillChunks };
}

function pick(s: string, re: RegExp): string {
  const m = re.exec(s);
  return m ? m[1].trim() : "";
}

/**
 * Apply edits to the source. Applied back-to-front so earlier offsets stay
 * valid, and overlapping edits are rejected outright rather than silently
 * producing a corrupted document.
 */
export function applyEdits(tex: string, edits: TexEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].start < sorted[i + 1].end) {
      throw new Error("Overlapping edits — refusing to write a corrupted .tex");
    }
  }
  let out = tex;
  for (const e of sorted) {
    if (e.start < 0 || e.end > out.length || e.start > e.end) {
      throw new Error("Edit outside the document");
    }
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

/**
 * Rewrite one entry's bullet list in a new order, reusing the exact separator
 * text already between the bullets so the file's own indentation survives.
 */
export function reorderEdit(tex: string, entry: TexEntry, orderedIds: string[]): TexEdit | null {
  if (!entry.items.length) return null;
  const byId = new Map(entry.items.map((i) => [i.id, i]));
  const ordered = orderedIds.map((id) => byId.get(id)).filter((i): i is TexItem => !!i);
  if (ordered.length !== entry.items.length) return null;
  if (ordered.every((it, i) => it.id === entry.items[i].id)) return null; // unchanged

  const indent = detectIndent(tex, entry.items[0].start);
  const body = ordered.map((it) => `${indent}\\item ${it.text}`).join("\n");
  const start = tex.lastIndexOf("\\item", entry.items[0].start);
  return { start, end: entry.itemsEnd, replacement: body.slice(indent.length) };
}

function detectIndent(tex: string, itemStart: number): string {
  const itemTok = tex.lastIndexOf("\\item", itemStart);
  const lineStart = tex.lastIndexOf("\n", itemTok) + 1;
  return tex.slice(lineStart, itemTok);
}

// ── Never let unvalidated text reach the engine ────────────────────────────
// A model asked for LaTeX will occasionally hand back a bare % or & — and a
// single one of those doesn't just break its own bullet, it derails the whole
// compile (% comments out the rest of the line; & is an alignment tab). Since
// one bad fragment would otherwise take down a 20-fragment measurement run,
// everything coming from the model goes through here first.

const NEEDS_ESCAPE: [RegExp, string][] = [
  [/(^|[^\\])%/g, "$1\\%"],
  [/(^|[^\\])&/g, "$1\\&"],
  [/(^|[^\\])#/g, "$1\\#"],
  [/(^|[^\\])_/g, "$1\\_"],
];

/** Escape the specials that are almost never intentional in a bullet. */
export function sanitizeTex(s: string): string {
  let out = s.replace(/[\r\n]+/g, " ").trim();
  for (const [re, sub] of NEEDS_ESCAPE) {
    // Twice: the regex consumes the preceding character, so back-to-back
    // specials ("R&D & ops") need a second pass to catch the ones it skipped.
    out = out.replace(re, sub).replace(re, sub);
  }
  return out;
}

/** Null when the fragment is safe to typeset; otherwise why it isn't. */
export function validateFragment(s: string): string | null {
  if (!s.trim()) return "empty";
  if (/\\item\b/.test(s)) return "contains \\item";
  if (/\\\\/.test(s)) return "contains a line break (\\\\)";
  if (/\\(begin|end|documentclass|usepackage|newcommand|def)\b/.test(s)) return "contains a structural command";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth < 0) return "unbalanced braces";
  }
  if (depth !== 0) return "unbalanced braces";
  const dollars = (s.match(/(^|[^\\])\$/g) || []).length;
  if (dollars % 2 !== 0) return "unbalanced $";
  return null;
}
