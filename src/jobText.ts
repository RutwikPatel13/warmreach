// ── Job description fetcher ─────────────────────────────────────────────────
// Apollo's job_postings endpoint returns a title, a URL, and a city — never a
// description. So to score a role against a résumé we have to go get the text
// ourselves.
//
// This succeeds on company-hosted boards (Greenhouse/Lever/Ashby and bespoke
// career pages are server-rendered) and fails on LinkedIn, which serves an
// interstitial to anything without a session. Roughly half of a big company's
// Apollo postings point at LinkedIn — Stripe's split is 259 LinkedIn / 190
// stripe.com — so failure is the normal case, not an error case. Callers get
// null and score on the title alone, and the UI says so.

const FETCH_TIMEOUT_MS = 12_000;
const MAX_CHARS = 12_000; // ~3k tokens; JDs past this are boilerplate

// Hosts that reliably refuse an unauthenticated fetch. Skipped without trying
// so a sweep isn't spending 12s per posting to learn what we already know.
const BLOCKED_HOSTS = [/(^|\.)linkedin\.com$/i, /(^|\.)glassdoor\./i, /(^|\.)indeed\.com$/i];

export interface JobText {
  text: string;
  source: string; // hostname the text came from, shown on the match card
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function isFetchable(url: string | null | undefined): boolean {
  if (!url) return false;
  const host = hostOf(url);
  if (!host) return false;
  return !BLOCKED_HOSTS.some((re) => re.test(host));
}

// Strip an HTML document to readable text. Deliberately crude — no parser
// dependency, and the model tolerates imperfect whitespace far better than it
// tolerates a missing description.
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

// ── Ashby ───────────────────────────────────────────────────────────────────
// jobs.ashbyhq.com is a client-rendered SPA, so the generic path below gets an
// empty shell. It does publish the whole board as JSON though, with the
// description already in plain text — better input than any HTML strip. Worth
// the special case because Ashby is the ATS behind a lot of startups (Ramp's
// 53-of-80 postings among them).
//
// One board fetch serves every posting from that company in a sweep, so the
// response is memoized for the run.
const ashbyBoards = new Map<string, { at: number; jobs: Map<string, string> }>();
const ASHBY_TTL_MS = 10 * 60 * 1000;

async function ashbyBoard(org: string): Promise<Map<string, string>> {
  const hit = ashbyBoards.get(org);
  if (hit && Date.now() - hit.at < ASHBY_TTL_MS) return hit.jobs;

  const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`, {
    headers: { Accept: "application/json" },
  });
  const jobs = new Map<string, string>();
  if (res.ok) {
    const data = (await res.json()) as { jobs?: { id?: string; descriptionPlain?: string }[] };
    for (const j of data.jobs ?? []) {
      if (j.id && j.descriptionPlain) jobs.set(j.id, j.descriptionPlain);
    }
  }
  ashbyBoards.set(org, { at: Date.now(), jobs });
  return jobs;
}

async function fetchAshby(url: string): Promise<JobText | null> {
  // https://jobs.ashbyhq.com/{org}/{jobId}
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const [org, jobId] = parts;
  if (!org || !jobId) return null;

  const board = await ashbyBoard(org);
  const text = board.get(jobId);
  if (!text || text.length < 400) return null;
  return { text: text.slice(0, MAX_CHARS), source: "jobs.ashbyhq.com" };
}

/**
 * Fetch a posting and return its text, or null if that isn't possible.
 * Never throws — a description is a nice-to-have, not a precondition.
 */
export async function fetchJobText(url: string | null | undefined): Promise<JobText | null> {
  if (!isFetchable(url)) return null;

  if (/(^|\.)ashbyhq\.com$/i.test(hostOf(url as string) ?? "")) {
    try {
      return await fetchAshby(url as string);
    } catch {
      return null;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url as string, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // Plain-looking UA: several boards return a stub to obvious scripts.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return null;

    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) return null;

    const body = await res.text();
    const text = /text\/plain/i.test(type) ? body.trim() : htmlToText(body);

    // A page that yields almost nothing is a JS shell — treat it as a miss so
    // the card reports "no description" instead of scoring on navigation chrome.
    if (text.length < 400) return null;

    return { text: text.slice(0, MAX_CHARS), source: hostOf(url as string) ?? "web" };
  } catch {
    return null; // timeout, DNS, TLS, abort — all the same to the caller
  } finally {
    clearTimeout(timer);
  }
}
