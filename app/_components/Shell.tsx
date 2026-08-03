"use client";

// Shared app shell for the Apollo intelligence-layer pages (/companies, /people,
// /jobs). Same sidebar + nav + theme toggle as the other pages, plus the credit
// meter. Wraps content in <CreditsProvider> so pages can call useCredits().

import { useEffect, useState, type ReactNode } from "react";
import { CreditMeter } from "./credits";

type Theme = "light" | "dark";
const THEME_KEY = "warmreach:v1:theme";

const NAV: { href: string; icon: string; label: string; key: string }[] = [
  { href: "/", icon: "◱", label: "Applications", key: "applications" },
  { href: "/campaigns", icon: "◎", label: "Campaigns", key: "campaigns" },
  { href: "/companies", icon: "◨", label: "Companies", key: "companies" },
  { href: "/people", icon: "☰", label: "People", key: "people" },
  { href: "/jobs", icon: "▤", label: "Open roles", key: "jobs" },
  { href: "/database", icon: "▦", label: "Database", key: "database" },
];

export default function Shell({
  active,
  title,
  subtitle,
  children,
}: {
  active: string;
  title?: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const s = localStorage.getItem(THEME_KEY);
    if (s === "dark" || s === "light") setTheme(s);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* quota */
    }
  }, [theme]);

  return (
    <div className="shell">
      <aside className="sidebar">
          <div className="side-brand">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">warmreach</span>
          </div>

          <nav className="side-section">
            <div className="side-label">Workspace</div>
            <div className="cmp-nav">
              {NAV.map((n) => (
                <a
                  key={n.key}
                  href={n.href}
                  className={active === n.key ? "active" : ""}
                  aria-current={active === n.key ? "page" : undefined}
                >
                  {n.icon}&nbsp; {n.label}
                </a>
              ))}
            </div>
          </nav>

          <div className="side-foot">
            <CreditMeter />
            <button
              type="button"
              className={`theme-toggle ${theme === "dark" ? "is-dark" : ""}`}
              aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
              aria-pressed={theme === "dark"}
              onClick={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
            >
              <span className="theme-toggle-track" aria-hidden="true">
                <span className="theme-toggle-thumb" />
              </span>
              <span className="theme-toggle-label">{theme === "dark" ? "Dark" : "Light"}</span>
            </button>
          </div>
        </aside>

        <main className="workspace">
          <div className="workspace-inner">
            {(title || subtitle) && (
              <div className="main-top">
                <div className="main-co">
                  {title && <h1>{title}</h1>}
                  {subtitle && <div className="cmp-sub">{subtitle}</div>}
                </div>
              </div>
            )}
            {children}
          </div>
        </main>
      </div>
  );
}
