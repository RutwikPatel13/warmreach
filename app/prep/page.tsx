"use client";

// /prep — the LeetCode questions a company actually asks, as a worklist.
//
// The page leads with a queue rather than a table: opening it the night before
// a screen should answer "what do I do next", not "here is everything that
// exists". Priority runs resumed work → asked in the last 30 days → Hard →
// the rest, and each entry says why it's there.
//
// Nothing here spends a credit and nothing here talks to LeetCode. Reading is
// pure disk (/api/prep); fetching questions is an explicit sync you trigger
// (/api/prep/sync), and even that has a mirrors-only mode that makes no
// request to LeetCode at all.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../_components/AppShell";
import CodeBlock from "./CodeBlock";

type Status = "todo" | "doing" | "done";
type Difficulty = "Easy" | "Medium" | "Hard";
type SortKey = "rank" | "diff" | "acc" | "num";

interface PrepQuestion {
  id: number;
  slug: string;
  title: string;
  difficulty: Difficulty;
  acceptance: number;
  rank: number;
  windows: string[];
  lcSolved: boolean;
  tags: string[];
  statement: string;
  section?: string;
  paidOnly?: boolean;
}
interface PrepSet {
  company: string;
  label: string;
  kind: "company" | "studyplan";
  sections?: string[];
  syncedAt: string;
  sources: { repo: string; snapshot: string; windows: string[] }[];
  questions: PrepQuestion[];
}
interface Progress {
  st: Status;
  code: string;
  lang: string;
  notes: string;
  at: string | null;
}
interface Payload {
  set: PrepSet | null;
  progress: Record<string, Progress>;
  companies: { company: string; label: string; kind: string; total: number; syncedAt: string }[];
  suggestions: { company: string; label: string }[];
}

const STUBS: Record<string, string> = {
  python3: "class Solution:\n    def solve(self):\n        ",
  java: "class Solution {\n    public void solve() {\n        \n    }\n}",
  cpp: "class Solution {\npublic:\n    void solve() {\n        \n    }\n};",
  javascript: "var solve = function() {\n    \n};",
  go: "func solve() {\n    \n}",
};
const DIFF_CLASS: Record<Difficulty, string> = { Easy: "e", Medium: "m", Hard: "h" };
const DIFF_ORDER: Record<Difficulty, number> = { Hard: 0, Medium: 1, Easy: 2 };
const NEXT_STATUS: Record<Status, Status> = { todo: "doing", doing: "done", done: "todo" };
const STATUS_GLYPH: Record<Status, string> = { todo: "", doing: "◐", done: "✓" };
const EMPTY: Progress = { st: "todo", code: "", lang: "python3", notes: "", at: null };

const isRecent = (q: PrepQuestion) => q.windows.includes("thirty-days");

function questionUrl(q: PrepQuestion, company: string): string {
  const w = isRecent(q) ? "thirty-days" : (q.windows[0] ?? "all");
  return `https://leetcode.com/problems/${q.slug}?envType=company&envId=${company}&favoriteSlug=${company}-${w}`;
}

export default function PrepPage() {
  const [company, setCompany] = useState("linkedin");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const [tab, setTab] = useState<"all" | "recent">("all");
  const [diff, setDiff] = useState<"all" | Difficulty>("all");
  const [term, setTerm] = useState("");
  const [sort, setSort] = useState<SortKey>("rank");
  const [tileFilter, setTileFilter] = useState<"recent" | "hard" | "doing" | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  // Which question is in paste mode. Saved solutions render highlighted and
  // read-only until you explicitly reopen them.
  const [editingId, setEditingId] = useState<number | null>(null);

  // Draft edits live here so typing doesn't hit the server on every keystroke;
  // they're flushed by Save. Keyed by question id.
  const drafts = useRef<Record<number, { code?: string; notes?: string; lang?: string }>>({});
  const [savedFlash, setSavedFlash] = useState<number | null>(null);

  // The company lives in the URL so a prep page is linkable, and so switching
  // companies survives a reload.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("company");
    if (p) setCompany(p);
  }, []);

  const load = useCallback(async (co: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/prep?company=${encodeURIComponent(co)}`);
      const json = (await res.json()) as Payload & { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not load prep.");
      setData(json);
      drafts.current = {};
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(company);
    const url = new URL(window.location.href);
    url.searchParams.set("company", company);
    window.history.replaceState(null, "", url);
  }, [company, load]);

  const questions = data?.set?.questions ?? [];
  // A study plan has no recency windows and no frequency ranking. Everything
  // keyed off those is hidden rather than rendered as zeroes, which would read
  // as "nothing asked recently" instead of "that idea doesn't apply here".
  const isPlan = data?.set?.kind === "studyplan";
  const progressOf = useCallback(
    (id: number): Progress => data?.progress?.[String(id)] ?? EMPTY,
    [data],
  );

  const patch = useCallback(
    async (id: number, body: Partial<Progress>) => {
      // Optimistic: the ring and queue should move the instant you click.
      setData((d) =>
        d
          ? { ...d, progress: { ...d.progress, [String(id)]: { ...EMPTY, ...d.progress[String(id)], ...body } } }
          : d,
      );
      try {
        const res = await fetch("/api/prep", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ company, id, ...body }),
        });
        if (!res.ok) {
          const j = (await res.json()) as { error?: string };
          throw new Error(j.error ?? "Save failed.");
        }
      } catch (e) {
        setError((e as Error).message);
        void load(company); // don't leave the UI showing a state the disk doesn't have
      }
    },
    [company, load, setData],
  );

  const sync = useCallback(
    async (mode: "mirrors" | "premium") => {
      setSyncing(true);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch("/api/prep/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ company, mode }),
        });
        const json = (await res.json()) as { error?: string; warnings?: string[]; set?: PrepSet };
        if (!res.ok) throw new Error(json.error ?? "Sync failed.");
        await load(company);
        const n = json.set?.questions.length ?? 0;
        setNotice(
          [`Refreshed ${n} question${n === 1 ? "" : "s"}.`,
            ...(json.warnings ?? [])].join(" "),
        );
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSyncing(false);
      }
    },
    [company, load],
  );

  // ── derived ───────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const done = questions.filter((q) => progressOf(q.id).st === "done").length;
    const byDiff = (["Easy", "Medium", "Hard"] as Difficulty[]).map((d) => {
      const set = questions.filter((q) => q.difficulty === d);
      return { d, done: set.filter((q) => progressOf(q.id).st === "done").length, total: set.length };
    });
    return {
      done,
      total: questions.length,
      byDiff,
      recentLeft: questions.filter((q) => isRecent(q) && progressOf(q.id).st !== "done").length,
      recentTotal: questions.filter(isRecent).length,
      hardLeft: questions.filter((q) => q.difficulty === "Hard" && progressOf(q.id).st !== "done").length,
      hardTotal: questions.filter((q) => q.difficulty === "Hard").length,
      doing: questions.filter((q) => progressOf(q.id).st === "doing").length,
    };
  }, [questions, progressOf]);

  const sectionStats = useMemo(() => {
    if (!isPlan) return [];
    return (data?.set?.sections ?? []).map((name) => {
      const qs = questions.filter((q) => q.section === name);
      return { name, total: qs.length, done: qs.filter((q) => progressOf(q.id).st === "done").length };
    });
  }, [isPlan, data, questions, progressOf]);

  const queue = useMemo(
    () =>
      questions
        .filter((q) => progressOf(q.id).st !== "done")
        .map((q) => {
          if (progressOf(q.id).st === "doing") return { q, p: 0, why: "Picked up, not finished" };
          if (!isPlan && isRecent(q)) return { q, p: 1, why: "Asked in the last 30 days" };
          if (!isPlan && q.difficulty === "Hard") return { q, p: 2, why: "Hard — the gap in your set" };
          // A plan is a curriculum: the next thing to do is the next thing in
          // it, so order carries the meaning frequency would for a company.
          return { q, p: 3, why: isPlan ? (q.section ?? "Next in the plan") : "Not attempted" };
        })
        .sort((a, b) => a.p - b.p || a.q.rank - b.q.rank),
    [questions, progressOf, isPlan],
  );

  const visible = useMemo(() => {
    const t = term.trim().toLowerCase();
    return questions
      .filter((q) => isPlan || tab === "all" || isRecent(q))
      .filter((q) => diff === "all" || q.difficulty === diff)
      .filter((q) => !t || q.title.toLowerCase().includes(t) || String(q.id).includes(t))
      .filter((q) =>
        !tileFilter
          ? true
          : tileFilter === "recent"
            ? isRecent(q) && progressOf(q.id).st !== "done"
            : tileFilter === "hard"
              ? q.difficulty === "Hard" && progressOf(q.id).st !== "done"
              : progressOf(q.id).st === "doing",
      )
      .sort((a, b) =>
        sort === "diff"
          ? DIFF_ORDER[a.difficulty] - DIFF_ORDER[b.difficulty] || a.rank - b.rank
          : sort === "acc"
            ? a.acceptance - b.acceptance
            : sort === "num"
              ? a.id - b.id
              : a.rank - b.rank,
      );
  }, [questions, tab, diff, term, tileFilter, sort, progressOf, isPlan]);

  const focusQuestion = (id: number) => {
    setTileFilter(null);
    setTerm("");
    setDiff("all");
    setTab("all");
    setOpenId(id);
    requestAnimationFrame(() => {
      document.getElementById(`prep-q-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const toggleTile = (k: "recent" | "hard" | "doing") => setTileFilter((v) => (v === k ? null : k));

  const saveSolution = async (q: PrepQuestion) => {
    const d = drafts.current[q.id] ?? {};
    const cur = progressOf(q.id);
    await patch(q.id, {
      code: d.code ?? cur.code,
      notes: d.notes ?? cur.notes,
      lang: d.lang ?? cur.lang,
      // Saving work on something untouched means you've started it.
      ...(cur.st === "todo" ? { st: "doing" as Status } : {}),
    });
    setEditingId(null); // back to the highlighted read view
    setSavedFlash(q.id);
    setTimeout(() => setSavedFlash((v) => (v === q.id ? null : v)), 1400);
  };

  const allCompanies = [
    ...(data?.companies ?? []),
    ...(data?.suggestions ?? []).map((s) => ({ ...s, total: 0, syncedAt: "" })),
  ];
  const ring = stats.total ? stats.done / stats.total : 0;
  const CIRC = 2 * Math.PI * 26;

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="prep-wrap">
      <PageHeader
        title={`${data?.set?.label ?? company} — interview prep`}
        subtitle="Work the queue, save your solution, keep your notes."
      />

      <div className="prep-bar">
        <label className="prep-colabel" htmlFor="prep-co">
          {isPlan ? "Set" : "Company"}
        </label>
        <select
          id="prep-co"
          className="prep-select"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        >
          {!allCompanies.some((c) => c.company === company) && <option value={company}>{company}</option>}
          {allCompanies.map((c) => (
            <option key={c.company} value={c.company}>
              {c.label}
              {c.total ? ` · ${c.total}` : " · not synced"}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-sm btn-link-ghost"
          onClick={() => {
            const name = window.prompt("Company name (e.g. Tesla)");
            if (name?.trim()) setCompany(name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"));
          }}
        >
          + Add
        </button>
        <span className="prep-bar-gap" />
        {data?.set && (
          <span className="prep-synced">
            {data.set.questions.length} questions · synced {data.set.syncedAt.slice(0, 10)}
          </span>
        )}
        {isPlan ? (
          <button
            type="button"
            className="btn-sm btn-link-ghost"
            disabled={syncing}
            onClick={() => void sync("mirrors")}
            title="Re-reads each question from LeetCode's public API. The plan's contents are fixed by LeetCode."
          >
            {syncing && <span className="spinner" />} Refresh from LeetCode
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn-sm btn-link-ghost"
              disabled={syncing}
              onClick={() => void sync("mirrors")}
            >
              {syncing && <span className="spinner" />} Sync from mirrors
            </button>
            <button
              type="button"
              className="btn-sm btn-link-ghost"
              disabled={syncing}
              onClick={() => void sync("premium")}
            >
              Sync from Premium
            </button>
          </>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="prep-notice">{notice}</div>}

      {loading && !data && <div className="prep-empty">Loading…</div>}

      {!loading && !data?.set && (
        <div className="card prep-empty">
          <p>
            No question set for <b>{company}</b> yet.
          </p>
          <p className="prep-dim">
            “Sync from mirrors” pulls the public GitHub lists and makes no request to LeetCode.
            “Sync from Premium” additionally replays your captured session, which is the only
            source current enough for the recent windows.
          </p>
        </div>
      )}

      {data?.set && (
        <>
          {/* ── up next ─────────────────────────────────────────────── */}
          <section className="prep-next">
            <div className="prep-next-h">
              <b>Up next</b>
              <span>
                {queue.length ? `${queue.length} left of ${stats.total}` : "queue clear"}
              </span>
            </div>
            {queue.length === 0 ? (
              <div className="prep-next-done">
                <b>All {stats.total} done.</b>
                Send one back to “to do” from the list to queue a re-run before your screen.
              </div>
            ) : (
              <div className="prep-next-b">
                <div className="prep-lead">
                  <span className="prep-why">{queue[0].why}</span>
                  <h2 className="prep-lead-t">
                    <em>{queue[0].q.id}</em>
                    {queue[0].q.title}
                  </h2>
                  <div className="prep-lead-m">
                    <span className={`prep-pill prep-pill--${DIFF_CLASS[queue[0].q.difficulty]}`}>
                      {queue[0].q.difficulty}
                    </span>
                    <span className="prep-acc prep-acc--wide">
                      {queue[0].q.acceptance.toFixed(1)}% accepted
                    </span>
                    <span className="prep-chip prep-chip--lc">
                      {isPlan ? (queue[0].q.section ?? `#${queue[0].q.rank}`) : `freq #${queue[0].q.rank}`}
                    </span>
                    {isRecent(queue[0].q) && <span className="prep-chip prep-chip--hot">30d</span>}
                  </div>
                  {queue[0].q.statement && <p className="prep-lead-s">{queue[0].q.statement}</p>}
                  <div className="prep-lead-a">
                    <button
                      type="button"
                      className="btn-sm btn-link-primary"
                      onClick={() => {
                        void patch(queue[0].q.id, { st: "doing" });
                        focusQuestion(queue[0].q.id);
                      }}
                    >
                      Start this
                    </button>
                    <a
                      className="btn-sm btn-link-ghost"
                      href={questionUrl(queue[0].q, data.set.company)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open on LeetCode
                    </a>
                  </div>
                </div>
                <div className="prep-qn">
                  {queue.slice(1, 7).map((it, i) => (
                    <button
                      type="button"
                      key={it.q.id}
                      className="prep-qn-i"
                      onClick={() => focusQuestion(it.q.id)}
                    >
                      <span className="prep-qn-n">{i + 2}</span>
                      <span className="prep-qn-t">{it.q.title}</span>
                      <span className={`prep-pill prep-pill--${DIFF_CLASS[it.q.difficulty]}`}>
                        {it.q.difficulty}
                      </span>
                    </button>
                  ))}
                  {queue.length > 7 && (
                    <div className="prep-qn-more">+ {queue.length - 7} more in the list below</div>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* ── summary ─────────────────────────────────────────────── */}
          <section className="prep-tiles">
            <div className="prep-tile prep-tile--ring">
              <svg className="prep-ring" width="62" height="62" viewBox="0 0 62 62" role="img" aria-label={`${stats.done} of ${stats.total} done`}>
                <circle cx="31" cy="31" r="26" fill="none" stroke="var(--surface-2)" strokeWidth="7" />
                <circle
                  cx="31" cy="31" r="26" fill="none" stroke="var(--ok)" strokeWidth="7" strokeLinecap="round"
                  strokeDasharray={`${CIRC * ring} ${CIRC}`}
                  transform="rotate(-90 31 31)"
                />
                <text x="31" y="30" textAnchor="middle" fontSize="16" fontWeight="640" fill="var(--text)">
                  {stats.done}
                </text>
                <text x="31" y="42" textAnchor="middle" fontSize="10" fill="var(--faint)">
                  / {stats.total}
                </text>
              </svg>
              <div className="prep-bars">
                {stats.byDiff.map(({ d, done, total }) => {
                  const v = d === "Easy" ? "--ok" : d === "Medium" ? "--warn" : "--err";
                  return (
                    <div className="prep-brow" key={d}>
                      <span className="prep-brow-l" style={{ color: `var(${v})` }}>
                        {d === "Medium" ? "Med" : d}
                      </span>
                      <span className="prep-track">
                        <span
                          className="prep-fill"
                          style={{ width: `${total ? (done / total) * 100 : 0}%`, background: `var(${v})` }}
                        />
                      </span>
                      <span className="prep-brow-n">
                        {done}/{total}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {isPlan ? (
              <div className="prep-tile prep-tile--sections">
                <span className="prep-k">Sections</span>
                <div className="prep-seclist">
                  {sectionStats.map((sec) => (
                    <div className="prep-secrow" key={sec.name}>
                      <span className="prep-secname" title={sec.name}>
                        {sec.name}
                      </span>
                      <span className="prep-track">
                        <span
                          className="prep-fill"
                          style={{
                            width: `${sec.total ? (sec.done / sec.total) * 100 : 0}%`,
                            background: sec.done === sec.total ? "var(--ok)" : "var(--accent)",
                          }}
                        />
                      </span>
                      <span className="prep-brow-n">
                        {sec.done}/{sec.total}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="prep-tile prep-tile--btn"
                  aria-pressed={tileFilter === "recent"}
                  onClick={() => toggleTile("recent")}
                >
                  <span className="prep-k">Asked in last 30d</span>
                  <span className="prep-v">
                    {stats.recentLeft}
                    <small>left of {stats.recentTotal}</small>
                  </span>
                  <span className="prep-sub">Filter to these</span>
                </button>

                <button
                  type="button"
                  className="prep-tile prep-tile--btn"
                  aria-pressed={tileFilter === "hard"}
                  onClick={() => toggleTile("hard")}
                >
                  <span className="prep-k">Hard, not done</span>
                  <span className="prep-v">
                    {stats.hardLeft}
                    <small>of {stats.hardTotal}</small>
                  </span>
                  <span className="prep-sub">Your widest gap</span>
                </button>
              </>
            )}

            <button
              type="button"
              className="prep-tile prep-tile--btn"
              aria-pressed={tileFilter === "doing"}
              onClick={() => toggleTile("doing")}
            >
              <span className="prep-k">In progress</span>
              <span className="prep-v">
                {stats.doing}
                <small>open</small>
              </span>
              <span className="prep-sub">Started, not finished</span>
            </button>
          </section>

          {/* ── controls ────────────────────────────────────────────── */}
          <div className="prep-ctl">
            {!isPlan && (
            <div className="prep-tabs" role="tablist">
              {(["all", "recent"] as const).map((k) => (
                <button
                  type="button"
                  key={k}
                  role="tab"
                  aria-selected={tab === k}
                  className={tab === k ? "prep-tab is-on" : "prep-tab"}
                  onClick={() => setTab(k)}
                >
                  {k === "all" ? "All" : "Recent"}
                  <span className="prep-tab-n">
                    {k === "all" ? stats.total : stats.recentTotal}
                  </span>
                </button>
              ))}
            </div>
            )}
            <div className="prep-search">
              <span className="prep-mag" aria-hidden="true">
                ⌕
              </span>
              <input
                type="search"
                value={term}
                placeholder="Search questions"
                aria-label="Search questions"
                onChange={(e) => setTerm(e.target.value)}
              />
            </div>
            <div className="prep-seg">
              {(["all", "Easy", "Medium", "Hard"] as const).map((d) => (
                <button
                  type="button"
                  key={d}
                  className={diff === d ? "is-on" : ""}
                  onClick={() => setDiff(d)}
                >
                  {d === "all" ? "All" : d === "Medium" ? "Med" : d}
                </button>
              ))}
            </div>
            <select
              className="prep-select"
              value={sort}
              aria-label="Sort by"
              onChange={(e) => setSort(e.target.value as SortKey)}
            >
              <option value="rank">{isPlan ? "Plan order" : "LeetCode frequency order"}</option>
              <option value="diff">Hardest first</option>
              <option value="acc">Lowest acceptance first</option>
              <option value="num">Question number</option>
            </select>
          </div>

          <p className="prep-note">
            {visible.length !== stats.total
              ? `${visible.length} of ${stats.total} shown`
              : isPlan
                ? "LeetCode's curriculum order, grouped by topic. Work it top to bottom — there's no frequency ranking in a study plan."
                : "Ranked by LeetCode's own frequency order — #1 is asked most. Position is the only honest frequency signal the source gives."}
          </p>

          {/* ── list ────────────────────────────────────────────────── */}
          <div className="prep-list">
            {visible.length === 0 && (
              <div className="prep-empty">
                <span className="prep-glyph">◇</span>
                Nothing matches these filters.
              </div>
            )}
            {visible.map((q, i) => {
              const p = progressOf(q.id);
              // Headers only make sense while the list is in plan order; once
              // you sort by difficulty the grouping no longer holds.
              const header =
                isPlan && sort === "rank" && q.section && q.section !== visible[i - 1]?.section
                  ? q.section
                  : null;
              const open = openId === q.id;
              const draft = drafts.current[q.id] ?? {};
              // Nothing saved yet means straight to paste mode — no empty
              // highlighted block to click through first.
              const editing = editingId === q.id || !p.code.trim();
              return (
                <Fragment key={q.id}>
                {header && (
                  <div className="prep-sechead">
                    <span>{header}</span>
                    <span className="prep-sechead-n">
                      {questions.filter((x) => x.section === header && progressOf(x.id).st === "done").length}
                      {" / "}
                      {questions.filter((x) => x.section === header).length}
                    </span>
                  </div>
                )}
                <div className="prep-q" id={`prep-q-${q.id}`} data-st={p.st} data-open={open ? 1 : 0}>
                  <div className="prep-qrow">
                    <span className="prep-stripe" />
                    <button
                      type="button"
                      className="prep-st"
                      aria-label={`Status: ${p.st}. Click to change.`}
                      title={`Mark ${NEXT_STATUS[p.st] === "doing" ? "in progress" : NEXT_STATUS[p.st] === "done" ? "done" : "to do"}`}
                      onClick={() => void patch(q.id, { st: NEXT_STATUS[p.st] })}
                    >
                      {STATUS_GLYPH[p.st]}
                    </button>
                    <span className="prep-rank">{q.rank}</span>
                    <span className="prep-id">{q.id}</span>
                    <button
                      type="button"
                      className="prep-exp"
                      aria-expanded={open}
                      onClick={() => setOpenId(open ? null : q.id)}
                    >
                      <span className="prep-title">{q.title}</span>
                      {isRecent(q) && <span className="prep-chip prep-chip--hot">30d</span>}
                      {q.lcSolved && <span className="prep-chip prep-chip--lc">solved on LC</span>}
                      {p.code.trim() && <span className="prep-chip prep-chip--saved">saved</span>}
                    </button>
                    <span className="prep-meta">
                      <span className="prep-acc">{q.acceptance.toFixed(1)}%</span>
                      <span className={`prep-pill prep-pill--${DIFF_CLASS[q.difficulty]}`}>
                        {q.difficulty}
                      </span>
                      <span className="prep-chev">▶</span>
                    </span>
                  </div>

                  {open && (
                    <div className="prep-detail">
                      <div className="prep-dtop">
                        <div>
                          <div className="prep-label">Question</div>
                          {q.statement ? (
                            <p className="prep-stmt">{q.statement}</p>
                          ) : q.paidOnly ? (
                            <p className="prep-stmt prep-dim">
                              Premium-only question — LeetCode's public API withholds the text, so
                              syncing won't fetch it. Open it on LeetCode to read the statement.
                            </p>
                          ) : (
                            <p className="prep-stmt prep-dim">
                              No statement stored yet — a sync pulls it from LeetCode's public API.
                            </p>
                          )}
                          <div className="prep-tags">
                            {q.tags.map((t) => (
                              <span className="prep-tag" key={t}>
                                {t}
                              </span>
                            ))}
                          </div>
                        </div>
                        <a
                          className="prep-golink"
                          href={questionUrl(q, data.set!.company)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open on LeetCode →
                        </a>
                      </div>

                      <div className="prep-label">Your solution</div>
                      <div className="prep-ed">
                        <div className="prep-edbar">
                          {editing ? (
                            <select
                              className="prep-select prep-select--sm"
                              aria-label="Language"
                              defaultValue={p.lang}
                              onChange={(e) => {
                                drafts.current[q.id] = { ...drafts.current[q.id], lang: e.target.value };
                              }}
                            >
                              {Object.keys(STUBS).map((l) => (
                                <option key={l}>{l}</option>
                              ))}
                            </select>
                          ) : (
                            <span className="prep-langtag">{p.lang}</span>
                          )}
                          <span className="prep-bar-gap" />
                          <span className="prep-stamp">
                            {p.at ? `saved ${new Date(p.at).toLocaleString()}` : "not saved"}
                          </span>
                          {editing ? (
                            <>
                              <button
                                type="button"
                                className="btn-sm btn-link-ghost"
                                onClick={() => {
                                  const ta = document.getElementById(
                                    `prep-code-${q.id}`,
                                  ) as HTMLTextAreaElement | null;
                                  const lang = drafts.current[q.id]?.lang ?? p.lang;
                                  if (ta) {
                                    ta.value = STUBS[lang] ?? "";
                                    drafts.current[q.id] = { ...drafts.current[q.id], code: ta.value };
                                  }
                                }}
                              >
                                Reset
                              </button>
                              <button
                                type="button"
                                className="btn-sm btn-link-primary"
                                onClick={() => void saveSolution(q)}
                              >
                                {savedFlash === q.id ? "Saved ✓" : "Save"}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn-sm btn-link-ghost"
                              onClick={() => setEditingId(q.id)}
                            >
                              Replace
                            </button>
                          )}
                        </div>
                        {editing ? (
                          <textarea
                            id={`prep-code-${q.id}`}
                            className="prep-code"
                            spellCheck={false}
                            autoFocus
                            placeholder={`Paste your ${p.lang} solution from LeetCode…`}
                            defaultValue={draft.code ?? p.code}
                            onChange={(e) => {
                              drafts.current[q.id] = { ...drafts.current[q.id], code: e.target.value };
                            }}
                          />
                        ) : (
                          <CodeBlock code={p.code} lang={p.lang} />
                        )}
                      </div>
                      <textarea
                        className="prep-notes"
                        placeholder="Approach, edge cases, what tripped you up…"
                        defaultValue={draft.notes ?? p.notes}
                        onChange={(e) => {
                          drafts.current[q.id] = { ...drafts.current[q.id], notes: e.target.value };
                        }}
                      />
                    </div>
                  )}
                </div>
                </Fragment>
              );
            })}
          </div>

          <p className="prep-sources">
            {data.set.sources.map((s) => `${s.repo} (${s.snapshot})`).join(" · ")}
          </p>
        </>
      )}
    </div>
  );
}
