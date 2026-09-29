"use client";

// /applied — every job Tsenta applied to, lined up for outreach.
//
// Applications are prepared on their own when they're synced — posting read,
// people found and picked by title — with no Apollo credits and no Claude calls,
// and each lands in the Applications page as a workspace at step 2 the next time
// that page loads. Writing the emails and drafting happen there, exactly as for
// any company you research by hand. This list shows where each one stands, and
// is where you prepare anything left behind or fix one that got stuck.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../_components/AppShell";
import { ago } from "./time";

type Status = "new" | "preparing" | "review" | "opened" | "drafted" | "stuck";

interface Row {
  id: string;
  company: string;
  role: string | null;
  appliedAt: string;
  status: Status;
  error: string | null;
  needs: "posting" | "website" | null;
  picked: number;
  credits: number;
  drafts: number;
}

type Tab = "all" | "review" | "todo" | "opened";

const STATUS_LABEL: Record<Status, string> = {
  new: "Not prepared",
  preparing: "Preparing…",
  review: "Ready",
  opened: "In Applications",
  drafted: "Drafted",
  stuck: "Needs attention",
};

const inTab = (tab: Tab, r: Row) =>
  tab === "all" ||
  (tab === "review" && r.status === "review") ||
  (tab === "todo" && (r.status === "new" || r.status === "preparing" || r.status === "stuck")) ||
  (tab === "opened" && (r.status === "opened" || r.status === "drafted"));

function peopleText(r: Row): string {
  if (r.status === "stuck") return r.error ?? "";
  if (r.status === "drafted") return `${r.drafts} ${r.drafts === 1 ? "draft" : "drafts"} in Gmail`;
  if (r.status === "review" || r.status === "opened") {
    const cr = r.credits === 0 ? "free" : `${r.credits} ${r.credits === 1 ? "credit" : "credits"}`;
    return `${r.picked} ${r.picked === 1 ? "person" : "people"} · ${cr}`;
  }
  return "—";
}

// The Applications page picks this up, creates the workspace, and switches to it.
const openHref = (id: string) => `/?tsenta=${encodeURIComponent(id)}`;

export default function AppliedPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("all");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const [fixText, setFixText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/applied").then((x) => x.json());
      if (r.error) setErr(r.error);
      else setRows(r.rows ?? []);
    } catch {
      setErr("Couldn’t load applications — is the server running?");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { all: rows.length, review: 0, todo: 0, opened: 0 };
    for (const r of rows) for (const t of ["review", "todo", "opened"] as Tab[]) if (inTab(t, r)) c[t]++;
    return c;
  }, [rows]);

  const shown = rows.filter((r) => inTab(tab, r));
  const preparable = shown.filter((r) => r.status === "new");
  const picked = rows.filter((r) => sel.has(r.id) && r.status === "new");

  const toggle = (id: string) =>
    setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // FREE — no Apollo credits, no Claude. Streams one line per application as it
  // finishes, so each row flips to "Ready" as soon as its people are picked.
  const prepare = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    setRunning(true);
    setErr(null);
    setRows((rs) => rs.map((r) => (ids.includes(r.id) ? { ...r, status: "preparing" } : r)));
    try {
      const res = await fetch("/api/applied/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Prepare failed.");
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const u = JSON.parse(line);
          if (!u.id) continue;
          setRows((rs) => rs.map((r) => (r.id === u.id ? {
            ...r,
            status: u.status,
            error: u.error ?? null,
            role: u.role ?? r.role,
            company: u.company ?? r.company,
            picked: u.picked ?? r.picked,
            credits: u.credits ?? r.credits,
          } : r)));
          if (u.status !== "preparing") setSel((s) => { const n = new Set(s); n.delete(u.id); return n; });
        }
      }
    } catch (e: any) {
      setErr(e?.message ?? "Prepare failed.");
    } finally {
      setRunning(false);
      void load(); // picks up "needs" for anything that got stuck
    }
  }, [load]);

  // Stuck → give it what it was missing, then prepare it again.
  const fix = useCallback(async (r: Row) => {
    const value = fixText.trim();
    if (!value) return;
    setErr(null);
    try {
      const res = await fetch(`/api/applied/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(r.needs === "website" ? { companyWebsite: value } : { jd: value }),
      }).then((x) => x.json());
      if (res.error) throw new Error(res.error);
      setFixing(null);
      setFixText("");
      await prepare([r.id]);
    } catch (e: any) {
      setErr(e?.message ?? "Couldn’t save that.");
    }
  }, [fixText, prepare]);

  return (
    <div className="workspace-inner wide ap-page">
      <PageHeader
        title="Applied"
        subtitle="Jobs Tsenta applied to. Each is prepared for free and added to Applications at step 2 — people found and picked, emails still yours to write."
      />

      <div className="ap-tabs" role="tablist">
        {([["all", "All"], ["review", "Ready"], ["todo", "Not prepared"], ["opened", "In Applications"]] as [Tab, string][]).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`ap-tab${tab === id ? " on" : ""}`} onClick={() => setTab(id)}>
            {label} <span className="ap-tab-n">{counts[id]}</span>
          </button>
        ))}
        <span className="ap-tabs-sp" />
        {preparable.length > 0 && (
          <button type="button" className="ap-textbtn" onClick={() => setSel(new Set(preparable.map((r) => r.id)))}>
            Select all {preparable.length} not prepared
          </button>
        )}
      </div>

      {err && <p className="hv-err">{err}</p>}

      <div className="ap-list">
        {loading && <p className="meta ap-empty">Loading…</p>}
        {!loading && rows.length === 0 && (
          <div className="ap-empty">
            <b>No applications yet.</b>
            <span>Ask Claude to “sync tsenta” and every job Tsenta has submitted lands here.</span>
          </div>
        )}
        {!loading && rows.length > 0 && shown.length === 0 && <p className="meta ap-empty">Nothing here.</p>}
        {shown.map((r) => (
          <Fragment key={r.id}>
            <div className={`ap-row${sel.has(r.id) ? " sel" : ""}`}>
              <span className="ap-cb">
                {r.status === "new" && (
                  <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.company}`} />
                )}
              </span>
              <span className="ap-co">
                <b>{r.company}</b>
                <span className={r.role ? "ap-role" : "ap-role none"}>{r.role ?? "Role comes from the posting when prepared"}</span>
              </span>
              <span className="ap-when tnum">{ago(r.appliedAt)}</span>
              <span className={`ap-people tnum${r.status === "stuck" ? " warn" : ""}`}>{peopleText(r)}</span>
              <span><span className={`ap-pill ${r.status}`}>{r.status === "preparing" && <span className="spinner" />}{STATUS_LABEL[r.status]}</span></span>
              <span className="ap-act">
                {r.status === "review" && <a className="ap-go primary" href={openHref(r.id)}>Open in Applications</a>}
                {(r.status === "opened" || r.status === "drafted") && <a className="ap-go" href={openHref(r.id)}>Open</a>}
                {r.status === "stuck" && r.needs && (
                  <button type="button" className="ap-go" onClick={() => { setFixing(fixing === r.id ? null : r.id); setFixText(""); }}>
                    {fixing === r.id ? "Cancel" : "Fix"}
                  </button>
                )}
              </span>
            </div>
            {fixing === r.id && r.needs && (
              <div className="ap-fix">
                <label htmlFor={`fix-${r.id}`}>
                  {r.needs === "website" ? `${r.company}’s website` : "Paste the job description"}
                </label>
                {r.needs === "website" ? (
                  <input id={`fix-${r.id}`} value={fixText} onChange={(e) => setFixText(e.target.value)} placeholder="e.g. ouraring.com" />
                ) : (
                  <textarea id={`fix-${r.id}`} value={fixText} onChange={(e) => setFixText(e.target.value)} placeholder="Copy the posting from the job page and paste it here…" />
                )}
                <div className="ap-fix-act">
                  <button type="button" disabled={running || !fixText.trim()} onClick={() => void fix(r)}>
                    Save &amp; prepare
                  </button>
                  <span className="meta">Free — no Apollo credits, no Claude.</span>
                </div>
              </div>
            )}
          </Fragment>
        ))}
      </div>

      {picked.length > 0 && (
        <div className="ap-bar">
          <b>{picked.length} selected</b>
          <span className="ap-bar-note">Finds the right people and picks the best. No Apollo credits, no Claude.</span>
          <span className="ap-bar-sp" />
          <button type="button" className="ap-bar-quiet" disabled={running} onClick={() => setSel(new Set())}>Clear</button>
          <button type="button" disabled={running} onClick={() => void prepare(picked.map((r) => r.id))}>
            {running && <span className="spinner" />} {running ? "Preparing…" : `Prepare ${picked.length}`}
          </button>
        </div>
      )}
    </div>
  );
}
