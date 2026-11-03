"use client";

// One application in full: people, the résumé that goes out, the posting, its
// history across Tsenta and warmreach, and what to do next. For a row that
// stopped at Needs website, the website goes in here and the run carries on.

import { useCallback, useEffect, useState } from "react";
import { Logo } from "./Logo";
import { STAGE, STARTABLE, fmt, money, shortDate, titleCase, type BoardRow, type Stage } from "./shared";

interface Person { id: string; firstName: string; title: string; source: "apollo" | "file" | "hunter"; email: string | null; picked: boolean; reason: string }
interface Detail {
  application: {
    id: string; company: string; role: string | null; url: string | null; jd: string | null; error: string | null;
    org: { name: string; domain: string | null; logoUrl: string | null; employees?: number | null; industry?: string | null } | null;
    people: Person[]; found: number; locations?: string[]; skillTags?: string[]; tailored?: boolean | null;
    details?: { salaryMin: number | null; salaryMax: number | null; sponsorship: boolean | null; employmentType: string | null } | null;
    startedAt?: string | null; options?: { resumeFallback: "wait" | "base" } | null; noteQueuedAt?: string | null; notedAt?: string | null;
    boardDrafts?: { draftId: string }[]; trackerId?: string | null;
  };
  stage: Stage;
  detail: string | null;
  history: { at: string | null; source: "Tsenta" | "Inbox" | "warmreach"; text: string }[];
  resume: { saved: boolean; name: string; fromTsenta: boolean; baseName: string };
}

const SRC_TONE = { Tsenta: "tone-none", Inbox: "tone-run", warmreach: "tone-ready" } as const;

export function Drawer({ row, siblings, onClose, onChanged }: { row: BoardRow; siblings: BoardRow[]; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [website, setWebsite] = useState("");
  const [posting, setPosting] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/applied/${encodeURIComponent(row.id)}`).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      setD(r);
    } catch (e: any) {
      setErr(e?.message ?? "Couldn’t load this application.");
    }
  }, [row.id]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const patch = async (body: object) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/applied/${encodeURIComponent(row.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      await load();
      onChanged();
      return r as { status: string; continued: boolean };
    } catch (e: any) {
      setErr(e?.message ?? "Couldn’t save that.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  // Website entered: a started row carries on by itself; one never started is started now.
  const continueWith = async (body: object) => {
    const r = await patch(body);
    if (r && !r.continued) {
      await fetch("/api/applied/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [row.id] }) });
      await load();
      onChanged();
    }
  };

  const startOne = async () => {
    setBusy(true);
    await fetch("/api/applied/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [row.id] }) });
    setBusy(false);
    await load();
    onChanged();
  };

  const queueNote = async () => {
    const r = await fetch(`/api/applied/${encodeURIComponent(row.id)}/note`, { method: "POST" }).then((x) => x.json());
    setNote(r.note ?? null);
    await load();
    onChanged();
  };

  const a = d?.application;
  const stage = d?.stage ?? row.stage;
  const s = STAGE[stage];
  const people = a?.people ?? [];
  const picked = people.filter((p) => p.picked);
  const shownPeople = showAll ? people : people.slice(0, Math.max(5, picked.length));
  const name = a?.org?.name ?? row.company;
  const facts = [a?.org?.domain ?? null, a?.org?.employees != null ? `${fmt(a.org.employees)} people` : null, a?.org?.industry ?? null, a?.locations?.[0] ?? row.locations[0] ?? null].filter(Boolean).join(" · ");
  const fallback = a?.options?.resumeFallback ?? "wait";
  const det = a?.details;

  return (
    <div className="wb-scrim right" onClick={onClose}>
      <aside className="wb-drawer" aria-label={`${name} details`} onClick={(e) => e.stopPropagation()}>
        <div className="wb-drawer-h">
          <Logo name={name} logoUrl={a?.org?.logoUrl ?? row.logoUrl} site={row.site} size={44} />
          <div className="t">
            <h2>{name}</h2>
            <span className="meta">{facts || (stage === "needs_website" ? "Company not identified yet" : "Not looked up yet")}</span>
            <span style={{ fontSize: 13 }}>
              {siblings.length > 1 ? <>{siblings.map((x) => x.role ?? "?").join(" · ")} <span className="meta">({siblings.length} applications, one outreach)</span></> : (a?.role ?? row.role ?? "")}
            </span>
          </div>
          <div className="acts">
            <span className={`wb-pill tone-${s.tone}`}>{s.label}</span>
            {STARTABLE.has(stage) && row.bucket === "submitted" && <button type="button" className="wb-btn primary" disabled={busy} onClick={() => void startOne()}>Start</button>}
            {(stage === "ready" || stage === "getting_resume") && <a className="wb-btn primary" href={`/applied/review?id=${encodeURIComponent(row.id)}`}>Review emails</a>}
            {a?.org && people.length > 0 && <a className="wb-btn" href={`/?tsenta=${encodeURIComponent(row.id)}`}>Open in Applications</a>}
            <button type="button" className="wb-btn sm" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        {err && <div className="wb-err" style={{ margin: "12px 24px 0" }}>{err}</div>}
        {!d && !err && <p className="meta" style={{ padding: "20px 24px" }}>Loading…</p>}

        {d && a && (
          <>
            {stage === "needs_website" && (
              <section className="wb-fix">
                <span><b>Which company is “{a.company}”?</b> Tsenta gave no website and nothing on the posting matched. Nothing has been searched or spent.</span>
                <div className="row">
                  <label htmlFor="wb-site" className="sr-only" style={{ position: "absolute", left: -9999 }}>Company website</label>
                  <input id="wb-site" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="example.com" inputMode="url" />
                  <button type="button" className="wb-btn primary" disabled={busy || !website.trim()} onClick={() => void continueWith({ companyWebsite: website })}>Continue</button>
                </div>
              </section>
            )}
            {(stage === "error" || stage === "no_emails" || stage === "contacted") && d.detail && (
              <section className="wb-fix">
                <span><b>{STAGE[stage].label}.</b> {d.detail}</span>
                {stage === "error" && !a.jd && (
                  <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
                    <label htmlFor="wb-jd">Paste the posting if it couldn't be read</label>
                    <textarea id="wb-jd" value={posting} onChange={(e) => setPosting(e.target.value)} />
                    <button type="button" className="wb-btn primary" style={{ alignSelf: "flex-start" }} disabled={busy || !posting.trim()} onClick={() => void continueWith({ jd: posting })}>Save and continue</button>
                  </div>
                )}
              </section>
            )}

            <div className="wb-sections">
              <section className="wb-sec">
                <h3>People {a.found > 0 && <span>{picked.length} picked of {fmt(a.found)} found</span>}</h3>
                {people.length === 0 && <span className="meta">{a.startedAt ? "None yet." : "Found when you Start. Free: Apollo's people search costs no credits."}</span>}
                {shownPeople.map((p) => (
                  <label key={p.id} className="wb-person">
                    <input type="checkbox" checked={p.picked} disabled={busy || stage === "drafted" || stage === "sent"}
                      onChange={() => void patch({ picked: people.filter((x) => (x.id === p.id ? !x.picked : x.picked)).map((x) => x.id) })} />
                    <span><b>{p.firstName}</b> <span className="meta">· {p.title}</span>{p.reason && <span className="why">{p.reason}</span>}</span>
                    <span className={`wb-cost ${p.source === "apollo" ? "credit" : "free"}`}>{p.source === "apollo" ? "1 credit at drafts" : p.source === "hunter" ? "Hunter, free" : "on file, free"}</span>
                  </label>
                ))}
                {people.length > shownPeople.length && <button type="button" className="wb-link" style={{ alignSelf: "flex-start" }} onClick={() => setShowAll(true)}>Show all {people.length}</button>}
              </section>

              <section className="wb-sec">
                <h3>Résumé that goes out</h3>
                <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                <a className="wb-paper" href={d.resume.saved ? `/api/applied/${encodeURIComponent(row.id)}/resume` : undefined} target="_blank" rel="noreferrer" aria-label={d.resume.saved ? "Open the résumé PDF" : undefined} aria-hidden={d.resume.saved ? undefined : true}>
                  <i style={{ width: "60%", height: 6, background: "var(--text)" }} />
                  <i style={{ width: "85%" }} /><i style={{ width: "70%" }} />
                  <i style={{ width: "40%", height: 4, background: "var(--muted)", marginTop: 4 }} />
                  <i style={{ width: "90%" }} /><i style={{ width: "80%" }} /><i style={{ width: "86%" }} />
                  <i style={{ width: "40%", height: 4, background: "var(--muted)", marginTop: 4 }} />
                  <i style={{ width: "75%" }} /><i style={{ width: "88%" }} />
                </a>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                {d.resume.saved && fallback === "wait" ? (
                  <>
                    <span className="wb-cap" style={{ color: "var(--ok)" }}>{a.tailored === false ? "Submitted by Tsenta" : "Tailored by Tsenta"}</span>
                    <b>{d.resume.name}</b>
                    <span className="meta">The copy Tsenta submitted for this job.</span>
                    <span style={{ display: "flex", gap: 14 }}>
                      <a href={`/api/applied/${encodeURIComponent(row.id)}/resume`} target="_blank" rel="noreferrer">Open PDF</a>
                      <button type="button" className="wb-link" disabled={busy} onClick={() => void patch({ resumeFallback: "base" })}>Use base résumé instead</button>
                    </span>
                  </>
                ) : fallback === "base" ? (
                  <>
                    <span className="wb-cap">Your base résumé</span>
                    <b>{d.resume.baseName}</b>
                    <span style={{ display: "flex", gap: 14 }}>
                      {d.resume.saved && <a href={`/api/applied/${encodeURIComponent(row.id)}/resume`} target="_blank" rel="noreferrer">Open Tsenta's copy</a>}
                      <button type="button" className="wb-link" disabled={busy} onClick={() => void patch({ resumeFallback: "wait" })}>Use Tsenta's résumé</button>
                    </span>
                  </>
                ) : (
                  <>
                    <span className="wb-cap" style={{ color: "var(--warn)" }}>{a.startedAt ? "Getting Tsenta's résumé" : "Tsenta's résumé not fetched yet"}</span>
                    <span className="meta">{a.startedAt ? "The next Tsenta sync fetches it. Drafts wait for it." : "Fetched on the next Tsenta sync after you Start."}</span>
                    <button type="button" className="wb-link" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void patch({ resumeFallback: "base" })}>Use my base résumé instead</button>
                  </>
                )}
                </div>
                </div>
              </section>

              <section className="wb-sec">
                <h3>Posting {a.url && <span><a href={a.url} target="_blank" rel="noreferrer">Open the job page</a></span>}</h3>
                {a.jd ? <p className="wb-jd">{a.jd.slice(0, 2400)}{a.jd.length > 2400 ? "…" : ""}</p> : <span className="meta">Read when you Start.</span>}
                <div className="wb-tags">
                  {(a.skillTags ?? []).map((t) => <span key={t}>{t}</span>)}
                  {det && (det.salaryMin != null || det.salaryMax != null) && <span>{[money(det.salaryMin), money(det.salaryMax)].filter(Boolean).join("–")}</span>}
                  {det?.sponsorship != null && <span>Sponsorship: {det.sponsorship ? "yes" : "no"}</span>}
                  {det?.employmentType && <span>{titleCase(det.employmentType)}</span>}
                </div>
              </section>

              <section className="wb-sec">
                <h3>History</h3>
                <ol className="wb-hist">
                  {d.history.map((h, i) => (
                    <li key={i}>
                      <span className="d">{h.at ? shortDate(h.at) : "—"}</span>
                      <span className={`wb-src ${SRC_TONE[h.source]}`}>{h.source}</span>
                      <span>{h.text}</span>
                    </li>
                  ))}
                </ol>
              </section>
            </div>

            {(a.boardDrafts?.length ?? 0) > 0 && (
              <section className="wb-box">
                <div className="t">
                  <b>Note this in Tsenta</b>
                  <span>
                    {a.notedAt ? "Added to this job's notes in Tsenta." :
                      a.noteQueuedAt ? `Queued: “${note ?? "warmreach: outreach note"}”. The next Claude session with Tsenta writes it.` :
                        "Adds a line like “warmreach: emailed 3 people on Nov 2” to this job's notes in Tsenta's tracker. It changes your Tsenta data, so it only happens when you click."}
                  </span>
                </div>
                {!a.noteQueuedAt && !a.notedAt && <button type="button" className="wb-btn" onClick={() => void queueNote()}>Add note to Tsenta</button>}
              </section>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
