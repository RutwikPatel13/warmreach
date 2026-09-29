"use client";

// /resume — tailor the one-page résumé to a specific posting, and see the real
// PDF while you do it.
//
// The shape of this page follows from one constraint: the .tex is the source of
// truth, and the PDF is the only honest view of it. So the editor and the
// preview sit side by side (or stacked — two monitors, two orientations), and
// every judgement the inspector makes comes from having actually compiled the
// document rather than from a model of it.
//
// Only "Tailor" costs money. Compiling, measuring, the ATS audit and version
// history are local and free, so the compile can run on every pause in typing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader, SidebarExtra } from "../_components/AppShell";
import TexEditor, { type LineMark } from "./TexEditor";
import PdfViewer from "./PdfViewer";
import Review, { type Decision, type ReviewItem } from "./Review";
import { AtsPanel, FitPanel, HistoryPanel, TailorPanel, type Tab } from "./Inspector";
import { BASE_ID, type DocSummary, type Proposal, type RenderReport } from "./types";

const LAYOUT_KEY = "warmreach:v1:resume:layout";
const SPLIT_KEY = "warmreach:v1:resume:split";
const AUTO_KEY = "warmreach:v1:resume:auto";
const AUTO_COMPILE_MS = 1500;

type Layout = "side" | "stack";

export default function ResumePage() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [engine, setEngine] = useState<{ latex: boolean; pdftotext: boolean } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [meta, setMeta] = useState<DocSummary | null>(null);
  const [tex, setTex] = useState("");
  const [savedTex, setSavedTex] = useState("");
  const [report, setReport] = useState<RenderReport | null>(null);
  const [versions, setVersions] = useState<{ stamp: string; bytes: number }[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [decided, setDecided] = useState<Record<string, Decision>>({});
  const [reviewing, setReviewing] = useState(false);
  const [tab, setTab] = useState<Tab>("tailor");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [pdfVersion, setPdfVersion] = useState(0);
  const [jump, setJump] = useState<{ line: number; n: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newDoc, setNewDoc] = useState({ company: "", role: "" });

  const [layout, setLayout] = useState<Layout>("side");
  const [split, setSplit] = useState(50);
  const [auto, setAuto] = useState(true);
  const splitRef = useRef<HTMLDivElement>(null);
  const compileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dirty = tex !== savedTex;

  // ── boot ────────────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const l = localStorage.getItem(LAYOUT_KEY);
      if (l === "side" || l === "stack") setLayout(l);
      const s = Number(localStorage.getItem(SPLIT_KEY));
      if (s >= 20 && s <= 80) setSplit(s);
      setAuto(localStorage.getItem(AUTO_KEY) !== "off");
    } catch {
      /* private mode */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
      localStorage.setItem(SPLIT_KEY, String(split));
      localStorage.setItem(AUTO_KEY, auto ? "on" : "off");
    } catch {
      /* quota */
    }
  }, [layout, split, auto]);

  const loadDocs = useCallback(async () => {
    const r = await fetch("/api/resume");
    const d = await r.json();
    setDocs(d.docs ?? []);
    setEngine(d.engine ?? null);
    return (d.docs ?? []) as DocSummary[];
  }, []);

  useEffect(() => {
    void loadDocs().then((list) => {
      if (list.length && !activeId) setActiveId(list[0].id);
    });
  }, [loadDocs]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── open a résumé ───────────────────────────────────────────────────────
  const openDoc = useCallback(async (id: string) => {
    setError(null);
    setProposal(null);
    setReviewItems([]);
    setDecided({});
    setReviewing(false);
    setReport(null);
    const r = await fetch(`/api/resume/${id}`);
    const d = await r.json();
    if (d.error) {
      setError(d.error);
      return;
    }
    setMeta(d.doc);
    setTex(d.tex);
    setSavedTex(d.tex);
    setVersions(d.versions ?? []);
    void compile(id, d.tex);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeId) void openDoc(activeId);
  }, [activeId, openDoc]);

  // ── compile ─────────────────────────────────────────────────────────────
  // Compiling is also the save — see the render route. `savedTex` therefore
  // tracks "last successfully compiled", which is exactly what the dot means.
  const compile = useCallback(async (id: string, source: string) => {
    setBusy("compile");
    setError(null);
    try {
      const r = await fetch(`/api/resume/${id}/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tex: source }),
      });
      const d = await r.json();
      if (d.error) {
        setError(d.error);
        return;
      }
      setReport(d);
      setPdfVersion(d.version);
      setSavedTex(source);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  // Compile-as-you-pause, the way Overleaf does. Free, so the only cost of
  // being wrong is a wasted 0.5s of CPU.
  useEffect(() => {
    if (!auto || !activeId || tex === savedTex || !tex) return;
    if (compileTimer.current) clearTimeout(compileTimer.current);
    compileTimer.current = setTimeout(() => void compile(activeId, tex), AUTO_COMPILE_MS);
    return () => {
      if (compileTimer.current) clearTimeout(compileTimer.current);
    };
  }, [tex, activeId, savedTex, auto, compile]);

  // ⌘S compiles now instead of offering to save the web page.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activeId) void compile(activeId, tex);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, tex, compile]);

  // ── actions ─────────────────────────────────────────────────────────────
  async function createDoc() {
    if (!newDoc.company.trim() && !newDoc.role.trim()) {
      setError("Give it a company or a role so it has a name.");
      return;
    }
    setBusy("create");
    try {
      const r = await fetch("/api/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(newDoc),
      });
      const d = await r.json();
      if (d.error) {
        setError(d.error);
        return;
      }
      await loadDocs();
      setActiveId(d.doc.id);
      setCreating(false);
      setNewDoc({ company: "", role: "" });
      setTab("tailor");
    } finally {
      setBusy(null);
    }
  }

  async function runTailor(form: { company: string; role: string; jd: string; notes: string; jobUrl: string }) {
    if (!activeId) return;
    setBusy("tailor");
    setError(null);
    try {
      let target = activeId;

      // Tailoring the base one-pager would bend your master template toward a
      // single job. Fork it instead: this is also the shortest path from
      // "I opened the page" to "I have a résumé for this role".
      if (activeId === BASE_ID) {
        if (!form.company.trim() && !form.role.trim()) {
          setError("Add the company or the role first — the new résumé is filed under that name.");
          return;
        }
        const created = await fetch("/api/resume", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...form, fromTex: tex }),
        }).then((x) => x.json());
        if (created.error) {
          setError(created.error);
          return;
        }
        target = created.doc.id;
        await loadDocs();
        setActiveId(target);
        setMeta(created.doc);
        setSavedTex(tex);
      }

      const r = await fetch(`/api/resume/${target}/tailor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, tex }),
      });
      const d = await r.json();
      if (d.error) {
        setError(d.error);
        return;
      }
      setProposal(d);
      setReviewItems(report?.parsed ? buildQueue(d, report.parsed) : []);
      setDecided({});
      setReviewing(true);
      setMeta((m) => (m ? { ...m, ...form } : m));
      void loadDocs();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Apply exactly one suggestion, with whatever text is in the box — which may
   * be the model's wording or the user's edit of it. Applying one at a time is
   * the point: the page recompiles above you, so you see what each change did
   * before deciding on the next one.
   */
  async function applyOne(item: ReviewItem, text: string) {
    if (!activeId || !proposal) return;
    setBusy("apply");
    try {
      const payload =
        item.kind === "bullet"
          ? { bullets: [{ id: item.id, text, sourceId: item.sourceId, rationale: item.rationale, changed: true, before: item.before }] }
          : item.kind === "project"
            ? { projects: [{ id: item.id, blurb: text, rationale: item.rationale, before: item.before }] }
            : { skills: [{ id: item.id, text, rationale: item.rationale, before: item.before }] };

      const r = await fetch(`/api/resume/${activeId}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tex, accept: [item.id], ...payload }),
      });
      const d = await r.json();
      if (d.error) {
        setError(d.error);
        return;
      }
      setTex(d.tex);
      setSavedTex(d.tex);
      setReport(d);
      setPdfVersion(d.version);
      void refreshVersions();
    } finally {
      setBusy(null);
    }
  }

  async function applyFix(fix: string) {
    if (!activeId) return;
    setBusy("fix");
    try {
      const r = await fetch(`/api/resume/${activeId}/fix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fix, tex }),
      });
      const d = await r.json();
      if (d.error) {
        setError(d.error);
        return;
      }
      setTex(d.tex);
      setSavedTex(d.tex);
      setReport(d);
      setPdfVersion(d.version);
      setFlash("Ligature fix applied");
      void refreshVersions();
    } finally {
      setBusy(null);
    }
  }

  async function exportPdf() {
    if (!activeId) return;
    setBusy("export");
    try {
      const r = await fetch(`/api/resume/${activeId}/export`, { method: "POST" });
      const d = await r.json();
      if (d.error) setError(d.error);
      else setFlash(`${d.overwrote ? "Replaced" : "Saved to"} ${d.path}`);
    } finally {
      setBusy(null);
    }
  }

  async function refreshVersions() {
    if (!activeId) return;
    const r = await fetch(`/api/resume/${activeId}/versions`);
    const d = await r.json();
    setVersions(d.versions ?? []);
  }

  async function restore(stamp: string) {
    if (!activeId) return;
    setBusy("restore");
    try {
      const r = await fetch(`/api/resume/${activeId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stamp }),
      });
      const d = await r.json();
      if (d.error) {
        setError(d.error);
        return;
      }
      setTex(d.tex);
      setSavedTex(d.tex);
      setReport(d);
      setPdfVersion(d.version);
      setFlash("Restored");
      void refreshVersions();
    } finally {
      setBusy(null);
    }
  }

  async function removeDoc(id: string) {
    const doc = docs.find((d) => d.id === id);
    const label = doc ? doc.company || doc.title : id;
    // This takes the .tex, the PDF and every snapshot with it.
    if (!window.confirm(`Delete "${label}" and its ${doc?.versions ?? 0} saved version(s)? This can't be undone.`)) {
      return;
    }
    await fetch(`/api/resume/${id}`, { method: "DELETE" });
    const list = await loadDocs();
    setActiveId(list.length ? list[0].id : null);
    if (!list.length) {
      setMeta(null);
      setTex("");
      setReport(null);
    }
  }

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  // ── split dragging ──────────────────────────────────────────────────────
  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    const el = splitRef.current;
    if (!el) return;
    function onMove(ev: MouseEvent) {
      const box = el!.getBoundingClientRect();
      const pct =
        layout === "side"
          ? ((ev.clientX - box.left) / box.width) * 100
          : ((ev.clientY - box.top) / box.height) * 100;
      setSplit(Math.min(80, Math.max(20, pct)));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("rs-dragging");
    }
    document.body.classList.add("rs-dragging");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /**
   * Build the decision queue from a proposal. Called once, when the suggestions
   * arrive, and then held in state — deriving it from the live parse would
   * shrink the list as you applied things, shifting every later item under the
   * cursor mid-review.
   */
  const buildQueue = useCallback((p: Proposal, parsed: RenderReport["parsed"]): ReviewItem[] => {
    const where = new Map<string, string>();
    const before = new Map<string, string>();
    for (const e of parsed.experience) {
      const label = [e.primary, e.secondary].filter(Boolean).join(", ") || e.dates;
      for (const i of e.items) {
        where.set(i.id, label);
        before.set(i.id, i.text);
      }
    }
    for (const pr of parsed.projects) {
      where.set(pr.id, pr.name);
      before.set(pr.id, pr.blurb);
    }
    for (const sk of parsed.skills) {
      where.set(sk.id, `Skills — ${sk.label}`);
      before.set(sk.id, sk.text);
    }

    const rows: ReviewItem[] = [];
    const add = (id: string, after: string, rationale: string, sourceId: string, kind: ReviewItem["kind"]) => {
      const was = before.get(id);
      if (was === undefined || !after || was === after) return;
      rows.push({ id, where: where.get(id) ?? id, before: was, after, rationale, sourceId, kind });
    };
    for (const b of p.bullets) add(b.id, b.text, b.rationale, b.sourceId, "bullet");
    for (const pr of p.projects) add(pr.id, pr.blurb, pr.rationale, "", "project");
    for (const sk of p.skills) add(sk.id, sk.text, sk.rationale, "", "skill");
    return rows;
  }, []);

  // Problems TeX reported, plus the bullets whose measurement says they're at
  // or past the edge — both anchored to the line you'd need to edit.
  const marks: LineMark[] = [];
  if (report) {
    for (const p of report.problems) {
      if (p.line) marks.push({ line: p.line, kind: p.kind === "error" ? "error" : "overfull", title: p.message });
    }
  }

  const pdfSrc = activeId && pdfVersion ? `/api/resume/${activeId}/pdf?v=${pdfVersion}` : null;

  return (
    <div className="rs-page">
      <SidebarExtra>
        <div className="side-section">
          <div className="side-label">Résumés</div>
          <button className="rs-new" onClick={() => setCreating((v) => !v)}>+ New résumé</button>
          {creating && (
            <div className="rs-newform">
              <input className="rs-input" placeholder="Company" value={newDoc.company} onChange={(e) => setNewDoc({ ...newDoc, company: e.target.value })} />
              <input className="rs-input" placeholder="Role" value={newDoc.role} onChange={(e) => setNewDoc({ ...newDoc, role: e.target.value })} />
              <button className="rs-btn is-primary is-small rs-wide" disabled={busy === "create"} onClick={createDoc}>
                {busy === "create" ? "Creating…" : "Create from one-pager"}
              </button>
            </div>
          )}
          <div className="rs-doclist">
            {docs.map((d) => (
              <div key={d.id} className={`rs-docitem${d.id === activeId ? " active" : ""}${d.isBase ? " is-base" : ""}`}>
                <button onClick={() => setActiveId(d.id)}>
                  <span className="rs-doc-title">{d.company || d.title}</span>
                  <span className="rs-doc-sub">{d.isBase ? "your master template" : d.role || "—"}</span>
                </button>
                {!d.isBase && (
                  <button className="rs-doc-del" title="Delete" onClick={() => void removeDoc(d.id)}>×</button>
                )}
              </div>
            ))}
            {docs.length <= 1 && <div className="rs-empty">No role-specific résumés yet.</div>}
          </div>
        </div>
      </SidebarExtra>

      <PageHeader
        title="Résumé tailor"
        subtitle={
          meta
            ? meta.role && meta.company
              ? `${meta.role} at ${meta.company}`
              : meta.role || meta.company || "Your master template"
            : "Point it at a job description and it rewrites your one-pager to fit — without inventing anything or moving the page."
        }
      />

      {engine && !engine.latex && (
        <div className="rs-banner is-err">
          No LaTeX engine found. Run <code>brew install tectonic</code> in this project, then reload.
        </div>
      )}
      {error && <div className="rs-banner is-err">{error}</div>}
      {flash && <div className="rs-banner is-ok">{flash}</div>}

      {!activeId ? (
        <div className="rs-blank">
          <p>Couldn&rsquo;t load your résumés. Check that the server is running, then reload.</p>
        </div>
      ) : (
        <div className="rs-shell">
          <div className="rs-toolbar">
            <div className="rs-toolbar-left">
              <span className={`rs-dot${busy === "compile" ? " is-working" : dirty ? " is-dirty" : ""}`} aria-hidden="true" />
              <span className="rs-file">{activeId === BASE_ID ? "base.tex" : `${activeId}.tex`}</span>
              {report && (
                <>
                  <span className={`rs-pill${report.pages === 1 ? " is-ok" : " is-bad"}`}>
                    {report.pages ?? "?"} page{report.pages === 1 ? "" : "s"}
                  </span>
                  {/* Jumping to the offending line is the only useful thing to
                      do with an error count, so the count is the control. */}
                  {report.problems.some((p) => p.kind === "error") && (
                    <button
                      className="rs-pill is-bad is-button"
                      onClick={() => {
                        const first = report.problems.find((p) => p.kind === "error" && p.line);
                        if (first?.line) setJump((j) => ({ line: first.line!, n: (j?.n ?? 0) + 1 }));
                      }}
                    >
                      {report.problems.filter((p) => p.kind === "error").length} error — go to it
                    </button>
                  )}
                  <span className={`rs-pill${report.ats.score >= 85 ? " is-ok" : ""}`}>ATS {report.ats.score}</span>
                </>
              )}
              <span className="rs-status">
                {busy === "compile" ? "Compiling" : dirty ? "Unsaved edits" : "Up to date"}
              </span>
            </div>
            <div className="rs-toolbar-right">
              <div className="rs-seg" role="group" aria-label="Layout">
                <button className={layout === "side" ? "active" : ""} onClick={() => setLayout("side")} title="Editor and preview side by side — for a landscape monitor">◫ Side</button>
                <button className={layout === "stack" ? "active" : ""} onClick={() => setLayout("stack")} title="Editor above preview — for a portrait monitor">⬓ Stack</button>
              </div>
              <label className="rs-auto" title="Recompile shortly after you stop typing">
                <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                Auto
              </label>
              <button className="rs-btn" disabled={!!busy} onClick={() => activeId && compile(activeId, tex)}>
                {busy === "compile" ? "Compiling…" : "Compile"}
              </button>
              <button className="rs-btn" disabled={!!busy || !report?.ok} onClick={exportPdf} title="Copy the PDF into your Resume folder so it shows up in the Applications attach picker">
                Export
              </button>
            </div>
          </div>

          <div className="rs-body">
            <div className={`rs-split is-${layout}`} ref={splitRef}>
              <div className="rs-pane" style={layout === "side" ? { width: `${split}%` } : { height: `${split}%` }}>
                <TexEditor value={tex} onChange={setTex} marks={marks} scrollToLine={jump} />
              </div>
              <div className="rs-divider" onMouseDown={startDrag} role="separator" aria-orientation={layout === "side" ? "vertical" : "horizontal"} />
              <div className="rs-pane rs-preview">
                <PdfViewer src={pdfSrc} busy={busy === "compile"} />
              </div>
            </div>

            <aside className="rs-inspector">
              <div className="rs-tabs">
                {(["tailor", "fit", "ats", "history"] as Tab[]).map((t) => (
                  <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                    {t === "tailor" ? "Tailor" : t === "fit" ? "Fit" : t === "ats" ? "ATS" : "History"}
                    {t === "ats" && report ? <span className="rs-tabnum">{report.ats.score}</span> : null}
                  </button>
                ))}
              </div>

              {tab === "tailor" && (
                <TailorPanel
                  key={activeId}
                  isBase={activeId === BASE_ID}
                  meta={{
                    company: meta?.company ?? "",
                    role: meta?.role ?? "",
                    jd: meta?.jd ?? "",
                    notes: meta?.notes ?? "",
                    jobUrl: meta?.jobUrl ?? "",
                  }}
                  proposal={proposal}
                  pending={reviewItems.filter((i) => !decided[i.id]).length}
                  busy={busy}
                  onTailor={runTailor}
                  onReview={() => setReviewing(true)}
                  onDiscard={() => {
                    setProposal(null);
                    setReviewItems([]);
                    setDecided({});
                    setReviewing(false);
                  }}
                />
              )}
              {tab === "fit" && <FitPanel parsed={report?.parsed ?? null} report={report} onJump={(line) => setJump((j) => ({ line, n: (j?.n ?? 0) + 1 }))} />}
              {tab === "ats" && <AtsPanel ats={report?.ats ?? null} hasJd={!!meta?.jd} busy={busy} onFix={applyFix} />}
              {tab === "history" && <HistoryPanel versions={versions} busy={busy} onRestore={restore} />}
            </aside>
          </div>

          {reviewing && proposal && reviewItems.length > 0 && (
            <Review
              items={reviewItems}
              proposal={proposal}
              docId={activeId}
              tex={tex}
              busy={busy}
              decided={decided}
              onDecide={(id, decision) => setDecided((d) => ({ ...d, [id]: decision }))}
              onApply={applyOne}
              onDone={() => setReviewing(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
