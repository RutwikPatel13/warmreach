import { NextResponse } from "next/server";
import { getApplication, updateApplication } from "@/src/applied";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// Unstick an application: paste the posting it couldn't read, or give the
// company's website when it couldn't tell which company it is. Free; the list
// then runs Prepare again.
export async function PATCH(req: Request, { params }: Ctx) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  const { id } = await params;
  if (!getApplication(id)) return NextResponse.json({ error: "No application with that id." }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { jd?: string; companyWebsite?: string };
  const app = updateApplication(id, (a) => {
    if (typeof body.jd === "string" && body.jd.trim()) {
      a.jd = body.jd.trim();
      a.jdSource = "pasted";
    }
    if (typeof body.companyWebsite === "string" && body.companyWebsite.trim()) {
      a.companyWebsite = body.companyWebsite.trim();
    }
    if (a.status === "stuck") { a.status = "new"; a.error = null; }
  });
  return NextResponse.json({ status: app.status });
}
