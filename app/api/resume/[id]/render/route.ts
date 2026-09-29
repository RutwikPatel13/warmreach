import { NextResponse } from "next/server";
import { readDoc, saveDoc } from "@/src/resumeStore";
import { renderAndAudit } from "@/src/resumeRender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Compile + measure + audit. Costs nothing but CPU — no model call — so the
 * editor calls it on every pause in typing. The PDF itself is served from the
 * sibling /pdf route so it streams as bytes instead of bloating this JSON.
 *
 * Compiling always persists the source. It has to: the engine writes main.tex
 * as part of compiling, so pretending a compile left the file untouched would
 * make the editor's saved/unsaved indicator lie. Autosave here is snapshot-free
 * (see saveDoc) — what you compiled is what's on disk, which is also the model
 * Overleaf uses.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as { tex?: string };
    const { meta, tex: stored, dir } = readDoc(id);
    const tex = typeof body.tex === "string" ? body.tex : stored;

    if (tex !== stored) saveDoc(id, tex, {}, { snapshot: false });

    const report = await renderAndAudit(dir, tex, { jd: meta.jd });
    return NextResponse.json({ ...report, version: Date.now() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
