import { NextResponse } from "next/server";
import { rejectNonLocal } from "@/src/localGuard";
import { getGmailAuth, getFromAddress, hasGmailToken } from "@/src/gmail";
import { outreachRows } from "@/src/tracker";
import { scanFollowups, type CompanyState } from "@/src/followups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  maxCompanies?: number;
}

// Scans Gmail (retroactively) for replies to every logged application, groups
// by company, and returns per-person status + counts. This is the heaviest
// route in the feature — one Gmail search + thread fetch per person, plus one
// Claude call per genuine reply — so maxCompanies is a safety valve, not a
// user-facing limit.
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
  if (rows.length === 0) {
    return NextResponse.json({ companies: [], counts: countsFor([]) });
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

  try {
    const companies = await scanFollowups(auth, from, rows, { maxCompanies: body.maxCompanies });
    return NextResponse.json({ companies, counts: countsFor(companies) });
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
