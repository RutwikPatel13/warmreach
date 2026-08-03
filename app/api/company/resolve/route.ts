import { NextResponse } from "next/server";
import { resolveCompanyOptions } from "@/src/apollo";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Company search for the /companies page. Ranked candidates by name or domain.
// FREE — no Apollo credits (mixed_companies/search + organizations/enrich).
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const { q } = (await req.json()) as { q?: string };
    if (!q || !q.trim()) {
      return NextResponse.json({ error: "Type a company name or domain." }, { status: 400 });
    }
    const options = await resolveCompanyOptions(q.trim());
    return NextResponse.json({
      companies: options.map((c) => ({
        orgId: c.orgId ?? null,
        name: c.name,
        domain: c.domain ?? null,
        description: c.description,
        keywords: c.keywords,
        employees: c.employees ?? null,
        logoUrl: c.logoUrl ?? null,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Company search failed." }, { status: 500 });
  }
}
