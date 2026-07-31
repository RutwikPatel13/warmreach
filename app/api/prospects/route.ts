import { NextResponse } from "next/server";
import { loadProspectLists } from "@/src/prospects";
import { contactsCompanyList } from "@/src/contacts";
import { TITLE_GROUPS } from "@/src/apollo";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The source lists that drive the Campaigns page — the scraped prospect lists
// (data/prospects/*.csv) PLUS a synthetic "My contacts" list of every company we
// already hold contacts for (data/contacts/*.csv); searching those costs no
// Apollo credits. Also returns the target-title groups. Read-only.
export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const prospectLists = loadProspectLists();

  const onFile = contactsCompanyList();
  const contactsList = onFile.length
    ? [{
        id: "my_contacts",
        name: "My contacts · on file",
        count: onFile.length,
        withDomain: onFile.filter((c) => c.domain).length,
        onFile: true, // UI flag: these are free (verified emails already in hand)
        companies: onFile.map((c) => ({
          name: c.name,
          domain: c.domain,
          description: `${c.count} contact${c.count === 1 ? "" : "s"} on file`,
        })),
      }]
    : [];

  const groups = Object.entries(TITLE_GROUPS).map(([id, g]) => ({ id, label: g.label }));
  return NextResponse.json({ lists: [...contactsList, ...prospectLists], groups });
}
