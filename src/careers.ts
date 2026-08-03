import { promises as dns } from "node:dns";

// ── Generic careers inboxes ─────────────────────────────────────────────────
// The "third kind" of outreach target (alongside recruiters and engineers): a
// shot at a company's careers/jobs queue, guessed from its domain. These are
// GUESSES — the MX check only proves the DOMAIN accepts mail, not that a given
// mailbox exists — so callers surface them opt-in and clearly labeled, never
// auto-selected, to protect sender reputation from bounces.

export const CAREERS_PREFIXES = ["careers", "jobs", "recruiting"] as const;
export type CareersPrefix = (typeof CAREERS_PREFIXES)[number];

export interface CareersInbox {
  prefix: CareersPrefix;
  email: string;
}

// Domain → has-MX, memoized for the process: a domain's MX rarely changes within
// a run, and one campaign can resolve the same domain repeatedly.
const mxCache = new Map<string, Promise<boolean>>();

export function hasMx(domain: string): Promise<boolean> {
  const d = domain.trim().toLowerCase();
  if (!d) return Promise.resolve(false);
  let hit = mxCache.get(d);
  if (!hit) {
    // A "null MX" (RFC 7505: a single record whose exchange is "." or empty) is an
    // explicit "this domain accepts NO mail" — treat it as no MX so we don't guess
    // addresses at a domain that has opted out of email.
    hit = dns
      .resolveMx(d)
      .then((r) => r.some((m) => m.exchange && m.exchange !== "."))
      .catch(() => false);
    mxCache.set(d, hit);
  }
  return hit;
}

// careers@/jobs@/recruiting@ for a domain, but ONLY if the domain can actually
// receive mail (MX present). Returns [] for a missing or dead domain so callers
// never surface a guaranteed-bounce address.
export async function careersInboxes(domain: string | null | undefined): Promise<CareersInbox[]> {
  const d = (domain ?? "").trim().toLowerCase();
  if (!d || !(await hasMx(d))) return [];
  return CAREERS_PREFIXES.map((prefix) => ({ prefix, email: `${prefix}@${d}` }));
}
