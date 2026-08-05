"use client";

// The one-off compose dock — a Gmail-style floating composer for emailing a
// single person (someone revealed on /people, or any address pasted in).
//
// It's non-blocking by design: it floats bottom-right so you can keep browsing,
// reveal a second person, or copy a line out of a dossier while writing. It is
// NOT part of the batch drafting flow and spends no Apollo credits — /api/compose
// is a plain Gmail-draft route with no AI in it.
//
// The Gmail draft is the source of truth. Edits autosave into it (debounced), so
// an unsent compose survives a refresh and can be finished from Gmail instead.
// Send and Schedule reuse the same /api/send and /api/schedule routes the rest of
// the app uses. Discard only ever deletes the draft this composer itself created.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ScheduleMenu, { formatSendAt } from "./ScheduleMenu";

export interface ComposeSeed {
  to?: string;
  name?: string; // display name, shown in the dock title
  subject?: string;
  body?: string;
}

interface ResumeFile {
  path: string;
  label: string;
}

// Its own storage key — nothing here touches the Applications/Campaigns state.
const COMPOSE_KEY = "warmreach:v1:compose";
const AUTOSAVE_MS = 1500;

interface Persisted {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  name?: string;
  resumePath: string;
  draftId: string | null;
  showCc: boolean;
  showBcc: boolean;
}

const ComposeCtx = createContext<(seed?: ComposeSeed) => void>(() => {});

/** Opens the compose dock, optionally prefilled (e.g. from a /people row). */
export function useCompose() {
  return useContext(ComposeCtx);
}

export function ComposeProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<ComposeSeed | null>(null);
  const [restored, setRestored] = useState<Persisted | null>(null);
  // Bumped per open, and used as the dock's key so a new "Email" click starts a
  // fresh composer. It must be state, not Date.now() — a value that changed on
  // every render would remount the dock (losing what's typed) whenever an
  // ancestor re-rendered, e.g. on the theme toggle.
  const [seq, setSeq] = useState(0);

  // Reopen an unfinished compose after a refresh.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COMPOSE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Persisted;
      if (saved?.to || saved?.subject || saved?.body) {
        setRestored(saved);
        setOpen(true);
      }
    } catch {
      /* corrupt/unavailable storage — just don't restore */
    }
  }, []);

  const openCompose = useCallback((next?: ComposeSeed) => {
    setRestored(null);
    setSeed(next ?? {});
    setSeq((n) => n + 1);
    setOpen(true);
  }, []);

  function close() {
    setOpen(false);
    setSeed(null);
    setRestored(null);
    try {
      localStorage.removeItem(COMPOSE_KEY);
    } catch {
      /* quota */
    }
  }

  return (
    <ComposeCtx.Provider value={openCompose}>
      {children}
      {open && (
        <ComposeDock
          key={seed ? `seed_${seq}` : "restored"}
          seed={seed}
          restored={restored}
          onClose={close}
        />
      )}
    </ComposeCtx.Provider>
  );
}

function ComposeDock({
  seed,
  restored,
  onClose,
}: {
  seed: ComposeSeed | null;
  restored: Persisted | null;
  onClose: () => void;
}) {
  const [to, setTo] = useState(restored?.to ?? seed?.to ?? "");
  const [cc, setCc] = useState(restored?.cc ?? "");
  const [bcc, setBcc] = useState(restored?.bcc ?? "");
  const [subject, setSubject] = useState(restored?.subject ?? seed?.subject ?? "");
  const [body, setBody] = useState(restored?.body ?? seed?.body ?? "");
  const [showCc, setShowCc] = useState(restored?.showCc ?? false);
  const [showBcc, setShowBcc] = useState(restored?.showBcc ?? false);
  const [draftId, setDraftId] = useState<string | null>(restored?.draftId ?? null);

  const [resumes, setResumes] = useState<ResumeFile[]>([]);
  const [resumePath, setResumePath] = useState(restored?.resumePath ?? "");
  const [resumeReady, setResumeReady] = useState(Boolean(restored));

  const [minimized, setMinimized] = useState(false);
  const [full, setFull] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "send" | "schedule" | "discard">(null);
  const [done, setDone] = useState<string | null>(null);

  const name = restored?.name ?? seed?.name;
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const draftIdRef = useRef(draftId); // so saveNow() always sees the latest id
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    draftIdRef.current = draftId;
  }, [draftId]);

  // Resume list for the attachment chip. A fresh compose defaults to the same
  // resume the batch flow uses; a restored one keeps whatever it had.
  useEffect(() => {
    let alive = true;
    fetch("/api/resumes")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setResumes(d.resumes ?? []);
        if (!restored) setResumePath(d.default ?? "");
        setResumeReady(true);
      })
      .catch(() => {
        if (alive) setResumeReady(true);
      });
    return () => {
      alive = false;
    };
  }, [restored]);

  // Keep the composer across refreshes.
  useEffect(() => {
    if (!resumeReady) return;
    try {
      localStorage.setItem(
        COMPOSE_KEY,
        JSON.stringify({ to, cc, bcc, subject, body, name, resumePath, draftId, showCc, showBcc } satisfies Persisted),
      );
    } catch {
      /* quota */
    }
  }, [to, cc, bcc, subject, body, name, resumePath, draftId, showCc, showBcc, resumeReady]);

  // Writes the composer into its Gmail draft (creating it on first save).
  const saveNow = useCallback(async (): Promise<string | null> => {
    if (!to.trim()) return null;
    setStatus("saving");
    try {
      const res = await fetch("/api/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftId: draftIdRef.current ?? undefined,
          to,
          cc,
          bcc,
          subject,
          body,
          resumePath,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not save the draft.");
      draftIdRef.current = data.draftId;
      setDraftId(data.draftId);
      dirty.current = false;
      setStatus("saved");
      setError(null);
      return data.draftId as string;
    } catch (e: any) {
      setStatus("error");
      setError(e?.message ?? "Could not save the draft.");
      return null;
    }
  }, [to, cc, bcc, subject, body, resumePath]);

  // Debounced autosave. Waits for the resume list so the first save doesn't
  // create a draft with the wrong attachment.
  useEffect(() => {
    if (!resumeReady || !to.trim()) return;
    if (!dirty.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveNow(), AUTOSAVE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [to, cc, bcc, subject, body, resumePath, resumeReady, saveNow]);

  function edit<T>(setter: (v: T) => void) {
    return (v: T) => {
      dirty.current = true;
      setStatus("idle");
      setter(v);
    };
  }

  // Wraps the selection in **…**, which the existing renderer already turns into
  // <strong> (and strips for the plain-text part). No change to how mail is built.
  function bold() {
    const el = bodyRef.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const picked = body.slice(s, e);
    const next = picked
      ? `${body.slice(0, s)}**${picked}**${body.slice(e)}`
      : `${body.slice(0, s)}****${body.slice(e)}`;
    dirty.current = true;
    setStatus("idle");
    setBody(next);
    const caret = picked ? e + 4 : s + 2;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(picked ? s + 2 : caret, picked ? e + 2 : caret);
    });
  }

  async function send() {
    setBusy("send");
    setError(null);
    if (timer.current) clearTimeout(timer.current);
    const id = await saveNow();
    if (!id) {
      setBusy(null);
      return;
    }
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftIds: [id] }),
      });
      const data = await res.json();
      const result = data?.results?.[0];
      if (!res.ok || !result?.ok) throw new Error(result?.error ?? data?.error ?? "Send failed.");
      setDone("Sent ✓");
      setTimeout(onClose, 1100);
    } catch (e: any) {
      setError(e?.message ?? "Send failed.");
    } finally {
      setBusy(null);
    }
  }

  async function schedule(iso: string) {
    setBusy("schedule");
    setError(null);
    if (timer.current) clearTimeout(timer.current);
    const id = await saveNow();
    if (!id) {
      setBusy(null);
      return;
    }
    try {
      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ draftId: id, to, name, subject }], sendAt: iso }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not schedule the send.");
      setDone(`Scheduled · ${formatSendAt(iso)}`);
      setTimeout(onClose, 1400);
    } catch (e: any) {
      setError(e?.message ?? "Could not schedule the send.");
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    if (timer.current) clearTimeout(timer.current);
    const id = draftIdRef.current;
    if (!id) return onClose();
    setBusy("discard");
    try {
      await fetch("/api/compose", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId: id }),
      });
    } catch {
      /* the draft stays in Gmail; closing is still the right outcome */
    }
    onClose();
  }

  const title = done ?? (name ? `New message · ${name}` : "New message");
  const resumeLabel = resumes.find((r) => r.path === resumePath)?.label ?? resumePath.split("/").pop();

  if (minimized) {
    return (
      <div className="compose-dock is-min">
        <div className="dock-bar" onClick={() => setMinimized(false)}>
          <span className="dock-title">{title}</span>
          <span className="dock-bar-actions">
            <button type="button" title="Expand" onClick={() => setMinimized(false)}>⌃</button>
            <button
              type="button"
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              ✕
            </button>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`compose-dock ${full ? "is-full" : ""}`} role="dialog" aria-label="Compose email">
      <div className="dock-bar">
        <span className="dock-title">{title}</span>
        <span className="dock-bar-actions">
          <button type="button" title="Minimize" onClick={() => setMinimized(true)}>⌄</button>
          <button type="button" title={full ? "Exit full screen" : "Full screen"} onClick={() => setFull((f) => !f)}>
            ⤢
          </button>
          <button type="button" title="Close (keeps the draft)" onClick={onClose}>✕</button>
        </span>
      </div>

      <div className="dock-fields">
        <div className="dock-row">
          <label htmlFor="compose-to">To</label>
          <input
            id="compose-to"
            value={to}
            autoFocus={!to}
            placeholder="name@company.com"
            onChange={(e) => edit(setTo)(e.target.value)}
          />
          <span className="dock-toggles">
            {!showCc && (
              <button type="button" onClick={() => setShowCc(true)}>Cc</button>
            )}
            {!showBcc && (
              <button type="button" onClick={() => setShowBcc(true)}>Bcc</button>
            )}
          </span>
        </div>

        {showCc && (
          <div className="dock-row">
            <label htmlFor="compose-cc">Cc</label>
            <input id="compose-cc" value={cc} onChange={(e) => edit(setCc)(e.target.value)} />
          </div>
        )}
        {showBcc && (
          <div className="dock-row">
            <label htmlFor="compose-bcc">Bcc</label>
            <input id="compose-bcc" value={bcc} onChange={(e) => edit(setBcc)(e.target.value)} />
          </div>
        )}

        <div className="dock-row">
          <label htmlFor="compose-subject">Subject</label>
          <input
            id="compose-subject"
            value={subject}
            autoFocus={Boolean(to)}
            onChange={(e) => edit(setSubject)(e.target.value)}
          />
        </div>
      </div>

      <textarea
        ref={bodyRef}
        className="dock-body"
        value={body}
        placeholder="Write your email…"
        onChange={(e) => edit(setBody)(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
            e.preventDefault();
            bold();
          }
        }}
      />

      {(error || status !== "idle") && (
        <div className={`dock-status ${error ? "is-err" : ""}`}>
          {error ?? (status === "saving" ? "Saving…" : status === "saved" ? "Saved to Gmail ✓" : "")}
        </div>
      )}

      <div className="dock-foot">
        <div className="dock-tools">
          <button type="button" className="dock-bold" title="Bold (⌘B)" onClick={bold}>
            B
          </button>
          {resumePath ? (
            <span className="dock-chip" title={resumePath}>
              📎
              <select value={resumePath} onChange={(e) => edit(setResumePath)(e.target.value)}>
                {resumes.length === 0 && <option value={resumePath}>{resumeLabel}</option>}
                {resumes.map((r) => (
                  <option key={r.path} value={r.path}>
                    {r.label}
                  </option>
                ))}
              </select>
              <button type="button" title="Remove attachment" onClick={() => edit(setResumePath)("")}>
                ✕
              </button>
            </span>
          ) : (
            resumes.length > 0 && (
              <button type="button" className="dock-attach" onClick={() => edit(setResumePath)(resumes[0].path)}>
                📎 Attach resume
              </button>
            )
          )}
        </div>

        <div className="dock-actions">
          <button type="button" onClick={send} disabled={!to.trim() || busy !== null || Boolean(done)}>
            {busy === "send" ? "Sending…" : "Send"}
          </button>
          <ScheduleMenu
            disabled={!to.trim() || busy !== null || Boolean(done)}
            onSchedule={schedule}
            align="right"
          />
          <button
            type="button"
            className="ghost dock-discard"
            title="Discard draft"
            onClick={discard}
            disabled={busy !== null || Boolean(done)}
          >
            🗑
          </button>
        </div>
      </div>
    </div>
  );
}
