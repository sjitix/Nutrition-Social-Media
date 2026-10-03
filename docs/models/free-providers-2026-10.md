<!--
Provenance: produced 2026-10-03 by a 25-agent search (6 sweepers, 12 per-provider verifiers that read
each provider's own pricing / rate-limit pages, a completeness critic plus 5 more verifiers, and a ranker).
The models lane then checked the claims that change a decision itself (section "Checked by the models
lane" below). Owner actions derived from it: OWNER-TODO.md.
-->

## Checked by the models lane (after the search, same day)

- **Nemotron-3-Super-120B is gone.** NVIDIA returned `410 Gone`: "reached its end of life on
  2026-10-03T09:00:00Z". So rank 4 below (OpenRouter's NVIDIA-hosted `:free` mirror) is very likely dead too.
- **GitHub Models is retired**, confirmed on docs.github.com: "As of July 30, 2026, GitHub Models has been
  fully retired."
- **OVH keys.** The capabilities page confirms anonymous 2 req/min per IP per model vs 400 req/min per
  Public Cloud project per model, and that keys belong to a Public Cloud project. OVH's AI Endpoints page
  advertises **$200 free credit for new Public Cloud projects**. At ~EUR 0.0007 per gpt-oss-120b call that
  credit would carry a long beta, so OVH is "card, then effectively free for a while", not just "paid".
- **OVH keyless is still blocked** for this IP (429 at 15:30 local, ~5 h after the burst).
- **Vercel's Ling 3.1 Flash exists** as described (keyless metrics GET): 560B total / 25B active,
  reasoning efforts `none | low | medium | high`.

---

# Choosing NutriFlow's assistant model: free big-model options (verified 2026-10-03)

## Bottom line

**No provider verified today meets all four requirements together:**

- a model of 70B or more;
- calls of 5 s or less;
- a free tier;
- 300-1,500 calls a day.

The free tiers split into three groups:

- **Hard daily caps.** Most free tiers are capped at roughly 20-150 of our 5-7k-token calls a day.
- **Unpublished limits.** Two are $0-per-token with undisclosed rate limits: Vercel AI Gateway's Ling models.
- **Needs $10.** OpenRouter's :free models need a one-time $10 purchase to reach 1,000 requests/day.

The most promising free route is **Vercel AI Gateway: Ling 3.1 Flash (560B MoE, 25B active)**, with Ling Sante as a fast fallback. Next is **OpenRouter :free plus the $10 top-up**: dots-3-note-preview, Nemotron-3-Super or Inkling.

If the beta must reliably hit 5 s or less with schema-enforced JSON, the realistic answer is **a few euros a month**:

- OVH gpt-oss-120b: 3.4 s measured, about EUR 10-33 a month.
- Groq Developer gpt-oss-120b.

Throughout, "big" means total parameters. Active parameters per token are listed too, because they predict agentic quality better: gpt-oss-120b has about 5B active, Ling 3.1 Flash 25B, and Mistral Large 3 and Inkling 41B each.

## Ranking

Expected seconds are for a call with about 5k tokens in and 400 out. "Est." means the figure is derived from published latency and throughput rather than timed by us.

| # | Provider / model | Total (active) | Access | Free limits | s/call | JSON | Owner effort |
|---|---|---|---|---|---|---|---|
| 1 | Vercel AI Gateway, `inclusionai/ling-3.1-flash` | 560B (25B) | Key in the existing Vercel team; a card prompt is possible | $0/token; **rate limit undisclosed** | **~8 (est.)**: p50 2.7 s + 400/79 tok/s; p95 up to ~12 | No response_format: forced tool call or prompt JSON | Low (team exists) |
| 2 | OpenRouter `dots-3-note-preview:free` | 280B (16B) | Key; $10 one-time for 1,000 RPD | 20 RPM, 1,000 RPD, shared across all :free models | Unverified (AtlasCloud upstream) | json_schema | Key + $10 |
| 3 | Mistral Large 3 (Free plan) | 675B (41B) | Key; no card (official) | $10/month credit, about 90 calls/day | ~6 (AA: 1.06 s TTFT, 79 tok/s) | Schema-enforced structured output | Email (+ phone?) |
| 4 | OpenRouter `nemotron-3-super-120b-a12b:free` | 120B (12B) | Key + $10 | Shared 20 RPM / 1,000 RPD | Unverified; NVIDIA-hosted, so likely the NIM queue | json_schema | Key + $10 |
| 5 | OpenRouter `thinkingmachines/inkling:free` | 975B (41B) | Key + $10 | Shared | Unverified | Prompt-only (no tool_choice) | Key + $10 |
| 6 | Vercel `ling-3.0-flash-sante` | 124B (5.1B), health-tuned | As #1 | $0; undisclosed | **~3 (est.)**: 0.85 s + 400/207 | Forced tool call or prompt | As #1 |
| 7 | OVH `gpt-oss-120b` / `Qwen3.5-397B-A17B` (paid) | 117B (5B) / 397B (17B) | Payment method | Keyless 2 req/min/IP/model only | **3.4 (measured)** / unmeasured | json_schema | Card; ~EUR 0.3-1.1/day (Qwen ~EUR 1.6-8) |
| 8 | Groq `gpt-oss-120b` | ~120B (5B) | Key (free); card for Developer | Free: 8K TPM, 200K TPD, so ~30 calls/day | ~1.5-3 (est.) | **Strict** json_schema | Email; card to scale (~$1-6/day) |
| 9 | Cerebras `gpt-oss-120b` | ~117B | Card; $5 credit for 30 days | 5 RPM, 1M TPD (~150 calls/day) | <2 (est.) | Strict json_schema | Card |
| 10 | NIM Nemotron-3-Ultra (current baseline) | 550B (55B) | Key held | Account limits | **17-22 (measured): disqualified** | Prompt/tools | None |

### How the speed estimates were derived
- **Ling models:** the Vercel gateway's own public per-endpoint metrics for the last hour, read with keyless GETs on `/v1/models/{id}/endpoints`:
  - Ling 3.1 Flash: p50 2.7 s, p95 7.2 s, 79 tok/s, uptime 99.999%.
  - Ling Sante: p50 0.85 s, p95 2.0 s, 207 tok/s.
- **Mistral Large 3:** Artificial Analysis provider page.
- **Groq and Cerebras:** vendor-claimed throughput.
- **OVH gpt-oss-120b:** our own earlier measurement.
- **OpenRouter :free:** no speed data. OpenRouter publishes latency as null, and chat calls return 401 without a key.

## Can we test it today without a new key?

1. **NIM, with the key we already hold.** Time `nvidia/nemotron-3-super-120b-a12b` at about 6k tokens with json_schema.
   - OpenRouter's :free endpoint for it is NVIDIA-hosted, so this previews rank 4 before anyone spends $10.
   - It may 404, as most big NIM models do on free accounts.
2. **OVH keyless.** Only if the IP block has lifted; the last probe returned 429 in 0.12 s.
   - At most 3 calls, 30 s or more apart, to Qwen3.5-397B. Its latency is the one unmeasured OVH figure.
3. **Vercel and OpenRouter public metrics and catalogs** (keyless GETs).
   - Re-read the Ling latency at other times of day.
   - Watch for the preview :free models disappearing.
4. **LLM7 keyless (undocumented).** At most 3 spaced calls to DeepSeek-V4-Flash, as a quality spot-check only.
5. **Code-side prep (proposal, nothing edited).** A "forced tool call as schema" path in `src/lib/ai.ts`'s local provider.
   - Ranks 1 and 6 have no `response_format`, so this decides whether they are usable.

## Corrections to what we believed

**OVH "free account key at 400 req/min" is not free.**
- Keyed use needs a Public Cloud project with a payment method, billed per token.
- Only keyless 2 req/min/IP/model costs nothing.
- If the owner already holds an OVH key, check the console for charges.
- Source: [OVH capabilities](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-capabilities), [catalog](https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/)

**Groq free does not fit our volume.**
- gpt-oss-120b is 30 RPM, 1K RPD, 8K TPM and 200K TPD, which is about 1 call/min and about 30/day at our prompt size.
- Llama-3.3-70B is no longer in the free table.
- Source: [rate limits](https://console.groq.com/docs/rate-limits), [models](https://console.groq.com/docs/models), [structured outputs](https://console.groq.com/docs/structured-outputs)

**Cerebras needs a card.**
- The $5 credit expires after 30 days.
- The shared catalog now holds only gpt-oss-120b and qwen-3.8-27b.
- Source: [rate limits](https://inference-docs.cerebras.ai/support/rate-limits), [models](https://inference-docs.cerebras.ai/models/overview), [structured outputs](https://inference-docs.cerebras.ai/capabilities/structured-outputs)

**SambaNova's free tier is 20 requests/day per model.** The plans page also asks for a payment method.
- Source: [rate limits](https://docs.sambanova.ai/docs/en/models/rate-limits), [plans](https://cloud.sambanova.ai/plans)

**GitHub Models is retired**, as of 2026-07-30.
- Source: [docs](https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models), [changelog](https://github.blog/changelog/2026-07-01-github-models-is-being-fully-retired-on-july-30-2026/)

**OpenRouter :free:**
- 20 RPM.
- 50 RPD, or 1,000 RPD after $10 or more in lifetime purchases.
- Per account and shared across all :free models; failed requests count.
- No gpt-oss-120b or Llama-70B :free variant exists.
- Source: [limits](https://openrouter.ai/docs/api/reference/limits), [catalog](https://openrouter.ai/api/v1/models)

**Cloudflare:** the big Kimi, GLM and DeepSeek V4 models need paid billing, and the free 10k neurons/day is about 29-71 calls.
- Source: [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)

**Google AI Studio:**
- Gemini 3.x reasoning cannot be disabled.
- 3.8 Flash is about 20 RPD (third-party figure).
- 2.5 models are closed to new users.
- Parameter counts are undisclosed.
- Source: [OpenAI compat](https://ai.google.dev/gemini-api/docs/openai), [changelog](https://ai.google.dev/gemini-api/docs/changelog), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)

**Mistral:** the free tier is now a $10/month credit, according to a third-party source; the old "1B tokens" figure is stale. No card is needed, per the official docs.
- Source: [pricing](https://mistral.ai/pricing), [quickstart](https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key), [Mistral 3](https://mistral.ai/news/mistral-3)

**Vercel AI Gateway:**
- Only 3 $0 chat models are on the official free filter.
- gpt-oss-120b and Nemotron are priced, not free.
- The FAQ lists a `customer_verification_required` error that can demand a card.
- Source: [pricing](https://vercel.com/docs/ai-gateway/pricing), [rate limits](https://vercel.com/docs/ai-gateway/rate-limits), [FAQ](https://vercel.com/docs/ai-gateway/faq), [free filter](https://vercel.com/ai-gateway/models?freeTier=true)

## Rejected
- **GitHub Models:** retired.
- **Google AI Studio:** size unknown, about 20 RPD, slow thinking, trains on free-tier data.
- **NIM Ultra and the other NIM big models:** 17-90 s or timeouts.
- **Groq free:** token caps.
- **Cerebras:** card, 30-day credit.
- **SambaNova:** 20 RPD.
- **Cloudflare:** about 44 calls/day.
- **LLM7:** 100K tokens/day, dirty JSON, undocumented keyless access.
- **Hugging Face:** $0.10/month.
- **Nebius:** $1 trial, card required.
- **OpenRouter without $10:** 50 RPD.
- **Small or off-target :free models.**
- **Sweep-only, unverified:** Together, Fireworks, DeepInfra, Chutes and DeepSeek are paid. Novita's free models are ≤9B. Hyperbolic, Scaleway and Alibaba offer one-time credits only. Cohere is 1,000 calls/month and non-commercial. Z.ai's free GLM-Flash is below 70B. Lambda is winding down.

## Risks to keep in view
- **Data handling.** Free tiers at Google and Mistral (reportedly) may use inputs for training. OpenRouter's free-endpoint logging is unverified. Testers' health data is involved.
- **Preview models can vanish.** dots-3-note-preview and the Ling "free" aliases may disappear without notice. Keep the provider abstraction's fallback chain populated.
- **Confidence.** Medium for the Vercel and OpenRouter rows: their rate limits and speeds are unpublished or estimated. High for the corrections above, which come from official pages.
