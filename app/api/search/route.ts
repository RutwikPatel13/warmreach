import { NextResponse } from "next/server";
import { resolveCompanyOptions, searchContacts, titlesForGroups } from "@/src/apollo";
import { hunterConfigured, domainSearch } from "@/src/hunter";
import { careersInboxes } from "@/src/careers";
import { rejectNonLocal } from "@/src/localGuard";
import { selectContacts, type Fit } from "@/src/select";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const { company: companyInput, locations, role, jobDescription, groups, customTitles, all, careers } =
      (await req.json()) as {
        company?: string;
        locations?: string[];
        role?: string;
        jobDescription?: string;
        groups?: string[]; // targeting groups (founders / engineering / recruiters)
        customTitles?: string[]; // freeform title keywords
        all?: boolean; // "Everyone at the company" — ignore title targeting
        careers?: boolean; // append careers@/jobs@/recruiting@ inbox rows (MX-gated)
      };

    if (!companyInput || !companyInput.trim()) {
      return NextResponse.json({ error: "Company is required." }, { status: 400 });
    }

    // Country filter (Apollo person_locations). Default to US; empty array = any country.
    const locs = Array.isArray(locations) ? locations.filter(Boolean) : ["United States"];
    // Picked role groups (+ custom titles) → title list; empty falls back to DEFAULT_TITLES.
    const titles = titlesForGroups(groups ?? [], customTitles ?? []);
    const allPeople = all === true;

    // Resolve to ranked candidates; use the best, but return the rest so the UI
    // can let the user switch if the auto-pick is wrong (e.g. "Klaviyo" partner agency).
    const options = await resolveCompanyOptions(companyInput.trim());
    const company = options[0];

    // Apollo first (free): all reachable people (paginated, no artificial cap).
    const found = await searchContacts(company, titles, 500, locs, allPeople);
    let candidates = found
      .filter((p) => p.has_email)
      .map((p) => ({
        id: p.id,
        firstName: p.first_name,
        lastName: null as string | null,
        title: p.title,
        source: "apollo" as "apollo" | "hunter" | "careers",
        email: null as string | null,
        confidence: null as number | null,
        fit: null as Fit | null,
      }));

    // Fallback: if Apollo found nobody reachable, ask Hunter's domain search.
    // Only when NO country filter is set — Hunter's domain search can't filter by
    // country, so falling back under a country constraint would return wrong-country
    // people. These already include emails (no Apollo enrichment needed at draft time).
    let source: "apollo" | "hunter" = "apollo";
    if (candidates.length === 0 && locs.length === 0 && hunterConfigured() && company.domain) {
      const people = await domainSearch(company.domain, 100);
      candidates = people.map((p) => ({
        id: `hunter:${p.email}`,
        firstName: p.firstName,
        lastName: p.lastName,
        title: p.position ?? "",
        source: "hunter" as const,
        email: p.email,
        confidence: p.confidence,
        fit: null as Fit | null,
      }));
      if (candidates.length > 0) source = "hunter";
    }

    // Defensive: guarantee unique ids so the UI never renders duplicate React keys,
    // even if an upstream source (Apollo pagination, Hunter) repeats a person.
    const seenIds = new Set<string>();
    candidates = candidates.filter((c) => (seenIds.has(c.id) ? false : (seenIds.add(c.id), true)));

    // JD-based selection: when a job description was pasted, one Claude call
    // ranks the found people against it (titles only — no Apollo cost), so the
    // likely hiring manager / relevant leads / recruiters surface first.
    // Fail open: ranking is a nicety — never block search on a Claude error.
    let ranked = false;
    const jd = jobDescription?.trim();
    if (jd && candidates.length > 0) {
      try {
        const fits = await selectContacts(
          company.name,
          role?.trim() || "the applied role",
          jd,
          candidates.map((c) => ({ id: c.id, firstName: c.firstName, title: c.title })),
        );
        for (const c of candidates) c.fit = fits[c.id] ?? null;
        ranked = true;
      } catch (err) {
        console.error("JD ranking failed (continuing unranked):", err);
      }
    }

    // Careers inboxes (careers@/jobs@/recruiting@) — generic GUESSES gated by an MX
    // check on the domain. Appended AFTER ranking so they aren't fed to the JD
    // ranker; opt-in and unverified, so the UI leaves them unselected. Email is in
    // hand, so drafting them spends no Apollo credit.
    if (careers) {
      for (const cx of await careersInboxes(company.domain)) {
        candidates.push({
          id: `careers:${cx.email}`,
          firstName: cx.email,
          lastName: null,
          title: "generic inbox · unverified guess",
          source: "careers",
          email: cx.email,
          confidence: null,
          fit: null,
        });
      }
    }

    return NextResponse.json({
      ranked,
      company: {
        name: company.name,
        domain: company.domain ?? null,
        orgId: company.orgId ?? null,
        description: company.description,
        keywords: company.keywords,
        logoUrl: company.logoUrl ?? null,
      },
      companyOptions: options.map((o) => ({
        name: o.name,
        domain: o.domain ?? null,
        orgId: o.orgId ?? null,
        employees: o.employees ?? null,
        logoUrl: o.logoUrl ?? null,
      })),
      source,
      totalFound: found.length,
      candidates,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Search failed." }, { status: 500 });
  }
}
