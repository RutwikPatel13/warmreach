import { NextResponse } from "next/server";
import { rejectNonLocal } from "@/src/localGuard";
import { hasGmailToken } from "@/src/gmail";
import {
  addScheduled,
  cancelScheduled,
  listScheduled,
  startScheduler,
  type ScheduleItem,
} from "@/src/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The scheduled-send store. The sweep loop that actually sends is started here
// too (and from instrumentation.ts on boot) — startScheduler() is idempotent.

export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  startScheduler();
  return NextResponse.json({ scheduled: listScheduled() });
}

export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as {
    items?: ScheduleItem[];
    sendAt?: string;
  };
  const { items, sendAt } = body;

  if (!Array.isArray(items) || items.length === 0 || items.some((i) => !i?.draftId)) {
    return NextResponse.json({ error: "items (each with a draftId) is required." }, { status: 400 });
  }
  const at = sendAt ? Date.parse(sendAt) : NaN;
  if (Number.isNaN(at)) {
    return NextResponse.json({ error: "sendAt must be a valid date/time." }, { status: 400 });
  }
  if (!hasGmailToken()) {
    return NextResponse.json(
      { error: "Gmail isn't authorized yet. Run `npm run gmail:auth` once, then retry." },
      { status: 400 },
    );
  }

  startScheduler();
  const created = addScheduled(items, new Date(at).toISOString());
  return NextResponse.json({ created, scheduled: listScheduled() });
}

export async function DELETE(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  cancelScheduled(id);
  return NextResponse.json({ scheduled: listScheduled() });
}
