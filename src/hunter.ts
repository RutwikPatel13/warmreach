import { HUNTER_API_KEY } from "./config";

const BASE = "https://api.hunter.io/v2";

export function hunterConfigured(): boolean {
  return !!HUNTER_API_KEY;
}

export interface HunterPerson {
  email: string;
  firstName: string;
  lastName: string | null;
  position: string | null;
  confidence: number;
}

// Hunter Domain Search: list a domain's people + emails directly. Used as a
// fallback when Apollo finds nobody reachable. Keeps only NAMED personal
// mailboxes (drops support@/sales@/noreply@ and unnamed addresses). Fails open.
export async function domainSearch(domain: string, limit = 30): Promise<HunterPerson[]> {
  if (!HUNTER_API_KEY || !domain) return [];
  try {
    const params = new URLSearchParams({ domain, api_key: HUNTER_API_KEY, limit: String(limit) });
    const res = await fetch(`${BASE}/domain-search?${params.toString()}`);
    if (!res.ok) return [];
    const json = await res.json();
    const emails = json?.data?.emails ?? [];
    return emails
      .filter((e: any) => e?.value && e?.first_name)
      .map((e: any) => ({
        email: e.value,
        firstName: e.first_name,
        lastName: e.last_name ?? null,
        position: e.position ?? null,
        confidence: e.confidence ?? 0,
      }));
  } catch {
    return [];
  }
}

// Hunter Email Finder: domain + name -> best-guess email + confidence (0-100).
// Used only as a fallback when Apollo returns no email. Fails OPEN: any missing
// key / HTTP error / no-result returns null so it never blocks drafting.
export async function findEmail(
  domain: string,
  firstName: string,
  lastName?: string,
): Promise<{ email: string; score: number } | null> {
  if (!HUNTER_API_KEY || !domain || !firstName) return null;

  const params = new URLSearchParams({ domain, api_key: HUNTER_API_KEY });
  if (lastName) {
    params.set("first_name", firstName);
    params.set("last_name", lastName);
  } else {
    params.set("full_name", firstName);
  }

  try {
    const res = await fetch(`${BASE}/email-finder?${params.toString()}`);
    if (!res.ok) return null;
    const json = await res.json();
    const email = json?.data?.email;
    if (!email) return null;
    return { email, score: json.data.score ?? 0 };
  } catch {
    return null;
  }
}
