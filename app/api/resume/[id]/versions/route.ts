import { NextResponse } from "next/server";
import { listVersions, readVersion, saveDoc, readDoc } from "@/src/resumeStore";
import { renderAndAudit } from "@/src/resumeRender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return NextResponse.json({ versions: listVersions(id) });
}

/** Restore a snapshot. The current .tex is snapshotted first, so this undoes. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    const { stamp } = (await req.json()) as { stamp?: string };
    if (!stamp) return NextResponse.json({ error: "Which version?" }, { status: 400 });
    const tex = readVersion(id, stamp);
    saveDoc(id, tex);
    const { meta, dir } = readDoc(id);
    const report = await renderAndAudit(dir, tex, { jd: meta.jd });
    return NextResponse.json({ tex, ...report, version: Date.now() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
