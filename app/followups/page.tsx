"use client";

// /followups — company-wise, reply-aware follow-ups over the Applications log.
// Scans Gmail (retroactively — works on mail sent before this page existed) for
// replies, reads them with Claude, and surfaces: who replied (AI read + a
// hold/nudge recommendation), who's due for a nudge (oldest application first),
// and who was contacted too recently to nudge yet. The last scan is PERSISTED
// (server-side), so reopening the page shows it instantly — no re-scan. Nothing
// sends synchronously: "Send N" creates Gmail drafts and queues them on the
// existing scheduler.

import { useEffect, useRef, useState } from "react";
import Shell from "../_components/Shell";
import ScheduleMenu from "../_components/ScheduleMenu";

type Tone = "gentle" | "direct" | "add_value";
type ReplyCategory = "interested" | "auto_ack" | "out_of_office" | "deflection" | "rejection" | "other";
type PersonStatus = "quiet" | "replied" | "out_of_office" | "bounced";

interface ReplyRead {
  category: ReplyCategory;
  summary: string;
  recommendation: "hold" | "nudge_rest";
  returnDate: string | null;
  snippet: string;
  threadId: string;
}
interface Cadence {
  due: boolean;
  exhausted: boolean;
  nextNudgeNumber: 1 | 2 | 3 | null;
  businessDaysSince: number;
  threshold: number | null;
  lastTouchAt: string;
}
interface PersonState {
  email: string;
  name: string;
  title: string;
  company: string;
  role: string;
  firstTouchAt: string;
  lastTouchAt: string;
  draftId: string | null;
  subject: string;
  status: PersonStatus;
  reply: ReplyRead | null;
  threadId: string | null;
  snoozedUntil: string | null;
  nudgesSent: number;
  cadence: Cadence;
}
interface CompanyState {
  company: string;
  companyKey: string;
  role: string;
  appliedAt: string;
  people: PersonState[];
  someoneReplied: boolean;
  someoneInterested: boolean;
  recommendation: "hold" | "nudge_rest" | null;
  dueCount: number;
}
interface Counts {
  companiesApplied: number;
  someoneReplied: number;
  companiesToNudge: number;
  peopleToNudge: number;
  bounced: number;
}

const TONES: { id: Tone; label: string }[] = [
  { id: "gentle", label: "Gentle" },
  { id: "direct", label: "Direct" },
  { id: "add_value", label: "Add value" },
];
const CATEGORY_LABEL: Record<ReplyCategory, string> = {
  interested: "Interested",
  auto_ack: "Auto-ack",
  out_of_office: "Out of office",
  deflection: "Deflection",
  rejection: "Rejection",
  other: "Other",
};

function fmtDate(s: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
function firstName(name: string): string {
  return (name || "").trim().split(/\s+/)[0] || "there";
}
function ordinal(n: number): string {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}
function bdays(n: number): string {
  return `${n} business day${n === 1 ? "" : "s"}`;
}
// One-line summary for the composer's people list — a company's contacts were
// reached out together and share a cadence, so show it once, not on every row.
function peopleSummary(quiet: PersonState[], anchor: PersonState | undefined): string {
  if (quiet.length === 0) return "";
  const times = quiet.map((p) => Date.parse(p.lastTouchAt)).filter((t) => !Number.isNaN(t));
  const minIso = times.length ? new Date(Math.min(...times)).toISOString() : null;
  const maxIso = times.length ? new Date(Math.max(...times)).toISOString() : null;
  const date = !minIso
    ? "an earlier date"
    : fmtDate(minIso) === fmtDate(maxIso!)
      ? fmtDate(minIso)
      : `${fmtDate(minIso)} – ${fmtDate(maxIso!)}`;
  const n = anchor?.cadence.nextNudgeNumber ?? 1;
  const bd = anchor?.cadence.businessDaysSince ?? 0;
  const who = `${quiet.length} ${quiet.length === 1 ? "person" : "people"}`;
  return `Reached out ${date} · ${who} · due for ${ordinal(n)} nudge (no reply in ${bdays(bd)})`;
}
function tint(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 45% 45%)`;
}
function mono(name: string): string {
  return (name || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}
// Free/personal mail domains never represent the company.
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "live.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
]);
// The company's own domain, inferred from the work addresses we emailed there —
// used to fetch a real logo, with the monogram as a graceful fallback.
function companyDomain(people: { email: string }[]): string | null {
  const counts = new Map<string, number>();
  for (const p of people) {
    const at = (p.email || "").indexOf("@");
    if (at < 0) continue;
    const dom = p.email.slice(at + 1).toLowerCase().trim();
    if (!dom || FREE_MAIL.has(dom)) continue;
    counts.set(dom, (counts.get(dom) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [d, n] of counts) if (n > bestN) [best, bestN] = [d, n];
  return best;
}
function Logo({ name, people }: { name: string; people: { email: string }[] }) {
  const domain = companyDomain(people);
  const [failed, setFailed] = useState(false);
  if (domain && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className="fu-logo fu-logo--img"
        src={`https://icons.duckduckgo.com/ip3/${domain}.ico`}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="fu-logo" style={{ background: tint(name) }} aria-hidden="true">
      {mono(name)}
    </span>
  );
}

// Dismiss ("don't follow up here") a company — persisted server-side so it stays
// out of future scans; shows an Undo strip in the meantime.
function useDismiss(companyKey: string) {
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  async function set(v: boolean) {
    setBusy(true);
    try {
      await fetch("/api/followups/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyKey, dismissed: v }),
      });
      setDismissed(v);
    } catch {
      /* ignore — dismiss is best-effort */
    } finally {
      setBusy(false);
    }
  }
  return { dismissed, busy, skip: () => set(true), undo: () => set(false) };
}
function DismissedStrip({ company, onUndo, busy }: { company: string; onUndo: () => void; busy: boolean }) {
  return (
    <div className="fu-co" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 15px" }}>
      <span className="meta">
        Dismissed <b style={{ color: "var(--text)" }}>{company}</b> — won&apos;t show on future scans.
      </span>
      <button type="button" className="ghost btn-sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}

// Replied companies: non-committal replies (deflection/rejection/auto_ack/OOO)
// first, genuinely "interested" ones last.
function sortReplied(companies: CompanyState[]): CompanyState[] {
  return [...companies].sort((a, b) => (a.someoneInterested ? 1 : 0) - (b.someoneInterested ? 1 : 0));
}
function primaryReply(c: CompanyState): PersonState | null {
  return c.people.find((p) => p.reply?.category === "interested") ?? c.people.find((p) => p.reply) ?? null;
}
// A company where the only reply(ies) are out-of-office is best labeled snoozed.
function pillFor(c: CompanyState): { label: string; tone: "hold" | "snoozed" | "nudge" } {
  if (c.recommendation === "hold") return { label: "Hold", tone: "hold" };
  const soonestSnooze = c.people
    .map((p) => p.snoozedUntil)
    .filter((d): d is string => Boolean(d))
    .sort()[0];
  const onlyOoo = c.someoneReplied && c.people.every((p) => p.status !== "replied");
  if (onlyOoo && soonestSnooze) return { label: `Snoozed → ${fmtDate(soonestSnooze)}`, tone: "snoozed" };
  return { label: "Nudge the rest", tone: "nudge" };
}

interface DraftState {
  subject: string;
  body: string;
  threadId: string | null;
  inReplyTo: string | null;
  references: string | null;
  loading: boolean;
  error: string | null;
}
function useDraft(company: CompanyState, anchor: PersonState | undefined) {
  const [tone, setTone] = useState<Tone>("gentle");
  const [draft, setDraft] = useState<DraftState | null>(null);

  async function generate(nextTone?: Tone) {
    if (!anchor) return;
    const t = nextTone ?? tone;
    setDraft((d) =>
      d
        ? { ...d, loading: true, error: null }
        : { subject: "", body: "", threadId: null, inReplyTo: null, references: null, loading: true, error: null },
    );
    try {
      const r = await fetch("/api/followups/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: anchor.email, company: company.company, role: company.role, tone: t }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Could not generate a follow-up draft.");
      setDraft({ subject: d.subject, body: d.body, threadId: d.threadId, inReplyTo: d.inReplyTo, references: d.references, loading: false, error: null });
    } catch (e: any) {
      setDraft((d) => ({ ...(d ?? { subject: "", body: "", threadId: null, inReplyTo: null, references: null }), loading: false, error: e.message }));
    }
  }
  return { tone, setTone, draft, setDraft, generate };
}

// ── Shared composer: pick who to nudge, choose a tone, generate/edit the
// template, and schedule. Used by BOTH the Due cards and the "Follow up the rest
// anyway" action so they behave identically. ─────────────────────────────────
function FollowupComposer({ company, quiet }: { company: CompanyState; quiet: PersonState[] }) {
  const anchor = quiet.find((p) => p.cadence.due) ?? quiet[0];
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set((quiet.some((p) => p.cadence.due) ? quiet.filter((p) => p.cadence.due) : quiet).map((p) => p.email)),
  );
  const { tone, setTone, draft, setDraft, generate } = useDraft(company, anchor);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [sentMode, setSentMode] = useState<"now" | "scheduled">("scheduled");
  const [createdIds, setCreatedIds] = useState<string[]>([]);
  const [canceling, setCanceling] = useState(false);

  const toggle = (email: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(email) ? n.delete(email) : n.add(email);
      return n;
    });

  async function run(sendNow: boolean, startAt?: string) {
    if (!draft || selected.size === 0) return;
    setSending(true);
    setSendError(null);
    try {
      const items = quiet
        .filter((p) => selected.has(p.email))
        .map((p) => ({
          email: p.email,
          name: p.name,
          company: company.company,
          subject: draft.subject,
          body: `Hi ${firstName(p.name)},\n\n${draft.body}`,
          tone,
          nudgeNumber: p.cadence.nextNudgeNumber ?? 1,
          threadId: p.email === anchor?.email ? draft.threadId : null,
          inReplyTo: p.email === anchor?.email ? draft.inReplyTo : null,
          references: p.email === anchor?.email ? draft.references : null,
          lastTouchAt: p.cadence.lastTouchAt,
        }));
      const r = await fetch("/api/followups/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, sendNow, startAt }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Could not send follow-ups.");
      if (d.errors?.length) throw new Error(d.errors.map((e: any) => `${e.email}: ${e.error}`).join("; "));
      setCreatedIds(Array.isArray(d.created) ? d.created.map((x: any) => x.draftId).filter(Boolean) : []);
      setSentMode(sendNow ? "now" : "scheduled");
      setSent(true);
    } catch (e: any) {
      setSendError(e.message);
    } finally {
      setSending(false);
    }
  }

  // Undo a scheduled batch: cancel the queued sends + delete the drafts.
  async function cancel() {
    if (createdIds.length === 0) return;
    setCanceling(true);
    setSendError(null);
    try {
      const r = await fetch("/api/followups/schedule", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftIds: createdIds }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not cancel.");
      setSent(false);
      setCreatedIds([]);
    } catch (e: any) {
      setSendError(e.message);
    } finally {
      setCanceling(false);
    }
  }

  if (quiet.length === 0) return <p className="meta" style={{ padding: "6px 2px" }}>No one left to nudge here.</p>;

  return (
    <>
      <div className="fu-people-summary">{peopleSummary(quiet, anchor)}</div>
      <div className="fu-people">
        {quiet.map((p) => (
          <label key={p.email} className="fu-prow">
            <input type="checkbox" checked={selected.has(p.email)} onChange={() => toggle(p.email)} />
            <span className="fu-pn">{p.name || p.email}</span>
            <span className="fu-pt">{p.title}</span>
          </label>
        ))}
      </div>

      <div className="editor fu-editor">
        <div className="editor-head">
          <strong>Follow-up template</strong>
          <div className="cmp-seg">
            {TONES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={tone === t.id ? "on" : ""}
                onClick={() => {
                  setTone(t.id);
                  void generate(t.id);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button type="button" className="ghost btn-sm" onClick={() => void generate()} disabled={draft?.loading}>
            {draft ? "Regenerate" : "Generate"}
          </button>
        </div>

        {draft?.error && <div className="error-box">{draft.error}</div>}
        {draft?.loading && (
          <p className="meta">
            <span className="spinner" /> writing…
          </p>
        )}
        {!draft && (
          <p className="hint">
            <span className="i">◍</span>
            Pick a tone (or hit Generate) to write the follow-up, then edit it before scheduling.
          </p>
        )}
        {draft && !draft.loading && (
          <>
            <label className="field-label">Subject</label>
            <input value={draft.subject} onChange={(e) => setDraft((d) => (d ? { ...d, subject: e.target.value } : d))} />
            <label className="field-label">Body</label>
            <textarea
              className="body-editor"
              value={draft.body}
              onChange={(e) => setDraft((d) => (d ? { ...d, body: e.target.value } : d))}
            />
            <p className="hint">
              <span className="i">◍</span>
              Sends as plain text on the SAME thread as the original email when we can find it — no tracking pixel.
              Skips anyone who replies before it sends.
            </p>
            {sendError && <div className="error-box">{sendError}</div>}
            {sent ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="badge drafted">
                  {sentMode === "now" ? `Sent ${selected.size} ✓` : `Scheduled ${selected.size} ✓`}
                </span>
                {sentMode === "scheduled" && createdIds.length > 0 && (
                  <button type="button" className="ghost btn-sm" disabled={canceling} onClick={cancel}>
                    {canceling ? "Canceling…" : "Undo"}
                  </button>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div className="send-split">
                  <button type="button" className="send-btn" disabled={sending || selected.size === 0} onClick={() => run(true)}>
                    {sending ? <span className="spinner" /> : null}
                    Send {selected.size} now
                  </button>
                  <ScheduleMenu
                    label={`Schedule (${selected.size})`}
                    disabled={sending || selected.size === 0}
                    onSchedule={(iso) => run(false, iso)}
                  />
                </div>
                <button type="button" className="ghost btn-sm" disabled={sending} onClick={() => setDraft(null)}>
                  Discard
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ── "Due for follow-up" company card — monogram, summary, expand into the
// composer (+ any bounced people). ───────────────────────────────────────────
function DueCompanyCard({ c }: { c: CompanyState }) {
  const [open, setOpen] = useState(false);
  const quiet = c.people.filter((p) => p.status === "quiet" && !p.snoozedUntil);
  const bounced = c.people.filter((p) => p.status === "bounced");
  const dm = useDismiss(c.companyKey);

  if (dm.dismissed) return <DismissedStrip company={c.company} onUndo={dm.undo} busy={dm.busy} />;

  return (
    <div className="fu-co fu-co--hot">
      <div className="fu-co-head">
        <Logo name={c.company} people={c.people} />
        <div className="fu-co-main">
          <div className="fu-co-name">{c.company}</div>
          <div className="fu-co-sum">
            <span>applied {fmtDate(c.appliedAt)}</span>
            <span className="sep">·</span>
            <span>{c.people.length} people</span>
            <span className="sep">·</span>
            <span className="mini"><i style={{ background: "var(--warn)" }} /><b>{c.dueCount}</b> due</span>
            {bounced.length > 0 && (
              <>
                <span className="sep">·</span>
                <span className="mini"><i style={{ background: "var(--err)" }} />{bounced.length} bounced</span>
              </>
            )}
          </div>
        </div>
        <span className="fu-pill quiet">{c.dueCount} to nudge</span>
        <div className="fu-co-actions">
          <button type="button" className="ghost btn-sm" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : `Show ${c.people.length}`}
          </button>
          <button type="button" className="ghost btn-sm" title="Don't follow up at this company" disabled={dm.busy} onClick={dm.skip}>
            Skip
          </button>
        </div>
      </div>

      {open && (
        <div className="fu-co-exp">
          {bounced.length > 0 && (
            <div className="fu-people">
              {bounced.map((p) => (
                <div key={p.email} className="fu-prow fu-prow--muted">
                  <span className="fu-pn">{p.name || p.email}</span>
                  <span className="fu-pt">{p.title}</span>
                  <a className="btn-link-ghost btn-xs" style={{ marginLeft: "auto" }} href={`/people?name=${encodeURIComponent(c.company)}`}>
                    Bounced · find another
                  </a>
                </div>
              ))}
            </div>
          )}
          <FollowupComposer company={c} quiet={quiet} />
        </div>
      )}
    </div>
  );
}

// ── "Someone replied" company card — the AI read + a reveal that opens the SAME
// composer as the Due cards. ─────────────────────────────────────────────────
function RepliedCompanyCard({ c }: { c: CompanyState }) {
  const reply = primaryReply(c);
  const quiet = c.people.filter((p) => p.status === "quiet" && !p.snoozedUntil);
  const [open, setOpen] = useState(false);
  const pill = pillFor(c);
  const genuine = reply?.reply?.category === "interested";
  const recTone = pill.tone; // hold | snoozed | nudge
  const dm = useDismiss(c.companyKey);

  if (dm.dismissed) return <DismissedStrip company={c.company} onUndo={dm.undo} busy={dm.busy} />;

  return (
    <div className="fu-co fu-co--win">
      <div className="fu-co-head">
        <Logo name={c.company} people={c.people} />
        <div className="fu-co-main">
          <div className="fu-co-name">{c.company}</div>
          <div className="fu-co-sum">{c.role || "application"}</div>
        </div>
        <span className={`fu-pill ${recTone}`}>{pill.label}</span>
        <button type="button" className="ghost btn-sm" title="Don't follow up at this company" disabled={dm.busy} onClick={dm.skip}>
          Skip
        </button>
      </div>

      <div className="fu-co-exp" style={{ background: "transparent", borderTop: "none", paddingTop: 0 }}>
        {reply?.reply && (
          <>
            <blockquote className={`fu-quote${genuine ? "" : " fu-quote--flat"}`}>
              &ldquo;{reply.reply.snippet.slice(0, 220)}&rdquo;
            </blockquote>
            <div className="fu-airead">
              <span className="fu-ai-badge">✦ AI</span>
              <span className="fu-ai-text">
                <b>{CATEGORY_LABEL[reply.reply.category]}.</b> {reply.reply.summary}
              </span>
              <span className={`fu-ai-rec ${recTone}`}>{pill.label}</span>
            </div>
          </>
        )}

        <div className="fu-co-actions fu-co-actions--reply">
          <button
            type="button"
            className={recTone === "hold" ? "ghost btn-sm" : "btn-sm"}
            disabled={quiet.length === 0}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide" : `Follow up the rest anyway (${quiet.length})`}
          </button>
        </div>

        {open && quiet.length > 0 && <FollowupComposer company={c} quiet={quiet} />}
      </div>
    </div>
  );
}

function FollowupsView() {
  const [companies, setCompanies] = useState<CompanyState[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const cancelRef = useRef(false);

  // Load the last persisted scan on open — instant, no Gmail/Claude.
  useEffect(() => {
    fetch("/api/followups/scan")
      .then((r) => r.json())
      .then((d) => {
        if (d.cached) {
          setCompanies(d.companies ?? []);
          setCounts(d.counts ?? null);
          setScannedAt(d.scannedAt ?? null);
          setScanned(true);
        }
      })
      .catch(() => {});
  }, []);

  // Fresh scan, in batches so a big mailbox never hangs one request. Results +
  // counts fill in progressively; "Stop" halts after the current batch. The
  // bounced set is computed once (first batch) and threaded back on the rest.
  async function scan() {
    cancelRef.current = false;
    setLoading(true);
    setError(null);
    setScanned(true);
    setCompanies([]);
    setCounts(null);
    setScannedAt(new Date().toISOString());
    setProgress({ done: 0, total: 0 });

    const limit = 8;
    let offset = 0;
    let acc: CompanyState[] = [];
    let sum: Counts = { companiesApplied: 0, someoneReplied: 0, companiesToNudge: 0, peopleToNudge: 0, bounced: 0 };
    let bounced: string[] | undefined;

    try {
      while (true) {
        const r = await fetch("/api/followups/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offset, limit, bouncedAddresses: bounced }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Scan failed.");
        if (offset === 0 && Array.isArray(d.bouncedAddresses)) bounced = d.bouncedAddresses;

        const batch: CompanyState[] = d.companies ?? [];
        acc = [...acc, ...batch];
        const c: Counts = d.counts ?? { companiesApplied: 0, someoneReplied: 0, companiesToNudge: 0, peopleToNudge: 0, bounced: 0 };
        sum = {
          companiesApplied: d.total ?? sum.companiesApplied,
          someoneReplied: sum.someoneReplied + c.someoneReplied,
          companiesToNudge: sum.companiesToNudge + c.companiesToNudge,
          peopleToNudge: sum.peopleToNudge + c.peopleToNudge,
          bounced: sum.bounced + c.bounced,
        };
        setCompanies([...acc]);
        setCounts({ ...sum });
        setProgress({ done: acc.length, total: d.total ?? acc.length });

        offset = d.nextOffset ?? offset + batch.length;
        if (d.done || batch.length === 0 || cancelRef.current) break;
      }
    } catch (e: any) {
      setError(e.message);
      if (acc.length === 0) setCompanies([]);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  const replied = companies?.filter((c) => c.someoneReplied) ?? [];
  const due = companies?.filter((c) => !c.someoneReplied && (c.dueCount > 0 || c.people.some((p) => p.status === "bounced"))) ?? [];
  const recent = companies?.filter((c) => !c.someoneReplied && c.dueCount === 0 && !c.people.some((p) => p.status === "bounced")) ?? [];

  return (
    <>
      <div className="card">
        <div className="fu-filterbar">
          <div className="cmp-seg" aria-label="Outreach scope">
            <button type="button" className="on">Applications</button>
            <button type="button" disabled title="Follow-ups currently cover Applications only.">Campaigns</button>
          </div>
          <button type="button" onClick={scan} disabled={loading}>
            {loading ? <span className="spinner" /> : null}
            {loading ? "Scanning…" : scanned ? "Rescan Gmail" : "Scan for replies"}
          </button>
          {loading && (
            <button type="button" className="ghost btn-sm" onClick={() => { cancelRef.current = true; }}>
              Stop
            </button>
          )}
          <span className="fu-scanmeta">
            {progress
              ? `${progress.done}/${progress.total} companies`
              : scannedAt
                ? `last scanned ${relTime(scannedAt)}`
                : ""}
          </span>
        </div>
        {progress && (
          <div className="fu-progress">
            <i style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
          </div>
        )}

        <div className="fu-rulebar">
          <b>⏱ Cadence</b>
          <span className="fu-rb-step">+4</span>
          <span className="fu-rb-sep">→</span>
          <span className="fu-rb-step">+5</span>
          <span className="fu-rb-sep">→</span>
          <span className="fu-rb-step">+6</span>
          <span>business days · stops the moment someone replies · plain text, no pixel</span>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      {counts && (
        <div className="cmp-stats">
          <div className="cmp-stat"><div className="k">Companies applied</div><div className="v tnum">{counts.companiesApplied}</div></div>
          <div className="cmp-stat ok"><div className="k">Someone replied</div><div className="v tnum">{counts.someoneReplied}</div></div>
          <div className="cmp-stat warn"><div className="k">Companies to nudge</div><div className="v tnum">{counts.companiesToNudge}</div></div>
          <div className="cmp-stat warn"><div className="k">People to nudge</div><div className="v tnum">{counts.peopleToNudge}</div></div>
          <div className="cmp-stat"><div className="k">Bounced</div><div className="v tnum">{counts.bounced}</div></div>
        </div>
      )}

      {!scanned && !loading && !error && (
        <p className="meta">Scan Gmail to see who replied and who&apos;s due for a follow-up. The result is saved, so you only scan when you want fresh data.</p>
      )}

      {scanned && replied.length > 0 && (
        <div className="fu-section">
          <div className="fu-sec-head">
            <span className="lbl">Someone replied · AI read</span>
            <span className="n ok">{replied.length}</span>
            <span className="fu-sec-note">deflections &amp; rejections first</span>
          </div>
          {sortReplied(replied).map((c) => (
            <RepliedCompanyCard key={c.companyKey} c={c} />
          ))}
        </div>
      )}

      {scanned && due.length > 0 && (
        <div className="fu-section">
          <div className="fu-sec-head">
            <span className="lbl">Due for follow-up · oldest first</span>
            <span className="n warn">{due.length}</span>
          </div>
          {due.map((c) => (
            <DueCompanyCard key={c.companyKey} c={c} />
          ))}
        </div>
      )}

      {scanned && recent.length > 0 && (
        <div className="fu-section">
          <div className="fu-sec-head">
            <span className="lbl">Applied recently · too soon to nudge</span>
            <span className="n muted">{recent.length}</span>
          </div>
          <div className="card" style={{ padding: "4px 14px" }}>
            {recent.map((c) => (
              <div key={c.companyKey} className="fu-recent-row">
                <Logo name={c.company} people={c.people} />
                <strong>{c.company}</strong>
                <span className="meta">
                  {c.role || "application"} · applied {fmtDate(c.appliedAt)} · {c.people.length} contacted
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {scanned && !loading && replied.length === 0 && due.length === 0 && recent.length === 0 && (
        <p className="meta">No applications to follow up on yet.</p>
      )}
    </>
  );
}

export default function FollowupsPage() {
  return (
    <Shell active="followups" title="Follow-ups" subtitle="Company-wise, reply-aware nudges over everyone you've already applied to.">
      <FollowupsView />
    </Shell>
  );
}
