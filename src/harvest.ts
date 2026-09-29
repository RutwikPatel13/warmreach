import fs from "node:fs";
import path from "node:path";
import { TITLE_GROUPS, resolveCompanyOptions, searchContacts, enrichPerson, type Company, type SearchResult } from "./apollo";
import { alreadyHave, appendPeople, companySlug, writeFileAtomic, invalidateIndex, peopleForCompany, normLinkedin, titleOverlap, type Person } from "./contactDb";
import { TARGETS, scoreTarget, type Target } from "./harvestTargets";
import { outreachRows, normCompany } from "./tracker";

// ── Harvest engine ──────────────────────────────────────────────────────────
// Two phases, and the split is the whole point:
//
//   scan()    Apollo people-search. FREE. Tells us who exists at a company and,
//             after subtracting everyone already in the store, exactly how many
//             credits harvesting them would cost. Nothing is charged.
//   harvest() Apollo person-match. 1 CREDIT PER PERSON. Only ever runs on the
//             candidates a scan already found and the caller explicitly picked.
//
// Scans are cached per company under data/db/scans/<slug>.json so re-opening the
// page doesn't re-query, and so the harvest phase spends against numbers the
// user actually saw.

const SCAN_DIR = path.resolve("data/db/scans");
const SEARCH_CAP = 1000; // per company, per scan — free, but bounded

export type Group = "founders" | "engineering" | "recruiters" | "other";

// "Vice President of Customer Success" contains "president" but is nobody's
// founder, and founders sort first — so the president alternative has to exclude
// the vice-president forms explicitly, and the VP spellings belong to the
// engineering group when they name an engineering org.
const GROUP_RE: [Group, RegExp][] = [
  ["founders", /\b(founder|co-?founder|ceo|chief executive|(?<!vice\s)(?<!vp\s)president|\bcoo\b|chief operating)\b/i],
  ["engineering", /\b(cto|chief technology|(vp|vice president)\s*(of\s*)?(eng|engineering|ai\b|machine learning|ml\b|data|research|technology|platform|infrastructure)|head of eng|director of eng|engineering manager|eng(ineering)? director|head of ai|head of machine learning|(staff|principal|distinguished)\s+(\w+\s+){0,3}engineer|tech lead)\b/i],
  ["recruiters", /\b(recruit\w*|talent\w*|people ops|people operations|head of people)\b/i],
];

// "Executive Assistant to the CEO" and "Advisor to Founders" are not founders,
// but a bare regex over the whole title says they are — and since founders sort
// first, they'd take the top slots under the cap. Test only the part of the
// title that describes the person's OWN role: everything before " to ".
function roleOf(title: string): string {
  return (title ?? "").split(/\s+to\s+|\s*[|·]\s*|\s+at\s+/i)[0];
}

export function groupOf(title: string): Group {
  const role = roleOf(title);
  for (const [g, re] of GROUP_RE) if (re.test(role)) return g;
  return "other";
}

// Harvest priority. Founders and eng leaders first — they're the contacts you
// can't get anywhere else — then recruiters, then everyone else the title filter
// happened to catch.
const GROUP_RANK: Record<Group, number> = { founders: 0, engineering: 1, recruiters: 2, other: 3 };

// The union of the three groups' titles — what we ask Apollo to search for.
export const HARVEST_TITLES = [
  ...TITLE_GROUPS.founders.titles,
  ...TITLE_GROUPS.engineering.titles,
  ...TITLE_GROUPS.recruiters.titles,
];

// Per-company ceiling. Person-level dedupe stops us re-buying people we own, but
// it can't stop Amazon — where we own nobody — from being ~1,900 "new" people and
// eating the entire budget. The cap is what keeps one mega-cap from starving the
// other 139. Flat rather than tiered by headcount: a small company rarely returns
// 60 matching people anyway, so the ceiling only ever binds where it's needed.
// Editable per row in the UI.
export const DEFAULT_CAP = 60;

export function defaultCap(_employees?: number): number {
  return DEFAULT_CAP;
}

export interface Candidate {
  id: string; // Apollo person id
  firstName: string;
  lastName: string | null;
  title: string;
  group: Group;
  linkedin: string | null;
}

export interface GroupCount {
  found: number;
  held: number;
  new: number; // not already on file
  reachable: number; // ...and Apollo has an email to sell. Only these cost a credit.
}

export interface ScanRow {
  name: string;
  domain: string;
  tier: string;
  orgId: string | null;
  logoUrl: string | null;
  employees: number | null;
  scannedAt: string;
  found: number; // people Apollo returned (free)
  held: number; // people we already have for this company, all sources
  heldOfFound: number; // of the found, how many we already own
  newReachable: number; // found - held, and Apollo says an email exists
  cap: number;
  credits: number; // min(newReachable, cap) — what harvesting this row costs
  groups: Record<Group, GroupCount>;
  candidates: Candidate[]; // the new+reachable, in harvest order
  harvested: number; // people already bought for this company
  error: string | null;
}

function scanFile(domain: string): string {
  return path.join(SCAN_DIR, `${companySlug(domain)}.json`);
}

export function readScan(domain: string): ScanRow | null {
  try {
    return JSON.parse(fs.readFileSync(scanFile(domain), "utf8")) as ScanRow;
  } catch {
    return null;
  }
}

export function writeScan(row: ScanRow): void {
  writeFileAtomic(scanFile(row.domain), JSON.stringify(row, null, 1));
}

export function allScans(): Map<string, ScanRow> {
  const out = new Map<string, ScanRow>();
  let files: string[];
  try {
    files = fs.readdirSync(SCAN_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const row = JSON.parse(fs.readFileSync(path.join(SCAN_DIR, f), "utf8")) as ScanRow;
      out.set(row.domain, row);
    } catch {
      // Unreadable scan cache is not fatal — that company just reads as unscanned.
    }
  }
  return out;
}

// ── phase 1: scan (free) ────────────────────────────────────────────────────

export async function scanCompany(target: Target): Promise<ScanRow> {
  const base: ScanRow = {
    name: target.name,
    domain: target.domain,
    tier: target.tier,
    orgId: null,
    logoUrl: null,
    employees: null,
    scannedAt: new Date().toISOString(),
    found: 0,
    held: peopleForCompany(target.name, target.domain).length,
    heldOfFound: 0,
    newReachable: 0,
    cap: defaultCap(),
    credits: 0,
    groups: {
      founders: { found: 0, held: 0, new: 0, reachable: 0 },
      engineering: { found: 0, held: 0, new: 0, reachable: 0 },
      recruiters: { found: 0, held: 0, new: 0, reachable: 0 },
      other: { found: 0, held: 0, new: 0, reachable: 0 },
    },
    candidates: [],
    harvested: readScan(target.domain)?.harvested ?? 0,
    error: null,
  };

  let company: Company;
  try {
    company = (await resolveCompanyOptions(target.domain))[0];
  } catch (e: any) {
    base.error = e?.message ?? "Could not resolve company in Apollo.";
    writeScan(base);
    return base;
  }

  base.orgId = company.orgId ?? null;
  base.logoUrl = company.logoUrl ?? null;
  base.employees = company.employees ?? null;
  base.cap = defaultCap(company.employees);

  let found: SearchResult[];
  try {
    found = await searchContacts(company, HARVEST_TITLES, SEARCH_CAP);
  } catch (e: any) {
    base.error = e?.message ?? "People search failed.";
    writeScan(base);
    return base;
  }

  base.found = found.length;

  // Who we already hold for this company, resolved by OUR target name and domain
  // — NOT by the name Apollo hands back. Apollo files x.ai under "SpaceXAI", so
  // matching on its org name missed all 43 xAI contacts already on file and cost
  // 16 real credits re-buying people we had. peopleForCompany() keys on the
  // normalized name AND the email domain, which survives that mismatch.
  const heldForCompany = peopleForCompany(target.name, target.domain);
  const heldById = new Map<string, Person>();
  const heldByLi = new Map<string, Person>();
  const heldByFirst = new Map<string, Person[]>();
  const cleanFirst = (v: string) => (v ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  for (const h of heldForCompany) {
    if (h.apolloId) heldById.set(h.apolloId, h);
    const li = normLinkedin(h.linkedin);
    if (li) heldByLi.set(li, h);
    const fk = cleanFirst(h.firstName);
    if (!fk) continue;
    const arr = heldByFirst.get(fk);
    if (arr) arr.push(h);
    else heldByFirst.set(fk, [h]);
  }

  // Company-scoped first, then the global store — someone can be on file under a
  // different employer and still be the same person.
  const matchHeld = (p: SearchResult): Person | null => {
    if (p.id && heldById.has(p.id)) return heldById.get(p.id)!;
    const li = normLinkedin(p.linkedin);
    if (li && heldByLi.has(li)) return heldByLi.get(li)!;
    const bucket = heldByFirst.get(cleanFirst(p.first_name)) ?? [];
    if (bucket.length === 1) return bucket[0];
    if (bucket.length > 1) return bucket.find((h) => titleOverlap(h.title, p.title)) ?? null;
    return alreadyHave({
      apolloId: p.id,
      linkedin: p.linkedin,
      firstName: p.first_name,
      lastName: p.last_name ?? "",
      title: p.title,
      company: target.name,
    });
  };

  const candidates: Candidate[] = [];
  for (const p of found) {
    const g = groupOf(p.title);
    base.groups[g].found++;
    // The identity check that makes this whole thing worth building: person-level,
    // not company-level. Exact via Apollo id / LinkedIn for the CSV contacts,
    // first name + title for the outreach log (whose rows carry no Apollo id).
    const held = matchHeld(p);
    if (held) {
      base.groups[g].held++;
      base.heldOfFound++;
      continue;
    }
    base.groups[g].new++;
    if (!p.has_email) continue; // Apollo has no email to sell us — never a credit
    base.groups[g].reachable++;
    candidates.push({
      id: p.id,
      firstName: p.first_name,
      lastName: p.last_name ?? null,
      title: p.title,
      group: g,
      linkedin: p.linkedin ?? null,
    });
  }

  candidates.sort((a, b) => GROUP_RANK[a.group] - GROUP_RANK[b.group]);
  base.candidates = candidates.slice(0, 500); // bound the cache file
  base.newReachable = candidates.length;
  base.credits = Math.min(candidates.length, base.cap);
  writeScan(base);
  return base;
}

// ── phase 2: harvest (1 credit per person) ──────────────────────────────────

export interface HarvestResult {
  domain: string;
  name: string;
  attempted: number;
  revealed: number; // got a usable email
  spent: number; // credits actually consumed (Apollo charges on match, email or not)
  alreadyHarvested: number; // bought by an earlier run — the resume count
  beyondCap: number; // real candidates this run won't reach, because of the cap
  errors: string[];
  dryRun: boolean;
}

// Which candidate ids did an earlier run already buy? Read straight from the
// shard, so an interrupted run resumes exactly where it stopped without needing
// any separate bookkeeping file to stay in sync.
function harvestedIds(company: string): Set<string> {
  const out = new Set<string>();
  const file = path.resolve("data/db/people", `${companySlug(company)}.ndjson`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as Person;
      if (p.apolloId) out.add(p.apolloId);
    } catch {
      /* torn line */
    }
  }
  return out;
}

// Bring a cached scan back in line with what we now own. A harvest used to bump
// `harvested` and nothing else, so the row kept advertising its pre-harvest
// numbers — Cohere still offered 48 credits after all 48 had been bought, and
// DeepMind still showed 0 on file after 60 landed. The engine was never at risk
// (harvestCompany filters candidates against the shard, so a second run buys the
// NEXT people rather than the same ones), but the page was telling you to spend
// money that would have bought nothing. Uses no Apollo call — everything needed
// is already on disk.
export function reconcileScan(scan: ScanRow): ScanRow {
  const bought = harvestedIds(scan.name);
  const before = scan.candidates.length;
  scan.candidates = scan.candidates.filter((c) => !bought.has(c.id));
  const removed = before - scan.candidates.length;

  scan.harvested = bought.size;
  scan.newReachable = Math.max(0, scan.newReachable - removed);
  scan.held = peopleForCompany(scan.name, scan.domain).length;
  scan.heldOfFound = Math.min(scan.found, scan.heldOfFound + removed);
  for (const g of Object.keys(scan.groups) as Group[]) {
    const stillThere = scan.candidates.filter((c) => c.group === g).length;
    scan.groups[g].reachable = Math.min(scan.groups[g].reachable ?? 0, Math.max(stillThere, 0));
  }
  scan.credits = Math.min(scan.newReachable, scan.cap);
  writeScan(scan);
  return scan;
}

export async function harvestCompany(opts: {
  domain: string;
  cap?: number;
  budget: number; // hard ceiling on credits this call may spend
  dryRun: boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<HarvestResult> {
  const scan = readScan(opts.domain);
  if (!scan) throw new Error(`No scan for ${opts.domain} — run a free scan first.`);

  const cap = opts.cap ?? scan.cap;
  const done = harvestedIds(scan.name);
  const fresh = scan.candidates.filter((c) => !done.has(c.id));
  const queue = fresh.slice(0, cap);
  const budgeted = queue.slice(0, Math.max(0, opts.budget));

  const res: HarvestResult = {
    domain: scan.domain,
    name: scan.name,
    attempted: budgeted.length,
    revealed: 0,
    spent: 0,
    alreadyHarvested: scan.candidates.length - fresh.length,
    beyondCap: fresh.length - queue.length,
    errors: [],
    dryRun: opts.dryRun,
  };
  if (opts.dryRun || !budgeted.length) return res;

  const batch: Person[] = [];
  const now = new Date().toISOString();
  for (let i = 0; i < budgeted.length; i++) {
    const c = budgeted[i];
    try {
      const contact = await enrichPerson(c.id, scan.domain);
      res.spent++; // Apollo charges on a match, whether or not an email comes back
      if (contact.email) res.revealed++;
      batch.push({
        apolloId: c.id,
        firstName: contact.firstName || c.firstName,
        lastName: contact.lastName || c.lastName || "",
        fullName: contact.fullName || [c.firstName, c.lastName].filter(Boolean).join(" "),
        title: contact.title || c.title,
        company: scan.name,
        companyDomain: scan.domain,
        email: contact.email ?? null,
        emailStatus: contact.emailStatus ?? null,
        seniority: contact.seniority ?? null,
        linkedin: contact.linkedin ?? c.linkedin,
        source: "harvest",
        addedAt: now,
        contactedAt: null,
      });
    } catch (e: any) {
      res.errors.push(`${c.firstName} ${c.lastName ?? ""}: ${e?.message ?? "enrich failed"}`);
    }
    // Flush every 10 so a crash costs at most 10 credits of unwritten work.
    if (batch.length >= 10) {
      appendPeople(scan.name, batch.splice(0));
    }
    opts.onProgress?.(i + 1, budgeted.length);
  }
  if (batch.length) appendPeople(scan.name, batch);

  invalidateIndex(); // the people we just bought are now part of the store
  reconcileScan(scan);
  return res;
}

// ── the ranked target table the page renders ────────────────────────────────

export interface TargetRow extends Target {
  score: number;
  outreach: number;
  onFile: number;
  scan: ScanRow | null;
}

export function targetRows(): TargetRow[] {
  // Outreach volume per company, for the "investment" ranking signal.
  const outreach = new Map<string, number>();
  for (const r of outreachRows()) {
    const k = normCompany(r.company);
    if (k) outreach.set(k, (outreach.get(k) ?? 0) + 1);
  }
  const scans = allScans();

  const rows = TARGETS.map((t) => {
    const onFile = peopleForCompany(t.name, t.domain).length;
    const out = outreach.get(normCompany(t.name)) ?? 0;
    return {
      ...t,
      onFile,
      outreach: out,
      score: scoreTarget(t, { outreach: out, onFile }),
      scan: scans.get(t.domain) ?? null,
    };
  });
  rows.sort((a, b) => b.score - a.score);
  return rows;
}
