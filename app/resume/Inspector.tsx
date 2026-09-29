"use client";

// The right-hand inspector: everything you need to judge a draft without
// leaving the editor. Four panels, and only one of them ever spends money.

import { useState } from "react";
import {
  plain,
  type AtsReport,
  type Fit,
  type ParsedResume,
  type Proposal,
  type RenderReport,
} from "./types";

export type Tab = "tailor" | "fit" | "ats" | "history";

const STATUS_LABEL: Record<Fit["status"], string> = {
  ok: "fits",
  tight: "packed",
  overflow: "over",
  loose: "gap",
  short: "short",
};

// ── Tailor ─────────────────────────────────────────────────────────────────

export function TailorPanel({
  meta,
  isBase,
  proposal,
  pending,
  busy,
  onTailor,
  onReview,
  onDiscard,
}: {
  meta: { company: string; role: string; jd: string; notes: string; jobUrl: string };
  /** Tailoring the master forks it into a new role résumé rather than editing it. */
  isBase?: boolean;
  proposal: Proposal | null;
  /** How many suggestions are still outstanding against the current draft. */
  pending: number;
  busy: string | null;
  onTailor: (form: { company: string; role: string; jd: string; notes: string; jobUrl: string }) => void;
  onReview: () => void;
  onDiscard: () => void;
}) {
  const [form, setForm] = useState(meta);

  if (!proposal) {
    return (
      <div className="rs-panel">
        <p className="rs-help">
          Paste what you&rsquo;d paste into an application. Every bullet comes back traceable to something already in
          your master résumé — nothing invented — and measured against the real page so the line count never moves.
        </p>
        {isBase && (
          <p className="rs-note rs-callout">
            You&rsquo;re looking at your master template. Tailoring won&rsquo;t touch it — it copies it into a new
            résumé filed under the company and role below, and works on that.
          </p>
        )}
        <label className="rs-label" htmlFor="rs-company">Company</label>
        <input id="rs-company" className="rs-input" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder="Vercel" />

        <label className="rs-label" htmlFor="rs-role">Role you&rsquo;re applying to</label>
        <input id="rs-role" className="rs-input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="Software Engineer, Frontend Platform" />

        <label className="rs-label" htmlFor="rs-url">Posting URL (optional)</label>
        <input id="rs-url" className="rs-input" value={form.jobUrl} onChange={(e) => setForm({ ...form, jobUrl: e.target.value })} placeholder="https://" />

        <label className="rs-label" htmlFor="rs-jd">Job description</label>
        <textarea id="rs-jd" className="rs-textarea" rows={12} value={form.jd} onChange={(e) => setForm({ ...form, jd: e.target.value })} placeholder="Paste the whole posting — requirements, responsibilities, nice-to-haves. The more of it, the better the keyword match." />

        <label className="rs-label" htmlFor="rs-notes">Anything to emphasise (optional)</label>
        <textarea id="rs-notes" className="rs-textarea" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. lead with the C++ systems work, they care about latency" />

        <button className="rs-btn is-primary rs-wide" disabled={!!busy} onClick={() => onTailor(form)}>
          {busy === "tailor" ? "Reading the posting…" : isBase ? "Create a résumé for this role" : "Tailor for this role"}
        </button>
        <p className="rs-note">
          The only step on this page that calls the model — everything else is local and free. Measured at 4–8¢ per
          role and about 80 seconds; a second role costs less because your bullet bank stays cached.
        </p>
      </div>
    );
  }

  return (
    <div className="rs-panel">
      <div className="rs-strategy">
        <div className="rs-strategy-head">The argument this version makes</div>
        <p>{proposal.strategy}</p>
      </div>

      {proposal.keywords.length > 0 && (
        <div className="rs-chips">
          {proposal.keywords.map((k) => (
            <span key={k} className="rs-chip is-on">{k}</span>
          ))}
        </div>
      )}

      <div className="rs-runline">
        {proposal.rounds} pass{proposal.rounds === 1 ? "" : "es"}, ${proposal.costUsd.toFixed(3)}
      </div>

      {(proposal.reverted?.length ?? 0) > 0 && (
        <p className="rs-note">
          {proposal.reverted.length} rewrite{proposal.reverted.length === 1 ? " was" : "s were"} dropped after
          measuring — {proposal.reverted.length === 1 ? "it" : "they"} couldn&rsquo;t fill the line without spilling
          onto another. Those bullets are untouched.
        </p>
      )}

      {pending === 0 ? (
        <p className="rs-help">Every suggestion has been applied or skipped.</p>
      ) : (
        <button className="rs-btn is-primary rs-wide" onClick={onReview}>
          Review {pending} change{pending === 1 ? "" : "s"}
        </button>
      )}
      <button className="rs-btn rs-wide" onClick={onDiscard}>Discard the suggestions</button>
    </div>
  );
}

// ── Fit ────────────────────────────────────────────────────────────────────

export function FitPanel({
  parsed,
  report,
  onJump,
}: {
  parsed: ParsedResume | null;
  report: RenderReport | null;
  onJump: (line: number) => void;
}) {
  if (!parsed || !report) return <div className="rs-panel"><p className="rs-help">Compile to measure the page.</p></div>;

  const rows: { id: string; label: string; line: number; text: string }[] = [];
  for (const e of parsed.experience) {
    for (const i of e.items) {
      rows.push({ id: i.id, label: [e.primary, e.secondary].filter(Boolean).join(", ") || e.dates, line: i.line, text: plain(i.text) });
    }
  }
  for (const p of parsed.projects) rows.push({ id: p.id, label: p.name, line: p.line, text: plain(p.blurb) });
  // Skills lines are measured as whole physical lines: two labels often share
  // one, and it's the line that has to fit, not either list on its own.
  for (const c of parsed.skillChunks ?? []) {
    rows.push({
      id: c.id,
      label: `Skills — ${c.skillIds.map((i) => parsed.skills.find((s) => s.id === i)?.label ?? i).join(" + ")}`,
      line: c.line,
      text: plain(c.tex),
    });
  }

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    const s = report.fits[r.id]?.status ?? "ok";
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="rs-panel">
      <p className="rs-help">
        Measured by typesetting each bullet at its real width — not estimated. <b>packed</b> means TeX is squeezing the
        spaces to make it fit, so there&rsquo;s no room for another word. <b>gap</b> means the last line is under 75% full.
      </p>
      <div className="rs-chips">
        {Object.entries(counts).map(([s, n]) => (
          <span key={s} className={`rs-chip is-${s}`}>{n} {STATUS_LABEL[s as Fit["status"]]}</span>
        ))}
      </div>
      <table className="rs-fittable">
        <thead>
          <tr><th>Where</th><th>Lines</th><th>Last line</th><th>Chars</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const f = report.fits[r.id];
            return (
              <tr key={r.id} className={`is-${f?.status ?? "unknown"}`} onClick={() => onJump(r.line)} title={r.text}>
                <td>
                  <div className="rs-fit-where">{r.label}</div>
                  <div className="rs-fit-text">{r.text.slice(0, 72)}…</div>
                </td>
                <td>{f?.lines ?? "—"}</td>
                <td>{f ? `${Math.round(f.lastFill * 100)}%` : "—"}</td>
                <td>{f ? `${f.budget.current} / ${f.budget.max}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── ATS ────────────────────────────────────────────────────────────────────

export function AtsPanel({
  ats,
  hasJd,
  busy,
  onFix,
}: {
  ats: AtsReport | null;
  hasJd: boolean;
  busy: string | null;
  onFix: (fix: string) => void;
}) {
  if (!ats) return <div className="rs-panel"><p className="rs-help">Compile to run the checks.</p></div>;
  const missing = ats.keywords.filter((k) => !k.inResume);
  const present = ats.keywords.filter((k) => k.inResume);

  return (
    <div className="rs-panel">
      <div className={`rs-score is-${ats.score >= 85 ? "good" : ats.score >= 65 ? "mid" : "bad"}`}>
        <div className="rs-score-num">{ats.score}</div>
        <div className="rs-score-label">ATS score</div>
      </div>

      {ats.findings.map((f) => (
        <div key={f.id} className={`rs-finding is-${f.level}`}>
          <div className="rs-finding-head">
            <span className="rs-finding-dot" />
            {f.title}
          </div>
          <div className="rs-finding-detail">{f.detail}</div>
          {f.fixable && (
            <button className="rs-btn is-small" disabled={!!busy} onClick={() => onFix(f.fixable!)}>
              {busy === "fix" ? "Applying…" : "Apply the fix"}
            </button>
          )}
        </div>
      ))}

      {hasJd && (
        <>
          <div className="rs-subhead">Keywords from the posting</div>
          <div className="rs-chips">
            {missing.map((k) => (
              <span key={k.term} className="rs-chip is-off" title={`The posting mentions this ${k.jdCount}×`}>{k.term}</span>
            ))}
            {present.map((k) => (
              <span key={k.term} className="rs-chip is-on" title={`The posting mentions this ${k.jdCount}×`}>{k.term}</span>
            ))}
          </div>
          {missing.length > 0 && (
            <p className="rs-note">
              Greyed terms are in the posting but not the résumé. Add only the ones you can honestly claim — a keyword
              you can&rsquo;t back up in an interview costs more than a missed filter.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── History ────────────────────────────────────────────────────────────────

export function HistoryPanel({
  versions,
  busy,
  onRestore,
}: {
  versions: { stamp: string; bytes: number }[];
  busy: string | null;
  onRestore: (stamp: string) => void;
}) {
  return (
    <div className="rs-panel">
      <p className="rs-help">
        Every save and every applied suggestion snapshots the previous source first. Restoring snapshots the current one
        too, so this never loses work.
      </p>
      {versions.length === 0 && <p className="rs-help">No snapshots yet.</p>}
      {versions.map((v) => (
        <div key={v.stamp} className="rs-version">
          <span>{v.stamp.replace(/-/g, ":").replace("T", " ").slice(0, 19)}</span>
          <button className="rs-btn is-small" disabled={!!busy} onClick={() => onRestore(v.stamp)}>Restore</button>
        </div>
      ))}
    </div>
  );
}
