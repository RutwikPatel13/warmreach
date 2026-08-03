"use client";

import { useEffect, useMemo, useState } from "react";
import { CreditMeter } from "../_components/credits";

// ── Database: everyone you've reached out to ────────────────────────────────
// Read-only view over data/outreach_log.csv (via /api/outreach): stat tiles, a
// couple of small single-series charts, and a searchable/sortable table. No
// Apollo/Gmail cost. Shares the app shell + theme with the other pages.

type Theme = "light" | "dark";
type TypeFilter = "all" | "campaign" | "application";
type Sort = "date" | "name" | "company";

interface Row {
  timestamp: string; company: string; role: string; name: string; title: string;
  email: string; emailStatus: string; subject: string; draftStatus: string;
}

const THEME_KEY = "warmreach:v1:theme";
const DAY = 86_400_000;

function fmtDate(t: string, opts?: Intl.DateTimeFormatOptions) {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, opts ?? { year: "numeric", month: "short", day: "numeric" });
}
// verified/csv = confident (ok), catch-all = maybe (warn), else unknown (faint).
function statusClass(s: string) {
  const v = (s || "").toLowerCase();
  if (v === "verified" || v === "csv") return "v";
  if (v.includes("catch")) return "g";
  return "n";
}

export default function DatabasePage() {
  const [theme, setTheme] = useState<Theme>("light");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [type, setType] = useState<TypeFilter>("all");
  const [sort, setSort] = useState<Sort>("date");

  useEffect(() => { const s = localStorage.getItem(THEME_KEY); if (s === "dark" || s === "light") setTheme(s); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem(THEME_KEY, theme); } catch { /* quota */ } }, [theme]);

  useEffect(() => {
    fetch("/api/outreach").then((r) => r.json()).then((d) => { setRows(d.rows ?? []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const stats = useMemo(() => {
    const emails = new Set<string>(), companies = new Set<string>(), verified = new Set<string>();
    let thisWeek = 0, lastAt = 0; const weekAgo = Date.now() - 7 * DAY;
    for (const r of rows) {
      const e = r.email.toLowerCase();
      if (e) emails.add(e);
      if (r.company) companies.add(r.company.toLowerCase());
      if (e && (r.emailStatus.toLowerCase() === "verified" || r.emailStatus.toLowerCase() === "csv")) verified.add(e);
      const t = Date.parse(r.timestamp);
      if (!Number.isNaN(t)) { if (t >= weekAgo) thisWeek++; if (t > lastAt) lastAt = t; }
    }
    return { people: emails.size, companies: companies.size, logged: rows.length, thisWeek, verified: verified.size, lastAt };
  }, [rows]);

  const topCompanies = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.company) m.set(r.company, (m.get(r.company) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [rows]);
  const topMax = topCompanies[0]?.[1] ?? 1;

  const monthly = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const t = Date.parse(r.timestamp); if (Number.isNaN(t)) continue;
      const d = new Date(t); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12);
  }, [rows]);
  const monthMax = Math.max(1, ...monthly.map((x) => x[1]));

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let arr = rows.filter((r) => {
      if (type === "campaign" && r.role !== "campaign") return false;
      if (type === "application" && r.role === "campaign") return false;
      if (!needle) return true;
      return `${r.name} ${r.company} ${r.email} ${r.title} ${r.subject}`.toLowerCase().includes(needle);
    });
    if (sort === "name") arr = [...arr].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "company") arr = [...arr].sort((a, b) => a.company.localeCompare(b.company) || Date.parse(b.timestamp) - Date.parse(a.timestamp));
    // "date" keeps the server order (newest first).
    return arr;
  }, [rows, q, type, sort]);
  const shown = filtered.slice(0, 500);

  const navLink = (href: string, icon: string, label: string, active = false) => (
    <a href={href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>{icon}&nbsp; {label}</a>
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="side-brand"><span className="brand-mark" aria-hidden="true" /><span className="brand-name">warmreach</span></div>
        <nav className="side-section">
          <div className="side-label">Workspace</div>
          <div className="cmp-nav">
            {navLink("/", "◱", "Applications")}
            {navLink("/campaigns", "◎", "Campaigns")}
            {navLink("/companies", "◨", "Companies")}
            {navLink("/people", "☰", "People")}
            {navLink("/jobs", "▤", "Open roles")}
            {navLink("/database", "▦", "Database", true)}
          </div>
        </nav>
        <div className="side-foot">
          <CreditMeter />
          <button type="button" className={`theme-toggle ${theme === "dark" ? "is-dark" : ""}`}
            aria-pressed={theme === "dark"} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            onClick={() => setTheme((p) => (p === "light" ? "dark" : "light"))}>
            <span className="theme-toggle-track" aria-hidden="true"><span className="theme-toggle-thumb" /></span>
            <span className="theme-toggle-label">{theme === "dark" ? "Dark" : "Light"}</span>
          </button>
        </div>
      </aside>

      <main className="workspace">
        <div className="workspace-inner">
          <div className="main-top">
            <div className="main-co">
              <h1>Database</h1>
              <div className="cmp-sub">Everyone you&apos;ve reached out to — across Applications and Campaigns.</div>
            </div>
          </div>

          {loading ? (
            <p className="meta">Loading your outreach…</p>
          ) : rows.length === 0 ? (
            <p className="meta">No outreach logged yet. Draft some emails in Applications or Campaigns and they&apos;ll show up here.</p>
          ) : (
            <>
              <div className="cmp-stats">
                <div className="cmp-stat"><div className="k">People reached</div><div className="v tnum">{stats.people.toLocaleString()}</div></div>
                <div className="cmp-stat"><div className="k">Companies</div><div className="v tnum">{stats.companies.toLocaleString()}</div></div>
                <div className="cmp-stat"><div className="k">Outreach logged</div><div className="v tnum">{stats.logged.toLocaleString()}</div></div>
                <div className="cmp-stat accent"><div className="k">This week</div><div className="v tnum">{stats.thisWeek.toLocaleString()}</div></div>
                <div className="cmp-stat ok"><div className="k">Verified emails</div><div className="v tnum">{stats.verified.toLocaleString()}</div></div>
              </div>

              <div className="db-charts">
                <div className="card db-chart">
                  <div className="db-chart-head">Top companies <span className="meta">by outreach</span></div>
                  <div className="db-bars">
                    {topCompanies.map(([name, n]) => (
                      <div className="db-bar-row" key={name} title={`${name}: ${n}`}>
                        <span className="db-bar-label" title={name}>{name}</span>
                        <span className="db-bar-track"><span className="db-bar-fill" style={{ width: `${Math.max(3, (n / topMax) * 100)}%` }} /></span>
                        <span className="db-bar-val tnum">{n}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="card db-chart">
                  <div className="db-chart-head">Outreach over time <span className="meta">last {monthly.length} months · peak {monthMax}</span></div>
                  <div className="db-months" role="img" aria-label="Monthly outreach counts">
                    {monthly.map(([k, n]) => {
                      const [y, mo] = k.split("-");
                      const label = new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString(undefined, { month: "short" });
                      return (
                        <div className="db-month" key={k} title={`${label} ${y}: ${n}`}>
                          <span className="db-month-track"><span className="db-month-bar" style={{ height: `${Math.max(2, (n / monthMax) * 100)}%` }} /></span>
                          <span className="db-month-lbl">{label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="db-controls">
                  <input className="db-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, company, email, title…" />
                  <div className="cmp-seg">
                    {(["all", "campaign", "application"] as TypeFilter[]).map((t) => (
                      <button type="button" key={t} className={type === t ? "on" : ""} onClick={() => setType(t)}>{t === "all" ? "All" : t === "campaign" ? "Campaigns" : "Applications"}</button>
                    ))}
                  </div>
                  <label className="db-sort">Sort
                    <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                      <option value="date">Newest</option>
                      <option value="name">Name</option>
                      <option value="company">Company</option>
                    </select>
                  </label>
                  <span className="meta db-count">{filtered.length.toLocaleString()} {filtered.length === 1 ? "person" : "people"}{filtered.length > shown.length ? ` · showing ${shown.length}` : ""}</span>
                </div>

                <div className="db-table-wrap">
                  <table className="db-table">
                    <thead>
                      <tr><th>Name</th><th>Title</th><th>Company</th><th>Email</th><th>Type</th><th>Date</th></tr>
                    </thead>
                    <tbody>
                      {shown.map((r, i) => (
                        <tr key={`${r.email}-${r.timestamp}-${i}`}>
                          <td className="db-name">{r.name || "—"}</td>
                          <td className="db-title">{r.title || "—"}</td>
                          <td>{r.company || "—"}</td>
                          <td className="db-email">
                            <span className={`db-dot ${statusClass(r.emailStatus)}`} title={r.emailStatus || "unknown"} />
                            {r.email || "—"}
                          </td>
                          <td>{r.role === "campaign" ? <span className="tag recruiter">Campaign</span> : <span className="tag engineering" title={r.role}>Application</span>}</td>
                          <td className="db-date mono">{fmtDate(r.timestamp, { month: "short", day: "numeric", year: "numeric" })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filtered.length === 0 && <p className="meta" style={{ padding: 16 }}>No matches for “{q}”.</p>}
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
