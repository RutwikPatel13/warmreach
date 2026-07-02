# warmreach

Cold outreach made warm. After you apply for a job, warmreach finds the right people at the company (recruiters, founders, engineering leads), writes each of them a personalized email grounded in real company facts, and lands the results as Gmail drafts — resume attached, ready for you to review and send.

Pipeline: **Apollo** (find people → verified emails, with optional Hunter.io fallback) → **Claude** (personalize each email from real company facts and the job description) → **Gmail** (drafts, never auto-sent). Every contact is logged to `data/outreach_log.csv` so you never double-contact anyone.

## Web app

```bash
npm run dev   # → http://localhost:3000
```

The web UI is the main way to use warmreach:

1. **Find people** — enter company + role (paste the JD for better results); candidates are ranked against the JD and the best fits are pre-selected.
2. **Pick a template** — use a saved email template, write a new one inline, or let Claude write from scratch; add per-run instructions or reusable prompt presets.
3. **Generate** — Claude composes one email per contact, personalized to the company and audience (recruiter vs. engineer).
4. **Review & send** — edit inline, create Gmail drafts, then send from the app or from Gmail.

Workspaces live in browser tabs and persist across reloads. All API routes reject non-local requests — this is a personal tool meant to run on `localhost`.

## CLI

```bash
npm run warmreach -- "<company or domain>" --role "<role>" [--max N] [--dry-run]
```

- `--max N` — cap contacts enriched (default 5; each enrichment = 1 Apollo credit).
- `--dry-run` — skip Gmail, just print + log.

## Setup

```bash
npm install
cp .env.example .env                     # then paste your keys
cp src/profile.example.ts src/profile.ts # then fill in your details
```

- `.env` needs `ANTHROPIC_API_KEY` and `APOLLO_API_KEY` (`HUNTER_API_KEY` optional).
- `src/profile.ts` is your identity: name, links, resume location, the experience bullets and signature that go verbatim into every email. It is git-ignored.

### Gmail (optional, for auto-drafts)

Without this, the tool prints the emails so you can paste them. To auto-create drafts:

1. [console.cloud.google.com](https://console.cloud.google.com) → new project.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **OAuth consent screen** → External → add your Gmail as a **Test user**.
4. **Credentials → Create credentials → OAuth client ID → Desktop app** → Download JSON.
5. Save it as `credentials/credentials.json`.
6. `npm run gmail:auth` (opens a browser once; saves `credentials/token.json`).

## Layout

- `app/` — Next.js web app (UI + local-only API routes)
- `src/apollo.ts` — company resolve, people search, enrichment
- `src/hunter.ts` — Hunter.io email-finder fallback
- `src/personalize.ts` — Claude composes each email
- `src/gmail.ts` — OAuth + draft creation/sending
- `src/templateStore.ts` — saved email templates (`data/templates.json`)
- `src/tracker.ts` — CSV log + dedupe
- `src/profile.ts` — **your details** (git-ignored; copy from `profile.example.ts`)
- `src/index.ts` — the CLI

## Security

Keys live in `.env` (git-ignored). `credentials/`, `data/`, and `src/profile.ts` are git-ignored too — never commit them. The only Gmail scope requested is `gmail.compose`; nothing is ever sent without you clicking Send.
