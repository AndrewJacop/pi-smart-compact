# 08 — Remaining backends: ollama, freejev, jev-direct

**What to build:** The `DecisionClient` contract gains its remaining shipped profiles, all speaking the canonical Jev wire shape: self-hosted Ollama (no key, `clef-flash`, 20 questions default, client-side state truncation on), freejev (server-pinned model, ≤ 16 questions, 128 KB body, mandatory `Idempotency-Key` header derived after redaction as content-hash + attempt so later retries are safe; documented 1 req/min caveat and 402-on-empty-balance behavior), and jev-direct (no client truncation — the API errors on oversize instead, 64k tok/req). Per-profile config knobs (model, maxQuestions, stateTokenBudget, truncateStateClientSide, confidenceFloor) select behavior; fail-open is client policy on every backend — any `ok:false` → native, no in-hook retry. Key setup docs cover the env-var conventions. Smoke-testing against the live freejev key respects the 1 req/min rate.

**Blocked by:** 02 — Decision pipeline in shadow mode (client contract + clef reference implementation); 05 — Privacy redaction (idempotency key derives from redacted content).

**Status:** ready-for-agent

- [ ] Switching `backend` config between clef/jev/ollama/jev-direct changes only the adapter; pipeline behavior and fail-open policy identical
- [ ] Ollama profile works against a local server with no key configured
- [ ] freejev requests carry the mandatory Idempotency-Key; repeated identical runs derive the same key after redaction, a retry attempt derives a fresh one
- [ ] freejev 402 (empty balance) and 429 (rate limit) → native, rung 1, no retry
- [ ] jev-direct oversize state → the API's 400 surfaces as a fallback rung (no client-side truncation on this profile)
- [ ] Per-profile confidenceFloor and maxQuestions take effect (a clef-calibrated floor doesn't leak into other profiles)
