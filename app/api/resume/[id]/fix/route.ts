import { NextResponse } from "next/server";
import { readDoc, saveDoc } from "@/src/resumeStore";
import { applyLigatureFix } from "@/src/resumeAts";
import { renderAndAudit } from "@/src/resumeRender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** One-click repairs for ATS findings. Snapshotted like any other save. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    const { fix, tex: incoming } = (await req.json()) as { fix?: string; tex?: string };
    const { meta, tex: stored, dir } = readDoc(id);
    const tex = typeof incoming === "string" ? incoming : stored;

    if (fix !== "ligatures") {
      return NextResponse.json({ error: `No repair named "${fix}".` }, { status: 400 });
    }

    const next = applyLigatureFix(tex);
    if (next === tex) {
      return NextResponse.json({ error: "That fix is already in the document." }, { status: 400 });
    }
    saveDoc(id, next);
    const report = await renderAndAudit(dir, next, { jd: meta.jd });
    return NextResponse.json({ tex: next, ...report, version: Date.now() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
