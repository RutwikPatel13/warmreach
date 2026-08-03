"use client";

// The company dossier modal — opens when you click a company. Everything shown
// here is FREE Apollo data (organizations/enrich + job_postings); no credits.

import { useEffect, useState } from "react";

export interface Dossier {
  orgId?: string | null;
  name: string;
  domain?: string | null;
  websiteUrl?: string | null;
  logoUrl?: string | null;
  description: string | null;
  industry?: string | null;
  foundedYear?: number | null;
  employees?: number | null;
  location?: string | null;
  keywords: string[];
  technologies: string[];
  linkedinUrl?: string | null;
  annualRevenue?: string | null;
  totalFunding?: string | null;
  latestFundingStage?: string | null;
  latestFundingDate?: string | null;
  publiclyTraded?: string | null;
}

export interface Job {
  id: string;
  title: string;
  url: string | null;
  location: string | null;
  postedAt: string | null;
}

export interface DossierTarget {
  orgId?: string | null;
  domain?: string | null;
  name?: string | null;
}

// Deterministic logo tint from the name (matches the monogram fallback elsewhere).
function tint(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 52% 45%)`;
}
function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase();
}
function fmtDate(s?: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
function toQuery(t: DossierTarget): string {
  const p = new URLSearchParams();
  if (t.orgId) p.set("orgId", t.orgId);
  if (t.domain) p.set("domain", t.domain);
  if (t.name) p.set("name", t.name);
  return p.toString();
}

type Signal = { kind: "hire" | "fund" | "news"; text: string; when: string };

function buildSignals(d: Dossier, jobs: Job[]): Signal[] {
  const out: Signal[] = [];
  if (jobs.length) {
    out.push({ kind: "hire", text: `${jobs.length} open role${jobs.length === 1 ? "" : "s"} right now`, when: "now" });
  }
  if (d.latestFundingStage) {
    out.push({
      kind: "fund",
      text: `Latest funding: ${d.latestFundingStage}`,
      when: fmtDate(d.latestFundingDate) || "",
    });
  } else if (d.totalFunding) {
    out.push({ kind: "fund", text: `Raised ${d.totalFunding} to date`, when: "" });
  }
  if (d.publiclyTraded) {
    out.push({ kind: "news", text: `Publicly traded — ${d.publiclyTraded}`, when: "" });
  } else if (d.annualRevenue) {
    out.push({ kind: "news", text: `Est. annual revenue ${d.annualRevenue}`, when: "" });
  }
  if (d.foundedYear) {
    out.push({ kind: "news", text: `Founded ${d.foundedYear}`, when: "" });
  }
  return out;
}

export default function CompanyDossier({
  target,
  onClose,
}: {
  target: DossierTarget | null;
  onClose: () => void;
}) {
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDossier(null);
    setJobs([]);
    fetch("/api/company/dossier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(target),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Could not load the company.");
        return d;
      })
      .then((d) => {
        if (cancelled) return;
        setDossier(d.dossier);
        setJobs(d.jobs ?? []);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;

  const q = dossier
    ? toQuery({ orgId: dossier.orgId, domain: dossier.domain, name: dossier.name })
    : toQuery(target);
  const signals = dossier ? buildSignals(dossier, jobs) : [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal dz-modal" onClick={(e) => e.stopPropagation()}>
        {loading && <p className="meta" style={{ padding: "8px 0" }}>Loading company…</p>}
        {error && <div className="error-box">{error}</div>}

        {dossier && (
          <>
            <div className="dz-head">
              {dossier.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="co-logo" src={dossier.logoUrl} alt="" />
              ) : (
                <span className="co-logo co-logo--mono" style={{ background: tint(dossier.name), color: "#fff" }}>
                  {initials(dossier.name)}
                </span>
              )}
              <div className="dz-h-main">
                <div className="dz-name">{dossier.name}</div>
                <div className="dz-dom">
                  {dossier.domain ?? "—"}
                  {dossier.location ? ` · ${dossier.location}` : ""}
                </div>
              </div>
              <span className="badge free">free · 0 credits</span>
            </div>

            <div className="cmp-stats dz-stats">
              <div className="cmp-stat">
                <div className="k">Employees</div>
                <div className="v tnum">{dossier.employees != null ? dossier.employees.toLocaleString() : "—"}</div>
              </div>
              <div className="cmp-stat">
                <div className="k">Founded</div>
                <div className="v tnum">{dossier.foundedYear ?? "—"}</div>
              </div>
              <div className="cmp-stat">
                <div className="k">Industry</div>
                <div className="v dz-v-sm">{dossier.industry ?? "—"}</div>
              </div>
              <div className="cmp-stat">
                <div className="k">Funding</div>
                <div className="v dz-v-sm">{dossier.latestFundingStage ?? dossier.totalFunding ?? "—"}</div>
              </div>
            </div>

            {dossier.description && <p className="dz-about">{dossier.description}</p>}

            {dossier.technologies.length > 0 && (
              <div className="dz-block">
                <span className="field-label">Tech stack</span>
                <div className="dz-chips">
                  {dossier.technologies.map((t) => (
                    <span className="chip tech" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {dossier.keywords.length > 0 && (
              <div className="dz-block">
                <span className="field-label">Keywords</span>
                <div className="dz-chips">
                  {dossier.keywords.map((k) => (
                    <span className="chip" key={k}>
                      {k}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {signals.length > 0 && (
              <div className="dz-block">
                <span className="field-label">Recent signals</span>
                <div className="dz-signals">
                  {signals.map((s, i) => (
                    <div className="sig" key={i}>
                      <i className={s.kind} />
                      <div className="txt">{s.text}</div>
                      {s.when && <div className="when">{s.when}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="dz-foot">
              <a className="btn-link-primary" href={`/people?${q}`}>
                Find people
              </a>
              <a className="btn-link-ghost" href={`/jobs?${q}`}>
                See open roles
              </a>
              {dossier.websiteUrl && (
                <a className="footer-link dz-site" href={dossier.websiteUrl} target="_blank" rel="noreferrer">
                  Website ↗
                </a>
              )}
              <span className="dz-spacer" />
              <button type="button" className="ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
