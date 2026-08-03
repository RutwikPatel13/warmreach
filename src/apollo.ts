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
  last_name?: string | null;
  title: string;
  has_email: boolean;
  seniority?: string | null;
  linkedin?: string | null;
  photo?: string | null;
  location?: string | null;
}

// Paginates Apollo people-search (free) up to `limit`, so big companies aren't
// truncated to a single page. Safety-bounded by limit (default 500).
export async function searchContacts(
  company: Company,
  titles: string[] = DEFAULT_TITLES,
  limit = 500,
  locations: string[] = [],
  allPeople = false,
): Promise<SearchResult[]> {
  const orgFilter: Record<string, unknown> = company.orgId
    ? { organization_ids: [company.orgId] }
    : company.domain
      ? { q_organization_domains_list: [company.domain] }
      : {};
  // Apollo's person_locations filter (e.g. ["United States"], ["Canada"]).
  const locationFilter = locations.length ? { person_locations: locations } : {};
  // "Everyone at the company" — drop the title filter entirely so Apollo returns
  // all people at the org (bounded by `limit`). Useful for small startups where
  // you want to reach the whole team rather than specific roles.
  const titleFilter = allPeople ? {} : { person_titles: titles };

  const out: SearchResult[] = [];
  const seen = new Set<string>(); // Apollo can repeat a person across pages — dedupe by id
  const maxPages = Math.max(1, Math.ceil(limit / 100));
  for (let page = 1; page <= maxPages; page++) {
    const data = await post("/mixed_people/api_search", {
      ...titleFilter,
      page,
      per_page: 100,
      ...orgFilter,
      ...locationFilter,
    });
    const people = data.people ?? [];
    for (const p of people) {
      if (!p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({
        id: p.id,
        first_name: p.first_name,
        last_name: p.last_name ?? null,
        title: p.title,
        has_email: p.has_email ?? false,
        seniority: p.seniority ?? null,
        linkedin: p.linkedin_url ?? null,
        photo: p.photo_url ?? null,
        location: [p.city, p.state, p.country].filter(Boolean).join(", ") || null,
      });
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

// ── Company dossier + open roles (both FREE — no Apollo credits) ─────────────
// The dossier (organizations/enrich) and job postings power the /companies,
// dossier-modal, and /jobs surfaces. Neither endpoint consumes credits.

export interface CompanyDossier {
  orgId?: string;
  name: string;
  domain?: string;
  websiteUrl?: string | null;
  logoUrl?: string | null;
  description: string | null;
  industry?: string | null;
  foundedYear?: number | null;
  employees?: number | null;
  location?: string | null;
  keywords: string[];
  technologies: string[];
  linkedinUrl?: string | null;
  annualRevenue?: string | null;
  totalFunding?: string | null;
  latestFundingStage?: string | null;
  latestFundingDate?: string | null;
  publiclyTraded?: string | null;
}

// Map an Apollo org (organizations/enrich) into the rich dossier the UI shows.
function dossierFromOrg(org: any, fallbackDomain?: string): CompanyDossier {
  const techs: string[] = Array.isArray(org.current_technologies)
    ? org.current_technologies.map((t: any) => t?.name).filter(Boolean)
    : Array.isArray(org.technology_names)
      ? org.technology_names
      : [];
  const exchange = org.publicly_traded_exchange;
  const symbol = org.publicly_traded_symbol;
  return {
    orgId: org.organization_id ?? org.id,
    name: org.name,
    domain: org.primary_domain ?? fallbackDomain,
    websiteUrl: org.website_url ?? null,
    logoUrl: org.logo_url ?? null,
    description: org.short_description ?? org.seo_description ?? null,
    industry: org.industry ?? null,
    foundedYear: org.founded_year ?? null,
    employees: org.estimated_num_employees ?? null,
    location: [org.city, org.state, org.country].filter(Boolean).join(", ") || null,
    keywords: (org.keywords ?? []).slice(0, 14),
    technologies: [...new Set(techs)].slice(0, 16),
    linkedinUrl: org.linkedin_url ?? null,
    annualRevenue: org.annual_revenue_printed ?? null,
    totalFunding: org.total_funding_printed ?? null,
    latestFundingStage: org.latest_funding_stage ?? null,
    latestFundingDate: org.latest_funding_round_date ?? null,
    publiclyTraded: exchange && symbol ? `${exchange}: ${symbol}` : null,
  };
}

// Resolve a company (by domain, name, or orgId+domain) and return its full
// dossier. Prefers a domain enrich (rich); falls back to a name search (thinner).
export async function enrichCompanyDossier(opts: {
  orgId?: string;
  domain?: string;
  name?: string;
}): Promise<CompanyDossier> {
  let domain = opts.domain?.trim();
  if (!domain && opts.name) {
    const found = await searchCompanies(opts.name, 1);
    if (found[0]?.domain) domain = found[0].domain;
    else if (found[0]) {
      // No domain to enrich against — return the thin company as a dossier.
      const c = found[0];
      return {
        orgId: c.orgId,
        name: c.name,
        domain: c.domain,
        description: c.description,
        employees: c.employees ?? null,
        keywords: c.keywords,
        technologies: [],
        logoUrl: c.logoUrl ?? null,
      };
    }
  }
  if (!domain) throw new Error("Could not resolve a company to enrich.");
  const data = await get(`/organizations/enrich?domain=${encodeURIComponent(domain)}`);
  if (!data.organization) throw new Error(`No Apollo organization for "${domain}".`);
  return dossierFromOrg(data.organization, domain);
}

export interface JobPosting {
  id: string;
  title: string;
  url: string | null;
  location: string | null;
  postedAt: string | null;
}

// A company's currently-open roles (organizations/{id}/job_postings). FREE.
// Needs an Apollo org id — resolve the company first if you only have a name.
export async function companyJobPostings(orgId: string, limit = 40): Promise<JobPosting[]> {
  const data = await get(`/organizations/${encodeURIComponent(orgId)}/job_postings`);
  const raw: any[] = data.organization_job_postings ?? [];
  return raw.slice(0, limit).map((j) => ({
    id: String(j.id ?? j.url ?? j.title),
    title: j.title ?? "Untitled role",
    url: j.url ?? null,
    location: [j.city, j.state, j.country].filter(Boolean).join(", ") || null,
    postedAt: j.posted_at ?? j.last_seen_at ?? null,
  }));
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
