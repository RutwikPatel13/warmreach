"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Variant = "recruiter" | "engineering";

interface Fit {
  priority: "high" | "medium";
  reason: string;
}

interface Candidate {
  id: string;
  firstName: string;
  lastName?: string | null;
  title: string;
  source?: "apollo" | "hunter";
  email?: string | null;
  confidence?: number | null;
  fit?: Fit | null;
}

interface ResolvedCompany {
  name: string;
  domain: string | null;
  orgId: string | null;
  description: string | null;
  keywords: string[];
}

interface CompanyOption {
  name: string;
  domain: string | null;
  orgId: string | null;
  employees: number | null;
}

interface Email {
  subject: string;
  body: string;
}

interface ResumeFile {
  path: string;
  label: string;
}

interface PromptPreset {
  id: string;
  name: string;
  instructions: string;
}

interface SavedTemplate {
  id: string;
  name: string;
  variants: Record<Variant, Email>;
}

interface Library {
  presets: PromptPreset[];
  templates: SavedTemplate[];
}

interface ResultLine {
  id: string;
  name?: string;
  title?: string;
  email?: string | null;
  status: "drafted" | "skipped" | "error";
  reason?: string;
  subject?: string;
  bodyPreview?: string;
  draftId?: string;
  emailSource?: "apollo" | "hunter";
  emailScore?: number;
  resumeAttached?: boolean;
}

const GMAIL_DRAFTS = "https://mail.google.com/mail/u/0/#drafts";
const VARIANT_LABEL: Record<Variant, string> = {
  recruiter: "Recruiter / founder",
  engineering: "Engineering",
};

// Country filter (Apollo person_locations). US is the default.
const COUNTRY_OPTIONS: { value: string; label: string; locations: string[] }[] = [
  { value: "us", label: "United States", locations: ["United States"] },
  { value: "ca", label: "Canada", locations: ["Canada"] },
  { value: "in", label: "India", locations: ["India"] },
  { value: "us_ca", label: "United States + Canada", locations: ["United States", "Canada"] },
  { value: "any", label: "Any country", locations: [] },
];
function countryLocations(value: string): string[] {
  return COUNTRY_OPTIONS.find((o) => o.value === value)?.locations ?? ["United States"];
}

// Mirror of classifyVariant in src/personalize.ts — kept here so the client
// doesn't import server-only modules. Tweak both if the rule changes.
const ENG_RE = /\b(engineer|engineering|swe|software|developer|programmer|cto|architect|tech lead)\b/;
function classifyVariant(title: string): Variant {
  return ENG_RE.test((title ?? "").toLowerCase()) ? "engineering" : "recruiter";
}

// Display order: actual recruiters/talent first, then other recruiter-variant
// people, then engineering — so the primary outreach targets are up top.
const RECRUITER_RE = /recruit|talent|sourc/;
function recruiterRank(title: string): number {
  const t = (title ?? "").toLowerCase();
  if (RECRUITER_RE.test(t)) return 0;
  if (classifyVariant(title) === "recruiter") return 1;
  return 2;
}

// JD-fit rank (from the server's Claude ranking) — sorts ahead of the
// recruiter/eng heuristic when a JD was provided.
function fitRank(c: Candidate): number {
  if (c.fit?.priority === "high") return 0;
  if (c.fit?.priority === "medium") return 1;
  return 2;
}

// ── localStorage persistence (SSR-safe) ─────────────────────────────────────
const NS = "warmreach:v1:";
const TABS_KEY = NS + "tabs";
const wsKey = (id: number) => `${NS}ws:${id}`;

// One-time migration from the pre-rename namespace so existing tabs survive.
if (typeof window !== "undefined") {
  try {
    const OLD_NS = "reachout:v1:";
    if (!window.localStorage.getItem(TABS_KEY)) {
      Object.keys(window.localStorage)
        .filter((k) => k.startsWith(OLD_NS))
        .forEach((k) => {
          const v = window.localStorage.getItem(k);
          if (v !== null) window.localStorage.setItem(NS + k.slice(OLD_NS.length), v);
          window.localStorage.removeItem(k);
        });
    }
  } catch {
    /* ignore */
  }
}

function loadJSON<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function saveJSON(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / serialization error — non-fatal for a local tool */
  }
}
function removeKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
function clearStorage(): void {
  if (typeof window === "undefined") return;
  try {
    Object.keys(window.localStorage)
      .filter((k) => k.startsWith(NS))
      .forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

// Durable per-workspace state — transient flags (spinners, in-flight errors) are
// intentionally NOT persisted; they reset to idle on reload.
interface WorkspaceSnapshot {
  company: string;
  role: string;
  jd: string;
  instructions: string;
  country: string;
  resolved: ResolvedCompany | null;
  totalFound: number;
  searchSource: "apollo" | "hunter";
  candidates: Candidate[];
  selected: string[];
  templates: Record<Variant, Email> | null;
  results: Record<string, ResultLine>;
  sentIds: string[];
  resumePath: string;
}

function CompanyWorkspace({
  storageKey,
  onTitle,
  resumes,
  defaultResume,
  library,
  onLibraryChange,
}: {
  storageKey: string;
  onTitle: (title: string) => void;
  resumes: ResumeFile[];
  defaultResume: string;
  library: Library;
  onLibraryChange: (lib: Library) => void;
}) {
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [jd, setJd] = useState("");
  const [instructions, setInstructions] = useState("");
  const [presetSel, setPresetSel] = useState(""); // selected preset id ("" = none)
  const [templateSel, setTemplateSel] = useState(""); // selected saved-template id
  const [newTpl, setNewTpl] = useState<Email | null>(null); // inline template editor (null = closed)
  const [country, setCountry] = useState("us");

  const [searching, setSearching] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [resolved, setResolved] = useState<ResolvedCompany | null>(null);
  const [companyOptions, setCompanyOptions] = useState<CompanyOption[]>([]);
  const [totalFound, setTotalFound] = useState(0);
  const [searchSource, setSearchSource] = useState<"apollo" | "hunter">("apollo");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [templates, setTemplates] = useState<Record<Variant, Email> | null>(null);

  const [results, setResults] = useState<Record<string, ResultLine>>({});
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<Set<string>>(new Set());
  const [resumePath, setResumePath] = useState(""); // "" = use defaultResume

  const [hydrated, setHydrated] = useState(false);

  // The resume actually attached: explicit per-tab choice, else the profile default.
  const effectiveResume = resumePath || defaultResume;

  // Restore this tab's saved state after mount (localStorage is client-only).
  useEffect(() => {
    const snap = loadJSON<WorkspaceSnapshot>(storageKey);
    if (snap) {
      setCompany(snap.company ?? "");
      setRole(snap.role ?? "");
      setJd(snap.jd ?? "");
      setInstructions(snap.instructions ?? "");
      setCountry(snap.country ?? "us");
      setResolved(snap.resolved ?? null);
      setTotalFound(snap.totalFound ?? 0);
      setSearchSource(snap.searchSource ?? "apollo");
      setCandidates(snap.candidates ?? []);
      setSelected(new Set(snap.selected ?? []));
      setTemplates(snap.templates ?? null);
      setResults(snap.results ?? {});
      setSentIds(new Set(snap.sentIds ?? []));
      setResumePath(snap.resumePath ?? "");
    }
    setHydrated(true);
  }, [storageKey]);

  // Persist durable state — only AFTER restore, so mount defaults never clobber it.
  useEffect(() => {
    if (!hydrated) return;
    saveJSON(storageKey, {
      company,
      role,
      jd,
      instructions,
      country,
      resolved,
      totalFound,
      searchSource,
      candidates,
      selected: [...selected],
      templates,
      results,
      sentIds: [...sentIds],
      resumePath,
    } satisfies WorkspaceSnapshot);
  }, [
    hydrated,
    storageKey,
    company,
    role,
    jd,
    instructions,
    country,
    resolved,
    totalFound,
    searchSource,
    candidates,
    selected,
    templates,
    results,
    sentIds,
    resumePath,
  ]);

  const allSelected = candidates.length > 0 && selected.size === candidates.length;
  const jdRanked = useMemo(() => candidates.some((c) => c.fit), [candidates]);

  const selectedByVariant = useMemo(() => {
    const counts: Record<Variant, number> = { recruiter: 0, engineering: 0 };
    for (const c of candidates) if (selected.has(c.id)) counts[classifyVariant(c.title)]++;
    return counts;
  }, [candidates, selected]);

  const draftedRows = useMemo(
    () => Object.values(results).filter((r) => r.status === "drafted" && r.draftId),
    [results],
  );
  const unsentDraftIds = draftedRows.map((r) => r.draftId!).filter((id) => !sentIds.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(candidates.map((c) => c.id)));
  }

  // keepOptions=true preserves the original match list when re-searching after a
  // company switch (searching by domain returns just one option on its own).
  async function runSearch(query: string, keepOptions = false) {
    if (!query.trim()) return;
    setError(null);
    setSearching(true);
    setResolved(null);
    if (!keepOptions) setCompanyOptions([]);
    setCandidates([]);
    setSelected(new Set());
    setTemplates(null);
    setResults({});
    setSentIds(new Set());
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: query,
          locations: countryLocations(country),
          role,
          jobDescription: jd,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed.");
      setResolved(data.company);
      if (!keepOptions) setCompanyOptions(data.companyOptions ?? []);
      setTotalFound(data.totalFound ?? data.candidates.length);
      setSearchSource(data.source ?? "apollo");
      const sorted = [...(data.candidates ?? [])].sort(
        (a: Candidate, b: Candidate) =>
          fitRank(a) - fitRank(b) || recruiterRank(a.title) - recruiterRank(b.title),
      );
      setCandidates(sorted);
      // Pre-select the strong JD matches — a suggestion only; nothing is
      // enriched or drafted until the user clicks the buttons.
      if (data.ranked) {
        setSelected(new Set(sorted.filter((c: Candidate) => c.fit?.priority === "high").map((c: Candidate) => c.id)));
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  }

  function findPeople(e: React.FormEvent) {
    e.preventDefault();
    runSearch(company);
  }

  // Re-run against a specific company the user picked from the matches — search by
  // its domain so resolution is deterministic, and keep the match list visible.
  function pickCompany(opt: CompanyOption) {
    const query = opt.domain || opt.name;
    setCompany(query);
    onTitle(query);
    runSearch(query, true);
  }

  async function generateEmails() {
    if (!resolved) return;
    setError(null);
    setGenerating(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: resolved,
          role,
          jobDescription: jd,
          promptInstructions: instructions,
          templateId: templateSel || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generation failed.");
      setTemplates(data.variants);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  function editTemplate(variant: Variant, field: keyof Email, value: string) {
    setTemplates((prev) => (prev ? { ...prev, [variant]: { ...prev[variant], [field]: value } } : prev));
  }

  // ── prompt presets + saved templates (shared library, data/templates.json) ──

  async function mutateLibrary(method: "POST" | "DELETE", payload: unknown) {
    const res = await fetch("/api/templates", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Template library update failed.");
    onLibraryChange({ presets: data.presets ?? [], templates: data.templates ?? [] });
    return data as Library;
  }

  function pickPreset(id: string) {
    setPresetSel(id);
    const preset = library.presets.find((p) => p.id === id);
    if (preset) setInstructions(preset.instructions);
  }

  async function saveAsPreset() {
    const name = window.prompt("Preset name (an existing name is overwritten):");
    if (!name?.trim()) return;
    setError(null);
    try {
      const lib = await mutateLibrary("POST", { kind: "preset", name, instructions });
      const saved = lib.presets.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
      if (saved) setPresetSel(saved.id);
    } catch (err: any) {
      setError(err.message);
    }
  }

  // Saved templates are stored with {company}/{role} placeholders; the server
  // merges them back for whichever company the template is used on next.
  function tokenize(text: string): string {
    let out = text;
    if (resolved?.name) out = out.split(resolved.name).join("{company}");
    if (role.trim()) out = out.split(role.trim()).join("{role}");
    return out;
  }

  async function saveAsTemplate() {
    if (!templates) return;
    const name = window.prompt("Template name (an existing name is overwritten):");
    if (!name?.trim()) return;
    setError(null);
    try {
      await mutateLibrary("POST", {
        kind: "template",
        name,
        variants: {
          recruiter: { subject: tokenize(templates.recruiter.subject), body: tokenize(templates.recruiter.body) },
          engineering: { subject: tokenize(templates.engineering.subject), body: tokenize(templates.engineering.body) },
        },
      });
    } catch (err: any) {
      setError(err.message);
    }
  }

  // Hand-written template from the inline editor: one example email, stored as
  // both variants — the AUDIENCE line in the adapt prompt handles the
  // recruiter-vs-engineering tone difference at generation time.
  async function saveNewTemplate() {
    if (!newTpl) return;
    const name = window.prompt("Template name (an existing name is overwritten):");
    if (!name?.trim()) return;
    setError(null);
    try {
      const variant = { subject: tokenize(newTpl.subject), body: tokenize(newTpl.body) };
      const lib = await mutateLibrary("POST", {
        kind: "template",
        name,
        variants: { recruiter: variant, engineering: { ...variant } },
      });
      const saved = lib.templates.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
      if (saved) setTemplateSel(saved.id);
      setNewTpl(null);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function deleteSaved(kind: "preset" | "template", id: string) {
    const list = kind === "preset" ? library.presets : library.templates;
    const name = list.find((x) => x.id === id)?.name ?? "this item";
    if (!window.confirm(`Delete ${kind} "${name}"? This can't be undone.`)) return;
    setError(null);
    try {
      await mutateLibrary("DELETE", { kind, id });
      if (kind === "preset" && presetSel === id) setPresetSel("");
      if (kind === "template" && templateSel === id) setTemplateSel("");
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function createDrafts() {
    if (!resolved || !templates || selected.size === 0) return;
    setError(null);
    setDrafting(true);
    setResults({});
    setSentIds(new Set());
    try {
      const people = candidates
        .filter((c) => selected.has(c.id))
        .map((c) => ({
          id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          title: c.title,
          variant: classifyVariant(c.title),
          source: c.source,
          email: c.email,
          confidence: c.confidence,
        }));

      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: { name: resolved.name, domain: resolved.domain },
          role,
          people,
          templates,
          resumePath: effectiveResume,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Drafting failed.");
      }
      if (!res.body) throw new Error("No response stream.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const r = JSON.parse(line) as ResultLine;
          setResults((prev) => ({ ...prev, [r.id]: r }));
        }
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDrafting(false);
    }
  }

  async function send(draftIds: string[]) {
    if (draftIds.length === 0) return;
    setError(null);
    setSending((prev) => new Set([...prev, ...draftIds]));
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Send failed.");
      const okIds: string[] = (data.results ?? []).filter((r: any) => r.ok).map((r: any) => r.draftId);
      const failed = (data.results ?? []).filter((r: any) => !r.ok);
      if (okIds.length) setSentIds((prev) => new Set([...prev, ...okIds]));
      if (failed.length) setError(`Failed to send ${failed.length}: ${failed[0].error}`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSending((prev) => {
        const next = new Set(prev);
        draftIds.forEach((id) => next.delete(id));
        return next;
      });
    }
  }

  return (
    <>
      {error && <div className="error-box">{error}</div>}

      {/* 1 — search inputs */}
      <form className="card" onSubmit={findPeople}>
        <div className="row">
          <label htmlFor="company">Company name or domain</label>
          <input
            id="company"
            value={company}
            onChange={(e) => {
              setCompany(e.target.value);
              onTitle(e.target.value);
            }}
            placeholder="Acme AI  (or acme.com)"
            required
          />
        </div>
        <div className="row">
          <label htmlFor="role">Role you applied to</label>
          <input
            id="role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Software Engineer (Toronto)"
            required
          />
        </div>
        <div className="row">
          <label htmlFor="country">Location (country)</label>
          <select id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label htmlFor="jd">Job description (pasted from the posting — used to pick people and personalize)</label>
          <textarea
            id="jd"
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            placeholder="Paste the JD here. Found people get ranked against it (best fits pre-selected), and the personalization line references what this role actually needs."
          />
        </div>
        <div className="row">
          <label htmlFor="resume">Resume to attach (PDF)</label>
          {resumes.length === 0 ? (
            <p className="meta">
              No PDFs found under your resume folder — using the profile default. Edit <code>resumeDir</code>{" "}
              in <code>src/profile.ts</code>.
            </p>
          ) : (
            <select id="resume" value={effectiveResume} onChange={(e) => setResumePath(e.target.value)}>
              {effectiveResume && !resumes.some((r) => r.path === effectiveResume) && (
                <option value={effectiveResume}>{effectiveResume.split("/").pop()} (current)</option>
              )}
              {resumes.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <button type="submit" disabled={searching}>
          {searching && <span className="spinner" />}
          {searching ? "Searching…" : "Find people"}
        </button>
      </form>

      {/* 2 — people + generate */}
      {resolved && (
        <div className="card">
          <div className="toolbar">
            <div>
              <strong>{resolved.name}</strong>
              {resolved.domain && <span className="meta" style={{ marginLeft: 8 }}>{resolved.domain}</span>}
              {searchSource === "hunter" && candidates.length > 0 && (
                <span className="hunter-note">· via Hunter (Apollo found no one)</span>
              )}
              {companyOptions.length > 1 && (
                <div className="company-switch">
                  <span className="meta">Wrong company?</span>
                  <select
                    value={resolved.orgId ?? ""}
                    onChange={(e) => {
                      const opt = companyOptions.find((o) => o.orgId === e.target.value);
                      if (opt) pickCompany(opt);
                    }}
                  >
                    {companyOptions.map((o) => (
                      <option key={o.orgId ?? o.domain ?? o.name} value={o.orgId ?? ""}>
                        {o.name}
                        {o.domain ? ` · ${o.domain}` : ""}
                        {o.employees ? ` · ${o.employees.toLocaleString()} ppl` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="meta">
                {candidates.length} reachable{totalFound > candidates.length ? ` of ${totalFound} found` : ""} ·{" "}
                {selected.size} selected
                {selected.size > 0 && ` (${selectedByVariant.recruiter} recruiter, ${selectedByVariant.engineering} eng)`}
                {jdRanked && " · ranked by JD match, best fits pre-selected"}
              </div>
            </div>
            {candidates.length > 0 && (
              <button type="button" className="ghost" onClick={toggleAll}>
                {allSelected ? "Clear all" : "Select all"}
              </button>
            )}
          </div>

          {candidates.length === 0 ? (
            <p className="meta">
              No reachable contacts found for <strong>{resolved.domain ?? resolved.name}</strong>
              {country !== "any" ? <> in <strong>{COUNTRY_OPTIONS.find((o) => o.value === country)?.label}</strong></> : null}. Try
              widening the country to <strong>Any country</strong>, or — if the domain looks wrong — enter
              the company&apos;s website domain directly (e.g. <code>feathery.io</code>) instead of its name.
            </p>
          ) : (
            <div className="list">
              {candidates.map((c) => (
                <label className="person" key={c.id}>
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    disabled={drafting}
                  />
                  <span className="name">{c.firstName}{c.lastName ? ` ${c.lastName}` : ""}</span>
                  <span className="title">— {c.title || "—"}</span>
                  {c.source === "hunter" && c.email && <span className="title">({c.email})</span>}
                  {c.fit && <span className="title">· {c.fit.reason}</span>}
                  {c.fit && (
                    <span className={`tag fit-${c.fit.priority}`}>
                      {c.fit.priority === "high" ? "★ strong match" : "match"}
                    </span>
                  )}
                  <span
                    className={`tag ${classifyVariant(c.title)}`}
                    style={c.fit ? { marginLeft: 0 } : undefined}
                  >
                    {VARIANT_LABEL[classifyVariant(c.title)]}
                  </span>
                </label>
              ))}
            </div>
          )}

          {candidates.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="row">
                <label>Email template (optional — an example email Claude adapts to this company)</label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select
                    value={templateSel}
                    onChange={(e) => {
                      setTemplateSel(e.target.value);
                      setNewTpl(null);
                    }}
                  >
                    <option value="">— no template (Claude writes from scratch) —</option>
                    {library.templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="ghost" onClick={() => setNewTpl({ subject: "", body: "" })}>
                    New template…
                  </button>
                  {templateSel && (
                    <button type="button" className="ghost" onClick={() => deleteSaved("template", templateSel)}>
                      Delete template
                    </button>
                  )}
                </div>
                {newTpl && (
                  <div className="editor" style={{ marginTop: 8 }}>
                    <div className="editor-head">
                      <strong>New template</strong>
                      <span className="meta">
                        Write an example email. No greeting line — “Hi [First name],” is added per person. Use{" "}
                        {"{company}"} and {"{role}"} as placeholders; Claude rewrites the company-specific parts for
                        each company you use it on.
                      </span>
                    </div>
                    <label>Subject</label>
                    <input
                      value={newTpl.subject}
                      onChange={(e) => setNewTpl({ ...newTpl, subject: e.target.value })}
                      placeholder="{role} application — Jane Doe (recent CS grad)"
                    />
                    <label style={{ marginTop: 10 }}>Body</label>
                    <textarea
                      className="body-editor"
                      value={newTpl.body}
                      onChange={(e) => setNewTpl({ ...newTpl, body: e.target.value })}
                      placeholder="Write the example email body here…"
                    />
                    <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        onClick={saveNewTemplate}
                        disabled={!newTpl.subject.trim() || !newTpl.body.trim()}
                      >
                        Save template
                      </button>
                      <button type="button" className="ghost" onClick={() => setNewTpl(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="row">
                <label>Prompt instructions (optional — steer the generated emails; save as a preset to reuse)</label>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <select value={presetSel} onChange={(e) => pickPreset(e.target.value)}>
                    <option value="">— presets —</option>
                    {library.presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="ghost" onClick={saveAsPreset} disabled={!instructions.trim()}>
                    Save as preset…
                  </button>
                  {presetSel && (
                    <button type="button" className="ghost" onClick={() => deleteSaved("preset", presetSel)}>
                      Delete preset
                    </button>
                  )}
                </div>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder='e.g. "Keep it under 120 words" or "Mention my Next.js side project". Wins over the built-in rules when they conflict.'
                />
              </div>
              <button type="button" onClick={generateEmails} disabled={generating || selected.size === 0}>
                {generating && <span className="spinner" />}
                {generating
                  ? "Generating…"
                  : templates
                    ? "Regenerate emails"
                    : templateSel
                      ? "Generate from template"
                      : "Generate emails"}
              </button>
              <span className="meta" style={{ marginLeft: 12 }}>
                2 Claude calls for the whole company (free of Apollo credits).
              </span>
            </div>
          )}
        </div>
      )}

      {/* 3 — editable templates */}
      {templates && (
        <div className="card">
          <div className="toolbar">
            <strong>Edit the two emails</strong>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span className="meta">Greeting “Hi [First name],” is added per person automatically.</span>
              <button type="button" className="ghost" onClick={saveAsTemplate}>
                Save as template…
              </button>
            </div>
          </div>
          {(["recruiter", "engineering"] as Variant[]).map((v) => (
            <div className="editor" key={v}>
              <div className="editor-head">
                <span className={`tag ${v}`}>{VARIANT_LABEL[v]}</span>
                <span className="meta">{selectedByVariant[v]} selected will get this</span>
              </div>
              <label>Subject</label>
              <input value={templates[v].subject} onChange={(e) => editTemplate(v, "subject", e.target.value)} />
              <label style={{ marginTop: 10 }}>Body (after “Hi [First name],”)</label>
              <textarea
                className="body-editor"
                value={templates[v].body}
                onChange={(e) => editTemplate(v, "body", e.target.value)}
              />
            </div>
          ))}
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={createDrafts} disabled={drafting || selected.size === 0}>
              {drafting && <span className="spinner" />}
              {drafting ? "Creating drafts…" : `Create drafts (${selected.size})`}
            </button>
            <span className="meta" style={{ marginLeft: 12 }}>
              1 Apollo credit per person. Nothing is sent yet.
            </span>
          </div>
        </div>
      )}

      {/* 4 — results + send */}
      {Object.keys(results).length > 0 && (
        <div className="card">
          <div className="toolbar">
            <strong>Results</strong>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {unsentDraftIds.length > 0 && (
                <button type="button" onClick={() => send(unsentDraftIds)} disabled={sending.size > 0}>
                  {sending.size > 0 && <span className="spinner" />}
                  Send all ({unsentDraftIds.length})
                </button>
              )}
              {draftedRows.length > 0 && (
                <a className="footer-link" href={GMAIL_DRAFTS} target="_blank" rel="noreferrer">
                  Open Gmail Drafts ↗
                </a>
              )}
            </div>
          </div>
          {Object.values(results).map((r) => {
            const sent = r.draftId ? sentIds.has(r.draftId) : false;
            const isSending = r.draftId ? sending.has(r.draftId) : false;
            return (
              <div className="result" key={r.id}>
                <div className="head">
                  <span className={`badge ${sent ? "sent" : r.status}`}>
                    {sent ? "✓ sent" : r.status === "drafted" ? "✓ drafted" : r.status === "skipped" ? "skipped" : "error"}
                  </span>
                  <strong>{r.name ?? r.id}</strong>
                  {r.title && <span className="title">— {r.title}</span>}
                  {r.status === "drafted" && r.draftId && !sent && (
                    <button
                      type="button"
                      className="ghost send-btn"
                      onClick={() => send([r.draftId!])}
                      disabled={isSending}
                    >
                      {isSending ? "Sending…" : "Send"}
                    </button>
                  )}
                </div>
                {r.email && (
                  <div className="subject">
                    {r.email}
                    {r.emailSource === "hunter" && (
                      <span className="hunter-note">
                        · found by Hunter{typeof r.emailScore === "number" ? ` · ${r.emailScore}%` : ""}
                      </span>
                    )}
                  </div>
                )}
                {r.reason && <div className="subject">{r.reason}</div>}
                {r.subject && <div className="subject">Subject: {r.subject}</div>}
                {r.status === "drafted" && r.resumeAttached === false && (
                  <div className="subject resume-warn">⚠ resume file not found — drafted WITHOUT attachment</div>
                )}
                {r.bodyPreview && (
                  <details>
                    <summary>Preview email</summary>
                    <pre>{r.bodyPreview}</pre>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

interface Tab {
  id: number;
  title: string;
}

interface TabsSnapshot {
  tabs: Tab[];
  activeId: number;
  nextId: number;
}

// Shell that lets you work several companies at once. Each tab is an independent
// CompanyWorkspace; inactive tabs stay MOUNTED (hidden via CSS) so their state and
// any in-flight drafting/sending survive switching tabs. The tab list and each
// workspace persist to localStorage, so a refresh restores everything.
export default function Page() {
  const nextId = useRef(2);
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, title: "New company" }]);
  const [activeId, setActiveId] = useState(1);
  const [hydrated, setHydrated] = useState(false);
  const [resumes, setResumes] = useState<ResumeFile[]>([]);
  const [defaultResume, setDefaultResume] = useState("");
  const [library, setLibrary] = useState<Library>({ presets: [], templates: [] });

  // Fetch the available resume PDFs once (shared by every tab).
  useEffect(() => {
    fetch("/api/resumes")
      .then((r) => r.json())
      .then((d) => {
        setResumes(d.resumes ?? []);
        setDefaultResume(d.default ?? "");
      })
      .catch(() => {});
  }, []);

  // Fetch the preset/template library once (shared by every tab; mutations
  // return the updated store, which workspaces push back via onLibraryChange).
  useEffect(() => {
    fetch("/api/templates")
      .then((r) => r.json())
      .then((d) => setLibrary({ presets: d.presets ?? [], templates: d.templates ?? [] }))
      .catch(() => {});
  }, []);

  // Restore tabs after mount (localStorage isn't available during SSR / first paint).
  useEffect(() => {
    const saved = loadJSON<TabsSnapshot>(TABS_KEY);
    if (saved?.tabs?.length) {
      setTabs(saved.tabs);
      setActiveId(saved.tabs.some((t) => t.id === saved.activeId) ? saved.activeId : saved.tabs[0].id);
      nextId.current = saved.nextId ?? Math.max(...saved.tabs.map((t) => t.id)) + 1;
    }
    setHydrated(true);
  }, []);

  // Persist the tab list — only after restore, so we never clobber it on mount.
  useEffect(() => {
    if (!hydrated) return;
    saveJSON(TABS_KEY, { tabs, activeId, nextId: nextId.current } satisfies TabsSnapshot);
  }, [hydrated, tabs, activeId]);

  function addTab() {
    const id = nextId.current++;
    setTabs((t) => [...t, { id, title: "New company" }]);
    setActiveId(id);
  }

  function setTitle(id: number, title: string) {
    setTabs((t) => t.map((x) => (x.id === id ? { ...x, title } : x)));
  }

  function closeTab(id: number) {
    removeKey(wsKey(id));
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        const fresh = { id: nextId.current++, title: "New company" };
        setActiveId(fresh.id);
        return [fresh];
      }
      setActiveId((cur) => (cur === id ? next[Math.max(0, idx - 1)].id : cur));
      return next;
    });
  }

  function clearAll() {
    if (!window.confirm("Clear all tabs and saved data? This can't be undone.")) return;
    clearStorage();
    const fresh = { id: nextId.current++, title: "New company" };
    setTabs([fresh]);
    setActiveId(fresh.id);
  }

  return (
    <div className="wrap">
      <div className="tabbar">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeId ? "active" : ""}`}
            onClick={() => setActiveId(t.id)}
          >
            <span className="tab-label">{t.title || "New company"}</span>
            {tabs.length > 1 && (
              <button
                type="button"
                className="tab-close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button type="button" className="tab-add" title="New company tab" onClick={addTab}>
          +
        </button>
        <button type="button" className="tab-clear" title="Clear all tabs & saved data" onClick={clearAll}>
          Clear all
        </button>
      </div>

      {hydrated &&
        tabs.map((t) => (
          <div key={t.id} style={{ display: t.id === activeId ? "block" : "none" }}>
            <CompanyWorkspace
              storageKey={wsKey(t.id)}
              onTitle={(title) => setTitle(t.id, title)}
              resumes={resumes}
              defaultResume={defaultResume}
              library={library}
              onLibraryChange={setLibrary}
            />
          </div>
        ))}
    </div>
  );
}
