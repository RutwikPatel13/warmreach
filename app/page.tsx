"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CreditMeter } from "./_components/credits";

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
  source?: "apollo" | "hunter" | "careers";
  email?: string | null;
  confidence?: number | null;
  fit?: Fit | null;
}

// Role-targeting groups — ids match TITLE_GROUPS keys in src/apollo.ts so the
// server expands them to the right person_titles. All three preselected by default.
const ROLE_GROUPS: { id: string; label: string }[] = [
  { id: "founders", label: "Founders / C-level" },
  { id: "engineering", label: "Engineering leaders" },
  { id: "recruiters", label: "Recruiters / Talent" },
];

interface ResolvedCompany {
  name: string;
  domain: string | null;
  orgId: string | null;
  description: string | null;
  keywords: string[];
  logoUrl?: string | null;
}

interface CompanyOption {
  name: string;
  domain: string | null;
  orgId: string | null;
  employees: number | null;
  logoUrl?: string | null;
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

type Theme = "light" | "dark";

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

// ── scheduled send ──────────────────────────────────────────────────────────
// Mirror of the server ScheduledSend shape (src/scheduler.ts). Gmail's API can't
// schedule a send, so the app holds each message as a real Gmail draft and the
// running server sends it at sendAt.
interface ScheduledSend {
  id: string;
  draftId: string;
  to?: string | null;
  name?: string;
  subject?: string;
  sendAt: string; // ISO instant
  status: "pending" | "sent" | "failed" | "canceled";
  createdAt: string;
  sentAt?: string;
  messageId?: string;
  error?: string;
}

interface SchedulePreset {
  label: string;
  date: Date;
}

// The viewer's timezone, spelled out like Gmail ("Pacific Daylight Time").
function localTimeZoneLabel(): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "long" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

// "Jul 24, 8:00 AM" in the viewer's locale + timezone.
function formatSendAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Gmail-style quick picks, computed from now and filtered to future instants.
function schedulePresets(now = new Date()): SchedulePreset[] {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const tomorrowMorning = at(1, 8);
  const tomorrowAfternoon = at(1, 13);
  // The next Monday strictly after today (if today is Monday, a week out).
  const daysToMonday = (1 - now.getDay() + 7) % 7 || 7;
  const mondayMorning = at(daysToMonday, 8);
  const weekday = mondayMorning.toLocaleDateString(undefined, { weekday: "long" });

  const out: SchedulePreset[] = [
    { label: "Tomorrow morning", date: tomorrowMorning },
    { label: "Tomorrow afternoon", date: tomorrowAfternoon },
  ];
  // Skip the Monday pick when "tomorrow" already is Monday (avoids a duplicate).
  if (mondayMorning.toDateString() !== tomorrowMorning.toDateString()) {
    out.push({ label: `${weekday} morning`, date: mondayMorning });
  }
  return out.filter((p) => p.date.getTime() > now.getTime());
}

// A Date -> the value a <input type="datetime-local"> expects (local wall time).
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

// ── localStorage persistence (SSR-safe) ─────────────────────────────────────
const NS = "warmreach:v1:";
const TABS_KEY = NS + "tabs";
const THEME_KEY = NS + "theme";
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
// Durable per-workspace state — transient flags (spinners, in-flight errors) are
// intentionally NOT persisted; they reset to idle on reload.
interface WorkspaceSnapshot {
  company: string;
  role: string;
  jd: string;
  groups?: string[];
  customTitles?: string;
  allPeople?: boolean;
  wantCareers?: boolean;
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

// Gmail-style "Schedule send" popover: three quick picks plus a custom
// date/time. Calls onSchedule with an absolute ISO instant; the parent decides
// which draft(s) it applies to.
function ScheduleMenu({
  onSchedule,
  disabled,
  label = "Schedule",
  align = "right",
}: {
  onSchedule: (iso: string) => void | Promise<void>;
  disabled?: boolean;
  label?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [customVal, setCustomVal] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const tz = useMemo(() => localTimeZoneLabel(), []);
  const presets = useMemo(() => schedulePresets(), [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function choose(iso: string) {
    setOpen(false);
    setCustom(false);
    onSchedule(iso);
  }

  return (
    <div className="sched" ref={ref}>
      <button
        type="button"
        className="ghost sched-caret"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setCustom(false);
          setCustomVal(toLocalInputValue(schedulePresets()[0]?.date ?? new Date(Date.now() + 3_600_000)));
          setOpen((o) => !o);
        }}
      >
        {label} ▾
      </button>
      {open && (
        <div className={`sched-menu ${align}`} role="menu">
          <div className="sched-head">Schedule send</div>
          {tz && <div className="sched-tz">{tz}</div>}
          {!custom ? (
            <>
              {presets.map((p) => (
                <button
                  type="button"
                  key={p.label}
                  className="sched-opt"
                  role="menuitem"
                  onClick={() => choose(p.date.toISOString())}
                >
                  <span className="sched-opt-label">{p.label}</span>
                  <span className="sched-opt-time">{formatSendAt(p.date.toISOString())}</span>
                </button>
              ))}
              <button type="button" className="sched-opt sched-custom" onClick={() => setCustom(true)}>
                <span className="sched-opt-label">Pick date &amp; time…</span>
              </button>
            </>
          ) : (
            <div className="sched-picker">
              <input
                type="datetime-local"
                value={customVal}
                min={toLocalInputValue(new Date())}
                onChange={(e) => setCustomVal(e.target.value)}
              />
              <div className="sched-picker-actions">
                <button type="button" className="ghost" onClick={() => setCustom(false)}>
                  Back
                </button>
                <button
                  type="button"
                  disabled={!customVal || new Date(customVal).getTime() <= Date.now()}
                  onClick={() => choose(new Date(customVal).toISOString())}
                >
                  Schedule send
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// In-app modal replacing native window.prompt / window.confirm — a text prompt
// (kind: "prompt") or a yes/no confirmation (kind: "confirm").
type DialogState =
  | {
      kind: "prompt";
      title: string;
      message?: string;
      placeholder?: string;
      defaultValue?: string;
      confirmLabel?: string;
      onSubmit: (value: string) => void;
    }
  | {
      kind: "confirm";
      title: string;
      message: string;
      confirmLabel?: string;
      danger?: boolean;
      onConfirm: () => void;
    };

function Dialog({ state, onClose }: { state: DialogState | null; onClose: () => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isPrompt = state?.kind === "prompt";

  // Seed the input from defaultValue and focus it whenever a prompt opens.
  useEffect(() => {
    if (state?.kind === "prompt") {
      setValue(state.defaultValue ?? "");
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [state]);

  // Escape closes any open dialog.
  useEffect(() => {
    if (!state) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, onClose]);

  if (!state) return null;

  const canConfirm = state.kind !== "prompt" || value.trim().length > 0;

  function submit() {
    if (!state) return;
    if (state.kind === "prompt") {
      if (!value.trim()) return;
      state.onSubmit(value.trim());
    } else {
      state.onConfirm();
    }
    onClose();
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={state.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-title">{state.title}</div>
        {state.message && <div className="modal-msg">{state.message}</div>}
        {isPrompt && (
          <input
            ref={inputRef}
            value={value}
            placeholder={"placeholder" in state ? state.placeholder : undefined}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        )}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={state.kind === "confirm" && state.danger ? "danger" : undefined}
            disabled={!canConfirm}
            onClick={submit}
          >
            {state.confirmLabel ?? (isPrompt ? "Save" : "Confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Company logo from Apollo (free — comes with the resolved org). Falls back to a
// monogram when there's no logo or the image fails to load.
function CompanyLogo({ name, logoUrl }: { name: string; logoUrl?: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [logoUrl]); // retry when the company changes
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  if (logoUrl && !failed) {
    return (
      <img className="co-logo" src={logoUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
    );
  }
  return (
    <span className="co-logo co-logo--mono" aria-hidden="true">
      {initial}
    </span>
  );
}

// "Wrong company?" disambiguation for name searches (e.g. several "Nuna"s). A
// native <select> can't render images, so this is a custom dropdown showing each
// match's LOGO + name + domain + headcount — pick by recognizing the logo even
// when you don't know the exact domain. Closes on outside click / Escape.
function CompanySwitch({
  options,
  currentOrgId,
  onPick,
}: {
  options: CompanyOption[];
  currentOrgId: string | null;
  onPick: (o: CompanyOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.orgId === currentOrgId) ?? options[0];
  const sub = (o: CompanyOption) =>
    `${o.domain ?? "no domain"}${o.employees ? ` · ${o.employees.toLocaleString()} ppl` : ""}`;

  return (
    <div className="co-switch" ref={ref}>
      <span className="meta">Wrong company?</span>
      <button
        type="button"
        className="co-switch-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <CompanyLogo name={current?.name ?? "?"} logoUrl={current?.logoUrl} />
        <span className="co-switch-name">{current?.name ?? "Pick a match"}</span>
        <span className="co-switch-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="co-switch-menu" role="listbox">
          {options.map((o) => (
            <button
              type="button"
              key={o.orgId ?? o.domain ?? o.name}
              role="option"
              aria-selected={o.orgId === currentOrgId}
              className={`co-switch-opt ${o.orgId === currentOrgId ? "on" : ""}`}
              onClick={() => {
                onPick(o);
                setOpen(false);
              }}
            >
              <CompanyLogo name={o.name} logoUrl={o.logoUrl} />
              <span className="co-switch-opt-main">
                <span className="co-switch-opt-name">{o.name}</span>
                <span className="co-switch-opt-sub">{sub(o)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CompanyWorkspace({
  storageKey,
  onTitle,
  onIdentity,
  onStage,
  resumes,
  defaultResume,
  library,
  onLibraryChange,
  lifetime,
}: {
  storageKey: string;
  onTitle: (title: string) => void;
  onIdentity: (info: { name: string; logoUrl?: string | null }) => void;
  onStage: (stage: number) => void;
  resumes: ResumeFile[];
  defaultResume: string;
  library: Library;
  onLibraryChange: (lib: Library) => void;
  lifetime: OutreachStats | null;
}) {
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [jd, setJd] = useState("");
  const [groupSel, setGroupSel] = useState<Set<string>>(new Set(["founders", "engineering", "recruiters"]));
  const [customTitles, setCustomTitles] = useState("");
  const [allPeople, setAllPeople] = useState(false); // "Everyone at the company" — ignore role targeting
  const [wantCareers, setWantCareers] = useState(false); // add careers@/jobs@/recruiting@ inbox rows
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
  const [editingSearch, setEditingSearch] = useState(false); // reopen the collapsed search form (transient)
  const [peopleOpen, setPeopleOpen] = useState(true); // collapse/expand the People list (transient)
  const [dialog, setDialog] = useState<DialogState | null>(null); // in-app prompt / confirm

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
      setGroupSel(new Set(snap.groups ?? ["founders", "engineering", "recruiters"]));
      setCustomTitles(snap.customTitles ?? "");
      setAllPeople(snap.allPeople === true);
      setWantCareers(snap.wantCareers === true);
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
      groups: [...groupSel],
      customTitles,
      allPeople,
      wantCareers,
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
    groupSel,
    customTitles,
    allPeople,
    wantCareers,
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
  const sentCount = draftedRows.length - unsentDraftIds.length; // drafted rows whose draft is in sentIds

  // Which of the four stages (Find → Write → Draft → Send) this workspace is on —
  // drives both the header spine and the sidebar's progress dots.
  const hasResults = Object.keys(results).length > 0;
  const allSent = draftedRows.length > 0 && draftedRows.every((r) => sentIds.has(r.draftId!));
  const currentStep = !resolved ? 1 : !templates ? 2 : !hasResults ? 3 : 4;

  // Report stage upward without re-running on every parent render: a ref holds the
  // latest callback, and the effect only fires when the computed stage changes.
  const onStageRef = useRef(onStage);
  onStageRef.current = onStage;
  useEffect(() => {
    onStageRef.current(allSent ? 5 : currentStep);
  }, [currentStep, allSent]);

  // Push the resolved company's clean name + logo up to the sidebar tab, so the
  // workspace list shows "Happenstance" with its logo instead of the raw typed
  // "https://happenstance.ai". Fires on search-resolve and on hydrate-restore
  // (each tab restores its own persisted `resolved`), so existing tabs update too.
  const onIdentityRef = useRef(onIdentity);
  onIdentityRef.current = onIdentity;
  useEffect(() => {
    if (resolved?.name) onIdentityRef.current({ name: resolved.name, logoUrl: resolved.logoUrl });
  }, [resolved]);

  // ── scheduled sends (server-backed store, data/scheduled.json) ────────────
  const [scheduledList, setScheduledList] = useState<ScheduledSend[]>([]);

  // /api/schedule returns every scheduled send (all tabs); scope to this tab's
  // drafts so a tab only ever shows / reconciles its own.
  const myDraftIds = useMemo(
    () => new Set(Object.values(results).map((r) => r.draftId).filter(Boolean) as string[]),
    [results],
  );
  const pendingByDraft = useMemo(() => {
    const m: Record<string, ScheduledSend> = {};
    for (const s of scheduledList) if (s.status === "pending" && myDraftIds.has(s.draftId)) m[s.draftId] = s;
    return m;
  }, [scheduledList, myDraftIds]);
  // Unsent drafts not already scheduled — what the batch "Schedule" targets.
  const schedulableAll = unsentDraftIds.filter((id) => !pendingByDraft[id]);

  const refreshScheduled = useCallback(async () => {
    try {
      const res = await fetch("/api/schedule");
      if (!res.ok) return;
      const data = await res.json();
      setScheduledList(data.scheduled ?? []);
    } catch {
      /* best-effort status poll — ignore */
    }
  }, []);

  // Poll while this tab has drafts, so a send fired by the server sweep (or from
  // another tab) surfaces here without a manual refresh.
  useEffect(() => {
    if (!hydrated || draftedRows.length === 0) return;
    refreshScheduled();
    const t = setInterval(refreshScheduled, 30_000);
    return () => clearInterval(t);
  }, [hydrated, draftedRows.length, refreshScheduled]);

  // Reconcile scheduler outcomes into this tab: sent → mark the draft sent,
  // failed → surface the reason once.
  useEffect(() => {
    const mine = scheduledList.filter((s) => myDraftIds.has(s.draftId));
    const sent = mine.filter((s) => s.status === "sent").map((s) => s.draftId);
    if (sent.length) {
      setSentIds((prev) => {
        if (sent.every((id) => prev.has(id))) return prev;
        const next = new Set(prev);
        sent.forEach((id) => next.add(id));
        return next;
      });
    }
    const failed = mine.find((s) => s.status === "failed");
    if (failed) {
      setError((e) => e ?? `Scheduled send failed for ${failed.name ?? "a draft"}: ${failed.error ?? "unknown error"}`);
    }
  }, [scheduledList, myDraftIds]);

  async function scheduleSend(draftIds: string[], sendAtIso: string) {
    if (draftIds.length === 0) return;
    setError(null);
    const items = draftIds.map((draftId) => {
      const row = draftedRows.find((r) => r.draftId === draftId);
      return { draftId, to: row?.email ?? null, name: row?.name, subject: row?.subject };
    });
    try {
      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, sendAt: sendAtIso }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Scheduling failed.");
      setScheduledList(data.scheduled ?? []);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function cancelSchedule(id: string) {
    setError(null);
    try {
      const res = await fetch("/api/schedule", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cancel failed.");
      setScheduledList(data.scheduled ?? []);
    } catch (err: any) {
      setError(err.message);
    }
  }

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
          groups: [...groupSel],
          customTitles: customTitles.split(",").map((s) => s.trim()).filter(Boolean),
          all: allPeople,
          careers: wantCareers,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed.");
      setResolved(data.company);
      setEditingSearch(false); // collapse the form back into its summary once people are found
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

  function saveAsPreset() {
    if (!instructions.trim()) return;
    setDialog({
      kind: "prompt",
      title: "Save preset",
      message: "Reuse these prompt instructions later. An existing name is overwritten.",
      placeholder: "e.g. Short & punchy",
      confirmLabel: "Save preset",
      onSubmit: async (name) => {
        setError(null);
        try {
          const lib = await mutateLibrary("POST", { kind: "preset", name, instructions });
          const saved = lib.presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
          if (saved) setPresetSel(saved.id);
        } catch (err: any) {
          setError(err.message);
        }
      },
    });
  }

  // Saved templates are stored with {company}/{role} placeholders; the server
  // merges them back for whichever company the template is used on next.
  function tokenize(text: string): string {
    let out = text;
    if (resolved?.name) out = out.split(resolved.name).join("{company}");
    if (role.trim()) out = out.split(role.trim()).join("{role}");
    return out;
  }

  function saveAsTemplate() {
    if (!templates) return;
    const t = templates;
    setDialog({
      kind: "prompt",
      title: "Save as template",
      message: "Save these two emails as a reusable template. An existing name is overwritten.",
      placeholder: "e.g. New-grad intro",
      confirmLabel: "Save template",
      onSubmit: async (name) => {
        setError(null);
        try {
          await mutateLibrary("POST", {
            kind: "template",
            name,
            variants: {
              recruiter: { subject: tokenize(t.recruiter.subject), body: tokenize(t.recruiter.body) },
              engineering: { subject: tokenize(t.engineering.subject), body: tokenize(t.engineering.body) },
            },
          });
        } catch (err: any) {
          setError(err.message);
        }
      },
    });
  }

  // Hand-written template from the inline editor: one example email, stored as
  // both variants — the AUDIENCE line in the adapt prompt handles the
  // recruiter-vs-engineering tone difference at generation time.
  function saveNewTemplate() {
    if (!newTpl) return;
    const tpl = newTpl;
    setDialog({
      kind: "prompt",
      title: "Save template",
      message: "Name this template so you can reuse it. An existing name is overwritten.",
      placeholder: "e.g. Referral ask",
      confirmLabel: "Save template",
      onSubmit: async (name) => {
        setError(null);
        try {
          const variant = { subject: tokenize(tpl.subject), body: tokenize(tpl.body) };
          const lib = await mutateLibrary("POST", {
            kind: "template",
            name,
            variants: { recruiter: variant, engineering: { ...variant } },
          });
          const saved = lib.templates.find((t) => t.name.toLowerCase() === name.toLowerCase());
          if (saved) setTemplateSel(saved.id);
          setNewTpl(null);
        } catch (err: any) {
          setError(err.message);
        }
      },
    });
  }

  function deleteSaved(kind: "preset" | "template", id: string) {
    const list = kind === "preset" ? library.presets : library.templates;
    const name = list.find((x) => x.id === id)?.name ?? "this item";
    setDialog({
      kind: "confirm",
      title: `Delete ${kind}`,
      message: `Delete “${name}”? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        setError(null);
        try {
          await mutateLibrary("DELETE", { kind, id });
          if (kind === "preset" && presetSel === id) setPresetSel("");
          if (kind === "template" && templateSel === id) setTemplateSel("");
        } catch (err: any) {
          setError(err.message);
        }
      },
    });
  }

  async function createDrafts() {
    if (!resolved || !templates || selected.size === 0) return;
    setError(null);
    setDrafting(true);
    // Remember the previous run's drafts so this run EDITS them in place instead
    // of piling up duplicates: the server updates each existing Gmail draft —
    // keeping its id, and any scheduled send tied to it — rather than making a
    // new one. (The server also falls back to the log to find a draft from an
    // earlier session if this tab no longer holds the id.)
    const priorDraftByPerson: Record<string, string> = {};
    for (const r of Object.values(results)) if (r.draftId) priorDraftByPerson[r.id] = r.draftId;
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
          replaceDraftId: priorDraftByPerson[c.id],
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
    // If any of these were scheduled, cancel first so the sweep doesn't later
    // try to re-send an already-gone draft (which would look like a failure).
    const pendingSchedules = draftIds.map((id) => pendingByDraft[id]).filter(Boolean) as ScheduledSend[];
    if (pendingSchedules.length) {
      void Promise.all(
        pendingSchedules.map((s) =>
          fetch("/api/schedule", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: s.id }),
          }),
        ),
      ).then(refreshScheduled);
    }
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
      {/* company header + Find → Write → Draft → Send progress spine */}
      <div className="main-top">
        <div className="main-co">
          {resolved && <CompanyLogo name={resolved.name} logoUrl={resolved.logoUrl} />}
          <h1>{resolved?.name || company || "New company"}</h1>
          {resolved?.domain && <span className="dom">{resolved.domain}</span>}
        </div>
        <div className="spine" aria-label={`Step ${currentStep} of 4`}>
          {["Find", "People", "Compose", "Send"].map((stepLabel, idx) => {
            const i = idx + 1;
            const done = i < currentStep || (i === 4 && allSent);
            const now = !done && i === currentStep;
            return (
              <Fragment key={stepLabel}>
                {idx > 0 && <span className="spine-sep" aria-hidden="true" />}
                <span className={`spine-step ${done ? "done" : now ? "now" : ""}`}>
                  <span className="spine-num">{done ? "✓" : i}</span>
                  <span>{stepLabel}</span>
                </span>
              </Fragment>
            );
          })}
        </div>
      </div>

      {/* at-a-glance stats: this company once resolved, else all-time from the log */}
      {resolved ? (
        <div className="cmp-stats">
          <div className="cmp-stat"><div className="k">People found</div><div className="v tnum">{totalFound}</div></div>
          <div className="cmp-stat"><div className="k">Reachable</div><div className="v tnum">{candidates.length}</div></div>
          <div className="cmp-stat accent"><div className="k">Selected</div><div className="v tnum">{selected.size}</div></div>
          <div className="cmp-stat warn"><div className="k">Credits est.</div><div className="v tnum">{selected.size}</div></div>
          <div className="cmp-stat"><div className="k">Drafted</div><div className="v tnum">{draftedRows.length}</div></div>
          <div className="cmp-stat ok"><div className="k">Sent</div><div className="v tnum">{sentCount}</div></div>
        </div>
      ) : lifetime && lifetime.people > 0 ? (
        <>
          <div className="lifetime-cap">
            All-time outreach{lifetime.lastAt ? ` · last ${new Date(lifetime.lastAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}
          </div>
          <div className="cmp-stats">
            <div className="cmp-stat"><div className="k">Companies</div><div className="v tnum">{lifetime.companies}</div></div>
            <div className="cmp-stat"><div className="k">People reached</div><div className="v tnum">{lifetime.people}</div></div>
            <div className="cmp-stat"><div className="k">Drafts created</div><div className="v tnum">{lifetime.drafted}</div></div>
            <div className="cmp-stat accent"><div className="k">This week</div><div className="v tnum">{lifetime.thisWeek}</div></div>
          </div>
        </>
      ) : null}

      {error && <div className="error-box">{error}</div>}

      {/* 1 — search inputs (collapse to a one-line summary once people are found) */}
      {resolved && !editingSearch ? (
        <div className="done-strip">
          <span className="tick" aria-hidden="true">✓</span>
          <span className="ds-text">
            <b>{resolved.name}</b>
            {role ? ` · ${role}` : ""} · <b>{candidates.length} reachable</b>
            {totalFound > candidates.length ? ` of ${totalFound}` : ""}
            {selected.size > 0 ? ` · ${selected.size} selected` : ""}
          </span>
          <button type="button" className="ds-edit" onClick={() => setEditingSearch(true)}>
            Edit search
          </button>
        </div>
      ) : (
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
          <label>Target these roles</label>
          <div className="cmp-chips">
            {ROLE_GROUPS.map((g) => (
              <button
                type="button"
                key={g.id}
                disabled={allPeople}
                className={`cmp-chip ${groupSel.has(g.id) ? "on" : ""} ${allPeople ? "muted" : ""}`}
                onClick={() =>
                  setGroupSel((prev) => {
                    const n = new Set(prev);
                    n.has(g.id) ? n.delete(g.id) : n.add(g.id);
                    return n;
                  })
                }
              >
                {groupSel.has(g.id) ? "✓ " : ""}{g.label}
              </button>
            ))}
            <button
              type="button"
              className={`cmp-chip ${allPeople ? "on" : ""}`}
              onClick={() => setAllPeople((v) => !v)}
              title="Reach the whole team — ignores the role filters. Best for small startups."
            >
              {allPeople ? "✓ " : ""}Everyone at the company
            </button>
            <button
              type="button"
              className={`cmp-chip ${wantCareers ? "on" : ""}`}
              onClick={() => setWantCareers((v) => !v)}
              title="Also add a generic careers@ / jobs@ / recruiting@ inbox (MX-checked guess, free to draft, opt-in per row)."
            >
              {wantCareers ? "✓ " : ""}+ Careers inbox
            </button>
          </div>
          {allPeople && (
            <p className="meta">Everyone mode: role filters are ignored — the search returns all reachable people at the company (capped).</p>
          )}
        </div>
        <div className="row">
          <label htmlFor="customTitles">Custom titles (comma-sep, optional)</label>
          <input
            id="customTitles"
            value={customTitles}
            onChange={(e) => setCustomTitles(e.target.value)}
            placeholder="design lead, head of growth"
            disabled={allPeople}
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
      )}

      {/* 2 — people + generate */}
      {resolved && (
        <div className="card">
          <div className="panel-head-row">
            <div className="panel-head-main">
              <span className="step-badge">2</span>
              <div className="panel-head-text">
              <div className="panel-title">People</div>
              <div className="panel-sub">
                {candidates.length} reachable{totalFound > candidates.length ? ` of ${totalFound} found` : ""} ·{" "}
                {selected.size} selected
                {selected.size > 0 && ` (${selectedByVariant.recruiter} recruiter, ${selectedByVariant.engineering} eng)`}
                {jdRanked && " · ranked by JD match, best fits pre-selected"}
                {searchSource === "hunter" && candidates.length > 0 && (
                  <span className="hunter-note">· via Hunter (Apollo found no one)</span>
                )}
              </div>
              {companyOptions.length > 1 && (
                <CompanySwitch options={companyOptions} currentOrgId={resolved.orgId} onPick={pickCompany} />
              )}
              </div>
            </div>
            {candidates.length > 0 && (
              <div className="panel-head-actions">
                {peopleOpen && (
                  <button type="button" className="ghost btn-sm" onClick={toggleAll}>
                    {allSelected ? "Clear all" : "Select all"}
                  </button>
                )}
                <button
                  type="button"
                  className="ghost btn-sm collapse-btn"
                  onClick={() => setPeopleOpen((o) => !o)}
                  aria-expanded={peopleOpen}
                  title={peopleOpen ? "Collapse people" : "Expand people"}
                >
                  {peopleOpen ? "Collapse ▾" : "Expand ▸"}
                </button>
              </div>
            )}
          </div>

          {candidates.length === 0 ? (
            <p className="meta">
              No reachable contacts found for <strong>{resolved.domain ?? resolved.name}</strong>
              {country !== "any" ? <> in <strong>{COUNTRY_OPTIONS.find((o) => o.value === country)?.label}</strong></> : null}. Try
              widening the country to <strong>Any country</strong>, or — if the domain looks wrong — enter
              the company&apos;s website domain directly (e.g. <code>feathery.io</code>) instead of its name.
            </p>
          ) : peopleOpen ? (
            <div className="list">
              {candidates.map((c) => (
                <label className="person" key={c.id}>
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    disabled={drafting}
                  />
                  <span className="p-main">
                    <span className="name">{c.firstName}{c.lastName ? ` ${c.lastName}` : ""}</span>
                    <span className="p-meta">
                      — {c.title || "—"}
                      {c.source === "hunter" && c.email ? ` (${c.email})` : ""}
                      {c.fit ? ` · ${c.fit.reason}` : ""}
                    </span>
                  </span>
                  <span className="p-tags">
                    {c.fit && (
                      <span className={`tag fit-${c.fit.priority}`}>
                        {c.fit.priority === "high" ? "★ strong match" : "match"}
                      </span>
                    )}
                    {c.source === "careers" ? (
                      <span className="cmp-src-pill cmp-src-pill--guess" title="Generic role inbox guessed from the domain (MX-checked, but unverified). Free to draft; may bounce — pick sparingly.">generic · guess</span>
                    ) : (
                      <span className={`tag ${classifyVariant(c.title)}`}>
                        {VARIANT_LABEL[classifyVariant(c.title)]}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {/* 2b — compose: template + instructions + generate, as its own step */}
      {resolved && candidates.length > 0 && (
        <div className="card">
          <div className="panel-head-row">
            <div className="panel-head-main">
              <span className="step-badge">3</span>
              <div className="panel-head-text">
                <div className="panel-title">Compose</div>
                <div className="panel-sub">
                  Pick a template or write from scratch, generate, then edit the emails below.
                </div>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
              <div className="row">
                <label>Email template (optional — an example email Claude adapts to this company)</label>
                <div className="control-row">
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
                  <button type="button" className="ghost btn-sm" onClick={() => setNewTpl({ subject: "", body: "" })}>
                    New template…
                  </button>
                  {templateSel && (
                    <button
                      type="button"
                      className="ghost btn-sm"
                      onClick={() => deleteSaved("template", templateSel)}
                    >
                      Delete
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
                <div className="control-row" style={{ marginBottom: 8 }}>
                  <select value={presetSel} onChange={(e) => pickPreset(e.target.value)}>
                    <option value="">— presets —</option>
                    {library.presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="ghost btn-sm" onClick={saveAsPreset} disabled={!instructions.trim()}>
                    Save as preset…
                  </button>
                  {presetSel && (
                    <button type="button" className="ghost btn-sm" onClick={() => deleteSaved("preset", presetSel)}>
                      Delete
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
          </div>
        )}

      {/* 3 — editable templates */}
      {templates && (
        <div className="card">
          <div className="toolbar">
            <span className="panel-head-main">
              <span className="step-badge">3</span>
              <strong>Review &amp; edit the emails</strong>
            </span>
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
            <strong>Drafts &amp; sends</strong>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {unsentDraftIds.length > 0 && (
                <div className="send-split">
                  <button type="button" onClick={() => send(unsentDraftIds)} disabled={sending.size > 0}>
                    {sending.size > 0 && <span className="spinner" />}
                    Send all ({unsentDraftIds.length})
                  </button>
                  <ScheduleMenu
                    label={`Schedule (${schedulableAll.length})`}
                    disabled={sending.size > 0 || schedulableAll.length === 0}
                    onSchedule={(iso) => scheduleSend(schedulableAll, iso)}
                  />
                </div>
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
            const pending = r.draftId ? pendingByDraft[r.draftId] : undefined;
            return (
              <div className="result" key={r.id}>
                <div className="head">
                  <span className={`badge ${sent ? "sent" : r.status}`}>
                    {sent ? "✓ sent" : r.status === "drafted" ? "✓ drafted" : r.status === "skipped" ? "skipped" : "error"}
                  </span>
                  <strong>{r.name ?? r.id}</strong>
                  {r.title && <span className="title">— {r.title}</span>}
                  {r.status === "drafted" && r.draftId && !sent && (
                    pending ? (
                      <span className="sched-chip" title={`Scheduled for ${formatSendAt(pending.sendAt)}`}>
                        ⏱ {formatSendAt(pending.sendAt)}
                        <button
                          type="button"
                          className="sched-chip-x"
                          onClick={() => cancelSchedule(pending.id)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <span className="row-actions">
                        <button
                          type="button"
                          className="ghost send-btn"
                          onClick={() => send([r.draftId!])}
                          disabled={isSending}
                        >
                          {isSending ? "Sending…" : "Send"}
                        </button>
                        <ScheduleMenu
                          disabled={isSending}
                          onSchedule={(iso) => scheduleSend([r.draftId!], iso)}
                        />
                      </span>
                    )
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

      <Dialog state={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

interface Tab {
  id: number;
  title: string;
  logoUrl?: string | null; // resolved company logo for the sidebar (Apollo, free)
  stage?: number; // 1–4 (Find/Write/Draft/Send), 5 = all sent — for the sidebar dots
}

// Lifetime outreach totals (from /api/stats → data/outreach_log.csv), shown in a
// workspace before its first search so the page is never blank.
interface OutreachStats {
  companies: number;
  people: number;
  drafted: number;
  thisWeek: number;
  lastAt: string | null;
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
  const [theme, setTheme] = useState<Theme>("light");
  const [resumes, setResumes] = useState<ResumeFile[]>([]);
  const [defaultResume, setDefaultResume] = useState("");
  const [library, setLibrary] = useState<Library>({ presets: [], templates: [] });
  const [lifetime, setLifetime] = useState<OutreachStats | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);

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

  // Lifetime outreach totals for the pre-search stat strip (refreshed on mount).
  useEffect(() => {
    fetch("/api/stats").then((r) => r.json()).then(setLifetime).catch(() => {});
  }, []);

  useEffect(() => {
    const saved = loadJSON<Theme>(THEME_KEY);
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveJSON(THEME_KEY, theme);
  }, [theme]);

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

  // A resolved company reports its clean name + logo; the sidebar tab adopts them
  // (replacing the raw typed URL/domain). Guarded to a no-op when unchanged so the
  // child's identity effect can't drive a render loop (mirrors setStage).
  function setIdentity(id: number, info: { name: string; logoUrl?: string | null }) {
    const logoUrl = info.logoUrl ?? null;
    setTabs((t) =>
      t.some((x) => x.id === id && (x.title !== info.name || (x.logoUrl ?? null) !== logoUrl))
        ? t.map((x) => (x.id === id ? { ...x, title: info.name, logoUrl } : x))
        : t,
    );
  }

  // Guarded so a workspace reporting its unchanged stage is a no-op (prevents a
  // render loop between the child's stage effect and this state update).
  function setStage(id: number, stage: number) {
    setTabs((t) =>
      t.some((x) => x.id === id && x.stage !== stage) ? t.map((x) => (x.id === id ? { ...x, stage } : x)) : t,
    );
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

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="side-brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">warmreach</span>
        </div>

        <nav className="side-section">
          <div className="side-label">Workspace</div>
          <div className="cmp-nav">
            <a href="/" className="active" aria-current="page">◱&nbsp; Applications</a>
            <a href="/campaigns">◎&nbsp; Campaigns</a>
            <a href="/companies">◨&nbsp; Companies</a>
            <a href="/people">☰&nbsp; People</a>
            <a href="/jobs">▤&nbsp; Open roles</a>
            <a href="/followups">↩&nbsp; Follow-ups</a>
            <a href="/database">▦&nbsp; Database</a>
          </div>
        </nav>

        <div className="side-section">
          <div className="side-label">Workspaces</div>
          <div className="ws-list">
            {tabs.map((t) => {
              const stage = t.stage ?? 1;
              return (
                <div
                  key={t.id}
                  className={`ws ${t.id === activeId ? "active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveId(t.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActiveId(t.id);
                    }
                  }}
                >
                  <CompanyLogo name={t.title || "New company"} logoUrl={t.logoUrl} />
                  <span className="ws-name">{t.title || "New company"}</span>
                  <span className="ws-dots" aria-hidden="true">
                    {[1, 2, 3, 4].map((i) => (
                      <i key={i} className={i < stage ? "done" : i === stage ? "now" : ""} />
                    ))}
                  </span>
                  {tabs.length > 1 && (
                    <button
                      type="button"
                      className="ws-close"
                      title="Close workspace"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.id);
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <button type="button" className="ws-new" onClick={addTab}>
            + New company
          </button>
        </div>

        <div className="side-foot">
          <CreditMeter />
          <button
            type="button"
            className={`theme-toggle ${theme === "dark" ? "is-dark" : ""}`}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            aria-pressed={theme === "dark"}
            onClick={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
          >
            <span className="theme-toggle-track" aria-hidden="true">
              <span className="theme-toggle-thumb" />
            </span>
            <span className="theme-toggle-label">{theme === "dark" ? "Dark" : "Light"}</span>
          </button>
        </div>
      </aside>

      <main className="workspace">
        {hydrated &&
          tabs.map((t) => (
            <div key={t.id} style={{ display: t.id === activeId ? "block" : "none" }}>
              <div className="workspace-inner">
                <CompanyWorkspace
                  storageKey={wsKey(t.id)}
                  onTitle={(title) => setTitle(t.id, title)}
                  onIdentity={(info) => setIdentity(t.id, info)}
                  onStage={(stage) => setStage(t.id, stage)}
                  resumes={resumes}
                  defaultResume={defaultResume}
                  library={library}
                  onLibraryChange={setLibrary}
                  lifetime={lifetime}
                />
              </div>
            </div>
          ))}
      </main>

      <Dialog state={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}
