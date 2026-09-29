import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TITLES, resolveCompanyOptions, searchContacts, titlesForGroups, type Company } from "./apollo";
import { contactsForCompany } from "./contacts";
import { writeFileAtomic } from "./contactDb";
import { fetchJobText } from "./jobText";
import { classifyVariant, type Email, type Variant } from "./personalize";
import { profile } from "./profile";
import { alreadyContacted, normCompany, outreachRows } from "./tracker";

// ── Applied: Tsenta applications → warmreach outreach ────────────────────────
// Tsenta applies; this module turns each submitted application into outreach.
//
// Tsenta has no public API, only an MCP connector, so a Claude session is the
// bridge: it pulls submitted applications and hands them to importApplications()
// (via `npm run applied -- import` or POST /api/applied/import). Everything
// after that is local.
//
// This module only does the FREE half — no Apollo credits and no Claude calls.
// prepare() reads the posting, resolves the company, people-searches it (free)
// and picks the best people by title. Everything after that — writing the
// emails, revealing addresses, drafting, sending — happens in an ordinary
// Applications workspace that toWorkspace() pre-fills up to step 2, and that
// the Applications page adds on its own (claimPending).
//
// State lives in one JSON file. Every write is a synchronous read-modify-write,
// so concurrent requests in the one Node process can't interleave a lost update.

const DIR = path.resolve("data/applied");
const STORE = path.join(DIR, "applications.json");
const RESUME_DIR = path.join(DIR, "resumes");

const SEARCH_CAP = 300; // Apollo people-search, free — bounded
const KEEP = 40; // people kept per application for the page
export const DEFAULT_PICK = 3;

// Stored status. The list adds "opened" and "drafted" on top, derived from
// openedAt and the outreach log (drafting happens on the Applications page).
// "drafted" is only ever stored by the first version of this feature, which
// drafted on its own page and kept the drafts in `drafts` (see LegacyDraft).
export type Status = "new" | "preparing" | "review" | "stuck" | "drafted";

/** Drafts made by the first version's own page — carried into the workspace. */
export interface LegacyDraft {
  personId: string;
  name: string;
  title: string;
  email: string;
  variant: Variant;
  draftId: string;
  sentAt: string | null;
}

export interface Person {
  id: string; // Apollo person id, or "file:<email>" for someone already on file
  firstName: string;
  title: string;
  source: "apollo" | "file";
  email: string | null; // known up front only for "file" people
  variant: Variant;
  fit: "high" | "medium" | null;
  reason: string;
  picked: boolean;
}

export interface Skipped {
  name: string;
  title: string;
  reason: string;
}

export interface Org {
  name: string;
  domain: string | null;
  orgId: string | null;
  description: string | null;
  keywords: string[];
  logoUrl: string | null;
}

export interface Application {
  id: string; // Tsenta applicationId
  company: string; // as Tsenta recorded it
  companyWebsite: string | null;
  role: string | null;
  url: string | null;
  ats: string | null;
  appliedAt: string;
  importedAt: string;
  status: Status;
  error: string | null;
  jd: string | null;
  jdSource: string | null;
  org: Org | null;
  found: number;
  people: Person[];
  skipped: Skipped[];
  emails: Record<Variant, Email> | null;
  templateId: string | null;
  instructions: string;
  resumePath: string | null; // the PDF Tsenta submitted, cached locally
  preparedAt: string | null;
  openedAt: string | null; // turned into an Applications workspace
  drafts?: LegacyDraft[]; // first version only; read, never written
}

// ── store ────────────────────────────────────────────────────────────────────

function readAll(): Record<string, Application> {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8")) as Record<string, Application>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Application>): void {
  fs.mkdirSync(DIR, { recursive: true });
  writeFileAtomic(STORE, JSON.stringify(all, null, 1));
}

export function listApplications(): Application[] {
  return Object.values(readAll()).sort((a, b) => Date.parse(b.appliedAt) - Date.parse(a.appliedAt));
}

export function getApplication(id: string): Application | null {
  return readAll()[id] ?? null;
}

/** Synchronous read-modify-write of one application. Returns the new value. */
export function updateApplication(id: string, fn: (a: Application) => Application | void): Application {
  const all = readAll();
  const cur = all[id];
  if (!cur) throw new Error(`No application ${id}`);
  const draft = structuredClone(cur);
  const next = (fn(draft) ?? draft) as Application;
  all[id] = next;
  writeAll(all);
  return next;
}

// ── import (the Tsenta bridge lands here) ───────────────────────────────────

// Accepts rows from either Tsenta tool: list-applications (applicationId, url,
// jobTitle, companyWebsite, status) or list-tracked-applications (positionTitle,
// applicationUrl, dateApplied). The bridge may add jobDescription (Tsenta's
// scrape, for a posting we can't read) and resumePdfUrl (a short-lived signed
// link to the submitted résumé, so it has to be downloaded at import time).
export interface TsentaRow {
  applicationId?: string;
  companyName?: string;
  companyWebsite?: string | null;
  jobTitle?: string | null;
  positionTitle?: string | null;
  url?: string | null;
  applicationUrl?: string | null;
  atsType?: string | null;
  status?: string | null;
  jobStatus?: string | null;
  createdAt?: string;
  updatedAt?: string;
  dateApplied?: string;
  jobDescription?: string | null;
  resumePdfUrl?: string | null;
}

export interface ImportResult {
  addedIds: string[];
  added: number;
  updated: number;
  skipped: number;
  resumes: number;
  resumeErrors: string[];
}

function resumeFileFor(id: string): string {
  // The attachment's filename is what the recruiter sees, so it keeps the name
  // of your own résumé file — never the Tsenta application id.
  return path.join(RESUME_DIR, id, path.basename(profile.resumePath) || "Resume.pdf");
}

async function downloadResume(id: string, url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("not a PDF");
  const file = resumeFileFor(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}

// list-applications statuses for work that never reached the employer.
const NOT_SUBMITTED = /^(READY|RUNNING|OPTIMIZING_|PENDING_|FAILED|SKIPPED)/;

export async function importApplications(rows: TsentaRow[]): Promise<ImportResult> {
  const out: ImportResult = { addedIds: [], added: 0, updated: 0, skipped: 0, resumes: 0, resumeErrors: [] };
  const now = new Date().toISOString();
  const all = readAll();

  const toFetch: { id: string; url: string }[] = [];
  for (const r of rows) {
    const id = r.applicationId?.trim();
    const company = r.companyName?.trim();
    const state = (r.status ?? r.jobStatus ?? "COMPLETED").toUpperCase();
    // Only submitted applications. list-applications says COMPLETED; tracker rows
    // (APPLIED, INTERVIEWING, …) exist only once submitted, so those count too.
    if (!id || !company || NOT_SUBMITTED.test(state)) {
      out.skipped++;
      continue;
    }
    const role = r.jobTitle?.trim() || r.positionTitle?.trim() || null;
    const url = r.url?.trim() || r.applicationUrl?.trim() || null;
    const jd = r.jobDescription?.trim() || null;
    const existing = all[id];

    if (!existing) {
      all[id] = {
        id,
        company,
        companyWebsite: r.companyWebsite?.trim() || null,
        role,
        url,
        ats: r.atsType ?? null,
        appliedAt: r.dateApplied ?? r.updatedAt ?? r.createdAt ?? now,
        importedAt: now,
        status: "new",
        error: null,
        jd,
        jdSource: jd ? "tsenta" : null,
        org: null,
        found: 0,
        people: [],
        skipped: [],
        emails: null,
        templateId: null,
        instructions: "",
        resumePath: null,
        preparedAt: null,
        openedAt: null,
      };
      out.added++;
      out.addedIds.push(id);
    } else {
      // Fill gaps only. Never touch status, people, emails or drafts — a re-sync
      // must not undo work already done in warmreach.
      let changed = false;
      if (!existing.role && role) { existing.role = role; changed = true; }
      if (!existing.url && url) { existing.url = url; changed = true; }
      if (!existing.companyWebsite && r.companyWebsite) { existing.companyWebsite = r.companyWebsite; changed = true; }
      if (!existing.jd && jd) {
        existing.jd = jd;
        existing.jdSource = "tsenta";
        if (existing.status === "stuck") { existing.status = "new"; existing.error = null; }
        changed = true;
      }
      if (changed) out.updated++;
    }

    const cached = all[id].resumePath && fs.existsSync(all[id].resumePath!);
    if (r.resumePdfUrl && !cached) toFetch.push({ id, url: r.resumePdfUrl });
  }
  writeAll(all);

  // Downloads after the write, so a slow or failed download never loses the
  // import itself. Each success is its own small update.
  for (const { id, url } of toFetch) {
    try {
      const file = await downloadResume(id, url);
      updateApplication(id, (a) => { a.resumePath = file; });
      out.resumes++;
    } catch (e: any) {
      out.resumeErrors.push(`${all[id].company}: ${e?.message ?? "download failed"}`);
    }
  }
  return out;
}

// ── prepare (free of Apollo credits) ────────────────────────────────────────

// Most postings carry a title on the board's API; for pasted text, the first
// short line usually is one ("SUPPORT ENGINEER I (NYC, WEEKEND SHIFT)").
function titleFromText(jd: string): string | null {
  const first = jd.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (!first || first.length > 90 || /[.!?]$/.test(first)) return null;
  const isShouting = first === first.toUpperCase();
  return isShouting ? first.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : first;
}

// ── who to pick, from job titles alone ──────────────────────────────────────
// Prepare makes no model calls, so ranking is by title: recruiters first (the
// specific ones before a bare "Talent"), then the people who run the team the
// role sits in, then other leads. Founders rank high only at small companies,
// where they still do the hiring. "On topic" means the title shares a real word
// with the role — "Support Engineering Manager" for a Support Engineer role.

const RECRUIT_RE = /\b(recruit\w*|talent|people ops|people operations|head of people)\b/i;
const LEAD_RE = /\b(cto|chief technology|vp|vice president|head of|director|manager|lead|principal|staff|architect)\b/i;
const FOUNDER_RE = /\b(founder|co-?founder|ceo|chief executive)\b/i;
const SMALL_COMPANY = 200;

const ROLE_STOP = new Set([
  "engineer", "engineering", "software", "developer", "development", "senior", "junior", "staff", "lead",
  "principal", "the", "and", "for", "with", "new", "york", "remote", "hybrid", "onsite", "nyc", "shift",
  "weekend", "full", "time", "part", "program", "programme", "year", "intern", "internship", "associate",
  "level", "united", "states", "usa", "graduate", "grad", "university", "early", "career", "entry",
]);

function roleWords(role: string): string[] {
  const words = role.replace(/\([^)]*\)/g, " ").toLowerCase().split(/[^a-z]+/);
  return [...new Set(words.filter((w) => w.length >= 3 && !ROLE_STOP.has(w)))];
}

// "Executive Assistant to the CEO" is not the CEO: only the part of a title that
// describes the person's own job counts (same rule as Harvest's groupOf).
const ownRole = (title: string) => (title ?? "").split(/\s+to\s+|\s*[|·]\s*|\s+at\s+/i)[0];

function titleScore(title: string, words: string[], small: boolean): number {
  const own = ownRole(title);
  const t = own.toLowerCase();
  const onTopic = words.some((w) => t.includes(w));
  if (RECRUIT_RE.test(own)) {
    if (/technical recruit/i.test(own)) return 0;
    if (/recruit|talent acquisition|talent partner/i.test(own)) return 0.1;
    return own.trim().split(/\s+/).length < 2 ? 0.4 : 0.2; // a bare "Talent" says least
  }
  if (FOUNDER_RE.test(own)) return small ? 0.6 : 2.2;
  if (LEAD_RE.test(own)) return onTopic ? 0.5 : 1;
  return onTopic ? 2 : 3;
}

const isRecruiter = (p: Person) => RECRUIT_RE.test(ownRole(p.title));

// Default pick: the best recruiter plus the two people closest to the team —
// the recruiter and the hiring side read different emails — topped up from
// whatever is left if either side is missing.
function pickDefaults(people: Person[]): void {
  const recruiters = people.filter(isRecruiter);
  const team = people.filter((p) => !isRecruiter(p));
  const chosen = new Set([...recruiters.slice(0, 1), ...team.slice(0, DEFAULT_PICK - 1)].map((p) => p.id));
  for (const p of people) {
    if (chosen.size >= DEFAULT_PICK) break;
    chosen.add(p.id);
  }
  for (const p of people) p.picked = chosen.has(p.id);
}

const key = (first: string, title: string) =>
  `${(first ?? "").trim().toLowerCase()}|${(title ?? "").trim().toLowerCase().replace(/\s+/g, " ")}`;

// People already emailed at this company, from the outreach log. Apollo search
// hides emails, so first name + title is the identity we can match on here; the
// email itself is checked again at draft time, after it's revealed.
function loggedAtCompany(org: Org, company: string): Map<string, string> {
  const names = new Set([normCompany(org.name), normCompany(company)]);
  const out = new Map<string, string>();
  for (const row of outreachRows()) {
    if (!names.has(normCompany(row.company))) continue;
    const first = row.name.split(/\s+/)[0] ?? "";
    const k = key(first, row.title);
    if (!out.has(k)) out.set(k, row.timestamp);
  }
  return out;
}

function shortDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "earlier" : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── which company is this? ───────────────────────────────────────────────────
// Name search is not safe here: Apollo's "Oura" is a coconut brand, its "Hive"
// is hive.app rather than thehive.ai, and the real companies aren't always in
// the results at all. A wrong company means emailing the wrong people, so the
// employer is resolved by WEBSITE only: the website Tsenta or the user gave,
// else candidates read off the posting (its careers page, the links on the job
// page, domains in the text, the board's slug) — each confirmed by Apollo's
// domain lookup AND a match against the name Tsenta applied under.

const ATS_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com|workable\.com|smartrecruiters\.com|oraclecloud\.com|ultipro\.com|ukg\.com|rippling\.com|rippling-ats\.com|pinpointhq\.com|adp\.com|applytojob\.com|jazzhr\.com|breezy\.hr|bamboohr\.com|icims\.com|taleo\.net|successfactors\.(com|eu)|jobvite\.com|recruitee\.com|teamtailor\.com|dover\.com|wellfound\.com|linkedin\.com|indeed\.com)$/i;

function registrable(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".");
  // example.co.uk keeps three labels; example.com keeps two.
  const n = parts.length >= 3 && parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3 ? 3 : 2;
  return parts.slice(-n).join(".");
}

function careersDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return ATS_HOSTS.test(host) ? null : registrable(host);
  } catch {
    return null;
  }
}

// Names must match exactly once the noise is gone: accents, punctuation,
// spacing, and suffixes like Inc / LLC / SE & Co. KGaA / AI / Labs. Not "contains"
// — that let "Aircalls" pass for "Aircall", which is a different company.
const NAME_NOISE = new Set([
  "inc", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "plc", "gmbh", "ag", "se", "kgaa",
  "sa", "bv", "nv", "pvt", "pte", "holdings", "group", "the", "ai", "labs", "lab", "hq", "technologies",
  "technology", "tech", "software", "systems", "solutions", "global", "io",
]);

function nameKey(s: string): string {
  const words = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const kept = words.filter((w) => !NAME_NOISE.has(w));
  return (kept.length ? kept : words).join("");
}

function namesAgree(a: string, b: string): boolean {
  const x = nameKey(a);
  return !!x && x === nameKey(b);
}

// Hosts that appear on job pages but are never the employer.
const NOISE_HOSTS = /(^|\.)(google|gstatic|googleapis|googletagmanager|doubleclick|youtube|linkedin|twitter|x|facebook|instagram|tiktok|glassdoor|indeed|cloudflare|cloudfront|jsdelivr|jquery|w3|schema|onetrust|cookielaw|hcaptcha|recaptcha|apple|microsoft|wikipedia|github|medium|vimeo|hubspot|bit)\.[a-z.]+$|\.gov$|\.mil$|\.edu$/i;

const TIMEOUT_MS = 12_000;

async function pageHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
    });
    return res.ok ? await res.text() : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// The board's own name for the company: greenhouse "for=neweratech" or
// /oura/jobs/…, lever /hive/…, ashby /replit/…, workday's tenant subdomain.
function boardSlug(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const first = u.pathname.split("/").filter(Boolean)[0] ?? "";
    if (host.endsWith("greenhouse.io")) return u.searchParams.get("for") || (first !== "embed" ? first : null);
    if (["jobs.lever.co", "jobs.ashbyhq.com", "ats.rippling.com", "apply.workable.com", "jobs.smartrecruiters.com"].includes(host)) {
      return first || null;
    }
    if (host.endsWith(".myworkdayjobs.com") || host.endsWith(".breezy.hr")) return host.split(".")[0];
    return null;
  } catch {
    return null;
  }
}

// "aircallioinc" → aircall.io, "skildai-careers" → skild.ai, "Wisdom-AI" → wisdom.ai.
function slugDomains(slug: string): string[] {
  let base = slug.toLowerCase();
  const hadIo = /io(inc|llc)?$/.test(base.replace(/[^a-z0-9]/g, ""));
  for (let prev = ""; prev !== base; ) {
    prev = base;
    base = base.replace(/[-_]?(careers?|jobs?|hiring|external|inc|llc|hq)$/, "");
  }
  const compact = base.replace(/[^a-z0-9]/g, "");
  if (!compact) return [];
  const out: string[] = [];
  const noIo = compact.replace(/io$/, "");
  if (hadIo && noIo.length >= 3) out.push(`${noIo}.io`);
  if (compact.endsWith("ai") && compact.length > 4) out.push(`${compact.slice(0, -2)}.ai`);
  out.push(`${compact}.com`, `${compact}.ai`, `${compact}.io`, `${compact}.org`);
  return out;
}

/** Candidate employer websites, most trustworthy first. None of them is used unchecked. */
async function websiteCandidates(a: Application, jd: string): Promise<string[]> {
  const out: string[] = [];
  const add = (host: string | null | undefined) => {
    if (!host) return;
    const h = host.toLowerCase().replace(/^www\./, "");
    if (!h.includes(".") || ATS_HOSTS.test(h) || NOISE_HOSTS.test(h)) return;
    const d = registrable(h);
    if (!out.includes(d)) out.push(d);
  };

  // 1. The careers page itself, when it isn't a job board.
  add(careersDomain(a.url));

  // 2. The board's own name for the company, as a domain. Exact name match
  // required, so a wrong guess costs one free lookup and nothing else.
  const slug = boardSlug(a.url);
  if (slug) for (const d of slugDomains(slug)) add(d);

  // 3. Links on the job page — boards link the logo to the company's site.
  if (a.url) {
    const counts = new Map<string, number>();
    for (const m of (await pageHtml(a.url)).matchAll(/href="https?:\/\/([^/"?#:]+)/gi)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    [...counts.entries()].sort((x, y) => y[1] - x[1]).forEach(([h]) => add(h));
  }

  // 4. Domains written into the posting ("Learn more at neweratech.com").
  for (const m of jd.matchAll(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ai|io|co|net|org|tech|app|dev|us))\b/gi)) add(m[1]);

  return out.slice(0, 12);
}

async function byDomain(domain: string): Promise<Company | null> {
  try {
    return (await resolveCompanyOptions(domain))[0] ?? null;
  } catch {
    return null;
  }
}

async function resolveEmployer(a: Application, jd: string): Promise<Company | null> {
  // A website Tsenta recorded or the user typed is trusted as given.
  if (a.companyWebsite) {
    const hit = await byDomain(registrable(a.companyWebsite.replace(/^https?:\/\//, "").split("/")[0]));
    if (hit) return hit;
  }
  // Everything else must also match the name Tsenta applied under.
  for (const domain of await websiteCandidates(a, jd)) {
    const hit = await byDomain(domain);
    if (hit && namesAgree(hit.name, a.company)) return hit;
  }
  return null;
}

/**
 * Find the people and write the emails. Spends no Apollo credits: people-search
 * is free, and nobody's email is revealed here. Leaves the application at
 * "review", or at "stuck" with a reason the page can act on.
 */
export async function prepare(id: string): Promise<Application> {
  const start = getApplication(id);
  if (!start) throw new Error(`No application ${id}`);
  // Its workspace owns it now (or it was drafted) — don't rewrite underneath it.
  if (start.openedAt || start.status === "drafted") return start;
  updateApplication(id, (a) => { a.status = "preparing"; a.error = null; });

  const stuck = (error: string) => updateApplication(id, (a) => { a.status = "stuck"; a.error = error; });

  try {
    // 1. The posting. A board API gives the real title too.
    let jd = start.jd;
    let jdSource = start.jdSource;
    let role = start.role;
    if (!jd) {
      const fetched = await fetchJobText(start.url);
      if (fetched) {
        jd = fetched.text;
        jdSource = fetched.source;
        role = role || fetched.title || null;
      }
    }
    // A posting we can't read doesn't block step 2 — finding people needs only
    // the company and the role, and Tsenta gives the role. The description only
    // matters later, for writing emails, and can be pasted on Applications.
    role = role || (jd ? titleFromText(jd) : null) || "the role";
    // Saved now, not at the end: if a later step gets stuck, the page should ask
    // for what's actually missing, not for a posting we already read.
    const readJd = jd;
    const readSource = jdSource;
    const readRole = role;
    updateApplication(id, (a) => { a.jd = readJd; a.jdSource = readSource; a.role = readRole; });

    // 2. The company — by website, never by name alone (see resolveEmployer).
    const company = await resolveEmployer(start, jd ?? "");
    if (!company) {
      return stuck(`Couldn’t tell which company “${start.company}” is. Enter its website to continue.`);
    }
    const org: Org = {
      name: company.name,
      domain: company.domain ?? null,
      orgId: company.orgId ?? null,
      description: company.description,
      keywords: company.keywords,
      logoUrl: company.logoUrl ?? null,
    };

    // 3. People: on file first (emails known, free), then Apollo (free to search).
    const skipped: Skipped[] = [];
    const people: Person[] = [];
    const seen = new Set<string>();

    for (const c of contactsForCompany(org.name, org.domain)) {
      if (!c.email) continue;
      if (alreadyContacted(c.email)) {
        skipped.push({ name: c.firstName, title: c.title, reason: "already emailed" });
        seen.add(key(c.firstName, c.title));
        continue;
      }
      const k = key(c.firstName, c.title);
      if (seen.has(k)) continue;
      seen.add(k);
      people.push({
        id: `file:${c.email.toLowerCase()}`,
        firstName: c.firstName,
        title: c.title,
        source: "file",
        email: c.email,
        variant: classifyVariant(c.title),
        fit: null,
        reason: "",
        picked: false,
      });
    }

    const titles = [...new Set([...DEFAULT_TITLES, ...titlesForGroups(["founders", "engineering", "recruiters"])])];
    // US first, like the Applications page's default. A company with nobody
    // reachable in the US (Fospha, Bertelsmann) is searched everywhere instead.
    let found = await searchContacts(company, titles, SEARCH_CAP, ["United States"]);
    if (!found.some((p) => p.has_email)) found = await searchContacts(company, titles, SEARCH_CAP, []);
    const logged = loggedAtCompany(org, start.company);
    for (const p of found) {
      if (!p.has_email) continue;
      const k = key(p.first_name, p.title);
      if (seen.has(k)) continue;
      seen.add(k);
      const when = logged.get(k);
      if (when) {
        skipped.push({ name: p.first_name, title: p.title, reason: `already emailed on ${shortDate(when)}` });
        continue;
      }
      people.push({
        id: p.id,
        firstName: p.first_name,
        title: p.title ?? "",
        source: "apollo",
        email: null,
        variant: classifyVariant(p.title ?? ""),
        fit: null,
        reason: "",
        picked: false,
      });
    }
    if (people.length === 0) {
      return stuck(`No one at ${org.name} has an email Apollo can reveal.`);
    }

    // 4. Rank by title. No model call: preparing is free of Claude as well as
    // Apollo — writing the emails is left to the Applications page.
    const words = roleWords(role);
    const small = (company.employees ?? Infinity) <= SMALL_COMPANY;
    const score = new Map(people.map((p) => [p.id, titleScore(p.title, words, small)]));
    people.sort((a, b) =>
      score.get(a.id)! - score.get(b.id)! ||
      (a.source === "file" ? -1 : 0) - (b.source === "file" ? -1 : 0));
    const kept = people.slice(0, KEEP);
    pickDefaults(kept);
    // The picked people lead the list, so what's ticked is what you see first.
    kept.sort((a, b) => Number(b.picked) - Number(a.picked));

    updateApplication(id, (a) => {
      a.jd = jd;
      a.jdSource = jdSource;
      a.role = role;
      a.org = org;
      a.found = found.length;
      a.people = kept;
      a.skipped = skipped.slice(0, 20);
    });
    return updateApplication(id, (a) => {
      a.status = "review";
      a.preparedAt = new Date().toISOString();
    });
  } catch (e: any) {
    return stuck(e?.message ?? "Preparing failed.");
  }
}

// ── hand-off to the Applications page ───────────────────────────────────────
// Drafting, sending and scheduling happen in an ordinary Applications workspace:
// toWorkspace() turns a prepared application into that page's WorkspaceSnapshot
// (the exact shape it already persists), and the browser saves it as a new tab.
// So the draft goes through /api/draft like any other, with Tsenta's résumé as
// the tab's attachment and on-file people marked "csv" (free, no enrichment).

export function creditsFor(a: Application): { picked: number; credits: number; free: number } {
  const picked = a.people.filter((p) => p.picked);
  const credits = picked.filter((p) => p.source === "apollo").length;
  return { picked: picked.length, credits, free: picked.length - credits };
}

// Stops at step 2 — people found and picked, no emails. Writing them is the
// user's call on the Applications page (Generate emails, templates, presets).
// Only an application the first version already drafted carries its emails,
// because its drafts were made from them.
export function toWorkspace(a: Application) {
  if (!a.org || !a.role) throw new Error("Prepare this application first.");
  const legacy = a.drafts?.length ? a.drafts : [];
  return {
    company: a.org.name,
    role: a.role,
    jd: a.jd ?? "",
    groups: ["founders", "engineering", "recruiters"],
    customTitles: "",
    allPeople: false,
    wantCareers: false,
    instructions: "",
    country: "us",
    resolved: a.org,
    totalFound: a.found,
    searchSource: "apollo" as const,
    candidates: a.people.map((p) => ({
      id: p.id,
      firstName: p.firstName,
      lastName: null,
      title: p.title,
      source: p.source === "file" ? ("csv" as const) : ("apollo" as const),
      email: p.email,
      confidence: null,
      fit: p.fit ? { priority: p.fit, reason: p.reason } : null,
    })),
    selected: a.people.filter((p) => p.picked).map((p) => p.id),
    templates: legacy.length ? a.emails : null,
    // Drafts the first version already made show up as drafted rows, with
    // Send / Schedule, instead of the people looking undrafted.
    results: Object.fromEntries(legacy.map((d) => [d.personId, {
      id: d.personId,
      name: d.name,
      title: d.title,
      email: d.email,
      status: "drafted" as const,
      draftId: d.draftId,
      subject: a.emails![d.variant].subject,
      emailSource: "apollo" as const,
      resumeAttached: true,
    }])),
    sentIds: legacy.filter((d) => d.sentAt).map((d) => d.draftId),
    resumePath: a.resumePath && fs.existsSync(a.resumePath) ? a.resumePath : "",
  };
}

const isReady = (a: Application) => (a.status === "review" || a.status === "drafted") && !!a.org && !!a.role;

/**
 * Every prepared application the Applications page hasn't taken yet, as
 * workspaces — marked opened in the same synchronous step, so two browser tabs
 * loading at once can't both add the same one. If a tab gets lost anyway, the
 * Applied list's "Open" rebuilds it from the store.
 */
export function claimPending(): { id: string; workspace: ReturnType<typeof toWorkspace>; logoUrl: string | null }[] {
  const all = readAll();
  const now = new Date().toISOString();
  const out = Object.values(all)
    .filter((a) => isReady(a) && !a.openedAt)
    .sort((x, y) => Date.parse(y.appliedAt) - Date.parse(x.appliedAt))
    .map((a) => {
      a.openedAt = now;
      return { id: a.id, workspace: toWorkspace(a), logoUrl: a.org?.logoUrl ?? null };
    });
  if (out.length) writeAll(all);
  return out;
}

/** Prepare several applications, a few at a time. Free — Apollo search + page fetches. */
export async function prepareMany(ids: string[], onDone?: (a: Application) => void, concurrency = 3): Promise<void> {
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        const a = await prepare(id);
        onDone?.(a);
      } catch (err) {
        console.error(`[applied] prepare failed for ${id}:`, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

export function markOpened(id: string): void {
  updateApplication(id, (a) => { a.openedAt = a.openedAt ?? new Date().toISOString(); });
}

/**
 * Drafts made from this application, read from the outreach log — the
 * Applications page logs every draft there with its company and role.
 */
export function draftCounts(): (a: Application) => number {
  const byKey = new Map<string, string[]>();
  for (const r of outreachRows()) {
    if (!r.draftStatus.startsWith("draft:")) continue;
    const k = `${normCompany(r.company)}|${r.role.trim().toLowerCase()}`;
    const list = byKey.get(k) ?? [];
    list.push(r.timestamp);
    byKey.set(k, list);
  }
  return (a) => {
    // Counted from when it was prepared: any draft for this company and role
    // after that — from its workspace or typed in by hand — is outreach for it.
    if (!a.org || !a.role || !a.preparedAt) return 0;
    const since = Date.parse(a.preparedAt);
    const k = `${normCompany(a.org.name)}|${a.role.trim().toLowerCase()}`;
    return (byKey.get(k) ?? []).filter((t) => Date.parse(t) >= since).length;
  };
}
