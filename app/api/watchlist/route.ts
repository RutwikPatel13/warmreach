import { NextResponse } from "next/server";
import { addWatch, listWatches, removeWatch, type WatchContact } from "@/src/watchlist";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The watched-companies store. Local disk only — no Apollo call, no credits.
// The company itself is resolved client-side through the existing
// /api/company/resolve, and the optional contact through /api/people/find, so
// adding a watch never spends anything.

export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  return NextResponse.json({ watches: listWatches() });
}

export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const body = (await req.json()) as {
      orgId?: string;
      name?: string;
      domain?: string | null;
      logoUrl?: string | null;
      description?: string | null;
      keywords?: string[];
      titles?: string[];
      locations?: string[];
      contact?: WatchContact | null;
    };

    if (!body.orgId || !body.name) {
      return NextResponse.json({ error: "Pick a company first." }, { status: 400 });
    }

    // A contact is optional by design. If one came through it needs a name to be
    // worth storing — everything else about them can stay unknown.
    const contact =
      body.contact && body.contact.name?.trim()
        ? {
            name: body.contact.name.trim(),
            title: body.contact.title ?? null,
            email: body.contact.email ?? null,
            source: body.contact.source ?? "typed",
            howYouKnowThem: body.contact.howYouKnowThem?.trim() || null,
          }
        : null;

    const watch = addWatch({
      orgId: body.orgId,
      name: body.name,
      domain: body.domain ?? null,
      logoUrl: body.logoUrl ?? null,
      description: body.description ?? null,
      keywords: body.keywords ?? [],
      titles: body.titles ?? [],
      locations: body.locations ?? [],
      contact,
    });

    return NextResponse.json({ watch });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not save the watch." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const { id } = (await req.json()) as { id?: string };
    if (!id) return NextResponse.json({ error: "A watch id is required." }, { status: 400 });
    removeWatch(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not remove the watch." }, { status: 500 });
  }
}
