# 02 — decision backend matrix (Jev / Clef)
Type: research
Status: resolved
Blocked by:

## Question
Consolidate the exact client contract for both hosted backends into one comparison table the spec can cite: request/response schema, question types (`noul`/`choice`/`score`), limits (max questions/request, max state size, context window), auth setup, model ids + pricing, latency, rate limits, error codes / fail-open behavior.

Known at charting (verify, correct, fill gaps):
- Jev: POST `https://api.typesafe.ai/v1/systemone`, model `jev-latest` / `jev-1.13`, <=20 q/req, ~0.2s. Gaps: state size limit, pricing, rate limits, models list (jev-ai.org/docs/models/).
- Clef: POST `https://api.cloudflare.com/client/v4/accounts/<acct>/ai/run/@cf/cloudflare/clef` (or `-flash`), <=64 q/req, REST envelope `{success, errors, result}`, output unbilled, $0.24 / $0.09 per M input tokens, 65,536-token context. Gaps: account/token setup steps, rate limits.

Deliver: the table + a recommendation for the spec's `DecisionClient` interface and per-provider envelope adapters.

## Answer

Verified 2026-10-04 against primary sources (listed at the end). **Naming note:** official TypeSafe "System One" docs live at `docs.typesafe.ai` (machine-readable contract: `https://api.typesafe.ai/openapi.json`, OpenAPI 3.1.0 v0.2.0). Two same-shaped lookalikes are *not* TypeSafe official and must not be cited as its contract: **jev-ai.org** (a compatible rehost of the same API with its own, tighter limits) and **docs.system-one.dev** (a third-party gateway platform: 32 q/req, 64 KiB body cap, 120 req/min/account — different surface entirely). The ticket's known-facts ("≤20 q/req", "jev-1.13") actually came from the jev-ai.org mirror, not from TypeSafe.

### Comparison table

| Dimension | **Jev** (TypeSafe hosted) | **Clef** (Cloudflare Workers AI) |
|---|---|---|
| **Endpoint** | `POST https://api.typesafe.ai/v1/systemone`; `GET /v1/models` | `POST https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/run/@cf/cloudflare/clef` (or `/clef-flash`); or a Worker AI binding: `env.AI.run('@cf/cloudflare/clef', body)` |
| **Auth / setup** | Bearer API key (`Authorization: Bearer $TYPESAFE_API_KEY`); key from console.typesafe.ai/keys. ⚠️ New TypeSafe signups paused since ~2026-09-22 — existing keys keep working | Cloudflare account ID + API token with **Workers AI – Read** and **Workers AI – Edit** (dashboard → Workers AI → "Use REST API" → "Create a Workers AI API Token" template). Env: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AUTH_TOKEN`. Any Cloudflare account works; binding path needs no token |
| **Request schema** | `{ state: string\|object\|array (not null), model: string (required per OpenAPI; SDK always sends one, default `jev-latest`), questions: Record<id, Question> }` | Same shape (Jev-compatible). `model` **required** and must match `^\s*(clef\|clef-flash)\s*$` — anything else fails with REST error code **5006** |
| **Question types** | `noul` / `choice` / `score`; `{type, instructions, criteria?}`; `instructions` string\|object\|array (docs mark it required; OpenAPI tolerates omission — always send it) | Identical types and shapes. Clef extension: optional `images[]` next to `state` (≤4 PNG/JPEG/WebP, 4 MiB & 16 MP each, ≤8 MiB decoded total, ≤13 MiB body) — irrelevant for compaction |
| **Answers** | Keyed by question id. `noul → {type, noul}` (no confidence field); `choice → {type, choice, probabilities, confidence}`; `score → {type, score (float, probability-weighted), legend, probabilities, confidence}`; `usage: {input_tokens, output_tokens}` | Identical shapes, under `result`. Response `model` echoes e.g. `clef-flash` with no version suffix |
| **Questions / request** | **No documented max** (OpenAPI: only `minProperties: 1`); the real ceiling is context budget. jev-ai.org mirror: **20** | **1–64**, schema-enforced (`maxProperties: 64`); ids ≤100 chars, `[A-Za-z0-9_.-]` |
| **State / input size** | No char cap documented. Token budgets: **64k tokens per request** (state + all questions) and **32k tokens for state + the single longest question**. Oversize → `400` `detail.error_type: "max_tokens_exceeded"` (community-observed; undocumented in official docs). Never truncated | Context window **65,536 tokens**. Over-limit long text state is **silently truncated** to fit (docs' own wording) — no error. jev-ai.org mirror by contrast caps state at 100k chars and returns `422 input_too_large`, never truncating |
| **Criteria bounds** | Choice: object, ≤**255** options (2+ sensible); Score: array, **2–10** levels; Noul: optional `{true, false}` descriptions | Choice: 2–**255** options; Score: 2–**10** levels; Noul optional `{true, false}`. Same bounds — no adapter divergence |
| **Models** | `jev-1.13.0` (pinned; **not** `jev-1.13`), aliases `jev-latest` and `jev-preview` (both → `jev-1.13.0`); response `model` reports the resolved version. Text-only input | `clef` (27B, Qwen3.8-27B base), `clef-flash` (9B, Qwen3.5-9B). Open weights (Apache 2.0) on HuggingFace → self-host possible |
| **Pricing** | **$0.042 / M input tokens** ($42 / Btok); output free | **$0.24 / M input** (clef), **$0.09 / M input** (clef-flash); output unbilled (`output_tokens: 0`). Billed in Neurons at $0.011/1k; **10,000 Neurons/day free** on Free and Paid plans (~458k clef / ~1.2M clef-flash tokens/day); beyond that needs Workers Paid |
| **Latency** | Vendor: 70–500 ms e2e, ~100 ms typical (US West); Cloudflare-lab measured median **524 ms** round trip | Vendor (model only): clef median 209 ms / p95 239 ms; clef-flash 39 ms / p95 122 ms. Independent REST measurement (Italy): clef-flash 191–205 ms median, clef 524–726 ms (spikes to ~3 s) |
| **Rate limits** | **100K tokens/s and 40 req/s** (as of 2026-09-30; *changed from* 250K tok/s + 1,200 req/min days earlier — docs say limits "can change without notice"). Breach → `429`, honor `retry-after-ms` then `retry-after`. Higher limits on enterprise | Workers AI platform per-task-type, per-account defaults (text-generation bucket; see platform limits page — values not Clef-specific). Practical cap at our scale = daily Neuron allocation. Header namespace `X-RateLimit-*` on the gateway, not on raw Workers AI |
| **Response envelope** | Plain body: `{model, answers, usage}` (+ `x-typesafe-request-id` header) | REST: Cloudflare envelope `{success, errors: [{code, message}], messages, result}` — Jev-shaped payload under **`result`**. AI binding returns the Jev-shaped object **directly, no envelope** |
| **Errors / retry** | Documented: 401, 422 (`HTTPValidationError` `detail[]`), 429, **529 Overloaded**; SDKs also map 400/403/404/5xx. Retry 408/429/5xx w/ backoff (SDK default: 2 retries, 500 ms→5 s cap, 25 % jitter). No charge-on-error guarantee stated, but billing is input-token metered | REST errors are `success:false` + `errors[]` with numeric codes (e.g. 5006 model pattern; context-window overflow errors on oversized images). Binding path **throws** instead. No documented retry policy — client's job |
| **Idempotency** | Not documented on official TypeSafe (no `Idempotency-Key` in OpenAPI/docs). jev-ai.org mirror supports it; don't rely on it | None |
| **SDK** | Official **`@typesafe-ai/sdk`** (JS/TS, Node 20+, ESM+CJS) and `typesafe-sdk` (Python). Also Vercel AI Gateway support and AI SDK `experimental_evaluate` | None official; REST or binding. Works through `@typesafe-ai/sdk` via **custom `fetch`** injection (verified): unwrap envelope, rewrite URL, pass CF token as `apiKey` — only `systemOne()` functions through that adapter (`models.list()` does not) |

### Corrections to the ticket's known-facts

- `jev-1.13` → the versioned id is **`jev-1.13.0`**; `jev-latest`/`jev-preview` are aliases. `model` is required per the official OpenAPI (the SDK's default `jev-latest` masks this).
- "≤20 q/req" is the **jev-ai.org mirror's** limit. Official TypeSafe documents **no question-count cap** — the binding limits are the 64k/32k token budgets. Clef is 64.
- "~0.2 s" for Jev is optimistic-as-written: vendor claims 70–500 ms (~100 ms typical); third-party measured 524 ms median round-trip. Clef-flash genuinely lands 40–200 ms.
- Clef facts all verified ✓ (64 q/req, `{success, errors, result}` envelope, $0.24/$0.09 per M input, output unbilled, 65,536 ctx). Additions: required `model` field (else 5006), and **Clef truncates over-limit state instead of erroring** — a real behavioral divergence.

### Gaps filled

- **Jev state size:** 64k tokens/request total; 32k for state + longest question; no char cap; oversize → `400 max_tokens_exceeded` (never truncated).
- **Jev pricing:** $0.042/M input tokens, output free. **Jev rate limits:** 100K tok/s, 40 req/s (volatile — do not hardcode; implement 429 backoff). **Models:** `jev-1.13.0` + `jev-latest`/`jev-preview` aliases.
- **Clef setup:** account ID + Workers AI token (Read+Edit) from the Workers AI dashboard page; binding alternative needs neither env var. **Clef rate limits:** platform per-task-type defaults; practical constraint = 10k free Neurons/day.

### Recommendation: `DecisionClient` + envelope adapters

Keep the **Jev System One shape as the canonical internal wire format** — both backends already speak it, so adapters only normalize envelope, auth, model id, and errors:

```ts
interface DecisionClient {
  decide(req: { state: unknown; questions: Record<string, Question> }): Promise<DecisionBatch>
}
type DecisionBatch =
  | { ok: true; answers: Record<string, Answer>; model: string; inputTokens: number }
  | { ok: false; error: DecisionError }
interface DecisionError {
  kind: 'auth' | 'rate_limit' | 'input_too_large' | 'overloaded' | 'network' | 'timeout' | 'other'
  retryable: boolean; retryAfterMs?: number; providerCode?: string
}
```

- **Jev adapter:** pass-through — body already canonical, Bearer `TYPESAFE_API_KEY`, map statuses to `kind` (429/529 → `rate_limit`/`overloaded`; `max_tokens_exceeded` 400 → `input_too_large`).
- **Clef adapter:** inject `model` (`clef`|`clef-flash`), rewrite URL to the account-scoped `ai/run` endpoint, set Bearer `CLOUDFLARE_AUTH_TOKEN`, unwrap `{success, result}` (turn `success:false` into a synthesized error Response so retry logic stays uniform). The AI-binding path needs only the model-id rewrite.
- **Per-backend profile** (alongside the map's threshold profiles): `{ model, maxQuestions (Jev: none documented / mirror 20; Clef: 64; self-hosted default 20), stateTokenBudget (Jev 32k w/ longest question; Clef 65536 shared), truncateStateClientSide (true for Clef — it truncates silently; pre-trim ourselves so decisions never see partial state), thresholds }`.
- **Transport:** use `@typesafe-ai/sdk`'s `TypeSafeClient` for **both** providers via its custom-`fetch` option (Clef path verified working; gives typed choice labels via const type params, built-in retry/backoff, error taxonomy for free). Plain `fetch` is an acceptable fallback — the wire is trivial; don't take the dep if the spike doesn't want it.
- **Fail-open is client policy on both backends:** any `ok:false` after built-in retries → caller falls back to native pi compaction. Set per-call timeout 2–5 s (SDK default 10 s is too slow for the compaction path) and cap retries at 1–2.
- **No server idempotency** on either backend → the extension dedupes decisions by entry id itself. **Question-count overflow:** chunk into parallel requests (answers are independent); note it re-reads state per chunk on Jev (extra input tokens).
- **Onboarding risk (ticket 05):** TypeSafe signups are paused; Clef works with any Cloudflare account. Spec should treat Clef(-flash) as the zero-friction default profile and Jev as first-class-when-keyed.

### Sources

- TypeSafe official: docs.typesafe.ai (`/api`, `/models`, quickstart), api.typesafe.ai/openapi.json (v0.2.0 — schema constraints via jevwiki.ai mirror, high-confidence capture, cross-checked), typesafe.ai/blog/introducing-system-one-models-and-jev (pricing $0.042/M, 70–500 ms, 255-choice cardinality)
- jev-ai.org/docs/ + `/models/`, `/decisions/`, `/limits/`, `/errors/`, `/billing/` (compatible rehost — its own limits: 20 q/req, 100k chars state, 32k ctx, 60→300 rpm/key, 10k decisions/day/key, full error-code table, Idempotency-Key)
- Clef: developers.cloudflare.com/workers-ai/models/clef/ (+ `schema-input.json` — 64 q, 2–255 options, 2–10 levels, images, truncation note, $0.24/M, 65,536 ctx), blog.cloudflare.com/clef-decision-models/ (benchmarks, latency, pricing, training), developers.cloudflare.com/workers-ai/platform/limits/ (rate-limit structure, Paid-plan 20/50 rpm table)
- flaviocopes.com/clef (compatibility deep-dive: envelope, 5006, custom-fetch SDK adapter, measured latency, Neuron math, image gotchas) and flaviocopes.com/jev-nodejs (`@typesafe-ai/sdk` full surface: `systemOne()`, options, retries, error classes)
- Footnote: docs.system-one.dev/en/docs/api examined and identified as a third-party gateway (32 q/req, 64 KiB body, 120 rpm/account) — **not** the TypeSafe contract; excluded from the table above.
