import fs from "node:fs";
import path from "node:path";
import { normCompany } from "./tracker";

// ── Local contacts cache (data/contacts/*.csv) ──────────────────────────────
// Apollo exports the friend shared: real people WITH verified emails. Apollo's
// free people-search hides the email (and obfuscates the last name), and each
// enrichment costs a credit — but for any company we already have on file here,
// we can skip BOTH the search and the enrichment and use these rows directly.
// So covered companies cost ZERO Apollo credits. Matched by email domain first,
// then normalized company name. Built once per process and memoized.

const DIR = path.resolve("data/contacts");

// Personal-email domains never represent a company (and must not become cache keys).
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
  "aol.com", "protonmail.com", "me.com", "live.com", "msn.com",
]);

export interface CachedContact {
  firstName: string;
  lastName: string;
  title: string;
  email: string;
  emailStatus: string;
}

// One distinct company we hold contacts for (for the "My contacts" source list).
export interface ContactsCompany {
  name: string;
  domain?: string;
  count: number; // people on file
}

// RFC-4180-ish CSV parser (quoted fields, "" escapes, CRLF/LF).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase().trim() || null : null;
}

interface Index {
  byDomain: Map<string, CachedContact[]>;
  byName: Map<string, CachedContact[]>;
  companyList: ContactsCompany[];
  people: number;
  companies: number;
}
let INDEX: Index | null = null;

function listCsvFiles(dir: string): string[] {
  let out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(listCsvFiles(full));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".csv")) out.push(full);
  }
  return out;
}

function build(): Index {
  const byDomain = new Map<string, CachedContact[]>();
  const byName = new Map<string, CachedContact[]>();
  const seenEmails = new Set<string>(); // dedupe a person appearing in several CSVs
  const companies = new Set<string>();
  // Aggregate distinct companies by NORMALIZED NAME (so several CSVs / domains /
  // spellings for one company collapse together), tracking the best display name,
  // the most common work domain, and the person count — for the "My contacts" list.
  const agg = new Map<string, { names: Map<string, number>; domains: Map<string, number>; people: number }>();

  for (const file of listCsvFiles(DIR)) {
    let rows: string[][];
    try { rows = parseCsv(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (rows.length < 2) continue;
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (...names: string[]) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
    const iFirst = col("first name");
    const iLast = col("last name");
    const iTitle = col("title");
    const iEmail = col("email");
    const iStatus = col("email status");
    const iCompany = col("company name", "company");
    if (iEmail < 0 || iFirst < 0) continue;

    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      const email = (cells[iEmail] ?? "").trim().toLowerCase();
      if (!email.includes("@")) continue;
      const contact: CachedContact = {
        firstName: (cells[iFirst] ?? "").trim(),
        lastName: iLast >= 0 ? (cells[iLast] ?? "").trim() : "",
        title: iTitle >= 0 ? (cells[iTitle] ?? "").trim() : "",
        email,
        emailStatus: iStatus >= 0 ? (cells[iStatus] ?? "").trim() : "",
      };
      const domain = domainOf(email);
      const company = iCompany >= 0 ? (cells[iCompany] ?? "").trim() : "";
      const dedupeKey = email;
      if (seenEmails.has(dedupeKey)) continue;
      seenEmails.add(dedupeKey);

      const workDomain = domain && !PERSONAL_DOMAINS.has(domain) ? domain : undefined;
      if (workDomain) {
        (byDomain.get(workDomain) ?? byDomain.set(workDomain, []).get(workDomain)!).push(contact);
        companies.add(workDomain);
      }
      const nameKey = company ? normCompany(company) : "";
      if (nameKey) {
        (byName.get(nameKey) ?? byName.set(nameKey, []).get(nameKey)!).push(contact);
      }

      // company aggregation — keyed by normalized NAME (falls back to work domain).
      const aggKey = nameKey || workDomain || "";
      if (aggKey) {
        let a = agg.get(aggKey);
        if (!a) { a = { names: new Map(), domains: new Map(), people: 0 }; agg.set(aggKey, a); }
        a.people++;
        if (company) a.names.set(company, (a.names.get(company) ?? 0) + 1);
        if (workDomain) a.domains.set(workDomain, (a.domains.get(workDomain) ?? 0) + 1);
      }
    }
  }

  // Merge domain-keyed buckets (rows that had a blank company name) into the
  // named company that owns that domain — so "apple.com" folds into "Apple".
  // Name keys never contain a dot (normCompany strips punctuation); domain keys do.
  const domainOwner = new Map<string, string>();
  for (const [key, a] of agg) {
    if (key.includes(".")) continue;
    for (const d of a.domains.keys()) if (!domainOwner.has(d)) domainOwner.set(d, key);
  }
  for (const [key, a] of [...agg]) {
    if (!key.includes(".")) continue;
    const owner = domainOwner.get(key);
    const o = owner ? agg.get(owner) : undefined;
    if (!o) continue;
    o.people += a.people;
    for (const [n, c] of a.names) o.names.set(n, (o.names.get(n) ?? 0) + c);
    for (const [d, c] of a.domains) o.domains.set(d, (o.domains.get(d) ?? 0) + c);
    agg.delete(key);
  }

  const topKey = (m: Map<string, number>): string | undefined => {
    let best: string | undefined, n = -1;
    for (const [k, c] of m) if (c > n) { best = k; n = c; }
    return best;
  };
  const companyList: ContactsCompany[] = [...agg.values()]
    .map((a) => ({ name: topKey(a.names) ?? topKey(a.domains) ?? "", domain: topKey(a.domains), count: a.people }))
    .filter((c) => c.name)
    .sort((x, y) => x.name.localeCompare(y.name));

  return { byDomain, byName, companyList, people: seenEmails.size, companies: companies.size };
}

function index(): Index {
  if (!INDEX) INDEX = build();
  return INDEX;
}

// People we already have on file for a company (verified emails included), or []
// if the company isn't in the local exports. Domain match wins; name is fallback.
export function contactsForCompany(name: string | undefined, domain: string | undefined | null): CachedContact[] {
  const idx = index();
  if (domain) { const d = idx.byDomain.get(domain.toLowerCase()); if (d?.length) return d; }
  if (name) { const n = idx.byName.get(normCompany(name)); if (n?.length) return n; }
  return [];
}

export function contactsStats(): { people: number; companies: number } {
  const idx = index();
  return { people: idx.people, companies: idx.companies };
}

// Distinct companies we hold contacts for — powers the "My contacts" source list
// on the Campaigns page (searching these returns the CSV people, free).
export function contactsCompanyList(): ContactsCompany[] {
  return index().companyList;
}
