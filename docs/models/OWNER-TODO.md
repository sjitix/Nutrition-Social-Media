# Owner to-do — models lane

Things only you can do. **This lane never waits on them.** It keeps working with what is reachable,
and each item says exactly what it unlocks. Put every key in the main folder's `.env.local` only
(gitignored). **Never** put one in the repo or in a message.

Rewritten 2026-10-03 after a verified search of every free provider (`free-providers-2026-10.md`).
The honest headline: **no provider gives a big model, ~5 s calls, a free tier AND hundreds of calls a day
all at once.** The keys below are ranked by what they unlock per minute of your time.

## Open — ranked

- [ ] **1. Vercel AI Gateway key** (your existing Vercel team, the one that deploys ntrux) — Vercel
  dashboard → AI Gateway → API keys → Create. Add `AI_GATEWAY_API_KEY=...`. **Do not buy credits**:
  any purchase ends the monthly free credit for good. Vercel may ask for a card to verify the team.
  **Unlocks:** `inclusionai/ling-3.1-flash` at **$0**: 560B total / 25B active, reasoning switchable to
  "none", ~8 s per call (estimate from Vercel's public metrics). It is the biggest free model with no
  token cap we found. The free rate limit is unpublished, so the first eval finds it.
- [ ] **2. Mistral key** — console.mistral.ai → sign up (the official quickstart says no card) → API keys.
  Add `MISTRAL_API_KEY=...`. If there is a setting to opt out of training on your data, use it.
  **Unlocks:** **Mistral Large 3** (675B / 41B active, schema-enforced JSON, ~6 s per call). The free
  plan is $10/month of credit, ~90 of our calls a day: enough to EVALUATE it, not to run a beta on.
- [ ] **3. Groq key** — console.groq.com → API Keys → Create (no card). Add `GROQ_API_KEY=...`
  **Unlocks:** `gpt-oss-120b` at ~500 tok/s (~1.5–3 s per call). The free tier is 8K tokens/min and
  200K/day, which is ~25–40 of our calls a day: evals only, not a beta (corrected from the "1,000/day"
  this file said before).
- [ ] **4. OpenRouter key** — openrouter.ai → Keys → Create. Add `OPENROUTER_API_KEY=...`
  **Unlocks:** the `:free` big models (dots-3-note-preview 280B with JSON schema, Inkling 975B) at 50
  requests/day across ALL free models. **Optional one-time $10 credit** (not a subscription) raises
  that to 1,000/day at 20/min. That is the cheapest way to a beta-sized free quota.
- [ ] **5. OVHcloud Public Cloud project** — needs a payment method. New projects get **$200 free
  credit** (OVH's AI Endpoints page). Then AI Endpoints → API keys; add `OVH_AI_KEY=...`.
  **Unlocks:** `gpt-oss-120b` (measured **3.4 s per call**, JSON schema) and Qwen3.5-397B at 400
  requests/min. gpt-oss-120b costs ~EUR 0.0007 per call, so the credit covers a long beta. This is the
  only verified path to "fast + big + enough volume". (Corrected: the key is NOT free by itself.
  Only the anonymous 2 requests/min tier is, and it has blocked this machine's IP for 3+ hours.)

## Removed (verified 2026-10-03)

- ~~GitHub Models~~ — **retired.** GitHub's docs: "As of July 30, 2026, GitHub Models has been fully
  retired." Nothing to create.
- ~~Google AI Studio~~ — parameter counts undisclosed (cannot verify "big"), ~20 requests/day on the
  newest Flash, and Gemini 3's reasoning cannot be switched off (13–22 s to first token).
- ~~Cerebras / SambaNova "free"~~ — both need a card. Cerebras is a $5 trial that expires in 30 days;
  SambaNova is 20 requests/day per model.

## Open — optional / later

- [ ] Install the other RTX 2070s if you have them (`docs/v1/03-kimi-decision.md` §3): 32 GB VRAM, a
  30B model fully on GPU, free. Lower priority now that the direction is big hosted models.

## Done

*(none yet)*
