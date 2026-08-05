"use client";

// /people — browse the team at a company for FREE (names, titles, seniority,
// LinkedIn, and whether Apollo holds a verified email). Revealing an email is
// the ONE action that costs a credit; the sidebar meter ticks down on success.

import { useEffect, useState } from "react";
import { PageHeader } from "../_components/AppShell";
import { useCredits } from "../_components/credits";
import { useCompose } from "../_components/Compose";

interface Person {
  id: string;
  firstName: string;
  lastName: string | null;
  title: string;
  seniority: string | null;
  linkedin: string | null;
  photo: string | null;
  location: string | null;
  hasEmail: boolean;
}
interface Company {
  orgId: string | null;
  name: string;
  domain: string | null;
  logoUrl: string | null;
}
interface Revealed {
  fullName: string;
  email: string | null;
  emailStatus: string | null;
  title: string;
}

const GROUPS = [
  { id: "founders", label: "Founders / C-level" },
  { id: "engineering", label: "Engineering leaders" },
  { id: "recruiters", label: "Recruiters / Talent" },
];

function tint(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 52% 45%)`;
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "·";
}
function statusDot(s: string | null): "v" | "g" | "n" {
  const v = (s ?? "").toLowerCase();
  if (v === "verified") return "v";
  if (v.includes("likely") || v.includes("guess") || v.includes("catch")) return "g";
  return "n";
}

function PeopleView() {
  const openCompose = useCompose();
  const { spend } = useCredits();

  const [mode, setMode] = useState<"team" | "person">("team");

  const [company, setCompany] = useState<Company | null>(null);
  const [input, setInput] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [groups, setGroups] = useState<Set<string>>(new Set());
  const [everyone, setEveryone] = useState(false);

  // "Find a person" mode: a name (+ optional company) or a LinkedIn URL.
  const [pName, setPName] = useState("");
  const [pCompany, setPCompany] = useState("");
  const [pLinkedin, setPLinkedin] = useState("");

  const [people, setPeople] = useState<Person[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [revealed, setRevealed] = useState<Record<string, Revealed>>({});
  const [revealing, setRevealing] = useState<Set<string>>(new Set());
  const [rowError, setRowError] = useState<Record<string, string>>({});

  // Paid, opt-in exact lookup by LinkedIn URL (used when the free search finds no one).
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);

  // Arrive from a dossier ("Find people") with the company pre-resolved.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const orgId = p.get("orgId");
    const domain = p.get("domain");
    const name = p.get("name");
    setRole(p.get("role"));
    if (orgId || domain || name) {
      const c = { orgId, name: name ?? domain ?? "", domain, logoUrl: null };
      setCompany(c);
      setInput(name ?? domain ?? "");
      void browse(c);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function browse(preset?: Company) {
    const base = preset ?? company;
    const payload = base
      ? { orgId: base.orgId ?? undefined, domain: base.domain ?? undefined, name: base.name || undefined }
      : { name: input.trim() };
    if (!payload.orgId && !payload.domain && !payload.name) return;

    setLoading(true);
    setError(null);
    setNote(null);
    setRevealed({});
    setRowError({});
    try {
      const r = await fetch("/api/people/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, groups: everyone ? [] : [...groups], all: everyone }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "People search failed.");
      setCompany(d.company);
      setPeople(d.people ?? []);
    } catch (e: any) {
      setError(e.message);
      setPeople([]);
    } finally {
      setLoading(false);
    }
  }

  // Find a specific person by name (+ optional company) or a LinkedIn URL.
  async function findPerson() {
    if (!pName.trim() && !pLinkedin.trim()) return;
    setLoading(true);
    setError(null);
    setNote(null);
    setMatchError(null);
    setRevealed({});
    setRowError({});
    try {
      const r = await fetch("/api/people/find", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: pName.trim() || undefined,
          company: pCompany.trim() || undefined,
          linkedinUrl: pLinkedin.trim() || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "People search failed.");
      setCompany(d.company);
      setPeople(d.people ?? []);
      setNote(d.note ?? null);
    } catch (e: any) {
      setError(e.message);
      setPeople([]);
    } finally {
      setLoading(false);
    }
  }

  // Paid, opt-in: resolve the pasted LinkedIn URL EXACTLY via Apollo's People
  // Match (1 credit) and reveal the email in one step — the fallback for URLs the
  // free search can't read (e.g. ".../in/deepshah08"). Spends a credit on success.
  async function lookupLinkedin() {
    const url = pLinkedin.trim();
    if (!url || matching) return;
    setMatching(true);
    setMatchError(null);
    try {
      const r = await fetch("/api/people/linkedin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkedinUrl: url }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Lookup failed.");
      const person: Person = d.person;
      setNote(null);
      setPeople([person]);
      setRevealed({ [person.id]: d.contact });
      spend(1); // Apollo charged 1 credit for the match — reflect it in the meter
    } catch (e: any) {
      setMatchError(e.message);
    } finally {
      setMatching(false);
    }
  }

  // Switch search mode — clear the results so team hits don't linger under the
  // person controls (or vice-versa).
  function switchMode(next: "team" | "person") {
    if (next === mode) return;
    setMode(next);
    setPeople(null);
    setCompany(null);
    setError(null);
    setNote(null);
    setMatchError(null);
    setRevealed({});
    setRowError({});
  }

  async function reveal(person: Person) {
    if (revealing.has(person.id) || revealed[person.id]) return;
    setRevealing((s) => new Set(s).add(person.id));
    setRowError((m) => {
      const { [person.id]: _, ...rest } = m;
      return rest;
    });
    try {
      const r = await fetch("/api/people/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: person.id, domain: company?.domain ?? undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Reveal failed.");
      setRevealed((m) => ({ ...m, [person.id]: d.contact }));
      spend(1); // Apollo charged 1 credit for the match — reflect it in the meter
    } catch (e: any) {
      setRowError((m) => ({ ...m, [person.id]: e.message }));
    } finally {
      setRevealing((s) => {
        const n = new Set(s);
        n.delete(person.id);
        return n;
      });
    }
  }

  // Seed subject for the compose dock — same wording the old mailto link used.
  function seedSubject(): string {
    return role
      ? `Following up on the ${role} role at ${company?.name ?? "your team"}`
      : `Reaching out — ${company?.name ?? ""}`.trim();
  }

  const toggleGroup = (id: string) => {
    setEveryone(false);
    setGroups((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const availableCount = people?.filter((p) => p.hasEmail).length ?? 0;

  return (
    <>
      <div className="card">
        <div className="cmp-chips" style={{ marginBottom: 14 }}>
          <button
            type="button"
            className={`cmp-chip ${mode === "team" ? "on" : ""}`}
            onClick={() => switchMode("team")}
          >
            Browse a team
          </button>
          <button
            type="button"
            className={`cmp-chip ${mode === "person" ? "on" : ""}`}
            onClick={() => switchMode("person")}
          >
            Find a person
          </button>
        </div>

        {mode === "team" ? (
          <>
            <div className="searchbar">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && browse()}
                placeholder="Company name or domain — e.g. Klaviyo, stripe.com"
              />
              <button type="button" onClick={() => browse()} disabled={loading || (!input.trim() && !company)}>
                {loading ? <span className="spinner" /> : null}
                Find people
              </button>
            </div>

            <div className="ppl-targeting">
              <span className="field-label">Target</span>
              <div className="cmp-chips">
                {GROUPS.map((g) => (
                  <button
                    type="button"
                    key={g.id}
                    className={`cmp-chip ${!everyone && groups.has(g.id) ? "on" : ""} ${everyone ? "muted" : ""}`}
                    onClick={() => toggleGroup(g.id)}
                  >
                    {g.label}
                  </button>
                ))}
                <button
                  type="button"
                  className={`cmp-chip ${everyone ? "on" : ""}`}
                  onClick={() => setEveryone((v) => !v)}
                >
                  Everyone
                </button>
              </div>
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              <span className="i">◍</span>
              Browsing is free. <b>Reveal</b> spends one credit — only the people you actually want to email.
            </p>
          </>
        ) : (
          <>
            <div className="ppl-find">
              <input
                value={pName}
                onChange={(e) => setPName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && findPerson()}
                placeholder="Person's name — e.g. Aaryan Shah"
              />
              <input
                value={pCompany}
                onChange={(e) => setPCompany(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && findPerson()}
                placeholder="Company (optional) — e.g. LinkedIn"
              />
            </div>
            <div className="ppl-find-or">— or paste a LinkedIn profile URL —</div>
            <div className="searchbar">
              <input
                value={pLinkedin}
                onChange={(e) => setPLinkedin(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && findPerson()}
                placeholder="https://linkedin.com/in/aaryan-shah"
              />
              <button
                type="button"
                onClick={() => findPerson()}
                disabled={loading || (!pName.trim() && !pLinkedin.trim())}
              >
                {loading ? <span className="spinner" /> : null}
                Find person
              </button>
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              <span className="i">◍</span>
              Searching by name is free. <b>Reveal</b> spends one credit for the person you pick.
            </p>
          </>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}
      {note && (
        <p className="hint" style={{ margin: "0 2px 14px" }}>
          <span className="i">◍</span>
          {note}
        </p>
      )}

      {people && (
        <div className="card ppl-card">
          <div className="toolbar ppl-head">
            <strong>
              {company?.name || "People"}{" "}
              <span className="meta">
                · {people.length} found · {availableCount} with email on file
              </span>
            </strong>
          </div>

          {people.length === 0 ? (
            <div style={{ padding: "6px 2px" }}>
              <p className="meta">
                {mode === "person"
                  ? "No free match. Try the person’s name (and their company), or check the spelling."
                  : "No people matched. Try a different target group or “Everyone”."}
              </p>
              {mode === "person" && pLinkedin.trim() && (
                <div className="ppl-exact">
                  <button type="button" className="btn-xs" onClick={() => lookupLinkedin()} disabled={matching}>
                    {matching ? <span className="spinner" /> : null}
                    Look up this exact profile <span className="cr">· 1cr</span>
                  </button>
                  <span className="avail-lbl">resolves the URL directly and reveals the email</span>
                  {matchError && <div className="prow-err" style={{ flexBasis: "100%" }}>{matchError}</div>}
                </div>
              )}
            </div>
          ) : (
            <div className="plist">
              {people.map((p) => {
                const full = `${p.firstName}${p.lastName ? " " + p.lastName : ""}`.trim();
                const rev = revealed[p.id];
                const isRevealing = revealing.has(p.id);
                return (
                  <div className="prow" key={p.id}>
                    {p.photo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="pav" src={p.photo} alt="" />
                    ) : (
                      <span className="pav" style={{ background: tint(full) }}>
                        {initials(full)}
                      </span>
                    )}
                    <div className="pmain">
                      <div className="pname">
                        {full}
                        {p.linkedin && (
                          <a className="pli" href={p.linkedin} target="_blank" rel="noreferrer" title="LinkedIn">
                            in↗
                          </a>
                        )}
                      </div>
                      <div className="ptitle">
                        {p.title}
                        {p.seniority ? ` · ${p.seniority}` : ""}
                        {p.location ? ` · ${p.location}` : ""}
                      </div>
                      {rowError[p.id] && <div className="prow-err">{rowError[p.id]}</div>}
                    </div>

                    <div className="pright">
                      {rev ? (
                        rev.email ? (
                          <>
                            <span className={`dot ${statusDot(rev.emailStatus)}`} title={rev.emailStatus ?? "unknown"} />
                            <span className="pemail">{rev.email}</span>
                            <button
                              type="button"
                              className="ghost btn-xs"
                              onClick={() => navigator.clipboard?.writeText(rev.email!)}
                            >
                              Copy
                            </button>
                            <button
                              type="button"
                              className="btn-xs"
                              onClick={() =>
                                openCompose({ to: rev.email!, name: full, subject: seedSubject() })
                              }
                            >
                              ✉ Email
                            </button>
                          </>
                        ) : (
                          <span className="avail-lbl">no email returned</span>
                        )
                      ) : isRevealing ? (
                        <span className="avail-lbl">
                          <span className="spinner" />
                          revealing…
                        </span>
                      ) : p.hasEmail ? (
                        <>
                          <span className="avail-lbl">
                            <span className="dot avail" />
                            email available
                          </span>
                          <button type="button" className="btn-xs" onClick={() => reveal(p)}>
                            Reveal <span className="cr">· 1cr</span>
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="avail-lbl">
                            <span className="dot n" />
                            no email
                          </span>
                          <button type="button" className="btn-xs" disabled>
                            Reveal
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default function PeoplePage() {
  return (
    <div className="workspace-inner">
      <PageHeader title={'People'} subtitle={"Browse the team for free. Reveal an email — one credit — only for the people you'll actually reach."} />
      <PeopleView />
    </div>
  );
}
