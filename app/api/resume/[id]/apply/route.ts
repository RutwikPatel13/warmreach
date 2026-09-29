import { NextResponse } from "next/server";
import { readDoc, saveDoc } from "@/src/resumeStore";
import { parseResume, applyEdits } from "@/src/texDoc";
import { editsFor, renderAndAudit } from "@/src/resumeRender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Splice the accepted suggestions into the .tex and recompile. Only the slots
 * in `accept` are touched; everything else in the file — spacing, comments,
 * hand edits — comes through byte-identical. The previous .tex is snapshotted
 * by saveDoc, so this is always reversible.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    const body = (await req.json()) as {
      tex?: string;
      accept?: string[];
      bullets?: { id: string; text: string; sourceId: string; rationale: string; changed: boolean; before: string }[];
      projects?: { id: string; blurb: string; rationale: string; before: string }[];
      skills?: { id: string; text: string; rationale: string; before: string }[];
    };
    const { meta, tex: stored, dir } = readDoc(id);
    const tex = typeof body.tex === "string" ? body.tex : stored;

    const parsed = parseResume(tex);
    const edits = editsFor(
      parsed,
      { bullets: body.bullets ?? [], projects: body.projects ?? [], skills: body.skills ?? [] },
      new Set(body.accept ?? []),
    );
    if (!edits.length) {
      return NextResponse.json({ error: "Nothing selected to apply." }, { status: 400 });
    }

    const next = applyEdits(tex, edits);
    saveDoc(id, next);
    const report = await renderAndAudit(dir, next, { jd: meta.jd });
    return NextResponse.json({ tex: next, applied: edits.length, ...report, version: Date.now() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
