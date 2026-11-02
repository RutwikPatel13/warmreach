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

// The free providers (src/llm.ts) fail with { provider, status, message }; a
// whole chain failing carries each attempt in `failures`. Checked by shape, not
// instanceof, so this file stays free of imports.
interface ChainFailure {
  ref: { provider: string; model: string };
  error: unknown;
}

const PROVIDER_LABEL: Record<string, string> = { gemini: "Gemini", groq: "Groq", claude: "Claude" };

function shortReason(e: unknown): string {
  const err = (e ?? {}) as MaybeApiError;
  if (/credit balance is too low/i.test(err.error?.error?.message ?? err.message ?? "")) return "out of credits";
  switch (err.status) {
    case 401:
    case 403:
      return "key rejected";
    case 404:
      return "model not found";
    case 429:
      return "quota spent";
    case 500:
    case 502:
    case 503:
    case 529:
      return "temporarily down";
  }
  return (err.message ?? "failed").slice(0, 80);
}

/** A short, actionable sentence for any error coming out of an LLM call. */
export function friendlyLlmError(e: unknown): string {
  const failures = (e as { failures?: ChainFailure[] } | null)?.failures;
  if (Array.isArray(failures) && failures.length) {
    const allQuota = failures.every((f) => (f.error as MaybeApiError)?.status === 429);
    if (allQuota) {
      return "Every free model quota is spent for the moment. Wait a minute and try again, or add Claude as a paid fallback with LLM_PROVIDERS=gemini,groq,claude in .env — your work is saved.";
    }
    const parts = failures.map(
      (f) => `${PROVIDER_LABEL[f.ref.provider] ?? f.ref.provider} ${f.ref.model}: ${shortReason(f.error)}`,
    );
    return `No model could handle this request (${parts.join("; ")}). Check the keys and models in .env, then try again.`;
  }

  const provider = (e as { provider?: string } | null)?.provider;
  if (provider && provider !== "claude") {
    const name = PROVIDER_LABEL[provider] ?? provider;
    const status = (e as MaybeApiError).status;
    const hint = status === 401 || status === 403 || status === 404
      ? ` Check ${provider.toUpperCase()}_API_KEY and the model name in .env.`
      : " Try again in a minute.";
    return `${name}: ${shortReason(e)}.${hint}`;
  }

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
