# 02 — decision backend matrix (Jev / Clef)
Type: research
Status: open
Blocked by:

## Question
Consolidate the exact client contract for both hosted backends into one comparison table the spec can cite: request/response schema, question types (`noul`/`choice`/`score`), limits (max questions/request, max state size, context window), auth setup, model ids + pricing, latency, rate limits, error codes / fail-open behavior.

Known at charting (verify, correct, fill gaps):
- Jev: POST `https://api.typesafe.ai/v1/systemone`, model `jev-latest` / `jev-1.13`, <=20 q/req, ~0.2s. Gaps: state size limit, pricing, rate limits, models list (jev-ai.org/docs/models/).
- Clef: POST `https://api.cloudflare.com/client/v4/accounts/<acct>/ai/run/@cf/cloudflare/clef` (or `-flash`), <=64 q/req, REST envelope `{success, errors, result}`, output unbilled, $0.24 / $0.09 per M input tokens, 65,536-token context. Gaps: account/token setup steps, rate limits.

Deliver: the table + a recommendation for the spec's `DecisionClient` interface and per-provider envelope adapters.
