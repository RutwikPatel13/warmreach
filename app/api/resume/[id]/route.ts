import { NextResponse } from "next/server";
import { readDoc, saveDoc, deleteDoc, listVersions } from "@/src/resumeStore";
import { parseResume } from "@/src/texDoc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    const { meta, tex } = readDoc(id);
    return NextResponse.json({ doc: meta, tex, parsed: parseResume(tex), versions: listVersions(id) });
  } catch {
    return NextResponse.json({ error: "No résumé with that id." }, { status: 404 });
  }
}

export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    const body = (await req.json()) as { tex?: string; meta?: Record<string, unknown> };
    if (typeof body.tex !== "string") {
      return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
    }
    const meta = saveDoc(id, body.tex, body.meta ?? {});
    return NextResponse.json({ doc: meta });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  deleteDoc(id);
  return NextResponse.json({ ok: true });
}
