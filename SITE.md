# NutriFlow — running the site

## The link

**http://localhost:3000**

This is a *local* address: it only works on the machine running the dev server (this
desktop), while `npm run dev` is running. It is not on the public internet, so it
won't open from your phone or another computer unless you deploy it.

## How to start it

```bash
npm run dev          # then open http://localhost:3000
```

If `npm` isn't found, Node was installed portably — prepend it to PATH first:

```bash
export PATH="$LOCALAPPDATA/nodejs:$PATH"   # Git Bash
```

## What it's talking to

The assistant chat and "regenerate" use whatever `.env.local` points at:

- `AI_PROVIDER=local` + `LOCAL_AI_MODEL=<identifier>` → the model loaded in LM Studio
  on `http://localhost:1234`. The identifier must match what `lms ps` shows, **not**
  the folder name. Right now it's the fine-tuned `nutriflow-v7`.
- No `.env.local` → demo mode: an instant sample plan, assistant disabled.

If the chat says it's unavailable, LM Studio probably has no model loaded, or the
identifier in `.env.local` doesn't match `lms ps`.

## To reach it from your phone / share it

The `localhost` link won't leave this machine. To get a shareable URL you'd deploy
(e.g. Vercel) or run a tunnel — say the word and I'll set one up.
