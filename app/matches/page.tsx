"use client";

// /matches — roles that opened at companies you're watching, scored against your
// résumé. Three tabs: what's new, what you've already asked about, and the
// watchlist itself.
//
// Nothing on this page spends an Apollo credit. Companies resolve through the
// same free /api/company/resolve the Companies page uses, the optional contact
// through the free /api/people/find, and job postings are free to read. The only
// billed step is the model call, and that happens in the background sweep on
// postings that are both new and past the title filter.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PageHeader } from "../_components/AppShell";
import { useCompose } from "../_components/Compose";
import { DEFAULT_ROLE_KEYWORDS } from "@/src/roleDefaults";

type Tab = "new" | "asked" | "watching";

interface WatchContact {
  name: string;
  title?: string | null;
  email?: string | null;
  source: "typed" | "contacts_csv" | "apollo_find";
  howYouKnowThem?: string | null;
}

interface Watch {
  id: string;
  orgId: string;
  name: string;
  domain?: string | null;
  logoUrl?: string | null;
  titles: string[];
  locations: string[];
  contact: WatchContact | null;
  lastSweptAt?: string | null;
  baselinedAt?: string | null;
  lastError?: string | null;
}

interface Match {
  id: string;
  watchId: string;
  company: string;
  domain?: string | null;
  logoUrl?: string | null;
  title: string;
  location?: string | null;
  url?: string | null;
  postedAt?: string | null;
  score: number;
  verdict: "strong" | "worth_a_look" | "stretch" | "skip";
  strengths: { claim: string; resumeQuote: string }[];
  gaps: string[];
  referralLine: string;
  groundedInJd: boolean;
  jdSource?: string | null;
  contact: WatchContact | null;
  status: "new" | "asked" | "dismissed";
  foundAt: string;
}

const VERDICT_LABEL: Record<Match["verdict"], string> = {
  strong: "Strong",
  worth_a_look: "Worth a look",
  stretch: "Stretch",
  skip: "Skip",
};

// Every name that reaches these can be missing: Apollo's free people search
// omits first_name on some records, and a contacts CSV row can have neither
// name column filled. They are display helpers, so they degrade rather than throw.
function tint(name: string | null | undefined): string {
  const s = name ?? "";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h} 52% 45%)`;
}
function initials(name: string | null | undefined): string {
  return (name ?? "").trim().slice(0, 2).toUpperCase() || "?";
}
function avatarLetter(name: string | null | undefined): string {
  return (name ?? "").trim().slice(0, 1).toUpperCase() || "?";
}
function firstNameOf(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] || "them";
}
// The keyword list is identical across most watches, so listing it on every row
// is 15 chips of noise repeated per company. A count carries the same signal —
// open the watch to see or change the actual keywords.
function filterSummary(w: Watch): string {
  const roles = w.titles.length === 0 ? "all roles" : `${w.titles.length} role${w.titles.length === 1 ? "" : "s"}`;
  return w.locations.length > 0 ? `${roles} · ${w.locations.join(", ")}` : roles;
}
function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const days = Math.round((Date.now() - t) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export default function MatchesPage() {
  const [tab, setTab] = useState<Tab>("new");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [watches, setWatches] = useState<Watch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepNote, setSweepNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, w] = await Promise.all([fetch("/api/matches"), fetch("/api/watchlist")]);
      const md = await m.json();
      const wd = await w.json();
      if (!m.ok) throw new Error(md.error ?? "Could not load matches.");
      if (!w.ok) throw new Error(wd.error ?? "Could not load the watchlist.");
      setMatches(md.matches ?? []);
      setWatches(wd.watches ?? []);
    } catch (e: any) {
      setError(e.message);
      setMatches([]);
      setWatches([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(id: string, status: Match["status"]) {
    setMatches((prev) => (prev ?? []).map((m) => (m.id === id ? { ...m, status } : m)));
    try {
      await fetch("/api/matches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      // Nudge the sidebar count — it would otherwise stay stale until you navigate.
      window.dispatchEvent(new CustomEvent("warmreach:matches-changed"));
    } catch {
      void load(); // put the row back where it was if the write failed
    }
  }

  // Dismissing is one click and there's no Dismissed tab to fish things out of,
  // so every dismissal leaves an undo behind until the next one replaces it.
  function dismiss(m: Match) {
    setUndo({ id: m.id, title: m.title });
    void setStatus(m.id, "dismissed");
  }

  async function checkNow() {
    setSweeping(true);
    setError(null);
    setSweepNote(null);
    try {
      const r = await fetch("/api/watchlist/sweep", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Sweep failed.");
      await load();
      // Say what happened. "Nothing new" is a real, common result and silence
      // after a minute-long wait reads as a failure.
      const co = (n: number) => `${n} ${n === 1 ? "company" : "companies"}`;
      const more = d.remaining > 0 ? ` ${co(d.remaining)} hit this run's limit — press again to continue.` : "";
      setSweepNote(
        (d.matches > 0
          ? `Found ${d.matches} new ${d.matches === 1 ? "role" : "roles"} across ${co(d.swept)}.`
          : `Checked ${co(d.swept)} — nothing new worth surfacing.`) + more,
      );
      if (d.matches > 0) setTab("new");
      window.dispatchEvent(new CustomEvent("warmreach:matches-changed"));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSweeping(false);
    }
  }

  const newOnes = (matches ?? []).filter((m) => m.status === "new");
  const asked = (matches ?? []).filter((m) => m.status === "asked");
  const lastSwept = (watches ?? [])
    .map((w) => w.lastSweptAt)
    .filter(Boolean)
    .sort()
    .pop();

  // Every page wraps its content in .workspace-inner — that's what supplies the
  // max-width and the side padding. <main class="workspace"> itself has neither.
  return (
    <div className="workspace-inner">
      <PageHeader
        title="Matches"
        subtitle={
          watches === null
            ? "Loading…"
            : watches.length === 0
              ? "Watch a company and new roles there get scored against your résumé each day."
              : `${watches.length} ${watches.length === 1 ? "company" : "companies"} · last checked ${ago(lastSwept)}`
        }
      />

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <div className="wl-tabs" role="tablist">
          {([
            ["new", "New", newOnes.length],
            ["asked", "Asked", asked.length],
            ["watching", "Watching", watches?.length ?? 0],
          ] as [Tab, string, number][]).map(([key, label, n]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? "wl-tab is-on" : "wl-tab"}
              onClick={() => setTab(key)}
            >
              {label} <span className="wl-tab-n">{n}</span>
            </button>
          ))}
          <div className="wl-tabs-right">
            <button type="button" className="btn-sm" onClick={checkNow} disabled={sweeping || !watches?.length}>
              {sweeping ? <span className="spinner" /> : null}
              {sweeping ? "Checking…" : "Check now"}
            </button>
          </div>
        </div>

        {sweeping && (
          <div className="wl-note">
            Reading each company's board and scoring anything new. This can take a minute — you can leave the page, it
            keeps running.
          </div>
        )}
        {!sweeping && sweepNote && <div className="wl-note">{sweepNote}</div>}
      </div>

      {undo && tab === "new" && (
        <div className="card wl-undo">
          <span>
            Dismissed <strong>{undo.title}</strong>.
          </span>
          <button
            type="button"
            className="btn-link-ghost"
            onClick={() => {
              void setStatus(undo.id, "new");
              setUndo(null);
            }}
          >
            Undo
          </button>
        </div>
      )}

      {tab === "new" && (
        <MatchList
          matches={newOnes}
          empty={
            watches?.length
              ? "Nothing new since the last check. Roles show up here within a day or two of Apollo seeing them."
              : "Watch a company and any new role there gets scored against your résumé — with the referral email ready to send if you know someone."
          }
          action={
            watches?.length ? null : (
              <button
                type="button"
                className="btn-link-primary"
                onClick={() => {
                  setTab("watching");
                  setAdding(true);
                }}
              >
                Watch your first company
              </button>
            )
          }
          onStatus={setStatus}
          onDismiss={dismiss}
        />
      )}

      {tab === "asked" && (
        <MatchList
          matches={asked}
          empty="Roles you've asked about will collect here."
          onStatus={setStatus}
          onDismiss={dismiss}
        />
      )}

      {tab === "watching" && (
        <WatchingTab
          watches={watches ?? []}
          adding={adding}
          onAdd={() => setAdding(true)}
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await load();
          }}
          onRemove={async (id) => {
            await fetch("/api/watchlist", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id }),
            });
            await load();
          }}
        />
      )}
    </div>
  );
}

// ── matches ─────────────────────────────────────────────────────────────────

function MatchList({
  matches,
  empty,
  action,
  onStatus,
  onDismiss,
}: {
  matches: Match[];
  empty: string;
  action?: ReactNode;
  onStatus: (id: string, status: Match["status"]) => void;
  onDismiss: (m: Match) => void;
}) {
  if (matches.length === 0) {
    return (
      <div className="card wl-empty">
        <div className="hint">
          <span className="i">◍</span>
          {empty}
        </div>
        {action}
      </div>
    );
  }
  return (
    <div className="wl-list">
      {matches.map((m) => (
        <MatchCard key={m.id} match={m} onStatus={onStatus} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function MatchCard({
  match,
  onStatus,
  onDismiss,
}: {
  match: Match;
  onStatus: (id: string, s: Match["status"]) => void;
  onDismiss: (m: Match) => void;
}) {
  const openCompose = useCompose();
  const contact = match.contact;
  // A contact with no address can't be emailed yet — revealing one costs a
  // credit, so that stays an explicit trip to People rather than a side effect
  // of clicking "ask for a referral".
  const peopleHref = `/people?${new URLSearchParams({
    ...(match.domain ? { domain: match.domain } : {}),
    name: match.company,
    role: match.title,
  }).toString()}`;

  function askForReferral() {
    if (!contact?.email) return; // guarded by the button, belt-and-braces
    const first = firstNameOf(contact.name);
    const opener = contact.howYouKnowThem
      ? `Hope things are good — it's been a while since ${contact.howYouKnowThem}.`
      : "Hope you're doing well.";
    const lines = [
      `Hi ${first},`,
      "",
      opener,
      "",
      `${match.company} just opened ${match.title}, and it's close enough to what I've been doing that I wanted to ask you directly rather than drop it in the pile.`,
      "",
      match.referralLine,
      "",
      "Would you be up for referring me? Happy to send over anything that makes it easy.",
    ];
    if (match.url) lines.push("", `The posting: ${match.url}`);
    const body = lines.join("\n");

    openCompose({
      to: contact.email ?? "",
      name: contact.name,
      subject: `Quick one — ${match.title} at ${match.company}`,
      body,
    });
    onStatus(match.id, "asked");
  }

  return (
    <article className={`card wl-match wl-match--${match.verdict}`}>
      <div className="wl-stripe" />
      <div className="wl-match-in">
        <div className="wl-match-head">
          {match.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="co-logo" src={match.logoUrl} alt="" />
          ) : (
            <span className="co-logo co-logo--mono" style={{ background: tint(match.company), color: "#fff" }}>
              {initials(match.company)}
            </span>
          )}
          <div className="wl-match-headings">
            <div className="wl-match-title">{match.title}</div>
            <div className="wl-match-meta">
              {match.company}
              {match.location ? ` · ${match.location}` : ""} · found {ago(match.foundAt)}
            </div>
          </div>
          <div className="wl-fit">
            <div className="wl-fit-n">{match.score}</div>
            <span className="wl-pill">{VERDICT_LABEL[match.verdict]}</span>
          </div>
        </div>

        {(match.strengths.length > 0 || match.gaps.length > 0) && (
          <div className="wl-why">
            {match.strengths.map((s, i) => (
              <div className="wl-why-row" key={`s${i}`}>
                <span className="wl-mark">✓</span>
                <span>
                  {s.claim} <span className="wl-quote">“{s.resumeQuote}”</span>
                </span>
              </div>
            ))}
            {match.gaps.map((g, i) => (
              <div className="wl-why-row" key={`g${i}`}>
                <span className="wl-mark wl-mark--gap">△</span>
                <span>{g}</span>
              </div>
            ))}
          </div>
        )}

        {contact && (
          <div className="wl-friend">
            <span className="wl-friend-av">{avatarLetter(contact.name)}</span>
            <span>
              <strong>{contact.name}</strong>
              {contact.title ? ` — ${contact.title}` : ""} works here
              {contact.email ? "" : " (no email on file yet)"}.
            </span>
          </div>
        )}

        <div className="wl-prov">
          <span className="wl-chip">
            {match.groundedInJd ? `description read · ${match.jdSource ?? "web"}` : "title only · no description"}
          </span>
          {!match.groundedInJd && <span className="wl-chip wl-chip--warn">weaker read</span>}
        </div>

        <div className="wl-acts">
          {contact?.email && (
            <button type="button" className="btn-link-primary" onClick={askForReferral}>
              Ask {firstNameOf(contact.name)} for a referral
            </button>
          )}
          {contact && !contact.email && (
            <a className="btn-link-primary" href={peopleHref}>
              Find {firstNameOf(contact.name)}’s email
            </a>
          )}
          {!contact && (
            <a className="btn-link-primary" href={peopleHref}>
              Find someone here
            </a>
          )}
          {match.url && (
            <a className="btn-link-ghost" href={match.url} target="_blank" rel="noreferrer">
              Open posting
            </a>
          )}
          {match.status === "asked" && (
            <button type="button" className="btn-link-ghost" onClick={() => onStatus(match.id, "new")}>
              Move back to New
            </button>
          )}
          {match.status === "new" && (
            <button type="button" className="btn-link-ghost" onClick={() => onDismiss(match)}>
              Not interested
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

// ── watching ────────────────────────────────────────────────────────────────

function WatchingTab({
  watches,
  adding,
  onAdd,
  onClose,
  onSaved,
  onRemove,
}: {
  watches: Watch[];
  adding: boolean;
  onAdd: () => void;
  onClose: () => void;
  onSaved: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <>
      {adding && <AddWatchPanel onClose={onClose} onSaved={onSaved} />}

      {!adding && (
        <div className="card">
          <div className="wl-addbar">
            <div>
              <div className="wl-addbar-t">Watch a company</div>
              <div className="wl-addbar-s">
                Checked once a day. Adding one costs nothing — no Apollo credits, no model calls.
              </div>
            </div>
            <button type="button" className="btn-link-primary" onClick={onAdd}>
              Add a company
            </button>
          </div>
        </div>
      )}

      {watches.length === 0 && !adding && (
        <div className="card">
          <div className="hint">
            <span className="i">◍</span>
            Nothing watched yet. Start with the companies where you actually know someone — that's what makes the
            referral ask worth sending.
          </div>
        </div>
      )}

      {watches.length > 0 && (
        <div className="card">
          {watches.map((w) => (
            <div className="wl-row" key={w.id}>
              {w.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="co-logo" src={w.logoUrl} alt="" />
              ) : (
                <span className="co-logo co-logo--mono" style={{ background: tint(w.name), color: "#fff" }}>
                  {initials(w.name)}
                </span>
              )}
              <div className="wl-row-main">
                <div className="wl-row-name">
                  {w.name} <span className="wl-row-dom">{w.domain ?? "—"}</span>
                </div>
                <div className="wl-row-sub">
                  {w.contact
                    ? `${w.contact.name}${w.contact.title ? ` — ${w.contact.title}` : ""}`
                    : "No contact — cards will offer to find one"}
                  {" · "}
                  {filterSummary(w)}
                  {" · checked "}
                  {ago(w.lastSweptAt)}
                </div>
                {w.lastError && <div className="wl-row-err">Last check failed: {w.lastError}</div>}
              </div>
              <button
                type="button"
                className="btn-link-ghost"
                onClick={() => {
                  // Removing also drops the seen-posting baseline, so re-adding
                  // would replay the company's whole board as "new".
                  if (confirm(`Stop watching ${w.name}? Matches already found stay where they are.`)) onRemove(w.id);
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── the add panel ───────────────────────────────────────────────────────────

interface CompanyOption {
  orgId: string | null;
  name: string;
  domain: string | null;
  description: string | null;
  keywords: string[];
  employees: number | null;
  logoUrl: string | null;
}

interface Preview {
  total: number;
  matched: number;
  examples: string[];
  rolesError: string | null;
  contacts: { name: string; title: string | null; email: string | null }[];
}

interface FoundPerson {
  id: string;
  // Apollo's free search omits these on some records — optional on purpose.
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
}

function AddWatchPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<CompanyOption[] | null>(null);
  const [picked, setPicked] = useState<CompanyOption | null>(null);
  const [searching, setSearching] = useState(false);

  const [titleInput, setTitleInput] = useState("");
  // Seeded with the standard engineering set — most watches want these, and the
  // live count below makes it obvious when they're catching too much or too little.
  const [titles, setTitles] = useState<string[]>(DEFAULT_ROLE_KEYWORDS);
  const [location, setLocation] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [contactName, setContactName] = useState("");
  const [contact, setContact] = useState<WatchContact | null>(null);
  const [people, setPeople] = useState<FoundPerson[] | null>(null);
  const [looking, setLooking] = useState(false);
  const [how, setHow] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function searchCompany() {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const r = await fetch("/api/company/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: query.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Company search failed.");
      setOptions(d.companies ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
  }

  // Refresh the "N of M roles" preview whenever the company or filters change.
  // Debounced: `location` is a free-text field, and without this every keystroke
  // of "United States" would fire its own Apollo request.
  useEffect(() => {
    if (!picked?.orgId) return;
    let live = true;
    setPreviewing(true);
    const timer = setTimeout(async () => {
      try {
        const r = await fetch("/api/watchlist/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orgId: picked.orgId,
            name: picked.name,
            domain: picked.domain,
            titles,
            locations: location.trim() ? [location.trim()] : [],
          }),
        });
        const d = await r.json();
        if (live && r.ok) setPreview(d);
      } catch {
        /* preview is advisory — a failure shouldn't block saving */
      } finally {
        if (live) setPreviewing(false);
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [picked, titles, location]);

  function addTitle() {
    const t = titleInput.trim().toLowerCase();
    if (!t || titles.includes(t)) return;
    setTitles([...titles, t]);
    setTitleInput("");
  }

  // Free by-name search, scoped to the picked company. No credit — this is the
  // same endpoint the People page uses before you choose to reveal an email.
  async function lookUpPerson() {
    if (!contactName.trim() || !picked) return;
    setLooking(true);
    try {
      const r = await fetch("/api/people/find", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: contactName.trim(), company: picked.domain ?? picked.name }),
      });
      const d = await r.json();
      if (r.ok) setPeople((d.people ?? []).slice(0, 4));
    } catch {
      /* stay on the typed name */
    } finally {
      setLooking(false);
    }
  }

  async function save() {
    if (!picked?.orgId) return;
    setSaving(true);
    setError(null);
    try {
      // A typed name with no lookup is a perfectly valid contact.
      const finalContact: WatchContact | null =
        contact ?? (contactName.trim() ? { name: contactName.trim(), source: "typed" } : null);

      const r = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId: picked.orgId,
          name: picked.name,
          domain: picked.domain,
          logoUrl: picked.logoUrl,
          description: picked.description,
          keywords: picked.keywords,
          titles,
          locations: location.trim() ? [location.trim()] : [],
          contact: finalContact ? { ...finalContact, howYouKnowThem: how.trim() || null } : null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Could not save the watch.");
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card wl-panel">
      <div className="wl-panel-head">
        <div>
          <div className="wl-panel-t">Watch a company</div>
          <div className="wl-panel-s">Checked once a day. Nothing here spends an Apollo credit.</div>
        </div>
        <button type="button" className="wl-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="wl-panel-body">
        {error && <div className="error-box">{error}</div>}

        {/* company */}
        <div className="wl-field">
          <div className="wl-label">Company</div>
          <div className="searchbar">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchCompany()}
              placeholder="Company name or domain — e.g. Ramp, stripe.com"
            />
            <button type="button" onClick={searchCompany} disabled={searching || !query.trim()}>
              {searching ? <span className="spinner" /> : null}
              Search
            </button>
          </div>
          {options?.map((c) => (
            <button
              type="button"
              key={`${c.orgId}-${c.domain}`}
              className={picked?.orgId === c.orgId ? "wl-cand is-on" : "wl-cand"}
              onClick={() => {
                setPicked(c);
                // Everything below the company field describes the OLD company —
                // keeping it would let you save Ramp with a Stripe contact.
                setPreview(null);
                setPeople(null);
                setContact(null);
                setContactName("");
                setHow("");
              }}
              disabled={!c.orgId}
            >
              {c.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="co-logo" src={c.logoUrl} alt="" />
              ) : (
                <span className="co-logo co-logo--mono" style={{ background: tint(c.name), color: "#fff" }}>
                  {initials(c.name)}
                </span>
              )}
              <span className="wl-cand-main">
                <span className="wl-cand-n">{c.name}</span>
                <span className="wl-cand-d">
                  {c.domain ?? "no domain"}
                  {c.employees ? ` · ${c.employees.toLocaleString()} employees` : ""}
                  {!c.orgId ? " · can't be watched" : ""}
                </span>
              </span>
              {picked?.orgId === c.orgId && <span className="wl-cand-tick">✓</span>}
            </button>
          ))}
        </div>

        {picked && (
          <>
            {/* roles */}
            <div className="wl-field">
              <div className="wl-label">
                Roles to watch for
                <span className="wl-label-actions">
                  {titles.length > 0 && (
                    <button type="button" className="wl-linkbtn" onClick={() => setTitles([])}>
                      Clear all
                    </button>
                  )}
                  {titles.join("|") !== DEFAULT_ROLE_KEYWORDS.join("|") && (
                    <button type="button" className="wl-linkbtn" onClick={() => setTitles(DEFAULT_ROLE_KEYWORDS)}>
                      Reset to defaults
                    </button>
                  )}
                </span>
              </div>
              <div className="wl-tagbox">
                {titles.map((t) => (
                  <span className="wl-tag" key={t}>
                    {t}
                    <button type="button" onClick={() => setTitles(titles.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
                      ×
                    </button>
                  </span>
                ))}
                <input
                  value={titleInput}
                  onChange={(e) => setTitleInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addTitle();
                    }
                  }}
                  onBlur={addTitle}
                  placeholder={titles.length ? "add a keyword…" : "backend, payments, new grad…"}
                />
              </div>
              <input
                className="wl-input"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Location contains — e.g. United States, Remote (optional)"
              />
              {titles.length === 0 && (
                <div className="wl-preview wl-preview--warn">
                  No keywords — <strong>every</strong> new role at this company gets scored, including sales and
                  recruiting. Add a few unless that's what you want.
                </div>
              )}
              {preview?.rolesError && (
                <div className="wl-preview wl-preview--warn">
                  Couldn’t read this company’s open roles just now — you can still save the watch and it’ll try again on
                  the next check.
                </div>
              )}
              {preview && !preview.rolesError && (
                <div className={preview.matched === 0 ? "wl-preview wl-preview--warn" : "wl-preview"}>
                  {previewing ? (
                    <>Counting matching roles…</>
                  ) : preview.matched === 0 ? (
                    <>
                      <strong>No</strong> current roles match these keywords — you'd only hear about future ones. Try
                      broadening them.
                    </>
                  ) : (
                    <>
                      <strong>
                        {preview.matched} of {preview.total} open roles
                      </strong>{" "}
                      match this right now.
                    </>
                  )}
                  {!previewing && preview.examples.length > 0 && (
                    <div className="wl-preview-eg">{preview.examples.join(" · ")}</div>
                  )}
                </div>
              )}
            </div>

            {/* person — optional */}
            <div className="wl-field">
              <div className="wl-label">
                Someone you know here <span className="wl-opt">Optional</span>
              </div>

              {preview && preview.contacts.length > 0 && (
                <>
                  <div className="wl-known">
                    You have {preview.contacts.length} contact{preview.contacts.length === 1 ? "" : "s"} on file for{" "}
                    {picked.domain ?? picked.name} — no credit to use one.
                  </div>
                  {preview.contacts.map((c, i) => (
                    <button
                      type="button"
                      key={`${c.email ?? ""}-${c.name}-${i}`}
                      className={contact?.email === c.email && c.email ? "wl-cand is-on" : "wl-cand"}
                      onClick={() => {
                        setContact({ name: c.name, title: c.title, email: c.email, source: "contacts_csv" });
                        setContactName(c.name);
                        setPeople(null);
                      }}
                    >
                      <span className="wl-friend-av">{avatarLetter(c.name)}</span>
                      <span className="wl-cand-main">
                        <span className="wl-cand-n">
                          {c.name}
                          {c.title ? ` — ${c.title}` : ""}
                        </span>
                        <span className="wl-cand-d">from your contacts · email on file</span>
                      </span>
                      {contact?.email === c.email && c.email && <span className="wl-cand-tick">✓</span>}
                    </button>
                  ))}
                </>
              )}

              <div className="searchbar">
                <input
                  value={contactName}
                  onChange={(e) => {
                    setContactName(e.target.value);
                    setContact(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && lookUpPerson()}
                  placeholder="Their name — just a first name is enough"
                />
                <button type="button" onClick={lookUpPerson} disabled={looking || !contactName.trim()}>
                  {looking ? <span className="spinner" /> : null}
                  Look up
                </button>
              </div>

              {people
                ?.map((p) => ({ p, full: [p.first_name, p.last_name].filter(Boolean).join(" ").trim() }))
                // A record with no name at all is unusable as a contact — it can't
                // be addressed and can't be recognised. Drop it rather than render
                // a blank row you can still click.
                .filter(({ full }) => full.length > 0)
                .map(({ p, full }) => {
                return (
                  <button
                    type="button"
                    key={p.id}
                    className={contact?.name === full && contact.source === "apollo_find" ? "wl-cand is-on" : "wl-cand"}
                    onClick={() => setContact({ name: full, title: p.title, email: null, source: "apollo_find" })}
                  >
                    <span className="wl-friend-av">{avatarLetter(full)}</span>
                    <span className="wl-cand-main">
                      <span className="wl-cand-n">
                        {full}
                        {p.title ? ` — ${p.title}` : ""}
                      </span>
                      <span className="wl-cand-d">from Apollo · free, no email revealed</span>
                    </span>
                    {contact?.name === full && contact.source === "apollo_find" && <span className="wl-cand-tick">✓</span>}
                  </button>
                );
                })}

              {people?.length === 0 && (
                <div className="hint">
                  <span className="i">◍</span>
                  No one by that name showed up at this company. The typed name still works — you just won't get their
                  title on the card.
                </div>
              )}

              {(contact || contactName.trim()) && (
                <input
                  className="wl-input"
                  value={how}
                  onChange={(e) => setHow(e.target.value)}
                  placeholder="How you know them — “worked together at Candex” (used in the referral email)"
                />
              )}

              <div className="hint">
                <span className="i">◍</span>
                Skip this and the watch still runs — match cards just offer to find someone instead. An email address is
                only revealed later, when you actually send.
              </div>
            </div>
          </>
        )}
      </div>

      <div className="wl-panel-foot">
        <span className="wl-foot-note">Checked daily while the local server is running.</span>
        <div className="wl-foot-actions">
          <button type="button" className="btn-link-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-link-primary" onClick={save} disabled={saving || !picked?.orgId}>
            {saving ? <span className="spinner" /> : null}
            Start watching
          </button>
        </div>
      </div>
    </div>
  );
}
