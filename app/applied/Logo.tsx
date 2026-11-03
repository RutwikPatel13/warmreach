"use client";

// A company's mark: Apollo's logo once the company is found, else the site's
// icon from its domain, else its first letter. Never a broken image.

import { useState } from "react";

const iconFor = (site: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(site)}&sz=64`;

export function Logo({ name, logoUrl, site, size = 28 }: { name: string; logoUrl: string | null; site: string | null; size?: number }) {
  const sources = [logoUrl, site ? iconFor(site) : null].filter(Boolean) as string[];
  const [i, setI] = useState(0);
  const src = sources[i];
  return (
    <span className="wb-mark" style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }} aria-hidden="true">
      {src ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setI((n) => n + 1)} /> : (name.trim().charAt(0) || "?").toUpperCase()}
    </span>
  );
}
