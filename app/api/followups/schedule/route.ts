import { NextResponse } from "next/server";
import { friendlyLlmError } from "@/src/apiErrors";
import { rejectNonLocal } from "@/src/localGuard";
import { getGmailAuth, getFromAddress, hasGmailToken, createDraft, sendDraft, deleteDraft } from "@/src/gmail";
import { addScheduledMany, listScheduled, startScheduler, cancelByDraftIds, type ScheduleItem } from "@/src/scheduler";
import {
  appendFollowupLog,
  removeFollowupLogByDraftIds,
  findThreadForPerson,
  type FollowupLogEntry,
  type FollowupTone,
} from "@/src/followups";
import { normCompany } from "@/src/tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ScheduleFollowupItem {
  email: string;
  name?: string;
  company: string;
  subject: string;
  body: string;
  tone: FollowupTone;
  nudgeNumber: 1 | 2 | 3;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  lastTouchAt?: string; // person's last outreach timestamp — anchors the thread search if threadId is missing
}

interface Body {
  items?: ScheduleFollowupItem[];
  sendNow?: boolean; // true = create the drafts and SEND them immediately (no queue)
  perDay?: number;
  startAt?: string; // ISO instant for the first send (scheduled mode)
  windowStartHour?: number;
  windowEndHour?: number;
}

const HOUR = 3_600_000;
// Gentler than the Campaigns drip default (40/day) — this is a nudge to
// people already contacted, not a fresh launch, so keep the daily volume low.
const DEFAULT_PER_DAY = 15;

// Reuses the SAME send path as everything else: createDraft() makes a real
// Gmail draft (threaded onto the original conversation when we found it),
// then addScheduledMany() queues it — the existing scheduler sweep in
// src/scheduler.ts is what actually calls sendDraft() when it comes due.
// Nothing is sent synchronously here.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as Body;
  const items = (body.items ?? []).filter((i) => i?.email && i?.company && i?.subject && i?.body);
  const sendNow = body.sendNow === true;
  if (items.length === 0) {
    return NextResponse.json({ error: "No follow-ups to send." }, { status: 400 });
  }
  if (!hasGmailToken()) {
    return NextResponse.json(
      { error: "Gmail isn't authorized yet. Run `npm run gmail:auth` once, then retry." },
      { status: 400 },
    );
  }

  let auth: any;
  let from: string;
  try {
    auth = await getGmailAuth();
    from = await getFromAddress(auth);
  } catch (e: any) {
    const msg = String(friendlyLlmError(e) || "");
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

  const perDay = Math.max(1, Math.min(50, Math.floor(body.perDay ?? DEFAULT_PER_DAY)));
  const wStart = clampHour(body.windowStartHour, 8);
  const wEnd = Math.max(wStart + 1, clampHour(body.windowEndHour, 17));
  const start = body.startAt ? new Date(body.startAt) : new Date(Date.now() + HOUR);
  if (Number.isNaN(start.getTime())) {
    return NextResponse.json({ error: "startAt must be a valid date/time." }, { status: 400 });
  }

  const windowLen = (wEnd - wStart) * HOUR;
  const floor = Date.now() + 60_000; // never schedule in the past
  const now = new Date().toISOString();

  const created: FollowupLogEntry[] = [];
  const scheduleEntries: { item: ScheduleItem; sendAt: string }[] = [];
  const errors: { email: string; error: string }[] = [];

  for (const it of items) {
    try {
      // Each recipient has their OWN conversation — resolve it independently
      // when the caller didn't already supply one (e.g. every recipient
      // besides the composer's anchor person).
      let threadId = it.threadId ?? null;
      let inReplyTo = it.inReplyTo ?? null;
      let references = it.references ?? null;
      if (!threadId) {
        try {
          const match = await findThreadForPerson(auth, it.email, it.lastTouchAt ?? now);
          if (match) {
            threadId = match.threadId;
            inReplyTo = match.lastMessageId;
            references = match.references;
          }
        } catch {
          /* no thread found — draft still goes out, just not threaded */
        }
      }

      const draftId = await createDraft(
        auth,
        {
          to: it.email,
          subject: it.subject,
          body: it.body,
          threadId: threadId ?? undefined,
          inReplyTo: inReplyTo ?? undefined,
          references: references ?? undefined,
        },
        from,
      );

      if (sendNow) {
        await sendDraft(auth, draftId); // send immediately (throws -> recorded as an error below)
      } else {
        const slotIndex = scheduleEntries.length; // drip position among successfully-queued items
        const day = Math.floor(slotIndex / perDay);
        const slot = slotIndex % perDay;
        const dayStart = new Date(start);
        dayStart.setDate(dayStart.getDate() + day);
        dayStart.setHours(wStart, 0, 0, 0);
        const off = perDay > 1 ? Math.round((slot * windowLen) / perDay) : 0;
        let at = dayStart.getTime() + off;
        if (day === 0) at = Math.max(at, start.getTime());
        at = Math.max(at, floor);
        scheduleEntries.push({ item: { draftId, to: it.email, name: it.name, subject: it.subject }, sendAt: new Date(at).toISOString() });
      }

      created.push({
        id: `fu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        email: it.email,
        company: it.company,
        companyKey: normCompany(it.company),
        nudgeNumber: it.nudgeNumber,
        tone: it.tone,
        draftId,
        threadId,
        subject: it.subject,
        sentAt: now,
      });
    } catch (e: any) {
      errors.push({ email: it.email, error: friendlyLlmError(e) || "Failed to draft follow-up." });
    }
  }

  if (created.length > 0) {
    appendFollowupLog(created);
    if (!sendNow) {
      startScheduler();
      addScheduledMany(scheduleEntries);
    }
  }

  return NextResponse.json({ created, errors, scheduled: listScheduled(), sent: sendNow ? created.length : 0 });
}

function clampHour(h: number | undefined, dflt: number): number {
  if (typeof h !== "number" || Number.isNaN(h)) return dflt;
  return Math.max(0, Math.min(23, Math.floor(h)));
}

// Cancel scheduled follow-ups by their draft ids: drop them from the send queue,
// delete the Gmail drafts, and remove their follow-up-log entries so those
// people can be nudged again later. (Already-sent follow-ups can't be undone.)
export async function DELETE(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const { draftIds } = (await req.json().catch(() => ({}))) as { draftIds?: string[] };
  if (!Array.isArray(draftIds) || draftIds.length === 0) {
    return NextResponse.json({ error: "draftIds is required." }, { status: 400 });
  }

  const canceled = cancelByDraftIds(draftIds); // remove from the scheduler queue
  removeFollowupLogByDraftIds(draftIds); // let the cadence nudge them again later

  let deleted = 0;
  if (hasGmailToken()) {
    try {
      const auth = await getGmailAuth();
      for (const id of draftIds) {
        try {
          await deleteDraft(auth, id);
          deleted++;
        } catch {
          /* draft already sent/deleted — nothing to remove */
        }
      }
    } catch {
      /* auth issue — the queue is already cleared, which is the important part */
    }
  }

  return NextResponse.json({ canceled, deleted });
}
