import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TITLES, resolveCompanyOptions, searchContacts, titlesForGroups, type Company } from "./apollo";
import { contactsCompanyList, contactsForCompany } from "./contacts";
import { writeFileAtomic } from "./contactDb";
import { fetchJobText } from "./jobText";
import { classifyVariant, type Email, type Variant } from "./personalize";
import { profile } from "./profile";
import { alreadyContacted, contactedCompanies, normCompany, outreachRows } from "./tracker";
import { domainSearch, hunterConfigured } from "./hunter";
import { readScanResult } from "./followups";

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
// The board's Start adds two more: "writing" while a model writes the emails,
// "ready" once they're written and the row waits for review.
export type Status = "new" | "preparing" | "review" | "writing" | "ready" | "stuck" | "drafted";

/** Tsenta's own tab for the application. Only "submitted" can be started. */
export type Bucket = "submitted" | "in_flight" | "needs" | "failed" | "skipped";

/** The column on Tsenta's tracker (kanban). */
export type Pipeline = "APPLIED" | "GHOSTED" | "INTERVIEWING" | "REJECTED" | "OFFER";

/** Why a run stopped: the board shows each one differently. */
export type StuckReason = "company" | "no_emails" | "contacted" | "other";

/** What Start was told to do — kept on the row so a resumed run does the same. */
export interface StartOptions {
  templateId: string | null; // saved template the emails adapt; null = written from scratch
  presetId: string | null; // prompt preset added to the instructions
  pick: number; // people per company
  roles: { recruiter: boolean; team: boolean; founders: boolean };
  resumeFallback: "wait" | "base"; // when Tsenta's résumé isn't in yet
}

export const DEFAULT_START: StartOptions = {
  templateId: null,
  presetId: null,
  pick: 3,
  roles: { recruiter: true, team: true, founders: true },
  resumeFallback: "wait",
};

/** get-job-details fields, when Tsenta has them. */
export interface JobDetails {
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  yearsExperience: number | null;
  sponsorship: boolean | null;
  employmentType: string | null;
  roleFamily: string | null;
}

/** One message from Tsenta's inbox, as its category says. */
export interface InboxSignal {
  category: string; // INTERVIEW, OFFER, REJECTION, ASSESSMENT, REMINDER, ACKNOWLEDGMENT, GENERAL
  subject: string;
  at: string;
}

/** A draft made from the review queue. */
export interface BoardDraft {
  personId: string;
  name: string;
  title: string;
  email: string;
  variant: Variant;
  draftId: string;
  at: string;
  sentAt: string | null;
}

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
  source: "apollo" | "file" | "hunter";
  email: string | null; // known up front for "file" and "hunter" people
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
  employees?: number | null;
  industry?: string | null;
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

  // ── from Tsenta, refreshed on every sync (absent on rows imported before the board)
  bucket?: Bucket;
  tsentaState?: string | null; // raw status, e.g. COMPLETED, PENDING_RESUME_REVIEW
  jobId?: string | null;
  locations?: string[];
  skillTags?: string[];
  tailored?: boolean | null; // Tsenta submitted an optimized résumé
  resumeProfileId?: string | null;
  tsentaUpdatedAt?: string | null;
  pipeline?: Pipeline | null;
  pipelineHistory?: string[];
  trackerId?: string | null; // the tracker row, for writing notes back
  tsentaNotes?: string | null;
  linkedEmails?: number;
  inbox?: InboxSignal[];
  details?: JobDetails | null;

  // ── the board's run
  stuckReason?: StuckReason | null;
  startedAt?: string | null;
  options?: StartOptions | null;
  emailsAt?: string | null;
  resumeWanted?: boolean; // started without a saved résumé: the next sync fetches it
  boardDrafts?: BoardDraft[];
  noteQueuedAt?: string | null; // "add a note to Tsenta" clicked; the next sync writes it
  notedAt?: string | null;
}

// ── store ────────────────────────────────────────────────────────────────────

// Parsed once per change of the file, not per request: with thousands of rows
// the board reads the whole store on every load. writeAll() keeps the cache in
// step, and an edit from the CLI (another process) changes the mtime.
let cache: { mtimeMs: number; size: number; all: Record<string, Application> } | null = null;

function readAll(): Record<string, Application> {
  try {
    const st = fs.statSync(STORE);
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.all;
    const all = JSON.parse(fs.readFileSync(STORE, "utf8")) as Record<string, Application>;
    cache = { mtimeMs: st.mtimeMs, size: st.size, all };
    return all;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Application>): void {
  fs.mkdirSync(DIR, { recursive: true });
  writeFileAtomic(STORE, JSON.stringify(all));
  try {
    const st = fs.statSync(STORE);
    cache = { mtimeMs: st.mtimeMs, size: st.size, all };
  } catch {
    cache = null;
  }
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
  // list-applications
  jobId?: string | null;
  locations?: unknown[];
  skillTags?: unknown[];
  useOptimizedResume?: boolean;
  isOptimized?: boolean;
  resumeProfileId?: string | null;
  // list-tracked-applications (the tracker row's own id is `id`)
  id?: string;
  statusHistory?: unknown[];
  notes?: string | null;
  linkedEmailCount?: number;
}

export interface ImportResult {
  addedIds: string[];
  added: number;
  updated: number;
  unchanged: number; // already here with the same Tsenta updatedAt: a sync can stop paging
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

// Tsenta's raw status → its tab. list-applications says COMPLETED for submitted;
// tracker rows (APPLIED, INTERVIEWING, …) exist only once submitted.
function bucketOf(state: string): Bucket {
  if (/^(READY|RUNNING|OPTIMIZING_)/.test(state)) return "in_flight";
  if (/^PENDING_/.test(state)) return "needs";
  if (/^FAILED/.test(state)) return "failed";
  if (/^SKIPPED/.test(state)) return "skipped";
  return "submitted";
}

const PIPELINES = new Set<Pipeline>(["APPLIED", "GHOSTED", "INTERVIEWING", "REJECTED", "OFFER"]);

const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === "string" ? x : (x as any)?.name ?? (x as any)?.label ?? (x as any)?.city ?? "")).map((s) => String(s).trim()).filter(Boolean)
    : [];

// statusHistory entries come as strings or { status, at } objects.
const history = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : (x as any)?.status ?? (x as any)?.toStatus ?? "")).filter(Boolean) : [];

const isTrackerRow = (r: TsentaRow) => r.statusHistory !== undefined || r.positionTitle !== undefined || r.dateApplied !== undefined;

export async function importApplications(rows: TsentaRow[]): Promise<ImportResult> {
  const out: ImportResult = { addedIds: [], added: 0, updated: 0, unchanged: 0, skipped: 0, resumes: 0, resumeErrors: [] };
  const now = new Date().toISOString();
  const all = readAll();

  const toFetch: { id: string; url: string }[] = [];
  for (const r of rows) {
    const id = r.applicationId?.trim();
    const company = r.companyName?.trim();
    // A tracker row you added by hand in Tsenta has no applicationId: nothing to start.
    if (!id || !company) {
      out.skipped++;
      continue;
    }
    const tracker = isTrackerRow(r);
    const state = (r.status ?? r.jobStatus ?? "COMPLETED").toUpperCase();
    const bucket = tracker ? "submitted" : bucketOf(state);
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
        appliedAt: r.dateApplied ?? r.createdAt ?? r.updatedAt ?? now,
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
    }
    const a = all[id];
    const before = JSON.stringify(a);

    // Fill gaps in what warmreach owns. Never touch status, people, emails or
    // drafts: a re-sync must not undo work already done here.
    if (!a.role && role) a.role = role;
    if (!a.url && url) a.url = url;
    if (!a.companyWebsite && r.companyWebsite) a.companyWebsite = r.companyWebsite.trim();
    if (!a.jd && jd) {
      a.jd = jd;
      a.jdSource = "tsenta";
      if (a.status === "stuck" && a.stuckReason !== "company") { a.status = "new"; a.error = null; }
    }

    // What Tsenta owns is refreshed every time.
    if (tracker) {
      const col = state as Pipeline;
      if (PIPELINES.has(col)) a.pipeline = col;
      const h = history(r.statusHistory);
      if (h.length) a.pipelineHistory = h;
      if (r.id) a.trackerId = r.id;
      if (r.notes !== undefined) a.tsentaNotes = r.notes ?? null;
      if (typeof r.linkedEmailCount === "number") a.linkedEmails = r.linkedEmailCount;
      a.bucket = a.bucket ?? "submitted";
    } else {
      a.bucket = bucket;
      a.tsentaState = state;
      if (r.jobId) a.jobId = r.jobId;
      if (r.locations) a.locations = strings(r.locations);
      if (r.skillTags) a.skillTags = strings(r.skillTags);
      const tailored = r.isOptimized ?? r.useOptimizedResume;
      if (typeof tailored === "boolean") a.tailored = tailored;
      if (r.resumeProfileId) a.resumeProfileId = r.resumeProfileId;
      if (r.atsType) a.ats = r.atsType;
      if (r.updatedAt) a.tsentaUpdatedAt = r.updatedAt;
    }

    if (out.addedIds.at(-1) !== id) {
      if (JSON.stringify(a) !== before) out.updated++;
      else out.unchanged++;
    }

    const cached = a.resumePath && fs.existsSync(a.resumePath);
    if (r.resumePdfUrl && !cached) toFetch.push({ id, url: r.resumePdfUrl });
  }
  writeAll(all);
  writeMeta({ lastSyncAt: now });

  // Downloads after the write, so a slow or failed download never loses the
  // import itself. Each success is its own small update.
  for (const { id, url } of toFetch) {
    try {
      const file = await downloadResume(id, url);
      updateApplication(id, (a) => { a.resumePath = file; a.resumeWanted = false; });
      out.resumes++;
    } catch (e: any) {
      out.resumeErrors.push(`${all[id].company}: ${e?.message ?? "download failed"}`);
    }
  }
  return out;
}

// ── more from Tsenta: inbox and job details ─────────────────────────────────
// Neither shape has been seen from a real call yet, so both accept the likely
// field names and match to an application by its id, else its job id, else the
// company name. Anything that matches nothing is counted, never guessed at.

export interface InboxRow {
  applicationId?: string | null;
  companyName?: string | null;
  company?: string | null;
  fromName?: string | null;
  from?: string | null;
  category?: string | null;
  subject?: string | null;
  receivedAt?: string | null;
  date?: string | null;
  createdAt?: string | null;
}

export function importInbox(rows: InboxRow[]): { matched: number; unmatched: number } {
  const all = readAll();
  const byCompany = new Map<string, Application[]>();
  for (const a of Object.values(all)) {
    for (const n of [a.company, a.org?.name]) {
      if (!n) continue;
      const k = nameKey(n);
      byCompany.set(k, [...(byCompany.get(k) ?? []), a]);
    }
  }
  let matched = 0, unmatched = 0;
  for (const r of rows) {
    const category = (r.category ?? "GENERAL").toUpperCase();
    if (category === "VERIFICATION") continue; // OTPs: nothing to show
    const at = r.receivedAt ?? r.date ?? r.createdAt ?? new Date().toISOString();
    const subject = (r.subject ?? "").slice(0, 160);
    const hits = r.applicationId && all[r.applicationId]
      ? [all[r.applicationId]]
      : byCompany.get(nameKey(r.companyName ?? r.company ?? r.fromName ?? "")) ?? [];
    if (!hits.length) { unmatched++; continue; }
    matched++;
    for (const a of hits) {
      const list = a.inbox ?? [];
      if (!list.some((m) => m.at === at && m.subject === subject)) list.push({ category, subject, at });
      a.inbox = list.sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).slice(0, 20);
    }
  }
  writeAll(all);
  return { matched, unmatched };
}

export interface DetailsRow {
  applicationId?: string | null;
  jobId?: string | null;
  id?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salary?: { min?: number | null; max?: number | null; currency?: string | null } | null;
  currency?: string | null;
  yearsExperience?: number | null;
  yearsOfExperience?: number | null;
  sponsorship?: boolean | string | null;
  visaSponsorship?: boolean | string | null;
  employmentType?: string | null;
  roleFamily?: string | null;
}

const yesNo = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : typeof v === "string" ? (/^(yes|true|offered|available)/i.test(v) ? true : /^(no|false|not)/i.test(v) ? false : null) : null;

export function importDetails(rows: DetailsRow[]): { matched: number; unmatched: number } {
  const all = readAll();
  const byJob = new Map(Object.values(all).filter((a) => a.jobId).map((a) => [a.jobId!, a]));
  let matched = 0, unmatched = 0;
  for (const r of rows) {
    const a = (r.applicationId && all[r.applicationId]) || byJob.get(r.jobId ?? r.id ?? "");
    if (!a) { unmatched++; continue; }
    matched++;
    a.details = {
      salaryMin: r.salaryMin ?? r.salary?.min ?? null,
      salaryMax: r.salaryMax ?? r.salary?.max ?? null,
      currency: r.currency ?? r.salary?.currency ?? null,
      yearsExperience: r.yearsExperience ?? r.yearsOfExperience ?? null,
      sponsorship: yesNo(r.sponsorship ?? r.visaSponsorship),
      employmentType: r.employmentType ?? null,
      roleFamily: r.roleFamily ?? null,
    };
  }
  writeAll(all);
  return { matched, unmatched };
}

// ── sync bookkeeping ────────────────────────────────────────────────────────
// warmreach can't reach Tsenta itself; a Claude session with Tsenta's connector
// does the pulling. The board's "Sync Tsenta" leaves a request here, and the
// session clears it.

const META = path.join(DIR, "meta.json");

export interface SyncMeta {
  lastSyncAt: string | null;
  syncRequestedAt: string | null;
  tsentaTotal: number | null;
}

export function readMeta(): SyncMeta {
  try {
    return { lastSyncAt: null, syncRequestedAt: null, tsentaTotal: null, ...JSON.parse(fs.readFileSync(META, "utf8")) };
  } catch {
    return { lastSyncAt: null, syncRequestedAt: null, tsentaTotal: null };
  }
}

export function writeMeta(patch: Partial<SyncMeta>): SyncMeta {
  const next = { ...readMeta(), ...patch };
  fs.mkdirSync(DIR, { recursive: true });
  writeFileAtomic(META, JSON.stringify(next, null, 1));
  return next;
}

/** Started rows still waiting on Tsenta's résumé — what the next sync fetches. */
export function resumesWanted(): { applicationId: string; companyName: string }[] {
  return listApplications()
    .filter((a) => a.resumeWanted && !(a.resumePath && fs.existsSync(a.resumePath)))
    .map((a) => ({ applicationId: a.id, companyName: a.company }));
}

/** Notes waiting to be written to Tsenta's tracker. */
export function tsentaOutbox(): { applicationId: string; trackerId: string | null; companyName: string; note: string }[] {
  return listApplications()
    .filter((a) => a.noteQueuedAt && !a.notedAt)
    .map((a) => ({ applicationId: a.id, trackerId: a.trackerId ?? null, companyName: a.company, note: outreachNote(a) }));
}

export function outreachNote(a: Application): string {
  const drafts = a.boardDrafts ?? [];
  const sent = drafts.filter((d) => d.sentAt);
  const when = shortDate((sent[0] ?? drafts[0])?.sentAt ?? (sent[0] ?? drafts[0])?.at ?? new Date().toISOString());
  const n = sent.length || drafts.length;
  return `warmreach: ${sent.length ? "emailed" : "drafted emails to"} ${n} ${n === 1 ? "person" : "people"} on ${when}`;
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
//
// Start can change how many and from which sides: with recruiters off nobody
// recruiting is picked; with founders off no founder is; "team" is everyone else.
function pickDefaults(people: Person[], opts: StartOptions = DEFAULT_START): void {
  const n = Math.max(1, Math.min(10, opts.pick || DEFAULT_PICK));
  const allowed = people.filter((p) => {
    const own = ownRole(p.title);
    if (RECRUIT_RE.test(own)) return opts.roles.recruiter;
    if (FOUNDER_RE.test(own)) return opts.roles.founders;
    return opts.roles.team;
  });
  const pool = allowed.length ? allowed : people;
  const recruiters = pool.filter(isRecruiter);
  const team = pool.filter((p) => !isRecruiter(p));
  const chosen = new Set([...recruiters.slice(0, 1), ...team.slice(0, n - Math.min(1, recruiters.length))].map((p) => p.id));
  for (const p of pool) {
    if (chosen.size >= n) break;
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
export async function prepare(id: string, opts: StartOptions = DEFAULT_START): Promise<Application> {
  const start = getApplication(id);
  if (!start) throw new Error(`No application ${id}`);
  // Its workspace owns it now (or it was drafted) — don't rewrite underneath it.
  if (start.openedAt || start.status === "drafted") return start;
  updateApplication(id, (a) => { a.status = "preparing"; a.error = null; a.stuckReason = null; });

  const stuck = (error: string, reason: StuckReason = "other") =>
    updateApplication(id, (a) => { a.status = "stuck"; a.error = error; a.stuckReason = reason; });

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
      return stuck(`Couldn’t tell which company “${start.company}” is. Enter its website to continue.`, "company");
    }
    const org: Org = {
      name: company.name,
      domain: company.domain ?? null,
      orgId: company.orgId ?? null,
      description: company.description,
      keywords: company.keywords,
      logoUrl: company.logoUrl ?? null,
      employees: company.employees ?? null,
      industry: company.industry ?? null,
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
    // Nobody Apollo can reveal: Hunter lists a domain's people with their
    // emails (its own quota, no Apollo credit), so those go in as known emails.
    if (people.length === 0 && hunterConfigured() && org.domain) {
      for (const h of await domainSearch(org.domain, 30)) {
        if (alreadyContacted(h.email)) {
          skipped.push({ name: h.firstName, title: h.position ?? "", reason: "already emailed" });
          continue;
        }
        const k = key(h.firstName, h.position ?? "");
        if (seen.has(k)) continue;
        seen.add(k);
        people.push({
          id: `hunter:${h.email.toLowerCase()}`,
          firstName: h.firstName,
          title: h.position ?? "",
          source: "hunter",
          email: h.email,
          variant: classifyVariant(h.position ?? ""),
          fit: null,
          reason: `Hunter, ${h.confidence}% sure of the address`,
          picked: false,
        });
      }
    }
    if (people.length === 0) {
      return skipped.length
        ? stuck(`Everyone reachable at ${org.name} was emailed before.`, "contacted")
        : stuck(`No one at ${org.name} has an email Apollo or Hunter can find.`, "no_emails");
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
    pickDefaults(kept, opts);
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
    return stuck(e?.message ?? "Preparing failed.", "other");
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
      source: p.source === "file" ? ("csv" as const) : p.source === "hunter" ? ("hunter" as const) : ("apollo" as const),
      email: p.email,
      confidence: null,
      fit: p.fit ? { priority: p.fit, reason: p.reason } : null,
    })),
    selected: a.people.filter((p) => p.picked).map((p) => p.id),
    // Written by the board's Start, or by the first version for its drafts.
    templates: a.emails ?? null,
    templateSel: a.templateId ?? "",
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
    // Rows the board started stay on the board (its review queue drafts them);
    // they open in Applications only when you ask for one.
    .filter((a) => isReady(a) && !a.openedAt && !a.startedAt)
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

// ── the board ───────────────────────────────────────────────────────────────
// One light row per application for the Applied board: no posting text and no
// people lists, so thousands of rows load in one request. Where each one stands
// ("stage") is worked out here from the row, the queue, the outreach log, sent
// schedules and the last follow-up scan.

export type Stage =
  | "not_startable" // Tsenta never submitted it
  | "not_started"
  | "queued"
  | "finding"
  | "needs_website"
  | "no_emails"
  | "contacted"
  | "error"
  | "writing"
  | "getting_resume"
  | "ready"
  | "in_applications" // opened as a workspace before the board existed
  | "drafted"
  | "sent"
  | "replied";

export interface BoardRow {
  id: string;
  company: string;
  tsentaCompany: string;
  groupKey: string;
  domain: string | null;
  employees: number | null;
  industry: string | null;
  logoUrl: string | null;
  role: string | null;
  url: string | null;
  ats: string | null;
  locations: string[];
  skills: string[];
  appliedAt: string;
  bucket: Bucket;
  tsentaState: string | null;
  pipeline: Pipeline | null;
  tailored: boolean | null;
  resume: "saved" | "wanted" | "none";
  stage: Stage;
  detail: string | null;
  picked: number;
  found: number;
  credits: number;
  drafts: number;
  contacted: boolean;
  onFile: boolean;
  inbox: string[];
  salaryMin: number | null;
  salaryMax: number | null;
  sponsorship: boolean | null;
  employmentType: string | null;
  hasJd: boolean;
  dupOf: string | null;
  replied: boolean;
  followupDue: boolean;
  noteQueued: boolean;
}

const SCHEDULED = path.resolve("data/scheduled.json");

function sentDraftIds(): Set<string> {
  try {
    const rows = JSON.parse(fs.readFileSync(SCHEDULED, "utf8")) as { draftId: string; status: string }[];
    return new Set(rows.filter((r) => r.status === "sent").map((r) => r.draftId));
  } catch {
    return new Set();
  }
}

function replyState(): Map<string, { replied: boolean; due: boolean }> {
  const out = new Map<string, { replied: boolean; due: boolean }>();
  for (const c of readScanResult()?.companies ?? []) {
    out.set(c.companyKey, { replied: c.someoneReplied, due: c.dueCount > 0 });
  }
  return out;
}

const hasResume = (a: Application) => !!a.resumePath && fs.existsSync(a.resumePath);

export function stageOf(
  a: Application,
  ctx: { queued: Set<string>; drafts: number; sent: boolean; replied: boolean },
): { stage: Stage; detail: string | null } {
  const bucket = a.bucket ?? "submitted";
  if (bucket !== "submitted") return { stage: "not_startable", detail: a.tsentaState ?? null };
  if (ctx.replied && (ctx.sent || ctx.drafts > 0)) return { stage: "replied", detail: null };
  if (ctx.sent) return { stage: "sent", detail: null };
  if (ctx.drafts > 0 || a.status === "drafted") return { stage: "drafted", detail: `${ctx.drafts || a.drafts?.length || 0} in Gmail` };
  if (ctx.queued.has(a.id)) return { stage: "queued", detail: null };
  switch (a.status) {
    case "preparing":
      return { stage: "finding", detail: null };
    case "writing":
      return { stage: "writing", detail: null };
    case "stuck": {
      // Rows stuck before the board kept no reason: read it off the message.
      const r = a.stuckReason ?? (
        /enter its website/i.test(a.error ?? "") ? "company"
          : /has an email|can find/i.test(a.error ?? "") ? "no_emails"
            : /emailed before/i.test(a.error ?? "") ? "contacted"
              : "other");
      const stage: Stage = r === "company" ? "needs_website" : r === "no_emails" ? "no_emails" : r === "contacted" ? "contacted" : "error";
      return { stage, detail: a.error };
    }
    case "ready": {
      const waiting = a.resumeWanted && !hasResume(a) && (a.options?.resumeFallback ?? "wait") === "wait";
      return waiting ? { stage: "getting_resume", detail: "Fetched on the next Tsenta sync" } : { stage: "ready", detail: null };
    }
    case "review":
      return a.openedAt ? { stage: "in_applications", detail: null } : { stage: "not_started", detail: null };
    default:
      return { stage: "not_started", detail: null };
  }
}

export function boardRows(queued: Set<string> = new Set()): BoardRow[] {
  const apps = listApplications();
  const drafts = draftCounts();
  const sent = sentDraftIds();
  const replies = replyState();
  const contacted = contactedCompanies();
  const contactedNames = new Set(contacted.names);
  const contactedDomains = new Set(contacted.domains);
  const onFile = new Set<string>();
  for (const c of contactsCompanyList()) {
    onFile.add(normCompany(c.name));
    if (c.domain) onFile.add(c.domain.toLowerCase());
  }

  // The same job applied to twice shows once: same company, role and posting.
  const dupKey = (a: Application) =>
    `${normCompany(a.company)}|${(a.role ?? "").trim().toLowerCase()}|${(a.url ?? "").split("?")[0].toLowerCase()}`;
  const newest = new Map<string, Application>();
  for (const a of apps) {
    const k = dupKey(a);
    const cur = newest.get(k);
    if (!cur || Date.parse(a.appliedAt) > Date.parse(cur.appliedAt)) newest.set(k, a);
  }

  return apps.map((a) => {
    const name = a.org?.name ?? a.company;
    const companyKey = normCompany(name);
    const domain = a.org?.domain ?? null;
    const bd = a.boardDrafts ?? [];
    const nDrafts = Math.max(drafts(a), bd.length);
    const wasSent = bd.some((d) => d.sentAt || sent.has(d.draftId)) || (a.drafts ?? []).some((d) => d.sentAt || sent.has(d.draftId));
    const reply = replies.get(companyKey) ?? replies.get(normCompany(a.company));
    const { stage, detail } = stageOf(a, { queued, drafts: nDrafts, sent: wasSent, replied: !!reply?.replied });
    const { picked, credits } = creditsFor(a);
    const keep = newest.get(dupKey(a));
    return {
      id: a.id,
      company: name,
      tsentaCompany: a.company,
      groupKey: companyKey,
      domain,
      employees: a.org?.employees ?? null,
      industry: a.org?.industry ?? null,
      logoUrl: a.org?.logoUrl ?? null,
      role: a.role,
      url: a.url,
      ats: a.ats,
      locations: a.locations ?? [],
      skills: a.skillTags ?? [],
      appliedAt: a.appliedAt,
      bucket: a.bucket ?? "submitted",
      tsentaState: a.tsentaState ?? null,
      pipeline: a.pipeline ?? null,
      tailored: a.tailored ?? null,
      resume: hasResume(a) ? "saved" : a.resumeWanted ? "wanted" : "none",
      stage,
      detail,
      picked,
      found: a.found,
      credits,
      drafts: nDrafts,
      contacted: contactedNames.has(companyKey) || contactedNames.has(normCompany(a.company)) || (!!domain && contactedDomains.has(domain.toLowerCase())),
      onFile: onFile.has(companyKey) || (!!domain && onFile.has(domain.toLowerCase())),
      inbox: [...new Set((a.inbox ?? []).map((m) => m.category))],
      salaryMin: a.details?.salaryMin ?? null,
      salaryMax: a.details?.salaryMax ?? null,
      sponsorship: a.details?.sponsorship ?? null,
      employmentType: a.details?.employmentType ?? null,
      hasJd: !!a.jd,
      dupOf: keep && keep.id !== a.id ? keep.id : null,
      replied: !!reply?.replied,
      followupDue: !!reply?.due,
      noteQueued: !!a.noteQueuedAt && !a.notedAt,
    };
  });
}

/** Rows waiting in the review queue: emails written, nothing drafted yet. */
export function reviewCount(): number {
  return listApplications().filter((a) => a.status === "ready" && !(a.boardDrafts?.length)).length;
}

/** Ids whose posting text contains every word of the query. */
export function searchPostings(q: string): string[] {
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) return [];
  return listApplications()
    .filter((a) => {
      const text = (a.jd ?? "").toLowerCase();
      return text && words.every((w) => text.includes(w));
    })
    .map((a) => a.id);
}

// ── what the board spent ────────────────────────────────────────────────────

const SPEND = path.join(DIR, "spend.jsonl");

export interface SpendEntry {
  at: string;
  kind: "start" | "drafts" | "followups";
  what: string;
  claude: number;
  credits: number;
  ids: string[];
}

export function logSpend(e: Omit<SpendEntry, "at">): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(SPEND, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n");
}

export function readSpend(limit = 200): SpendEntry[] {
  try {
    return fs.readFileSync(SPEND, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as SpendEntry).reverse().slice(0, limit);
  } catch {
    return [];
  }
}

// ── drafts and sends from the review queue ──────────────────────────────────

export function recordDrafts(id: string, drafts: Omit<BoardDraft, "at" | "sentAt">[], credits: number): Application {
  const at = new Date().toISOString();
  const app = updateApplication(id, (a) => {
    const list = a.boardDrafts ?? [];
    for (const d of drafts) {
      const i = list.findIndex((x) => x.personId === d.personId);
      const row = { ...d, at, sentAt: i >= 0 ? list[i].sentAt : null };
      if (i >= 0) list[i] = row;
      else list.push(row);
    }
    a.boardDrafts = list;
  });
  logSpend({ kind: "drafts", what: `Created drafts · ${app.org?.name ?? app.company}`, claude: 0, credits, ids: [id] });
  return app;
}

export function recordSent(id: string, draftIds: string[]): Application {
  const at = new Date().toISOString();
  return updateApplication(id, (a) => {
    for (const d of a.boardDrafts ?? []) if (draftIds.includes(d.draftId)) d.sentAt = d.sentAt ?? at;
  });
}

/** Who an email went to, by title: the reply-rate chart's first split. */
export function audienceOf(title: string): "Recruiters" | "Founders" | "The role’s team" {
  const own = ownRole(title);
  if (RECRUIT_RE.test(own)) return "Recruiters";
  if (FOUNDER_RE.test(own)) return "Founders";
  return "The role’s team";
}

export interface HistoryLine {
  at: string | null;
  source: "Tsenta" | "Inbox" | "warmreach";
  text: string;
}

/** Everything that happened to one application, oldest first. */
export function historyOf(a: Application): HistoryLine[] {
  const out: HistoryLine[] = [];
  out.push({ at: a.appliedAt, source: "Tsenta", text: a.tailored ? "Applied with a tailored résumé" : "Applied" });
  if (a.pipelineHistory?.length) out.push({ at: null, source: "Tsenta", text: `Pipeline: ${a.pipelineHistory.map((s) => s.charAt(0) + s.slice(1).toLowerCase()).join(" → ")}` });
  for (const m of [...(a.inbox ?? [])].reverse()) out.push({ at: m.at, source: "Inbox", text: `${m.category.charAt(0) + m.category.slice(1).toLowerCase()}: ${m.subject}` });
  const names = new Set([normCompany(a.company), a.org ? normCompany(a.org.name) : ""]);
  const since = a.startedAt ? Date.parse(a.startedAt) : Infinity;
  const earlier = outreachRows().filter((r) => names.has(normCompany(r.company)) && Date.parse(r.timestamp) < since);
  out.push(earlier.length
    ? { at: earlier[earlier.length - 1].timestamp, source: "warmreach", text: `Emailed ${earlier.length} ${earlier.length === 1 ? "person" : "people"} here before` }
    : { at: null, source: "warmreach", text: "Never contacted before" });
  if (a.startedAt) out.push({ at: a.startedAt, source: "warmreach", text: "Started" });
  if (a.preparedAt && a.org) out.push({ at: a.preparedAt, source: "warmreach", text: `Company found · ${a.people.filter((p) => p.picked).length} of ${a.found} people picked` });
  if (a.emailsAt) out.push({ at: a.emailsAt, source: "warmreach", text: "Emails written (2 model calls)" });
  const bd = a.boardDrafts ?? [];
  if (bd.length) out.push({ at: bd[0].at, source: "warmreach", text: `${bd.length} ${bd.length === 1 ? "draft" : "drafts"} created` });
  const sent = bd.filter((d) => d.sentAt);
  if (sent.length) out.push({ at: sent[0].sentAt, source: "warmreach", text: `${sent.length} sent` });
  if (a.notedAt) out.push({ at: a.notedAt, source: "Tsenta", text: "Note added in Tsenta" });
  else if (a.noteQueuedAt) out.push({ at: a.noteQueuedAt, source: "Tsenta", text: "Note queued for the next sync" });
  // Undated lines (the pipeline path, "never contacted") sort with the line
  // added just before them, so they stay next to what they describe.
  let prev = 0;
  const keyed = out.map((h, i) => {
    if (h.at) prev = Date.parse(h.at) || prev;
    return { h, k: prev, i };
  });
  return keyed.sort((x, y) => x.k - y.k || x.i - y.i).map((x) => x.h);
}

export function resumeFileOf(a: Application): string | null {
  return a.resumePath && fs.existsSync(a.resumePath) ? a.resumePath : null;
}
