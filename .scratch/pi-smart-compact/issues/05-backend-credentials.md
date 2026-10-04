# 05 — backend credentials for the spike
Type: task
Status: resolved
Blocked by:

## Question
(HITL, user) Provide live credentials so ticket 06 can test both hosted backends:
1. Jev: create a TypeSafe API key (console.typesafe.ai/settings/keys), export `TYPESAFE_API_KEY` in the shell that launches pi.
2. Clef: from the firm's Cloudflare setup — account id + Workers AI API token (or whatever the firm announcement grants; record the exact grant shape). Export `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`.
3. Freejev (test-only): user holds a freejev API key — Jev-compatible, **rate-limited to 1 request/minute**, so suitable for the spike's smoke tests only, not for measured runs. At setup, record its base URL, model id, and export as `FREEJEV_API_KEY`; the spike's backend config must respect the 1 req/min budget (batch aggressively or stub the rest).

Rules: env vars only; never committed or printed; revocable keys. Resolved when both backends answer one test question from this machine.

## Answer
Both legs verified live from this machine (2026-10-04), one smoke request each. Done-criterion met.

**Key storage**: gitignored `.env.local` at repo root holds `FREEJEV_API_KEY` and `OPTOLLM_API_KEY` (source with `set -a; source .env.local; set +a`). Keys are never echoed, logged, or committed. **Rotate both after the spike** — they transited chat on delivery. TypeSafe direct: unobtainable (signups paused) and not needed.

### freejev — the Jev leg
- Endpoint: `POST https://freejev.org/api/v1/decisions`, `Authorization: Bearer`, `Idempotency-Key` supported. Docs: freejev.org/docs. Wire: `{state, questions}` (no `model` field — pinned server-side to `typesafe/jev-1.13-20260917`).
- Smoke test: noul "flaky CI?" → **0.88**; 306 input tokens, 0.306 credits, 9999.3 remaining.
- Limits: **1 req/min on this key** (docs' account default is 30/min, one-at-a-time — honor the stricter key limit); ≤16 questions/request; 128 KB max body; 1 credit = 1000 input tokens, output free; 402 on empty balance; client retries billable requests at its peril (no auto-retry).

### optollm gateway — the Clef leg (the firm grant's actual shape)
- Not Cloudflare at all: the grant is the firm's **optollm gateway** serving `clef` natively at `POST https://optollm.optomatica.com/v1/systemone` (Jev-shape, LiteLLM key auth, request carries `"model": "clef"` — exactly what ticket 03's update found).
- Smoke test: noul → **0.9417** (agrees with Jev's 0.88 — good cross-backend sanity); choice triage → `infra` p=0.671, confidence 0.346; `output_tokens: 0` (prefill-only decision head confirmed through the gateway); 285 input tokens.
- Standing caveats (ticket 03): decision API only, never the chat endpoint; image input unverified through the gateway; probabilities are estimates.

### Consequence for ticket 06
Smoke tests → freejev at ≤1 req/min (batch aggressively, stub the rest). Measured Clef runs → optollm pass-through (TypeSafe-SDK style, not the Cloudflare `{success, result}` envelope from ticket 02). Ollama `clef-flash` remains the keyless offline fallback.

## Comments

Update (post-research, ticket 02): **TypeSafe signups are currently paused** — the Jev key may be unobtainable right now. Your firm's Clef access is the critical path; record its exact grant shape. If neither hosted key materializes, ticket 03 found a no-key fallback: `ollama pull clef-flash` serves the native Jev API on `/v1/systemone` locally, enough to unblock ticket 06.

Update (user): a **freejev** API key is available for testing — Jev-compatible, 1 request/minute limit, testing only. Recorded as option 3 above; unblocks part of ticket 06 without waiting on TypeSafe or the firm grant.

Update (user, delivery): delivered freejev + optollm keys via chat; agent secured both into gitignored `.env.local`. optollm is the firm gateway hosting clef — matches ticket 03's update; no Cloudflare credentials exist or are needed.
