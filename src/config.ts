import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

export const ANTHROPIC_API_KEY = required("ANTHROPIC_API_KEY");
export const APOLLO_API_KEY = required("APOLLO_API_KEY");
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

// Optional — when set, Apollo's "no email" contacts get a Hunter Email Finder fallback.
export const HUNTER_API_KEY = process.env.HUNTER_API_KEY || "";
