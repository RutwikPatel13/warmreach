// Shared by the Applied board, its review queue and results page.
import type { BoardRow, Stage } from "@/src/applied";

export type { BoardRow, Stage };

export type Tone = "none" | "run" | "wait" | "ready" | "done" | "err";

export const STAGE: Record<Stage, { label: string; tone: Tone; group: string }> = {
  not_startable: { label: "Not submitted", tone: "none", group: "Not submitted" },
  not_started: { label: "Not started", tone: "none", group: "Not started" },
  queued: { label: "Queued", tone: "run", group: "In progress" },
  finding: { label: "Finding people", tone: "run", group: "In progress" },
  writing: { label: "Writing emails", tone: "run", group: "In progress" },
  needs_website: { label: "Needs website", tone: "wait", group: "Needs website" },
  getting_resume: { label: "Getting résumé", tone: "wait", group: "Getting résumé" },
  ready: { label: "Ready to review", tone: "ready", group: "Ready to review" },
  in_applications: { label: "In Applications", tone: "done", group: "In Applications" },
  drafted: { label: "Drafted", tone: "done", group: "Drafted" },
  sent: { label: "Sent", tone: "done", group: "Sent" },
  replied: { label: "Replied", tone: "ready", group: "Replied" },
  no_emails: { label: "No emails", tone: "err", group: "Stopped" },
  contacted: { label: "Already contacted", tone: "done", group: "Stopped" },
  error: { label: "Didn’t finish", tone: "err", group: "Stopped" },
};

// The order the stage strip and the Outreach sort use.
export const STAGE_GROUPS = [
  "Not started", "In progress", "Needs website", "Getting résumé", "Ready to review",
  "Drafted", "Sent", "Replied", "Stopped", "In Applications", "Not submitted",
];

export const stageRank = (s: Stage) => STAGE_GROUPS.indexOf(STAGE[s].group);

// "In Applications" rows (opened before the board) can be started too: their
// people are already picked, so Start only writes the emails.
export const STARTABLE = new Set<Stage>(["not_started", "error", "in_applications"]);

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function sizeBucket(n: number | null): string {
  return n == null ? "Unknown" : n <= 50 ? "1–50" : n <= 200 ? "51–200" : n <= 1000 ? "201–1,000" : "1,000+";
}

export const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ");

export function money(n: number | null): string {
  if (n == null) return "";
  return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`;
}

export const fmt = (n: number) => n.toLocaleString("en-US");
