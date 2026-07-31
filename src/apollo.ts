import { APOLLO_API_KEY } from "./config";

const BASE = "https://api.apollo.io/api/v1";

const HEADERS = {
  "Content-Type": "application/json",
  accept: "application/json",
  "Cache-Control": "no-cache",
  "X-Api-Key": APOLLO_API_KEY,
};

// Titles we look for, in rough priority order. Founders/eng leads matter at
// small startups that have no dedicated recruiter.
export const DEFAULT_TITLES = [
  "recruiter",
  "technical recruiter",
  "talent acquisition",
  "talent",
  "people operations",
  "head of talent",
  "engineering manager",
  "head of engineering",
  "vp engineering",
  "cto",
  "co-founder",
  "founder",
  "hiring manager",
];

// Campaign targeting groups (Campaigns page). The user picks which groups to
// reach at each company; the union of the picked groups' titles is passed to
// searchContacts. Keys are stable ids the UI sends back.
export const TITLE_GROUPS: Record<string, { label: string; titles: string[] }> = {
  founders: {
    label: "Founders / C-level",
    titles: ["founder", "co-founder", "ceo", "chief executive officer", "president", "coo"],
  },
  engineering: {
    label: "Engineering leaders",
    titles: [
      "cto",
      "chief technology officer",
      "vp engineering",
      "head of engineering",
      "director of engineering",
      "engineering manager",
      "head of ai",
      "head of machine learning",
      "principal engineer",
      "staff engineer",
      "tech lead",
    ],
  },
  recruiters: {
    label: "Recruiters / Talent",
    titles: [
      "recruiter",
      "technical recruiter",
      "talent acquisition",
      "talent",
      "head of talent",
      "head of people",
      "people operations",
    ],
  },
};

// Resolve the picked group ids (+ any freeform custom titles) into a deduped
// title list for Apollo. Unknown ids are ignored; empty selection -> DEFAULT_TITLES.
export function titlesForGroups(groupIds: string[], custom: string[] = []): string[] {
  const out = new Set<string>();
  for (const id of groupIds) TITLE_GROUPS[id]?.titles.forEach((t) => out.add(t));
  for (const t of custom) {
    const v = t.trim().toLowerCase();
    if (v) out.add(v);
  }
  return out.size ? [...out] : DEFAULT_TITLES;
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Apollo POST ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function get(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Apollo GET ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export interface Company {
  orgId?: string;
  domain?: string;
  name: string;
  description: string | null;
  keywords: string[];
  employees?: number;
  logoUrl?: string; // Apollo org logo (free — already on the resolved org object)
}

// Pull the company facts we personalize from off an Apollo org object. The
// domain path (organizations/enrich) is rich; the name path (search) may be thinner.
// NOTE: "account" results carry the real org id in `organization_id` (their `id`
// is an account id that returns no people if used as organization_ids).
function companyFromOrg(org: any, fallbackDomain?: string): Company {
  return {
    orgId: org.organization_id ?? org.id,
    domain: org.primary_domain ?? fallbackDomain,
    name: org.name,
    description: org.short_description ?? null,
    keywords: (org.keywords ?? []).slice(0, 12),
    employees: org.estimated_num_employees ?? undefined,
    logoUrl: org.logo_url ?? undefined,
  };
}

function looksLikeDomain(input: string): boolean {
  return /\.[a-z]{2,}$/i.test(input) && !input.includes(" ");
}

// How well an org name matches the query: exact > prefix > whole-word > none.
function nameMatchScore(name: string, query: string): number {
  const n = (name ?? "").toLowerCase().trim();
  const q = query.toLowerCase().trim();
  if (!n || !q) return 0;
  if (n === q) return 3;
  if (n.startsWith(q)) return 2;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b${escaped}\\b`).test(n)) return 1;
  return 0;
}

// Ranked company candidates for a NAME query. Apollo's relevance order is poor
// (a "Klaviyo partner agency" can outrank Klaviyo itself), so we re-rank by
// name-match quality, then by employee count, and de-dupe.
export async function searchCompanies(name: string, limit = 6): Promise<Company[]> {
  const data = await post("/mixed_companies/search", { q_organization_name: name, per_page: 10 });
  const raw = [...(data.organizations ?? []), ...(data.accounts ?? [])];
  const companies = raw.map((o: any) => companyFromOrg(o));

  companies.sort((a, b) => {
    const s = nameMatchScore(b.name, name) - nameMatchScore(a.name, name);
    if (s !== 0) return s;
    return (b.employees ?? 0) - (a.employees ?? 0);
  });

  const seen = new Set<string>();
  const out: Company[] = [];
  for (const c of companies) {
    const key = c.domain ?? c.orgId ?? c.name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

// Ranked candidates for either a domain (single, exact) or a name (best-first).
export async function resolveCompanyOptions(input: string): Promise<Company[]> {
  if (looksLikeDomain(input)) {
    const data = await get(`/organizations/enrich?domain=${encodeURIComponent(input)}`);
    const org = data.organization;
    if (!org) throw new Error(`No Apollo organization for domain "${input}"`);
    return [companyFromOrg(org, input)];
  }
  const opts = await searchCompanies(input);
  if (opts.length === 0) throw new Error(`No Apollo organization found for "${input}"`);
  return opts;
}

// Accepts either a domain ("acme.com") or a company name ("Acme AI").
// Returns the single best match (use resolveCompanyOptions for disambiguation).
export async function resolveCompany(input: string): Promise<Company> {
  return (await resolveCompanyOptions(input))[0];
}

export interface SearchResult {
  id: string;
  first_name: string;
  title: string;
  has_email: boolean;
}

// Paginates Apollo people-search (free) up to `limit`, so big companies aren't
// truncated to a single page. Safety-bounded by limit (default 500).
export async function searchContacts(
  company: Company,
  titles: string[] = DEFAULT_TITLES,
  limit = 500,
  locations: string[] = [],
): Promise<SearchResult[]> {
  const orgFilter: Record<string, unknown> = company.orgId
    ? { organization_ids: [company.orgId] }
    : company.domain
      ? { q_organization_domains_list: [company.domain] }
      : {};
  // Apollo's person_locations filter (e.g. ["United States"], ["Canada"]).
  const locationFilter = locations.length ? { person_locations: locations } : {};

  const out: SearchResult[] = [];
  const seen = new Set<string>(); // Apollo can repeat a person across pages — dedupe by id
  const maxPages = Math.max(1, Math.ceil(limit / 100));
  for (let page = 1; page <= maxPages; page++) {
    const data = await post("/mixed_people/api_search", {
      person_titles: titles,
      page,
      per_page: 100,
      ...orgFilter,
      ...locationFilter,
    });
    const people = data.people ?? [];
    for (const p of people) {
      if (!p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ id: p.id, first_name: p.first_name, title: p.title, has_email: p.has_email ?? false });
    }
    if (people.length < 100) break; // reached the last page
  }
  return out.slice(0, limit);
}

export interface Contact {
  firstName: string;
  lastName: string;
  fullName: string;
  title: string;
  email: string | null;
  emailStatus: string | null;
  seniority: string | null;
  linkedin: string | null;
  company: {
    name: string;
    description: string | null;
    keywords: string[];
  };
}

// Costs 1 Apollo credit per matched person. Returns the verified email + full name.
export async function enrichPerson(id: string, domain?: string): Promise<Contact> {
  const body: Record<string, unknown> = { id };
  if (domain) body.domain = domain;
  const data = await post("/people/match", body);
  const p = data.person;
  if (!p) throw new Error(`Enrichment returned no person for id ${id}`);
  const org = p.organization ?? {};
  return {
    firstName: p.first_name,
    lastName: p.last_name,
    fullName: p.name,
    title: p.title,
    email: p.email ?? null,
    emailStatus: p.email_status ?? null,
    seniority: p.seniority ?? null,
    linkedin: p.linkedin_url ?? null,
    company: {
      name: org.name ?? domain ?? "the company",
      description: org.short_description ?? null,
      keywords: (org.keywords ?? []).slice(0, 12),
    },
  };
}
