# Contributing

warmreach is a personal tool that runs on `localhost`. This file exists so the
working agreement is written down rather than remembered.

## Don't push to main

`main` is the release branch. Everything lands through a pull request that
@RutwikPatel13 reviews and merges — including small fixes, and including work
that looks obviously correct.

```bash
git switch -c short-descriptive-name
# ... commit ...
git push -u origin short-descriptive-name
# then open a PR
```

No force-pushing to `main`, and no deleting it. A force-push rewrites history
for everyone and there's no server-side undo on this repo.

## Turn on the push guard

Run this once after cloning:

```bash
git config core.hooksPath .githooks
```

That enables [`.githooks/pre-push`](.githooks/pre-push), which runs two checks
before anything leaves your machine:

1. **Nothing lands directly on `main`** — including deleting it.
2. **No secret or personal-data file gets pushed, on any branch.** It refuses
   `.env`, `credentials/`, `data/`, `src/profile.ts`, `HANDOFF.md`, and
   anything shaped like a token, client secret, or private key — even if it was
   staged with `git add -f`. `.env.example` is allowed through; it's the
   committed placeholder.

Both catch accidents, not intent: `git push --no-verify` still overrides them.
Use the override only when you mean to.

## Before you open a PR

```bash
npx tsc --noEmit   # must be clean
npm run build      # must succeed
```

Keep commits reviewable on their own: one idea each, and each one should
typecheck on its own so the history stays bisectable.

## Things that never get committed

`.gitignore` covers these, but they're worth naming because committing one is
hard to walk back on a repo with shared access:

- `.env` — API keys
- `src/profile.ts` — personal identity, resume path, signature
- `data/` — the outreach log, templates, and everything else with real contact
  details in it
- `credentials/` — Gmail OAuth client and token

If you need to demonstrate something involving one of these, use fake data.
