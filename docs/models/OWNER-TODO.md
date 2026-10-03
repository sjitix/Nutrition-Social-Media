# Owner to-do — models lane

Things only you can do. **This lane never waits on them** — it keeps working with what is reachable,
and each item says exactly what it unlocks. Newest at the top. Put every key in `.env.local` of the
main folder only (gitignored) — **never** in the repo, never in a message to an agent you can't see.

## Open

- [ ] **Google AI Studio key — free, no card, ~2 min.** aistudio.google.com → "Get API key" → create.
  Add to `.env.local` as `GEMINI_API_KEY=...`.
  **Unlocks:** the Gemini Flash family (frontier-class quality, typically ~1–3 s/call) and Gemma 4 on a
  permanent free tier (Flash ≈ 1,000+ requests/day). This is the most likely "big *and* fast" answer —
  the free NVIDIA tier can't give one (see `survey.md`).
- [ ] **Groq key — free, no card, ~2 min.** console.groq.com → API Keys → create.
  Add as `GROQ_API_KEY=...`.
  **Unlocks:** `gpt-oss-120b` (6× the parameters of today's model) and other large open models at
  hundreds of tokens/sec. Free daily caps are tight (~1,000 requests/day for the 120B), enough for
  evals, not for a public beta.
- [ ] **(optional, later) one paid frontier key** — Anthropic, OpenRouter or Cerebras ($5 trial with a
  card since July 2026). Only if the free candidates can't clear the 84% bar. ~35–40¢ per full eval.
- [ ] **(free, unlocks local 30B)** Install the other RTX 2070s if you have them
  (`docs/v1/03-kimi-decision.md` §3): 4 cards = 32 GB VRAM = a 30B model fully on GPU.

## Done

*(none yet)*
