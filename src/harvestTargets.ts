// ── Harvest target list ─────────────────────────────────────────────────────
// The companies worth holding contacts at, as a static seed list. Ranking is
// computed (not hand-numbered) from three signals so the order stays honest as
// your coverage changes:
//
//   aspiration — tier weight. AI labs and the top AI product companies first,
//                then big tech, then the rest. This is the "who do SWEs want to
//                work for" axis and it's the only hand-set number here.
//   investment — how much outreach you've ALREADY logged at the company, log-
//                scaled so Google's 155 doesn't flatten the other 120 entries.
//   gap        — how little you hold. A company you care about with 0 contacts
//                outranks the same company with 682, because that's where a
//                credit actually buys you something.
//
// Score = aspiration × investment × gap. See scoreTarget() below.

export type Tier =
  | "AI lab"
  | "AI startup"
  | "Big tech"
  | "Data/AI"
  | "Infra"
  | "Fintech"
  | "Product"
  | "Enterprise"
  | "AV/Robotics"
  | "Aero/Defense"
  | "Semis"
  | "Consulting";

export interface Target {
  name: string;
  domain: string;
  tier: Tier;
}

// Aspiration weight per tier — the "who do engineers aspire to" axis.
export const TIER_WEIGHT: Record<Tier, number> = {
  "AI lab": 1.0,
  "AI startup": 0.92,
  "Big tech": 0.86,
  "Data/AI": 0.82,
  Infra: 0.76,
  Product: 0.72,
  Fintech: 0.7,
  "AV/Robotics": 0.68,
  "Aero/Defense": 0.66,
  Semis: 0.6,
  Enterprise: 0.56,
  Consulting: 0.4,
};

// The seed list. Domains matter more than names — they're what Apollo resolves
// against, and what the contacts cache keys on.
export const TARGETS: Target[] = [
  // ── AI labs ───────────────────────────────────────────────────────────────
  { name: "OpenAI", domain: "openai.com", tier: "AI lab" },
  { name: "Anthropic", domain: "anthropic.com", tier: "AI lab" },
  { name: "Google DeepMind", domain: "deepmind.google", tier: "AI lab" },
  { name: "xAI", domain: "x.ai", tier: "AI lab" },
  { name: "Mistral AI", domain: "mistral.ai", tier: "AI lab" },
  { name: "Cohere", domain: "cohere.com", tier: "AI lab" },
  { name: "Meta Superintelligence Labs", domain: "ai.meta.com", tier: "AI lab" },
  { name: "Reflection AI", domain: "reflection.ai", tier: "AI lab" },
  { name: "Thinking Machines Lab", domain: "thinkingmachines.ai", tier: "AI lab" },
  { name: "Safe Superintelligence", domain: "ssi.inc", tier: "AI lab" },

  // ── AI product companies / startups ───────────────────────────────────────
  { name: "Cursor", domain: "cursor.com", tier: "AI startup" },
  { name: "Perplexity", domain: "perplexity.ai", tier: "AI startup" },
  { name: "Sierra", domain: "sierra.ai", tier: "AI startup" },
  { name: "Harvey", domain: "harvey.ai", tier: "AI startup" },
  { name: "Glean", domain: "glean.com", tier: "AI startup" },
  { name: "ElevenLabs", domain: "elevenlabs.io", tier: "AI startup" },
  { name: "Suno", domain: "suno.com", tier: "AI startup" },
  { name: "Runway", domain: "runwayml.com", tier: "AI startup" },
  { name: "Midjourney", domain: "midjourney.com", tier: "AI startup" },
  { name: "Luma AI", domain: "lumalabs.ai", tier: "AI startup" },
  { name: "Black Forest Labs", domain: "blackforestlabs.ai", tier: "AI startup" },
  { name: "Decagon", domain: "decagon.ai", tier: "AI startup" },
  { name: "Clay", domain: "clay.com", tier: "AI startup" },
  { name: "Abridge", domain: "abridge.com", tier: "AI startup" },
  { name: "OpenEvidence", domain: "openevidence.com", tier: "AI startup" },
  { name: "Cognition", domain: "cognition.ai", tier: "AI startup" },
  { name: "Together AI", domain: "together.ai", tier: "AI startup" },
  { name: "Fireworks AI", domain: "fireworks.ai", tier: "AI startup" },
  { name: "Baseten", domain: "baseten.co", tier: "AI startup" },
  { name: "Modal", domain: "modal.com", tier: "AI startup" },
  { name: "LangChain", domain: "langchain.com", tier: "AI startup" },
  { name: "LlamaIndex", domain: "llamaindex.ai", tier: "AI startup" },
  { name: "Weights & Biases", domain: "wandb.ai", tier: "AI startup" },
  { name: "Hugging Face", domain: "huggingface.co", tier: "AI startup" },
  { name: "Replit", domain: "replit.com", tier: "AI startup" },
  { name: "Vercel", domain: "vercel.com", tier: "AI startup" },
  { name: "Anysphere", domain: "anysphere.co", tier: "AI startup" },
  { name: "Speak", domain: "speak.com", tier: "AI startup" },
  { name: "Mercor", domain: "mercor.com", tier: "AI startup" },
  { name: "Sesame", domain: "sesame.com", tier: "AI startup" },

  // ── Big tech ──────────────────────────────────────────────────────────────
  { name: "Google", domain: "google.com", tier: "Big tech" },
  { name: "Meta", domain: "meta.com", tier: "Big tech" },
  { name: "Apple", domain: "apple.com", tier: "Big tech" },
  { name: "Microsoft", domain: "microsoft.com", tier: "Big tech" },
  { name: "Amazon", domain: "amazon.com", tier: "Big tech" },
  { name: "NVIDIA", domain: "nvidia.com", tier: "Big tech" },
  { name: "Netflix", domain: "netflix.com", tier: "Big tech" },
  { name: "Tesla", domain: "tesla.com", tier: "Big tech" },
  { name: "LinkedIn", domain: "linkedin.com", tier: "Big tech" },
  { name: "Uber", domain: "uber.com", tier: "Big tech" },
  { name: "Airbnb", domain: "airbnb.com", tier: "Big tech" },
  { name: "Palantir", domain: "palantir.com", tier: "Big tech" },
  { name: "Snap", domain: "snap.com", tier: "Big tech" },
  { name: "Salesforce", domain: "salesforce.com", tier: "Enterprise" },
  { name: "Adobe", domain: "adobe.com", tier: "Enterprise" },
  { name: "IBM", domain: "ibm.com", tier: "Enterprise" },
  { name: "Oracle", domain: "oracle.com", tier: "Enterprise" },
  { name: "Cisco", domain: "cisco.com", tier: "Enterprise" },

  // ── Data / AI infrastructure ──────────────────────────────────────────────
  { name: "Databricks", domain: "databricks.com", tier: "Data/AI" },
  { name: "Snowflake", domain: "snowflake.com", tier: "Data/AI" },
  { name: "Scale AI", domain: "scale.com", tier: "Data/AI" },
  { name: "Confluent", domain: "confluent.io", tier: "Data/AI" },
  { name: "dbt Labs", domain: "getdbt.com", tier: "Data/AI" },
  { name: "Pinecone", domain: "pinecone.io", tier: "Data/AI" },
  { name: "Anyscale", domain: "anyscale.com", tier: "Data/AI" },
  { name: "Sigma Computing", domain: "sigmacomputing.com", tier: "Data/AI" },

  // ── Infra / devtools ──────────────────────────────────────────────────────
  { name: "Stripe", domain: "stripe.com", tier: "Fintech" },
  { name: "Cloudflare", domain: "cloudflare.com", tier: "Infra" },
  { name: "Datadog", domain: "datadoghq.com", tier: "Infra" },
  { name: "MongoDB", domain: "mongodb.com", tier: "Infra" },
  { name: "HashiCorp", domain: "hashicorp.com", tier: "Infra" },
  { name: "GitHub", domain: "github.com", tier: "Infra" },
  { name: "GitLab", domain: "gitlab.com", tier: "Infra" },
  { name: "Docker", domain: "docker.com", tier: "Infra" },
  { name: "Temporal", domain: "temporal.io", tier: "Infra" },
  { name: "Supabase", domain: "supabase.com", tier: "Infra" },
  { name: "Neon", domain: "neon.tech", tier: "Infra" },
  { name: "CockroachDB", domain: "cockroachlabs.com", tier: "Infra" },
  { name: "Redis", domain: "redis.com", tier: "Infra" },
  { name: "Grafana Labs", domain: "grafana.com", tier: "Infra" },
  { name: "Sentry", domain: "sentry.io", tier: "Infra" },
  { name: "Netlify", domain: "netlify.com", tier: "Infra" },
  { name: "Render", domain: "render.com", tier: "Infra" },
  { name: "Fly.io", domain: "fly.io", tier: "Infra" },

  // ── Fintech ───────────────────────────────────────────────────────────────
  { name: "Ramp", domain: "ramp.com", tier: "Fintech" },
  { name: "Brex", domain: "brex.com", tier: "Fintech" },
  { name: "Plaid", domain: "plaid.com", tier: "Fintech" },
  { name: "Coinbase", domain: "coinbase.com", tier: "Fintech" },
  { name: "Robinhood", domain: "robinhood.com", tier: "Fintech" },
  { name: "Block", domain: "block.xyz", tier: "Fintech" },
  { name: "Affirm", domain: "affirm.com", tier: "Fintech" },
  { name: "Chime", domain: "chime.com", tier: "Fintech" },
  { name: "Mercury", domain: "mercury.com", tier: "Fintech" },
  { name: "Capital One", domain: "capitalone.com", tier: "Fintech" },
  { name: "Citi", domain: "citi.com", tier: "Fintech" },
  { name: "Two Sigma", domain: "twosigma.com", tier: "Fintech" },
  { name: "Jane Street", domain: "janestreet.com", tier: "Fintech" },
  { name: "Citadel", domain: "citadel.com", tier: "Fintech" },
  { name: "Hudson River Trading", domain: "hudsonrivertrading.com", tier: "Fintech" },

  // ── Product companies ─────────────────────────────────────────────────────
  { name: "Figma", domain: "figma.com", tier: "Product" },
  { name: "Notion", domain: "notion.so", tier: "Product" },
  { name: "Linear", domain: "linear.app", tier: "Product" },
  { name: "Canva", domain: "canva.com", tier: "Product" },
  { name: "Discord", domain: "discord.com", tier: "Product" },
  { name: "Reddit", domain: "reddit.com", tier: "Product" },
  { name: "Spotify", domain: "spotify.com", tier: "Product" },
  { name: "DoorDash", domain: "doordash.com", tier: "Product" },
  { name: "Instacart", domain: "instacart.com", tier: "Product" },
  { name: "Lyft", domain: "lyft.com", tier: "Product" },
  { name: "Pinterest", domain: "pinterest.com", tier: "Product" },
  { name: "Roblox", domain: "roblox.com", tier: "Product" },
  { name: "Duolingo", domain: "duolingo.com", tier: "Product" },
  { name: "Rippling", domain: "rippling.com", tier: "Enterprise" },
  { name: "Deel", domain: "deel.com", tier: "Enterprise" },
  { name: "Gusto", domain: "gusto.com", tier: "Enterprise" },
  { name: "Atlassian", domain: "atlassian.com", tier: "Enterprise" },
  { name: "Asana", domain: "asana.com", tier: "Enterprise" },
  { name: "Airtable", domain: "airtable.com", tier: "Enterprise" },
  { name: "Klaviyo", domain: "klaviyo.com", tier: "Enterprise" },
  { name: "Samsara", domain: "samsara.com", tier: "Enterprise" },
  { name: "ServiceNow", domain: "servicenow.com", tier: "Enterprise" },
  { name: "Workday", domain: "workday.com", tier: "Enterprise" },
  { name: "Intuit", domain: "intuit.com", tier: "Enterprise" },

  // ── AV / robotics / aero / defense ────────────────────────────────────────
  { name: "Waymo", domain: "waymo.com", tier: "AV/Robotics" },
  { name: "Nuro", domain: "nuro.ai", tier: "AV/Robotics" },
  { name: "Applied Intuition", domain: "appliedintuition.com", tier: "AV/Robotics" },
  { name: "Zoox", domain: "zoox.com", tier: "AV/Robotics" },
  { name: "Figure", domain: "figure.ai", tier: "AV/Robotics" },
  { name: "Skild AI", domain: "skild.ai", tier: "AV/Robotics" },
  { name: "Physical Intelligence", domain: "physicalintelligence.company", tier: "AV/Robotics" },
  { name: "SpaceX", domain: "spacex.com", tier: "Aero/Defense" },
  { name: "Anduril", domain: "anduril.com", tier: "Aero/Defense" },
  { name: "Rivian", domain: "rivian.com", tier: "AV/Robotics" },

  // ── Semis ─────────────────────────────────────────────────────────────────
  { name: "AMD", domain: "amd.com", tier: "Semis" },
  { name: "Qualcomm", domain: "qualcomm.com", tier: "Semis" },
  { name: "Broadcom", domain: "broadcom.com", tier: "Semis" },
  { name: "Marvell Technology", domain: "marvell.com", tier: "Semis" },
  { name: "Groq", domain: "groq.com", tier: "Semis" },
  { name: "Cerebras", domain: "cerebras.ai", tier: "Semis" },
];

// ── Ranking ─────────────────────────────────────────────────────────────────

export interface RankInputs {
  outreach: number; // people already emailed at this company (outreach log)
  onFile: number; // distinct people held for this company (all sources)
}

// Log-scaled so a company with 155 logged emails outranks one with 12 — but by
// ~2x, not ~13x. Companies with no history still score 1.0 (never zeroed out).
function investmentFactor(outreach: number): number {
  return 1 + Math.log10(1 + Math.max(0, outreach)) / 2;
}

// Coverage decay: 0 on file → 1.0, ~50 → 0.5, 500+ → ~0.1. Companies you
// already have deeply are pushed down, never removed — you may still want the
// 60 new people at Microsoft, just not before Stripe's first 118.
function gapFactor(onFile: number): number {
  return 1 / (1 + Math.max(0, onFile) / 50);
}

export function scoreTarget(t: Target, r: RankInputs): number {
  return TIER_WEIGHT[t.tier] * investmentFactor(r.outreach) * gapFactor(r.onFile);
}
