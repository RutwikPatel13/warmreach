"use client";

// ── Apollo credit meter — the one number Apollo won't return over the API ─────
// You set your balance manually (from Apollo → Settings → Credits); warmreach
// subtracts 1 each time you reveal an email, and you top it up when you buy more.
// Provider-free: reads localStorage directly and syncs every mounted meter via a
// window event, so <CreditMeter/> can drop into any page's sidebar.

import { useEffect, useState } from "react";

const BAL_KEY = "warmreach:v1:apollo:balance"; // remaining credits (manual)
const PUR_KEY = "warmreach:v1:apollo:purchased"; // meter denominator = value at last set
const EVT = "warmreach:credits"; // in-page sync signal

// Reveals since this page loaded. Each page navigation is a full reload in this
// multi-page app, so "this session" naturally means "since this page opened".
let sessionRevealed = 0;

function readStore(): { balance: number | null; purchased: number | null } {
  try {
    const b = localStorage.getItem(BAL_KEY);
    const p = localStorage.getItem(PUR_KEY);
    return { balance: b ? Number(b) : null, purchased: p ? Number(p) : null };
  } catch {
    return { balance: null, purchased: null };
  }
}
function write(key: string, v: number | null) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(v));
  } catch {
    /* private mode / quota — the meter just won't persist */
  }
}
function emit() {
  try {
    window.dispatchEvent(new Event(EVT));
  } catch {
    /* SSR / no window */
  }
}

// Set / top up the balance (also resets the meter's "full" reference).
export function setCreditBalance(n: number) {
  const v = Math.max(0, Math.round(n));
  write(BAL_KEY, v);
  write(PUR_KEY, v);
  emit();
}

// Called on a successful reveal — Apollo charged 1 credit for the match.
export function spendCredit(n = 1) {
  sessionRevealed += n;
  const { balance } = readStore();
  if (balance !== null) write(BAL_KEY, Math.max(0, balance - n)); // unknown balance → count only
  emit();
}

// Live credit state for any component. No provider needed.
export function useCredits() {
  const [snap, setSnap] = useState<{ balance: number | null; purchased: number | null; ready: boolean }>({
    balance: null,
    purchased: null,
    ready: false,
  });
  useEffect(() => {
    const load = () => setSnap({ ...readStore(), ready: true });
    load(); // read once after mount (keeps SSR + first client render in sync)
    const onStorage = (e: StorageEvent) => {
      if (e.key === BAL_KEY || e.key === PUR_KEY) load();
    };
    window.addEventListener(EVT, load);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVT, load);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return {
    balance: snap.balance,
    purchased: snap.purchased,
    ready: snap.ready,
    revealedSession: sessionRevealed,
    setBalance: setCreditBalance,
    spend: spendCredit,
  };
}

// The sidebar-foot meter + its update/top-up dialog.
export function CreditMeter() {
  const { balance, purchased, revealedSession, ready, setBalance } = useCredits();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (!ready) return <div className="cmeter cmeter--skeleton" aria-hidden="true" />;

  const denom = purchased ?? balance ?? 0;
  const pct = balance !== null && denom > 0 ? Math.max(0, Math.min(100, (balance / denom) * 100)) : 0;
  const low = balance !== null && (balance <= 20 || (denom > 0 && balance / denom < 0.1));

  const openEditor = () => {
    setDraft(balance !== null ? String(balance) : "");
    setEditing(true);
  };
  const save = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 0) setBalance(n);
    setEditing(false);
  };

  return (
    <>
      <div className={`cmeter${low ? " low" : ""}`}>
        <div className="cmeter-top">
          <span className="cmeter-k">Apollo credits</span>
          <button type="button" className="cmeter-edit" onClick={openEditor}>
            {balance === null ? "Set" : low ? "Top up" : "Update"}
          </button>
        </div>
        {balance === null ? (
          <button type="button" className="cmeter-set" onClick={openEditor}>
            Set your balance
          </button>
        ) : (
          <>
            <div className="cmeter-val tnum">
              {balance.toLocaleString()}
              {denom > 0 && <small>/ {denom.toLocaleString()}</small>}
            </div>
            <div className="cmeter-track">
              <i style={{ width: `${pct}%` }} />
            </div>
            <div className="cmeter-sub">
              {revealedSession > 0
                ? `${revealedSession} revealed this session`
                : low
                  ? "running low · buy more"
                  : "1 credit per email reveal"}
            </div>
          </>
        )}
      </div>

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Update Apollo credits</div>
            <div className="modal-msg">
              Copy the balance from Apollo → Settings → Credits. warmreach subtracts 1 per email
              reveal — set this again whenever you buy more.
            </div>
            <label className="field-label">Current balance</label>
            <input
              autoFocus
              inputMode="numeric"
              value={draft}
              onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") setEditing(false);
              }}
              placeholder="e.g. 500"
            />
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button type="button" onClick={save}>
                Save balance
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
