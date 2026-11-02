import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

export const APOLLO_API_KEY = required("APOLLO_API_KEY");

// Model providers (see src/llm.ts). Writing calls try LLM_PROVIDERS in order,
// skipping any without a key; unset, that's the free tiers — Gemini, then Groq —
// falling back to Claude only when neither free key is present. The résumé
// tailor and matcher always use Claude, so they still need ANTHROPIC_API_KEY.
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
// Each Gemini model has its own free quota, so the next one answers when the
// first is spent.
export const GEMINI_MODELS = list(process.env.GEMINI_MODELS || "gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite");
export const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
export const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
export const LLM_PROVIDERS = list(process.env.LLM_PROVIDERS || "").map((p) => {
  if (p !== "gemini" && p !== "groq" && p !== "claude") {
    throw new Error(`LLM_PROVIDERS has "${p}"; use gemini, groq and/or claude`);
  }
  return p;
});

function list(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

// Optional — when set, Apollo's "no email" contacts get a Hunter Email Finder fallback.
export const HUNTER_API_KEY = process.env.HUNTER_API_KEY || "";
