import { NextResponse } from "next/server";
import { scanCompany } from "@/src/harvest";
import { TARGETS } from "@/src/harvestTargets";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CONCURRENCY = 3; // polite against Apollo; search is free but not unlimited

// FREE. Apollo people-search for each requested company, deduped against the
// contact store. Spends no credits — its entire job is to tell you what harvesting
// WOULD cost before you commit to it.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const { domains } = (await req.json()) as { domains?: string[] };
    if (!Array.isArray(domains) || !domains.length) {
      return NextResponse.json({ error: "domains[] is required." }, { status: 400 });
    }
    const targets = domains
      .map((d) => TARGETS.find((t) => t.domain === d))
      .filter((t): t is NonNullable<typeof t> => Boolean(t));
    if (!targets.length) {
      return NextResponse.json({ error: "No known targets in that list." }, { status: 400 });
    }

    const rows: Awaited<ReturnType<typeof scanCompany>>[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
        while (next < targets.length) {
          const t = targets[next++];
          // scanCompany never throws — a failed company comes back with .error set
          // so one bad domain can't abandon the rest of the sweep.
          rows.push(await scanCompany(t));
        }
      }),
    );
    return NextResponse.json({ rows });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Scan failed." }, { status: 500 });
  }
}
