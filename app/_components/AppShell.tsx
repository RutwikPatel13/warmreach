"use client";

// THE app shell — rendered once by app/layout.tsx, so it wraps every route.
//
// This replaces four hand-rolled copies of the same sidebar (Applications,
// Campaigns, Database, and the old Shell.tsx). Those copies were the reason
// chrome features kept landing on a subset of pages: the credit meter only
// ticked on People, and the compose dock only existed on the four Shell pages.
// Anything added here now appears everywhere by construction.
//
// Pages own their main content only. Two escape hatches:
//   <PageHeader>     — the title/subtitle block at the top of the workspace
//   <SidebarExtra>   — portals page-owned chrome INTO the sidebar; Applications
//                      uses it for its stateful workspace/tab list, which is
//                      what made a shared shell impossible before.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { CreditMeter } from "./credits";
import { ComposeProvider, useCompose } from "./Compose";

type Theme = "light" | "dark";
const THEME_KEY = "warmreach:v1:theme";

const NAV: { href: string; icon: string; label: string }[] = [
  { href: "/", icon: "◱", label: "Applications" },
  { href: "/campaigns", icon: "◎", label: "Campaigns" },
  { href: "/companies", icon: "◨", label: "Companies" },
  { href: "/people", icon: "☰", label: "People" },
  { href: "/jobs", icon: "▤", label: "Open roles" },
  { href: "/matches", icon: "◉", label: "Matches" },
  { href: "/followups", icon: "↩", label: "Follow-ups" },
  { href: "/database", icon: "▦", label: "Database" },
];

// The theme was written in two incompatible encodings against the SAME key:
// the Shell pages used a raw string ("dark"), while Applications and Campaigns
// went through a JSON helper ('"dark"'). Each side failed to read the other's
// value and fell back to light, so dark mode silently reset whenever you moved
// between the two groups. Read both, write raw — existing values self-heal.
function readTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (!raw) return null;
    const v = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

const SidebarSlotCtx = createContext<HTMLElement | null>(null);

/** Renders its children into the sidebar, below the nav. */
export function SidebarExtra({ children }: { children: ReactNode }) {
  const el = useContext(SidebarSlotCtx);
  return el ? createPortal(children, el) : null;
}

/** The workspace title block. Pages render this at the top of their content. */
export function PageHeader({ title, subtitle }: { title?: string; subtitle?: ReactNode }) {
  if (!title && !subtitle) return null;
  return (
    <div className="main-top">
      <div className="main-co">
        {title && <h1>{title}</h1>}
        {subtitle && <div className="cmp-sub">{subtitle}</div>}
      </div>
    </div>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [theme, setTheme] = useState<Theme>("light");
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const saved = readTheme();
    if (saved) setTheme(saved);
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
    <ComposeProvider>
      <div className="shell">
        <aside className="sidebar">
          <div className="side-brand">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">warmreach</span>
          </div>

          <ComposeButton />

          <nav className="side-section side-nav">
            <div className="side-label">Workspace</div>
            <div className="cmp-nav">
              {NAV.map((n) => {
                const active = pathname === n.href;
                return (
                  <a
                    key={n.href}
                    href={n.href}
                    className={active ? "active" : ""}
                    aria-current={active ? "page" : undefined}
                  >
                    {n.icon}&nbsp; {n.label}
                    {n.href === "/matches" && <MatchCount />}
                  </a>
                );
              })}
            </div>
          </nav>

          {/* page-owned sidebar chrome lands here (see <SidebarExtra>) */}
          <div className="side-extra" ref={setSlotEl} />

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

        <SidebarSlotCtx.Provider value={slotEl}>
          <main className="workspace">{children}</main>
        </SidebarSlotCtx.Provider>
      </div>
    </ComposeProvider>
  );
}

// Unread count on the Matches nav entry — the notification itself. Renders
// nothing at all when there's nothing waiting, and stays silent on any error:
// a failed count must never disturb the sidebar.
function MatchCount() {
  const pathname = usePathname();
  const [count, setCount] = useState(0);

  useEffect(() => {
    let live = true;
    async function refresh() {
      try {
        const r = await fetch("/api/matches");
        if (!r.ok) return;
        const d = await r.json();
        const n = (d.matches ?? []).filter((m: { status: string }) => m.status === "new").length;
        if (live) setCount(n);
      } catch {
        /* offline or route missing — leave the badge off */
      }
    }
    void refresh();
    // The Matches page fires this after a dismiss, an ask, or a sweep; without
    // it the badge would keep showing a count you've already cleared.
    window.addEventListener("warmreach:matches-changed", refresh);
    return () => {
      live = false;
      window.removeEventListener("warmreach:matches-changed", refresh);
    };
  }, [pathname]);

  if (count <= 0) return null;
  return <span className="wl-navcount">{count}</span>;
}

// Sidebar entry point for the one-off composer. Inside <ComposeProvider> so it
// can reach the dock; opens it blank, for an address pasted from anywhere.
function ComposeButton() {
  const openCompose = useCompose();
  return (
    <button type="button" className="side-compose" onClick={() => openCompose()}>
      ✉&nbsp; Compose
    </button>
  );
}
