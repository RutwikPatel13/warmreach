// ── Readable failures from the Anthropic SDK ────────────────────────────────
// An APIError's `message` is the status plus the raw response body, so routes
// that return `e.message` hand the user something like:
//
//   400 {"type":"error","error":{"type":"invalid_request_error","message":
//   "Your credit balance is too low to access the Anthropic API. Please go to
//   Plans & Billing to upgrade or purchase credits."},"request_id":"req_011C…"}
//
// The one sentence that matters is buried in the middle, and the thing the
// reader has to DO isn't stated at all. This maps the failures worth
// distinguishing onto plain instructions, and falls through to the SDK's own
// text for anything unrecognised so nothing is ever silently swallowed.

interface MaybeApiError {
  status?: number;
  message?: string;
  error?: { error?: { type?: string; message?: string } };
}

/** A short, actionable sentence for any error coming out of an LLM call. */
export function friendlyLlmError(e: unknown): string {
  const err = (e ?? {}) as MaybeApiError;
  const status = err.status;
  const body = err.error?.error;
  const detail = body?.message ?? err.message ?? "";

  // Billing is the one people actually hit, and it's the one the raw body
  // buries. Match on the text because the API reports it as a generic
  // invalid_request_error rather than a distinct type.
  if (/credit balance is too low/i.test(detail)) {
    return "Anthropic credits are exhausted, so nothing can be drafted or scored. Add credits at console.anthropic.com → Plans & Billing, then try again — your work is saved.";
  }

  switch (status) {
    case 401:
      return "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in .env, then restart the server.";
    case 403:
      return "That Anthropic key isn't allowed to use this model. Check the key's permissions, or set WATCH_MATCH_MODEL / ANTHROPIC_MODEL to one it can reach.";
    case 404:
      return `Anthropic doesn't recognise that model${detail ? ` (${detail})` : ""}. Check ANTHROPIC_MODEL in .env.`;
    case 413:
      return "The request was too large for the model. Shorten the job description or résumé and try again.";
    case 429:
      return "Anthropic rate-limited this request. Wait a moment and try again.";
    case 500:
    case 502:
    case 503:
    case 529:
      return "Anthropic is temporarily unavailable. Try again in a minute — nothing was lost.";
  }

  // Unknown failure: prefer the API's own sentence over the raw JSON blob.
  return body?.message || err.message || "The model request failed.";
}

/** True when the failure is Anthropic billing — callers may want to stop early. */
export function isCreditExhausted(e: unknown): boolean {
  const err = (e ?? {}) as MaybeApiError;
  return /credit balance is too low/i.test(err.error?.error?.message ?? err.message ?? "");
}
