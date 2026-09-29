"use client";

// /harvest — decide where Apollo credits go, before spending any.
//
// The page is built around one split: SEARCH IS FREE, REVEAL COSTS A CREDIT.
// Scanning a company asks Apollo who works there, subtracts everyone already in
// the contact store (person by person, not company by company), and reports the
// exact number of credits harvesting the remainder would cost. Nothing is
// charged until "Harvest selected", and Dry run rehearses even that.
//
// The real task here is allocation — ~140 companies against a fixed budget — so
// the sweep runs in batches you can watch and stop, the cap is editable inline,
// and "Fill to budget" walks the ranking so you don't have to click 33 rows.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../_components/AppShell";
import { useCredits } from "../_components/credits";

type Group = "founders" | "engineering" | "recruiters" | "other";

interface GroupCount { found: number; held: number; new: number; reachable: number }
interface Candidate { id: string; firstName: string; lastName: string | null; title: string; group: Group }

interface ScanRow {
  name: string; domain: string; tier: string; logoUrl: string | null; employees: number | null;
  scannedAt: string; found: number; held: number; heldOfFound: number; newReachable: number;
  cap: number; credits: number; groups: Record<Group, GroupCount>; candidates: Candidate[];
  harvested: number; error: string | null;
}

interface Row {
  name: string; domain: string; tier: string;
  score: number; outreach: number; onFile: number; scan: ScanRow | null;
}

interface Store { total: number; withEmail: number; contacted: number; companies: number }

const GROUP_LABEL: Record<Group, string> = {
  founders: "Founders / C-level",
  engineering: "Engineering leaders",
  recruiters: "Recruiters / Talent",
  other: "Other",
};
const MIX: Group[] = ["founders", "engineering", "recruiters", "other"];

const AI_TIERS = new Set(["AI lab", "AI startup", "Data/AI"]);
type TierFilter = "all" | "ai" | "Big tech" | "Fintech" | "Infra" | "Product";
type StatusFilter = "any" | "new" | "unscanned";
type SortKey = "rank" | "credits" | "new" | "onFile" | "name";

const BATCH = 6; // companies per scan request — small enough to show progress
const WELL_COVERED = 100;

const n = (v: number) => v.toLocaleString();
const initials = (s: string) =>
  s.replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

export default function HarvestPage() {
  const { balance } = useCredits();
  const [rows, setRows] = useState<Row[]>([]);
  const [store, setStore] = useState<Store | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState<Set<string>>(new Set());
  const [sweep, setSweep] = useState<{ done: number; total: number } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [caps, setCaps] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [tier, setTier] = useState<TierFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("any");
  const [sort, setSort] = useState<SortKey>("rank");
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const stopSweep = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/harvest/targets").then((x) => x.json());
      setRows(r.rows ?? []);
      setStore(r.store ?? null);
    } catch {
      setErr("Couldn't load the target list.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Credits for a row, honouring a cap the user has edited on this page. The
  // server stores its own cap, but editing shouldn't need a round trip — the
  // candidate list is already here, so the arithmetic is local.
  const capOf = useCallback((r: Row) => caps[r.domain] ?? r.scan?.cap ?? 60, [caps]);
  const creditsOf = useCallback(
    (r: Row) => (r.scan ? Math.min(r.scan.newReachable, capOf(r)) : 0),
    [capOf],
  );

  // FREE. Batched so a 140-company sweep reports progress and can be stopped
  // partway — the results of every completed batch are already saved server-side.
  const scan = useCallback(async (domains: string[]) => {
    if (!domains.length) return;
    setErr(null);
    stopSweep.current = false;
    if (domains.length > BATCH) setSweep({ done: 0, total: domains.length });

    for (let i = 0; i < domains.length; i += BATCH) {
      if (stopSweep.current) break;
      const chunk = domains.slice(i, i + BATCH);
      setScanning((s) => new Set([...s, ...chunk]));
      try {
        const r = await fetch("/api/harvest/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domains: chunk }),
        }).then((x) => x.json());
        if (r.error) { setErr(r.error); break; }
        const byDomain = new Map<string, ScanRow>((r.rows ?? []).map((s: ScanRow) => [s.domain, s]));
        setRows((prev) => prev.map((row) => (byDomain.has(row.domain) ? { ...row, scan: byDomain.get(row.domain)! } : row)));
      } catch {
        setErr("Scan failed — is the dev server still running?");
        break;
      } finally {
        setScanning((s) => { const next = new Set(s); chunk.forEach((d) => next.delete(d)); return next; });
        setSweep((p) => (p ? { ...p, done: Math.min(p.total, p.done + chunk.length) } : p));
      }
    }
    setSweep(null);
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (needle && !`${r.name} ${r.domain} ${r.tier}`.toLowerCase().includes(needle)) return false;
      if (tier === "ai" ? !AI_TIERS.has(r.tier) : tier !== "all" && r.tier !== tier) return false;
      if (status === "new" && !(r.scan && creditsOf(r) > 0)) return false;
      if (status === "unscanned" && r.scan) return false;
      return true;
    });
    if (sort === "rank") return out; // server order is the ranking
    const cmp: Record<Exclude<SortKey, "rank">, (a: Row, b: Row) => number> = {
      credits: (a, b) => creditsOf(b) - creditsOf(a),
      new: (a, b) => (b.scan?.newReachable ?? -1) - (a.scan?.newReachable ?? -1),
      onFile: (a, b) => b.onFile - a.onFile,
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return [...out].sort(cmp[sort]);
  }, [rows, q, tier, status, sort, creditsOf]);

  const totals = useMemo(() => {
    let scanned = 0, foundNew = 0, selCredits = 0, selCount = 0;
    const mix: Record<Group, number> = { founders: 0, engineering: 0, recruiters: 0, other: 0 };
    for (const r of rows) {
      if (r.scan) { scanned++; foundNew += creditsOf(r); }
      if (picked.has(r.domain) && r.scan) {
        selCredits += creditsOf(r);
        selCount++;
        // What the selection actually buys, by role — quantity isn't quality.
        const take = creditsOf(r);
        let left = take;
        for (const g of MIX) {
          const inGroup = r.scan.candidates.filter((c) => c.group === g).length;
          const t = Math.min(inGroup, left);
          mix[g] += t;
          left -= t;
          if (left <= 0) break;
        }
      }
    }
    return { scanned, foundNew, selCredits, selCount, mix };
  }, [rows, picked, creditsOf]);

  const budget = balance ?? 2000;
  const overBudget = totals.selCredits > budget;

  const toggle = (domain: string) =>
    setPicked((p) => { const next = new Set(p); next.has(domain) ? next.delete(domain) : next.add(domain); return next; });

  // Walk the ranking and take companies while the budget lasts. This is the
  // decision the page exists for, so it shouldn't cost 33 clicks.
  const fillToBudget = useCallback(() => {
    const next = new Set<string>();
    let spent = 0;
    for (const r of filtered) {
      const c = creditsOf(r);
      if (!r.scan || c === 0) continue;
      if (spent + c > budget) continue; // skip, don't stop — a cheap row may still fit
      next.add(r.domain);
      spent += c;
    }
    setPicked(next);
  }, [filtered, creditsOf, budget]);

  const run = useCallback(async (dryRun: boolean) => {
    const domains = [...picked].filter((d) => rows.find((r) => r.domain === d)?.scan);
    if (!domains.length) { setErr("Select at least one scanned company."); return; }
    if (!dryRun) {
      const msg = `Spend up to ${n(Math.min(totals.selCredits, budget))} Apollo credits across ${domains.length} companies?\n\nThis is irreversible.`;
      if (!window.confirm(msg)) return;
    }
    setBusy(dryRun ? "dry" : "run");
    setErr(null);
    setReport(null);
    try {
      const r = await fetch("/api/harvest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains, budget, dryRun, caps }),
      }).then((x) => x.json());
      if (r.error) { setErr(r.error); return; }
      const t = r.totals;
      setReport(
        dryRun
          ? `Dry run — would spend ${n(t.attempted)} credits across ${domains.length} companies.` +
            (t.alreadyHarvested ? ` ${n(t.alreadyHarvested)} already bought in an earlier run, skipped.` : "") +
            (t.beyondCap ? ` ${n(t.beyondCap)} more are available but sit beyond the cap.` : "") +
            " Nothing charged."
          : `Harvested ${n(t.revealed)} emails from ${n(t.attempted)} people · ${n(t.spent)} credits spent · ${n(t.remaining)} of your budget left.`,
      );
      if (!dryRun) { await load(); setPicked(new Set()); }
    } catch {
      setErr("The run failed to complete.");
    } finally {
      setBusy(null);
    }
  }, [picked, rows, totals.selCredits, budget, caps, load]);

  const unscanned = filtered.filter((r) => !r.scan).map((r) => r.domain);
  const selPct = Math.min(100, (totals.selCredits / Math.max(1, budget)) * 100);
  const restPct = Math.min(100 - selPct, (Math.max(0, totals.foundNew - totals.selCredits) / Math.max(1, budget)) * 100);

  const sortBtn = (key: SortKey, label: string, cls = "") => (
    <th className={cls}>
      <button type="button" className={`hv-sortbtn${sort === key ? " on" : ""}`} onClick={() => setSort(key)}>
        {label}{sort === key && <span className="hv-caret">▾</span>}
      </button>
    </th>
  );

  return (
    <div className="workspace-inner wide">
      <PageHeader
        title="Harvest"
        subtitle="Search is free. Nothing is charged until you press Harvest — and never for someone you already have."
      />

      <div className="card hv-budget">
        <div className="hv-budget-head">
          <span className="hv-budget-t">Credit budget</span>
          <span className="hv-budget-n">
            <b className={overBudget ? "over" : ""}>{n(totals.selCredits)}</b> selected ·{" "}
            <b>{n(totals.foundNew)}</b> found across {n(totals.scanned)} scanned ·{" "}
            <b>{balance === null ? "—" : n(balance)}</b> available
          </span>
        </div>
        <div className="hv-bar">
          <i className="sel" style={{ width: `${selPct}%` }} />
          <i className="rest" style={{ width: `${restPct}%` }} />
        </div>
        <div className="hv-key">
          <span><i className="sw sel" /> selected to harvest</span>
          <span><i className="sw rest" /> found but not selected</span>
          <span><i className="sw none" /> unallocated</span>
          {overBudget && <span className="hv-over">selection exceeds your balance</span>}
        </div>
      </div>

      <div className="cmp-stats">
        <div className="cmp-stat"><div className="k">Companies</div><div className="v tnum">{n(rows.length)}</div></div>
        <div className="cmp-stat"><div className="k">Scanned</div><div className="v tnum">{n(totals.scanned)}<small className="hv-of">/{n(rows.length)}</small></div></div>
        <div className="cmp-stat ok"><div className="k">Already on file</div><div className="v tnum">{store ? n(store.total) : "—"}</div></div>
        <div className="cmp-stat accent"><div className="k">New reachable</div><div className="v tnum">{n(totals.foundNew)}</div></div>
        <div className="cmp-stat"><div className="k">Companies held</div><div className="v tnum">{store ? n(store.companies) : "—"}</div></div>
      </div>

      {err && <p className="hv-err">{err}</p>}
      {report && <p className="hv-report">{report}</p>}

      <div className="card">
        <div className="hv-controls">
          <input className="db-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company…" />
          <div className="cmp-seg">
            {(["all", "ai", "Big tech", "Fintech", "Infra", "Product"] as TierFilter[]).map((t) => (
              <button type="button" key={t} className={tier === t ? "on" : ""} onClick={() => setTier(t)}>
                {t === "all" ? "All" : t === "ai" ? "AI" : t}
              </button>
            ))}
          </div>
          <div className="cmp-seg">
            {(["any", "new", "unscanned"] as StatusFilter[]).map((s) => (
              <button type="button" key={s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>
                {s === "any" ? "Any" : s === "new" ? "Has new" : "Unscanned"}
              </button>
            ))}
          </div>
          {sweep ? (
            <button type="button" className="ghost hv-stop" onClick={() => { stopSweep.current = true; }}>
              Stop sweep
            </button>
          ) : (
            <button type="button" className="ghost" disabled={!unscanned.length || busy !== null} onClick={() => void scan(unscanned)}>
              Scan {n(unscanned.length)} unscanned · free
            </button>
          )}
        </div>

        {sweep && (
          <div className="hv-sweep">
            <div className="hv-sweep-bar"><i style={{ width: `${(sweep.done / Math.max(1, sweep.total)) * 100}%` }} /></div>
            <span className="hv-sweep-n tnum">{n(sweep.done)} / {n(sweep.total)} scanned · free · results save as each batch finishes</span>
          </div>
        )}

        <div className="db-table-wrap">
          <table className="db-table hv-table">
            <thead>
              <tr>
                <th className="hv-cb" />
                {sortBtn("rank", "#", "hv-rank")}
                {sortBtn("name", "Company")}
                <th>Tier</th>
                {sortBtn("onFile", "On file", "num")}
                <th className="num">Found</th>
                {sortBtn("new", "New", "num")}
                <th className="hv-mixh">Mix</th>
                <th className="num hv-caph">Cap</th>
                {sortBtn("credits", "Credits", "num")}
                <th>Status</th>
                <th className="hv-act" />
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={12} className="meta hv-pad">Loading targets…</td></tr>}
              {!loading && filtered.length === 0 && <tr><td colSpan={12} className="meta hv-pad">No companies match that filter.</td></tr>}
              {filtered.map((r, i) => (
                <RowView
                  key={r.domain}
                  row={r}
                  rank={i + 1}
                  sel={picked.has(r.domain)}
                  scanning={scanning.has(r.domain)}
                  covered={r.onFile >= WELL_COVERED}
                  cap={capOf(r)}
                  credits={creditsOf(r)}
                  expanded={open === r.domain}
                  onToggleSel={() => toggle(r.domain)}
                  onScan={() => void scan([r.domain])}
                  onExpand={() => setOpen(open === r.domain ? null : r.domain)}
                  onCap={(v) => setCaps((c) => ({ ...c, [r.domain]: v }))}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="hv-note">
        <b>Row math:</b> “Found” is Apollo people-search — 0 credits. “New” subtracts everyone already in your{" "}
        {store ? n(store.total) : ""} contacts, matched on Apollo person id, LinkedIn URL, email, then first name +
        company + title. “Credits” is the new people Apollo has an email for, after the cap — edit any cap inline.
      </p>

      <div className="hv-dock">
        <div className="hv-dock-l">
          <span className="hv-dock-n"><b>{totals.selCount}</b> companies</span>
          <span className="hv-dock-c">
            <b className={overBudget ? "over" : ""}>{n(totals.selCredits)}</b> credits
            <span className="meta"> of {balance === null ? "—" : n(balance)}</span>
          </span>
          {totals.selCredits > 0 && (
            <span className="hv-dock-mix">
              {MIX.filter((g) => totals.mix[g] > 0).map((g) => (
                <span className={`hv-mixchip g-${g}`} key={g} title={GROUP_LABEL[g]}>
                  <i />{n(totals.mix[g])}
                </span>
              ))}
            </span>
          )}
        </div>
        <span className="hv-dock-sp" />
        <button type="button" className="ghost" onClick={fillToBudget}>Fill to budget</button>
        <button type="button" className="ghost" onClick={() => setPicked(new Set())} disabled={!totals.selCount}>Clear</button>
        <button type="button" className="ghost" disabled={busy !== null || !totals.selCount} onClick={() => void run(true)}>
          {busy === "dry" ? "Rehearsing…" : "Dry run"}
        </button>
        <button type="button" disabled={busy !== null || !totals.selCount} onClick={() => void run(false)}>
          {busy === "run" ? "Harvesting…" : "Harvest selected"}
        </button>
      </div>
    </div>
  );
}

function MixBar({ scan, take }: { scan: ScanRow; take: number }) {
  // Proportions of what this row would actually BUY (the first `take`
  // candidates, which are already sorted founders -> eng -> recruiters -> other).
  const counts: Record<Group, number> = { founders: 0, engineering: 0, recruiters: 0, other: 0 };
  let left = take;
  for (const g of MIX) {
    const inGroup = scan.candidates.filter((c) => c.group === g).length;
    const t = Math.min(inGroup, left);
    counts[g] = t;
    left -= t;
    if (left <= 0) break;
  }
  const total = Math.max(1, take);
  const title = MIX.filter((g) => counts[g] > 0).map((g) => `${counts[g]} ${GROUP_LABEL[g]}`).join(" · ");
  return (
    <span className="hv-mix" title={title || "nothing to buy"}>
      {MIX.map((g) => counts[g] > 0 && <i key={g} className={`g-${g}`} style={{ width: `${(counts[g] / total) * 100}%` }} />)}
    </span>
  );
}

function RowView({ row, rank, sel, scanning, covered, cap, credits, expanded, onToggleSel, onScan, onExpand, onCap }: {
  row: Row; rank: number; sel: boolean; scanning: boolean; covered: boolean; cap: number; credits: number;
  expanded: boolean; onToggleSel: () => void; onScan: () => void; onExpand: () => void; onCap: (v: number) => void;
}) {
  const s = row.scan;
  const capped = s ? s.newReachable > cap : false;
  const coverPct = Math.min(100, (row.onFile / WELL_COVERED) * 100);

  return (
    <>
      <tr className={`${sel ? "hv-sel" : ""}${!s ? " hv-unscanned" : ""}`}>
        <td className="hv-cb">
          <input type="checkbox" checked={sel} disabled={!s || credits === 0} onChange={onToggleSel} aria-label={`Select ${row.name}`} />
        </td>
        <td className="hv-rank tnum">{rank}</td>
        <td>
          <div className="hv-co">
            {s?.logoUrl ? <img className="hv-logo" src={s.logoUrl} alt="" /> : <span className="hv-logo hv-logo-ph">{initials(row.name)}</span>}
            <div className="hv-co-txt">
              <div className="hv-co-n">{row.name}</div>
              <div className="hv-co-d mono">{row.domain}</div>
            </div>
          </div>
        </td>
        <td><span className={`hv-tier${AI_TIERS.has(row.tier) ? " ai" : ""}`}>{row.tier}</span></td>
        <td className="num">
          <span className="hv-cov" title={`${row.onFile} on file · ${row.outreach} emailed`}>
            <span className={`tnum${covered ? " hv-ok" : " hv-dim"}`}>{n(row.onFile)}</span>
            <span className="hv-cov-bar"><i style={{ width: `${coverPct}%` }} /></span>
          </span>
        </td>
        <td className="num tnum">{s ? n(s.found) : <span className="hv-dim">—</span>}</td>
        <td className="num tnum">{s ? <span className={credits ? "hv-new" : "hv-dim"}>{n(s.newReachable)}</span> : <span className="hv-dim">—</span>}</td>
        <td className="hv-mixh">{s && credits > 0 ? <MixBar scan={s} take={credits} /> : <span className="hv-dim">—</span>}</td>
        <td className="num hv-caph">
          {s ? (
            <input
              className="hv-cap-in tnum" type="number" min={0} max={500} value={cap}
              onChange={(e) => onCap(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
              aria-label={`Cap for ${row.name}`}
            />
          ) : <span className="hv-dim">—</span>}
        </td>
        <td className="num tnum">
          {s ? (
            <span className={credits ? "hv-cost" : "hv-dim"}>
              {n(credits)}{capped && <span className="hv-cap"> cap</span>}
            </span>
          ) : <span className="hv-dim">—</span>}
        </td>
        <td>
          {scanning ? <span className="hv-st run"><i />searching…</span>
            : s?.error ? <span className="hv-st err" title={s.error}><i />failed</span>
            : s ? <span className={`hv-st ${covered ? "cov" : "done"}`}><i />{covered ? "well covered" : "scanned"}</span>
            : <span className="hv-st idle"><i />not scanned</span>}
        </td>
        <td className="hv-act">
          {s
            ? <button type="button" className="btn-xs" onClick={onExpand}>{expanded ? "Hide ▴" : "Review ▾"}</button>
            : <button type="button" className="btn-xs" disabled={scanning} onClick={onScan}>{scanning ? "…" : "Find people"}</button>}
        </td>
      </tr>

      {expanded && s && (
        <tr className="hv-exp">
          <td colSpan={12}>
            <div className="hv-exp-in">
              {s.error && <div className="hv-err-in">{s.error}</div>}
              {MIX.map((g) => {
                const gc = s.groups[g];
                if (!gc.found) return null;
                const reach = gc.reachable ?? 0;
                const people = s.candidates.filter((c) => c.group === g).slice(0, 8);
                return (
                  <div className="hv-grp" key={g}>
                    <div className="hv-grp-h"><i className={`hv-gdot g-${g}`} />{GROUP_LABEL[g]}</div>
                    <div className="hv-chips">
                      {gc.held > 0 && <span className="hv-chip have">{n(gc.held)} already on file</span>}
                      {people.map((c) => (
                        <span className="hv-chip" key={c.id}>
                          <i className="d" />
                          {c.firstName} {c.lastName ?? ""}
                          <span className="t">{c.title}</span>
                        </span>
                      ))}
                      {reach > people.length && <span className="hv-chip more">+{n(reach - people.length)} more</span>}
                      {gc.new > reach && <span className="hv-chip none">{n(gc.new - reach)} with no email Apollo will sell</span>}
                    </div>
                  </div>
                );
              })}
              <div className="hv-exp-foot">
                {n(s.found)} found · {n(s.heldOfFound)} already on file (skipped, 0 credits) ·{" "}
                <b>{n(credits)} credits</b>
                {capped && <> — capped from {n(s.newReachable)} so one company can’t take the whole budget</>}
                {s.harvested > 0 && <> · {n(s.harvested)} already harvested in an earlier run</>}
                {s.employees ? <> · {n(s.employees)} employees</> : null}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
