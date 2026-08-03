"use client";

// /jobs — the roles a company is actively hiring for (organizations/job_postings,
// FREE). The post-application hook: pick the req you applied to and hand it to the
// People page as context for a personalized draft.

import { useEffect, useState } from "react";
import Shell from "../_components/Shell";
import CompanyDossier, { type Dossier, type Job, type DossierTarget } from "../_components/CompanyDossier";

function tint(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 52% 45%)`;
}
function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase();
}
function fmtPosted(s: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
function peopleQuery(d: Dossier | null, role?: string): string {
  const p = new URLSearchParams();
  if (d?.orgId) p.set("orgId", d.orgId);
  if (d?.domain) p.set("domain", d.domain);
  if (d?.name) p.set("name", d.name);
  if (role) p.set("role", role);
  return p.toString();
}

function JobsView() {
  const [input, setInput] = useState("");
  const [company, setCompany] = useState<Dossier | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<DossierTarget | null>(null);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const orgId = p.get("orgId");
    const domain = p.get("domain");
    const name = p.get("name");
    if (orgId || domain || name) {
      setInput(name ?? domain ?? "");
      void load({ orgId, domain, name });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(preset?: DossierTarget) {
    const payload = preset ?? { name: input.trim() };
    if (!payload.orgId && !payload.domain && !payload.name) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/company/dossier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Could not load open roles.");
      setCompany(d.dossier);
      setJobs(d.jobs ?? []);
    } catch (e: any) {
      setError(e.message);
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="card">
        <div className="searchbar">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
            placeholder="Company name or domain — e.g. Klaviyo, stripe.com"
          />
          <button type="button" onClick={() => load()} disabled={loading || !input.trim()}>
            {loading ? <span className="spinner" /> : null}
            Find roles
          </button>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>
          <span className="i">◍</span>
          Open roles are free to browse. “Draft outreach” carries the role over to People, where you pick who to email.
        </p>
      </div>

      {error && <div className="error-box">{error}</div>}

      {company && jobs && (
        <div className="card">
          <div className="jobs-co">
            {company.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="co-logo" src={company.logoUrl} alt="" />
            ) : (
              <span className="co-logo co-logo--mono" style={{ background: tint(company.name), color: "#fff" }}>
                {initials(company.name)}
              </span>
            )}
            <div className="jobs-co-main">
              <div className="jobs-co-name">{company.name}</div>
              <div className="dz-dom">
                {company.domain ?? "—"} · {jobs.length} open role{jobs.length === 1 ? "" : "s"}
              </div>
            </div>
            <button
              type="button"
              className="ghost btn-sm"
              onClick={() => setTarget({ orgId: company.orgId, domain: company.domain, name: company.name })}
            >
              Full dossier
            </button>
          </div>

          {jobs.length === 0 ? (
            <p className="meta" style={{ padding: "6px 2px" }}>
              No open roles found on Apollo for this company right now.
            </p>
          ) : (
            <div className="jlist">
              {jobs.map((j) => (
                <div className="job" key={j.id}>
                  <div className="jmain">
                    <div className="jtitle">{j.title}</div>
                    <div className="jmeta">
                      {j.location && <span>{j.location}</span>}
                      {j.location && j.postedAt && <span className="sep">·</span>}
                      {j.postedAt && <span>Posted {fmtPosted(j.postedAt)}</span>}
                      {j.url && (
                        <>
                          <span className="sep">·</span>
                          <a className="footer-link" href={j.url} target="_blank" rel="noreferrer">
                            View posting ↗
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                  <a className="btn-link-primary btn-sm" href={`/people?${peopleQuery(company, j.title)}`}>
                    Draft outreach
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <CompanyDossier target={target} onClose={() => setTarget(null)} />
    </>
  );
}

export default function JobsPage() {
  return (
    <Shell active="jobs" title="Open roles" subtitle="What a company is hiring for — free. Take a role to People and draft outreach around it.">
      <JobsView />
    </Shell>
  );
}
