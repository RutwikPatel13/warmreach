import { NextResponse } from "next/server";
import { exportPdf } from "@/src/resumeStore";
import { profile } from "@/src/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Copy the compiled PDF into profile.resumeDir, which is the folder the
 * Applications page's attachment picker scans — so a résumé tailored here is
 * immediately attachable to outreach without a trip through Finder.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as { filename?: string };
    const result = exportPdf(id, profile.resumeDir, body.filename);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
