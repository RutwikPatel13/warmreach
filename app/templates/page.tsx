"use client";

// /templates — the library of saved email templates and prompt presets
// (data/templates.json). Applications' Compose step picks from the same file,
// and /api/generate reads a chosen template as the base Claude adapts.
//
// Nothing on this page calls Claude or Apollo: it reads and writes the local
// library only. Edits stay as per-item drafts until Save, so switching between
// templates never loses unsaved text.

import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../_components/AppShell";
import {
  sameEmail,
  splitPlaceholders,
  templateChecks,
  wordCount,
  type Segment,
  type TplEmail,
  type TplVariant,
} from "@/src/templateLint";

type Tab = "templates" | "presets";

interface Preset {
  id: string;
  name: string;
  instructions: string;
  createdAt: string;
  updatedAt?: string;
}

interface Template {
  id: string;
  name: string;
  variants: Record<TplVariant, TplEmail>;
  createdAt: string;
  updatedAt?: string;
  linked?: boolean;
}

interface Library {
  presets: Preset[];
  templates: Template[];
}

interface TemplateDraft {
  name: string;
  variants: Record<TplVariant, TplEmail>;
  linked: boolean;
}

interface PresetDraft {
  name: string;
  instructions: string;
}

// Unsaved "New template" / "New preset" rows live under this id until saved.
const NEW_ID = "__new__";
const SAMPLE_COMPANIES = ["Stripe", "Figma", "Capital One"];
const SAMPLE_ROLE = "Software Engineer, New Grad";
const VARIANTS: { id: TplVariant; label: string }[] = [
  { id: "recruiter", label: "Recruiter" },
  { id: "engineering", label: "Engineering" },
];

const blankEmail = (): TplEmail => ({ subject: "", body: "" });

function toDraft(t: Template): TemplateDraft {
  return { name: t.name, variants: t.variants, linked: t.linked === true };
}

function sameTemplate(a: TemplateDraft, b: TemplateDraft): boolean {
  return (
    a.name.trim() === b.name.trim() &&
    a.linked === b.linked &&
    sameEmail(a.variants.recruiter, b.variants.recruiter) &&
    sameEmail(a.variants.engineering, b.variants.engineering)
  );
}

function shortDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

async function callLibrary(method: "POST" | "PATCH" | "DELETE", payload: unknown): Promise<Library> {
  const res = await fetch("/api/templates", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Template library update failed.");
  return { presets: data.presets ?? [], templates: data.templates ?? [] };
}

function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} ${i}`;
  return name;
}

function Segments({ segs }: { segs: Segment[] }) {
  return (
    <>
      {segs.map((s, i) =>
        s.placeholder ? (
          <mark key={i} className="tpl-ph">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

export default function TemplatesPage() {
  const [lib, setLib] = useState<Library | null>(null);
  const [tab, setTab] = useState<Tab>("templates");
  const [selTpl, setSelTpl] = useState<string | null>(null);
  const [selPreset, setSelPreset] = useState<string | null>(null);
  const [tplDrafts, setTplDrafts] = useState<Record<string, TemplateDraft>>({});
  const [presetDrafts, setPresetDrafts] = useState<Record<string, PresetDraft>>({});
  const [variant, setVariant] = useState<TplVariant>("recruiter");
  const [sample, setSample] = useState(SAMPLE_COMPANIES[0]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // Deep links from Compose: /templates?id=<id>, ?tab=presets&id=<id>, ?new=1
  const deepLink = useRef<{ tab: Tab; id: string | null; isNew: boolean } | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    deepLink.current = {
      tab: q.get("tab") === "presets" ? "presets" : "templates",
      id: q.get("id"),
      isNew: q.get("new") === "1",
    };
    fetch("/api/templates")
      .then((r) => r.json())
      .then((d) => setLib({ presets: d.presets ?? [], templates: d.templates ?? [] }))
      .catch(() => setError("Couldn't load the template library."));
  }, []);

  // Apply the deep link (or default selection) once the library arrives.
  useEffect(() => {
    if (!lib || !deepLink.current) return;
    const { tab: t, id, isNew } = deepLink.current;
    deepLink.current = null;
    setTab(t);
    if (isNew && t === "templates") startNewTemplate();
    else if (isNew) startNewPreset();
    else {
      const tplId = t === "templates" && id && lib.templates.some((x) => x.id === id) ? id : lib.templates[0]?.id;
      const preId = t === "presets" && id && lib.presets.some((x) => x.id === id) ? id : lib.presets[0]?.id;
      setSelTpl(tplId ?? null);
      setSelPreset(preId ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib]);

  // Keep the URL pointing at what's open, so a refresh (or a bookmark) lands back here.
  useEffect(() => {
    const id = tab === "templates" ? selTpl : selPreset;
    const q = new URLSearchParams();
    if (tab === "presets") q.set("tab", "presets");
    if (id && id !== NEW_ID) q.set("id", id);
    const next = q.toString() ? `?${q}` : window.location.pathname;
    window.history.replaceState(null, "", next);
  }, [tab, selTpl, selPreset]);

  // ── template working copies ──────────────────────────────────────
  const savedTpl = (id: string | null) => lib?.templates.find((t) => t.id === id) ?? null;

  function tplDraftOf(id: string): TemplateDraft | null {
    if (tplDrafts[id]) return tplDrafts[id];
    const t = savedTpl(id);
    return t ? toDraft(t) : null;
  }

  function tplDirty(id: string): boolean {
    const d = tplDrafts[id];
    if (!d) return false;
    const t = savedTpl(id);
    return !t || !sameTemplate(d, toDraft(t));
  }

  function presetDraftOf(id: string): PresetDraft | null {
    if (presetDrafts[id]) return presetDrafts[id];
    const p = lib?.presets.find((x) => x.id === id);
    return p ? { name: p.name, instructions: p.instructions } : null;
  }

  function presetDirty(id: string): boolean {
    const d = presetDrafts[id];
    if (!d) return false;
    const p = lib?.presets.find((x) => x.id === id);
    return !p || d.name.trim() !== p.name.trim() || d.instructions !== p.instructions;
  }

  const anyDirty =
    Object.keys(tplDrafts).some((id) => tplDirty(id)) || Object.keys(presetDrafts).some((id) => presetDirty(id));

  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  function editTpl(id: string, change: (d: TemplateDraft) => TemplateDraft) {
    const base = tplDraftOf(id);
    if (!base) return;
    setTplDrafts((prev) => ({ ...prev, [id]: change(prev[id] ?? base) }));
    setFlash("");
  }

  // Writes one field of the visible version; with "same email for both" on,
  // the edit lands in both variants.
  function editEmail(field: keyof TplEmail, value: string) {
    if (!selTpl) return;
    editTpl(selTpl, (d) => {
      const next = { ...d.variants[variant], [field]: value };
      return {
        ...d,
        variants: d.linked ? { recruiter: next, engineering: { ...next } } : { ...d.variants, [variant]: next },
      };
    });
  }

  function insertPlaceholder(token: string) {
    const d = selTpl ? tplDraftOf(selTpl) : null;
    if (!d) return;
    const body = d.variants[variant].body;
    const el = bodyRef.current;
    const start = el ? el.selectionStart : body.length;
    const end = el ? el.selectionEnd : body.length;
    editEmail("body", body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function toggleLinked() {
    if (!selTpl) return;
    editTpl(selTpl, (d) => {
      if (d.linked) return { ...d, linked: false };
      // Turning it on keeps the version on screen and copies it to the other.
      const keep = d.variants[variant];
      return { ...d, linked: true, variants: { recruiter: keep, engineering: { ...keep } } };
    });
    setVariant("recruiter");
  }

  function startNewTemplate() {
    setTplDrafts((prev) => ({
      ...prev,
      [NEW_ID]: prev[NEW_ID] ?? {
        name: "",
        variants: { recruiter: blankEmail(), engineering: blankEmail() },
        linked: true,
      },
    }));
    setTab("templates");
    setSelTpl(NEW_ID);
    setVariant("recruiter");
    setConfirmDelete(false);
  }

  function startNewPreset() {
    setPresetDrafts((prev) => ({ ...prev, [NEW_ID]: prev[NEW_ID] ?? { name: "", instructions: "" } }));
    setTab("presets");
    setSelPreset(NEW_ID);
    setConfirmDelete(false);
  }

  function discard(kind: Tab, id: string) {
    if (kind === "templates") {
      setTplDrafts(({ [id]: _, ...rest }) => rest);
      if (id === NEW_ID) setSelTpl(lib?.templates[0]?.id ?? null);
    } else {
      setPresetDrafts(({ [id]: _, ...rest }) => rest);
      if (id === NEW_ID) setSelPreset(lib?.presets[0]?.id ?? null);
    }
    setFlash("Changes discarded");
    setError(null);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function saveTemplate(id: string) {
    const d = tplDraftOf(id);
    if (!d) return;
    if (!d.name.trim()) return setError("Give the template a name.");
    const missing = VARIANTS.find((v) => !d.variants[v.id].subject.trim() || !d.variants[v.id].body.trim());
    if (missing) return setError(`The ${missing.label} version needs a subject and a body.`);
    void run(async () => {
      let next: Library;
      let savedId = id;
      if (id === NEW_ID) {
        next = await callLibrary("POST", { kind: "template", name: d.name, variants: d.variants, createOnly: true });
        const created = next.templates.find((t) => t.name.trim().toLowerCase() === d.name.trim().toLowerCase());
        savedId = created?.id ?? savedId;
        if (created && d.linked) next = await callLibrary("PATCH", { kind: "template", id: created.id, linked: true });
      } else {
        next = await callLibrary("PATCH", {
          kind: "template",
          id,
          name: d.name,
          variants: d.variants,
          linked: d.linked,
        });
      }
      setLib(next);
      setTplDrafts(({ [id]: _, ...rest }) => rest);
      setSelTpl(savedId);
      setFlash("Saved");
    });
  }

  function savePreset(id: string) {
    const d = presetDraftOf(id);
    if (!d) return;
    if (!d.name.trim()) return setError("Give the preset a name.");
    if (!d.instructions.trim()) return setError("Write the instructions first.");
    void run(async () => {
      let next: Library;
      let savedId = id;
      if (id === NEW_ID) {
        next = await callLibrary("POST", { kind: "preset", name: d.name, instructions: d.instructions, createOnly: true });
        savedId = next.presets.find((p) => p.name.trim().toLowerCase() === d.name.trim().toLowerCase())?.id ?? id;
      } else {
        next = await callLibrary("PATCH", { kind: "preset", id, name: d.name, instructions: d.instructions });
      }
      setLib(next);
      setPresetDrafts(({ [id]: _, ...rest }) => rest);
      setSelPreset(savedId);
      setFlash("Saved");
    });
  }

  function duplicateTemplate(id: string) {
    const t = savedTpl(id);
    if (!t || !lib) return;
    const name = uniqueName(`${t.name} copy`, lib.templates.map((x) => x.name));
    void run(async () => {
      let next = await callLibrary("POST", { kind: "template", name, variants: t.variants, createOnly: true });
      const created = next.templates.find((x) => x.name === name);
      if (created && t.linked) next = await callLibrary("PATCH", { kind: "template", id: created.id, linked: true });
      setLib(next);
      if (created) setSelTpl(created.id);
      setFlash(`Duplicated as “${name}”`);
    });
  }

  function remove(kind: Tab, id: string) {
    void run(async () => {
      const next = await callLibrary("DELETE", { kind: kind === "templates" ? "template" : "preset", id });
      setLib(next);
      setConfirmDelete(false);
      if (kind === "templates") {
        setTplDrafts(({ [id]: _, ...rest }) => rest);
        setSelTpl(next.templates[0]?.id ?? null);
      } else {
        setPresetDrafts(({ [id]: _, ...rest }) => rest);
        setSelPreset(next.presets[0]?.id ?? null);
      }
      setFlash("Deleted");
    });
  }

  function switchTo(kind: Tab, id: string) {
    if (kind === "templates") {
      setSelTpl(id);
      setVariant("recruiter");
    } else setSelPreset(id);
    setConfirmDelete(false);
    setError(null);
    setFlash("");
  }

  // ── derived view data ────────────────────────────────────────────
  const q = query.trim().toLowerCase();
  const tplRows = useMemo(() => {
    if (!lib) return [];
    const rows = lib.templates.map((t) => ({ id: t.id, saved: t as Template | null }));
    if (tplDrafts[NEW_ID]) rows.unshift({ id: NEW_ID, saved: null });
    return rows;
  }, [lib, tplDrafts]);

  const presetRows = useMemo(() => {
    if (!lib) return [];
    const rows = lib.presets.map((p) => ({ id: p.id, saved: p as Preset | null }));
    if (presetDrafts[NEW_ID]) rows.unshift({ id: NEW_ID, saved: null });
    return rows;
  }, [lib, presetDrafts]);

  const fill = { company: sample, role: SAMPLE_ROLE };

  if (!lib) {
    return (
      <div className="workspace-inner wide">
        <PageHeader title="Templates" />
        {error ? <div className="error-box">{error}</div> : <p className="meta"><span className="spinner" /> Loading…</p>}
      </div>
    );
  }

  const tpl = selTpl ? tplDraftOf(selTpl) : null;
  const preset = selPreset ? presetDraftOf(selPreset) : null;
  const current = tpl ? tpl.variants[variant] : null;
  const status = (dirty: boolean) => (busy ? "Saving…" : dirty ? "Unsaved changes" : flash || "Saved to your library");

  return (
    <div className="workspace-inner wide">
      <PageHeader
        title="Templates"
        subtitle="Saved emails and prompt instructions. The Compose step in Applications picks from this library."
      />

      <div className="tpl-tabs" role="tablist" aria-label="Library">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "templates"}
          className={tab === "templates" ? "on" : ""}
          onClick={() => {
            setTab("templates");
            setConfirmDelete(false);
          }}
        >
          Email templates <span className="tpl-count">{lib.templates.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "presets"}
          className={tab === "presets" ? "on" : ""}
          onClick={() => {
            setTab("presets");
            setConfirmDelete(false);
          }}
        >
          Prompt presets <span className="tpl-count">{lib.presets.length}</span>
        </button>
        <button
          type="button"
          className="tpl-tabs-new btn-sm"
          onClick={tab === "templates" ? startNewTemplate : startNewPreset}
        >
          {tab === "templates" ? "+ New template" : "+ New preset"}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}

      {tab === "templates" ? (
        <div className="tpl-grid">
          {/* list */}
          <div className="tpl-list">
            <input
              type="search"
              className="tpl-search"
              placeholder="Search templates"
              aria-label="Search templates"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {tplRows
              .filter(({ id }) => {
                if (!q) return true;
                const d = tplDraftOf(id);
                return !!d && (d.name + " " + d.variants.recruiter.subject).toLowerCase().includes(q);
              })
              .map(({ id, saved }) => {
                const d = tplDraftOf(id)!;
                const identical = sameEmail(d.variants.recruiter, d.variants.engineering);
                const meta = id === NEW_ID
                  ? "not saved yet"
                  : `${d.linked ? "1 version" : identical ? "2 versions · identical" : "2 versions"} · saved ${shortDate(saved?.updatedAt ?? saved?.createdAt)}`;
                return (
                  <button
                    key={id}
                    type="button"
                    className={`tpl-item${selTpl === id ? " on" : ""}`}
                    onClick={() => switchTo("templates", id)}
                  >
                    <span className="tpl-item-name">
                      {d.name.trim() || "Untitled template"}
                      {tplDirty(id) && <span className="tpl-dirty" title="Unsaved changes" aria-label="Unsaved changes" />}
                    </span>
                    <span className="tpl-item-sub">{d.variants.recruiter.subject || "No subject yet"}</span>
                    <span className="tpl-item-meta">{meta}</span>
                  </button>
                );
              })}
            <button type="button" className="tpl-newcard" onClick={startNewTemplate}>
              + New template
            </button>
          </div>

          {/* editor */}
          {tpl && current && selTpl ? (
            <section className="card tpl-editor" aria-label="Template editor">
              <div className="tpl-head">
                <input
                  className="tpl-name"
                  value={tpl.name}
                  placeholder="Name this template"
                  aria-label="Template name"
                  onChange={(e) => editTpl(selTpl, (d) => ({ ...d, name: e.target.value }))}
                />
                {selTpl !== NEW_ID && (
                  <>
                    <button type="button" className="ghost btn-sm" disabled={busy} onClick={() => duplicateTemplate(selTpl)}>
                      Duplicate
                    </button>
                    {confirmDelete ? (
                      <button type="button" className="danger btn-sm" disabled={busy} onClick={() => remove("templates", selTpl)}>
                        Confirm delete
                      </button>
                    ) : (
                      <button type="button" className="ghost btn-sm tpl-del" onClick={() => setConfirmDelete(true)}>
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>

              <div className="tpl-variant-row">
                {tpl.linked ? (
                  <span className="meta">One email goes to recruiters and engineers</span>
                ) : (
                  <div className="cmp-seg" role="group" aria-label="Audience">
                    {VARIANTS.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        className={variant === v.id ? "on" : ""}
                        onClick={() => setVariant(v.id)}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                )}
                <label className="tpl-linked">
                  <input type="checkbox" checked={tpl.linked} onChange={toggleLinked} />
                  Same email for both
                </label>
              </div>

              <div>
                <label htmlFor="tpl-subject">Subject</label>
                <input
                  id="tpl-subject"
                  value={current.subject}
                  placeholder="{role} application — Your Name (recent CS grad)"
                  onChange={(e) => editEmail("subject", e.target.value)}
                />
              </div>

              <div>
                <div className="tpl-body-head">
                  <label htmlFor="tpl-body">Body</label>
                  <span className="meta">“Hi [First name],” is added per person</span>
                </div>
                <textarea
                  id="tpl-body"
                  ref={bodyRef}
                  className="body-editor tpl-body"
                  value={current.body}
                  placeholder="Write the email body. Use {company} and {role} where the company or job should go."
                  onChange={(e) => editEmail("body", e.target.value)}
                />
                <div className="tpl-insert">
                  <span>Insert at cursor</span>
                  <button type="button" className="tpl-chip" onClick={() => insertPlaceholder("{company}")}>
                    {"{company}"}
                  </button>
                  <button type="button" className="tpl-chip" onClick={() => insertPlaceholder("{role}")}>
                    {"{role}"}
                  </button>
                  <span className="tpl-words">{wordCount(current.body)} words</span>
                </div>
              </div>

              <div className="tpl-foot">
                <span className="meta">{status(tplDirty(selTpl))}</span>
                <button
                  type="button"
                  className="ghost btn-sm"
                  disabled={busy || !tplDrafts[selTpl]}
                  onClick={() => discard("templates", selTpl)}
                >
                  Discard
                </button>
                <button
                  type="button"
                  className="btn-sm"
                  disabled={busy || !tplDirty(selTpl)}
                  onClick={() => saveTemplate(selTpl)}
                >
                  {selTpl === NEW_ID ? "Save template" : "Save changes"}
                </button>
              </div>
            </section>
          ) : (
            <section className="card tpl-empty">
              <strong>No templates yet</strong>
              <span className="meta">
                Write one here, or generate emails in Applications and use “Save as new template…”.
              </span>
              <button type="button" className="btn-sm" onClick={startNewTemplate}>
                + New template
              </button>
            </section>
          )}

          {/* preview */}
          {tpl && current && (
            <aside className="card tpl-preview" aria-label="Preview">
              <div className="tpl-preview-head">
                <strong>Preview</strong>
                <div className="cmp-seg" role="group" aria-label="Preview company">
                  {SAMPLE_COMPANIES.map((c) => (
                    <button key={c} type="button" className={sample === c ? "on" : ""} onClick={() => setSample(c)}>
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <div className="meta tpl-preview-sub">
                as {SAMPLE_ROLE} · {tpl.linked ? "both audiences" : variant === "recruiter" ? "Recruiter version" : "Engineering version"}
              </div>
              <div className="tpl-mail">
                <div className="tpl-mail-subj">
                  <span className="meta">Subject</span>
                  <span>
                    <Segments segs={splitPlaceholders(current.subject, fill)} />
                  </span>
                </div>
                <div className="tpl-mail-body">
                  <div className="meta">Hi [First name],</div>
                  <div className="tpl-mail-text">
                    <Segments segs={splitPlaceholders(current.body, fill)} />
                  </div>
                </div>
              </div>
              <div className="tpl-checks">
                <div className="side-label">Checks</div>
                {templateChecks(current, tpl.variants, tpl.linked).map((c) => (
                  <div key={c.text} className="tpl-check">
                    <span className={`tpl-dot ${c.ok ? "ok" : "warn"}`} aria-label={c.ok ? "OK" : "Warning"}>
                      {c.ok ? "✓" : "!"}
                    </span>
                    <span>{c.text}</span>
                  </div>
                ))}
              </div>
              <p className="tpl-note">
                Placeholders are filled in here. When you generate, Claude still rewrites the company-specific lines
                for each company.
              </p>
            </aside>
          )}
        </div>
      ) : (
        <div className="tpl-grid">
          <div className="tpl-list">
            {presetRows.map(({ id, saved }) => {
              const d = presetDraftOf(id)!;
              return (
                <button
                  key={id}
                  type="button"
                  className={`tpl-item${selPreset === id ? " on" : ""}`}
                  onClick={() => switchTo("presets", id)}
                >
                  <span className="tpl-item-name">
                    {d.name.trim() || "Untitled preset"}
                    {presetDirty(id) && <span className="tpl-dirty" title="Unsaved changes" aria-label="Unsaved changes" />}
                  </span>
                  <span className="tpl-item-sub">{d.instructions || "No instructions yet"}</span>
                  <span className="tpl-item-meta">
                    {id === NEW_ID
                      ? "not saved yet"
                      : `${d.instructions.length} chars · saved ${shortDate(saved?.updatedAt ?? saved?.createdAt)}`}
                  </span>
                </button>
              );
            })}
            <button type="button" className="tpl-newcard" onClick={startNewPreset}>
              + New preset
            </button>
          </div>

          {preset && selPreset ? (
            <section className="card tpl-editor" aria-label="Preset editor">
              <div className="tpl-head">
                <input
                  className="tpl-name"
                  value={preset.name}
                  placeholder="Name this preset"
                  aria-label="Preset name"
                  onChange={(e) => {
                    const name = e.target.value;
                    setPresetDrafts((prev) => ({ ...prev, [selPreset]: { ...(prev[selPreset] ?? preset), name } }));
                    setFlash("");
                  }}
                />
                {selPreset !== NEW_ID &&
                  (confirmDelete ? (
                    <button type="button" className="danger btn-sm" disabled={busy} onClick={() => remove("presets", selPreset)}>
                      Confirm delete
                    </button>
                  ) : (
                    <button type="button" className="ghost btn-sm tpl-del" onClick={() => setConfirmDelete(true)}>
                      Delete
                    </button>
                  ))}
              </div>
              <div>
                <label htmlFor="preset-body">Instructions</label>
                <textarea
                  id="preset-body"
                  className="body-editor tpl-preset-body"
                  value={preset.instructions}
                  placeholder="e.g. Keep it under 120 words. Mention my Next.js side project."
                  onChange={(e) => {
                    const instructions = e.target.value;
                    setPresetDrafts((prev) => ({
                      ...prev,
                      [selPreset]: { ...(prev[selPreset] ?? preset), instructions },
                    }));
                    setFlash("");
                  }}
                />
                <p className="meta tpl-preset-hint">
                  Plain-language rules for Claude. Where they conflict with the built-in email rules, these win.
                </p>
              </div>
              <div className="tpl-foot">
                <span className="meta">{status(presetDirty(selPreset))}</span>
                <button
                  type="button"
                  className="ghost btn-sm"
                  disabled={busy || !presetDrafts[selPreset]}
                  onClick={() => discard("presets", selPreset)}
                >
                  Discard
                </button>
                <button
                  type="button"
                  className="btn-sm"
                  disabled={busy || !presetDirty(selPreset)}
                  onClick={() => savePreset(selPreset)}
                >
                  {selPreset === NEW_ID ? "Save preset" : "Save changes"}
                </button>
              </div>
            </section>
          ) : (
            <section className="card tpl-empty">
              <strong>No presets yet</strong>
              <span className="meta">Presets are instructions you switch on in the Compose step.</span>
              <button type="button" className="btn-sm" onClick={startNewPreset}>
                + New preset
              </button>
            </section>
          )}

          {preset && (
            <aside className="card tpl-preview" aria-label="What Claude receives">
              <strong>What Claude receives</strong>
              <div className="meta tpl-preview-sub">The end of the generation prompt, with this preset on</div>
              <div className="tpl-prompt">
                <span className="tpl-prompt-muted">…your profile, the job description and the built-in email rules…</span>
                {"\n\n"}
                <span className="tpl-prompt-key">
                  CUSTOM INSTRUCTIONS from the applicant — follow them; where they conflict with the structure or rules
                  above, the custom instructions win:
                </span>
                {"\n"}
                {preset.instructions.trim() || "(empty)"}
              </div>
              <p className="tpl-note">
                Presets never cost Apollo credits. They change the two Claude calls that write each company’s emails.
              </p>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
