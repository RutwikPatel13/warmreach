import fs from "node:fs";
import path from "node:path";
import { profile } from "./profile";

export interface ResumeFile {
  path: string; // absolute path, used as the attachment
  label: string; // path relative to resumeDir, e.g. "acme/My_Resume.pdf"
}

// Recursively list every PDF under profile.resumeDir. Used by the per-tab resume
// picker. Returns [] if the folder is missing/unreadable (fails open).
export function listResumes(): ResumeFile[] {
  const root = profile.resumeDir;
  const out: ResumeFile[] = [];

  function walk(dir: string, depth: number) {
    if (depth > 4) return; // guard against deep/cyclic trees
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".pdf")) {
        out.push({ path: full, label: path.relative(root, full) });
      }
    }
  }

  walk(root, 0);
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}
