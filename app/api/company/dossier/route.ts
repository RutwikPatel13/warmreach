import { NextResponse } from "next/server";
import { enrichCompanyDossier, companyJobPostings } from "@/src/apollo";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The company dossier (modal + /jobs page): full enrichment + open roles.
// Both endpoints are FREE — no Apollo credits spent.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const { orgId, domain, name } = (await req.json()) as {
      orgId?: string;
      domain?: string;
      name?: string;
    };
    if (!orgId && !domain && !name) {
      return NextResponse.json({ error: "A company (orgId, domain, or name) is required." }, { status: 400 });
    }

    const dossier = await enrichCompanyDossier({ orgId, domain, name });

    // Open roles need the resolved org id. Failing to fetch them shouldn't sink
    // the whole dossier — fall open with an empty list.
    let jobs: Awaited<ReturnType<typeof companyJobPostings>> = [];
    if (dossier.orgId) {
      try {
        jobs = await companyJobPostings(dossier.orgId);
      } catch (err) {
        console.error("job postings fetch failed (continuing):", err);
      }
    }

    return NextResponse.json({ dossier, jobs });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not load the company." }, { status: 500 });
  }
}
