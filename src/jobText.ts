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
  title?: string; // the posting's own title, when the board's API returns one
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
const ashbyBoards = new Map<string, { at: number; jobs: Map<string, { text: string; title?: string }> }>();
const ASHBY_TTL_MS = 10 * 60 * 1000;

async function ashbyBoard(org: string): Promise<Map<string, { text: string; title?: string }>> {
  const hit = ashbyBoards.get(org);
  if (hit && Date.now() - hit.at < ASHBY_TTL_MS) return hit.jobs;

  const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`, {
    headers: { Accept: "application/json" },
  });
  const jobs = new Map<string, { text: string; title?: string }>();
  if (res.ok) {
    const data = (await res.json()) as { jobs?: { id?: string; title?: string; descriptionPlain?: string }[] };
    for (const j of data.jobs ?? []) {
      if (j.id && j.descriptionPlain) jobs.set(j.id, { text: j.descriptionPlain, title: j.title });
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
  const hit = board.get(jobId);
  if (!hit || hit.text.length < 400) return null;
  return { text: hit.text.slice(0, MAX_CHARS), source: "jobs.ashbyhq.com", title: hit.title };
}

// ── Greenhouse, Lever, Workday ──────────────────────────────────────────────
// The other three boards behind most applications. Each has a public JSON
// endpoint that returns the description and the real title, which the HTML path
// can't: Greenhouse's embed/job_app link is the application FORM (no JD), a
// Lever /apply link is the same, and Workday pages are an empty SPA shell.

async function getJson(url: string, init?: RequestInit): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function finish(text: string, source: string, title?: string): JobText | null {
  const t = text.trim();
  if (t.length < 400) return null;
  return { text: t.slice(0, MAX_CHARS), source, title: title?.trim() || undefined };
}

// job-boards.greenhouse.io/{board}/jobs/{id}  or  …/embed/job_app?for={board}&token={id}
async function fetchGreenhouse(u: URL): Promise<JobText | null> {
  let board = u.searchParams.get("for");
  let id = u.searchParams.get("token");
  if (!board || !id) {
    const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    if (!m) return null;
    [, board, id] = m;
  }
  const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}`);
  if (!data?.content) return null;
  // Greenhouse double-encodes: the HTML itself arrives entity-escaped.
  return finish(htmlToText(decodeEntities(String(data.content))), "greenhouse.io", data.title);
}

// jobs.lever.co/{company}/{id}[/apply]
async function fetchLever(u: URL): Promise<JobText | null> {
  const [company, id] = u.pathname.split("/").filter(Boolean);
  if (!company || !id) return null;
  const data = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(company)}/${encodeURIComponent(id)}`);
  if (!data?.descriptionPlain) return null;
  const lists = (data.lists ?? [])
    .map((l: { text?: string; content?: string }) => `${l.text ?? ""}\n${htmlToText(l.content ?? "")}`)
    .join("\n\n");
  return finish([data.descriptionPlain, lists, data.additionalPlain ?? ""].join("\n\n"), "lever.co", data.text);
}

// {tenant}.wd5.myworkdayjobs.com/[en-US/]{site}/job/{location}/{slug}
async function fetchWorkday(u: URL): Promise<JobText | null> {
  const tenant = u.hostname.split(".")[0];
  const parts = u.pathname.split("/").filter(Boolean);
  if (/^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? "")) parts.shift();
  const jobAt = parts.indexOf("job");
  if (jobAt < 1) return null;
  const site = parts[jobAt - 1];
  const rest = parts.slice(jobAt).join("/");
  const data = await getJson(`https://${u.hostname}/wday/cxs/${tenant}/${site}/${rest}`);
  const info = data?.jobPostingInfo;
  if (!info?.jobDescription) return null;
  return finish(htmlToText(String(info.jobDescription)), "myworkdayjobs.com", info.title);
}

async function fetchFromBoardApi(url: string): Promise<JobText | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  try {
    if (/(^|\.)greenhouse\.io$/.test(host)) return await fetchGreenhouse(u);
    if (host === "jobs.lever.co") return await fetchLever(u);
    if (/\.myworkdayjobs\.com$/.test(host)) return await fetchWorkday(u);
  } catch {
    return null;
  }
  return null;
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

  // Board APIs first — a miss there still falls through to the plain page fetch.
  const viaApi = await fetchFromBoardApi(url as string);
  if (viaApi) return viaApi;

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
