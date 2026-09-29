import { readFileSync, existsSync } from "node:fs";
import { pdfPath } from "@/src/resumeStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    const file = pdfPath(id);
    if (!existsSync(file)) return new Response("Not compiled yet", { status: 404 });
    return new Response(new Uint8Array(readFileSync(file)), {
      headers: {
        "Content-Type": "application/pdf",
        // The viewer busts this with a ?v= stamp on every recompile; without
        // no-store some browsers keep showing the previous build.
        "Cache-Control": "no-store, must-revalidate",
        "Content-Disposition": "inline; filename=resume.pdf",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
