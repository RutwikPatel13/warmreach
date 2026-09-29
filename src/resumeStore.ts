// ── Where tailored résumés live ────────────────────────────────────────────
// Under data/, which is both .gitignore'd and matched by the pre-push guard in
// .githooks/pre-push — so a résumé full of personal detail cannot ride along
// with a push even by accident. Each tailored résumé is a directory holding its
// own .tex, its compiled PDF, and a copy of resume.cls (tectonic compiles in
// place, and a self-contained directory is also exactly what you'd upload to
// Overleaf).
//
// Every save snapshots the previous .tex into versions/ first. Rewriting
// bullets is lossy by nature and the model is not always right; being able to
// walk back to what you had five minutes ago is what makes it safe to accept a
// suggestion you're unsure about.

import fs from "node:fs";
import path from "node:path";

export const RESUME_DIR = path.join(process.cwd(), "data", "resume");
export const DOCS_DIR = path.join(RESUME_DIR, "docs");
export const BASE_TEX = path.join(RESUME_DIR, "base.tex");
export const CLS = path.join(RESUME_DIR, "resume.cls");
export const MASTER = path.join(RESUME_DIR, "master.json");

/** Matches the naming already used throughout ~/Documents/Resume. */
const DEFAULT_EXPORT_NAME = "Rutwik_Resume.pdf";

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
  /** True for the base one-pager, which is a real file rather than a copy. */
  isBase?: boolean;
}

/**
 * The base one-pager is a document too.
 *
 * Without it the page opens on an empty list and a dead end: there is nothing to
 * preview until you invent a role to tailor for, which is backwards — the thing
 * you most want to look at is your actual résumé. This id edits
 * data/resume/base.tex in place, so the master template is previewable,
 * editable and ATS-checkable on its own. It compiles in its own scratch
 * directory because compiling writes a main.tex, and that must never be
 * mistaken for the source of truth.
 */
export const BASE_ID = "base";
const BASE_WORKDIR = path.join(RESUME_DIR, "_base");

export function isBaseId(id: string): boolean {
  return id === BASE_ID;
}

function baseMeta(): DocMeta {
  const stat = fs.existsSync(BASE_TEX) ? fs.statSync(BASE_TEX) : null;
  return {
    id: BASE_ID,
    title: "Base one-pager",
    company: "",
    role: "",
    jd: "",
    jobUrl: "",
    notes: "",
    createdAt: stat ? stat.birthtime.toISOString() : new Date().toISOString(),
    updatedAt: stat ? stat.mtime.toISOString() : new Date().toISOString(),
    lastExportedTo: null,
    lastTailoredAt: null,
  };
}

/** Directory names are user-influenced, so they get sanitised, not trusted. */
export function safeId(raw: string): string {
  const id = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!id) throw new Error("Invalid document id");
  return id;
}

export function slugFor(company: string, role: string): string {
  const base = [company, role].filter(Boolean).join("-") || "untitled";
  let id = safeId(base);
  // Two applications to the same role at the same company are normal; give the
  // second one its own directory rather than silently overwriting the first.
  let n = 2;
  while (fs.existsSync(path.join(DOCS_DIR, id))) id = `${safeId(base)}-${n++}`;
  return id;
}

function docDir(id: string): string {
  return path.join(DOCS_DIR, safeId(id));
}

export function ensureDirs(): void {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

export function readBaseTex(): string {
  return fs.readFileSync(BASE_TEX, "utf8");
}

export function readMaster(): unknown {
  return JSON.parse(fs.readFileSync(MASTER, "utf8"));
}

export function listDocs(): DocSummary[] {
  ensureDirs();
  const out: DocSummary[] = [];
  for (const name of fs.readdirSync(DOCS_DIR)) {
    const metaPath = path.join(DOCS_DIR, name, "meta.json");
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as DocMeta;
      const vdir = path.join(DOCS_DIR, name, "versions");
      out.push({
        ...meta,
        hasPdf: fs.existsSync(path.join(DOCS_DIR, name, "main.pdf")),
        versions: fs.existsSync(vdir) ? fs.readdirSync(vdir).filter((f) => f.endsWith(".tex")).length : 0,
      });
    } catch {
      /* a half-written meta.json shouldn't hide every other résumé */
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // Always first, and always present — it is the file every other résumé here
  // is a copy of.
  const versions = fs.existsSync(path.join(BASE_WORKDIR, "versions"))
    ? fs.readdirSync(path.join(BASE_WORKDIR, "versions")).filter((f) => f.endsWith(".tex")).length
    : 0;
  out.unshift({
    ...baseMeta(),
    hasPdf: fs.existsSync(path.join(BASE_WORKDIR, "main.pdf")),
    versions,
    isBase: true,
  });
  return out;
}

export function createDoc(input: {
  company: string;
  role: string;
  jd?: string;
  jobUrl?: string;
  notes?: string;
  tex?: string;
}): DocMeta {
  ensureDirs();
  const id = slugFor(input.company, input.role);
  const dir = docDir(id);
  fs.mkdirSync(path.join(dir, "versions"), { recursive: true });

  const now = new Date().toISOString();
  const meta: DocMeta = {
    id,
    title: [input.company, input.role].filter(Boolean).join(" — ") || "Untitled résumé",
    company: input.company ?? "",
    role: input.role ?? "",
    jd: input.jd ?? "",
    jobUrl: input.jobUrl ?? "",
    notes: input.notes ?? "",
    createdAt: now,
    updatedAt: now,
    lastExportedTo: null,
    lastTailoredAt: null,
  };

  fs.writeFileSync(path.join(dir, "main.tex"), input.tex ?? readBaseTex(), "utf8");
  fs.copyFileSync(CLS, path.join(dir, "resume.cls"));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

export function readDoc(id: string): { meta: DocMeta; tex: string; dir: string } {
  if (isBaseId(id)) {
    fs.mkdirSync(BASE_WORKDIR, { recursive: true });
    const cls = path.join(BASE_WORKDIR, "resume.cls");
    if (!fs.existsSync(cls)) fs.copyFileSync(CLS, cls);
    return { meta: baseMeta(), tex: readBaseTex(), dir: BASE_WORKDIR };
  }
  const dir = docDir(id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as DocMeta;
  const tex = fs.readFileSync(path.join(dir, "main.tex"), "utf8");
  // resume.cls can go missing if the directory was copied around by hand.
  const cls = path.join(dir, "resume.cls");
  if (!fs.existsSync(cls)) fs.copyFileSync(CLS, cls);
  return { meta, tex, dir };
}

/**
 * Write the source, optionally snapshotting what was there first.
 *
 * `snapshot` is false for the autosave that runs on every compile — otherwise
 * typing would mint a version every second and bury the ones that matter. It
 * stays true for changes the user didn't type: applying a suggestion, the
 * ligature fix, restoring. Those are the ones worth being able to walk back,
 * and the editor's own undo covers the rest.
 */
export function saveDoc(
  id: string,
  tex: string,
  patch: Partial<DocMeta> = {},
  { snapshot = true }: { snapshot?: boolean } = {},
): DocMeta {
  if (isBaseId(id)) {
    const previous = fs.existsSync(BASE_TEX) ? fs.readFileSync(BASE_TEX, "utf8") : "";
    if (snapshot && previous && previous !== tex) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.mkdirSync(path.join(BASE_WORKDIR, "versions"), { recursive: true });
      fs.writeFileSync(path.join(BASE_WORKDIR, "versions", `${stamp}.tex`), previous, "utf8");
    }
    fs.writeFileSync(BASE_TEX, tex, "utf8");
    return baseMeta();
  }

  const dir = docDir(id);
  const metaPath = path.join(dir, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as DocMeta;
  const texPath = path.join(dir, "main.tex");

  const previous = fs.existsSync(texPath) ? fs.readFileSync(texPath, "utf8") : "";
  if (snapshot && previous && previous !== tex) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.mkdirSync(path.join(dir, "versions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "versions", `${stamp}.tex`), previous, "utf8");
  }

  fs.writeFileSync(texPath, tex, "utf8");
  const next: DocMeta = { ...meta, ...patch, id: meta.id, updatedAt: new Date().toISOString() };
  fs.writeFileSync(metaPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function deleteDoc(id: string): void {
  // The base one-pager is the template every other résumé is copied from;
  // deleting it from a list UI would be a catastrophe with no undo.
  if (isBaseId(id)) throw new Error("The base one-pager can't be deleted.");
  fs.rmSync(docDir(id), { recursive: true, force: true });
}

export function listVersions(id: string): { stamp: string; bytes: number }[] {
  const vdir = path.join(isBaseId(id) ? BASE_WORKDIR : docDir(id), "versions");
  if (!fs.existsSync(vdir)) return [];
  return fs
    .readdirSync(vdir)
    .filter((f) => f.endsWith(".tex"))
    .map((f) => ({ stamp: f.replace(/\.tex$/, ""), bytes: fs.statSync(path.join(vdir, f)).size }))
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
}

export function readVersion(id: string, stamp: string): string {
  const safe = stamp.replace(/[^0-9A-Za-z-]/g, "");
  const root = isBaseId(id) ? BASE_WORKDIR : docDir(id);
  return fs.readFileSync(path.join(root, "versions", `${safe}.tex`), "utf8");
}

export function pdfPath(id: string): string {
  return path.join(isBaseId(id) ? BASE_WORKDIR : docDir(id), "main.pdf");
}

/**
 * Copy the compiled PDF into the folder the Applications page's attachment
 * picker scans, so a tailored résumé becomes attachable without leaving the app.
 * Returns the destination path.
 */
export interface ExportResult {
  path: string;
  /** True when a file was already sitting there and has been replaced. */
  overwrote: boolean;
}

/**
 * Copy the compiled PDF into profile.resumeDir, which is the folder the
 * Applications page's attachment picker scans — so a résumé tailored here is
 * immediately attachable without a trip through Finder.
 *
 * The file is always called Rutwik_Resume.pdf, matching the convention already
 * in that folder (the-hive/Rutwik_Resume.pdf, google/Rutwik_Resume.pdf, …). The
 * company subfolder is what keeps them apart, and it is also what the picker
 * shows, so the label reads "the-hive/Rutwik_Resume.pdf".
 *
 * Reports whether it replaced something. That folder has files in it this app
 * never wrote, and overwriting one silently would be a poor way to find out.
 */
export function exportPdf(id: string, resumeDir: string, filename?: string): ExportResult {
  const src = pdfPath(id);
  if (!fs.existsSync(src)) throw new Error("Compile the résumé before exporting it.");
  const { meta } = readDoc(id);

  const name = (filename || DEFAULT_EXPORT_NAME).replace(/[/\\]/g, "-");
  const safeName = name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;

  // The base one-pager is not for one company, so it lands at the top level.
  const folder = isBaseId(id) ? resumeDir : path.join(resumeDir, safeId(meta.company || meta.id));
  fs.mkdirSync(folder, { recursive: true });

  const dest = path.join(folder, safeName);
  const overwrote = fs.existsSync(dest);
  fs.copyFileSync(src, dest);

  if (!isBaseId(id)) {
    saveDoc(id, fs.readFileSync(path.join(docDir(id), "main.tex"), "utf8"), { lastExportedTo: dest }, { snapshot: false });
  }
  return { path: dest, overwrote };
}
