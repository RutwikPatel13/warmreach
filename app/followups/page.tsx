"use client";

// /followups — company-wise, reply-aware follow-ups over the Applications log.
// Scans Gmail (retroactively — works on mail sent before this page existed)
// for replies, reads them with Claude, and surfaces three things: who
// replied (with an AI read + a hold/nudge recommendation), who's due for a
// nudge (oldest application first), and who was contacted too recently to
// nudge yet. Nothing sends synchronously — "Send N" creates Gmail drafts and
// queues them on the existing scheduler, same as everywhere else in the app.

import { useRef, useState } from "react";
import Shell from "../_components/Shell";

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
function firstName(name: string): string {
  return (name || "").trim().split(/\s+/)[0] || "there";
}

// Companies where someone replied: non-interested (deflection/rejection/
// auto_ack/out_of_office) first, "interested" (hold) last.
function sortReplied(companies: CompanyState[]): CompanyState[] {
  return [...companies].sort((a, b) => (a.someoneInterested ? 1 : 0) - (b.someoneInterested ? 1 : 0));
}

function primaryReply(c: CompanyState): PersonState | null {
  const interested = c.people.find((p) => p.reply?.category === "interested");
  if (interested) return interested;
  return c.people.find((p) => p.reply) ?? null;
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
    setDraft((d) => (d ? { ...d, loading: true, error: null } : { subject: "", body: "", threadId: null, inReplyTo: null, references: null, loading: true, error: null }));
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

// ── A company card in "Due for follow-up" — expandable, with the checkbox
// list + inline composer + Send/Schedule. ───────────────────────────────────
function DueCompanyCard({ c }: { c: CompanyState }) {
  const [open, setOpen] = useState(false);
  const quiet = c.people.filter((p) => p.status === "quiet" && !p.snoozedUntil);
  const bounced = c.people.filter((p) => p.status === "bounced");
  const anchor = quiet.find((p) => p.cadence.due) ?? quiet[0];

  const [selected, setSelected] = useState<Set<string>>(() => new Set(quiet.filter((p) => p.cadence.due).map((p) => p.email)));
  const { tone, setTone, draft, setDraft, generate } = useDraft(c, anchor);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const toggle = (email: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(email) ? n.delete(email) : n.add(email);
      return n;
    });

  async function send() {
    if (!draft || selected.size === 0) return;
    setSending(true);
    setSendError(null);
    try {
      const items = quiet
        .filter((p) => selected.has(p.email))
        .map((p) => ({
          email: p.email,
          name: p.name,
          company: c.company,
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
        body: JSON.stringify({ items }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Could not schedule follow-ups.");
      if (d.errors?.length) throw new Error(d.errors.map((e: any) => `${e.email}: ${e.error}`).join("; "));
      setSent(true);
    } catch (e: any) {
      setSendError(e.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="cmp-group fu-group">
      <div className="cmp-crow">
        <div className="fu-co-main">
          <strong>{c.company}</strong>
          <span className="meta">
            {c.role || "application"} · applied {fmtDate(c.appliedAt)} · {c.dueCount} due
            {bounced.length > 0 ? ` · ${bounced.length} bounced` : ""}
          </span>
        </div>
        <button type="button" className="ghost btn-sm" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : `Show ${c.people.length}`}
        </button>
      </div>

      {open && (
        <>
          <div className="fu-people">
            {quiet.map((p) => (
              <label key={p.email} className="cmp-prow fu-prow">
                <input type="checkbox" checked={selected.has(p.email)} onChange={() => toggle(p.email)} />
                <span className="fu-pn">{p.name || p.email}</span>
                <span className="fu-pt">{p.title}</span>
                <span className="meta">
                  {p.cadence.due
                    ? `due · nudge ${p.cadence.nextNudgeNumber} · ${p.cadence.businessDaysSince}bd since last touch`
                    : p.cadence.exhausted
                      ? "max follow-ups reached"
                      : `${p.cadence.businessDaysSince}/${p.cadence.threshold ?? "-"}bd`}
                </span>
              </label>
            ))}
            {bounced.map((p) => (
              <div key={p.email} className="cmp-prow fu-prow fu-prow--muted">
                <span className="fu-pn">{p.name || p.email}</span>
                <span className="fu-pt">{p.title}</span>
                <a className="btn-link-ghost btn-xs" href={`/people?name=${encodeURIComponent(c.company)}`}>
                  Bounced · find another
                </a>
              </div>
            ))}
          </div>

          {quiet.length > 0 && (
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

              {draft && !draft.loading && (
                <>
                  <label className="field-label">Subject</label>
                  <input
                    value={draft.subject}
                    onChange={(e) => setDraft((d) => (d ? { ...d, subject: e.target.value } : d))}
                  />
                  <label className="field-label">Body</label>
                  <textarea
                    className="body-editor"
                    value={draft.body}
                    onChange={(e) => setDraft((d) => (d ? { ...d, body: e.target.value } : d))}
                  />
                  <p className="hint">
                    <span className="i">◍</span>
                    Sends as plain text on the SAME thread as the original email when we can find it — no tracking
                    pixel. Skips anyone who replies before it sends.
                  </p>
                  {sendError && <div className="error-box">{sendError}</div>}
                  {sent ? (
                    <span className="badge drafted">Scheduled ✓</span>
                  ) : (
                    <button type="button" className="send-btn" disabled={sending || selected.size === 0} onClick={send}>
                      {sending ? <span className="spinner" /> : null}
                      Send {selected.size} / Schedule
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// A company where everyone who's replied is "out of office" (no interested,
// no other reply) is best summarized as snoozed rather than hold/nudge.
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

// ── A company card in "Someone replied" — the AI read + hold/nudge action. ──
function RepliedCompanyCard({ c }: { c: CompanyState }) {
  const reply = primaryReply(c);
  const quiet = c.people.filter((p) => p.status === "quiet" && !p.snoozedUntil);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function followUpRestAnyway() {
    const anchor = quiet[0];
    if (!anchor) return;
    setBusy(true);
    setError(null);
    try {
      const draftRes = await fetch("/api/followups/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: anchor.email, company: c.company, role: c.role, tone: "gentle" }),
      });
      const d0 = await draftRes.json();
      if (!draftRes.ok) throw new Error(d0.error ?? "Could not generate a follow-up draft.");

      const items = quiet.map((p) => ({
        email: p.email,
        name: p.name,
        company: c.company,
        subject: d0.subject,
        body: `Hi ${firstName(p.name)},\n\n${d0.body}`,
        tone: "gentle",
        nudgeNumber: p.cadence.nextNudgeNumber ?? 1,
        threadId: p.email === anchor.email ? d0.threadId : null,
        inReplyTo: p.email === anchor.email ? d0.inReplyTo : null,
        references: p.email === anchor.email ? d0.references : null,
        lastTouchAt: p.cadence.lastTouchAt,
      }));
      const r = await fetch("/api/followups/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Could not schedule follow-ups.");
      if (d.errors?.length) throw new Error(d.errors.map((e: any) => `${e.email}: ${e.error}`).join("; "));
      setDone(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const pill = pillFor(c);

  return (
    <div className="card fu-reply-card">
      <div className="fu-reply-head">
        <strong>{c.company}</strong>
        <span className="meta">{c.role || "application"}</span>
        <span className={`tag ${pill.tone === "hold" ? "fit-high" : pill.tone === "snoozed" ? "recruiter" : "engineering"}`}>
          {pill.label}
        </span>
      </div>
      {reply?.reply && (
        <>
          <blockquote className="fu-quote">&ldquo;{reply.reply.snippet.slice(0, 220)}&rdquo;</blockquote>
          <div className="fu-ai-read">
            <span className="chip tech">{CATEGORY_LABEL[reply.reply.category]}</span>
            <span>{reply.reply.summary}</span>
            {reply.snoozedUntil && <span className="meta">· snoozed until {fmtDate(reply.snoozedUntil)}</span>}
          </div>
        </>
      )}
      {error && <div className="error-box">{error}</div>}
      <div className="fu-reply-actions">
        {done ? (
          <span className="badge drafted">Scheduled ✓</span>
        ) : (
          <button
            type="button"
            className={c.recommendation === "hold" ? "ghost btn-sm" : "btn-sm"}
            disabled={busy || quiet.length === 0}
            onClick={followUpRestAnyway}
          >
            {busy ? <span className="spinner" /> : null}
            Follow up the rest anyway ({quiet.length})
          </button>
        )}
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
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const cancelRef = useRef(false);

  // Scans in BATCHES so a big mailbox never hangs one request. Results + counts
  // fill in progressively as each batch returns; "Stop" halts after the current
  // batch. The bounced-address set is computed on the first batch and threaded
  // back on the rest, so it's only looked up once.
  async function scan() {
    cancelRef.current = false;
    setLoading(true);
    setError(null);
    setScanned(true);
    setCompanies([]);
    setCounts(null);
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
          companiesApplied: d.total ?? sum.companiesApplied, // true total, not accumulated
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
            <button type="button" className="on">
              Applications
            </button>
            <button type="button" disabled title="Follow-ups currently cover Applications only.">
              Campaigns
            </button>
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
          {progress && (
            <span className="meta tnum" style={{ marginLeft: "auto" }}>
              {progress.done}/{progress.total} companies
            </span>
          )}
        </div>
        {progress && (
          <div style={{ height: 4, background: "var(--surface-2)", borderRadius: 999, overflow: "hidden", marginTop: 10 }}>
            <div
              style={{
                height: "100%",
                width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                background: "var(--accent)",
                transition: "width .2s ease",
              }}
            />
          </div>
        )}
        <p className="hint" style={{ marginTop: 12 }}>
          <span className="i">◍</span>
          Cadence: nudge 1 at +4 business days, nudge 2 at +5, nudge 3 at +6 — max 3, and it stops the moment someone
          replies. Follow-ups are plain text, no tracking pixel.
        </p>
      </div>

      {error && <div className="error-box">{error}</div>}

      {counts && (
        <div className="cmp-stats">
          <div className="cmp-stat">
            <div className="k">Companies applied</div>
            <div className="v tnum">{counts.companiesApplied}</div>
          </div>
          <div className="cmp-stat accent">
            <div className="k">Someone replied</div>
            <div className="v tnum">{counts.someoneReplied}</div>
          </div>
          <div className="cmp-stat warn">
            <div className="k">Companies to nudge</div>
            <div className="v tnum">{counts.companiesToNudge}</div>
          </div>
          <div className="cmp-stat warn">
            <div className="k">People to nudge</div>
            <div className="v tnum">{counts.peopleToNudge}</div>
          </div>
          <div className="cmp-stat">
            <div className="k">Bounced</div>
            <div className="v tnum">{counts.bounced}</div>
          </div>
        </div>
      )}

      {!scanned && !loading && !error && (
        <p className="meta">Scan Gmail to see who replied and who&apos;s due for a follow-up.</p>
      )}

      {scanned && replied.length > 0 && (
        <div className="card fu-section">
          <div className="panel-head-row">
            <div className="panel-head-main">
              <div className="panel-head-text">
                <div className="panel-title">Someone replied · AI read</div>
                <div className="panel-sub">Non-committal replies first, genuinely interested ones last.</div>
              </div>
            </div>
          </div>
          <div className="fu-reply-list">
            {sortReplied(replied).map((c) => (
              <RepliedCompanyCard key={c.companyKey} c={c} />
            ))}
          </div>
        </div>
      )}

      {scanned && due.length > 0 && (
        <div className="card fu-section">
          <div className="panel-head-row">
            <div className="panel-head-main">
              <div className="panel-head-text">
                <div className="panel-title">Due for follow-up · oldest first</div>
                <div className="panel-sub">Quiet is pre-selected. Replied people are skipped automatically.</div>
              </div>
            </div>
          </div>
          {due.map((c) => (
            <DueCompanyCard key={c.companyKey} c={c} />
          ))}
        </div>
      )}

      {scanned && recent.length > 0 && (
        <div className="card fu-section">
          <div className="panel-head-row">
            <div className="panel-head-main">
              <div className="panel-head-text">
                <div className="panel-title">Applied recently · too soon to nudge</div>
                <div className="panel-sub">Still inside the cadence window.</div>
              </div>
            </div>
          </div>
          <div className="fu-recent-list">
            {recent.map((c) => (
              <div key={c.companyKey} className="fu-recent-row">
                <strong>{c.company}</strong>
                <span className="meta">
                  {c.role || "application"} · applied {fmtDate(c.appliedAt)} · {c.people.length} contacted
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {scanned && replied.length === 0 && due.length === 0 && recent.length === 0 && (
        <p className="meta">No applications logged yet — nothing to follow up on.</p>
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
