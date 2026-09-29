import { NextResponse } from "next/server";
import { getApplication, markOpened, toWorkspace } from "@/src/applied";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// A prepared application as an Applications workspace: the page saves this as
// a new tab and switches to it. Free — nothing is revealed or drafted here.
export async function GET(req: Request, { params }: Ctx) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  const { id } = await params;
  const a = getApplication(id);
  if (!a) return NextResponse.json({ error: "No application with that id." }, { status: 404 });
  try {
    const workspace = toWorkspace(a);
    markOpened(id);
    return NextResponse.json({ workspace, logoUrl: a.org?.logoUrl ?? null });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Not prepared yet." }, { status: 400 });
  }
}
