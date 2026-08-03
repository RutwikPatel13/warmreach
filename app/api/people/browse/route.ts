import { NextResponse } from "next/server";
import { resolveCompanyOptions, searchContacts, titlesForGroups, type Company } from "@/src/apollo";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// People browse for the /people page. Names, titles, seniority, LinkedIn, and a
// has_email flag — all FREE. No email is revealed here (that's /people/reveal,
// which costs 1 credit). Pass groups to target titles, or all=true for everyone.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const { orgId, domain, name, groups, customTitles, all, locations } = (await req.json()) as {
      orgId?: string;
      domain?: string;
      name?: string;
      groups?: string[];
      customTitles?: string[];
      all?: boolean;
      locations?: string[];
    };

    // Build a Company for the search. Trust an explicit orgId/domain (from a card
    // the user already clicked); otherwise resolve the typed name/domain.
    let company: Company;
    if (orgId || domain) {
      company = { orgId, domain, name: name ?? domain ?? "the company", description: null, keywords: [] };
    } else if (name?.trim()) {
      const options = await resolveCompanyOptions(name.trim());
      if (!options.length) return NextResponse.json({ error: `No company found for "${name}".` }, { status: 404 });
      company = options[0];
    } else {
      return NextResponse.json({ error: "A company is required." }, { status: 400 });
    }

    const locs = Array.isArray(locations) ? locations.filter(Boolean) : ["United States"];
    const titles = titlesForGroups(groups ?? [], customTitles ?? []);
    const found = await searchContacts(company, titles, 200, locs, all === true);

    const people = found.map((p) => ({
      id: p.id,
      firstName: p.first_name,
      lastName: p.last_name ?? null,
      title: p.title,
      seniority: p.seniority ?? null,
      linkedin: p.linkedin ?? null,
      photo: p.photo ?? null,
      location: p.location ?? null,
      hasEmail: p.has_email,
    }));

    return NextResponse.json({
      company: {
        orgId: company.orgId ?? null,
        name: company.name,
        domain: company.domain ?? null,
        logoUrl: company.logoUrl ?? null,
      },
      people,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "People search failed." }, { status: 500 });
  }
}
