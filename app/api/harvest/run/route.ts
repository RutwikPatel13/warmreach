import { NextResponse } from "next/server";
import { harvestCompany, readScan, type HarvestResult } from "@/src/harvest";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

// SPENDS CREDITS — 1 per person matched. Everything else in this feature is free;
// this is the one route that costs money, so it will not run without an explicit
// budget, it stops the moment that budget is exhausted, and dryRun rehearses the
// whole thing (including the per-company splits) without calling Apollo at all.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const body = (await req.json()) as {
      domains?: string[];
      budget?: number;
      dryRun?: boolean;
      caps?: Record<string, number>;
    };
    const domains = body.domains ?? [];
    const dryRun = body.dryRun !== false; // default to the safe mode, opt in to spending
    const budget = Math.max(0, Math.floor(body.budget ?? 0));

    if (!domains.length) return NextResponse.json({ error: "domains[] is required." }, { status: 400 });
    if (!dryRun && budget <= 0) {
      return NextResponse.json({ error: "A positive credit budget is required to spend." }, { status: 400 });
    }

    const missing = domains.filter((d) => !readScan(d));
    if (missing.length) {
      return NextResponse.json(
        { error: `Scan these first (free): ${missing.join(", ")}` },
        { status: 400 },
      );
    }

    // Serial across companies, with the remaining budget carried forward — so the
    // ceiling is enforced across the whole run, not per company.
    const results: HarvestResult[] = [];
    let remaining = budget;
    for (const domain of domains) {
      if (!dryRun && remaining <= 0) break;
      const r = await harvestCompany({
        domain,
        cap: body.caps?.[domain],
        budget: dryRun ? (readScan(domain)?.credits ?? 0) : remaining,
        dryRun,
      });
      results.push(r);
      remaining -= r.spent;
    }

    return NextResponse.json({
      dryRun,
      results,
      totals: {
        attempted: results.reduce((s, r) => s + r.attempted, 0),
        revealed: results.reduce((s, r) => s + r.revealed, 0),
        spent: results.reduce((s, r) => s + r.spent, 0),
        alreadyHarvested: results.reduce((s, r) => s + r.alreadyHarvested, 0),
        beyondCap: results.reduce((s, r) => s + r.beyondCap, 0),
        remaining: dryRun ? budget : remaining,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Harvest failed." }, { status: 500 });
  }
}
