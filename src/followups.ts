import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from "./config";
import { profile } from "./profile";
import { HUMAN_EMAIL_RULES, humanize } from "./humanRules";
import { normCompany, type OutreachRow } from "./tracker";

// ── Follow-ups: company-wise, reply-aware follow-up engine ──────────────────
// Applications ONLY (role !== "campaign"), grouped by company. For each person
// already outreached, we find their Gmail thread and check for an inbound
// reply — this works RETROACTIVELY on mail sent before this feature existed,
// since it re-derives the thread from Gmail search rather than relying on a
// stored message id. A genuine reply is read once by Claude (classified +
// summarized); a bounce is detected deterministically (no Claude call). Who's
// "due" for a nudge is computed from a cadence log (data/followups_log.json)
// kept separate from data/outreach_log.csv so follow-up sends never pollute
// the Applications/Campaigns stats.

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────────────────────────────────
// Company / person grouping (from the outreach log)
// ─────────────────────────────────────────────────────────────────────────

export interface PersonRecord {
  email: string;
  name: string;
  title: string;
  company: string;
  role: string;
  firstTouchAt: string; // ISO — earliest logged outreach to this person at this company
  lastTouchAt: string; // ISO — most recent logged outreach (a re-draft updates this)
  draftId: string | null;
  subject: string;
}

export interface CompanyGroup {
  company: string;
  companyKey: string; // normCompany() — stable grouping key
  role: string;
  appliedAt: string; // ISO — earliest application to this company (drives oldest-first ordering)
  people: PersonRecord[];
}

// Applications only, grouped by company (normalized name). Dedupes multiple
// log rows for the same person down to one record: lastTouchAt/draftId/subject
// come from their newest row, firstTouchAt from their oldest.
export function groupApplicationsByCompany(rows: OutreachRow[]): CompanyGroup[] {
  const byCompany = new Map<string, Map<string, PersonRecord>>();
  const roleByCompany = new Map<string, string>();
  const nameByCompany = new Map<string, string>();
  const appliedAtByCompany = new Map<string, string>();

  // outreachRows() is newest-first, so the FIRST row seen per email is the
  // latest touch, and each older row for the same person/company keeps
  // pushing firstTouchAt/appliedAt further back to the true earliest one.
  for (const r of rows) {
    if (!r.company || !r.email || r.role === "campaign") continue;
    const key = normCompany(r.company);
    if (!byCompany.has(key)) byCompany.set(key, new Map());
    const people = byCompany.get(key)!;
    const emailKey = r.email.toLowerCase();
    const draftMatch = r.draftStatus.match(/^draft:(.+)$/);

    const existing = people.get(emailKey);
    if (!existing) {
      people.set(emailKey, {
        email: r.email,
        name: r.name,
        title: r.title,
        company: r.company,
        role: r.role,
        firstTouchAt: r.timestamp,
        lastTouchAt: r.timestamp,
        draftId: draftMatch ? draftMatch[1] : null,
        subject: r.subject,
      });
    } else {
      existing.firstTouchAt = r.timestamp;
    }

    if (!roleByCompany.has(key)) roleByCompany.set(key, r.role);
    if (!nameByCompany.has(key)) nameByCompany.set(key, r.company);
    appliedAtByCompany.set(key, r.timestamp); // ends at the earliest row for this company
  }

  const groups: CompanyGroup[] = [];
  for (const [key, people] of byCompany) {
    groups.push({
      company: nameByCompany.get(key) ?? key,
      companyKey: key,
      role: roleByCompany.get(key) ?? "",
      appliedAt: appliedAtByCompany.get(key) ?? "",
      people: [...people.values()],
    });
  }
  // Oldest application first — the default "due for follow-up" ordering.
  return groups.sort((a, b) => Date.parse(a.appliedAt) - Date.parse(b.appliedAt));
}

// ─────────────────────────────────────────────────────────────────────────
// Cadence: business-day math + the follow-up log (separate from the outreach
// log, so scheduling a nudge never shows up as a new "application").
// ─────────────────────────────────────────────────────────────────────────

export type FollowupTone = "gentle" | "direct" | "add_value";

const FOLLOWUP_LOG = path.resolve("data/followups_log.json");
const NUDGE_THRESHOLDS = { 1: 4, 2: 5, 3: 6 } as const; // business days since last touch
const MAX_NUDGES = 3;

export interface FollowupLogEntry {
  id: string;
  email: string;
  company: string;
  companyKey: string;
  nudgeNumber: 1 | 2 | 3;
  tone: FollowupTone;
  draftId: string;
  threadId: string | null;
  subject: string;
  sentAt: string; // when the follow-up draft was created/queued
}

function readFollowupLog(): FollowupLogEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(FOLLOWUP_LOG, "utf8"));
    return Array.isArray(parsed) ? (parsed as FollowupLogEntry[]) : [];
  } catch {
    return []; // missing / unreadable / malformed — treat as empty
  }
}
function writeFollowupLog(list: FollowupLogEntry[]): void {
  fs.mkdirSync(path.dirname(FOLLOWUP_LOG), { recursive: true });
  fs.writeFileSync(FOLLOWUP_LOG, JSON.stringify(list, null, 2));
}
export function appendFollowupLog(entries: FollowupLogEntry[]): void {
  if (entries.length === 0) return;
  writeFollowupLog([...readFollowupLog(), ...entries]);
}
// Follow-ups already sent/queued to this person at this company, oldest first.
export function followupsFor(email: string, companyKey: string): FollowupLogEntry[] {
  const e = email.toLowerCase();
  return readFollowupLog()
    .filter((f) => f.email.toLowerCase() === e && f.companyKey === companyKey)
    .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
}

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

// Count of business days strictly between `from` and `to` (whole days only —
// no holiday calendar, which is a deliberate simplification for v1).
export function businessDaysBetween(from: Date, to: Date): number {
  if (to.getTime() <= from.getTime()) return 0;
  const d = new Date(from);
  d.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);
  let count = 0;
  while (d.getTime() < end.getTime()) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(d)) count++;
  }
  return count;
}

export interface Cadence {
  due: boolean;
  exhausted: boolean; // already sent nudge #3 — no more follow-ups
  nextNudgeNumber: 1 | 2 | 3 | null;
  businessDaysSince: number;
  threshold: number | null;
  lastTouchAt: string; // original outreach, or the last nudge if any were sent
}

// nudge1 at +4 business days since last touch, nudge2 at +5 since nudge1,
// nudge3 at +6 since nudge2, max 3 total.
export function computeCadence(person: PersonRecord, companyKey: string, now: Date = new Date()): Cadence {
  const sent = followupsFor(person.email, companyKey);
  const lastTouchAt = sent.length ? sent[sent.length - 1].sentAt : person.lastTouchAt;
  const businessDaysSince = businessDaysBetween(new Date(lastTouchAt), now);

  if (sent.length >= MAX_NUDGES) {
    return { due: false, exhausted: true, nextNudgeNumber: null, businessDaysSince, threshold: null, lastTouchAt };
  }
  const nextNudgeNumber = (sent.length + 1) as 1 | 2 | 3;
  const threshold = NUDGE_THRESHOLDS[nextNudgeNumber];
  return { due: businessDaysSince >= threshold, exhausted: false, nextNudgeNumber, businessDaysSince, threshold, lastTouchAt };
}

// ─────────────────────────────────────────────────────────────────────────
// Gmail thread lookup — retroactive, so it works on mail sent before this
// feature existed. We only ever stored a draft id, not a message/thread id,
// so we re-find the thread by searching Sent for a message to this address
// and picking the one closest in time to when the log says we sent it.
// ─────────────────────────────────────────────────────────────────────────

function headerValue(headers: { name?: string | null; value?: string | null }[] | undefined, name: string): string {
  const h = headers?.find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}
function addressOf(headerVal: string): string {
  const m = headerVal.match(/<([^>]+)>/);
  return (m ? m[1] : headerVal).trim().toLowerCase();
}

export interface ThreadMatch {
  threadId: string;
  lastMessageId: string; // Message-Id of the latest message — for In-Reply-To
  references: string; // space-joined Message-Ids of the whole thread — for References
}

// TODO(followups): Gmail search is per-person (one list + one get per
// candidate + one thread fetch) — fine for the handful of people at a
// company but not batch-friendly at real scale. A production version would
// cache thread ids alongside the draft id at send time instead of
// re-searching on every scan.
export async function findThreadForPerson(auth: any, email: string, aroundIso: string): Promise<ThreadMatch | null> {
  const gmail = google.gmail({ version: "v1", auth });
  const list = await gmail.users.messages.list({ userId: "me", q: `in:sent to:${email}`, maxResults: 10 });
  const candidates = list.data.messages ?? [];
  if (candidates.length === 0) return null;

  const around = Date.parse(aroundIso) || Date.now();
  let best: { threadId: string; diff: number } | null = null;
  for (const c of candidates) {
    if (!c.id || !c.threadId) continue;
    const msg = await gmail.users.messages.get({ userId: "me", id: c.id, format: "minimal" });
    const at = Number(msg.data.internalDate ?? 0);
    const diff = Math.abs(at - around);
    if (!best || diff < best.diff) best = { threadId: c.threadId, diff };
  }
  if (!best) return null;

  const thread = await gmail.users.threads.get({ userId: "me", id: best.threadId, format: "full" });
  const messages = thread.data.messages ?? [];
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  const lastMessageId = headerValue(last.payload?.headers as any, "Message-Id");
  const references = messages
    .map((m) => headerValue(m.payload?.headers as any, "Message-Id"))
    .filter(Boolean)
    .join(" ");
  return { threadId: best.threadId, lastMessageId, references };
}

function decodePart(data?: string | null): string {
  if (!data) return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}
function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
// Walk the MIME tree for the plain-text part, falling back to stripped HTML.
function extractPlainText(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodePart(payload.body.data);
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) {
      const t = extractPlainText(p);
      if (t) return t;
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) return stripHtml(decodePart(payload.body.data));
  return "";
}

const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery subsystem/i;
const BOUNCE_SUBJECT = /undeliver|delivery status notification|delivery (has )?failed|returned to sender/i;
function isBounce(fromAddr: string, subject: string): boolean {
  return BOUNCE_FROM.test(fromAddr) || BOUNCE_SUBJECT.test(subject);
}

export type ReplyCategory = "interested" | "auto_ack" | "out_of_office" | "deflection" | "rejection" | "other";
export type Recommendation = "hold" | "nudge_rest";
export type PersonStatus = "quiet" | "replied" | "out_of_office" | "bounced";

export interface ReplyRead {
  category: ReplyCategory;
  summary: string;
  recommendation: Recommendation;
  returnDate: string | null; // YYYY-MM-DD, out_of_office only
  snippet: string;
  threadId: string;
}

export interface ScannedThread {
  status: PersonStatus;
  threadId: string | null;
  reply: ReplyRead | null;
}

// Inspect this person's Gmail thread for an inbound reply since our send. No
// thread found -> "quiet" (can't tell, so cadence just applies as normal). A
// bounce is detected deterministically; a genuine reply is classified once by
// Claude.
export async function scanPersonThread(auth: any, fromAddr: string, person: PersonRecord): Promise<ScannedThread> {
  const match = await findThreadForPerson(auth, person.email, person.lastTouchAt);
  if (!match) return { status: "quiet", threadId: null, reply: null };

  const gmail = google.gmail({ version: "v1", auth });
  const thread = await gmail.users.threads.get({ userId: "me", id: match.threadId, format: "full" });
  const messages = thread.data.messages ?? [];

  let inbound: any = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const from = addressOf(headerValue(messages[i].payload?.headers as any, "From"));
    if (from && from !== fromAddr.toLowerCase()) {
      inbound = messages[i];
      break;
    }
  }
  if (!inbound) return { status: "quiet", threadId: match.threadId, reply: null };

  const headers = inbound.payload?.headers as any;
  const fromAddrIn = addressOf(headerValue(headers, "From"));
  const subject = headerValue(headers, "Subject");
  const body = extractPlainText(inbound.payload) || inbound.snippet || "";

  if (isBounce(fromAddrIn, subject)) {
    return { status: "bounced", threadId: match.threadId, reply: null };
  }

  const read = await classifyReply(body, { name: person.name, company: person.company, role: person.role });
  const status: PersonStatus = read.category === "out_of_office" ? "out_of_office" : "replied";
  return {
    status,
    threadId: match.threadId,
    reply: { ...read, snippet: body.slice(0, 400), threadId: match.threadId },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Claude: classify a reply, and compose a follow-up draft.
// ─────────────────────────────────────────────────────────────────────────

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_reply",
  description: "Classify an inbound reply to a job-outreach email.",
  input_schema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["interested", "auto_ack", "out_of_office", "deflection", "rejection", "other"],
        description:
          "interested = engaged positively / wants to talk further. auto_ack = automated application-received ack. " +
          "out_of_office = an OOO auto-reply (or a human saying they're away). deflection = polite non-committal " +
          "(forwarded on, wrong contact) with no clear yes/no. rejection = a clear no. other = none of the above.",
      },
      summary: { type: "string", description: "One short, plain sentence describing what the reply actually says." },
      recommendation: {
        type: "string",
        enum: ["hold", "nudge_rest"],
        description:
          "hold = pause following up with the rest of this company right now (typically only for a genuine " +
          "'interested' reply). nudge_rest = fine to keep nudging the others.",
      },
      returnDate: {
        type: "string",
        description:
          "For out_of_office replies that state a return date, the date as YYYY-MM-DD. Empty string for every other case, " +
          "or if no date was given.",
      },
    },
    required: ["category", "summary", "recommendation", "returnDate"],
  },
};

export async function classifyReply(
  replyText: string,
  context: { name: string; company: string; role: string },
): Promise<{ category: ReplyCategory; summary: string; recommendation: Recommendation; returnDate: string | null }> {
  const prompt = [
    `You are triaging an inbound email reply to a job-outreach email sent by ${profile.fullName}.`,
    `Original context: ${context.name} at ${context.company}, regarding the "${context.role}" role.`,
    "",
    "REPLY TEXT:",
    replyText.slice(0, 4000),
    "",
    "Classify it, write a one-line human summary, and recommend hold or nudge_rest for the REST of this company.",
    "Return the result by calling the classify_reply tool.",
  ].join("\n");

  const message = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 512,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_reply" },
    messages: [{ role: "user", content: prompt }],
  });
  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Model did not return a classify_reply tool call");
  }
  const out = toolUse.input as { category: ReplyCategory; summary: string; recommendation: Recommendation; returnDate: string };
  return {
    category: out.category,
    summary: humanize(out.summary),
    recommendation: out.recommendation,
    returnDate: out.returnDate?.trim() || null,
  };
}

const FOLLOWUP_TOOL: Anthropic.Tool = {
  name: "compose_followup",
  description: "Return the composed follow-up email.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "The follow-up email subject line." },
      body: { type: "string", description: "The full plain-text follow-up email body (no greeting, no signature)." },
    },
    required: ["subject", "body"],
  },
};

const TONE_GUIDANCE: Record<FollowupTone, string> = {
  gentle: "Gentle: warm, low-pressure, brief — a light nudge in case the original got buried.",
  direct: "Direct: brief and confident, straight to the ask, no apologizing for following up.",
  add_value:
    "Add value: lead with ONE new, concrete, genuinely useful line (a specific thought, a relevant update, a small " +
    "piece of context) before the ask — never generic filler.",
};

export interface FollowupContext {
  company: string;
  role: string;
  originalSubject: string;
}

// No recipient name in here on purpose: like the Campaigns/Applications
// company-level templates, this is ONE follow-up TEMPLATE the composer lets
// you send to several quiet people at the same company — each gets their own
// "Hi <firstName>," prepended (and their own Gmail thread) at send time.
function buildFollowupPrompt(ctx: FollowupContext, tone: FollowupTone): string {
  return [
    `You are drafting a SHORT follow-up email TEMPLATE on behalf of ${profile.fullName}, following up on a`,
    `job-outreach email he sent to people at ${ctx.company} about the "${ctx.role}" role (original subject:`,
    `"${ctx.originalSubject}"). They have not replied yet. This is a template reused for several recipients at the`,
    "same company, so do NOT mention any recipient's name.",
    "",
    `TONE: ${TONE_GUIDANCE[tone]}`,
    "",
    "WRITE the body (NO greeting line, NO signature — both are added separately):",
    "1. One line referencing the original email (remind them what it was about, do not repeat it verbatim).",
    "2. One line of genuine value or context, specific and honest.",
    "3. One clear, low-friction ask.",
    "4. An easy out — make it clearly fine to not respond or to say no.",
    "",
    "RULES:",
    "- PLAIN TEXT. No tracking pixel, no images, no links unless genuinely useful.",
    "- Keep it SHORT: 60-100 words.",
    "- No markdown except the **bold** allowed below.",
    HUMAN_EMAIL_RULES,
    "Also produce a short subject line that reads naturally as a reply on the SAME thread as the original " +
      '(e.g. a "Re: ..." style subject, or a short fresh one).',
    "Return the result by calling the compose_followup tool.",
  ].join("\n");
}

export async function generateFollowupDraft(ctx: FollowupContext, tone: FollowupTone): Promise<{ subject: string; body: string }> {
  const message = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    tools: [FOLLOWUP_TOOL],
    tool_choice: { type: "tool", name: "compose_followup" },
    messages: [{ role: "user", content: buildFollowupPrompt(ctx, tone) }],
  });
  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Model did not return a compose_followup tool call");
  }
  const out = toolUse.input as { subject: string; body: string };
  return { subject: humanize(out.subject), body: humanize(out.body) };
}

// ─────────────────────────────────────────────────────────────────────────
// Top-level orchestration for /api/followups/scan
// ─────────────────────────────────────────────────────────────────────────

export interface PersonState extends PersonRecord {
  status: PersonStatus;
  reply: ReplyRead | null;
  threadId: string | null;
  snoozedUntil: string | null; // out_of_office with a future return date — this person only
  nudgesSent: number;
  cadence: Cadence;
}

export interface CompanyState {
  company: string;
  companyKey: string;
  role: string;
  appliedAt: string;
  people: PersonState[];
  someoneReplied: boolean;
  someoneInterested: boolean;
  recommendation: Recommendation | null; // company-level: set once anyone has replied
  dueCount: number; // quiet, not snoozed, past cadence threshold
}

export interface ScanOptions {
  maxCompanies?: number; // safety cap on Gmail/Claude calls for one scan
  now?: Date;
}

export async function scanFollowups(
  auth: any,
  fromAddr: string,
  rows: OutreachRow[],
  opts: ScanOptions = {},
): Promise<CompanyState[]> {
  const now = opts.now ?? new Date();
  const groups = groupApplicationsByCompany(rows).slice(0, opts.maxCompanies ?? 300);

  const companies: CompanyState[] = [];
  for (const g of groups) {
    const people: PersonState[] = [];
    for (const p of g.people) {
      const scanned = await scanPersonThread(auth, fromAddr, p);
      const cadence = computeCadence(p, g.companyKey, now);

      let snoozedUntil: string | null = null;
      if (scanned.status === "out_of_office" && scanned.reply?.returnDate) {
        const back = Date.parse(scanned.reply.returnDate);
        if (!Number.isNaN(back) && back > now.getTime()) snoozedUntil = scanned.reply.returnDate;
      }

      people.push({
        ...p,
        status: scanned.status,
        reply: scanned.reply,
        threadId: scanned.threadId,
        snoozedUntil,
        nudgesSent: followupsFor(p.email, g.companyKey).length,
        cadence,
      });
    }

    const someoneReplied = people.some((p) => p.status === "replied" || p.status === "out_of_office");
    const someoneInterested = people.some((p) => p.reply?.category === "interested");
    companies.push({
      company: g.company,
      companyKey: g.companyKey,
      role: g.role,
      appliedAt: g.appliedAt,
      people,
      someoneReplied,
      someoneInterested,
      recommendation: someoneInterested ? "hold" : someoneReplied ? "nudge_rest" : null,
      dueCount: people.filter((p) => p.status === "quiet" && !p.snoozedUntil && p.cadence.due).length,
    });
  }

  return companies; // already oldest-application-first from groupApplicationsByCompany
}
