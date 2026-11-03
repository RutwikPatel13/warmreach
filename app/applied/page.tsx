"use client";

// /applied — the Applied board: every job Tsenta applied to, thousands of rows.
//
// Filter and sort down to the ones worth chasing, select, and Start. Start runs
// each one up to written emails on the server (src/appliedRun.ts): read the
// posting, find the company by its website, pick people (all free), then two
// model calls per company to write the emails (free Gemini/Groq tiers when
// configured). A company it can't identify
// stops at "Needs website" before anything is searched or spent. Apollo
// credits are spent only in the review queue, when you click Create drafts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./board.css";
import { STAGE, STAGE_GROUPS, STARTABLE, fmt, money, shortDate, sizeBucket, stageRank, titleCase, type BoardRow } from "./shared";
import { Drawer } from "./Drawer";
import { Logo } from "./Logo";
import { StartDialog } from "./StartDialog";

type Bucket = BoardRow["bucket"];
type Tab = "all" | Bucket;

interface Meta { lastSyncAt: string | null; syncRequestedAt: string | null; tsentaTotal: number | null }
export interface QueueView {
  paused: boolean;
  running: number;
  waiting: number;
  done: number;
  total: number;
  finishedAt: string | null;
  items: { id: string; company: string; state: "waiting" | "running" | "done" | "canceled"; stage: BoardRow["stage"]; detail: string | null }[];
}

const TABS: [Tab, string][] = [["all", "All"], ["submitted", "Submitted"], ["in_flight", "In flight"], ["needs", "Needs you"], ["failed", "Failed"], ["skipped", "Skipped"]];

// ── filters ─────────────────────────────────────────────────────────────────

type Facet = "applied" | "outreach" | "pipeline" | "inbox" | "ats" | "location" | "skills" | "resume" | "company" | "size" | "industry" | "details";

const FACETS: { key: Facet; name: string; hint?: string; many?: boolean }[] = [
  { key: "applied", name: "Applied" },
  { key: "outreach", name: "Outreach" },
  { key: "pipeline", name: "Pipeline in Tsenta" },
  { key: "inbox", name: "Tsenta inbox", hint: "Mail sent to your Tsenta address" },
  { key: "ats", name: "Job board" },
  { key: "location", name: "Location", many: true },
  { key: "skills", name: "Skills", hint: "Tsenta's skill tags", many: true },
  { key: "resume", name: "Résumé" },
  { key: "company", name: "Company" },
  { key: "size", name: "Company size" },
  { key: "industry", name: "Industry", hint: "From Apollo, once the company is found", many: true },
  { key: "details", name: "Job details", hint: "When Tsenta has them" },
];

// Shown beside the search as one-click ways into the filters panel.
const QUICK: Facet[] = ["applied", "outreach", "pipeline", "size"];

const DAY = 86_400_000;
const AGES: [string, number][] = [["Last 7 days", 7], ["Last 14 days", 14], ["Last 30 days", 30], ["Last 90 days", 90]];
const SIZES = ["1–50", "51–200", "201–1,000", "1,000+", "Unknown"];

function valuesOf(r: BoardRow, f: Facet, now: number): string[] {
  switch (f) {
    case "applied": {
      const age = (now - Date.parse(r.appliedAt)) / DAY;
      return AGES.filter(([, d]) => age <= d).map(([l]) => l);
    }
    case "outreach": return [STAGE[r.stage].group];
    case "pipeline": return [r.pipeline ? titleCase(r.pipeline) : "No tracker row"];
    case "inbox": return r.inbox.length ? r.inbox.map(titleCase) : ["Nothing yet"];
    case "ats": return [r.ats ? titleCase(r.ats) : "Unknown"];
    case "location": return r.locations.length ? r.locations : ["Not listed"];
    case "skills": return r.skills;
    case "resume": return [
      r.tailored === true ? "Tailored by Tsenta" : r.tailored === false ? "Your base résumé" : "Tailoring not known",
      r.resume === "saved" ? "Saved in warmreach" : "Not fetched yet",
    ];
    case "company": return [
      r.domain ? "Found" : "Not found yet",
      ...(r.contacted ? ["Already contacted"] : ["Never contacted"]),
      ...(r.onFile ? ["People on file"] : []),
    ];
    case "size": return [sizeBucket(r.employees)];
    case "industry": return [r.industry ?? "Unknown"];
    case "details": return [
      ...(r.sponsorship === true ? ["Sponsorship offered"] : r.sponsorship === false ? ["No sponsorship"] : []),
      ...(r.employmentType ? [titleCase(r.employmentType)] : []),
      ...(r.salaryMin != null ? ["Salary listed"] : []),
    ];
  }
}

type Filters = Record<Facet, string[]>;
const NO_FILTERS = Object.fromEntries(FACETS.map((f) => [f.key, []])) as unknown as Filters;

// ── columns ─────────────────────────────────────────────────────────────────

type ColKey = "company" | "role" | "applied" | "pipeline" | "resume" | "people" | "outreach" | "location" | "ats" | "skills" | "size" | "industry" | "salary" | "tsenta";
type SortKey = ColKey;

interface Row extends BoardRow { roles: number; ids: string[] }

const COLS: { key: ColKey; label: string; from: string; width: string }[] = [
  { key: "company", label: "Company", from: "Tsenta + Apollo", width: "minmax(180px, 1.4fr)" },
  { key: "role", label: "Role", from: "Tsenta", width: "minmax(170px, 1.3fr)" },
  { key: "applied", label: "Applied", from: "Tsenta", width: "104px" },
  { key: "pipeline", label: "Pipeline", from: "Tsenta tracker", width: "110px" },
  { key: "resume", label: "Résumé", from: "Tsenta", width: "100px" },
  { key: "people", label: "People", from: "warmreach", width: "84px" },
  { key: "outreach", label: "Outreach", from: "warmreach", width: "minmax(150px, 1fr)" },
  { key: "location", label: "Location", from: "Tsenta", width: "minmax(110px, .8fr)" },
  { key: "ats", label: "Job board", from: "Tsenta", width: "100px" },
  { key: "skills", label: "Skills", from: "Tsenta", width: "minmax(120px, .8fr)" },
  { key: "size", label: "Size", from: "Apollo", width: "84px" },
  { key: "industry", label: "Industry", from: "Apollo", width: "minmax(110px, .8fr)" },
  { key: "salary", label: "Salary", from: "Tsenta details", width: "100px" },
  { key: "tsenta", label: "Tsenta status", from: "Tsenta", width: "130px" },
];
const DEFAULT_COLS: ColKey[] = ["company", "role", "applied", "pipeline", "resume", "people", "outreach"];
const COLS_KEY = "warmreach:v1:applied:cols";
const GROUP_KEY = "warmreach:v1:applied:group";
const SINCE_KEY = "warmreach:v1:applied:since";
const longDate = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function sortValue(r: Row, k: SortKey): string | number {
  switch (k) {
    case "company": return r.company.toLowerCase();
    case "role": return (r.role ?? "").toLowerCase();
    case "applied": return Date.parse(r.appliedAt) || 0;
    case "pipeline": return r.pipeline ?? "~";
    case "resume": return r.resume === "saved" ? 0 : r.resume === "wanted" ? 1 : 2;
    case "people": return r.picked;
    case "outreach": return stageRank(r.stage);
    case "location": return (r.locations[0] ?? "~").toLowerCase();
    case "ats": return (r.ats ?? "~").toLowerCase();
    case "skills": return (r.skills[0] ?? "~").toLowerCase();
    case "size": return r.employees ?? -1;
    case "industry": return (r.industry ?? "~").toLowerCase();
    case "salary": return r.salaryMax ?? r.salaryMin ?? -1;
    case "tsenta": return r.bucket;
  }
}

function cell(r: Row, k: ColKey) {
  switch (k) {
    case "company": {
      const sub = [r.domain ?? r.site ?? (r.stage === "needs_website" ? "website not found" : null), r.employees != null ? `${fmt(r.employees)} people` : null, r.roles > 1 ? `${r.roles} roles` : null].filter(Boolean).join(" · ");
      return (
        <span className="wb-co">
          <Logo name={r.company} logoUrl={r.logoUrl} site={r.site} />
          <span className="t"><b>{r.company}</b><span className="sub">{sub || "\u00a0"}</span></span>
        </span>
      );
    }
    case "role": return <>{r.role ?? "Role from the posting"}{r.roles > 1 && <span className="wb-n">+{r.roles - 1}</span>}<span className="sub">{[r.ats ? titleCase(r.ats) : null, r.locations[0]].filter(Boolean).join(" · ") || " "}</span></>;
    case "applied": return shortDate(r.appliedAt);
    case "pipeline": return r.pipeline ? titleCase(r.pipeline) : "—";
    case "resume": return r.resume === "saved" ? (r.tailored === false ? "Base, saved" : "Saved") : r.resume === "wanted" ? "Getting…" : r.tailored ? "Tailored" : r.tailored === false ? "Base" : "—";
    case "people": return r.found ? `${r.picked} of ${r.found}` : "—";
    case "outreach": {
      const s = STAGE[r.stage];
      const sub = r.stage === "replied" || r.followupDue ? (r.followupDue ? "Follow-up due" : "") : r.detail ?? "";
      return <><span className={`wb-pill tone-${s.tone}`}>{s.label}</span><span className="sub">{sub || " "}</span></>;
    }
    case "location": return r.locations.join(", ") || "—";
    case "ats": return r.ats ? titleCase(r.ats) : "—";
    case "skills": return r.skills.join(", ") || "—";
    case "size": return r.employees != null ? fmt(r.employees) : "—";
    case "industry": return r.industry ?? "—";
    case "salary": return r.salaryMin != null || r.salaryMax != null ? [money(r.salaryMin), money(r.salaryMax)].filter(Boolean).join("–") : "—";
    case "tsenta": return TABS.find(([t]) => t === r.bucket)?.[1] ?? r.bucket;
  }
}

const ROW_H = 54;

function readLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeLocal(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private window */ }
}

// ── page ────────────────────────────────────────────────────────────────────

export default function AppliedBoard() {
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [writer, setWriter] = useState("");
  const [queueHidden, setQueueHidden] = useState<string | null>(null); // finishedAt of a batch you closed
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("submitted");
  const [q, setQ] = useState("");
  const [jdIds, setJdIds] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [words, setWords] = useState<string[]>([]);
  const [minSalary, setMinSalary] = useState(0);
  // "Applied since" (YYYY-MM-DD, local day). Remembered here; /applied?since=2026-10-25 sets it.
  const [since, setSinceState] = useState("");
  const setSince = (v: string) => { setSinceState(v); writeLocal(SINCE_KEY, v); };
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "applied", dir: -1 });
  const [group, setGroup] = useState(false);
  const [cols, setCols] = useState<ColKey[]>(DEFAULT_COLS);
  const [sel, setSel] = useState<Set<string>>(new Set());

  const [panel, setPanel] = useState<"filters" | "columns" | null>(null);
  const [starting, setStarting] = useState<{ dryRunOnly: boolean } | null>(null);
  const [drawer, setDrawer] = useState<Row | null>(null);

  // Escape closes whichever panel or dialog is open (the drawer handles its own).
  useEffect(() => {
    if (!panel && !starting) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setPanel(null); setStarting(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, starting]);

  useEffect(() => {
    setCols(readLocal<ColKey[]>(COLS_KEY, DEFAULT_COLS).filter((k) => COLS.some((c) => c.key === k)));
    setGroup(readLocal<boolean>(GROUP_KEY, false));
    const fromUrl = new URLSearchParams(window.location.search).get("since");
    if (fromUrl && /^\d{4}-\d{2}-\d{2}$/.test(fromUrl)) { setSinceState(fromUrl); writeLocal(SINCE_KEY, fromUrl); }
    else setSinceState(readLocal<string>(SINCE_KEY, ""));
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/applied/board").then((x) => x.json());
      if (r.error) throw new Error(r.error);
      setRows(r.rows ?? []);
      setMeta(r.meta ?? null);
      setQueue(r.queue ?? null);
      setWriter(r.writer ?? "");
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? "Couldn’t load the board. Is the server running?");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // /applied?open=<id> (the review queue's "Details") opens that row's drawer.
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("open");
    if (id) { setOpenId(id); window.history.replaceState(null, "", window.location.pathname); }
  }, []);
  useEffect(() => {
    if (!openId || !rows.length) return;
    const r = rows.find((x) => x.id === openId);
    if (r) setDrawer({ ...r, roles: 1, ids: [r.id] });
    setOpenId(null);
  }, [openId, rows]);

  // While the queue runs, follow it; reload the rows whenever another one finishes.
  const doneRef = useRef(-1);
  useEffect(() => {
    if (!queue || (queue.running === 0 && queue.waiting === 0)) return;
    const t = setInterval(async () => {
      try {
        const v = (await fetch("/api/applied/queue").then((x) => x.json())) as QueueView;
        setQueue(v);
        if (v.done !== doneRef.current || (v.running === 0 && v.waiting === 0)) {
          doneRef.current = v.done;
          void load();
        }
      } catch { /* next tick */ }
    }, 3000);
    return () => clearInterval(t);
  }, [queue, load]);

  // Posting text is searched on the server; the rest of the row here.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 3) { setJdIds(new Set()); return; }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/applied/search?q=${encodeURIComponent(term)}`).then((x) => x.json());
        setJdIds(new Set(r.ids ?? []));
      } catch { setJdIds(new Set()); }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const now = useMemo(() => Date.now(), [rows]);
  const visibleRows = useMemo(() => rows.filter((r) => !r.dupOf), [rows]);
  const dupes = rows.length - visibleRows.length;

  const passes = useCallback((r: BoardRow, except?: Facet) => {
    if (tab !== "all" && r.bucket !== tab) return false;
    const term = q.trim().toLowerCase();
    if (term) {
      const hay = [r.company, r.tsentaCompany, r.role ?? "", r.ats ?? "", ...r.skills, ...r.locations, r.industry ?? ""].join(" ").toLowerCase();
      if (!term.split(/\s+/).every((w) => hay.includes(w)) && !jdIds.has(r.id)) return false;
    }
    if (words.length && !words.some((w) => (r.role ?? "").toLowerCase().includes(w))) return false;
    if (minSalary > 0 && (r.salaryMax ?? r.salaryMin ?? -1) < minSalary * 1000) return false;
    if (since && Date.parse(r.appliedAt) < new Date(`${since}T00:00:00`).getTime()) return false;
    for (const f of FACETS) {
      if (f.key === except) continue;
      const want = filters[f.key];
      if (!want.length) continue;
      const have = valuesOf(r, f.key, now);
      if (!want.some((w) => have.includes(w))) return false;
    }
    return true;
  }, [tab, q, jdIds, words, minSalary, since, filters, now]);

  // Tab counts follow the date window, so they match what's listed.
  const tabCounts = useMemo(() => {
    const from = since ? new Date(`${since}T00:00:00`).getTime() : 0;
    const inWindow = visibleRows.filter((r) => Date.parse(r.appliedAt) >= from);
    const c: Record<string, number> = { all: inWindow.length };
    for (const r of inWindow) c[r.bucket] = (c[r.bucket] ?? 0) + 1;
    return c;
  }, [visibleRows, since]);

  const shown = useMemo(() => {
    const list = visibleRows.filter((r) => passes(r));
    let out: Row[];
    if (group) {
      const by = new Map<string, BoardRow[]>();
      for (const r of list) by.set(r.groupKey, [...(by.get(r.groupKey) ?? []), r]);
      out = [...by.values()].map((g) => {
        // One outreach per company: the newest application speaks for the group,
        // unless an older one is already further along.
        const sorted = [...g].sort((a, b) => Date.parse(b.appliedAt) - Date.parse(a.appliedAt));
        const lead = sorted.find((r) => !STARTABLE.has(r.stage) && r.stage !== "not_startable") ?? sorted[0];
        return { ...lead, roles: g.length, ids: sorted.map((r) => r.id) };
      });
    } else {
      out = list.map((r) => ({ ...r, roles: 1, ids: [r.id] }));
    }
    const { key, dir } = sort;
    return out.sort((a, b) => {
      const x = sortValue(a, key), y = sortValue(b, key);
      return (x < y ? -1 : x > y ? 1 : 0) * dir || Date.parse(b.appliedAt) - Date.parse(a.appliedAt);
    });
  }, [visibleRows, passes, group, sort]);

  const stageCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of visibleRows) if (passes(r, "outreach")) c.set(STAGE[r.stage].group, (c.get(STAGE[r.stage].group) ?? 0) + 1);
    return STAGE_GROUPS.filter((g) => c.get(g)).map((g) => ({ group: g, n: c.get(g)! }));
  }, [visibleRows, passes]);

  // ── selection
  const selectable = (r: Row) => r.bucket === "submitted" && STARTABLE.has(r.stage);
  const selectedRows = shown.filter((r) => sel.has(r.id));
  const companies = new Set(selectedRows.map((r) => r.groupKey)).size;
  const contactedBefore = new Set(selectedRows.filter((r) => r.contacted).map((r) => r.groupKey)).size;
  const toggle = (r: Row) => setSel((s) => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; });
  const startableShown = shown.filter(selectable);
  const allOn = startableShown.length > 0 && startableShown.every((r) => sel.has(r.id));
  const toggleAll = () => setSel(allOn ? new Set() : new Set(startableShown.map((r) => r.id)));

  useEffect(() => {
    // Rows that started (or left the view) drop out of the selection.
    setSel((s) => {
      const ok = new Set(rows.filter((r) => STARTABLE.has(r.stage)).map((r) => r.id));
      const n = new Set([...s].filter((id) => ok.has(id)));
      return n.size === s.size ? s : n;
    });
  }, [rows]);

  // ── table window
  const boxRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, h: 800 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const on = () => setScroll({ top: el.scrollTop, h: el.clientHeight });
    on();
    el.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => { el.removeEventListener("scroll", on); window.removeEventListener("resize", on); };
  }, [loading]);
  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - 10);
  const last = Math.min(shown.length, Math.ceil((scroll.top + scroll.h) / ROW_H) + 10);
  const colDefs = cols.map((k) => COLS.find((c) => c.key === k)!).filter(Boolean);
  const template = `40px ${colDefs.map((c) => c.width).join(" ")}`;

  const setSortKey = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "applied" ? -1 : 1 }));

  const activeChips = FACETS.flatMap((f) => filters[f.key].map((v) => ({ f: f.key, v, label: `${f.name}: ${v}` })));
  // A chip's count: rows with that value, given every other filter.
  const chipCount = (f: Facet, v: string) => visibleRows.filter((r) => passes(r, f) && valuesOf(r, f, now).includes(v)).length;
  const nFilters = activeChips.length + (words.length ? 1 : 0) + (minSalary ? 1 : 0) + (since ? 1 : 0);
  const clearFilters = () => { setFilters(NO_FILTERS); setWords([]); setMinSalary(0); setSince(""); };

  const requestSync = async () => {
    try {
      const r = await fetch("/api/applied/sync", { method: "POST" }).then((x) => x.json());
      setMeta(r.meta);
    } catch { setErr("Couldn’t record the sync request."); }
  };

  const queueAction = async (action: "pause" | "resume" | "cancel") => {
    const v = await fetch("/api/applied/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).then((x) => x.json());
    setQueue(v);
    void load();
  };

  const queueOpen = !!queue && queue.total > 0 && !(queue.finishedAt && queue.finishedAt === queueHidden);

  return (
    <div className="workspace-inner wide wb-page">
      <header className="wb-head">
        <div className="grow">
          <h1>Applied</h1>
          <p>Every job Tsenta applied to. Filter, select, and Start runs each one up to written emails.</p>
        </div>
        <div className="wb-sync">
          <span>{meta?.lastSyncAt ? `Last synced ${shortDate(meta.lastSyncAt)}, ${new Date(meta.lastSyncAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "Never synced"} · {fmt(rows.length)} here{meta?.tsentaTotal ? ` of ${fmt(meta.tsentaTotal)} in Tsenta` : ""}</span>
          {meta?.syncRequestedAt && <span className="warn">Sync requested · ask Claude to “sync tsenta”</span>}
        </div>
        <button type="button" className="wb-btn" onClick={() => void requestSync()}>Sync Tsenta</button>
      </header>

      {err && <div className="wb-err">{err}</div>}

      <div className="wb-tabs" role="tablist" aria-label="Tsenta status">
        {TABS.map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`wb-tab${tab === t ? " on" : ""}`} onClick={() => { setTab(t); setSel(new Set()); }}>
            {label}<span className="wb-n">{fmt(tabCounts[t] ?? 0)}</span>
          </button>
        ))}
      </div>

      <div className="wb-bar">
        <label className="wb-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company, role, skill, posting text" aria-label="Search" />
        </label>
        {activeChips.map((c) => (
          <button key={c.f + c.v} type="button" className="wb-chip on" onClick={() => setFilters((f) => ({ ...f, [c.f]: f[c.f].filter((x) => x !== c.v) }))} aria-label={`Remove ${c.label}`}>
            {c.label} <span className="wb-n" style={{ color: "inherit", margin: 0, opacity: .8 }}>{fmt(chipCount(c.f, c.v))}</span> ×
          </button>
        ))}
        {words.length > 0 && <button type="button" className="wb-chip on" onClick={() => setWords([])}>Role: {words.join(", ")} ×</button>}
        {minSalary > 0 && <button type="button" className="wb-chip on" onClick={() => setMinSalary(0)}>Salary ${minSalary}k+ ×</button>}
        {since && <button type="button" className="wb-chip on" onClick={() => setSince("")} aria-label={`Remove applied since ${longDate(since)}`}>Applied since {longDate(since)} ×</button>}
        {QUICK.filter((f) => !filters[f].length).map((f) => (
          <button key={f} type="button" className="wb-chip" onClick={() => setPanel("filters")}>{FACETS.find((x) => x.key === f)!.name} ▾</button>
        ))}
        <button type="button" className="wb-chip add" onClick={() => setPanel("filters")}>+ More filters</button>
        {nFilters > 0 && <button type="button" className="wb-link" onClick={clearFilters}>Clear</button>}
        <span className="end">
          <label><input type="checkbox" checked={group} onChange={(e) => { setGroup(e.target.checked); writeLocal(GROUP_KEY, e.target.checked); setSel(new Set()); }} /> Group by company</label>
          <button type="button" className="wb-btn sm" onClick={() => setPanel("columns")}>Columns</button>
        </span>
      </div>

      {stageCounts.length > 0 && (
        <div className="wb-strip" aria-label="Outreach status">
          {stageCounts.map(({ group: g, n }) => {
            const on = filters.outreach.includes(g);
            const tone = Object.values(STAGE).find((s) => s.group === g)?.tone ?? "none";
            return (
              <button key={g} type="button" className={`tone-${tone}${on ? " on" : ""}`} aria-pressed={on}
                onClick={() => setFilters((f) => ({ ...f, outreach: on ? f.outreach.filter((x) => x !== g) : [...f.outreach, g] }))}>
                {g} <b>{fmt(n)}</b>
              </button>
            );
          })}
        </div>
      )}

      {queueOpen && queue && (
        <section className="wb-queue" aria-label="Start queue">
          <div className="wb-queue-h">
            <b>{queue.running + queue.waiting > 0 ? `Starting · ${queue.done} of ${queue.total} done` : `Last batch · ${queue.done} of ${queue.total} done`}</b>
            <span className="meta">{queue.paused ? "Paused" : queue.running ? `${queue.running} running, 3 at a time · keeps going if you close this tab` : ""}</span>
            {queue.running + queue.waiting > 0 && (queue.paused
              ? <button type="button" className="wb-btn sm" onClick={() => void queueAction("resume")}>Resume</button>
              : <button type="button" className="wb-btn sm" onClick={() => void queueAction("pause")}>Pause</button>)}
            {queue.waiting > 0 && <button type="button" className="wb-btn sm danger" onClick={() => void queueAction("cancel")}>Cancel the rest</button>}
            {queue.finishedAt && <button type="button" className="wb-btn sm" onClick={() => setQueueHidden(queue.finishedAt)}>Close</button>}
          </div>
          <div className="wb-prog" role="progressbar" aria-valuemin={0} aria-valuemax={queue.total} aria-valuenow={queue.done} aria-label="Queue progress">
            <div style={{ width: `${queue.total ? (100 * queue.done) / queue.total : 0}%` }} />
          </div>
          <ol>
            {queue.items.map((it) => {
              const s = STAGE[it.stage];
              const label = it.state === "waiting" ? "Waiting" : it.state === "running" && (it.stage === "queued" || it.stage === "not_started" || it.stage === "in_applications") ? "Starting" : s.label;
              const tone = it.state === "waiting" ? "none" : s.tone;
              return (
                <li key={it.id}>
                  <span style={{ minWidth: 0 }}><b>{it.company}</b>{it.detail && <span className="meta" style={{ display: "block", fontSize: 12 }}>{it.detail}</span>}</span>
                  <span className={`wb-pill tone-${tone}`} style={{ alignSelf: "flex-start" }}>{label}</span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {sel.size > 0 && (
        <div className="wb-bulk">
          <b><span className="tnum">{fmt(sel.size)}</span> selected</b>
          <span className="sub">{fmt(companies)} {companies === 1 ? "company" : "companies"}{contactedBefore ? ` · ${contactedBefore} emailed before (anyone already emailed is skipped)` : ""}</span>
          <span className="wb-cost free">0 Apollo credits</span>
          <span className="wb-cost claude" title={writer ? `Written on ${writer}` : undefined}>up to {fmt(2 * companies)} email-writing calls</span>
          <span className="end">
            <button type="button" className="wb-btn" onClick={() => setSel(new Set())}>Clear</button>
            <button type="button" className="wb-btn" onClick={() => setStarting({ dryRunOnly: true })}>Dry run</button>
            <button type="button" className="wb-btn primary" onClick={() => setStarting({ dryRunOnly: false })}>Start outreach for {fmt(sel.size)}</button>
          </span>
        </div>
      )}

      <div className="wb-table" ref={boxRef}>
        <div className="wb-grid" role="table" aria-rowcount={shown.length} style={{ minWidth: colDefs.length > 7 ? 1200 : 960 }}>
          <div className="wb-row head" role="row" style={{ gridTemplateColumns: template }}>
            <span className="wb-cell" role="columnheader">
              <input type="checkbox" checked={allOn} onChange={toggleAll} disabled={!startableShown.length} aria-label={`Select all ${startableShown.length} that can start`} />
            </span>
            {colDefs.map((c) => (
              <span key={c.key} className="wb-cell" role="columnheader" aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                <button type="button" className={sort.key === c.key ? "on" : ""} onClick={() => setSortKey(c.key)}>
                  {c.label}{sort.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                </button>
              </span>
            ))}
          </div>
          {loading && <div className="wb-empty">Loading…</div>}
          {!loading && rows.length === 0 && (
            <div className="wb-empty"><b>No applications yet.</b><span>Ask Claude to “sync tsenta” and every job Tsenta applied to lands here.</span></div>
          )}
          {!loading && rows.length > 0 && shown.length === 0 && (
            <div className="wb-empty"><b>Nothing matches.</b><button type="button" className="wb-link" onClick={() => { clearFilters(); setQ(""); setTab("all"); }}>Clear filters and search</button></div>
          )}
          <div style={{ height: first * ROW_H }} />
          {shown.slice(first, last).map((r) => (
            <div key={r.id} role="row" className={`wb-row${sel.has(r.id) ? " sel" : ""}`} style={{ gridTemplateColumns: template }} onClick={() => setDrawer(r)}>
              <span className="wb-cell" role="cell" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={sel.has(r.id)} disabled={!selectable(r)} onChange={() => toggle(r)} aria-label={`Select ${r.company}`} />
              </span>
              {colDefs.map((c) => (
                <span key={c.key} role="cell" className={`wb-cell${c.key === "applied" || c.key === "people" || c.key === "size" ? " num" : ""}`}>{cell(r, c.key)}</span>
              ))}
            </div>
          ))}
          <div style={{ height: Math.max(0, shown.length - last) * ROW_H }} />
        </div>
      </div>

      <div className="wb-foot">
        <span>{fmt(shown.length)} {group ? "companies" : "rows"}{dupes > 0 ? ` · ${dupes} applications Tsenta made twice are shown once` : ""}</span>
        <span>Start spends no Apollo credits. Credits are spent only when you create drafts.</span>
      </div>

      {panel === "filters" && (
        <FiltersPanel
          rows={visibleRows} passes={passes} now={now} filters={filters} setFilters={setFilters}
          words={words} setWords={setWords} minSalary={minSalary} setMinSalary={setMinSalary} since={since} setSince={setSince}
          matchCount={visibleRows.filter((r) => passes(r)).length} total={visibleRows.length}
          onClose={() => setPanel(null)} onClear={clearFilters} dupes={dupes}
          onCancel={(snap) => { setFilters(snap.filters); setWords(snap.words); setMinSalary(snap.minSalary); setSince(snap.since); setPanel(null); }}
        />
      )}
      {panel === "columns" && (
        <ColumnsPanel cols={cols} setCols={(c) => { setCols(c); writeLocal(COLS_KEY, c); }} onClose={() => setPanel(null)} />
      )}
      {starting && (
        <StartDialog
          ids={[...sel]}
          dryRunOnly={starting.dryRunOnly}
          onClose={() => setStarting(null)}
          onStarted={() => { setStarting(null); setSel(new Set()); doneRef.current = -1; void load(); }}
        />
      )}
      {drawer && <Drawer row={drawer} siblings={rows.filter((x) => drawer.ids.includes(x.id))} onClose={() => setDrawer(null)} onChanged={() => void load()} />}
    </div>
  );
}

// ── filters panel ───────────────────────────────────────────────────────────

function FiltersPanel(p: {
  rows: BoardRow[];
  passes: (r: BoardRow, except?: Facet) => boolean;
  now: number;
  filters: Filters;
  setFilters: (f: Filters | ((f: Filters) => Filters)) => void;
  words: string[];
  setWords: (w: string[]) => void;
  minSalary: number;
  since: string;
  setSince: (v: string) => void;
  setMinSalary: (n: number) => void;
  matchCount: number;
  total: number;
  dupes: number;
  onClose: () => void;
  onClear: () => void;
  onCancel: (snap: { filters: Filters; words: string[]; minSalary: number; since: string }) => void;
}) {
  const [more, setMore] = useState<Set<Facet>>(new Set());
  const [snap] = useState(() => ({ filters: p.filters, words: p.words, minSalary: p.minSalary, since: p.since }));
  const [word, setWord] = useState("");

  // Each option's count is what the board would show with it ticked, given the
  // other filters: rows passing every facet but this one, tallied by value.
  const counts = useMemo(() => {
    const out = new Map<Facet, Map<string, number>>();
    for (const f of FACETS) {
      const m = new Map<string, number>();
      for (const r of p.rows) {
        if (!p.passes(r, f.key)) continue;
        for (const v of new Set(valuesOf(r, f.key, p.now))) m.set(v, (m.get(v) ?? 0) + 1);
      }
      out.set(f.key, m);
    }
    return out;
  }, [p.rows, p.passes, p.now]);

  const options = (f: Facet): [string, number][] => {
    const m = counts.get(f) ?? new Map<string, number>();
    const fixed = f === "applied" ? AGES.map(([l]) => l) : f === "size" ? SIZES : f === "outreach" ? STAGE_GROUPS : null;
    const list: [string, number][] = fixed
      ? fixed.map((v) => [v, m.get(v) ?? 0])
      : [...m.entries()].sort((a, b) => b[1] - a[1]);
    for (const v of p.filters[f]) if (!list.some(([x]) => x === v)) list.push([v, 0]);
    return list;
  };

  const flip = (f: Facet, v: string) =>
    p.setFilters((cur) => ({ ...cur, [f]: cur[f].includes(v) ? cur[f].filter((x) => x !== v) : [...cur[f], v] }));

  const salaryKnown = p.rows.filter((r) => r.salaryMin != null || r.salaryMax != null).length;

  return (
    <div className="wb-scrim" onClick={p.onClose}>
      <section className="wb-panel" role="dialog" aria-label="Filters" onClick={(e) => e.stopPropagation()}>
        <div className="wb-panel-h">
          <h2>Filters</h2>
          <span className="meta"><b className="tnum">{fmt(p.matchCount)}</b> of {fmt(p.total)} match</span>
          <button type="button" className="wb-link" onClick={p.onClear}>Clear all</button>
        </div>
        <div className="wb-facets">
          {FACETS.map((f) => {
            const list = options(f.key);
            const cap = more.has(f.key) || !f.many ? list.length : 6;
            if (!list.length) return null;
            return (
              <fieldset key={f.key} className="wb-facet">
                <legend>{f.name}</legend>
                {f.hint && <span className="hint">{f.hint}</span>}
                {list.slice(0, cap).map(([v, n]) => (
                  <label key={v} className={`wb-opt${n === 0 && !p.filters[f.key].includes(v) ? " zero" : ""}`}>
                    <input type="checkbox" checked={p.filters[f.key].includes(v)} onChange={() => flip(f.key, v)} />
                    <span>{v}</span>
                    <span className="wb-n">{fmt(n)}</span>
                  </label>
                ))}
                {list.length > cap && <button type="button" className="wb-link" style={{ alignSelf: "flex-start", fontSize: 13 }} onClick={() => setMore((s) => new Set(s).add(f.key))}>{list.length - cap} more…</button>}
              </fieldset>
            );
          })}
        </div>
        <div className="wb-inputs">
          <label>
            <span className="wb-cap">Role keywords</span>
            <span className="wb-words">
              {p.words.map((w) => <button key={w} type="button" className="wb-word" onClick={() => p.setWords(p.words.filter((x) => x !== w))} aria-label={`Remove ${w}`}>{w} ×</button>)}
              <input value={word} onChange={(e) => setWord(e.target.value)} placeholder="Add a word, press Enter"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && word.trim()) {
                    e.preventDefault();
                    const w = word.trim().toLowerCase();
                    if (!p.words.includes(w)) p.setWords([...p.words, w]);
                    setWord("");
                  }
                }} />
            </span>
          </label>
          <label>
            <span className="wb-cap">Minimum salary · known for {fmt(salaryKnown)} rows</span>
            <input type="range" min={0} max={300} step={10} value={p.minSalary} onChange={(e) => p.setMinSalary(Number(e.target.value))} style={{ accentColor: "var(--accent)" }} />
            <span className="meta">{p.minSalary ? `$${p.minSalary}k and up (rows without a salary are hidden)` : "Any"}</span>
          </label>
          <label>
            <span className="wb-cap">Applied since</span>
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="date" value={p.since} onChange={(e) => p.setSince(e.target.value)} style={{ maxWidth: 180, padding: "7px 10px" }} />
              {p.since && <button type="button" className="wb-link" onClick={() => p.setSince("")}>Any date</button>}
            </span>
            <span className="meta">Remembered on this computer.</span>
          </label>
        </div>
        <div className="wb-panel-f">
          <span className="grow">{p.dupes > 0 ? `${p.dupes} applications Tsenta made twice are shown once.` : "Each count is what you'd see with that box ticked."}</span>
          <button type="button" className="wb-btn" onClick={() => p.onCancel(snap)}>Cancel</button>
          <button type="button" className="wb-btn primary" onClick={p.onClose}>Show {fmt(p.matchCount)} rows</button>
        </div>
      </section>
    </div>
  );
}

// ── columns panel ───────────────────────────────────────────────────────────

function ColumnsPanel({ cols, setCols, onClose }: { cols: ColKey[]; setCols: (c: ColKey[]) => void; onClose: () => void }) {
  // Shown columns first in their order, then the hidden ones.
  const order = [...cols, ...COLS.map((c) => c.key).filter((k) => !cols.includes(k))];
  const move = (k: ColKey, d: -1 | 1) => {
    const i = cols.indexOf(k);
    const j = i + d;
    if (i < 0 || j < 0 || j >= cols.length) return;
    const n = [...cols];
    [n[i], n[j]] = [n[j], n[i]];
    setCols(n);
  };
  return (
    <div className="wb-scrim" onClick={onClose}>
      <section className="wb-panel narrow" role="dialog" aria-label="Columns" style={{ width: "min(420px, 100%)" }} onClick={(e) => e.stopPropagation()}>
        <div className="wb-panel-h"><h2>Columns</h2><button type="button" className="wb-link" onClick={() => setCols(DEFAULT_COLS)}>Reset</button></div>
        <div className="wb-cols">
          {order.map((k) => {
            const c = COLS.find((x) => x.key === k)!;
            const on = cols.includes(k);
            return (
              <label key={k}>
                <input type="checkbox" checked={on} disabled={k === "company"} onChange={() => setCols(on ? cols.filter((x) => x !== k) : [...cols, k])} />
                <span>{c.label}</span>
                <span className="src">{c.from}</span>
                {on && <>
                  <button type="button" className="mv" onClick={(e) => { e.preventDefault(); move(k, -1); }} aria-label={`Move ${c.label} left`}>↑</button>
                  <button type="button" className="mv" onClick={(e) => { e.preventDefault(); move(k, 1); }} aria-label={`Move ${c.label} right`}>↓</button>
                </>}
              </label>
            );
          })}
        </div>
        <div className="wb-panel-f"><span className="grow">Remembered on this computer.</span><button type="button" className="wb-btn primary" onClick={onClose}>Done</button></div>
      </section>
    </div>
  );
}
