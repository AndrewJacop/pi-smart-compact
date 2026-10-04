# 05 — backend credentials for the spike
Type: task
Status: open
Blocked by:

## Question
(HITL, user) Provide live credentials so ticket 06 can test both hosted backends:
1. Jev: create a TypeSafe API key (console.typesafe.ai/settings/keys), export `TYPESAFE_API_KEY` in the shell that launches pi.
2. Clef: from the firm's Cloudflare setup — account id + Workers AI API token (or whatever the firm announcement grants; record the exact grant shape). Export `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`.
3. Freejev (test-only): user holds a freejev API key — Jev-compatible, **rate-limited to 1 request/minute**, so suitable for the spike's smoke tests only, not for measured runs. At setup, record its base URL, model id, and export as `FREEJEV_API_KEY`; the spike's backend config must respect the 1 req/min budget (batch aggressively or stub the rest).

Rules: env vars only; never committed or printed; revocable keys. Resolved when both backends answer one test question from this machine.

## Comments

Update (post-research, ticket 02): **TypeSafe signups are currently paused** — the Jev key may be unobtainable right now. Your firm's Clef access is the critical path; record its exact grant shape. If neither hosted key materializes, ticket 03 found a no-key fallback: `ollama pull clef-flash` serves the native Jev API on `/v1/systemone` locally, enough to unblock ticket 06.

Update (user): a **freejev** API key is available for testing — Jev-compatible, 1 request/minute limit, testing only. Recorded as option 3 above; unblocks part of ticket 06 without waiting on TypeSafe or the firm grant.
