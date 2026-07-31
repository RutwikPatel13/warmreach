import fs from "node:fs";
import path from "node:path";

// ── Prospect lists (data/prospects/*.csv) ───────────────────────────────────
// The Campaigns page is driven by curated startup lists that live as CSVs under
// data/prospects/ (scraped from pampam maps / startups.gallery). Each row is a
// company we can resolve in Apollo and reach out to. This module parses those
// CSVs into {name, domain, description} so the app never re-scrapes.

const DIR = path.resolve("data/prospects");

export interface ProspectCompany {
  name: string;
  domain?: string; // parsed from a website column when present; else name-only
  website?: string;
  description?: string;
}

export interface ProspectList {
  id: string; // filename without .csv
  name: string; // pretty display name
  count: number;
  withDomain: number;
  companies: ProspectCompany[];
}

// Pretty names for the known lists; unknown files fall back to a title-cased id.
const DISPLAY: Record<string, string> = {
  soho_valley: "SoHo Valley · NYC",
  brex_sf: "Brex AI Map · SF",
  startups_gallery: "startups.gallery",
};

// all_prospects.csv is the merged export — skip it so companies aren't doubled.
const SKIP = new Set(["all_prospects.csv"]);

// A website/URL -> bare registrable domain ("https://www.niva.co/path" -> "niva.co").
// LinkedIn/twitter/other-social links are NOT company domains, so they're dropped.
const SOCIAL = /(^|\.)(linkedin|twitter|x|facebook|instagram|crunchbase)\.com$/i;
export function toDomain(url?: string): string | undefined {
  if (!url) return undefined;
  let s = url.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  s = s.split(/[/?#]/)[0].trim().toLowerCase();
  if (!s || !s.includes(".") || s.includes(" ")) return undefined;
  if (SOCIAL.test(s)) return undefined;
  return s;
}

// Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
// escaped "" quotes, and CRLF/LF newlines. Returns rows of string cells.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cell); cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function readList(file: string): ProspectList | null {
  const full = path.join(DIR, file);
  let text: string;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch {
    return null;
  }
  const rows = parseCsv(text);
  if (rows.length < 2) return null;

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iName = col("company");
  const iDesc = col("description");
  // A website-ish column: prefer "website", then "url"/"link"/"details".
  const iSite = ["website", "url", "link"].map(col).find((x) => x >= 0) ?? -1;

  const companies: ProspectCompany[] = [];
  const seen = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const name = (cells[iName] ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const website = iSite >= 0 ? (cells[iSite] ?? "").trim() : "";
    companies.push({
      name,
      domain: toDomain(website),
      website: website || undefined,
      description: iDesc >= 0 ? (cells[iDesc] ?? "").trim() || undefined : undefined,
    });
  }

  const id = file.replace(/\.csv$/i, "");
  return {
    id,
    name: DISPLAY[id] ?? id.replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
    count: companies.length,
    withDomain: companies.filter((c) => c.domain).length,
    companies,
  };
}

// Every prospect list under data/prospects/ (merged export excluded), each with
// its parsed companies. Missing directory -> empty (the page shows an empty state).
export function loadProspectLists(): ProspectList[] {
  let files: string[];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith(".csv") && !SKIP.has(f));
  } catch {
    return [];
  }
  files.sort();
  return files.map(readList).filter((l): l is ProspectList => l !== null);
}
