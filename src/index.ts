import { parseArgs } from "node:util";
import { resolveCompany, searchContacts, enrichPerson, DEFAULT_TITLES } from "./apollo";
import { personalize } from "./personalize";
import { logOutreach, alreadyContacted } from "./tracker";
import { gmailConfigured, getGmailAuth, createDraft } from "./gmail";
import { profile } from "./profile";

function parse() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      role: { type: "string" },
      max: { type: "string", default: "5" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const company = positionals[0];
  if (!company || !values.role) {
    console.error(
      'Usage: npm run warmreach -- "<company or domain>" --role "<role>" [--max N] [--dry-run]',
    );
    process.exit(1);
  }
  return {
    company,
    role: values.role as string,
    max: parseInt(values.max as string, 10),
    dryRun: values["dry-run"] as boolean,
  };
}

async function main() {
  const args = parse();
  console.log(`\n🔎 Resolving "${args.company}" ...`);
  const company = await resolveCompany(args.company);
  console.log(`   → ${company.name} (${company.domain})`);

  const found = await searchContacts(company, DEFAULT_TITLES, 25);
  const candidates = found.filter((p) => p.has_email).slice(0, args.max);
  console.log(`\n👥 ${found.length} people found, ${candidates.length} with email (cap ${args.max}):`);
  candidates.forEach((c) => console.log(`   - ${c.first_name} — ${c.title}`));
  if (candidates.length === 0) {
    console.log("No reachable contacts. Done.");
    return;
  }

  console.log(`\n💳 Enriching ${candidates.length} contact(s) (≈${candidates.length} Apollo credits)...`);
  const gmailAuth = args.dryRun ? null : gmailConfigured() ? await getGmailAuth() : null;
  if (!gmailAuth && !args.dryRun) {
    console.log("   (Gmail not configured yet — will print drafts instead of creating them.)");
  }

  for (const cand of candidates) {
    const contact = await enrichPerson(cand.id, company.domain);
    if (!contact.email) {
      console.log(`\n⏭️  ${contact.fullName}: no email after enrichment, skipping.`);
      continue;
    }
    if (alreadyContacted(contact.email)) {
      console.log(`\n⏭️  ${contact.fullName} <${contact.email}>: already in log, skipping.`);
      continue;
    }

    const email = await personalize(contact, args.role);
    let draftStatus = "printed";

    if (gmailAuth) {
      const id = await createDraft(gmailAuth, {
        to: contact.email,
        subject: email.subject,
        body: email.body,
        attachmentPath: profile.resumePath,
      });
      draftStatus = `draft:${id}`;
    }

    console.log("\n" + "═".repeat(70));
    console.log(`TO: ${contact.fullName} <${contact.email}> [${contact.emailStatus}] — ${contact.title}`);
    console.log(`SUBJECT: ${email.subject}`);
    console.log("─".repeat(70));
    console.log(email.body);
    console.log("═".repeat(70));

    logOutreach({
      company: company.name,
      role: args.role,
      name: contact.fullName,
      title: contact.title,
      email: contact.email,
      emailStatus: contact.emailStatus ?? "",
      subject: email.subject,
      draftStatus,
    });
  }

  console.log(
    gmailAuth
      ? "\n✅ Drafts created in Gmail — review and hit Send on each."
      : "\n✅ Done (printed). Set up Gmail to auto-create drafts. Logged to data/outreach_log.csv.",
  );
}

main().catch((e) => {
  console.error("\n❌", e.message);
  process.exit(1);
});
