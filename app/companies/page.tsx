"use client";

// /companies — search Apollo for a company and open its dossier. FREE: the
// search and every card come from mixed_companies/search + organizations/enrich,
// which don't spend credits.

import { useState } from "react";
import Shell from "../_components/Shell";
import CompanyDossier, { type DossierTarget } from "../_components/CompanyDossier";

interface CompanyCard {
  orgId: string | null;
  name: string;
  domain: string | null;
  description: string | null;
  keywords: string[];
  employees: number | null;
  logoUrl: string | null;
}

function tint(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 52% 45%)`;
}
function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase();
}

function CompaniesView() {
  const [q, setQ] = useState("");
  const [companies, setCompanies] = useState<CompanyCard[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<DossierTarget | null>(null);

  async function search() {
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/company/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: query }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Search failed.");
      setCompanies(d.companies ?? []);
    } catch (e: any) {
      setError(e.message);
      setCompanies([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="card">
        <div className="searchbar">
          <input
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Company name or domain — e.g. Klaviyo, stripe.com"
          />
          <button type="button" onClick={search} disabled={loading || !q.trim()}>
            {loading ? <span className="spinner" /> : null}
            Search
          </button>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>
          <span className="i">◍</span>
          Searching and viewing a dossier is free. You only spend a credit later, on the People page, when you reveal an email.
        </p>
      </div>

      {error && <div className="error-box">{error}</div>}

      {companies && companies.length === 0 && !loading && (
        <p className="meta">No companies found for “{q}”. Try the domain instead.</p>
      )}

      {companies && companies.length > 0 && (
        <div className="co-grid">
          {companies.map((c, i) => (
            <button
              type="button"
              className="co-card"
              key={`${c.orgId ?? c.domain ?? c.name}-${i}`}
              onClick={() => setTarget({ orgId: c.orgId, domain: c.domain, name: c.name })}
            >
              {c.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="co-logo" src={c.logoUrl} alt="" />
              ) : (
                <span className="co-logo co-logo--mono" style={{ background: tint(c.name), color: "#fff" }}>
                  {initials(c.name)}
                </span>
              )}
              <div className="co-card-body">
                <div className="nm">{c.name}</div>
                <div className="dm">{c.domain ?? "no domain"}</div>
                <div className="sub">
                  {c.employees != null ? `${c.employees.toLocaleString()} employees` : "size unknown"}
                  {c.keywords[0] ? ` · ${c.keywords[0]}` : ""}
                </div>
                <div className="open">
                  View dossier <span className="badge free">free</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <CompanyDossier target={target} onClose={() => setTarget(null)} />
    </>
  );
}

export default function CompaniesPage() {
  return (
    <Shell active="companies" title="Companies" subtitle="Find a company and open its free dossier — headcount, tech stack, funding, and open roles.">
      <CompaniesView />
    </Shell>
  );
}
