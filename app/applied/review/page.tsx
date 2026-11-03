"use client";

// /applied/review — the review queue. Every application Start took to written
// emails, one company at a time: read and edit each person's email, then
// Create drafts (Gmail drafts, résumé attached) or Create drafts and send.
//
// This is the only place the board spends Apollo credits: Create drafts
// reveals the email of each picked Apollo person (1 credit each). People on
// file and Hunter's finds are free. No model calls here: each person gets the
// company's recruiter or engineering email with their own greeting, plus any
// edit you make to theirs.

import { useCallback, useEffect, useMemo, useState } from "react";
import "../board.css";
import { spendCredit } from "../../_components/credits";
import { STAGE, type BoardRow } from "../shared";

type Variant = "recruiter" | "engineering";
interface Email { subject: string; body: string }
interface Person { id: string; firstName: string; title: string; source: "apollo" | "file" | "hunter"; email: string | null; variant: Variant; picked: boolean }
interface Detail {
  application: {
    id: string; company: string; role: string | null; resumePath: string | null; tailored?: boolean | null;
    org: { name: string; domain: string | null } | null;
    people: Person[]; emails: Record<Variant, Email> | null; pipeline?: string | null;
    options?: { resumeFallback: "wait" | "base" } | null;
    boardDrafts?: { personId: string; draftId: string; sentAt: string | null }[];
  };
  resume: { saved: boolean; name: string; baseName: string };
}
interface Mail { include: boolean; subject: string; body: string; result?: { ok: boolean; text: string } }

const VERSION: Record<Variant, string> = { recruiter: "Recruiter version", engineering: "Engineering version" };
const SOURCE = { apollo: "apollo", file: "csv", hunter: "hunter" } as const;

async function readNdjson(res: Response, on: (line: any) => void) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) on(JSON.parse(l));
  }
  if (buf.trim()) on(JSON.parse(buf));
}

export default function ReviewQueue() {
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [doneToday, setDoneToday] = useState<string[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [d, setD] = useState<Detail | null>(null);
  const [mails, setMails] = useState<Record<string, Mail>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadRows = useCallback(async () => {
    const r = await fetch("/api/applied/board").then((x) => x.json());
    setRows((r.rows ?? []) as BoardRow[]);
    return (r.rows ?? []) as BoardRow[];
  }, []);

  useEffect(() => {
    void loadRows().then((list) => {
      const wanted = new URLSearchParams(window.location.search).get("id");
      const first = list.find((x) => x.id === wanted) ?? list.find((x) => x.stage === "ready") ?? list.find((x) => x.stage === "getting_resume");
      setId(first?.id ?? null);
    });
  }, [loadRows]);

  const queue = useMemo(() => {
    const open = rows.filter((r) => r.stage === "ready" || r.stage === "getting_resume");
    const done = rows.filter((r) => doneToday.includes(r.id));
    return [...done, ...open.filter((r) => !doneToday.includes(r.id))];
  }, [rows, doneToday]);
  const openCount = queue.filter((r) => !doneToday.includes(r.id)).length;

  // One company in full, with an editable email per picked person.
  useEffect(() => {
    if (!id) { setD(null); return; }
    let live = true;
    setErr(null);
    fetch(`/api/applied/${encodeURIComponent(id)}`).then((x) => x.json()).then((r: Detail & { error?: string }) => {
      if (!live) return;
      if (r.error) { setErr(r.error); return; }
      setD(r);
      const m: Record<string, Mail> = {};
      for (const p of r.application.people.filter((x) => x.picked)) {
        const e = r.application.emails?.[p.variant] ?? r.application.emails?.recruiter;
        m[p.id] = { include: true, subject: e?.subject ?? "", body: e?.body ?? "" };
      }
      setMails(m);
    }).catch(() => live && setErr("Couldn’t load this application."));
    return () => { live = false; };
  }, [id]);

  const a = d?.application;
  const picked = (a?.people ?? []).filter((p) => p.picked && mails[p.id]);
  const included = picked.filter((p) => mails[p.id].include);
  const credits = included.filter((p) => p.source === "apollo").length;
  const fallback = a?.options?.resumeFallback ?? "wait";
  const resumeReady = fallback === "base" || !!d?.resume.saved;
  const row = rows.find((r) => r.id === id);
  const index = queue.findIndex((r) => r.id === id);

  const next = () => {
    const after = queue.slice(index + 1).find((r) => !doneToday.includes(r.id)) ?? queue.find((r) => !doneToday.includes(r.id) && r.id !== id);
    setId(after?.id ?? null);
  };

  const setMail = (pid: string, patch: Partial<Mail>) => setMails((m) => ({ ...m, [pid]: { ...m[pid], ...patch } }));

  const useBase = async () => {
    if (!id) return;
    await fetch(`/api/applied/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resumeFallback: "base" }) });
    setD((cur) => (cur ? { ...cur, application: { ...cur.application, options: { resumeFallback: "base" } } } : cur));
    void loadRows();
  };

  // People whose email is identical go in one /api/draft call; an edited one
  // goes on its own, so each person's text is exactly what you see.
  const createDrafts = async (send: boolean) => {
    if (!a || !a.org || !included.length) return;
    setBusy(send ? "send" : "drafts");
    setErr(null);
    const groups = new Map<string, Person[]>();
    for (const p of included) {
      const k = JSON.stringify([mails[p.id].subject, mails[p.id].body]);
      groups.set(k, [...(groups.get(k) ?? []), p]);
    }
    const drafted: { personId: string; name: string; title: string; email: string; variant: Variant; draftId: string }[] = [];
    let spent = 0;
    try {
      for (const [k, people] of groups) {
        const [subject, body] = JSON.parse(k) as [string, string];
        const res = await fetch("/api/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            company: { name: a.org.name, domain: a.org.domain },
            role: a.role ?? "the role",
            templates: { recruiter: { subject, body }, engineering: { subject, body } },
            people: people.map((p) => ({ id: p.id, firstName: p.firstName, title: p.title, variant: p.variant, source: SOURCE[p.source], email: p.email })),
            resumePath: fallback === "base" ? "" : a.resumePath ?? "",
          }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? "Creating drafts failed.");
        }
        await readNdjson(res, (line) => {
          if (line.creditSpent) { spent++; spendCredit(1); }
          const p = people.find((x) => x.id === line.id);
          if (!p) return;
          if (line.status === "drafted" && line.draftId) {
            drafted.push({ personId: p.id, name: line.name ?? p.firstName, title: line.title ?? p.title, email: line.email, variant: p.variant, draftId: line.draftId });
            setMail(p.id, { result: { ok: true, text: `Drafted to ${line.email}${line.resumeAttached === false ? " · résumé missing" : ""}` } });
          } else {
            setMail(p.id, { result: { ok: false, text: line.reason ?? "Not drafted." } });
          }
        });
      }
      if (drafted.length) {
        await fetch(`/api/applied/${encodeURIComponent(a.id)}/drafted`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ drafts: drafted, credits: spent }),
        });
      }
      if (send && drafted.length) {
        const r = await fetch("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftIds: drafted.map((x) => x.draftId) }) }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        const ok = (r.results ?? []).filter((x: any) => x.ok).map((x: any) => x.draftId as string);
        await fetch(`/api/applied/${encodeURIComponent(a.id)}/drafted`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sent: ok }) });
        for (const x of drafted) setMail(x.personId, { result: { ok: ok.includes(x.draftId), text: ok.includes(x.draftId) ? `Sent to ${x.email}` : "Drafted, but sending failed: send it from Gmail" } });
      }
      if (drafted.length) {
        setDoneToday((s) => [...s, a.id]);
        void loadRows();
        if (drafted.length === included.length) setTimeout(next, 900);
      }
    } catch (e: any) {
      setErr(e?.message ?? "Creating drafts failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="wr-shell">
      <nav className="wr-list" aria-label="Ready to review">
        <div className="wr-list-h">
          <a href="/applied" style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}>← Applied</a>
          <h1>Review queue</h1>
          <span className="meta"><b style={{ color: "var(--text)" }}>{doneToday.length} of {doneToday.length + openCount}</b> done here</span>
          <div className="wb-prog" style={{ margin: 0 }}><div style={{ width: `${doneToday.length + openCount ? (100 * doneToday.length) / (doneToday.length + openCount) : 0}%`, background: "var(--ok)" }} /></div>
        </div>
        <ol>
          {queue.length === 0 && <li className="meta" style={{ padding: "8px 10px" }}>Nothing to review. Start some applications on the board.</li>}
          {queue.map((r) => {
            const done = doneToday.includes(r.id);
            return (
              <li key={r.id}>
                <button type="button" className={`wr-item${r.id === id ? " on" : done ? " done" : r.stage === "getting_resume" ? " wait" : ""}`} onClick={() => setId(r.id)}>
                  <span className="top"><b>{r.company}</b><span className="wb-n">{done ? "Done" : r.picked}</span></span>
                  <span className="sub">{r.stage === "getting_resume" ? "waiting on résumé" : r.role}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <main className="wr-main">
        {!id && <div className="wb-empty"><b>Nothing to review.</b><span>Applications you Start on the board land here once their emails are written.</span><a href="/applied">Go to the board</a></div>}
        {err && <div className="wb-err">{err}</div>}
        {id && !d && !err && <p className="meta">Loading…</p>}
        {a && (
          <>
            <header className="wr-head">
              <div className="grow">
                <span className="wb-cap">{index + 1} of {queue.length}</span>
                <h2>{a.org?.name ?? a.company}</h2>
                <span className="meta">{a.role}{a.pipeline ? ` · ${a.pipeline.toLowerCase()} in Tsenta` : ""} · 2 emails written for this company (recruiter, engineering), each person's greeting filled in</span>
              </div>
              <a href={`/applied?open=${encodeURIComponent(a.id)}`} className="wb-link" style={{ fontSize: 13 }}>Details</a>
              <a href={`/?tsenta=${encodeURIComponent(a.id)}`} className="wb-link" style={{ fontSize: 13 }}>Open in Applications</a>
            </header>

            {!a.emails && <div className="wb-err">This application has no written emails. Start it again from the board.</div>}

            {picked.map((p) => {
              const m = mails[p.id];
              return (
                <article key={p.id} className="wr-mail">
                  <div className="wr-mail-h">
                    <input type="checkbox" checked={m.include} onChange={(e) => setMail(p.id, { include: e.target.checked })} aria-label={`Include ${p.firstName}`} />
                    <span><b>{p.firstName}</b> <span className="meta">· {p.title}</span></span>
                    <span className="v">{VERSION[p.variant]}</span>
                    <span className={`wb-cost ${p.source === "apollo" ? "credit" : "free"}`}>{p.source === "apollo" ? "1 credit to reveal" : p.source === "hunter" ? "Hunter, free" : "on file, free"}</span>
                  </div>
                  <div className="wr-mail-b">
                    <label><span>Subject</span><input value={m.subject} onChange={(e) => setMail(p.id, { subject: e.target.value })} /></label>
                    <span className="meta" style={{ fontSize: 13 }}>Hi {p.firstName},</span>
                    <textarea aria-label={`Email to ${p.firstName}`} value={m.body} onChange={(e) => setMail(p.id, { body: e.target.value })} />
                    <span className={`wr-att${resumeReady ? "" : " wait"}`}>
                      {fallback === "base" ? `Your base résumé attached (${d!.resume.baseName})` : d!.resume.saved ? `Tsenta's ${a.tailored === false ? "submitted" : "tailored"} résumé attached (${d!.resume.name})` : "Waiting on Tsenta's résumé: the next sync fetches it"}
                    </span>
                  </div>
                  {m.result && <div className="wr-mail-res" style={{ color: m.result.ok ? "var(--ok)" : "var(--err)" }}>{m.result.text}</div>}
                </article>
              );
            })}

            <div className="wr-act">
              <span className="grow">
                <b>{included.length} {included.length === 1 ? "person" : "people"}</b>
                {" · "}<span style={{ color: credits ? "var(--warn)" : "var(--ok)" }}>{credits ? `${credits} Apollo ${credits === 1 ? "credit" : "credits"} to reveal emails` : "no credits"}</span>
                {included.length - credits > 0 ? ` · ${included.length - credits} free` : ""}
              </span>
              {!resumeReady && <button type="button" className="wb-btn" onClick={() => void useBase()}>Use base résumé instead</button>}
              <button type="button" className="wb-btn" onClick={next}>Skip for now</button>
              <button type="button" className="wb-btn" disabled={!!busy || !resumeReady || !included.length || !a.emails} onClick={() => void createDrafts(false)}>{busy === "drafts" ? "Creating…" : "Create drafts"}</button>
              <button type="button" className="wb-btn primary" disabled={!!busy || !resumeReady || !included.length || !a.emails} onClick={() => void createDrafts(true)}>{busy === "send" ? "Sending…" : "Create drafts and send"}</button>
              <span className="note">
                {resumeReady ? "Create drafts puts them in Gmail for you to send there. Either way the next company opens." : "Drafts wait for Tsenta's résumé. Ask Claude to “sync tsenta”, or use your base résumé."}
                {row && ` · ${STAGE[row.stage].label}`}
              </span>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
