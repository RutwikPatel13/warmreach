"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── Campaigns: bulk, list-driven cold outreach ──────────────────────────────
// Sibling to the Applications page (app/page.tsx). Drives outreach from the
// curated startup lists in data/prospects/: resolve every company in Apollo,
// people-search by target title, generate a cold intro per company, draft in
// Gmail, and drip-send. State lives under its OWN localStorage namespace so it
// never touches the Applications workspaces.

type Theme = "light" | "dark";
type Variant = "recruiter" | "engineering";
type Mode = "drip" | "once" | "manual";

interface ProspectCompany { name: string; domain?: string; website?: string; description?: string }
interface ProspectList { id: string; name: string; count: number; withDomain: number; companies: ProspectCompany[]; onFile?: boolean }
interface Group { id: string; label: string }

interface Person { id: string; firstName: string; lastName?: string | null; title: string; variant: Variant; strong?: boolean; source?: "apollo" | "csv"; email?: string | null }
interface CompanyResult {
  input: string;
  company: { name: string; domain: string | null; orgId: string | null; description: string | null; keywords: string[]; logoUrl: string | null };
  found: number;
  reachable: number;
  people: Person[];
  source?: "apollo" | "csv"; // "csv" = served free from data/contacts
}
interface Unresolved { input: string; reason: string }
interface ResultLine {
  id: string; company: string; name?: string; title?: string; email?: string | null;
  status: "drafted" | "skipped" | "error"; reason?: string; subject?: string; bodyPreview?: string; draftId?: string;
}
interface ScheduledSend {
  id: string; draftId: string; name?: string; subject?: string; sendAt: string;
  status: "pending" | "sent" | "failed" | "canceled"; error?: string;
}

const COUNTRY_OPTIONS = [
  { value: "us", label: "United States", locations: ["United States"] },
  { value: "ca", label: "Canada", locations: ["Canada"] },
  { value: "us_ca", label: "United States + Canada", locations: ["United States", "Canada"] },
  { value: "any", label: "Any country", locations: [] as string[] },
];
const countryLocations = (v: string) => COUNTRY_OPTIONS.find((o) => o.value === v)?.locations ?? ["United States"];
const GMAIL_DRAFTS = "https://mail.google.com/mail/u/0/#drafts";
const VARIANT_LABEL: Record<Variant, string> = { recruiter: "Founder / recruiter", engineering: "Engineering" };

// ── persistence (own namespace — never touches warmreach:v1: workspaces) ─────
const NS = "warmreach:campaign:v1:";
const STATE_KEY = NS + "state";
const THEME_KEY = "warmreach:v1:theme"; // shared UI pref (same meaning/values app-wide)

function loadJSON<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : null; } catch { return null; }
}
function saveJSON(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

function toLocalInputValue(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function tomorrowAt(hour: number) { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(hour, 0, 0, 0); return d; }
function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

interface Snapshot {
  selectedLists: string[]; groups: string[]; customTitles: string; country: string;
  deselectedCompanies: string[]; manualCompanies: ProspectCompany[]; skipContacted: boolean; instructions: string; baseTemplate: string;
  companyResults: CompanyResult[]; unresolved: Unresolved[]; selected: string[];
  results: Record<string, ResultLine>; resultOrder: string[];
  mode: Mode; perDay: number; startAt: string; manualSent: string[];
}

function monogramColor(name: string) {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 45% 45%)`;
}

// Mirror of normCompany in src/tracker.ts — normalizes a company name so the
// "already reached out" flag matches on both sides.
function normName(s: string) {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
    .filter((w) => w && !["inc", "llc", "ltd", "co", "corp", "corporation"].includes(w)).join("");
}

// Real Apollo company logo (free — comes with the resolved org during search),
// falling back to a colored monogram when there's none or the image fails.
function CampaignLogo({ name, logoUrl }: { name: string; logoUrl?: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [logoUrl]);
  if (logoUrl && !failed) {
    return <img className="cmp-logo cmp-logo-img" src={logoUrl} alt="" loading="lazy" onError={() => setFailed(true)} />;
  }
  return (
    <span className="cmp-logo" style={{ background: monogramColor(name) }} aria-hidden="true">
      {(name || "?").charAt(0).toUpperCase()}
    </span>
  );
}

export default function CampaignsPage() {
  const [theme, setTheme] = useState<Theme>("light");
  const [hydrated, setHydrated] = useState(false);

  const [lists, setLists] = useState<ProspectList[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedLists, setSelectedLists] = useState<Set<string>>(new Set());
  const [groupSel, setGroupSel] = useState<Set<string>>(new Set(["founders", "engineering", "recruiters"]));
  const [customTitles, setCustomTitles] = useState("");
  const [country, setCountry] = useState("us");
  const [deselectedCompanies, setDeselectedCompanies] = useState<Set<string>>(new Set());
  const [companyFilter, setCompanyFilter] = useState("");
  const [manualCompanies, setManualCompanies] = useState<ProspectCompany[]>([]); // ad-hoc companies typed by name/domain (e.g. Google), not from any list
  const [manualInput, setManualInput] = useState("");
  const [contactedNames, setContactedNames] = useState<Set<string>>(new Set());
  const [contactedDomains, setContactedDomains] = useState<Set<string>>(new Set());
  const [hideDone, setHideDone] = useState(false);
  const [skipContacted, setSkipContacted] = useState(true);

  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [companyResults, setCompanyResults] = useState<CompanyResult[]>([]);
  const [unresolved, setUnresolved] = useState<Unresolved[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [instructions, setInstructions] = useState("");
  const [baseTemplate, setBaseTemplate] = useState("");
  const [showTemplate, setShowTemplate] = useState(false);

  const [drafting, setDrafting] = useState(false);
  const [results, setResults] = useState<Record<string, ResultLine>>({});
  const [resultOrder, setResultOrder] = useState<string[]>([]);

  const [mode, setMode] = useState<Mode>("drip");
  const [perDay, setPerDay] = useState(40);
  const [startAt, setStartAt] = useState(() => toLocalInputValue(tomorrowAt(8)));
  const [scheduled, setScheduled] = useState<ScheduledSend[]>([]);
  const [manualSent, setManualSent] = useState<Set<string>>(new Set()); // drafts sent via "Send all now" (not in scheduled.json)
  const [sending, setSending] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // companies whose people are shown

  // ── theme ──
  useEffect(() => { const s = loadJSON<Theme>(THEME_KEY); if (s === "light" || s === "dark") setTheme(s); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; saveJSON(THEME_KEY, theme); }, [theme]);

  // ── load prospect lists + groups ──
  useEffect(() => {
    fetch("/api/prospects").then((r) => r.json()).then((d) => {
      setLists(d.lists ?? []);
      if (d.groups?.length) setGroups(d.groups);
    }).catch(() => setError("Could not load prospect lists from data/prospects/."));
  }, []);

  // Companies already reached out to (from the outreach log) — for the "done
  // before" flag. Refreshed on load and after each draft run.
  const refreshContacted = useCallback(async () => {
    try {
      const r = await fetch("/api/campaign/contacted");
      if (r.ok) { const d = await r.json(); setContactedNames(new Set(d.names ?? [])); setContactedDomains(new Set(d.domains ?? [])); }
    } catch { /* best-effort */ }
  }, []);
  useEffect(() => { refreshContacted(); }, [refreshContacted]);

  // ── restore snapshot ──
  useEffect(() => {
    const s = loadJSON<Snapshot>(STATE_KEY);
    if (s) {
      setSelectedLists(new Set(s.selectedLists ?? []));
      setGroupSel(new Set(s.groups ?? ["founders", "engineering", "recruiters"]));
      setCustomTitles(s.customTitles ?? "");
      setCountry(s.country ?? "us");
      setDeselectedCompanies(new Set(s.deselectedCompanies ?? []));
      setManualCompanies(s.manualCompanies ?? []);
      setSkipContacted(s.skipContacted !== false);
      setInstructions(s.instructions ?? "");
      setBaseTemplate(s.baseTemplate ?? "");
      setCompanyResults(s.companyResults ?? []);
      setUnresolved(s.unresolved ?? []);
      setSelected(new Set(s.selected ?? []));
      setResults(s.results ?? {});
      setResultOrder(s.resultOrder ?? []);
      setMode(s.mode ?? "drip");
      setPerDay(s.perDay ?? 40);
      if (s.startAt) setStartAt(s.startAt);
      setManualSent(new Set(s.manualSent ?? []));
    }
    setHydrated(true);
  }, []);

  // ── persist ──
  useEffect(() => {
    if (!hydrated) return;
    saveJSON(STATE_KEY, {
      selectedLists: [...selectedLists], groups: [...groupSel], customTitles, country,
      deselectedCompanies: [...deselectedCompanies], manualCompanies, skipContacted, instructions, baseTemplate,
      companyResults, unresolved, selected: [...selected], results, resultOrder,
      mode, perDay, startAt, manualSent: [...manualSent],
    } satisfies Snapshot);
  }, [hydrated, selectedLists, groupSel, customTitles, country, deselectedCompanies, manualCompanies, skipContacted,
      instructions, baseTemplate, companyResults, unresolved, selected, results, resultOrder, mode, perDay, startAt, manualSent]);

  // ── derived ──
  const keyOf = (c: ProspectCompany) => (c.domain || c.name).toLowerCase();

  const chosenCompanies = useMemo(() => {
    const map = new Map<string, ProspectCompany>();
    for (const c of manualCompanies) { const k = keyOf(c); if (!map.has(k)) map.set(k, c); } // ad-hoc companies first
    for (const l of lists) if (selectedLists.has(l.id))
      for (const c of l.companies) { const k = keyOf(c); if (!map.has(k)) map.set(k, c); }
    return [...map.values()];
  }, [lists, selectedLists, manualCompanies]);

  const manualKeys = useMemo(() => new Set(manualCompanies.map(keyOf)), [manualCompanies]);

  // The companies actually searched: chosen (from selected lists) minus any the
  // user unticked in the company picker. Default = all chosen (deselected empty).
  // Has this company been reached out to in an earlier batch? (log match by
  // email domain, then normalized name.) Used only to FLAG — never to deselect.
  const isDone = useCallback(
    (c: ProspectCompany) => (!!c.domain && contactedDomains.has(c.domain)) || contactedNames.has(normName(c.name)),
    [contactedDomains, contactedNames],
  );
  const doneCount = useMemo(() => chosenCompanies.filter(isDone).length, [chosenCompanies, isDone]);

  const companiesToSearch = useMemo(
    () => chosenCompanies.filter((c) => !deselectedCompanies.has(keyOf(c))),
    [chosenCompanies, deselectedCompanies],
  );
  const visibleCompanies = useMemo(() => {
    const q = companyFilter.trim().toLowerCase();
    let arr = chosenCompanies;
    if (q) arr = arr.filter((c) => c.name.toLowerCase().includes(q) || (c.domain ?? "").includes(q));
    if (hideDone) arr = arr.filter((c) => !isDone(c));
    return arr;
  }, [chosenCompanies, companyFilter, hideDone, isDone]);

  const totals = useMemo(() => {
    const found = companyResults.reduce((n, c) => n + c.found, 0);
    const reachable = companyResults.reduce((n, c) => n + c.reachable, 0);
    return { companies: companiesToSearch.length, resolved: companyResults.length, found, reachable, selected: selected.size };
  }, [companyResults, companiesToSearch, selected]);

  const draftedRows = useMemo(
    () => resultOrder.map((id) => results[id]).filter((r): r is ResultLine => !!r && r.status === "drafted" && !!r.draftId),
    [results, resultOrder],
  );
  const pendingByDraft = useMemo(() => {
    const m: Record<string, ScheduledSend> = {};
    for (const s of scheduled) if (s.status === "pending" && s.draftId) m[s.draftId] = s;
    return m;
  }, [scheduled]);
  // Sent = fired by the scheduler (recorded in scheduled.json) OR sent manually
  // via "Send all now" (which /api/send does NOT record in scheduled.json).
  const sentDraftIds = useMemo(() => {
    const s = new Set(scheduled.filter((x) => x.status === "sent").map((x) => x.draftId));
    manualSent.forEach((id) => s.add(id));
    return s;
  }, [scheduled, manualSent]);
  const sentCount = useMemo(
    () => draftedRows.filter((r) => r.draftId && sentDraftIds.has(r.draftId)).length,
    [draftedRows, sentDraftIds],
  );

  // What a "Create drafts" run will actually touch: selected people who aren't
  // already sent. Credits are spent only on Apollo people we haven't enriched yet
  // (CSV people and already-drafted people reuse a known email — free).
  const isSent = (id: string) => { const d = results[id]?.draftId; return !!d && sentDraftIds.has(d); };
  const toDraftCount = useMemo(() => {
    let n = 0;
    for (const c of companyResults) for (const p of c.people) if (selected.has(p.id) && !isSent(p.id)) n++;
    return n;
  }, [companyResults, selected, results, sentDraftIds]);
  const creditsEst = useMemo(() => {
    let n = 0;
    for (const c of companyResults) for (const p of c.people) {
      if (!selected.has(p.id) || p.source === "csv" || isSent(p.id)) continue;
      if (results[p.id]?.email) continue; // already enriched — re-draft reuses it, no credit
      n++;
    }
    return n;
  }, [companyResults, selected, results, sentDraftIds]);

  const currentStep = drafting || draftedRows.length ? 4 : companyResults.length ? 3 : 1;

  // ── search ──
  const toggleList = (id: string) => setSelectedLists((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleGroup = (id: string) => setGroupSel((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleExpand = (name: string) => setExpanded((prev) => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  const toggleCompanyPick = (c: ProspectCompany) => setDeselectedCompanies((prev) => { const n = new Set(prev); const k = keyOf(c); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const pickAllCompanies = (on: boolean) => setDeselectedCompanies(on ? new Set() : new Set(chosenCompanies.map(keyOf)));

  // Add one or more ad-hoc companies (comma-separated) by name or domain. A token
  // that looks like a bare domain (has a dot, no spaces) is stored as {name,domain}
  // so Apollo resolves by domain; otherwise it's resolved by name. Deduped against
  // everything already chosen so re-adding is a no-op; new keys default to selected.
  const addManualCompanies = () => {
    const tokens = manualInput.split(",").map((s) => s.trim()).filter(Boolean);
    if (tokens.length === 0) return;
    setManualCompanies((prev) => {
      const seen = new Set([...prev.map(keyOf), ...chosenCompanies.map(keyOf)]);
      const next = [...prev];
      for (const t of tokens) {
        const isDomain = /\.[a-z]{2,}$/i.test(t) && !/\s/.test(t);
        const c: ProspectCompany = isDomain ? { name: t.replace(/^https?:\/\//, "").replace(/\/.*$/, ""), domain: t.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase() } : { name: t };
        const k = keyOf(c);
        if (!seen.has(k)) { seen.add(k); next.push(c); }
      }
      return next;
    });
    setDeselectedCompanies((prev) => { // make sure freshly added ones are ticked
      if (prev.size === 0) return prev;
      const n = new Set(prev);
      manualInput.split(",").map((s) => s.trim()).filter(Boolean).forEach((t) => {
        const isDomain = /\.[a-z]{2,}$/i.test(t) && !/\s/.test(t);
        n.delete((isDomain ? t.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase() : t).toLowerCase());
      });
      return n;
    });
    setManualInput("");
  };
  const removeManual = (c: ProspectCompany) => {
    const k = keyOf(c);
    setManualCompanies((prev) => prev.filter((m) => keyOf(m) !== k));
    setDeselectedCompanies((prev) => { const n = new Set(prev); n.delete(k); return n; });
  };
  // Untick only the already-done companies for THIS run (not permanent — they
  // stay in the list, still flagged, and "All" re-adds them).
  const deselectDone = () => setDeselectedCompanies((prev) => {
    const n = new Set(prev); chosenCompanies.forEach((c) => { if (isDone(c)) n.add(keyOf(c)); }); return n;
  });

  async function runSearch() {
    if (companiesToSearch.length === 0) { setError("Pick at least one company to search."); return; }
    setError(null); setSearching(true); setCompanyResults([]); setUnresolved([]); setSelected(new Set());
    setResults({}); setResultOrder([]); setProgress({ done: 0, total: companiesToSearch.length });
    try {
      const res = await fetch("/api/campaign/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companies: companiesToSearch.map((c) => ({ name: c.name, domain: c.domain ?? null })),
          groups: [...groupSel], customTitles: customTitles.split(",").map((s) => s.trim()).filter(Boolean),
          locations: countryLocations(country),
        }),
      });
      if (!res.ok || !res.body) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? "Search failed."); }
      const preselect = new Set<string>();
      await readNdjson(res.body, (obj: any) => {
        if (obj.type === "company") {
          setCompanyResults((prev) => [...prev, obj as CompanyResult]);
          // Smart default: pre-select the strong matches (founders / eng leaders);
          // the user adjusts per company.
          (obj.people as Person[]).forEach((p) => { if (p.strong) preselect.add(p.id); });
          setSelected(new Set(preselect));
          setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
        } else if (obj.type === "unresolved") {
          setUnresolved((prev) => [...prev, obj as Unresolved]);
          setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
        }
      });
    } catch (e: any) { setError(e.message); } finally { setSearching(false); setProgress(null); }
  }

  function togglePerson(id: string) { setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function toggleCompany(c: CompanyResult) {
    const ids = c.people.map((p) => p.id); const allOn = ids.every((id) => selected.has(id));
    setSelected((prev) => { const n = new Set(prev); ids.forEach((id) => (allOn ? n.delete(id) : n.add(id))); return n; });
  }
  function selectAll(on: boolean) {
    if (!on) return setSelected(new Set());
    const n = new Set<string>(); companyResults.forEach((c) => c.people.forEach((p) => n.add(p.id))); setSelected(n);
  }

  // ── draft ──
  async function createDrafts() {
    // Regeneration-aware: skip anyone already SENT (leave them alone), and for
    // people already drafted, reuse their known email + draft id so the draft is
    // UPDATED in place (no duplicate, no new Apollo credit) with the latest text.
    const payloadCompanies = companyResults
      .map((c) => ({
        name: c.company.name, domain: c.company.domain, description: c.company.description, keywords: c.company.keywords,
        people: c.people
          .filter((p) => selected.has(p.id))
          .filter((p) => { const r = results[p.id]; return !(r?.draftId && sentDraftIds.has(r.draftId)); })
          .map((p) => {
            const r = results[p.id];
            return { ...p, email: r?.email ?? p.email ?? null, name: r?.name ?? null, title: r?.title ?? p.title, replaceDraftId: r?.draftId ?? null };
          }),
      }))
      .filter((c) => c.people.length);
    if (payloadCompanies.length === 0) { setError("Nothing to draft — everyone selected has already been sent."); return; }
    setError(null); setDrafting(true);
    // Do NOT clear results: keep the sent rows visible; streamed rows merge by id.
    try {
      const res = await fetch("/api/campaign/draft", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companies: payloadCompanies, instructions, template: baseTemplate.trim() ? { subject: "", body: baseTemplate } : null, skipContacted }),
      });
      if (!res.ok || !res.body) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? "Drafting failed."); }
      await readNdjson(res.body, (r: ResultLine) => {
        setResults((prev) => ({ ...prev, [r.id]: r }));
        setResultOrder((prev) => (prev.includes(r.id) ? prev : [...prev, r.id]));
      });
      refreshScheduled();
      refreshContacted(); // the log just grew — update the "done before" flags
    } catch (e: any) { setError(e.message); } finally { setDrafting(false); }
  }

  // ── schedule / send ──
  const refreshScheduled = useCallback(async () => {
    try { const res = await fetch("/api/schedule"); if (res.ok) setScheduled((await res.json()).scheduled ?? []); } catch { /* poll */ }
  }, []);
  useEffect(() => { if (hydrated && draftedRows.length) { refreshScheduled(); const t = setInterval(refreshScheduled, 30_000); return () => clearInterval(t); } }, [hydrated, draftedRows.length, refreshScheduled]);

  const scheduleItems = () => draftedRows
    .filter((r) => !pendingByDraft[r.draftId!] && !sentDraftIds.has(r.draftId!))
    .map((r) => ({ draftId: r.draftId!, to: r.email ?? null, name: r.name, subject: r.subject }));

  async function launch() {
    const items = scheduleItems();
    if (items.length === 0) { setError("No unsent drafts to schedule."); return; }
    setError(null); setSending(true);
    try {
      if (mode === "manual") { window.open(GMAIL_DRAFTS, "_blank"); return; }
      if (mode === "once") {
        const res = await fetch("/api/schedule", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items, sendAt: new Date(startAt).toISOString() }),
        });
        const d = await res.json(); if (!res.ok) throw new Error(d.error ?? "Scheduling failed."); setScheduled(d.scheduled ?? []);
      } else {
        const res = await fetch("/api/campaign/schedule", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items, perDay, startAt: new Date(startAt).toISOString() }),
        });
        const d = await res.json(); if (!res.ok) throw new Error(d.error ?? "Scheduling failed."); setScheduled(d.scheduled ?? []);
      }
    } catch (e: any) { setError(e.message); } finally { setSending(false); }
  }

  async function sendNow() {
    const items = scheduleItems(); if (!items.length) return;
    setError(null); setSending(true);
    try {
      const res = await fetch("/api/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftIds: items.map((i) => i.draftId) }),
      });
      const d = await res.json(); if (!res.ok) throw new Error(d.error ?? "Send failed.");
      // Track manual sends locally (persisted) — /api/send doesn't touch scheduled.json,
      // so this must NOT live in `scheduled` (refreshScheduled would wipe it).
      const okIds: string[] = (d.results ?? []).filter((r: any) => r.ok).map((r: any) => r.draftId);
      if (okIds.length) setManualSent((prev) => new Set([...prev, ...okIds]));
      const failed = (d.results ?? []).filter((r: any) => !r.ok);
      if (failed.length) setError(`Failed to send ${failed.length}: ${failed[0].error ?? "unknown error"}`);
    } catch (e: any) { setError(e.message); } finally { setSending(false); }
  }

  async function cancelSchedule(id: string) {
    try {
      const res = await fetch("/api/schedule", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      if (res.ok) setScheduled((await res.json()).scheduled ?? []);
    } catch { /* ignore */ }
  }

  const finishEstimate = useMemo(() => {
    const n = scheduleItems().length; if (mode !== "drip" || n === 0) return null;
    const days = Math.ceil(n / Math.max(1, perDay)); return { days };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftedRows, mode, perDay, scheduled]);

  const step = (n: number, label: string) => {
    const done = n < currentStep; const now = n === currentStep;
    return (
      <span className={`spine-step ${done ? "done" : now ? "now" : ""}`} key={label}>
        <span className="spine-num">{done ? "✓" : n}</span><span>{label}</span>
      </span>
    );
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="side-brand"><span className="brand-mark" aria-hidden="true" /><span className="brand-name">warmreach</span></div>

        <nav className="side-section">
          <div className="side-label">Workspace</div>
          <div className="cmp-nav">
            <a href="/">◱&nbsp; Applications</a>
            <a href="/campaigns" className="active" aria-current="page">◎&nbsp; Campaigns</a>
            <a href="/database">▦&nbsp; Database</a>
          </div>
        </nav>

        <div className="side-section">
          <div className="side-label">Source lists</div>
          <div className="cmp-lists">
            {lists.length === 0 && <p className="meta" style={{ padding: "0 6px" }}>No lists found in <code>data/prospects/</code>.</p>}
            {lists.map((l) => (
              <label className={`cmp-list ${selectedLists.has(l.id) ? "sel" : ""}`} key={l.id}>
                <input type="checkbox" checked={selectedLists.has(l.id)} onChange={() => toggleList(l.id)} />
                <span className="nm">{l.name}</span>
                {l.onFile && <span className="cmp-list-free" title="Verified emails already on file — no Apollo credits">free</span>}
                <span className="ct">{l.count}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="side-foot">
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
              <h1>Campaigns</h1>
              <div className="cmp-sub">Cold outreach to the people building at every startup on your lists — hiring or not.</div>
            </div>
            <div className="spine" aria-label={`Step ${currentStep} of 4`}>
              {step(1, "Source")}<span className="spine-sep" />{step(2, "People")}<span className="spine-sep" />
              {step(3, "Compose")}<span className="spine-sep" />{step(4, "Launch")}
            </div>
          </div>

          {error && <div className="error-box">{error}</div>}

          {/* stats */}
          <div className="cmp-stats">
            {[
              ["Companies", totals.companies], ["Resolved", `${totals.resolved}`],
              ["People found", totals.found], ["Reachable", totals.reachable],
            ].map(([k, v]) => (<div className="cmp-stat" key={k as string}><div className="k">{k}</div><div className="v tnum">{v}</div></div>))}
            <div className="cmp-stat accent"><div className="k">Selected</div><div className="v tnum">{totals.selected}</div></div>
            <div className="cmp-stat warn"><div className="k">Credits est.</div><div className="v tnum">{creditsEst}</div></div>
          </div>

          {/* STEP 1 — source & targeting */}
          <div className="card">
            <div className="panel-head-row"><div className="panel-head-main"><span className="step-badge">1</span>
              <div className="panel-head-text"><div className="panel-title">Source &amp; targeting</div>
                <div className="panel-sub">Pick lists on the left ({totals.companies} companies), choose who to reach, then discover people.</div></div>
            </div></div>
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div className="field-label">Target these roles at each company</div>
                <div className="cmp-chips">
                  {groups.map((g) => (
                    <button type="button" key={g.id} className={`cmp-chip ${groupSel.has(g.id) ? "on" : ""}`} onClick={() => toggleGroup(g.id)}>
                      {groupSel.has(g.id) ? "✓ " : ""}{g.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="cmp-grid3">
                <label className="cmp-field"><span className="field-label">Custom titles (comma-sep)</span>
                  <input value={customTitles} onChange={(e) => setCustomTitles(e.target.value)} placeholder="design lead, head of growth" /></label>
                <label className="cmp-field"><span className="field-label">Location</span>
                  <select value={country} onChange={(e) => setCountry(e.target.value)}>{COUNTRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
              </div>

              <div className="cmp-addco">
                <span className="field-label" style={{ margin: 0 }}>Add a company by name or domain</span>
                <div className="cmp-addco-row">
                  <input value={manualInput}
                    onChange={(e) => setManualInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addManualCompanies(); } }}
                    placeholder="e.g. Google, Stripe, notion.so" />
                  <button type="button" className="ghost btn-sm" onClick={addManualCompanies} disabled={!manualInput.trim()}>Add</button>
                </div>
                <span className="meta">Reach out to a company that isn’t on any list. Same steps after: people, compose, launch.</span>
              </div>

              {chosenCompanies.length === 0 ? (
                <p className="meta">Add a company above, or select a source list on the left to load its companies here.</p>
              ) : (
                <div className="cmp-copick">
                  <div className="cmp-copick-head">
                    <span className="field-label" style={{ margin: 0 }}>Companies to search — <b>{companiesToSearch.length}</b> of {chosenCompanies.length}{doneCount > 0 && <> · <span className="cmp-done-note">{doneCount} done before</span></>}</span>
                    <input className="cmp-copick-search" value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} placeholder="Filter companies…" />
                    {doneCount > 0 && <button type="button" className={`ghost btn-sm ${hideDone ? "on" : ""}`} onClick={() => setHideDone((v) => !v)}>{hideDone ? "✓ hiding done" : "Hide done"}</button>}
                    {doneCount > 0 && <button type="button" className="ghost btn-sm" onClick={deselectDone} title="Untick the already-done companies for this run">Skip done ({doneCount})</button>}
                    <button type="button" className="ghost btn-sm" onClick={() => pickAllCompanies(true)}>All</button>
                    <button type="button" className="ghost btn-sm" onClick={() => pickAllCompanies(false)}>None</button>
                  </div>
                  <div className="cmp-copick-list">
                    {visibleCompanies.map((c) => {
                      const on = !deselectedCompanies.has(keyOf(c));
                      const done = isDone(c);
                      const manual = manualKeys.has(keyOf(c));
                      return (
                        <label className={`cmp-copick-item ${on ? "on" : ""} ${done ? "done" : ""}`} key={keyOf(c)}>
                          <input type="checkbox" checked={on} onChange={() => toggleCompanyPick(c)} />
                          <span className="nm">{c.name}</span>
                          {manual && <span className="cmp-src-pill" title="Added by you — not from a list">typed</span>}
                          {done && <span className="cmp-done-pill" title="Already in your outreach log — reached out before">✓ done</span>}
                          {c.domain ? <span className="dm">{c.domain}</span> : <span className="dm faint">by name</span>}
                          {manual && <button type="button" className="cmp-remove" title="Remove this company"
                            onClick={(e) => { e.preventDefault(); removeManual(c); }}>×</button>}
                        </label>
                      );
                    })}
                    {visibleCompanies.length === 0 && <p className="meta" style={{ padding: 8 }}>No companies match “{companyFilter}”.</p>}
                  </div>
                </div>
              )}

              <label className="cmp-checkline"><input type="checkbox" checked={skipContacted} onChange={(e) => setSkipContacted(e.target.checked)} />
                <span>Skip anyone already in my outreach log (no double-contacting)</span></label>
              <div>
                <button type="button" onClick={runSearch} disabled={searching || totals.companies === 0}>
                  {searching && <span className="spinner" />}
                  {searching ? `Finding people… ${progress ? `${progress.done}/${progress.total}` : ""}` : `Find people across ${totals.companies || ""} companies`}
                </button>
                <span className="meta" style={{ marginLeft: 12 }}>People-search is free — no Apollo credits until you draft.</span>
              </div>
            </div>
          </div>

          {/* STEP 2 — people grouped by company */}
          {(companyResults.length > 0 || unresolved.length > 0) && (
            <div className="card">
              <div className="panel-head-row">
                <div className="panel-head-main"><span className="step-badge">2</span>
                  <div className="panel-head-text"><div className="panel-title">People</div>
                    <div className="panel-sub">{totals.reachable} reachable across {totals.resolved} companies · {totals.selected} selected{unresolved.length ? ` · ${unresolved.length} not found` : ""}</div></div>
                </div>
                <div className="panel-head-actions">
                  <button type="button" className="ghost btn-sm" onClick={() => selectAll(true)}>Select all</button>
                  <button type="button" className="ghost btn-sm" onClick={() => selectAll(false)}>Clear</button>
                </div>
              </div>

              {companyResults.map((c) => {
                const on = c.people.every((p) => selected.has(p.id)) && c.people.length > 0;
                const selCount = c.people.filter((p) => selected.has(p.id)).length;
                const open = expanded.has(c.company.name);
                return (
                  <div className="cmp-group" key={c.company.orgId ?? c.company.name}>
                    <div className="cmp-crow">
                      <input type="checkbox" checked={on} onChange={() => toggleCompany(c)} aria-label={`Select all at ${c.company.name}`} />
                      <CampaignLogo name={c.company.name} logoUrl={c.company.logoUrl} />
                      <span className="cmp-cn">{c.company.name}</span>
                      {c.company.domain && <span className="cmp-cd">{c.company.domain}</span>}
                      {c.source === "csv" && <span className="cmp-src-pill" title="From your contacts export — verified emails, no Apollo credits">on file · free</span>}
                      {isDone({ name: c.company.name, domain: c.company.domain ?? undefined }) && <span className="cmp-done-pill" title="Reached out before">✓ done before</span>}
                      <span className="cmp-found"><b>{selCount}</b> selected · {c.reachable} reachable / {c.found} found</span>
                      <button type="button" className="ghost btn-sm" onClick={() => toggleExpand(c.company.name)}>{open ? "Hide" : `Show ${c.people.length}`}</button>
                    </div>
                    {open && c.people.map((p) => (
                      <label className={`cmp-prow ${selected.has(p.id) ? "on" : ""}`} key={p.id}>
                        <input type="checkbox" checked={selected.has(p.id)} onChange={() => togglePerson(p.id)} />
                        <span className="cmp-pn">{p.firstName}{p.lastName ? ` ${p.lastName}` : ""}</span>
                        <span className="cmp-pt">— {p.title || "—"}</span>
                        {p.strong && <span className="tag fit-high" title="Founder / engineering leader — strongest cold-outreach target">★ strong match</span>}
                        <span className={`tag ${p.variant}`}>{VARIANT_LABEL[p.variant]}</span>
                      </label>
                    ))}
                  </div>
                );
              })}
              {unresolved.length > 0 && (
                <details className="cmp-unresolved"><summary>{unresolved.length} companies not found in Apollo</summary>
                  <div className="cmp-unresolved-list">{unresolved.map((u) => <span key={u.input} className="chip" title={u.reason}>{u.input}</span>)}</div>
                </details>
              )}
            </div>
          )}

          {/* STEP 3 — compose */}
          {companyResults.length > 0 && (
            <div className="card">
              <div className="panel-head-row"><div className="panel-head-main"><span className="step-badge">3</span>
                <div className="panel-head-text"><div className="panel-title">Compose the campaign email</div>
                  <div className="panel-sub">Claude writes a short cold intro per company from its Apollo profile — no resume attached.</div></div>
              </div></div>
              <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                <label className="cmp-field"><span className="field-label">Your angle / instructions (optional)</span>
                  <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)}
                    placeholder={'e.g. "I’m a full-stack eng who ships fast; mention my Next.js side projects. Keep it under 120 words."'} /></label>
                <div>
                  <button type="button" className="ghost btn-sm" onClick={() => setShowTemplate((v) => !v)}>{showTemplate ? "Remove base email" : "+ Write a base email Claude adapts"}</button>
                  {showTemplate && (
                    <textarea style={{ marginTop: 8 }} className="body-editor" value={baseTemplate} onChange={(e) => setBaseTemplate(e.target.value)}
                      placeholder="Optional: paste an example cold email. Claude keeps its voice and rewrites the company-specific line per company. No greeting line — 'Hi [First name],' is added per person." />
                  )}
                </div>
                <div className="hint"><span className="i">✶</span> Personalization is company-based (from each company&apos;s description &amp; keywords) — no job description needed.</div>
              </div>
            </div>
          )}

          {/* STEP 4 — launch */}
          {companyResults.length > 0 && (
            <>
            <div className={`cmp-launch${resultOrder.length === 0 ? " sticky" : ""}`}>
              <div className="cmp-launch-top">
                <button type="button" onClick={createDrafts} disabled={drafting || toDraftCount === 0}>
                  {drafting && <span className="spinner" />}{drafting ? `Drafting… (${draftedRows.length})` : draftedRows.length ? `Refresh ${toDraftCount} drafts` : `Create ${toDraftCount} drafts`}
                </button>
                <span className="cost"><b>~{creditsEst}</b> Apollo credit{creditsEst === 1 ? "" : "s"}{toDraftCount - creditsEst > 0 ? ` · ${toDraftCount - creditsEst} free (on file or already drafted)` : ""}{sentCount > 0 ? ` · ${sentCount} sent left as-is` : ""} · nothing sends yet</span>
              </div>

              {draftedRows.length > 0 && (
                <>
                  <div className="cmp-drip">
                    <span>Then</span>
                    <div className="cmp-seg">
                      {(["drip", "once", "manual"] as Mode[]).map((m) => (
                        <button type="button" key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{m === "drip" ? "Drip send" : m === "once" ? "Schedule once" : "Manual"}</button>
                      ))}
                    </div>
                    {mode === "drip" && (
                      <span className="cmp-rate">
                        <input
                          type="number"
                          min={1}
                          max={500}
                          value={perDay}
                          onChange={(e) => setPerDay(Math.max(1, Math.min(500, Math.floor(Number(e.target.value)) || 1)))}
                          aria-label="Emails per day"
                        />
                        <span>/ day</span>
                        {[100, 200, 300].map((n) => (
                          <button type="button" key={n} className={`ghost btn-sm ${perDay === n ? "on" : ""}`} onClick={() => setPerDay(n)}>{n}</button>
                        ))}
                      </span>
                    )}
                    {mode !== "manual" && (
                      <label className="cmp-when">start <input type="datetime-local" value={startAt} min={toLocalInputValue(new Date())} onChange={(e) => setStartAt(e.target.value)} /></label>
                    )}
                    {mode === "drip" && finishEstimate && <span className="meta">finishes in ~{finishEstimate.days} day{finishEstimate.days > 1 ? "s" : ""}</span>}
                  </div>
                  <div className="cmp-launch-actions">
                    {mode === "manual" ? (
                      <button type="button" onClick={sendNow} disabled={sending}>{sending && <span className="spinner" />}Send all now ({scheduleItems().length})</button>
                    ) : (
                      <button type="button" onClick={launch} disabled={sending}>{sending && <span className="spinner" />}{mode === "drip" ? `Start drip (${scheduleItems().length})` : `Schedule ${scheduleItems().length}`}</button>
                    )}
                    <a className="footer-link" href={GMAIL_DRAFTS} target="_blank" rel="noreferrer">Open Gmail Drafts ↗</a>
                  </div>
                  <div className="cmp-safety"><span>⚠</span><span><b>Deliverability.</b> Personal @gmail.com caps at ~500 sends/day (Google Workspace ~2,000). {mode === "drip" && perDay > 150 ? <><b>{perDay} cold emails/day is aggressive</b> — use a Workspace account and warm it up gradually, or the account can get flagged. </> : null}Drip spaces sends out via the local scheduler — keep <code>npm run serve</code> running for them to fire.</span></div>
                </>
              )}

              </div>

              {resultOrder.length > 0 && (
                <div className="card cmp-results-card">
                  <div className="cmp-results-head">Drafts · {draftedRows.length} created{sentCount > 0 ? ` · ${sentCount} sent` : ""}</div>
                  <div className="cmp-results">
                  {resultOrder.map((id) => { const r = results[id]; if (!r) return null;
                    const sent = r.draftId ? (sentDraftIds.has(r.draftId)) : false;
                    const pend = r.draftId ? pendingByDraft[r.draftId] : undefined;
                    return (
                      <div className="cmp-result" key={id}>
                        <span className={`badge ${sent ? "sent" : r.status}`}>{sent ? "✓ sent" : r.status === "drafted" ? "✓ drafted" : r.status}</span>
                        <span className="cmp-r-name">{r.name ?? r.id}</span>
                        <span className="cmp-r-co">{r.company}</span>
                        {r.email && <span className="cmp-r-email">{r.email}</span>}
                        {r.reason && <span className="meta">{r.reason}</span>}
                        {pend && <span className="sched-chip">⏱ {formatWhen(pend.sendAt)}<button type="button" className="sched-chip-x" onClick={() => cancelSchedule(pend.id)}>Cancel</button></span>}
                        {r.bodyPreview && <details className="cmp-r-prev"><summary>Preview</summary><pre>{r.bodyPreview}</pre></details>}
                      </div>
                    );
                  })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

// Read an NDJSON stream, invoking `onLine` for each parsed object.
async function readNdjson(body: ReadableStream<Uint8Array>, onLine: (obj: any) => void) {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop() ?? "";
    for (const line of lines) { if (!line.trim()) continue; try { onLine(JSON.parse(line)); } catch { /* skip partial */ } }
  }
  if (buf.trim()) { try { onLine(JSON.parse(buf)); } catch { /* ignore */ } }
}
