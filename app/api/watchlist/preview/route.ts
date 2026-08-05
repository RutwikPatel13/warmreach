import { NextResponse } from "next/server";
import { previewMatches } from "@/src/jobWatch";
import { contactsForCompany } from "@/src/contacts";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Everything the add panel needs to know about a company once you've picked it:
// how many of its open roles your filter would actually catch, and whether you
// already have people on file there. Both are FREE — job postings cost no Apollo
// credits, and contacts come off local CSVs.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const { orgId, name, domain, titles, locations } = (await req.json()) as {
      orgId?: string;
      name?: string;
      domain?: string | null;
      titles?: string[];
      locations?: string[];
    };
    if (!orgId) return NextResponse.json({ error: "A company is required." }, { status: 400 });

    // Contacts are read off disk and can't fail in a way worth surfacing; the
    // postings call can (rate limit, transient 5xx), so let that one throw.
    let contacts: ReturnType<typeof contactsForCompany> = [];
    try {
      contacts = contactsForCompany(name, domain);
    } catch {
      contacts = [];
    }

    // The role count and the contacts are independent answers. A rate-limited or
    // flaky postings call shouldn't hide contacts that are sitting on local disk,
    // so the roles half degrades to an error string instead of failing the request.
    let preview: Awaited<ReturnType<typeof previewMatches>> = { total: 0, matched: 0, examples: [] };
    let rolesError: string | null = null;
    try {
      preview = await previewMatches(orgId, titles ?? [], locations ?? []);
    } catch (e: any) {
      rolesError = e?.message ?? "Could not read this company's open roles.";
    }

    return NextResponse.json({
      ...preview,
      rolesError,
      // A CSV row can be missing both name columns. Such a row can't be shown or
      // addressed, so it's dropped here rather than rendered as a blank option.
      contacts: contacts
        .map((c) => ({
          name: [c.firstName, c.lastName].filter(Boolean).join(" ").trim(),
          title: c.title || null,
          email: c.email || null,
        }))
        .filter((c) => c.name.length > 0)
        .slice(0, 8),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not read the company's roles." }, { status: 500 });
  }
}
