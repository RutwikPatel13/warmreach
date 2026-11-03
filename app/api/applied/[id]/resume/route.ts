import fs from "node:fs";
import path from "node:path";
import { getApplication, resumeFileOf } from "@/src/applied";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// The résumé Tsenta submitted for this application, as saved by a sync.
export async function GET(req: Request, { params }: Ctx) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  const { id } = await params;
  const a = getApplication(id);
  const file = a ? resumeFileOf(a) : null;
  if (!file) return new Response("Tsenta’s résumé for this application isn’t saved yet.", { status: 404 });
  return new Response(new Uint8Array(fs.readFileSync(file)), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${path.basename(file).replace(/"/g, "")}"`,
    },
  });
}
