// ── The LaTeX engine ────────────────────────────────────────────────────────
// Everything the résumé editor knows about the page comes from actually running
// TeX. There is no HTML approximation of the layout anywhere in this feature:
// asking "does this bullet fit on one line" is asking the same engine that will
// produce the PDF, which is the only answer that can't drift from the artifact.
//
// Tectonic over MacTeX deliberately — it's a single ~50MB binary that fetches
// only the packages resume.cls actually pulls in, against 6GB for a full TeX
// Live. First compile downloads them (~60s, once); every compile after that is
// ~0.4s, which is what makes live preview-as-you-type viable.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const exec = promisify(execFile);

const COMPILE_TIMEOUT_MS = 120_000; // first run downloads packages; later runs ~0.4s
const TEXT_TIMEOUT_MS = 15_000;

// Homebrew's bin isn't on PATH for a GUI-launched `next dev`, so look there
// explicitly rather than failing with a confusing ENOENT.
const ENGINE_CANDIDATES = ["tectonic", "/opt/homebrew/bin/tectonic", "/usr/local/bin/tectonic"];
const PDFTOTEXT_CANDIDATES = ["pdftotext", "/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext"];

/**
 * Resolve a binary to an absolute path, or null if it isn't installed.
 *
 * Returning a bare name and letting the spawn fail is not good enough here: the
 * page asks "is there an engine?" up front so it can say `brew install
 * tectonic` instead of showing an empty preview, and that answer has to be
 * true. So every candidate is checked on disk, PATH included.
 */
function resolveBinary(candidates: string[]): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const bin of candidates) {
    if (bin.includes("/")) {
      if (isExecutable(bin)) return bin;
      continue;
    }
    for (const dir of dirs) {
      const full = path.join(dir, bin);
      if (isExecutable(full)) return full;
    }
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function enginePath(): string | null {
  return resolveBinary(ENGINE_CANDIDATES);
}

export function pdftotextPath(): string | null {
  return resolveBinary(PDFTOTEXT_CANDIDATES);
}

export interface TexProblem {
  kind: "error" | "overfull" | "underfull";
  line: number | null;
  message: string;
  points?: number; // how far over the line width, for overfull boxes
}

export interface CompileResult {
  ok: boolean;
  pdfPath: string | null;
  pages: number | null;
  log: string;
  problems: TexProblem[];
  ms: number;
}

/**
 * Compile `tex` in `dir` (which must already contain resume.cls) and leave the
 * PDF next to it. `dir` is a real directory rather than a temp one so the PDF
 * URL stays stable and the browser can re-fetch it.
 */
export async function compile(dir: string, tex: string, jobname = "main"): Promise<CompileResult> {
  const engine = enginePath();
  const started = Date.now();
  if (!engine) {
    return {
      ok: false,
      pdfPath: null,
      pages: null,
      log: "",
      ms: 0,
      problems: [
        {
          kind: "error",
          line: null,
          message:
            "No LaTeX engine found. Install one with `brew install tectonic`, then reload this page.",
        },
      ],
    };
  }

  const texPath = path.join(dir, `${jobname}.tex`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(texPath, tex, "utf8");

  let stderr = "";
  let failed = false;
  try {
    const r = await exec(engine, ["-X", "compile", texPath, "--outdir", dir, "--keep-logs"], {
      timeout: COMPILE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      cwd: dir,
    });
    stderr = r.stderr ?? "";
  } catch (e) {
    // Tectonic exits non-zero on a TeX error but still writes the log, which is
    // where the useful message lives — so a throw is not the end of the story.
    const err = e as { stderr?: string; message?: string; killed?: boolean };
    stderr = err.stderr ?? err.message ?? "";
    failed = true;
    if (err.killed) {
      stderr += "\nThe compile timed out.";
    }
  }

  const logPath = path.join(dir, `${jobname}.log`);
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "latin1") : "";
  const pdfPath = path.join(dir, `${jobname}.pdf`);
  const hasPdf = fs.existsSync(pdfPath);

  const problems = parseLog(log, stderr);
  const pages = parsePages(log);

  return {
    ok: hasPdf && !problems.some((p) => p.kind === "error"),
    pdfPath: hasPdf ? pdfPath : null,
    pages,
    log: log || stderr,
    problems: failed && !problems.length
      ? [{ kind: "error", line: null, message: stderr.trim().slice(0, 2000) || "The compile failed." }]
      : problems,
    ms: Date.now() - started,
  };
}

// XeTeX writes an .xdv, so the page count line names that rather than the PDF.
// Taking the count from the engine's own report beats parsing the PDF, whose
// object streams make a naive /Type/Page scan unreliable.
function parsePages(log: string): number | null {
  const m = /Output written on .*?\((\d+)\s+pages?/.exec(log);
  return m ? Number(m[1]) : null;
}

function parseLog(log: string, stderr: string): TexProblem[] {
  const problems: TexProblem[] = [];

  for (const m of log.matchAll(/Overfull \\hbox \(([\d.]+)pt too wide\) in paragraph at lines (\d+)--(\d+)/g)) {
    problems.push({
      kind: "overfull",
      line: Number(m[2]),
      points: Number(m[1]),
      message: `Line runs ${Number(m[1]).toFixed(1)}pt past the margin`,
    });
  }

  // TeX errors start with "! " at the beginning of a line; the following
  // "l.<n>" line carries the source line number.
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("! ")) continue;
    let srcLine: number | null = null;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const lm = /^l\.(\d+)/.exec(lines[j]);
      if (lm) {
        srcLine = Number(lm[1]);
        break;
      }
    }
    problems.push({ kind: "error", line: srcLine, message: line.slice(2).trim() });
  }

  if (!problems.length && /error/i.test(stderr)) {
    const firstError = stderr.split("\n").find((l) => /error/i.test(l));
    if (firstError) problems.push({ kind: "error", line: null, message: firstError.trim() });
  }

  return problems;
}

/**
 * The copy-paste test, run for real: pull the text back out of the finished PDF
 * exactly as a résumé parser would. This is the only way to catch the classic
 * LaTeX trap where "workflow" comes out as "work ow" because the fi/fl ligature
 * has no ToUnicode mapping — invisible on the page, missing from the keyword
 * match. Returns null when poppler isn't installed; the caller degrades to
 * source-only checks rather than pretending the test passed.
 */
export async function extractText(pdfPath: string): Promise<string | null> {
  const bin = pdftotextPath();
  if (!bin) return null;
  try {
    const r = await exec(bin, ["-layout", pdfPath, "-"], {
      timeout: TEXT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return r.stdout;
  } catch {
    return null;
  }
}
