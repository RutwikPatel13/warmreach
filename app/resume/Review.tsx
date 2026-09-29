"use client";

// Reviewing suggestions, one decision at a time.
//
// The first version listed every suggestion as a card with a checkbox and an
// Apply-all button at the bottom. That is a bulk-approval UI, and it produces
// bulk approval: nine diffs scrolling past, none of them read closely. This is
// the opposite shape — one change fills the space, you see the bullet it
// replaces directly above it, and the only decisions are keep or skip.
//
// The suggestion is editable, because the model's wording is a starting point
// and the answer is often "almost, but say it my way". Every keystroke is
// re-measured against the real typeset page, so the fit meter tells you the
// truth about your own edit, not just about the model's.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { plain, wordDiff, type Fit, type Proposal } from "./types";

export interface ReviewItem {
  id: string;
  where: string;
  before: string;
  after: string;
  rationale: string;
  sourceId: string;
  kind: "bullet" | "project" | "skill";
}

/** The fill meter: a line as long as the line it describes. */
function FitMeter({ fit, pending }: { fit?: Fit | null; pending?: boolean }) {
  if (!fit) {
    return <div className={`rs-meter${pending ? " is-pending" : ""}`}><span className="rs-meter-label">measuring…</span></div>;
  }
  const full = Math.max(0, fit.lines - 1);
  const last = Math.min(1, fit.lastFill);
  const verdict =
    fit.status === "overflow"
      ? "runs past the margin"
      : fit.status === "loose"
        ? `last line only ${Math.round(last * 100)}% full`
        : fit.status === "tight"
          ? "packed — no room for another word"
          : fit.status === "short"
            ? "half a line used"
            : `${fit.lines} line${fit.lines === 1 ? "" : "s"}, last one ${Math.round(last * 100)}% full`;

  return (
    <div className={`rs-meter is-${fit.status}${pending ? " is-pending" : ""}`}>
      <div className="rs-meter-lines">
        {Array.from({ length: full }, (_, i) => (
          <span key={i} className="rs-meter-line is-full" />
        ))}
        <span className="rs-meter-line">
          <span className="rs-meter-fill" style={{ width: `${Math.round(last * 100)}%` }} />
        </span>
      </div>
      <span className="rs-meter-label">{verdict}</span>
    </div>
  );
}

export type Decision = "applied" | "skipped";

export default function Review({
  items,
  proposal,
  docId,
  tex,
  busy,
  decided,
  onDecide,
  onApply,
  onDone,
}: {
  items: ReviewItem[];
  proposal: Proposal;
  docId: string;
  tex: string;
  busy: string | null;
  /** Decisions live on the page so closing the drawer doesn't forget them. */
  decided: Record<string, Decision>;
  onDecide: (id: string, decision: Decision) => void;
  /** Apply one change with the (possibly edited) text. */
  onApply: (item: ReviewItem, text: string) => Promise<void>;
  onDone: () => void;
}) {
  const [index, setIndex] = useState(() => {
    const first = items.findIndex((i) => !decided[i.id]);
    return first === -1 ? 0 : first;
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [fit, setFit] = useState<Fit | null | undefined>(undefined);
  const [fitError, setFitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const remaining = items.filter((i) => !decided[i.id]);
  const item = items[index];
  const draft = item ? (drafts[item.id] ?? item.after) : "";
  const edited = item ? draft !== item.after : false;

  // The measured fit of whatever is currently in the box. Falls back to the
  // measurement the tailoring run already did when the text is untouched.
  const measureDraft = useCallback(
    async (slotId: string, text: string) => {
      setPending(true);
      try {
        const r = await fetch(`/api/resume/${docId}/fit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slotId, text, tex }),
        });
        const d = await r.json();
        if (d.error) {
          setFitError(d.error);
          setFit(null);
        } else {
          setFitError(null);
          setFit(d.fit);
        }
      } catch {
        setFit(null);
      } finally {
        setPending(false);
      }
    },
    [docId, tex],
  );

  useEffect(() => {
    if (!item) return;
    setFitError(null);
    if (!edited) {
      setFit(proposal.fits[item.id] ?? null);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void measureDraft(item.id, draft), 450);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [draft, item, edited, measureDraft, proposal.fits]);

  const diff = useMemo(
    () => (item ? wordDiff(plain(item.before), plain(draft)) : []),
    [item, draft],
  );

  if (!item) return null;

  const step = index + 1;
  const blocked = fit?.status === "overflow" || (fitError !== null);

  function go(n: number): void {
    setIndex(Math.max(0, Math.min(items.length - 1, n)));
  }

  function advance(): void {
    const next = items.findIndex((i, idx) => idx > index && !decided[i.id]);
    if (next === -1) {
      const any = items.findIndex((i) => !decided[i.id]);
      if (any === -1) onDone();
      else go(any);
    } else go(next);
  }

  return (
    <section className="rs-review" aria-label="Review suggestions">
      <header className="rs-review-top">
        <div className="rs-review-count">
          <strong>{step}</strong> of {items.length}
          {remaining.length < items.length && (
            <span className="rs-review-left">{remaining.length} left</span>
          )}
        </div>
        <div className="rs-review-where">{item.where}</div>
        <div className="rs-review-nav">
          <button className="rs-icon" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous">‹</button>
          <button className="rs-icon" onClick={() => go(index + 1)} disabled={index === items.length - 1} aria-label="Next">›</button>
          <button className="rs-btn is-small" onClick={onDone}>Close</button>
        </div>
      </header>

      <div className="rs-review-body">
        <div className="rs-review-col">
          <div className="rs-review-label">Currently</div>
          <p className="rs-review-before">{plain(item.before)}</p>
          <div className="rs-review-label">Change</div>
          <p className="rs-diff">
            {diff.map((d, i) => (
              <span key={i} className={d.kind === "same" ? "" : `rs-diff-${d.kind}`}>{d.text}</span>
            ))}
          </p>
        </div>

        <div className="rs-review-col">
          <div className="rs-review-label">
            Replacement
            {edited && <span className="rs-edited">edited by you</span>}
          </div>
          <textarea
            className="rs-review-edit"
            value={draft}
            spellCheck={false}
            onChange={(e) => setDrafts((d) => ({ ...d, [item.id]: e.target.value }))}
            aria-label="Edit the replacement text"
          />
          <FitMeter fit={fit} pending={pending} />
          {fitError && <div className="rs-review-error">{fitError}</div>}
          <p className="rs-review-why">
            {item.sourceId && <span className="rs-src" title="The résumé bullet this came from">{item.sourceId}</span>}
            {item.rationale}
          </p>
        </div>
      </div>

      <footer className="rs-review-foot">
        <div className="rs-review-state">
          {decided[item.id] === "applied" && <span className="rs-done">Applied</span>}
          {decided[item.id] === "skipped" && <span className="rs-skipped">Skipped</span>}
          {edited && <button className="rs-link" onClick={() => setDrafts((d) => ({ ...d, [item.id]: item.after }))}>Undo my edits</button>}
        </div>
        <div className="rs-review-actions">
          <button
            className="rs-btn"
            onClick={() => {
              onDecide(item.id, "skipped");
              advance();
            }}
          >
            Skip
          </button>
          <button
            className="rs-btn is-primary"
            disabled={!!busy || blocked}
            title={blocked ? "This runs past the margin — trim it first" : undefined}
            onClick={async () => {
              await onApply(item, draft);
              onDecide(item.id, "applied");
              advance();
            }}
          >
            {busy === "apply" ? "Applying…" : decided[item.id] === "applied" ? "Apply again" : "Apply this"}
          </button>
        </div>
      </footer>
    </section>
  );
}
