// ── ATS checks that test the artifact, not the intention ───────────────────
// Most "ATS checkers" grade the source. That misses the failure mode that
// actually costs LaTeX users interviews: the PDF looks perfect and extracts
// wrong. The classic is the fi/fl ligature — "workflow" renders beautifully
// and copies out as "work ow", so the keyword the filter wanted is simply not
// there. The only way to catch it is to pull the text back out of the finished
// PDF and compare, which is what checkExtraction does.
//
// Sources for the rule set (2026 guidance): parsers read single-column, top to
// bottom; they match section headings against a built-in dictionary; contact
// details in a header/footer are often dropped; images contribute nothing;
// exact keyword matching still beats semantic matching for coverage.

import { plainText } from "./texDoc";

export interface AtsFinding {
  id: string;
  level: "pass" | "warn" | "fail";
  title: string;
  detail: string;
  /** Names a one-click repair the editor can apply to the .tex. */
  fixable?: "ligatures";
}

export interface KeywordHit {
  term: string;
  inResume: boolean;
  /** How often the JD mentions it — a proxy for how much the filter cares. */
  jdCount: number;
}

export interface AtsReport {
  score: number; // 0-100, and every point is explained by a finding
  findings: AtsFinding[];
  keywords: KeywordHit[];
  extractedOk: boolean | null; // null = poppler missing, test not run
}

// Section headings ATS parsers match against. Anything else risks the content
// being filed under nothing at all.
const HEADING_DICT = [
  /work experience|^experience$|professional experience|employment/i,
  /^education$/i,
  /^(technical )?skills$/i,
  /projects/i,
];

const TECH_VOCAB = [
  "python","javascript","typescript","java","c++","go","golang","swift","ruby","rust","kotlin","scala","sql","bash",
  "react","next.js","nextjs","angular","vue","redux","zustand","node","node.js","express","django","flask","fastapi","spring",
  "graphql","rest","grpc","microservices","jwt","oauth","api","apis",
  "postgresql","postgres","mysql","mongodb","redis","dynamodb","chroma","pinecone","elasticsearch","snowflake","bigquery",
  "aws","gcp","azure","docker","kubernetes","terraform","ci/cd","github actions","jenkins","vercel",
  "jest","cypress","pytest","playwright","selenium","unit testing","integration testing","end-to-end",
  "llm","rag","embeddings","vector search","langchain","openai","pytorch","tensorflow","nlp","machine learning","ml",
  "etl","data pipeline","data pipelines","distributed systems","multithreading","concurrency","caching","scalability",
  "frontend","backend","full-stack","fullstack","html","css","tailwind","webpack","git","agile","scrum",
  "observability","monitoring","logging","performance","optimization","debugging","code review","system design",
];

/**
 * Source text that actually reaches the page: comments dropped, preamble
 * dropped. Without this, words that appear only in a `%` comment look like
 * they went missing from the PDF — they were never in it.
 */
function bodyText(tex: string): string {
  const withoutComments = tex.replace(/(^|[^\\])%.*$/gm, "$1");
  const at = withoutComments.indexOf("\\begin{document}");
  return plainText(at === -1 ? withoutComments : withoutComments.slice(at));
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ");
}

function countTerm(haystack: string, term: string): number {
  // Word-boundary-ish match that tolerates the punctuation around tech names
  // ("Node.js," / "CI/CD."); a naive \b breaks on the dots and slashes.
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^a-z0-9+#.])${esc}([^a-z0-9+#.]|$)`, "g");
  return (haystack.match(re) || []).length;
}

/** Terms the JD asks for, ranked by how hard it leans on them. */
export function jdKeywords(jd: string, resumeText: string, extra: string[] = []): KeywordHit[] {
  const jdNorm = norm(jd);
  const resumeNorm = norm(resumeText);
  const vocab = [...new Set([...TECH_VOCAB, ...extra.map(norm)])];

  const hits: KeywordHit[] = [];
  for (const term of vocab) {
    const jdCount = countTerm(jdNorm, term);
    if (!jdCount) continue;
    hits.push({ term, jdCount, inResume: countTerm(resumeNorm, term) > 0 });
  }
  // Missing first (that's the actionable half), then by JD emphasis.
  hits.sort((a, b) => Number(a.inResume) - Number(b.inResume) || b.jdCount - a.jdCount);
  return hits;
}

/**
 * The copy-paste test. Every word in the source that contains an f-ligature
 * must survive extraction intact — that is exactly what a broken font encoding
 * destroys, and it is invisible on the rendered page.
 */
function checkExtraction(sourceText: string, extracted: string | null): AtsFinding {
  if (extracted === null) {
    return {
      id: "extract",
      level: "warn",
      title: "Text-extraction test skipped",
      detail:
        "poppler isn't installed, so the PDF's copy-paste output couldn't be checked. `brew install poppler` enables it.",
    };
  }
  const flat = extracted.replace(/\s+/g, " ");
  const risky = [...new Set(sourceText.match(/\b\w*(?:ffi|ffl|fi|fl|ff)\w*\b/g) || [])].filter(
    (w) => w.length > 3,
  );
  const broken = risky.filter((w) => !flat.includes(w));
  if (broken.length) {
    return {
      id: "extract",
      level: "fail",
      title: `${broken.length} word${broken.length > 1 ? "s" : ""} garbled on copy-paste`,
      detail: `A parser reading this PDF loses: ${broken.slice(0, 6).join(", ")}. The fi/fl ligature has its own Unicode codepoint, so an exact-match filter never sees the word. Use the ligature fix below — it handles pdfLaTeX and XeLaTeX separately, so it stays safe in Overleaf.`,
      fixable: "ligatures",
    };
  }
  return {
    id: "extract",
    level: "pass",
    title: "Copies out cleanly",
    detail: `Checked ${risky.length} ligature-prone words (workflow, efficient, …) — all extract intact.`,
  };
}

export function auditResume(opts: {
  tex: string;
  extracted: string | null;
  pages: number | null;
  jd?: string;
  extraKeywords?: string[];
}): AtsReport {
  const { tex, extracted, pages, jd } = opts;
  const sourceText = bodyText(tex);
  const findings: AtsFinding[] = [];

  // ── one page ─────────────────────────────────────────────────────────────
  if (pages === 1) {
    findings.push({ id: "pages", level: "pass", title: "One page", detail: "Fits the page budget." });
  } else if (pages !== null) {
    findings.push({
      id: "pages",
      level: "fail",
      title: `${pages} pages`,
      detail: "This is meant to be a one-pager. Shorten a bullet or drop one to pull it back.",
    });
  }

  findings.push(checkExtraction(sourceText, extracted));

  // ── layout traps ─────────────────────────────────────────────────────────
  if (/\\includegraphics|\\begin\{tikzpicture\}/.test(tex)) {
    findings.push({
      id: "images",
      level: "fail",
      title: "Contains an image",
      detail: "Parsers read no text from images — anything in there counts as blank space.",
    });
  }
  if (/\\begin\{(tabular|multicols|minipage)\}/.test(tex)) {
    findings.push({
      id: "columns",
      level: "warn",
      title: "Multi-column or tabular layout",
      detail:
        "Two-column PDFs extract about 71% of fields against 97% for single-column, because the parser reads straight across the columns.",
    });
  } else {
    findings.push({
      id: "columns",
      level: "pass",
      title: "Single-column layout",
      detail: "Reads top-to-bottom the way a parser expects.",
    });
  }

  // ── headings ─────────────────────────────────────────────────────────────
  const headings = [...tex.matchAll(/\\begin\{rSection\}\{([^}]*)\}/g)].map((m) => m[1]);
  const unmatched = headings.filter((h) => !HEADING_DICT.some((re) => re.test(h.trim())));
  if (unmatched.length) {
    findings.push({
      id: "headings",
      level: "warn",
      title: `Non-standard heading: ${unmatched.join(", ")}`,
      detail:
        "Parsers match headings against a fixed dictionary. Use Experience, Education, Skills, Projects — a heading they don't recognise can drop the whole section.",
    });
  } else {
    findings.push({
      id: "headings",
      level: "pass",
      title: "Standard section headings",
      detail: headings.join(", "),
    });
  }

  // ── contact block ────────────────────────────────────────────────────────
  const haystack = extracted ?? sourceText;
  const hasEmail = /[\w.+-]+@[\w-]+\.[\w.]+/.test(haystack);
  const hasPhone = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(haystack);
  if (hasEmail && hasPhone) {
    findings.push({
      id: "contact",
      level: "pass",
      title: "Contact details readable",
      detail: "Email and phone are in the document body, not a header or footer.",
    });
  } else {
    findings.push({
      id: "contact",
      level: "fail",
      title: "Contact details not found in the text",
      detail: `Missing from the extracted text: ${[!hasEmail && "email", !hasPhone && "phone"].filter(Boolean).join(", ")}.`,
    });
  }

  // ── dates ────────────────────────────────────────────────────────────────
  const months = [...sourceText.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b/g)].map(
    (m) => m[1],
  );
  const mixed = months.includes("Sept") && months.includes("Sep");
  const longAndShort =
    /\b(January|February|August|September|October|November|December)\b/.test(sourceText) &&
    /\b(Jan|Feb|Aug|Sept?|Oct|Nov|Dec)\b\.?\s+\d{4}/.test(sourceText);
  if (mixed || longAndShort) {
    findings.push({
      id: "dates",
      level: "warn",
      title: "Mixed date formats",
      detail:
        "Parsers compute tenure from these; mixing 'August 2023' with 'Sept 2025' can produce misread employment periods. Pick one form.",
    });
  } else {
    findings.push({ id: "dates", level: "pass", title: "Consistent date format", detail: "Tenure parses cleanly." });
  }

  // ── keywords ─────────────────────────────────────────────────────────────
  const keywords = jd ? jdKeywords(jd, sourceText, opts.extraKeywords) : [];
  if (jd) {
    const covered = keywords.filter((k) => k.inResume).length;
    const pct = keywords.length ? Math.round((covered / keywords.length) * 100) : 100;
    findings.push({
      id: "keywords",
      level: pct >= 70 ? "pass" : pct >= 45 ? "warn" : "fail",
      title: `${covered}/${keywords.length} job-description terms present (${pct}%)`,
      detail: keywords.filter((k) => !k.inResume).length
        ? `Not in the résumé: ${keywords.filter((k) => !k.inResume).slice(0, 8).map((k) => k.term).join(", ")}. Only add the ones you can honestly claim.`
        : "Every term the posting leans on appears in the résumé.",
    });
  }

  // Score: start at 100, subtract for what's actually wrong. Keyword coverage
  // is weighted hardest because it's the thing the filter literally sorts on.
  let score = 100;
  for (const f of findings) {
    if (f.id === "keywords") continue;
    if (f.level === "fail") score -= 18;
    else if (f.level === "warn") score -= 7;
  }
  if (jd && keywords.length) {
    const pct = keywords.filter((k) => k.inResume).length / keywords.length;
    score -= Math.round((1 - pct) * 30);
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    findings,
    keywords,
    extractedOk: extracted === null ? null : !findings.some((f) => f.id === "extract" && f.level === "fail"),
  };
}

// The engine-portable ligature repair, as a source transformation. pdfLaTeX and
// XeLaTeX need opposite fixes (remap the glyph vs. stop producing it), so the
// inserted block branches on the engine — that keeps the same .tex compiling in
// Overleaf, which defaults to pdfLaTeX, and here under tectonic's XeTeX.
export const LIGATURE_FIX = String.raw`\usepackage{iftex}
\ifPDFTeX
  \input{glyphtounicode}\pdfgentounicode=1
\else
  \usepackage{fontspec}
  \setmainfont{lmroman10-regular.otf}[
    BoldFont=lmroman10-bold.otf, ItalicFont=lmroman10-italic.otf,
    BoldItalicFont=lmroman10-bolditalic.otf, Ligatures=NoCommon]
\fi`;

export function hasLigatureFix(tex: string): boolean {
  return /\\pdfgentounicode|Ligatures\s*=\s*NoCommon/.test(tex);
}

/** Insert the fix after the last \usepackage in the preamble. Idempotent. */
export function applyLigatureFix(tex: string): string {
  if (hasLigatureFix(tex)) return tex;
  const docStart = tex.indexOf("\\begin{document}");
  const preambleEnd = docStart === -1 ? tex.length : docStart;
  const uses = [...tex.slice(0, preambleEnd).matchAll(/^\s*\\usepackage[^\n]*$/gm)];
  const at = uses.length ? uses[uses.length - 1].index! + uses[uses.length - 1][0].length : preambleEnd;
  return (
    tex.slice(0, at) +
    "\n\n% ATS: make ligatures extract as plain text (see the ATS panel).\n" +
    LIGATURE_FIX +
    tex.slice(at)
  );
}
