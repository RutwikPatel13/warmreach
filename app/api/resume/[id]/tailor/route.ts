import { NextResponse } from "next/server";
import { readDoc, readMaster, saveDoc, isBaseId } from "@/src/resumeStore";
import { parseResume } from "@/src/texDoc";
import { measure, measurablesFor } from "@/src/texFit";
import { tailorWithFit } from "@/src/resumeRender";
import type { Bank } from "@/src/resumeTailor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Three model rounds plus four compiles; the default 15s serverless budget is
// not the constraint here (this runs locally), but be explicit about it.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * THE billed route on this page. Everything else — rendering, measuring, the
 * ATS audit, version history — is free and local. Nothing here runs unless the
 * user presses Tailor.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      tex?: string;
      jd?: string;
      company?: string;
      role?: string;
      notes?: string;
    };
    // The UI forks the base one-pager into a role résumé before tailoring; this
    // is the guard for every other caller. Bending the master template toward
    // one job description would quietly cost every future application.
    if (isBaseId(id)) {
      return NextResponse.json(
        { error: "Tailoring would rewrite your master template. Create a résumé for the role first." },
        { status: 400 },
      );
    }

    const { meta, tex: stored, dir } = readDoc(id);
    const tex = typeof body.tex === "string" ? body.tex : stored;

    const jd = (body.jd ?? meta.jd ?? "").trim();
    if (!jd && !(body.role ?? meta.role)) {
      return NextResponse.json(
        { error: "Paste the job description (or at least a role title) before tailoring." },
        { status: 400 },
      );
    }

    const parsed = parseResume(tex);
    if (!parsed.experience.length) {
      return NextResponse.json(
        { error: "No experience bullets found in this .tex — check the \\begin{rSection}{Experience} block." },
        { status: 400 },
      );
    }

    // Measure the document as it stands: this is where every slot's line count
    // and character budget comes from, and it is what keeps the page fixed.
    const { fits } = await measure(dir, tex, measurablesFor(parsed));

    const run = await tailorWithFit({
      dir,
      tex,
      parsed,
      fits,
      bank: readMaster() as Bank,
      jd,
      company: (body.company ?? meta.company ?? "").trim(),
      role: (body.role ?? meta.role ?? "").trim(),
      notes: (body.notes ?? meta.notes ?? "").trim(),
    });

    // Remember the inputs so a refit later doesn't need them retyped.
    saveDoc(id, tex, {
      jd,
      company: (body.company ?? meta.company ?? "").trim(),
      role: (body.role ?? meta.role ?? "").trim(),
      notes: (body.notes ?? meta.notes ?? "").trim(),
      lastTailoredAt: new Date().toISOString(),
    });

    return NextResponse.json({
      strategy: run.proposal.strategy,
      bullets: run.proposal.bullets,
      projects: run.proposal.projects,
      skills: run.proposal.skills,
      keywords: run.proposal.keywords,
      fits: run.fits,
      baseline: Object.fromEntries(fits),
      rounds: run.rounds,
      stillMissing: run.stillMissing,
      reverted: run.reverted,
      costUsd: run.costUsd,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
