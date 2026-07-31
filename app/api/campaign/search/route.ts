import { resolveCompanyOptions, searchContacts, titlesForGroups } from "@/src/apollo";
import { classifyVariant } from "@/src/personalize";
import { contactsForCompany } from "@/src/contacts";
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

          // Already have this company on file? Use those verified emails — no
          // Apollo people-search AND no enrichment credits. Filter to the picked
          // titles so results match the user's targeting.
          const cached = contactsForCompany(company.name, company.domain);
          if (cached.length) {
            const matched = cached.filter((p) => titleMatches(p.title, titles));
            matched.sort((a, b) => rankOf(a.title) - rankOf(b.title));
            const people = matched.slice(0, MAX_RETURN).map((p) => ({
              id: `csv:${p.email}`,
              firstName: p.firstName,
              lastName: p.lastName || null,
              title: p.title,
              variant: classifyVariant(p.title),
              strong: isStrong(p.title),
              source: "csv" as const,
              email: p.email,
            }));
            resolved++;
            totalReachable += people.length;
            send({ type: "company", input: c.name, company: companyPayload, source: "csv", found: matched.length, reachable: people.length, people });
            return;
          }

          // Otherwise Apollo (free people-search; emails enriched later at draft).
          const found = await searchContacts(company, titles, SEARCH_CAP, locations);
          const reachable = found.filter((p) => p.has_email);
          reachable.sort((a, b) => rankOf(a.title) - rankOf(b.title));
          const people = reachable.slice(0, MAX_RETURN).map((p) => ({
            id: p.id,
            firstName: p.first_name,
            lastName: null,
            title: p.title,
            variant: classifyVariant(p.title),
            strong: isStrong(p.title),
            source: "apollo" as const,
            email: null as string | null,
          }));
          resolved++;
          totalReachable += reachable.length;
          send({ type: "company", input: c.name, company: companyPayload, source: "apollo", found: found.length, reachable: reachable.length, people });
        } catch (e: any) {
          unresolved++;
          send({ type: "unresolved", input: c.name, reason: e?.message ?? "Not found in Apollo." });
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
