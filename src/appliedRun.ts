import fs from "node:fs";
import path from "node:path";
import { friendlyLlmError } from "./apiErrors";
import {
  DEFAULT_START,
  getApplication,
  listApplications,
  logSpend,
  prepare,
  stageOf,
  updateApplication,
  type Application,
  type Stage,
  type StartOptions,
} from "./applied";
import { configuredChain } from "./llm";
import { generateVariants, type Email, type Variant } from "./personalize";
import { loadStore } from "./templateStore";
import { contactedCompanies, normCompany } from "./tracker";

// ── the board's Start: one click, up to written emails ──────────────────────
// Each started application goes: read the posting → find the company (by
// website) → find and pick people → write the emails → "ready". The first
// three are free (prepare() in applied.ts). Writing is two model calls per
// company (recruiter + engineering versions), whatever the number of people,
// on whichever providers .env lists (src/llm.ts): the free Gemini and Groq
// tiers when their keys are set, Claude only when it's listed or alone.
// No Apollo credit is spent here: emails are revealed only when you click
// Create drafts in the review queue.
//
// A company it can't identify stops at "needs website" before any people
// search; it carries on from there once you enter the website.
//
// The queue lives in this server process, a few at a time, and is saved to
// data/applied/queue.json after every change, so a reload or a restart picks
// up where it was.

const FILE = path.resolve("data/applied/queue.json");
const POOL = 3;
const CALLS_PER_COMPANY = 2;

/** Who writes the emails, for the board's cost labels: "Gemini free tier, then Groq free tier". */
export function writerLabel(): string {
  try {
    const names = { gemini: "Gemini free tier", groq: "Groq free tier", claude: "Claude (paid)" } as const;
    const seen = [...new Set(configuredChain().map((r) => r.provider))];
    return seen.map((p) => names[p as keyof typeof names] ?? p).join(", then ");
  } catch {
    return "no model configured";
  }
}

type ItemState = "waiting" | "running" | "done" | "canceled";

interface Item {
  id: string;
  batch: string;
  opts: StartOptions;
  state: ItemState;
  addedAt: string;
}

interface Batch {
  id: string;
  at: string;
  ids: string[];
  claude: number;
  logged: boolean;
}

interface QueueState {
  items: Item[];
  batches: Batch[];
  paused: boolean;
}

// One queue per server process, kept on globalThis so a dev-server reload of
// this module doesn't start a second set of workers.
const G = globalThis as unknown as { __wrApplied?: { state: QueueState; workers: number } };

function load(): QueueState {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8")) as QueueState;
    // Anything "running" when the process stopped runs again.
    for (const it of s.items) if (it.state === "running") it.state = "waiting";
    return { items: s.items ?? [], batches: s.batches ?? [], paused: !!s.paused };
  } catch {
    return { items: [], batches: [], paused: false };
  }
}

function q() {
  if (!G.__wrApplied) G.__wrApplied = { state: load(), workers: 0 };
  return G.__wrApplied;
}

function save(): void {
  const s = q().state;
  // Keep the file small: finished items older than a day go.
  const cutoff = Date.now() - 24 * 3600_000;
  s.items = s.items.filter((it) => it.state === "waiting" || it.state === "running" || Date.parse(it.addedAt) > cutoff);
  s.batches = s.batches.filter((b) => !b.logged || Date.parse(b.at) > cutoff);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s));
}

/** Ids waiting or running — the board shows them as queued. */
export function queuedIds(): Set<string> {
  return new Set(q().state.items.filter((it) => it.state === "waiting").map((it) => it.id));
}

// ── writing the emails ──────────────────────────────────────────────────────

function baseFromTemplate(templateId: string | null, company: string, role: string): Record<Variant, Email> | undefined {
  if (!templateId) return undefined;
  const saved = loadStore().templates.find((t) => t.id === templateId);
  if (!saved) throw new Error("The template picked for this batch no longer exists.");
  const merge = (s: string) => s.split("{company}").join(company).split("{role}").join(role);
  return {
    recruiter: { subject: merge(saved.variants.recruiter.subject), body: merge(saved.variants.recruiter.body) },
    engineering: { subject: merge(saved.variants.engineering.subject), body: merge(saved.variants.engineering.body) },
  };
}

function presetText(presetId: string | null): string {
  if (!presetId) return "";
  return loadStore().presets.find((p) => p.id === presetId)?.instructions ?? "";
}

async function writeEmails(a: Application, opts: StartOptions): Promise<Record<Variant, Email>> {
  const org = a.org!;
  const role = (a.role ?? "the role").trim();
  return generateVariants(
    { name: org.name, description: org.description, keywords: org.keywords },
    role,
    a.jd ?? undefined,
    presetText(opts.presetId) || undefined,
    baseFromTemplate(opts.templateId, org.name, role),
  );
}

const hasResume = (a: Application) => !!a.resumePath && fs.existsSync(a.resumePath);

async function runOne(item: Item): Promise<number> {
  const start = getApplication(item.id);
  if (!start || (start.bucket ?? "submitted") !== "submitted") return 0;
  const now = new Date().toISOString();
  updateApplication(item.id, (a) => {
    a.startedAt = a.startedAt ?? now;
    a.options = item.opts;
    if (!hasResume(a)) a.resumeWanted = true;
  });

  let a = getApplication(item.id)!;
  const prepared = !!a.org && a.people.length > 0 && (a.status === "review" || a.status === "ready" || a.status === "writing");
  if (!prepared) a = await prepare(item.id, item.opts);
  if (a.status === "stuck" || !a.org) return 0;
  if (a.status === "ready" && a.emails) return 0;

  updateApplication(item.id, (x) => { x.status = "writing"; });
  try {
    const emails = await writeEmails(a, item.opts);
    updateApplication(item.id, (x) => {
      x.emails = emails;
      x.templateId = item.opts.templateId;
      x.instructions = presetText(item.opts.presetId);
      x.emailsAt = new Date().toISOString();
      x.status = "ready";
      x.error = null;
    });
  } catch (e: any) {
    updateApplication(item.id, (x) => {
      x.status = "stuck";
      x.stuckReason = "other";
      x.error = friendlyLlmError(e) || "Writing the emails failed.";
    });
    return 0; // a failed call writes nothing and isn't counted as spent
  }
  return CALLS_PER_COMPANY;
}

function finishBatches(): void {
  const s = q().state;
  for (const b of s.batches) {
    if (b.logged) continue;
    const open = s.items.some((it) => it.batch === b.id && (it.state === "waiting" || it.state === "running"));
    if (open) continue;
    b.logged = true;
    logSpend({ kind: "start", what: `Start · ${b.ids.length} ${b.ids.length === 1 ? "application" : "applications"}`, claude: b.claude, credits: 0, ids: b.ids });
  }
}

async function worker(): Promise<void> {
  const g = q();
  g.workers++;
  try {
    for (;;) {
      if (g.state.paused) return;
      const item = g.state.items.find((it) => it.state === "waiting");
      if (!item) return;
      item.state = "running";
      save();
      let calls = 0;
      try {
        calls = await runOne(item);
      } catch (e) {
        console.error(`[applied] run failed for ${item.id}:`, e);
      }
      const b = g.state.batches.find((x) => x.id === item.batch);
      if (b) b.claude += calls;
      if (item.state === "running") item.state = "done";
      finishBatches();
      save();
    }
  } finally {
    g.workers--;
  }
}

/** Start workers if there's work and fewer than POOL are running. */
export function kick(): void {
  const g = q();
  if (g.state.paused) return;
  const waiting = g.state.items.filter((it) => it.state === "waiting").length;
  const want = Math.min(POOL, waiting) - g.workers;
  for (let i = 0; i < want; i++) void worker();
}

export function enqueue(ids: string[], opts: StartOptions = DEFAULT_START): number {
  const g = q();
  const busy = new Set(g.state.items.filter((it) => it.state === "waiting" || it.state === "running").map((it) => it.id));
  const fresh = [...new Set(ids)].filter((id) => !busy.has(id));
  if (!fresh.length) return 0;
  const batch = `b_${Date.now().toString(36)}`;
  const addedAt = new Date().toISOString();
  g.state.batches.push({ id: batch, at: addedAt, ids: fresh, claude: 0, logged: false });
  for (const id of fresh) g.state.items.push({ id, batch, opts, state: "waiting", addedAt });
  save();
  kick();
  return fresh.length;
}

/** Run a started row again with the options it was started with (after a website was entered). */
export function resume(id: string): number {
  const a = getApplication(id);
  if (!a?.startedAt) return 0;
  return enqueue([id], a.options ?? DEFAULT_START);
}

export function setPaused(paused: boolean): void {
  q().state.paused = paused;
  save();
  if (!paused) kick();
}

export function cancelWaiting(): number {
  let n = 0;
  for (const it of q().state.items) if (it.state === "waiting") { it.state = "canceled"; n++; }
  finishBatches();
  save();
  return n;
}

export interface QueueView {
  paused: boolean;
  running: number;
  waiting: number;
  done: number;
  total: number;
  finishedAt: string | null; // set once the shown batch is over
  items: { id: string; company: string; state: ItemState; stage: Stage; detail: string | null }[];
}

export function queueView(): QueueView {
  const s = q().state;
  // "This batch" for the panel: everything since the oldest unfinished batch,
  // or, when all are done, the last one, so its results stay in view.
  const open = s.batches.filter((b) => !b.logged);
  const last = s.batches.at(-1);
  const firstAt = open.length ? Math.min(...open.map((b) => Date.parse(b.at))) : last ? Date.parse(last.at) : Infinity;
  const current = s.items.filter((it) => Date.parse(it.addedAt) >= firstAt && it.state !== "canceled");
  const apps = new Map(listApplications().map((a) => [a.id, a]));
  const waiting = new Set(s.items.filter((it) => it.state === "waiting").map((it) => it.id));
  return {
    paused: s.paused,
    running: s.items.filter((it) => it.state === "running").length,
    waiting: waiting.size,
    done: current.filter((it) => it.state === "done").length,
    total: current.length,
    finishedAt: open.length || !last ? null : last.at,
    items: current.slice(-60).map((it) => {
      const a = apps.get(it.id);
      const st = a ? stageOf(a, { queued: waiting, drafts: a.boardDrafts?.length ?? 0, sent: false, replied: false }) : { stage: "error" as Stage, detail: null };
      return { id: it.id, company: a?.org?.name ?? a?.company ?? it.id, state: it.state, stage: st.stage, detail: st.detail };
    }),
  };
}

// ── dry run ─────────────────────────────────────────────────────────────────
// What Start would do, from what's already known. Nothing is fetched, searched
// or written. Whether a company can be found is only known once it's tried, so
// "needs website" here means it already stopped there once.

export interface StartPlan {
  run: { id: string; company: string }[];
  waitResume: { id: string; company: string }[];
  needsWebsite: { id: string; company: string }[];
  maybeContacted: { id: string; company: string }[];
  already: { id: string; company: string }[];
  notStartable: { id: string; company: string }[];
  claude: number; // email-writing model calls
  writer: string;
}

export function planStart(ids: string[], opts: StartOptions = DEFAULT_START): StartPlan {
  const contacted = new Set(contactedCompanies().names);
  const busy = queuedIds();
  const plan: StartPlan = { run: [], waitResume: [], needsWebsite: [], maybeContacted: [], already: [], notStartable: [], claude: 0, writer: "" };
  for (const id of new Set(ids)) {
    const a = getApplication(id);
    if (!a) continue;
    const row = { id, company: a.org?.name ?? a.company };
    if ((a.bucket ?? "submitted") !== "submitted") { plan.notStartable.push(row); continue; }
    const done = a.status === "ready" || a.status === "writing" || a.status === "preparing" || a.status === "drafted" || (a.boardDrafts?.length ?? 0) > 0;
    if (busy.has(id) || done) { plan.already.push(row); continue; }
    const st = stageOf(a, { queued: busy, drafts: 0, sent: false, replied: false }).stage;
    if (st === "needs_website" && !a.companyWebsite) { plan.needsWebsite.push(row); continue; }
    if (contacted.has(normCompany(a.org?.name ?? a.company))) plan.maybeContacted.push(row);
    else plan.run.push(row);
    if (!hasResume(a) && opts.resumeFallback === "wait") plan.waitResume.push(row);
  }
  plan.claude = CALLS_PER_COMPANY * (plan.run.length + plan.maybeContacted.length);
  plan.writer = writerLabel();
  return plan;
}

/** Start options from a request body, clamped to what the runner supports. */
export function normalizeOptions(raw: any): StartOptions {
  const o = raw && typeof raw === "object" ? raw : {};
  const roles = o.roles && typeof o.roles === "object" ? o.roles : {};
  return {
    templateId: typeof o.templateId === "string" && o.templateId ? o.templateId : null,
    presetId: typeof o.presetId === "string" && o.presetId ? o.presetId : null,
    pick: Math.max(1, Math.min(10, Number(o.pick) || DEFAULT_START.pick)),
    roles: {
      recruiter: roles.recruiter !== false,
      team: roles.team !== false,
      founders: roles.founders !== false,
    },
    resumeFallback: o.resumeFallback === "base" ? "base" : "wait",
  };
}
