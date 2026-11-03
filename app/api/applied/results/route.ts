import { NextResponse } from "next/server";
import { audienceOf, listApplications, readSpend, type Application } from "@/src/applied";
import { readScanResult } from "@/src/followups";
import { loadStore } from "@/src/templateStore";
import { normCompany, outreachRows } from "@/src/tracker";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Results for outreach to companies you applied to through Tsenta: reply
// rates by who you emailed, company size, template and role; follow-ups due;
// and what each batch spent. Reads local files only — replies come from the
// last Follow-ups scan, so they're as fresh as that scan.

const SIZE = (n: number | null | undefined) =>
  n == null ? "Unknown" : n <= 50 ? "1–50" : n <= 200 ? "51–200" : n <= 1000 ? "201–1,000" : "1,000+";

const ROLE_FAMILIES: [string, RegExp][] = [
  ["Backend", /back[\s-]?end|api|server/i],
  ["Platform / infra", /platform|infra|devops|sre|reliability|cloud/i],
  ["Data / ML", /data|machine learning|\bml\b|\bai\b/i],
  ["Frontend", /front[\s-]?end|\bui\b|web/i],
  ["Full stack", /full[\s-]?stack/i],
];
const roleFamily = (role: string | null) => ROLE_FAMILIES.find(([, re]) => re.test(role ?? ""))?.[0] ?? "Other";

type Bucket = { label: string; n: number; replied: number };

export async function GET(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  // ?days=30 limits everything to outreach and spend in that window; none = all time.
  const days = Number(new URL(req.url).searchParams.get("days")) || 0;
  const since = days ? Date.now() - days * 86_400_000 : 0;
  const apps = listApplications();
  const byCompany = new Map<string, Application>();
  for (const a of apps) {
    byCompany.set(normCompany(a.company), a);
    if (a.org) byCompany.set(normCompany(a.org.name), a);
  }
  const scan = readScanResult();
  const repliedEmails = new Set<string>();
  for (const c of scan?.companies ?? []) for (const p of c.people) if (p.status === "replied") repliedEmails.add(p.email.toLowerCase());

  const templates = new Map(loadStore().templates.map((t) => [t.id, t.name]));
  const seen = new Set<string>();
  const tally = new Map<string, Map<string, Bucket>>();
  const add = (chart: string, label: string, replied: boolean) => {
    const m = tally.get(chart) ?? new Map<string, Bucket>();
    const b = m.get(label) ?? { label, n: 0, replied: 0 };
    b.n++;
    if (replied) b.replied++;
    m.set(label, b);
    tally.set(chart, m);
  };

  let emailed = 0, replied = 0;
  const interviewCompanies = new Set<string>();
  for (const r of outreachRows()) {
    if (!r.draftStatus.startsWith("draft:")) continue;
    if (since && Date.parse(r.timestamp) < since) continue;
    const a = byCompany.get(normCompany(r.company));
    if (!a) continue; // only companies you applied to through Tsenta
    const email = r.email.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    const didReply = repliedEmails.has(email);
    emailed++;
    if (didReply) {
      replied++;
      if (a.pipeline === "INTERVIEWING" || a.pipeline === "OFFER") interviewCompanies.add(a.id);
    }
    add("By who you emailed", audienceOf(r.title), didReply);
    add("By company size", SIZE(a.org?.employees), didReply);
    add("By template", a.startedAt ? (a.templateId ? templates.get(a.templateId) ?? "Deleted template" : "Written from scratch") : "From the Applications page", didReply);
    add("By role", roleFamily(a.role), didReply);
  }

  const spend = readSpend(1000).filter((e) => !since || Date.parse(e.at) >= since);
  const charts = [...tally.entries()].map(([title, m]) => ({
    title,
    bars: [...m.values()].sort((x, y) => y.n - x.n).map((b) => ({ ...b, rate: b.n ? (100 * b.replied) / b.n : 0 })),
  }));

  const due = (scan?.companies ?? [])
    .filter((c) => c.dueCount > 0 && byCompany.has(c.companyKey))
    .map((c) => {
      const quiet = c.people.filter((p) => p.status === "quiet");
      const last = quiet.map((p) => p.lastTouchAt).sort().at(-1) ?? null;
      return { company: c.company, who: quiet.map((p) => p.title || p.name).slice(0, 3), lastTouchAt: last, due: c.dueCount };
    })
    .sort((x, y) => (x.lastTouchAt ?? "").localeCompare(y.lastTouchAt ?? ""))
    .slice(0, 20);

  return NextResponse.json({
    facts: {
      emailed,
      replied,
      interviews: interviewCompanies.size,
      credits: spend.reduce((n, e) => n + e.credits, 0),
      claude: spend.reduce((n, e) => n + e.claude, 0),
    },
    scannedAt: scan?.scannedAt ?? null,
    charts,
    due,
    spend: spend.slice(0, 30),
  });
}
