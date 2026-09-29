import { friendlyLlmError } from "@/src/apiErrors";
import { resolveCompanyOptions, searchContacts, titlesForGroups } from "@/src/apollo";
import { classifyVariant } from "@/src/personalize";
import { contactsForCompany } from "@/src/contacts";
import { careersInboxes } from "@/src/careers";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_COMPANIES = 400; // safety bound for one campaign run
const POOL = 5; // concurrent companies (Apollo people-search is free but rate-limited)
const MAX_RETURN = 300; // reachable people returned per company (safety cap; user selects)
const SEARCH_CAP = 300; // Apollo people-search candidates pulled per company (paginated, free)

interface InCompany {
  name: string;
  domain?: string | null;
}

interface Body {
  companies?: InCompany[];
  groups?: string[];
  customTitles?: string[];
  locations?: string[];
  all?: boolean; // "Everyone at the company" — ignore title targeting, return all people
  careers?: boolean; // append careers@/jobs@/recruiting@ inbox rows (MX-gated, opt-in)
}

// "Strong match" without a JD: rank by how high-value the contact is for a cold
// "I'd love to help you build" intro. Founders/C-level and engineering leaders
// are the strongest targets at a startup; they sort first and are flagged so the
// UI can pre-select and star them.
const FOUNDER_RE = /\b(founder|co-?founder|ceo|chief executive|president|\bcoo\b|chief operating)\b/i;
const ENGLEAD_RE = /\b(cto|chief technology|vp\s*(of\s*)?eng|head of eng|director of eng|engineering manager|head of ai|head of machine learning|principal engineer|staff engineer|tech lead)\b/i;
const RECRUIT_RE = /\b(recruit|talent|people ops|people operations)\b/i;
function rankOf(title: string): number {
  const t = title ?? "";
  if (FOUNDER_RE.test(t)) return 0;
  if (ENGLEAD_RE.test(t)) return 1;
  if (RECRUIT_RE.test(t)) return 2;
  return 3;
}
const isStrong = (title: string) => rankOf(title) <= 1;
// A local-contacts person matches the picked targeting if their title contains
// any of the selected title keywords (mirrors Apollo's person_titles filter).
const titleMatches = (title: string, keywords: string[]) => {
  const t = (title ?? "").toLowerCase();
  return keywords.some((k) => t.includes(k));
};
// Identity key for de-duping an Apollo people-search hit against a contact we
// already have on file. Search hides the email and obfuscates the last name, so
// within an already-resolved company, first name + normalized title is the
// strongest safe signal. This is only ever used to AVOID re-surfacing (and paying
// to enrich) someone we already hold — the two never share an email, so a wrong
// match can at worst hide a paid duplicate, never misdirect a draft.
const idKey = (first: string, title: string) =>
  `${(first ?? "").trim().toLowerCase()}|${(title ?? "").trim().toLowerCase().replace(/\s+/g, " ")}`;

// Batch discovery for a campaign: resolve each company in Apollo, then people-
// search it by the picked target titles. Streams one NDJSON line per company as
// it finishes (so the UI fills in live), then a final "done" line with totals.
// People-search is FREE — no Apollo credits are spent here (enrichment happens at
// draft time). Contacts still lack emails until enriched; the per-person email +
// already-contacted dedupe are applied in /api/campaign/draft.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as Body;
  const companies = (body.companies ?? []).filter((c) => c?.name?.trim()).slice(0, MAX_COMPANIES);
  const titles = titlesForGroups(body.groups ?? [], body.customTitles ?? []);
  const locations = Array.isArray(body.locations) ? body.locations.filter(Boolean) : ["United States"];
  const allPeople = body.all === true; // "Everyone at the company"
  const wantCareers = body.careers === true; // append careers inbox rows

  if (companies.length === 0) {
    return Response.json({ error: "Pick at least one company (choose a list)." }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      let resolved = 0;
      let unresolved = 0;
      let totalReachable = 0;
      let idx = 0;

      async function handle(c: InCompany) {
        const query = (c.domain || c.name).trim();
        try {
          const options = await resolveCompanyOptions(query);
          const company = options[0];
          const companyPayload = {
            name: company.name,
            domain: company.domain ?? null,
            orgId: company.orgId ?? null,
            description: company.description,
            keywords: company.keywords,
            logoUrl: company.logoUrl ?? null,
          };

          // 1) People we already have on file for this company that match the picked
          // titles. Verified emails → ZERO Apollo credits (no search, no enrichment).
          // Always included, whether or not Apollo also turns them up below.
          const cached = contactsForCompany(company.name, company.domain);
          // "Everyone" mode ignores title targeting — take every on-file person.
          const csvMatched = allPeople ? [...cached] : cached.filter((p) => titleMatches(p.title, titles));
          csvMatched.sort((a, b) => rankOf(a.title) - rankOf(b.title));
          const csvPeople = csvMatched.slice(0, MAX_RETURN).map((p) => ({
            id: `csv:${p.email}`,
            firstName: p.firstName,
            lastName: p.lastName || null,
            title: p.title,
            variant: classifyVariant(p.title),
            strong: isStrong(p.title),
            source: "csv" as const,
            email: p.email as string | null,
          }));
          // Identities we already hold, so the same person coming back from Apollo
          // isn't ALSO surfaced as a paid lead (see idKey — email is never crossed).
          const csvKeys = new Set(csvMatched.map((p) => idKey(p.firstName, p.title)));

          // 2) Apollo people-search (FREE — no credits). Runs for EVERY company, even
          // ones we already have on file, so we still discover people we don't hold.
          // Emails are enriched later at draft (1 credit each) only for those picked.
          const found = await searchContacts(company, titles, SEARCH_CAP, locations, allPeople);
          let dedupHits = 0;
          const apolloReachable = found.filter((p) => {
            if (!p.has_email) return false;
            if (csvKeys.has(idKey(p.first_name, p.title))) { dedupHits++; return false; }
            return true;
          });
          apolloReachable.sort((a, b) => rankOf(a.title) - rankOf(b.title));
          const apolloRoom = Math.max(0, MAX_RETURN - csvPeople.length);
          const apolloPeople = apolloReachable.slice(0, apolloRoom).map((p) => ({
            id: p.id,
            firstName: p.first_name,
            lastName: null,
            title: p.title,
            variant: classifyVariant(p.title),
            strong: isStrong(p.title),
            source: "apollo" as const,
            email: null as string | null,
          }));

          // 3) Careers inboxes (careers@/jobs@/recruiting@) — generic GUESSES, gated
          // by an MX check on the domain. Opt-in and never "strong" so the UI leaves
          // them unselected; the email is in hand so drafting them costs no credit.
          const careersPeople = wantCareers
            ? (await careersInboxes(company.domain)).map((c) => ({
                id: `careers:${c.email}`,
                firstName: c.email, // shown verbatim so the user sees the address
                lastName: null,
                title: "generic inbox · unverified guess",
                variant: "recruiter" as const,
                strong: false,
                source: "careers" as const,
                email: c.email as string | null,
              }))
            : [];

          // 4) Merge: on-file (free) + newly-found Apollo (paid at draft) + careers
          // (free, opt-in), people sorted by target value with careers pinned last.
          const ranked = [...csvPeople, ...apolloPeople];
          ranked.sort((a, b) => rankOf(a.title) - rankOf(b.title));
          const people = [...ranked, ...careersPeople];
          const foundCount = found.length + csvPeople.length - dedupHits;
          // Company pill stays "on file · free" only when the WHOLE company is free;
          // a mix reads as apollo (per-person source still drives the credit estimate).
          const source = apolloPeople.length === 0 && csvPeople.length > 0 ? "csv" : "apollo";
          resolved++;
          totalReachable += people.length;
          send({ type: "company", input: c.name, company: companyPayload, source, found: foundCount, reachable: people.length, people });
        } catch (e: any) {
          unresolved++;
          send({ type: "unresolved", input: c.name, reason: friendlyLlmError(e) || "Not found in Apollo." });
        }
      }

      // Simple fixed-size worker pool; each worker pulls the next company index.
      async function worker() {
        for (;;) {
          const i = idx++;
          if (i >= companies.length) return;
          await handle(companies[i]);
        }
      }
      await Promise.all(Array.from({ length: Math.min(POOL, companies.length) }, worker));

      send({ type: "done", total: companies.length, resolved, unresolved, totalReachable });
      closed = true;
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
