import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, ANTHROPIC_MODEL, GEMINI_API_KEY, GEMINI_MODELS, GROQ_API_KEY, GROQ_MODEL, LLM_PROVIDERS } from "./config";

// ── One structured call, several providers ──────────────────────────────────
// Every writing call in warmreach (drafts, campaign intros, follow-ups, reply
// triage, contact picking) is the same shape: one prompt in, one forced tool
// call out. That shape is portable, so it runs on a chain of providers tried in
// order — by default the free tiers (Gemini, then Groq), with Claude only when
// LLM_PROVIDERS names it or no free key is set. When one provider turns a
// request away (quota, outage, malformed output) the next one gets it.
//
// The résumé tailor and résumé matcher stay on the Anthropic SDK directly: they
// lean on adaptive thinking, prompt caching and streaming, which don't port.

export type ProviderName = "gemini" | "groq" | "claude";

export interface ProviderRef {
  provider: ProviderName;
  model: string;
}

export interface ToolCallResult<T> {
  output: T;
  provider: ProviderName;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

/** Every provider in the chain failed; `failures` says why, in order. */
export class LlmChainError extends Error {
  constructor(public failures: { ref: ProviderRef; error: unknown }[]) {
    super(
      "Every model provider failed: " +
        failures.map((f) => `${label(f.ref)} (${errorText(f.error)})`).join("; "),
    );
    this.name = "LlmChainError";
  }
}

/** A non-2xx from an OpenAI-compatible endpoint, shaped like the Anthropic SDK's APIError. */
export class ProviderHttpError extends Error {
  constructor(public provider: ProviderName, public status: number, message: string) {
    super(`${status} ${message}`);
    this.name = "ProviderHttpError";
  }
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const label = (r: ProviderRef) => `${r.provider}:${r.model}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

function hasKey(p: ProviderName): boolean {
  return Boolean({ gemini: GEMINI_API_KEY, groq: GROQ_API_KEY, claude: ANTHROPIC_API_KEY }[p]);
}

// Gemini's free tier meters each model separately, so every listed model is
// its own quota and gets its own slot in the chain.
function expand(p: ProviderName): ProviderRef[] {
  if (p === "gemini") return GEMINI_MODELS.map((model) => ({ provider: p, model }));
  if (p === "groq") return [{ provider: p, model: GROQ_MODEL }];
  return [{ provider: p, model: ANTHROPIC_MODEL }];
}

/** The chain this server will try, in order, skipping providers with no key. */
export function configuredChain(): ProviderRef[] {
  const listed = LLM_PROVIDERS.length ? LLM_PROVIDERS : (["gemini", "groq"] as ProviderName[]);
  const chain = listed.filter(hasKey).flatMap(expand);
  // Nothing free configured and no explicit list: keep the old behaviour.
  if (!chain.length && !LLM_PROVIDERS.length && hasKey("claude")) return expand("claude");
  if (!chain.length) {
    throw new Error(
      "No model provider is configured. Set GEMINI_API_KEY and/or GROQ_API_KEY (free), or ANTHROPIC_API_KEY, in .env and restart the server.",
    );
  }
  return chain;
}

/**
 * Parse "gemini:gemini-3.5-flash", "groq:openai/gpt-oss-120b" or
 * "claude:claude-sonnet-4-6". A bare model id is treated as Claude, which keeps
 * the older call sites (bench.ts) working.
 */
export function parseRef(ref: string): ProviderRef {
  const m = ref.match(/^(gemini|groq|claude):(.+)$/);
  return m ? { provider: m[1] as ProviderName, model: m[2] } : { provider: "claude", model: ref };
}

/**
 * Run one forced tool call. With `only`, that single provider is used (no
 * fallback); otherwise the configured chain is tried in order.
 */
export async function callTool<T>(opts: {
  tool: Anthropic.Tool;
  prompt: string;
  maxTokens: number;
  only?: ProviderRef;
}): Promise<ToolCallResult<T>> {
  const chain = opts.only ? [opts.only] : configuredChain();
  const failures: { ref: ProviderRef; error: unknown }[] = [];
  for (const ref of chain) {
    try {
      const result = ref.provider === "claude" ? await viaClaude<T>(ref, opts) : await viaOpenAiCompat<T>(ref, opts);
      assertRequired(opts.tool, result.output);
      return result;
    } catch (e) {
      // A single pinned provider surfaces its own error untouched, so
      // friendlyLlmError can still read the Anthropic status/body.
      if (opts.only) throw e;
      console.warn(`[llm] ${label(ref)} failed, trying next: ${errorText(e)}`);
      failures.push({ ref, error: e });
    }
  }
  throw new LlmChainError(failures);
}

// Weaker models sometimes return a call with fields missing; treat that as a
// failure so the next provider gets a turn instead of the user getting a blank.
function assertRequired(tool: Anthropic.Tool, output: unknown) {
  const required = (tool.input_schema.required ?? []) as string[];
  const obj = (output ?? {}) as Record<string, unknown>;
  const missing = required.filter((k) => obj[k] === undefined || obj[k] === null);
  if (missing.length) throw new Error(`${tool.name} came back without ${missing.join(", ")}`);
}

async function viaClaude<T>(
  ref: ProviderRef,
  opts: { tool: Anthropic.Tool; prompt: string; maxTokens: number },
): Promise<ToolCallResult<T>> {
  const message = await anthropic.messages.create({
    model: ref.model,
    max_tokens: opts.maxTokens,
    tools: [opts.tool],
    tool_choice: { type: "tool", name: opts.tool.name },
    messages: [{ role: "user", content: opts.prompt }],
  });
  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error(`Model did not return a ${opts.tool.name} tool call`);
  }
  return {
    output: toolUse.input as T,
    provider: "claude",
    model: ref.model,
    usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
  };
}

const ENDPOINTS: Record<"gemini" | "groq", { url: string; key: () => string }> = {
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    key: () => GEMINI_API_KEY,
  },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", key: () => GROQ_API_KEY },
};

// Both run a reasoning pass that counts against max_tokens, so the cap gets
// headroom on top of what the answer itself needs. Low effort is plenty for a
// templated email; Groq reserves max_tokens against its per-minute budget, so
// the headroom there stays modest.
function providerParams(provider: "gemini" | "groq", maxTokens: number): Record<string, unknown> {
  return provider === "gemini"
    ? { reasoning_effort: "low", max_tokens: maxTokens + 4096 }
    : { reasoning_effort: "low", max_tokens: maxTokens + 1024 };
}

async function viaOpenAiCompat<T>(
  ref: ProviderRef,
  opts: { tool: Anthropic.Tool; prompt: string; maxTokens: number },
): Promise<ToolCallResult<T>> {
  const provider = ref.provider as "gemini" | "groq";
  const endpoint = ENDPOINTS[provider];
  const res = await fetch(endpoint.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.key()}` },
    body: JSON.stringify({
      model: ref.model,
      messages: [{ role: "user", content: opts.prompt }],
      tools: [
        {
          type: "function",
          function: { name: opts.tool.name, description: opts.tool.description, parameters: opts.tool.input_schema },
        },
      ],
      // There is only ever one tool, so "required" forces exactly that one.
      tool_choice: "required",
      ...providerParams(provider, opts.maxTokens),
    }),
    signal: AbortSignal.timeout(90_000),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const body = JSON.parse(text);
      detail = (Array.isArray(body) ? body[0] : body)?.error?.message ?? text;
    } catch {}
    throw new ProviderHttpError(provider, res.status, detail.slice(0, 300));
  }

  const data = JSON.parse(text);
  const call = data.choices?.[0]?.message?.tool_calls?.find(
    (c: { function?: { name?: string } }) => c.function?.name === opts.tool.name,
  );
  if (!call) throw new Error(`Model did not return a ${opts.tool.name} tool call`);
  const args = call.function.arguments;
  return {
    output: (typeof args === "string" ? JSON.parse(args) : args) as T,
    provider,
    model: ref.model,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}
