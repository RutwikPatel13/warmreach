// ── BeHuman: strip the tells of AI writing from generated emails ─────────────
// Distilled from the "behuman" skill (Wikipedia's "Signs of AI writing" field
// guide) into (1) a prompt block injected into every email-generation prompt and
// (2) a deterministic sanitizer that guarantees no em dashes / curly quotes make
// it into a sent email, whatever the model does.

export const HUMAN_EMAIL_RULES = [
  "WRITE LIKE A HUMAN (a specific, direct person emailing another person — not like AI):",
  "- NEVER use em dashes (—) or en dashes (–). Use a comma, a period, or reword. This is a hard rule.",
  "- Do NOT use these decorative AI-tell words: delve, leverage, seamless, robust, dynamic, intricate, nuanced, multifaceted, elevate, unlock, unleash, empower, foster, garner, boast, spearhead, embark, harness, tapestry, vibrant, crucial, pivotal, holistic, comprehensive, innovative, cutting-edge, state-of-the-art, game-changer, transformative, revolutionize, myriad, plethora, realm, ever-evolving, fast-paced, resonate, showcase, underscore, testament, landscape (metaphorical), journey (metaphorical), navigate (metaphorical), \"dive into\", \"stands as\", \"serves as a reminder\", \"in today's world\", \"in the digital age\", \"at the forefront\". Say the concrete thing the word was hiding instead.",
  "- No formula openers (\"In the world of...\", \"When it comes to...\", \"Whether you're a...\").",
  "- No negative parallelism (\"it's not just X, it's Y\"). No significance tails (\", highlighting...\", \", underscoring...\", \", ensuring...\").",
  "- No rule-of-three padding: don't stack three adjectives or three examples for rhythm. Not every list needs three items — name only what's real.",
  "- No false ranges (\"from solo founders to Fortune 500\"). If there's no real spectrum, name who you actually mean.",
  "- No vague attribution (\"experts say\", \"many believe\") and no puffery (\"stands as a testament to\", \"plays a vital role in\"). These fit anything, so they say nothing.",
  "- No filler transitions (Moreover, Furthermore, Additionally, \"It's worth noting\"). No summary closers (In conclusion, Overall, Ultimately).",
  "- No chatbot residue: never leave placeholder brackets like [insert name] / [company], \"Certainly!\", \"I hope this helps\", or any meta commentary. Ship finished text only.",
  "- Straight quotes and apostrophes only, never curly. No emojis.",
  "- You MAY bold one or two genuinely important phrases with **double asterisks** (e.g. **full-stack engineer**), used sparingly. A single bolded phrase is ideal. Never bold whole sentences, the greeting, the signature, or a phrase in every paragraph, and use no other markdown.",
  "- Short, specific, slightly uneven sentences beat smooth generic ones. Read it aloud: if a line performs competence instead of saying something real, cut it.",
].join("\n");

// Belt-and-suspenders: convert any dashes/curly punctuation the model still emits.
// Em dash -> comma pause; numeric en-dash ranges -> hyphen; other en dashes -> comma;
// curly quotes -> straight; then tidy the punctuation the swaps can create.
export function humanize(text: string): string {
  if (!text) return text;
  let s = text
    .replace(/\s*[—―]\s*/g, ", ")            // em dash / horizontal bar -> ", "
    .replace(/(\d)\s*–\s*(\d)/g, "$1-$2")     // ranges: 2020–2024 -> 2020-2024
    .replace(/\s*–\s*/g, ", ")                // remaining en dashes -> ", "
    .replace(/[“”]/g, '"')          // curly double quotes -> "
    .replace(/[‘’]/g, "'");         // curly single quotes/apostrophes -> '
  // clean up artifacts from the replacements
  s = s
    .replace(/ +,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/(^|\n)\s*,\s*/g, "$1")          // no comma left stranded at a line start
    .replace(/[ \t]{2,}/g, " ");
  return s;
}
