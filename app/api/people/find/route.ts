import { NextResponse } from "next/server";
import { findPeople, isSearchableName, nameFromLinkedin, resolveCompanyOptions, type Company } from "@/src/apollo";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Find ONE specific person by name (and/or a LinkedIn URL), optionally scoped to
// a company. Same FREE people-search as /people/browse — no credit is spent here;
// revealing an email (/people/reveal) still costs 1. If a company is typed but
// can't be resolved, we fall back to a global name search and return a `note`.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const { name, company: companyInput, linkedinUrl } = (await req.json()) as {
      name?: string;
      company?: string;
      linkedinUrl?: string;
    };

    if (!name?.trim() && !linkedinUrl?.trim()) {
      return NextResponse.json({ error: "Enter a person's name or a LinkedIn URL." }, { status: 400 });
    }

    // Optional company scope. Don't dead-end the search if it can't be resolved —
    // widen to a global name search and tell the user what happened.
    let company: Company | undefined;
    let note: string | undefined;
    if (companyInput?.trim()) {
      try {
        company = (await resolveCompanyOptions(companyInput.trim()))[0];
      } catch {
        note = `Couldn't find a company matching "${companyInput.trim()}" — showing all matches for the name.`;
      }
    }

    const found = await findPeople({ name: name?.trim(), linkedinUrl: linkedinUrl?.trim(), company });

    // Honest nudge: if the search leaned on a LinkedIn URL and either the slug
    // couldn't be split into a real name (e.g. ".../in/deepshah08") or Apollo
    // returned nothing, point the user at the by-name field, which does match.
    if (!name?.trim() && linkedinUrl?.trim()) {
      const derived = nameFromLinkedin(linkedinUrl.trim());
      if (!isSearchableName(derived) || found.length === 0) {
        note =
          `That LinkedIn URL doesn't include a readable name` +
          `${derived ? ` (it reads as "${derived}")` : ""}, so the free search couldn't match it.`;
      }
    }

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
      company: company
        ? {
            orgId: company.orgId ?? null,
            name: company.name,
            domain: company.domain ?? null,
            logoUrl: company.logoUrl ?? null,
          }
        : null,
      people,
      note,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "People search failed." }, { status: 500 });
  }
}
