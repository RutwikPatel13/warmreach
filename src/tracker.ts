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
