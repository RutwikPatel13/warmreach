import { NextResponse } from "next/server";
import { rejectNonLocal } from "@/src/localGuard";
import { getGmailAuth, getFromAddress, hasGmailToken } from "@/src/gmail";
import { outreachRows } from "@/src/tracker";
import {
  scanFollowups,
  activeCompanyGroups,
  findBouncedAddresses,
  saveScanBatch,
  readScanResult,
  readDismissed,
  type CompanyState,
} from "@/src/followups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  offset?: number;
  limit?: number;
  bouncedAddresses?: string[]; // passed back by the client after the first batch computed it
}

// The last persisted scan — so opening /followups shows results instantly
// without re-scanning. Free (reads a local file, no Gmail/Claude).
export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  const cached = readScanResult();
  if (!cached) {
    return NextResponse.json({ companies: [], counts: countsFor([]), scannedAt: null, complete: false, cached: false });
  }
  const dismissed = new Set(readDismissed());
  const active = cached.companies.filter((c) => !dismissed.has(c.companyKey));
  return NextResponse.json({
    companies: active,
    counts: { ...countsFor(active), companiesApplied: cached.total },
    scannedAt: cached.scannedAt,
    total: cached.total,
    complete: cached.complete,
    cached: true,
  });
}

// Scans Gmail (retroactively) for replies to logged applications, grouped by
// company. This is the heaviest route in the feature — one Gmail search + thread
// fetch per person, plus one Claude call per genuine reply — so it runs in
// BATCHES: the client calls it repeatedly with a rolling `offset` (companies are
// oldest-application-first, a stable order) so no single request hangs or times
// out. Bounces are looked up once (a separate mailbox search) and handed back to
// the client to thread through subsequent batches.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  if (!hasGmailToken()) {
    return NextResponse.json(
      { error: "Gmail isn't authorized yet. Run `npm run gmail:auth` once in the terminal, then retry." },
      { status: 400 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const rows = outreachRows().filter((r) => r.role !== "campaign");
  const total = activeCompanyGroups(rows).length;
  if (total === 0) {
    return NextResponse.json({ companies: [], counts: countsFor([]), total: 0, offset: 0, nextOffset: 0, done: true });
  }

  let auth: any;
  let from: string;
  try {
    auth = await getGmailAuth();
    from = await getFromAddress(auth);
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    if (msg.includes("invalid_grant")) {
      return NextResponse.json(
        {
          error:
            "Gmail authorization expired. Re-run `npm run gmail:auth` in the terminal to refresh the token, then retry.",
        },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: `Gmail auth failed: ${msg || "unknown error"}` }, { status: 400 });
  }

  const offset = Math.max(0, Math.floor(body.offset ?? 0));
  const limit = Math.max(1, Math.min(25, Math.floor(body.limit ?? 8)));

  try {
    // Compute the bounced set once (first batch) — a few mailbox calls, not
    // per-person — then let the client hand it back for the remaining batches.
    let bouncedList = body.bouncedAddresses;
    if (offset === 0 && !bouncedList) {
      try {
        bouncedList = await findBouncedAddresses(auth);
      } catch {
        bouncedList = [];
      }
    }
    const bouncedSet = new Set((bouncedList ?? []).map((e) => e.toLowerCase()));

    const companies = await scanFollowups(auth, from, rows, { offset, limit, bouncedAddresses: bouncedSet });
    const nextOffset = offset + companies.length;
    const done = nextOffset >= total || companies.length === 0;

    // Persist this batch so the results survive a reload / server restart.
    saveScanBatch(companies, { reset: offset === 0, complete: done, total });

    return NextResponse.json({
      companies,
      counts: countsFor(companies),
      total,
      offset,
      nextOffset,
      done,
      ...(offset === 0 ? { bouncedAddresses: [...bouncedSet] } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Scan failed." }, { status: 500 });
  }
}

function countsFor(companies: CompanyState[]) {
  let someoneReplied = 0;
  let companiesToNudge = 0;
  let peopleToNudge = 0;
  let bounced = 0;
  for (const c of companies) {
    if (c.someoneReplied) someoneReplied++;
    if (c.dueCount > 0) companiesToNudge++;
    peopleToNudge += c.dueCount;
    bounced += c.people.filter((p) => p.status === "bounced").length;
  }
  return { companiesApplied: companies.length, someoneReplied, companiesToNudge, peopleToNudge, bounced };
}
