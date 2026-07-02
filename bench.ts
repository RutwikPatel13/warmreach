// Compare models for the email-personalization task. No Apollo calls (fixed contact).
// Run: npx tsx bench.ts
import { personalizeWith } from "./src/personalize";
import type { Contact } from "./src/apollo";

const contact: Contact = {
  firstName: "Alex",
  lastName: "Rivera",
  fullName: "Alex Rivera",
  title: "Co-Founder & COO",
  email: "alex@acme.example",
  emailStatus: "verified",
  seniority: "founder",
  linkedin: "https://www.linkedin.com/in/alexrivera",
  company: {
    name: "Acme AI",
    description:
      "Acme AI is a New York-based software company founded in 2023. It builds an AI-native platform of specialized agents that automate complex workflows in sales, service, and operations for distributors, suppliers, and field-service organizations. It focuses on B2B enterprises, with autonomous multi-agent systems that execute end-to-end tasks directly within ERP, CRM, and service systems.",
    keywords: [
      "ai agents", "vertical ai", "enterprise ai", "ai automation", "workflow automation",
      "b2b", "supply chain", "erp integration", "machine learning", "saas",
    ],
  },
};

const ROLE = "Software Engineer (Toronto)";

// Approx public pricing, USD per 1M tokens (input / output).
const MODELS = [
  { label: "Haiku 4.5", id: "claude-haiku-4-5-20251001", in: 1, out: 5 },
  { label: "Sonnet 4.6", id: "claude-sonnet-4-6", in: 3, out: 15 },
  { label: "Opus 4.8", id: "claude-opus-4-8", in: 15, out: 75 },
];

const BUDGET = 5;

async function main() {
  const rows: any[] = [];
  for (const m of MODELS) {
    process.stdout.write(`\n\n${"#".repeat(72)}\n# ${m.label} (${m.id})\n${"#".repeat(72)}\n`);
    try {
      const r = await personalizeWith(contact, ROLE, m.id);
      const cost = (r.usage.input_tokens * m.in + r.usage.output_tokens * m.out) / 1e6;
      console.log(`SUBJECT: ${r.email.subject}\n`);
      console.log(r.email.body);
      rows.push({
        label: m.label,
        inTok: r.usage.input_tokens,
        outTok: r.usage.output_tokens,
        ms: r.ms,
        cost,
        perBudget: Math.floor(BUDGET / cost),
      });
    } catch (e: any) {
      console.error(`ERROR: ${e.message}`);
      rows.push({ label: m.label, error: e.message });
    }
  }

  console.log(`\n\n${"=".repeat(72)}\nSUMMARY (cost = this email; emails/$5 = how many $5 buys)\n${"=".repeat(72)}`);
  console.log(
    ["Model", "in tok", "out tok", "latency", "$/email", "emails/$5"]
      .map((s, i) => s.padEnd([12, 8, 8, 9, 10, 10][i]))
      .join(""),
  );
  for (const r of rows) {
    if (r.error) { console.log(`${r.label.padEnd(12)}ERROR: ${r.error}`); continue; }
    console.log(
      [
        r.label.padEnd(12),
        String(r.inTok).padEnd(8),
        String(r.outTok).padEnd(8),
        `${(r.ms / 1000).toFixed(1)}s`.padEnd(9),
        `$${r.cost.toFixed(5)}`.padEnd(10),
        `~${r.perBudget}`.padEnd(10),
      ].join(""),
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
