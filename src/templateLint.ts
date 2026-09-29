// Pure helpers for saved email templates, shared by the Templates page and the
// Applications compose step. No server imports: this runs in the browser.
//
// Placeholders are the two the server merges in app/api/generate/route.ts:
// {company} and {role}. Anything else in braces is left as literal text.

export type TplVariant = "recruiter" | "engineering";
export interface TplEmail {
  subject: string;
  body: string;
}

export interface Segment {
  text: string;
  placeholder: boolean;
}

const PLACEHOLDER_RE = /(\{company\}|\{role\})/;

// Splits text into plain runs and placeholders. With `fill`, placeholders carry
// the substituted value (still flagged, so the preview can highlight them).
export function splitPlaceholders(text: string, fill?: { company: string; role: string }): Segment[] {
  return text
    .split(PLACEHOLDER_RE)
    .filter((p) => p.length > 0)
    .map((p) => {
      if (p === "{company}") return { text: fill ? fill.company : p, placeholder: true };
      if (p === "{role}") return { text: fill ? fill.role : p, placeholder: true };
      return { text: p, placeholder: false };
    });
}

export function fillPlaceholders(text: string, fill: { company: string; role: string }): string {
  return text.split("{company}").join(fill.company).split("{role}").join(fill.role);
}

export function sameEmail(a: TplEmail, b: TplEmail): boolean {
  return a.subject === b.subject && a.body === b.body;
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export interface Check {
  ok: boolean;
  text: string;
}

// The checks shown under the Templates preview, for the version being edited.
export function templateChecks(
  current: TplEmail,
  variants: Record<TplVariant, TplEmail>,
  linked: boolean,
): Check[] {
  const uses = (current.subject + "\n" + current.body).split("{company}").length - 1;
  const checks: Check[] = [
    uses > 0
      ? { ok: true, text: `Uses {company} ${uses}×` }
      : { ok: false, text: "No {company} placeholder, so every email names the same company" },
    current.subject.includes("{role}")
      ? { ok: true, text: "Subject uses {role}" }
      : { ok: false, text: "Subject has no {role}, so it names one specific job" },
  ];
  if (linked) checks.push({ ok: true, text: "One version for both audiences" });
  else if (sameEmail(variants.recruiter, variants.engineering))
    checks.push({ ok: false, text: "Recruiter and Engineering are identical. Tick “Same email for both”?" });
  else checks.push({ ok: true, text: "Recruiter and Engineering versions differ" });
  return checks;
}

// The one-line warning the Compose picker shows on a template card, if any.
export function templateWarning(variants: Record<TplVariant, TplEmail>): string | null {
  const r = variants.recruiter;
  if (!r.subject.includes("{role}")) return "Subject names one specific job, not {role}";
  if (!(r.subject + r.body).includes("{company}")) return "No {company} placeholder";
  return null;
}
