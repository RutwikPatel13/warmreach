import { NextResponse } from "next/server";
import { listDocs, createDoc, readBaseTex, ensureDirs } from "@/src/resumeStore";
import { enginePath, pdftotextPath } from "@/src/latexEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The résumé list, plus whether the machine can actually build a PDF — the page
// needs to say "install tectonic" rather than silently showing an empty preview.
export async function GET() {
  ensureDirs();
  return NextResponse.json({
    docs: listDocs(),
    engine: { latex: !!enginePath(), pdftotext: !!pdftotextPath() },
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      company?: string;
      role?: string;
      jd?: string;
      jobUrl?: string;
      notes?: string;
      fromTex?: string;
    };
    const meta = createDoc({
      company: (body.company ?? "").trim(),
      role: (body.role ?? "").trim(),
      jd: body.jd ?? "",
      jobUrl: body.jobUrl ?? "",
      notes: body.notes ?? "",
      tex: body.fromTex || readBaseTex(),
    });
    return NextResponse.json({ doc: meta });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
