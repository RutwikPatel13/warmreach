import fs from "node:fs";
import path from "node:path";

const LOG = path.resolve("data/outreach_log.csv");
const HEADER = "timestamp,company,role,name,title,email,email_status,subject,draft_status\n";

function escape(v: string): string {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}

export interface LogRow {
  company: string;
  role: string;
  name: string;
  title: string;
  email: string;
  emailStatus: string;
  subject: string;
  draftStatus: string;
}

export function logOutreach(row: LogRow): void {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, HEADER);
  const line =
    [
      new Date().toISOString(),
      row.company,
      row.role,
      row.name,
      row.title,
      row.email,
      row.emailStatus,
      row.subject,
      row.draftStatus,
    ]
      .map(escape)
      .join(",") + "\n";
  fs.appendFileSync(LOG, line);
}

// Has this email already been contacted (per the log)? Avoids double outreach.
// Match the exact quoted email token (logOutreach writes emails as `"email"`),
// so `a@x.com` can't false-match `aa@x.com` or an address that appears in some
// other column (name/subject).
export function alreadyContacted(email: string): boolean {
  if (!fs.existsSync(LOG)) return false;
  const needle = `"${email.toLowerCase()}"`;
  return fs.readFileSync(LOG, "utf8").toLowerCase().includes(needle);
}

// Parse one CSV line written by logOutreach (fields quoted, "" = escaped quote).
function parseLogLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Normalize a company name for fuzzy matching (drops punctuation + common
// suffixes): "Ambrook Inc." and "ambrook" both -> "ambrook". Shared with the
// Campaigns page so the same key matches on both sides.
export function normCompany(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["inc", "llc", "ltd", "co", "corp", "corporation"].includes(w))
    .join("");
}

// Which companies have already been reached out to, per the log — returned as
// normalized names plus the email domains seen (columns: company=1, email=5).
// The Campaigns picker uses this to FLAG (not deselect) companies done earlier,
// so batching outreach across days is safe.
export function contactedCompanies(): { names: string[]; domains: string[] } {
  if (!fs.existsSync(LOG)) return { names: [], domains: [] };
  const names = new Set<string>();
  const domains = new Set<string>();
  const lines = fs.readFileSync(LOG, "utf8").split("\n").slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = parseLogLine(line);
    const company = cells[1] ?? "";
    const email = cells[5] ?? "";
    if (company) names.add(normCompany(company));
    const at = email.indexOf("@");
    if (at >= 0) { const d = email.slice(at + 1).toLowerCase().trim(); if (d) domains.add(d); }
  }
  return { names: [...names], domains: [...domains] };
}

export interface OutreachRow {
  timestamp: string;
  company: string;
  role: string; // "campaign" for Campaigns, else the applied role (Applications)
  name: string;
  title: string;
  email: string;
  emailStatus: string;
  subject: string;
  draftStatus: string;
}

// Every logged outreach as a structured row (newest first) — powers the Database
// page. Columns: timestamp,company,role,name,title,email,email_status,subject,draft_status.
export function outreachRows(): OutreachRow[] {
  if (!fs.existsSync(LOG)) return [];
  const rows: OutreachRow[] = [];
  for (const line of fs.readFileSync(LOG, "utf8").split("\n").slice(1)) {
    if (!line.trim()) continue;
    const c = parseLogLine(line);
    rows.push({
      timestamp: c[0] ?? "", company: c[1] ?? "", role: c[2] ?? "", name: c[3] ?? "",
      title: c[4] ?? "", email: c[5] ?? "", emailStatus: c[6] ?? "", subject: c[7] ?? "",
      draftStatus: c[8] ?? "",
    });
  }
  return rows.reverse(); // newest first
}

export interface OutreachStats {
  companies: number; // distinct companies ever contacted
  people: number; // total outreach rows
  drafted: number; // rows that produced a Gmail draft
  thisWeek: number; // rows in the last 7 days
  lastAt: string | null; // ISO timestamp of the most recent outreach
}

// Lifetime outreach totals from the log — so the app can show real numbers
// before any search this session (columns: timestamp=0, company=1, draft_status=8).
export function outreachStats(): OutreachStats {
  if (!fs.existsSync(LOG)) return { companies: 0, people: 0, drafted: 0, thisWeek: 0, lastAt: null };
  const companies = new Set<string>();
  let people = 0, drafted = 0, thisWeek = 0;
  let lastMs = 0, lastAt: string | null = null;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const line of fs.readFileSync(LOG, "utf8").split("\n").slice(1)) {
    if (!line.trim()) continue;
    const cells = parseLogLine(line);
    people++;
    if (cells[1]) companies.add(normCompany(cells[1]));
    if ((cells[8] ?? "").startsWith("draft:")) drafted++;
    const t = Date.parse(cells[0] ?? "");
    if (!Number.isNaN(t)) {
      if (t >= weekAgo) thisWeek++;
      if (t > lastMs) { lastMs = t; lastAt = cells[0]; }
    }
  }
  return { companies: companies.size, people, drafted, thisWeek, lastAt };
}

// The most recent draft id logged for this email, if any — lets a re-draft find
// and edit the earlier draft even when it was made in a previous session (the
// current tab no longer holds the id). Scans newest-first; null if never drafted.
export function lastDraftIdFor(email: string): string | null {
  if (!fs.existsSync(LOG)) return null;
  const needle = `"${email.toLowerCase()}"`;
  const lines = fs.readFileSync(LOG, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].toLowerCase().includes(needle)) continue;
    const m = lines[i].match(/"draft:([^"]+)"/);
    if (m) return m[1];
  }
  return null;
}
