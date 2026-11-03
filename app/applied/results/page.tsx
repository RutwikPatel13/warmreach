"use client";

// /applied/results — what outreach to companies you applied to through Tsenta
// got back: reply rates by who you emailed, company size, template and role;
// who's due a follow-up; and what each batch spent. Replies come from the last
// Follow-ups scan, so run one there for fresh numbers.

import { useEffect, useState } from "react";
import "../board.css";
import { fmt, shortDate } from "../shared";

interface Bar { label: string; n: number; replied: number; rate: number }
interface Results {
  facts: { emailed: number; replied: number; interviews: number; credits: number; claude: number };
  scannedAt: string | null;
  charts: { title: string; bars: Bar[] }[];
  due: { company: string; who: string[]; lastTouchAt: string | null; due: number }[];
  spend: { at: string; what: string; claude: number; credits: number }[];
}

const CHART_ORDER = ["By who you emailed", "By company size", "By template", "By role"];

export default function ResultsPage() {
  const [r, setR] = useState<Results | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    setR(null);
    fetch(`/api/applied/results${days ? `?days=${days}` : ""}`).then((x) => x.json()).then((j) => (j.error ? setErr(j.error) : setR(j))).catch(() => setErr("Couldn’t load results."));
  }, [days]);

  // One scale for every chart, so bars compare across them: at least 0–20%.
  const max = Math.max(20, ...(r?.charts.flatMap((c) => c.bars.map((b) => b.rate)) ?? [0]));
  const scale = Math.ceil(max / 10) * 10;
  const charts = [...(r?.charts ?? [])].sort((a, b) => CHART_ORDER.indexOf(a.title) - CHART_ORDER.indexOf(b.title));
  const pct = (n: number) => `${n.toFixed(1)}%`;

  return (
    <div className="workspace-inner wide wb-page">
      <header className="wb-head">
        <div className="grow">
          <h1>Results</h1>
          <p>Outreach to companies you applied to through Tsenta: who replied, who's due, and what it cost.</p>
        </div>
        <label className="meta" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>Period
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ border: "1px solid var(--border-strong)", borderRadius: "var(--r-sm)", padding: "7px 10px", background: "var(--surface)", color: "var(--text)", font: "inherit" }}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={0}>All time</option>
          </select>
        </label>
      </header>

      {err && <div className="wb-err">{err}</div>}
      {!r && !err && <p className="meta">Loading…</p>}

      {r && (
        <>
          <div className="ws-facts">
            <div><b>{fmt(r.facts.emailed)}</b><span>people emailed</span></div>
            <div><b>{fmt(r.facts.replied)}</b><span>replied{r.facts.emailed ? ` (${pct((100 * r.facts.replied) / r.facts.emailed)})` : ""}</span></div>
            <div><b>{fmt(r.facts.interviews)}</b><span>interviewing after a reply</span></div>
            <div><b>{fmt(r.facts.credits)}</b><span>Apollo credits spent from the board</span></div>
            <div><b>{fmt(r.facts.claude)}</b><span>email-writing calls from the board</span></div>
          </div>
          <p className="meta" style={{ margin: 0 }}>
            Replies as of the last Follow-ups scan{r.scannedAt ? ` (${shortDate(r.scannedAt)})` : ": none yet"}. Reply rate is the share of people emailed who replied · scale 0–{scale}%.
          </p>

          {charts.length === 0 ? (
            <div className="wb-empty"><b>No outreach to these companies yet.</b><span>Start some applications on the board, review them, and create drafts.</span></div>
          ) : (
            <div className="ws-grid">
              {charts.map((c) => (
                <figure key={c.title} className="ws-card">
                  <figcaption>{c.title}</figcaption>
                  {c.bars.map((b) => (
                    <div key={b.label} className="ws-bar">
                      <span className="l" title={b.label}>{b.label}</span>
                      <span className="ws-track"><span className="ws-fill" style={{ width: `${Math.min(100, (100 * b.rate) / scale)}%` }} /></span>
                      <span className="r"><b>{pct(b.rate)}</b> <span>of {fmt(b.n)}</span></span>
                    </div>
                  ))}
                </figure>
              ))}
            </div>
          )}

          <div className="ws-grid">
            <section className="ws-card">
              <h2>Follow-ups due</h2>
              <div className="ws-list">
                {r.due.length === 0 && <span className="meta">Nobody is due, as of the last scan.</span>}
                {r.due.map((x) => (
                  <div key={x.company}>
                    <span className="t"><b>{x.company}</b> <span>{x.who.join(", ")} · last emailed {shortDate(x.lastTouchAt)}</span></span>
                    <a className="wb-btn sm" href="/followups">Write follow-up</a>
                  </div>
                ))}
              </div>
            </section>
            <section className="ws-card">
              <h2>Spend log</h2>
              {r.spend.length === 0 ? <span className="meta">Nothing spent from the board yet.</span> : (
                <div style={{ overflowX: "auto" }}>
                  <table className="ws-table">
                    <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col" className="n">Model calls</th><th scope="col" className="n">Credits</th></tr></thead>
                    <tbody>
                      {r.spend.map((s, i) => (
                        <tr key={i}>
                          <td className="meta" style={{ whiteSpace: "nowrap" }}>{shortDate(s.at)}, {new Date(s.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</td>
                          <td>{s.what}</td>
                          <td className="n">{s.claude || "—"}</td>
                          <td className="n">{s.credits || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
