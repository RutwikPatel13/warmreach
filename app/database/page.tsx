"use client";

// ── Database: every contact warmreach holds ─────────────────────────────────
// Was a view over data/outreach_log.csv — i.e. only people you'd already emailed.
// Now it reads the whole contact store (/api/contacts): the Apollo CSV exports,
// everything harvested, the outreach log, and the watchlist referrers, deduped
// per person. "Contacted" is one property of a contact here, not the price of
// admission — so the outreach view is a filtered slice, not the whole page.
//
// Read-only. No Apollo or Gmail cost.

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../_components/AppShell";

type Tab = "contacts" | "outreach";
type Sort = "company" | "name" | "recent" | "title";
type SourceFilter = "all" | "csv" | "harvest" | "outreach" | "watchlist";
type ReachFilter = "all" | "email" | "contacted" | "uncontacted";

interface Person {
  apolloId: string | null;
  firstName: string; lastName: string; fullName: string;
  title: string; company: string; companyDomain: string | null;
  email: string | null; emailStatus: string | null;
  seniority: string | null; linkedin: string | null;
  source: SourceFilter extends never ? never : "csv" | "outreach" | "harvest" | "watchlist";
  addedAt: string; contactedAt: string | null;
}

interface Counts { total: number; withEmail: number; contacted: number; companies: number }

const DAY = 86_400_000;
const PAGE = 400;

const SOURCE_LABEL: Record<string, string> = {
  csv: "Apollo export", harvest: "Harvested", outreach: "Emailed", watchlist: "Referrer",
};

function fmtDate(t: string | null) {
  if (!t) return "—";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
// verified/csv = confident (ok), catch-all = maybe (warn), else unknown (faint).
function statusClass(s: string | null) {
  const v = (s || "").toLowerCase();
  if (v === "verified" || v === "csv") return "v";
  if (v.includes("catch")) return "g";
  return "n";
}

export default function DatabasePage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [bySource, setBySource] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("contacts");
  const [q, setQ] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [reach, setReach] = useState<ReachFilter>("all");
  const [sort, setSort] = useState<Sort>("company");
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    fetch("/api/contacts")
      .then((r) => r.json())
      .then((d) => { setPeople(d.people ?? []); setCounts(d.counts ?? null); setBySource(d.bySource ?? {}); })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  // Outreach tab is the same data with contactedAt required — the old page's
  // scope, now expressed as a filter rather than as a separate source of truth.
  const scoped = useMemo(() => (tab === "outreach" ? people.filter((p) => p.contactedAt) : people), [people, tab]);

  const stats = useMemo(() => {
    const companies = new Set<string>();
    let withEmail = 0, contacted = 0, thisWeek = 0;
    const weekAgo = Date.now() - 7 * DAY;
    for (const p of scoped) {
      if (p.company) companies.add(p.company.toLowerCase());
      if (p.email) withEmail++;
      if (p.contactedAt) {
        contacted++;
        const t = Date.parse(p.contactedAt);
        if (!Number.isNaN(t) && t >= weekAgo) thisWeek++;
      }
    }
    return { people: scoped.length, companies: companies.size, withEmail, contacted, thisWeek };
  }, [scoped]);

  const topCompanies = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of scoped) if (p.company) m.set(p.company, (m.get(p.company) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [scoped]);
  const topMax = topCompanies[0]?.[1] ?? 1;

  const monthly = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of scoped) {
      const stamp = tab === "outreach" ? p.contactedAt : p.addedAt;
      const t = Date.parse(stamp ?? "");
      if (Number.isNaN(t)) continue;
      const d = new Date(t);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12);
  }, [scoped, tab]);
  const monthMax = Math.max(1, ...monthly.map((x) => x[1]));

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let arr = scoped.filter((p) => {
      if (source !== "all" && p.source !== source) return false;
      if (reach === "email" && !p.email) return false;
      if (reach === "contacted" && !p.contactedAt) return false;
      if (reach === "uncontacted" && p.contactedAt) return false;
      if (!needle) return true;
      return `${p.fullName} ${p.company} ${p.email ?? ""} ${p.title}`.toLowerCase().includes(needle);
    });
    const cmp: Record<Sort, (a: Person, b: Person) => number> = {
      company: (a, b) => a.company.localeCompare(b.company) || a.fullName.localeCompare(b.fullName),
      name: (a, b) => a.fullName.localeCompare(b.fullName),
      title: (a, b) => a.title.localeCompare(b.title) || a.company.localeCompare(b.company),
      recent: (a, b) => Date.parse(b.contactedAt ?? b.addedAt) - Date.parse(a.contactedAt ?? a.addedAt),
    };
    return [...arr].sort(cmp[sort]);
  }, [scoped, q, source, reach, sort]);

  useEffect(() => { setLimit(PAGE); }, [q, source, reach, sort, tab]);
  const shown = filtered.slice(0, limit);

  const csvHref = useMemo(() => {
    const head = "name,title,company,email,email_status,source,contacted_at,linkedin";
    const esc = (v: string) => `"${(v ?? "").replace(/"/g, '""')}"`;
    const body = filtered
      .map((p) => [p.fullName, p.title, p.company, p.email ?? "", p.emailStatus ?? "", p.source, p.contactedAt ?? "", p.linkedin ?? ""].map(esc).join(","))
      .join("\n");
    return `data:text/csv;charset=utf-8,${encodeURIComponent(`${head}\n${body}`)}`;
  }, [filtered]);

  return (
    <div className="workspace-inner wide">
      <PageHeader
        title="Database"
        subtitle={
          tab === "contacts"
            ? "Every contact warmreach holds — Apollo exports, harvested people, everyone you've emailed, and your referrers."
            : "Everyone you've actually reached out to — across Applications and Campaigns."
        }
      />

      <div className="cmp-seg db-tabs">
        <button type="button" className={tab === "contacts" ? "on" : ""} onClick={() => setTab("contacts")}>
          Contacts {counts && <span className="db-tab-n">{counts.total.toLocaleString()}</span>}
        </button>
        <button type="button" className={tab === "outreach" ? "on" : ""} onClick={() => setTab("outreach")}>
          Outreach {counts && <span className="db-tab-n">{counts.contacted.toLocaleString()}</span>}
        </button>
      </div>

      {loading ? (
        <p className="meta">Loading your contacts…</p>
      ) : people.length === 0 ? (
        <p className="meta">No contacts yet. Drop an Apollo export in data/contacts/, or run a harvest.</p>
      ) : (
        <>
          <div className="cmp-stats">
            <div className="cmp-stat"><div className="k">{tab === "outreach" ? "People reached" : "People"}</div><div className="v tnum">{stats.people.toLocaleString()}</div></div>
            <div className="cmp-stat"><div className="k">Companies</div><div className="v tnum">{stats.companies.toLocaleString()}</div></div>
            <div className="cmp-stat ok"><div className="k">With an email</div><div className="v tnum">{stats.withEmail.toLocaleString()}</div></div>
            <div className="cmp-stat"><div className="k">Contacted</div><div className="v tnum">{stats.contacted.toLocaleString()}</div></div>
            <div className="cmp-stat accent"><div className="k">This week</div><div className="v tnum">{stats.thisWeek.toLocaleString()}</div></div>
          </div>

          <div className="db-charts">
            <div className="card db-chart">
              <div className="db-chart-head">Top companies <span className="meta">by {tab === "outreach" ? "outreach" : "contacts held"}</span></div>
              <div className="db-bars">
                {topCompanies.map(([name, count]) => (
                  <div className="db-bar-row" key={name} title={`${name}: ${count}`}>
                    <span className="db-bar-label" title={name}>{name}</span>
                    <span className="db-bar-track"><span className="db-bar-fill" style={{ width: `${Math.max(3, (count / topMax) * 100)}%` }} /></span>
                    <span className="db-bar-val tnum">{count}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card db-chart">
              <div className="db-chart-head">
                {tab === "outreach" ? "Outreach over time" : "Contacts added"} <span className="meta">last {monthly.length} months · peak {monthMax}</span>
              </div>
              <div className="db-months" role="img" aria-label="Monthly counts">
                {monthly.map(([k, count]) => {
                  const [y, mo] = k.split("-");
                  const label = new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString(undefined, { month: "short" });
                  return (
                    <div className="db-month" key={k} title={`${label} ${y}: ${count}`}>
                      <span className="db-month-track"><span className="db-month-bar" style={{ height: `${Math.max(2, (count / monthMax) * 100)}%` }} /></span>
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

              {tab === "contacts" && (
                <div className="cmp-seg">
                  {(["all", "csv", "harvest", "outreach", "watchlist"] as SourceFilter[]).map((s) => (
                    <button type="button" key={s} className={source === s ? "on" : ""} onClick={() => setSource(s)}
                      title={s === "all" ? "Every source" : `${SOURCE_LABEL[s]} — ${(bySource[s] ?? 0).toLocaleString()}`}>
                      {s === "all" ? "All" : SOURCE_LABEL[s]}
                    </button>
                  ))}
                </div>
              )}

              <div className="cmp-seg">
                {(["all", "email", "contacted", "uncontacted"] as ReachFilter[]).map((r) => (
                  <button type="button" key={r} className={reach === r ? "on" : ""} onClick={() => setReach(r)}>
                    {r === "all" ? "Any" : r === "email" ? "Has email" : r === "contacted" ? "Contacted" : "Not yet"}
                  </button>
                ))}
              </div>

              <label className="db-sort">Sort
                <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                  <option value="company">Company</option>
                  <option value="name">Name</option>
                  <option value="title">Title</option>
                  <option value="recent">Most recent</option>
                </select>
              </label>

              <a className="btn-xs db-export" href={csvHref} download="warmreach-contacts.csv">Export CSV</a>
              <span className="meta db-count">
                {filtered.length.toLocaleString()} {filtered.length === 1 ? "person" : "people"}
                {filtered.length > shown.length ? ` · showing ${shown.length.toLocaleString()}` : ""}
              </span>
            </div>

            <div className="db-table-wrap">
              <table className="db-table">
                <thead>
                  <tr>
                    <th>Name</th><th>Title</th><th>Company</th><th>Email</th>
                    <th>Source</th><th>{tab === "outreach" ? "Contacted" : "Last touch"}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p, i) => (
                    <tr key={`${p.apolloId ?? p.email ?? p.fullName}-${i}`}>
                      <td className="db-name">
                        {p.fullName || "—"}
                        {p.linkedin && <a className="db-li" href={p.linkedin} target="_blank" rel="noreferrer" title="LinkedIn">in</a>}
                      </td>
                      <td className="db-title">{p.title || "—"}</td>
                      <td>{p.company || "—"}</td>
                      <td className="db-email">
                        {p.email ? (
                          <><span className={`db-dot ${statusClass(p.emailStatus)}`} title={p.emailStatus || "unknown"} />{p.email}</>
                        ) : (
                          <span className="meta">not revealed</span>
                        )}
                      </td>
                      <td><span className={`tag src-${p.source}`}>{SOURCE_LABEL[p.source]}</span></td>
                      <td className="db-date mono">{fmtDate(p.contactedAt ?? p.addedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && <p className="meta db-empty">No matches for “{q}”.</p>}
              {filtered.length > shown.length && (
                <div className="db-more">
                  <button type="button" className="ghost" onClick={() => setLimit((l) => l + PAGE)}>
                    Show {Math.min(PAGE, filtered.length - shown.length).toLocaleString()} more
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
