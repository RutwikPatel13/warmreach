"use client";

// Start outreach: the dry run first (what would happen, nothing written), the
// batch's settings, and the cost. Start queues the rows that can run.

import { useEffect, useState } from "react";
import { fmt } from "./shared";

interface Row { id: string; company: string }
interface Plan {
  run: Row[];
  waitResume: Row[];
  needsWebsite: Row[];
  maybeContacted: Row[];
  already: Row[];
  notStartable: Row[];
  claude: number;
  writer: string;
}
interface Store { templates: { id: string; name: string }[]; presets: { id: string; name: string }[] }

const names = (rows: Row[]) => {
  const n = rows.map((r) => r.company);
  return n.length <= 4 ? n.join(", ") : `${n.slice(0, 4).join(", ")} and ${n.length - 4} more`;
};

export function StartDialog({ ids, dryRunOnly, onClose, onStarted }: { ids: string[]; dryRunOnly: boolean; onClose: () => void; onStarted: () => void }) {
  const [store, setStore] = useState<Store>({ templates: [], presets: [] });
  const [templateId, setTemplateId] = useState("");
  const [presetId, setPresetId] = useState("");
  const [pick, setPick] = useState(3);
  const [roles, setRoles] = useState({ recruiter: true, team: true, founders: true });
  const [fallback, setFallback] = useState<"wait" | "base">("wait");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const options = { templateId: templateId || null, presetId: presetId || null, pick, roles, resumeFallback: fallback };

  useEffect(() => {
    fetch("/api/templates").then((x) => x.json()).then((s) => setStore({ templates: s.templates ?? [], presets: s.presets ?? [] })).catch(() => {});
  }, []);

  // The plan depends only on the rows and the résumé fallback.
  useEffect(() => {
    let live = true;
    fetch("/api/applied/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, dryRun: true, options: { resumeFallback: fallback } }),
    })
      .then((x) => x.json())
      .then((r) => { if (live) { if (r.error) setErr(r.error); else setPlan(r.plan); } })
      .catch(() => live && setErr("Couldn’t work out the plan."));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(","), fallback]);

  const willRun = plan ? plan.run.length + plan.maybeContacted.length : 0;

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/applied/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, options }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      onStarted();
    } catch (e: any) {
      setErr(e?.message ?? "Couldn’t start.");
      setBusy(false);
    }
  };

  const lines: { n: number; tone: string; title: string; detail: string }[] = plan ? [
    { n: plan.run.length, tone: "tone-ready", title: "Run through to Ready to review.", detail: "Read the posting, find the company, pick people, write the emails." },
    { n: plan.waitResume.length, tone: "tone-wait", title: "Of those, wait on Tsenta's résumé.", detail: `${names(plan.waitResume)}: emails get written now; drafts wait for the next Tsenta sync.` },
    { n: plan.maybeContacted.length, tone: "tone-wait", title: "Run, but you've emailed these companies before.", detail: `${names(plan.maybeContacted)}: anyone already emailed is skipped, and if that's everyone, it stops there.` },
    { n: plan.needsWebsite.length, tone: "tone-wait", title: "Stop at Needs website.", detail: `${names(plan.needsWebsite)}: they stopped there before. No people search, no emails, nothing spent. Enter the website in the row's details.` },
    { n: plan.already.length, tone: "tone-none", title: "Skipped: already started.", detail: names(plan.already) },
    { n: plan.notStartable.length, tone: "tone-none", title: "Skipped: Tsenta never submitted these.", detail: names(plan.notStartable) },
  ].filter((l) => l.n > 0) : [];

  return (
    <div className="wb-scrim" onClick={onClose}>
      <section className="wb-panel narrow" role="dialog" aria-labelledby="start-title" onClick={(e) => e.stopPropagation()}>
        <div className="wb-panel-h" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
          <h2 id="start-title">{dryRunOnly ? "Dry run" : "Start outreach"} for {fmt(ids.length)} {ids.length === 1 ? "application" : "applications"}</h2>
          <span className="meta">Nothing has happened yet. Start runs each one up to written emails; you review and create drafts after.</span>
        </div>

        <div className="wb-plan">
          <h3>What will happen</h3>
          {!plan && !err && <span className="meta">Working it out…</span>}
          {lines.map((l) => (
            <div key={l.title} className="wb-plan-row">
              <span className={`n ${l.tone}`}>{fmt(l.n)}</span>
              <span><b>{l.title}</b> <span className="names">{l.detail}</span></span>
            </div>
          ))}
          {plan && plan.needsWebsite.length === 0 && (
            <span className="meta">Any company it can't identify will stop at Needs website, with nothing spent.</span>
          )}
        </div>

        <div className="wb-opts">
          <label className="f">Email template
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Write from scratch</option>
              {store.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="f">Prompt preset
            <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              <option value="">None</option>
              {store.presets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="f">People per company
            <span style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 400 }}>
              <button type="button" className="wb-btn sm" aria-label="Fewer people" disabled={pick <= 1} onClick={() => setPick((n) => Math.max(1, n - 1))}>−</button>
              <input type="number" min={1} max={10} value={pick} onChange={(e) => setPick(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} style={{ width: 60, textAlign: "center" }} />
              <button type="button" className="wb-btn sm" aria-label="More people" disabled={pick >= 10} onClick={() => setPick((n) => Math.min(10, n + 1))}>+</button>
              <span className="meta" style={{ fontSize: 12.5 }}>Change it per company in the details</span>
            </span>
          </label>
          <fieldset>
            <legend>Who to email</legend>
            <label><input type="checkbox" checked={roles.recruiter} onChange={(e) => setRoles({ ...roles, recruiter: e.target.checked })} /> The best recruiter</label>
            <label><input type="checkbox" checked={roles.team} onChange={(e) => setRoles({ ...roles, team: e.target.checked })} /> People on the role's team</label>
            <label><input type="checkbox" checked={roles.founders} onChange={(e) => setRoles({ ...roles, founders: e.target.checked })} /> Founders (picked first at 200 people or fewer)</label>
          </fieldset>
          <fieldset style={{ gridColumn: "1 / -1" }}>
            <legend>If Tsenta's résumé isn't saved yet</legend>
            <label><input type="radio" name="fallback" checked={fallback === "wait"} onChange={() => setFallback("wait")} /> Wait for it before drafts (the next Tsenta sync fetches it)</label>
            <label><input type="radio" name="fallback" checked={fallback === "base"} onChange={() => setFallback("base")} /> Use my base résumé</label>
          </fieldset>
        </div>

        <div className="wb-coststrip">
          <span className="wb-cost claude">{fmt(plan?.claude ?? 0)} email-writing calls</span>
          <span className="wb-cost free">0 Apollo credits</span>
          <span>2 calls per company that gets through, on {plan?.writer || "your configured models"}. Credits are spent only when you click Create drafts.</span>
        </div>

        {err && <div className="wb-err" style={{ margin: "12px 20px 0" }}>{err}</div>}

        <div className="wb-panel-f" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="wb-btn" onClick={onClose}>{dryRunOnly ? "Close" : "Cancel"}</button>
          <button type="button" className="wb-btn primary" disabled={busy || !plan || willRun === 0} onClick={() => void start()}>
            {busy ? "Starting…" : `Start ${fmt(willRun)} now`}
          </button>
        </div>
      </section>
    </div>
  );
}
