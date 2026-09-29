import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "./csv";
import { normCompany, outreachRows } from "./tracker";

// ── Contact store ───────────────────────────────────────────────────────────
// Every person warmreach knows about, from every source, behind one read API.
//
// Storage is deliberately NOT one file. Harvested people are appended to a
// per-company NDJSON shard under data/db/people/<slug>.ndjson, so a crash costs
// at most one company's tail rather than the whole store. The in-memory index
// below is DERIVED — from those shards plus the sources that already existed
// (the Apollo CSV exports, the outreach log, the watchlist) — which means it can
// be thrown away and rebuilt at any time, and the legacy files stay exactly
// where they are. Nothing is migrated; nothing is the only copy of anything.
//
// Dedupe is per PERSON, not per company: a company you hold 45 people at still
// has hundreds you don't. See personKeys() for the identity ladder.

const DB_DIR = path.resolve("data/db/people");
const CSV_DIR = path.resolve("data/contacts");
const WATCHLIST = path.resolve("data/watchlist.json");

export type Source = "csv" | "outreach" | "harvest" | "watchlist";

export interface Person {
  apolloId: string | null; // Apollo person id — exact identity when present
  firstName: string;
  lastName: string;
  fullName: string;
  title: string;
  company: string;
  companyDomain: string | null;
  email: string | null; // null = known to exist but never revealed
  emailStatus: string | null;
  seniority: string | null;
  linkedin: string | null;
  source: Source;
  addedAt: string; // ISO
  contactedAt: string | null; // ISO, from the outreach log
}

// ── identity ────────────────────────────────────────────────────────────────

export function normEmail(e: string | null | undefined): string | null {
  const v = (e ?? "").trim().toLowerCase();
  return v.includes("@") ? v : null;
}

// linkedin.com/in/jane-doe-08/  ->  jane-doe-08
export function normLinkedin(url: string | null | undefined): string | null {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url ?? "");
  return m ? m[1].toLowerCase().replace(/\/$/, "") : null;
}

// Apollo's FREE people-search does not merely obfuscate the last name — it omits
// it entirely (last_name: null). So the held contact "Oscar Ramirez" and the
// search hit "Oscar" have to be recognized as the same person from first name,
// company, and title alone. nameKey covers the case where a last name IS known
// on both sides; firstKey + title containment covers the case where it isn't.
export function nameKey(first: string, last: string, company: string): string | null {
  const f = (first ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  const c = normCompany(company ?? "");
  if (!f || !c) return null;
  const li = (last ?? "").trim().toLowerCase().replace(/[^a-z]/g, "").slice(0, 1);
  if (!li) return null; // no last name -> this key can't discriminate; use firstKey
  return `${f}|${li}|${c}`;
}

// The last-resort bucket: everyone with this first name at this company.
export function firstKey(first: string, company: string): string | null {
  const f = (first ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  const c = normCompany(company ?? "");
  return f && c ? `${f}|${c}` : null;
}

// Titles drift ("Talent Acquisition" -> "Talent Acquisition Consultant"), so
// compare by containment rather than equality. Used only to decide whether two
// people sharing a first name at one company are actually the same person.
export function titleOverlap(a: string, b: string): boolean {
  const norm = (t: string) => (t ?? "").toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// Every key a person can be recognized by, strongest first. Used both to dedupe
// the index and to decide whether an Apollo search hit is someone we already own.
export function personKeys(p: {
  apolloId?: string | null;
  linkedin?: string | null;
  email?: string | null;
  firstName?: string;
  lastName?: string;
  company?: string;
}): string[] {
  const keys: string[] = [];
  if (p.apolloId) keys.push(`id:${p.apolloId}`);
  const li = normLinkedin(p.linkedin);
  if (li) keys.push(`li:${li}`);
  const em = normEmail(p.email);
  if (em) keys.push(`em:${em}`);
  const nk = nameKey(p.firstName ?? "", p.lastName ?? "", p.company ?? "");
  if (nk) keys.push(`nm:${nk}`);
  return keys;
}

// ── durable writes ──────────────────────────────────────────────────────────

// Write-then-rename. rename(2) is atomic within a filesystem, so a crash leaves
// either the old file or the new one — never a truncated one. The rest of the
// repo still writes in place; this is the pattern to move them to.
export function writeFileAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function companySlug(name: string): string {
  const s = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "unknown";
}

// Append harvested people to their company's shard. Append is the only write
// mode here — existing lines are never rewritten, so a partial write can lose
// the last record but cannot corrupt earlier ones.
export function appendPeople(company: string, people: Person[]): void {
  if (!people.length) return;
  fs.mkdirSync(DB_DIR, { recursive: true });
  const file = path.join(DB_DIR, `${companySlug(company)}.ndjson`);
  fs.appendFileSync(file, people.map((p) => JSON.stringify(p)).join("\n") + "\n");
  INDEX = null; // next read rebuilds
}

// ── index ───────────────────────────────────────────────────────────────────

export interface Index {
  people: Person[];
  byKey: Map<string, Person>; // every key from personKeys() -> person
  byCompany: Map<string, Person[]>; // normCompany(name) -> people
  byFirst: Map<string, Person[]>; // firstKey() -> people, for last-name-less matching
  counts: { total: number; withEmail: number; contacted: number; companies: number };
  bySource: Record<Source, number>;
}

let INDEX: Index | null = null;

function readShards(): Person[] {
  const out: Person[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(DB_DIR).filter((f) => f.endsWith(".ndjson"));
  } catch {
    return out;
  }
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(DB_DIR, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Person);
      } catch {
        // A torn final line from an interrupted append — skip it, keep the rest.
      }
    }
  }
  return out;
}

// The Apollo CSV exports. Unlike contacts.ts (which only needs name/title/email
// for drafting) this keeps the Apollo Contact Id and LinkedIn URL, which are
// present on 100% of the exported rows and give EXACT identity against search.
function readCsvContacts(): Person[] {
  const out: Person[] = [];
  const walk = (dir: string): string[] => {
    let acc: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return acc;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) acc = acc.concat(walk(full));
      else if (e.isFile() && e.name.toLowerCase().endsWith(".csv")) acc.push(full);
    }
    return acc;
  };

  for (const file of walk(CSV_DIR)) {
    let rows: string[][];
    try {
      rows = parseCsv(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (rows.length < 2) continue;
    const h = rows[0].map((x) => x.trim().toLowerCase());
    const col = (...names: string[]) => {
      for (const n of names) {
        const i = h.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    const iFirst = col("first name");
    const iLast = col("last name");
    const iTitle = col("title");
    const iEmail = col("email");
    const iStatus = col("email status");
    const iCompany = col("company name", "company");
    const iSen = col("seniority");
    const iLi = col("person linkedin url");
    const iId = col("apollo contact id");
    const iWeb = col("website");
    if (iFirst < 0 || iEmail < 0) continue;

    const at = fs.statSync(file).mtime.toISOString();
    for (let r = 1; r < rows.length; r++) {
      const c = rows[r];
      const email = normEmail(c[iEmail]);
      if (!email) continue;
      const first = (c[iFirst] ?? "").trim();
      const last = iLast >= 0 ? (c[iLast] ?? "").trim() : "";
      const company = iCompany >= 0 ? (c[iCompany] ?? "").trim() : "";
      const web = iWeb >= 0 ? (c[iWeb] ?? "").trim() : "";
      const domain = email.slice(email.indexOf("@") + 1) || null;
      out.push({
        apolloId: iId >= 0 ? (c[iId] ?? "").trim() || null : null,
        firstName: first,
        lastName: last,
        fullName: [first, last].filter(Boolean).join(" "),
        title: iTitle >= 0 ? (c[iTitle] ?? "").trim() : "",
        company: company || domain || "",
        companyDomain: (web.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || domain) ?? null,
        email,
        emailStatus: iStatus >= 0 ? (c[iStatus] ?? "").trim() || null : null,
        seniority: iSen >= 0 ? (c[iSen] ?? "").trim() || null : null,
        linkedin: iLi >= 0 ? (c[iLi] ?? "").trim() || null : null,
        source: "csv",
        addedAt: at,
        contactedAt: null,
      });
    }
  }
  return out;
}

// Everyone in the outreach log. These carry no Apollo id (the app never stored
// one at draft time), so they match on email — exact once revealed — and on the
// name key. Their value here is the contactedAt stamp.
function readOutreach(): Person[] {
  const out: Person[] = [];
  for (const r of outreachRows()) {
    const email = normEmail(r.email);
    if (!email) continue;
    const parts = (r.name ?? "").trim().split(/\s+/);
    out.push({
      apolloId: null,
      firstName: parts[0] ?? "",
      lastName: parts.slice(1).join(" "),
      fullName: (r.name ?? "").trim(),
      title: r.title ?? "",
      company: r.company ?? "",
      companyDomain: email.slice(email.indexOf("@") + 1) || null,
      email,
      emailStatus: r.emailStatus || null,
      seniority: null,
      linkedin: null,
      source: "outreach",
      addedAt: r.timestamp,
      contactedAt: r.timestamp,
    });
  }
  return out;
}

// The referrer you attached to each watched company. Small, but they're the
// warmest contacts in the whole store, so they belong in it.
function readWatchlist(): Person[] {
  const out: Person[] = [];
  let list: any[];
  try {
    list = JSON.parse(fs.readFileSync(WATCHLIST, "utf8"));
  } catch {
    return out;
  }
  for (const w of Array.isArray(list) ? list : []) {
    const c = w?.contact;
    const name = (c?.name ?? "").trim();
    if (!name) continue;
    const parts = name.split(/\s+/);
    out.push({
      apolloId: null,
      firstName: parts[0] ?? "",
      lastName: parts.slice(1).join(" "),
      fullName: name,
      title: c?.title ?? "",
      company: w?.name ?? "",
      companyDomain: w?.domain ?? null,
      email: normEmail(c?.email),
      emailStatus: null,
      seniority: null,
      linkedin: null,
      source: "watchlist",
      addedAt: w?.createdAt ?? new Date().toISOString(),
      contactedAt: null,
    });
  }
  return out;
}

// Later sources win on conflict, so order matters: CSV first (richest — real
// Apollo ids), then harvest, then outreach (which contributes contactedAt), then
// the watchlist. merge() only ever fills blanks, so nothing rich is overwritten
// by something thin.
function merge(into: Person, from: Person): void {
  into.apolloId ??= from.apolloId;
  into.linkedin ??= from.linkedin;
  into.email ??= from.email;
  into.emailStatus ??= from.emailStatus;
  into.seniority ??= from.seniority;
  into.companyDomain ??= from.companyDomain;
  if (!into.title && from.title) into.title = from.title;
  if (!into.company && from.company) into.company = from.company;
  if (!into.lastName && from.lastName) into.lastName = from.lastName;
  if (from.contactedAt && (!into.contactedAt || from.contactedAt > into.contactedAt)) {
    into.contactedAt = from.contactedAt;
  }
}

export function buildIndex(): Index {
  const people: Person[] = [];
  const byKey = new Map<string, Person>();

  const add = (p: Person) => {
    const keys = personKeys(p);
    let hit: Person | undefined;
    for (const k of keys) {
      const found = byKey.get(k);
      if (found) {
        hit = found;
        break;
      }
    }
    if (hit) {
      merge(hit, p);
      // The merge may have produced new identity (e.g. an email), so re-key.
      for (const k of personKeys(hit)) byKey.set(k, hit);
      return;
    }
    people.push(p);
    for (const k of keys) byKey.set(k, p);
  };

  for (const p of readCsvContacts()) add(p);
  for (const p of readShards()) add(p);
  for (const p of readOutreach()) add(p);
  for (const p of readWatchlist()) add(p);

  const byCompany = new Map<string, Person[]>();
  const byFirst = new Map<string, Person[]>();
  const bySource: Record<Source, number> = { csv: 0, outreach: 0, harvest: 0, watchlist: 0 };
  let withEmail = 0;
  let contacted = 0;
  for (const p of people) {
    bySource[p.source]++;
    if (p.email) withEmail++;
    if (p.contactedAt) contacted++;
    const fk = firstKey(p.firstName, p.company);
    if (fk) {
      const fa = byFirst.get(fk);
      if (fa) fa.push(p);
      else byFirst.set(fk, [p]);
    }
    const k = normCompany(p.company);
    if (!k) continue;
    const arr = byCompany.get(k);
    if (arr) arr.push(p);
    else byCompany.set(k, [p]);
  }

  return {
    people,
    byKey,
    byCompany,
    byFirst,
    counts: { total: people.length, withEmail, contacted, companies: byCompany.size },
    bySource,
  };
}

export function getIndex(): Index {
  if (!INDEX) INDEX = buildIndex();
  return INDEX;
}

export function invalidateIndex(): void {
  INDEX = null;
}

// People we hold for a company, by normalized name and/or email domain.
export function peopleForCompany(name: string, domain?: string | null): Person[] {
  const idx = getIndex();
  const seen = new Set<Person>();
  for (const p of idx.byCompany.get(normCompany(name)) ?? []) seen.add(p);
  if (domain) {
    const d = domain.toLowerCase().replace(/^www\./, "");
    for (const p of idx.people) {
      if (p.companyDomain && p.companyDomain.toLowerCase().replace(/^www\./, "") === d) seen.add(p);
    }
  }
  return [...seen];
}

// Do we already own this person? The question the whole harvest flow turns on.
export function alreadyHave(p: {
  apolloId?: string | null;
  linkedin?: string | null;
  email?: string | null;
  firstName?: string;
  lastName?: string;
  title?: string;
  company?: string;
}): Person | null {
  const idx = getIndex();
  for (const k of personKeys(p)) {
    const hit = idx.byKey.get(k);
    if (hit) return hit;
  }

  // Nothing exact matched. If the caller has no last name to offer — which is
  // every hit off Apollo's free search — fall back to first name + company,
  // disambiguated by title. One held "Oscar" at OpenAI and an incoming "Oscar"
  // is the same person; two held Oscars means we need the title to agree before
  // spending (or not spending) a credit on the third.
  if (!(p.lastName ?? "").trim()) {
    const fk = firstKey(p.firstName ?? "", p.company ?? "");
    const bucket = fk ? idx.byFirst.get(fk) : undefined;
    if (bucket?.length === 1) return bucket[0];
    if (bucket && bucket.length > 1) {
      const byTitle = bucket.find((h) => titleOverlap(h.title, p.title ?? ""));
      if (byTitle) return byTitle;
      // Same first name, several people, no title agrees: treat as someone new.
      // Re-buying one duplicate costs a credit; skipping a real person costs a
      // contact we can't get back once these credits expire.
      return null;
    }
  }
  return null;
}
