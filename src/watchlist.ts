import fs from "node:fs";
import path from "node:path";

// ── Watchlist store ─────────────────────────────────────────────────────────
// Three JSON files on disk, all owned by this module and read/written nowhere
// else. Mirrors the durable-store half of scheduler.ts: read-modify-write whole
// files, fail open on anything unreadable. Nothing here talks to Apollo or
// Anthropic — jobWatch.ts does that and hands results back through save*().
//
//   watchlist.json      the companies you're watching (+ the optional contact)
//   seen_postings.json  posting ids already accounted for, per watch
//   matches.json        scored roles awaiting your attention
//
// The seen set is what makes a "new role" meaningful: Apollo returns a company's
// whole board every sweep, so without it every posting would look new forever.

const WATCH_STORE = path.resolve("data/watchlist.json");
const SEEN_STORE = path.resolve("data/seen_postings.json");
const MATCH_STORE = path.resolve("data/matches.json");

// Dismissed/asked matches older than this are pruned so the store stays small.
const KEEP_TERMINAL_MS = 30 * 24 * 60 * 60 * 1000;

export type ContactSource = "typed" | "contacts_csv" | "apollo_find";

/** Someone you know at a watched company. Every field past `name` is optional. */
export interface WatchContact {
  name: string;
  title?: string | null;
  email?: string | null;
  source: ContactSource;
  howYouKnowThem?: string | null;
}

export interface Watch {
  id: string;
  orgId: string;
  name: string;
  domain?: string | null;
  logoUrl?: string | null;
  /** Captured at add time so a sweep never needs a second Apollo call for context. */
  description?: string | null;
  keywords?: string[];
  /** Title keywords, lowercased. Empty means "every role". */
  titles: string[];
  /** Location substrings, lowercased. Empty means "anywhere". */
  locations: string[];
  /** null is a perfectly good value — a watch does not need a person. */
  contact: WatchContact | null;
  createdAt: string;
  lastSweptAt?: string | null;
  /** Set once the first sweep has recorded a baseline of existing postings. */
  baselinedAt?: string | null;
  lastError?: string | null;
}

export type MatchStatus = "new" | "asked" | "dismissed";

export interface MatchStrength {
  claim: string;
  resumeQuote: string;
}

export interface Match {
  id: string;
  watchId: string;
  postingId: string;
  company: string;
  domain?: string | null;
  logoUrl?: string | null;
  title: string;
  location?: string | null;
  url?: string | null;
  postedAt?: string | null;
  score: number;
  verdict: "strong" | "worth_a_look" | "stretch" | "skip";
  strengths: MatchStrength[];
  gaps: string[];
  referralLine: string;
  /** False when the posting description couldn't be fetched — a weaker read. */
  groundedInJd: boolean;
  jdSource?: string | null;
  contact: WatchContact | null;
  status: MatchStatus;
  foundAt: string;
  statusAt?: string | null;
}

// ── generic file helpers ────────────────────────────────────────────────────

function readJson<T>(file: string, fallback: T): T {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return (parsed ?? fallback) as T;
  } catch {
    return fallback; // missing / unreadable / malformed — treat as empty
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── watches ─────────────────────────────────────────────────────────────────

export function listWatches(): Watch[] {
  const list = readJson<Watch[]>(WATCH_STORE, []);
  return Array.isArray(list) ? list : [];
}

export interface NewWatch {
  orgId: string;
  name: string;
  domain?: string | null;
  logoUrl?: string | null;
  description?: string | null;
  keywords?: string[];
  titles?: string[];
  locations?: string[];
  contact?: WatchContact | null;
}

export function addWatch(input: NewWatch): Watch {
  const list = listWatches();
  // One watch per company — re-adding updates the filters instead of duplicating.
  const existing = list.find((w) => w.orgId === input.orgId);
  const watch: Watch = {
    id: existing?.id ?? id("wat"),
    orgId: input.orgId,
    name: input.name,
    domain: input.domain ?? null,
    logoUrl: input.logoUrl ?? null,
    description: input.description ?? existing?.description ?? null,
    keywords: input.keywords ?? existing?.keywords ?? [],
    titles: normList(input.titles),
    locations: normList(input.locations),
    contact: input.contact ?? null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastSweptAt: existing?.lastSweptAt ?? null,
    baselinedAt: existing?.baselinedAt ?? null,
    lastError: null,
  };
  writeJson(WATCH_STORE, existing ? list.map((w) => (w.id === watch.id ? watch : w)) : [...list, watch]);
  return watch;
}

function normList(v: string[] | undefined): string[] {
  return [...new Set((v ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

export function removeWatch(watchId: string): void {
  writeJson(WATCH_STORE, listWatches().filter((w) => w.id !== watchId));
  // Drop its seen-posting set too, so re-adding the company starts clean.
  const seen = readSeen();
  delete seen[watchId];
  writeJson(SEEN_STORE, seen);
}

export function patchWatch(watchId: string, patch: Partial<Watch>): void {
  writeJson(
    WATCH_STORE,
    listWatches().map((w) => (w.id === watchId ? { ...w, ...patch } : w)),
  );
}

// ── seen postings ───────────────────────────────────────────────────────────

type SeenMap = Record<string, string[]>;

function readSeen(): SeenMap {
  const raw = readJson<SeenMap>(SEEN_STORE, {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

export function seenFor(watchId: string): Set<string> {
  return new Set(readSeen()[watchId] ?? []);
}

/** Records posting ids as accounted-for. Capped so the file can't grow forever. */
export function markSeen(watchId: string, postingIds: string[]): void {
  if (postingIds.length === 0) return;
  const seen = readSeen();
  const merged = [...new Set([...(seen[watchId] ?? []), ...postingIds])];
  seen[watchId] = merged.slice(-4000);
  writeJson(SEEN_STORE, seen);
}

// ── matches ─────────────────────────────────────────────────────────────────

export function listMatches(): Match[] {
  const list = readJson<Match[]>(MATCH_STORE, []);
  return Array.isArray(list) ? list : [];
}

export function saveMatches(next: Match[]): void {
  if (next.length === 0) return;
  const existing = listMatches();
  const have = new Set(existing.map((m) => `${m.watchId}:${m.postingId}`));
  const fresh = next.filter((m) => !have.has(`${m.watchId}:${m.postingId}`));
  if (fresh.length === 0) return;
  writeJson(MATCH_STORE, prune([...fresh, ...existing]));
}

export function setMatchStatus(matchId: string, status: MatchStatus): void {
  writeJson(
    MATCH_STORE,
    listMatches().map((m) =>
      m.id === matchId ? { ...m, status, statusAt: new Date().toISOString() } : m,
    ),
  );
}

function prune(list: Match[]): Match[] {
  const cutoff = Date.now() - KEEP_TERMINAL_MS;
  return list.filter((m) => {
    if (m.status === "new") return true;
    const t = Date.parse(m.statusAt ?? m.foundAt);
    return Number.isNaN(t) || t > cutoff;
  });
}

/** Builds the Match record from a scored posting. Kept here so shape lives in one place. */
export function makeMatch(fields: Omit<Match, "id" | "status" | "foundAt">): Match {
  return { ...fields, id: id("mat"), status: "new", foundAt: new Date().toISOString() };
}
