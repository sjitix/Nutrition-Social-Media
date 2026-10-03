# Owner to-do — models lane

Things only you can do. **This lane never waits on them** — it keeps working with what is reachable,
and each item says exactly what it unlocks. Put every key in the main folder's `.env.local` only
(gitignored) — **never** in the repo, never in a message.

## Open — four free keys, no card, ~2 minutes each (do these first; they unlock the big-model search)

The free NVIDIA tier tops out at one slow big model (Nemotron-Ultra-550B, 7–46 s per call). Every
model below is bigger-and-faster or frontier-class, and free:

- [ ] **Groq** — console.groq.com → API Keys → Create. Add `GROQ_API_KEY=...`
  **Unlocks:** `gpt-oss-120b` (6× today's model) at hundreds of tok/s — the fastest big model there is,
  and the same class a 128 GB box would run (see `hardware-128gb.md`). ~1,000 requests/day.
- [ ] **OpenRouter** — openrouter.ai → Keys → Create (no credit needed). Add `OPENROUTER_API_KEY=...`
  **Unlocks:** `qwen3-235b-a22b:free` and the other `:free` models (Nemotron-3-Ultra, Laguna-S).
  50 requests/day per model — enough for evals.
- [ ] **GitHub Models** — github.com → Settings → Developer settings → Fine-grained tokens → Generate,
  with permission **Models: read** only. Add `GITHUB_MODELS_TOKEN=...`
  **Unlocks:** GPT-4.1, o3/o4-mini, Llama-4, DeepSeek-R1, Grok-3 — frontier models, free on your
  existing account (50/day on the big ones). Note: this machine has no `gh` CLI, and this lane will not
  borrow git's stored credential for another purpose — so it needs its own token.
- [ ] **Google AI Studio** — aistudio.google.com → Get API key. Add `GEMINI_API_KEY=...`
  **Unlocks:** the Gemini Flash family + Gemma 4 on a permanent free tier (~1,000+ requests/day).

- [ ] **OVHcloud AI Endpoints key** — ovhcloud.com → create an account → Public Cloud project → AI
  Endpoints → API keys. Add `OVH_AI_KEY=...`. **Unlocks:** the same models measured keyless today —
  **Qwen3.5-397B**, **gpt-oss-120b (3.4 s/call)**, **Llama-3.3-70B (2.7 s/call)** — at 400 requests/min
  instead of 2. Keyless already works but locks the IP out after a burst, so it can't carry an eval.
  (Check whether your account gets free credit; usage beyond that is pay-per-token and cheap.)

## Open — optional / later

- [ ] One paid key (Anthropic, Cerebras $5 trial, SambaNova) — only if no free model clears the bar.
- [ ] Install the other RTX 2070s if you have them (`docs/v1/03-kimi-decision.md` §3) — 32 GB VRAM, a
  30B model fully on GPU, free.

## Done

*(none yet)*
