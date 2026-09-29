// Shapes the résumé page shares with its API routes. Kept in one file so the
// panels and the page can't drift apart on what a fit or a finding looks like.

export interface Fit {
  id: string;
  lines: number;
  linewidthPt: number;
  lastFill: number;
  tightness: number;
  budget: { min: number; max: number; current: number };
  status: "ok" | "tight" | "overflow" | "loose" | "short";
}

export interface AtsFinding {
  id: string;
  level: "pass" | "warn" | "fail";
  title: string;
  detail: string;
  fixable?: "ligatures";
}

export interface KeywordHit {
  term: string;
  inResume: boolean;
  jdCount: number;
}

export interface AtsReport {
  score: number;
  findings: AtsFinding[];
  keywords: KeywordHit[];
  extractedOk: boolean | null;
}

export interface TexProblem {
  kind: "error" | "overfull" | "underfull";
  line: number | null;
  message: string;
  points?: number;
}

export interface TexItem {
  id: string;
  start: number;
  end: number;
  text: string;
  line: number;
}

export interface TexEntry {
  id: string;
  heading: string;
  primary: string;
  secondary: string;
  dates: string;
  items: TexItem[];
  listDecl: string;
  itemsStart: number;
  itemsEnd: number;
}

export interface TexProject {
  id: string;
  name: string;
  start: number;
  end: number;
  blurb: string;
  prefix: string;
  line: number;
}

export interface TexSkillLine {
  id: string;
  label: string;
  start: number;
  end: number;
  text: string;
  line: number;
}

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

export interface RenderReport {
  ok: boolean;
  pages: number | null;
  ms: number;
  problems: TexProblem[];
  fits: Record<string, Fit>;
  ats: AtsReport;
  parsed: ParsedResume;
  version: number;
}

export interface DocMeta {
  id: string;
  title: string;
  company: string;
  role: string;
  jd: string;
  jobUrl: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  lastExportedTo?: string | null;
  lastTailoredAt?: string | null;
}

export interface DocSummary extends DocMeta {
  hasPdf: boolean;
  versions: number;
  /** The base one-pager: a real file, not a copy. Can't be deleted. */
  isBase?: boolean;
}

/** The always-present document that edits data/resume/base.tex in place. */
export const BASE_ID = "base";

export interface ProposedBullet {
  id: string;
  text: string;
  sourceId: string;
  rationale: string;
  changed: boolean;
  /** The bullet as it was when the suggestion was made — see editsFor(). */
  before: string;
}

export interface Proposal {
  strategy: string;
  bullets: ProposedBullet[];
  projects: { id: string; blurb: string; rationale: string; before: string }[];
  skills: { id: string; text: string; rationale: string; before: string }[];
  keywords: string[];
  fits: Record<string, Fit>;
  baseline: Record<string, Fit>;
  rounds: number;
  stillMissing: string[];
  /** Rewrites that never fit and were put back to the original text. */
  reverted: string[];
  costUsd: number;
}

/** Visible text of a LaTeX fragment — mirrors plainText() on the server. */
export function plain(tex: string): string {
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

/** Word-level diff for the before/after view in the tailor panel. */
export function wordDiff(before: string, after: string): { text: string; kind: "same" | "add" | "del" }[] {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  // Longest common subsequence over words — small inputs, so the O(n·m) table
  // is free and gives a much more readable diff than a naive prefix/suffix trim.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: { text: string; kind: "same" | "add" | "del" }[] = [];
  const push = (text: string, kind: "same" | "add" | "del") => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(a[i], "same");
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(a[i], "del");
      i++;
    } else {
      push(b[j], "add");
      j++;
    }
  }
  while (i < n) push(a[i++], "del");
  while (j < m) push(b[j++], "add");
  return out;
}
