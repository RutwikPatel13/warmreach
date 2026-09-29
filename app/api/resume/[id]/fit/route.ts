import { NextResponse } from "next/server";
import { readDoc } from "@/src/resumeStore";
import { parseResume, sanitizeTex, validateFragment } from "@/src/texDoc";
import { measure, skillChunkTex, type Measurable } from "@/src/texFit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Measure one edited fragment against the real page.
 *
 * This is what makes editing a suggestion honest: type a word into a bullet and
 * you find out immediately whether it still fits its line, because TeX typeset
 * it. One compile, ~400ms, no model call, so it can run on every pause.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    const { slotId, text, tex: incoming } = (await req.json()) as {
      slotId?: string;
      text?: string;
      tex?: string;
    };
    if (!slotId || typeof text !== "string") {
      return NextResponse.json({ error: "Need a slot and some text." }, { status: 400 });
    }

    const { tex: stored, dir } = readDoc(id);
    const tex = typeof incoming === "string" ? incoming : stored;
    const parsed = parseResume(tex);
    const clean = sanitizeTex(text);

    const problem = validateFragment(clean);
    if (problem) return NextResponse.json({ error: `That won't typeset: ${problem}.` }, { status: 400 });

    let item: Measurable | null = null;

    const entry = parsed.experience.find((e) => e.items.some((i) => i.id === slotId));
    if (entry) item = { id: slotId, context: "list", listDecl: entry.listDecl, tex: clean };

    const project = parsed.projects.find((p) => p.id === slotId);
    if (project) item = { id: slotId, context: "plain", tex: project.prefix + clean };

    const skill = parsed.skills.find((s) => s.id === slotId);
    if (skill) {
      // A skill value is measured inside the physical line it shares, so a
      // longer list shows up as the wrap it would actually cause.
      const chunk = parsed.skillChunks.find((c) => c.skillIds.includes(skill.id));
      if (chunk) {
        const rel = { start: skill.start - chunk.start, end: skill.end - chunk.start };
        const next = chunk.tex.slice(0, rel.start) + clean + chunk.tex.slice(rel.end);
        item = { id: slotId, context: "plain", tex: skillChunkTex(next) };
      }
    }

    if (!item) return NextResponse.json({ error: "No such slot in this résumé." }, { status: 404 });

    const { fits } = await measure(dir, tex, [item]);
    const fit = fits.get(slotId);
    if (!fit) return NextResponse.json({ error: "Couldn't measure that." }, { status: 500 });

    return NextResponse.json({ fit, sanitized: clean });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
