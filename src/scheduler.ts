import fs from "node:fs";
import path from "node:path";
import { getGmailAuth, hasGmailToken, sendDraft } from "./gmail";

// ── Scheduled send ──────────────────────────────────────────────────────────
// Gmail's API has no "send at time" — its native Schedule Send is UI-only. So we
// keep the message as a real Gmail draft and fire sendDraft() ourselves when the
// time comes. This module is the durable store (data/scheduled.json) plus a sweep
// loop that the running Next server ticks every SWEEP_MS. Because the store is on
// disk, a scheduled send survives a browser refresh and even a server restart
// (anything already due is sent on the next boot, catch-up style).

const STORE = path.resolve("data/scheduled.json");
const SWEEP_MS = 30_000;
// Sent/failed/canceled entries older than this are pruned so the store stays small.
const KEEP_TERMINAL_MS = 7 * 24 * 60 * 60 * 1000;

export type ScheduledStatus = "pending" | "sent" | "failed" | "canceled";

export interface ScheduledSend {
  id: string;
  draftId: string;
  to?: string | null;
  name?: string;
  subject?: string;
  sendAt: string; // ISO instant (absolute — timezone already resolved client-side)
  status: ScheduledStatus;
  createdAt: string;
  sentAt?: string;
  messageId?: string;
  error?: string;
}

export interface ScheduleItem {
  draftId: string;
  to?: string | null;
  name?: string;
  subject?: string;
}

function read(): ScheduledSend[] {
  try {
    const raw = fs.readFileSync(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ScheduledSend[]) : [];
  } catch {
    return []; // missing / unreadable / malformed — treat as empty
  }
}

function write(list: ScheduledSend[]): void {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(list, null, 2));
}

function prune(list: ScheduledSend[]): ScheduledSend[] {
  const cutoff = Date.now() - KEEP_TERMINAL_MS;
  return list.filter((s) => {
    if (s.status === "pending") return true;
    const t = Date.parse(s.sentAt ?? s.createdAt);
    return Number.isNaN(t) || t >= cutoff;
  });
}

// Re-read + merge changes by id, so a concurrent add/cancel that happened during
// an await (sending is async) isn't clobbered by a stale in-memory snapshot.
function applyPatches(patches: Record<string, Partial<ScheduledSend>>): void {
  const list = read().map((s) => (patches[s.id] ? { ...s, ...patches[s.id] } : s));
  write(prune(list));
}

export function listScheduled(): ScheduledSend[] {
  return read()
    .slice()
    .sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt));
}

export function addScheduled(items: ScheduleItem[], sendAt: string): ScheduledSend[] {
  const now = new Date().toISOString();
  const created: ScheduledSend[] = items.map((it) => ({
    id: `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    draftId: it.draftId,
    to: it.to ?? null,
    name: it.name,
    subject: it.subject,
    sendAt,
    status: "pending" as const,
    createdAt: now,
  }));
  // Drop any earlier pending schedule for the same draft — a re-schedule wins.
  const list = read().filter(
    (s) => !(s.status === "pending" && created.some((c) => c.draftId === s.draftId)),
  );
  write(prune([...list, ...created]));
  return created;
}

// Like addScheduled, but each item carries its OWN sendAt — used by the Campaigns
// drip, which staggers hundreds of sends across days. Writes the store once (not
// once per item) and de-dupes pending schedules for the same draft (a re-schedule
// wins), same as addScheduled.
export function addScheduledMany(entries: { item: ScheduleItem; sendAt: string }[]): ScheduledSend[] {
  const now = new Date().toISOString();
  const created: ScheduledSend[] = entries.map(({ item, sendAt }) => ({
    id: `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    draftId: item.draftId,
    to: item.to ?? null,
    name: item.name,
    subject: item.subject,
    sendAt,
    status: "pending" as const,
    createdAt: now,
  }));
  const newDraftIds = new Set(created.map((c) => c.draftId));
  const list = read().filter((s) => !(s.status === "pending" && newDraftIds.has(s.draftId)));
  write(prune([...list, ...created]));
  return created;
}

export function cancelScheduled(id: string): boolean {
  let found = false;
  const list = read().map((s) => {
    if (s.id === id && s.status === "pending") {
      found = true;
      return { ...s, status: "canceled" as const };
    }
    return s;
  });
  if (found) write(prune(list));
  return found;
}

// Cancel any pending schedule(s) for these drafts — used when the user sends them
// manually so the sweep doesn't try to send an already-gone draft afterward.
export function cancelByDraftIds(draftIds: string[]): number {
  const set = new Set(draftIds);
  let n = 0;
  const list = read().map((s) => {
    if (set.has(s.draftId) && s.status === "pending") {
      n++;
      return { ...s, status: "canceled" as const };
    }
    return s;
  });
  if (n) write(prune(list));
  return n;
}

let sweeping = false;

async function sweep(): Promise<void> {
  if (sweeping) return; // never overlap ticks
  sweeping = true;
  try {
    const now = Date.now();
    const due = read().filter((s) => s.status === "pending" && Date.parse(s.sendAt) <= now);
    if (due.length === 0) return;
    if (!hasGmailToken()) return; // not authorized yet — leave pending, retry next tick

    const auth = await getGmailAuth();
    const patches: Record<string, Partial<ScheduledSend>> = {};
    for (const s of due) {
      try {
        const messageId = await sendDraft(auth, s.draftId);
        patches[s.id] = { status: "sent", sentAt: new Date().toISOString(), messageId };
      } catch (e: any) {
        patches[s.id] = { status: "failed", error: e?.message ?? "Send failed." };
      }
    }
    applyPatches(patches);
  } catch {
    /* transient (e.g. auth hiccup) — try again next tick */
  } finally {
    sweeping = false;
  }
}

// Idempotent: the interval lives on globalThis so Next's dev hot-reload (which
// re-imports modules) doesn't stack up duplicate timers. Runs one immediate
// sweep to catch anything that came due while the server was down.
export function startScheduler(): void {
  const g = globalThis as unknown as { __warmreachScheduler?: NodeJS.Timeout };
  if (g.__warmreachScheduler) return;
  g.__warmreachScheduler = setInterval(() => void sweep(), SWEEP_MS);
  void sweep();
}
