import { NextResponse } from "next/server";
import { enqueue, normalizeOptions, planStart } from "@/src/appliedRun";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX = 1000;

// Start outreach for the selected rows. { dryRun: true } only reports what
// would happen. Otherwise the rows that can run are queued: each is taken up to
// written emails: two model calls per company and no Apollo credits.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  const body = (await req.json().catch(() => ({}))) as { ids?: string[]; options?: unknown; dryRun?: boolean };
  const ids = (body.ids ?? []).filter((x) => typeof x === "string" && x).slice(0, MAX);
  if (!ids.length) return NextResponse.json({ error: "Select at least one application." }, { status: 400 });
  const options = normalizeOptions(body.options);
  const plan = planStart(ids, options);
  if (body.dryRun) return NextResponse.json({ plan });
  const queued = enqueue([...plan.run, ...plan.maybeContacted].map((r) => r.id), options);
  return NextResponse.json({ plan, queued });
}
