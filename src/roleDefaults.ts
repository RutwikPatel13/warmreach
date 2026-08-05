// ── Role keywords ───────────────────────────────────────────────────────────
// Deliberately dependency-free (no node:fs, no Apollo) so the browser bundle can
// import the defaults without dragging the watchlist store in with them.
//
// Matching is token-based, not substring. A plain `title.includes("backend
// engineer")` looks reasonable and then silently misses "Software Engineer,
// Backend" — which is how half of all backend roles are actually titled. So a
// keyword matches when every one of its words appears somewhere in the title, in
// any order.
//
// A slash separates alternatives: "ios/swift" matches either. That's what lets
// one chip cover the several ways a company might name the same job.

export const DEFAULT_ROLE_KEYWORDS = [
  "software engineer",
  "backend engineer",
  "frontend engineer",
  "full stack/fullstack",
  "react",
  "python",
  "data engineer",
  "ai engineer",
  "machine learning",
  "infrastructure",
  "embedded",
  "ios/swift",
  "qa engineer/quality assurance/software testing",
  "database administrator/dba",
  "new grad/university grad/entry level",
];

// Word characters plus the ones that carry meaning in job titles: C++, C#, .NET.
const WORD_SPLIT = /[^a-z0-9+#.]+/i;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when every word of the keyword appears in the title. Words match at a
 * word boundary but not at the end, so "engineer" still catches "engineers" —
 * while "ai" can't match the middle of "chair".
 */
export function keywordMatchesTitle(title: string, keyword: string): boolean {
  const haystack = title.toLowerCase();
  return keyword
    .toLowerCase()
    .split("/")
    .some((alternative) => {
      const words = alternative.split(WORD_SPLIT).filter(Boolean);
      if (words.length === 0) return false;
      return words.every((w) => new RegExp(`\\b${escapeRegex(w)}`).test(haystack));
    });
}

/** True when any keyword matches. An empty list means "every role". */
export function titleMatchesAny(title: string, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  return keywords.some((k) => keywordMatchesTitle(title, k));
}
