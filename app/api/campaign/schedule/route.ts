import { NextResponse } from "next/server";
import { rejectNonLocal } from "@/src/localGuard";
import { hasGmailToken } from "@/src/gmail";
import { addScheduledMany, listScheduled, startScheduler, type ScheduleItem } from "@/src/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  items?: ScheduleItem[]; // ordered — send order of the drip
  perDay?: number;
  startAt?: string; // ISO instant for the first send
  windowStartHour?: number; // local send window (default 8am–5pm)
  windowEndHour?: number;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

// Campaign drip scheduling: spread N sends per day across a daily window, over
// as many days as it takes. Each draft gets its OWN sendAt (addScheduledMany),
// staggered so a cold batch trickles out instead of blasting — protecting the
// Gmail account. Sends are fired by the local scheduler sweep (needs the server
// running). For a single fixed time, use /api/schedule instead.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as Body;
  const items = (body.items ?? []).filter((i) => i?.draftId);
  const perDay = Math.max(1, Math.min(500, Math.floor(body.perDay ?? 40)));
  const wStart = clampHour(body.windowStartHour, 8);
  const wEnd = Math.max(wStart + 1, clampHour(body.windowEndHour, 17));
  const start = body.startAt ? new Date(body.startAt) : new Date(Date.now() + HOUR);

  if (items.length === 0) {
    return NextResponse.json({ error: "No drafts to schedule." }, { status: 400 });
  }
  if (Number.isNaN(start.getTime())) {
    return NextResponse.json({ error: "startAt must be a valid date/time." }, { status: 400 });
  }
  if (!hasGmailToken()) {
    return NextResponse.json(
      { error: "Gmail isn't authorized yet. Run `npm run gmail:auth` once, then retry." },
      { status: 400 },
    );
  }

  const windowLen = (wEnd - wStart) * HOUR;
  const floor = Date.now() + 60_000; // never schedule in the past
  const entries = items.map((item, i) => {
    const day = Math.floor(i / perDay);
    const slot = i % perDay;
    const dayStart = new Date(start);
    dayStart.setDate(dayStart.getDate() + day);
    dayStart.setHours(wStart, 0, 0, 0);
    const offset = perDay > 1 ? Math.round((slot * windowLen) / perDay) : 0;
    let at = dayStart.getTime() + offset;
    if (day === 0) at = Math.max(at, start.getTime()); // honor the chosen first-send time
    at = Math.max(at, floor);
    return { item, sendAt: new Date(at).toISOString() };
  });

  startScheduler();
  const created = addScheduledMany(entries);
  const last = created[created.length - 1]?.sendAt;
  return NextResponse.json({ created, scheduled: listScheduled(), finishesAt: last });
}

function clampHour(h: number | undefined, dflt: number): number {
  if (typeof h !== "number" || Number.isNaN(h)) return dflt;
  return Math.max(0, Math.min(23, Math.floor(h)));
}
