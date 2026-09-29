import fs from "node:fs";
import path from "node:path";
import { parseCsvRecords } from "./csv";
import {
  WINDOWS,
  companySlug,
  type Difficulty,
  type PrepQuestion,
  type PrepSet,
  type PrepSource,
  type Window,
} from "./prep";

// ── Where prep questions come from ──────────────────────────────────────────
// Three sources, in descending order of freshness:
//
//   1. Your LeetCode Premium session, replayed from a request you captured out
//      of DevTools. The only CURRENT source for company tags — every public
//      mirror is months behind, and for recent windows often empty.
//   2. Two public GitHub mirrors of the same tags. Stale, but they need no
//      session and no requests to LeetCode at all.
//   3. LeetCode's PUBLIC, unauthenticated GraphQL endpoint, for per-question
//      metadata (difficulty, acceptance, topics, statement). No Premium needed,
//      so this keeps working even when the captured session expires.
//
// On the premium path: LeetCode's ToS bars automated access regardless of
// subscription, so requests are slow, sequential and identical in shape to the
// one the browser already made. Nothing here works around a bot check — if the
// captured session stops being accepted, the fix is capturing a fresh one.

const CACHE_DIR = path.resolve("data/prep/.cache");
const SESSION_FILE = path.resolve("data/prep/.session/company-request.curl");
const GRAPHQL = "https://leetcode.com/graphql";

const MIRRORS = {
  snehasishroy: {
    repo: "snehasishroy/leetcode-companywise-interview-questions",
    branch: "master",
    snapshot: "2026-05-24",
    // lowercase dir, one file per window
    file: (w: Window) => `${w}.csv`,
  },
  liquidslr: {
    repo: "liquidslr/leetcode-company-wise-problems",
    branch: "main",
    snapshot: "2025-06-20",
    file: (w: Window) =>
      ({
        "thirty-days": "1. Thirty Days.csv",
        "three-months": "2. Three Months.csv",
        "six-months": "3. Six Months.csv",
        "more-than-six-months": "4. More Than Six Months.csv",
        all: "5. All.csv",
      })[w],
  },
} as const;

type MirrorName = keyof typeof MIRRORS;

// ── cache ───────────────────────────────────────────────────────────────────

function cacheRead(rel: string): string | null {
  try {
    const f = path.join(CACHE_DIR, rel);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
  } catch {
    return null;
  }
}

function cacheWrite(rel: string, body: string): void {
  try {
    const f = path.join(CACHE_DIR, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  } catch {
    /* cache is an optimisation, never a requirement */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, cacheKey: string, refresh: boolean): Promise<string | null> {
  if (!refresh) {
    const hit = cacheRead(cacheKey);
    if (hit !== null) return hit;
  }
  const res = await fetch(url, { headers: { "user-agent": "warmreach-prep" } });
  if (!res.ok) return null;
  const body = await res.text();
  cacheWrite(cacheKey, body);
  return body;
}

// ── mirrors ─────────────────────────────────────────────────────────────────

/**
 * The two mirrors disagree on directory casing ("linkedin" vs "LinkedIn"), and
 * neither is guessable for multi-word companies. List the repo root once and
 * match case-insensitively.
 */
async function resolveDir(m: MirrorName, company: string, refresh: boolean): Promise<string | null> {
  const { repo } = MIRRORS[m];
  const body = await getText(
    `https://api.github.com/repos/${repo}/contents/`,
    `${m}/_root.json`,
    refresh,
  );
  if (!body) return null;
  try {
    const entries = JSON.parse(body) as { name: string; type: string }[];
    const want = companySlug(company);
    return entries.find((e) => e.type === "dir" && companySlug(e.name) === want)?.name ?? null;
  } catch {
    return null;
  }
}

const pct = (s: string): number => {
  const n = Number(String(s).replace("%", "").trim());
  return Number.isFinite(n) ? n : 0;
};

/**
 * liquidslr expresses acceptance as a bare decimal, but not consistently: its
 * LinkedIn file stores a 0–1 fraction (0.4553 → 45.5%) while its Tesla file
 * stores that divided by 100 again (0.005211 → 52.1% for Merge Intervals).
 * Same column, same repo, scales differing by 100×.
 *
 * Rather than pick a convention and mangle whichever files disagree, scale up
 * until the number lands in a plausible acceptance band. Anything that still
 * doesn't is returned as 0 = unknown, and public enrichment fills it in.
 */
function acceptanceFromDecimal(raw: string): number {
  let v = Number(String(raw).trim());
  if (!Number.isFinite(v) || v <= 0) return 0;
  while (v <= 1) v *= 100;
  return v <= 100 ? v : 0;
}

const slugFromUrl = (u: string): string => {
  const m = u.match(/\/problems\/([^/?#]+)/);
  return m ? m[1] : "";
};

const normDifficulty = (d: string): Difficulty => {
  const s = d.trim().toLowerCase();
  return s === "easy" ? "Easy" : s === "hard" ? "Hard" : "Medium";
};

/** A question as one source saw it, before merging. */
interface RawQ {
  slug: string;
  id: number;
  title: string;
  difficulty: Difficulty;
  acceptance: number;
  tags: string[];
}

function parseMirrorCsv(m: MirrorName, text: string): RawQ[] {
  return parseCsvRecords(text)
    .map((r): RawQ | null => {
      if (m === "snehasishroy") {
        // ID,URL,Title,Difficulty,Acceptance %,Frequency %  →  "45.9%"
        const slug = slugFromUrl(r["URL"] ?? "");
        if (!slug) return null;
        return {
          slug,
          id: Number(r["ID"]) || 0,
          title: r["Title"] ?? "",
          difficulty: normDifficulty(r["Difficulty"] ?? ""),
          acceptance: pct(r["Acceptance %"] ?? ""),
          tags: [],
        };
      }
      // liquidslr — Difficulty,Title,Frequency,Acceptance Rate,Link,Topics
      // Acceptance Rate is a bare decimal on an inconsistent scale; see
      // acceptanceFromDecimal. This is the mirror that carries Topics, though,
      // which is why it's worth merging at all.
      const slug = slugFromUrl(r["Link"] ?? "");
      if (!slug) return null;
      return {
        slug,
        id: 0, // this mirror carries no question number
        title: r["Title"] ?? "",
        difficulty: normDifficulty(r["Difficulty"] ?? ""),
        acceptance: acceptanceFromDecimal(r["Acceptance Rate"] ?? ""),
        tags: (r["Topics"] ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      };
    })
    .filter((q): q is RawQ => !!q);
}

async function fetchMirror(
  m: MirrorName,
  company: string,
  refresh: boolean,
): Promise<{ perWindow: Map<Window, RawQ[]>; source: PrepSource } | null> {
  const dir = await resolveDir(m, company, refresh);
  if (!dir) return null;
  const cfg = MIRRORS[m];
  const perWindow = new Map<Window, RawQ[]>();

  for (const w of WINDOWS) {
    const file = cfg.file(w);
    if (!file) continue;
    const url =
      `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/` +
      `${encodeURIComponent(dir)}/${encodeURIComponent(file)}`;
    const text = await getText(url, `${m}/${companySlug(company)}/${w}.csv`, refresh);
    // A missing window is normal, not an error: Tesla has no thirty-days list
    // in either mirror, and LinkedIn has none in snehasishroy.
    if (!text) continue;
    const rows = parseMirrorCsv(m, text);
    if (rows.length) perWindow.set(w, rows);
  }
  if (!perWindow.size) return null;
  return {
    perWindow,
    source: { repo: cfg.repo, snapshot: cfg.snapshot, windows: [...perWindow.keys()] },
  };
}

// ── premium replay ──────────────────────────────────────────────────────────

export class PrepSessionError extends Error {}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Parse a "Copy as cURL" blob from DevTools. We replay the request the browser
 * already made rather than reconstructing LeetCode's private GraphQL contract
 * from guesswork — the operation name and variable shape change often enough
 * that every public scraper built against a guessed shape is now broken.
 */
export function parseCurl(curl: string): CapturedRequest {
  const text = curl.replace(/\\\r?\n/g, " ");
  const url = text.match(/curl\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
  const headers: Record<string, string> = {};
  for (const m of text.matchAll(/-H\s+'([^']+)'|-H\s+"([^"]+)"/g)) {
    const raw = m[1] ?? m[2] ?? "";
    const i = raw.indexOf(":");
    if (i > 0) headers[raw.slice(0, i).trim().toLowerCase()] = raw.slice(i + 1).trim();
  }
  const cookie = text.match(/-b\s+'([^']+)'|--cookie\s+'([^']+)'/);
  if (cookie) headers["cookie"] = cookie[1] ?? cookie[2] ?? "";
  const body = text.match(
    /--data(?:-raw|-binary)?\s+'([\s\S]*?)'(?:\s+-|\s*$)|--data(?:-raw|-binary)?\s+"([\s\S]*?)"(?:\s+-|\s*$)/,
  );

  const target = url?.[1] ?? url?.[2] ?? url?.[3] ?? "";
  if (!target) throw new PrepSessionError("Could not read a URL out of the captured cURL command.");
  if (!headers["cookie"]) {
    throw new PrepSessionError(
      "The captured cURL has no cookies, so it can't authenticate. Re-copy it with “Copy as cURL” from a logged-in tab.",
    );
  }
  return { url: target, headers, body: body?.[1] ?? body?.[2] ?? "" };
}

function readCapture(): CapturedRequest {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new PrepSessionError(
      `No captured LeetCode request found. Open leetcode.com/company/<name>/ while logged in, ` +
        `DevTools → Network → filter "graphql" → change the window filter → right-click the ` +
        `request → Copy as cURL, and save it to ${path.relative(process.cwd(), SESSION_FILE)}.`,
    );
  }
  return parseCurl(fs.readFileSync(SESSION_FILE, "utf8"));
}

/**
 * Swap the company and window into the captured request. LeetCode addresses a
 * company list as "<company>-<window>" (linkedin-six-months, tesla-thirty-days),
 * so one capture covers every company by string substitution.
 */
function retarget(body: string, company: string, w: Window): string {
  return body.replace(
    /"(favoriteSlug|slug)"\s*:\s*"[a-z0-9-]+"/g,
    `"$1":"${companySlug(company)}-${w}"`,
  );
}

/**
 * LeetCode's response shape for this query isn't public and has changed before,
 * so rather than hard-code a path into the JSON, find the first array whose
 * elements look like questions. Survives the operation being renamed or the
 * payload being re-nested.
 */
function harvest(node: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 8 || node === null || typeof node !== "object") return [];
  if (Array.isArray(node)) {
    const objs = node.filter(
      (e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e),
    );
    if (objs.length && objs.every((e) => "titleSlug" in e || ("title" in e && "difficulty" in e))) {
      return objs;
    }
    return node.flatMap((e) => harvest(e, depth + 1));
  }
  return Object.values(node as Record<string, unknown>).flatMap((v) => harvest(v, depth + 1));
}

async function fetchPremium(
  company: string,
  refresh: boolean,
): Promise<{ perWindow: Map<Window, RawQ[]>; source: PrepSource }> {
  const cap = readCapture();
  const perWindow = new Map<Window, RawQ[]>();

  for (const w of WINDOWS) {
    const cacheKey = `premium/${companySlug(company)}/${w}.json`;
    let body = refresh ? null : cacheRead(cacheKey);

    if (body === null) {
      // Deliberately slow and sequential — one request per window, spaced the
      // way a person clicking the filter would be.
      await sleep(2000 + Math.random() * 2000);
      const res = await fetch(cap.url, {
        method: "POST",
        headers: cap.headers,
        body: retarget(cap.body, company, w),
      });
      if (res.status === 403 || res.status === 401) {
        throw new PrepSessionError(
          "LeetCode rejected the captured session (403). It has expired — capture a fresh cURL and try again.",
        );
      }
      if (!res.ok) throw new PrepSessionError(`LeetCode returned ${res.status} for the ${w} window.`);
      body = await res.text();
      cacheWrite(cacheKey, body);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // HTML instead of JSON means a Cloudflare interstitial, not an empty list.
      throw new PrepSessionError(
        "LeetCode returned a non-JSON response — the session is being challenged. Capture a fresh cURL from a working tab.",
      );
    }
    const errs = (parsed as { errors?: { message?: string }[] }).errors;
    if (errs?.length) throw new PrepSessionError(`LeetCode: ${errs[0]?.message ?? "query rejected"}`);

    const rows = harvest(parsed).map(
      (e): RawQ => ({
        slug: String(e.titleSlug ?? ""),
        id: Number(e.questionFrontendId ?? e.frontendQuestionId ?? e.id ?? 0) || 0,
        title: String(e.title ?? ""),
        difficulty: normDifficulty(String(e.difficulty ?? "")),
        acceptance: typeof e.acRate === "number" ? e.acRate : pct(String(e.acRate ?? "0")),
        tags: Array.isArray(e.topicTags)
          ? (e.topicTags as { name?: string }[]).map((t) => String(t.name ?? "")).filter(Boolean)
          : [],
      }),
    );
    const good = rows.filter((r) => r.slug);
    // An empty window is a real answer (Tesla often has no 30-day questions).
    // Only record it when we actually got a parseable payload, which we did.
    if (good.length) perWindow.set(w, good);
  }

  return {
    perWindow,
    source: {
      repo: "leetcode.com (your Premium session)",
      snapshot: new Date().toISOString().slice(0, 10),
      windows: [...perWindow.keys()],
    },
  };
}

// ── public enrichment ───────────────────────────────────────────────────────

const QUESTION_DATA = `query questionData($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionFrontendId
    title
    titleSlug
    difficulty
    isPaidOnly
    stats
    topicTags { name }
    content
  }
}`;

interface Meta {
  id: number;
  title: string;
  difficulty: Difficulty;
  acceptance: number;
  tags: string[];
  statement: string;
  paidOnly: boolean;
}

// SQL questions open with an ASCII schema table, which survives tag-stripping
// as a wall of "+-----+-----+ | Column Name | Type |". The prose after it is
// the part worth previewing, so the table markup is dropped from the excerpt.
// (`|` appears in LeetCode statements only inside these tables.)
const stripTables = (s: string): string =>
  s.replace(/\+[-+]{2,}\+/g, " ").replace(/(?:\|[^|\n]*)+\|/g, " ");

const stripHtml = (html: string): string =>
  stripTables(html.replace(/<[^>]+>/g, " "))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** Public endpoint, no auth, no Premium. Keeps working if the session lapses. */
async function fetchMeta(slug: string, refresh: boolean): Promise<Meta | null> {
  const cacheKey = `meta/${slug}.json`;
  let body = refresh ? null : cacheRead(cacheKey);

  if (body === null) {
    await sleep(250);
    try {
      const res = await fetch(GRAPHQL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          referer: `https://leetcode.com/problems/${slug}/`,
          "user-agent": "warmreach-prep",
        },
        body: JSON.stringify({ query: QUESTION_DATA, variables: { titleSlug: slug } }),
      });
      if (!res.ok) return null;
      body = await res.text();
      cacheWrite(cacheKey, body);
    } catch {
      return null; // enrichment is best-effort; the row keeps its mirror values
    }
  }

  try {
    const q = (JSON.parse(body) as { data?: { question?: Record<string, unknown> } }).data?.question;
    if (!q) return null;
    const stats = JSON.parse(String(q.stats ?? "{}")) as { acRate?: string };
    const statement = stripHtml(String(q.content ?? ""));
    return {
      id: Number(q.questionFrontendId ?? 0) || 0,
      title: String(q.title ?? ""),
      difficulty: normDifficulty(String(q.difficulty ?? "")),
      acceptance: pct(stats.acRate ?? "0"),
      tags: Array.isArray(q.topicTags)
        ? (q.topicTags as { name?: string }[]).map((t) => String(t.name ?? "")).filter(Boolean)
        : [],
      statement: statement.length > 280 ? `${statement.slice(0, 277)}…` : statement,
      paidOnly: q.isPaidOnly === true,
    };
  } catch {
    return null;
  }
}

/**
 * Refresh an existing set's per-question metadata in place, leaving membership
 * and ordering untouched.
 *
 * This is the whole sync story for a study plan: no mirror carries them, and a
 * plan's contents change only when LeetCode revises the curriculum. What does
 * drift is acceptance, and occasionally a title or difficulty — all of which
 * the public endpoint gives us without a session.
 */
export async function refreshSetMeta(set: PrepSet, refresh = false): Promise<SyncResult> {
  const warnings: string[] = [];
  let updated = 0;

  const questions: PrepQuestion[] = [];
  for (const q of set.questions) {
    const meta = await fetchMeta(q.slug, refresh);
    if (!meta) {
      warnings.push(`Could not refresh ${q.slug}.`);
      questions.push(q); // keep what we had rather than blanking the row
      continue;
    }
    updated++;
    questions.push({
      ...q,
      id: meta.id || q.id,
      title: meta.title || q.title,
      difficulty: meta.difficulty,
      acceptance: meta.acceptance || q.acceptance,
      tags: meta.tags.length ? meta.tags : q.tags,
      statement: meta.statement || q.statement,
      paidOnly: meta.paidOnly,
    });
  }
  if (!updated) {
    warnings.push("Nothing refreshed — LeetCode's public API may be rate-limiting.");
  }

  return {
    set: { ...set, questions, syncedAt: new Date().toISOString() },
    warnings,
  };
}

// ── build ───────────────────────────────────────────────────────────────────

export type SyncMode = "mirrors" | "premium";

export interface SyncOptions {
  company: string;
  label?: string;
  mode: SyncMode;
  refresh?: boolean;
  enrich?: boolean;
}

export interface SyncResult {
  set: PrepSet;
  warnings: string[];
}

export async function buildPrepSet(opts: SyncOptions): Promise<SyncResult> {
  const { company, mode, refresh = false, enrich = true } = opts;
  const warnings: string[] = [];
  const sources: PrepSource[] = [];
  // Tightest window wins, so collect narrowest-first and let later (wider)
  // sources fill gaps without overwriting a tighter classification.
  const windowsBySlug = new Map<string, Set<Window>>();
  const bySlug = new Map<string, RawQ>();
  let widest: RawQ[] = [];

  const absorb = (perWindow: Map<Window, RawQ[]>, authoritative: boolean) => {
    for (const w of WINDOWS) {
      const rows = perWindow.get(w);
      if (!rows) continue;
      for (const r of rows) {
        if (!windowsBySlug.has(r.slug)) windowsBySlug.set(r.slug, new Set());
        windowsBySlug.get(r.slug)!.add(w);
        const prev = bySlug.get(r.slug);
        if (!prev) {
          bySlug.set(r.slug, { ...r });
          continue;
        }
        // Merge field by field rather than letting one source win outright.
        // The two mirrors are complementary — snehasishroy has question numbers
        // and reliable acceptance, liquidslr has the topic tags — so taking
        // either wholesale throws away the half only the other one carries.
        bySlug.set(r.slug, {
          slug: r.slug,
          id: authoritative ? r.id || prev.id : prev.id || r.id,
          title: authoritative && r.title ? r.title : prev.title || r.title,
          difficulty: authoritative ? r.difficulty : prev.difficulty,
          acceptance: authoritative
            ? r.acceptance || prev.acceptance
            : prev.acceptance || r.acceptance,
          tags: authoritative && r.tags.length ? r.tags : prev.tags.length ? prev.tags : r.tags,
        });
      }
      if (rows.length > widest.length) widest = rows;
    }
  };

  if (mode === "premium") {
    const prem = await fetchPremium(company, refresh);
    absorb(prem.perWindow, true);
    sources.push(prem.source);
  }

  for (const m of ["snehasishroy", "liquidslr"] as MirrorName[]) {
    try {
      const got = await fetchMirror(m, company, refresh);
      if (got) {
        absorb(got.perWindow, false);
        sources.push(got.source);
      } else {
        warnings.push(`No ${m} data for "${company}".`);
      }
    } catch (e) {
      warnings.push(`${m} fetch failed: ${(e as Error).message}`);
    }
  }

  if (!bySlug.size) {
    throw new Error(
      `No questions found for "${company}" in any source. Check the company name, or run a premium sync.`,
    );
  }

  // Rank = position in the widest list we retrieved, which is the order
  // LeetCode itself returns — i.e. its frequency ranking.
  const rankOf = new Map<string, number>();
  widest.forEach((r, i) => rankOf.set(r.slug, i + 1));

  const slugs = [...bySlug.keys()].sort(
    (a, b) => (rankOf.get(a) ?? 9999) - (rankOf.get(b) ?? 9999),
  );

  const questions: PrepQuestion[] = [];
  for (const slug of slugs) {
    const r = bySlug.get(slug)!;
    const meta = enrich ? await fetchMeta(slug, refresh) : null;
    const windows = WINDOWS.filter((w) => windowsBySlug.get(slug)?.has(w));
    questions.push({
      id: meta?.id || r.id || 0,
      slug,
      title: meta?.title || r.title,
      difficulty: meta?.difficulty ?? r.difficulty,
      acceptance: meta?.acceptance ?? r.acceptance,
      rank: rankOf.get(slug) ?? questions.length + 1,
      windows,
      lcSolved: false, // the mirrors can't know this; premium capture may fill it later
      tags: meta?.tags.length ? meta.tags : r.tags,
      statement: meta?.statement ?? "",
      paidOnly: meta?.paidOnly ?? false,
    });
  }
  if (enrich && !questions.some((q) => q.statement || q.paidOnly)) {
    warnings.push("Statement enrichment returned nothing — LeetCode's public API may be rate-limiting.");
  }

  return {
    set: {
      company: companySlug(company),
      // This path only ever builds company tags — study plans come from seeds
      // and are refreshed in place, since no mirror carries them.
      kind: "company",
      // "tesla" → "Tesla". Imperfect for names like LinkedIn, but the sync route
      // keeps whatever label is already on file, so it only ever applies once.
      label:
        opts.label?.trim() ||
        companySlug(company)
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" "),
      syncedAt: new Date().toISOString(),
      sources,
      questions,
    },
    warnings,
  };
}
