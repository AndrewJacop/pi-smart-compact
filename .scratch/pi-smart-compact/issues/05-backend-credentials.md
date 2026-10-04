# 05 — backend credentials for the spike
Type: task
Status: open
Blocked by:

## Question
(HITL, user) Provide live credentials so ticket 06 can test both hosted backends:
1. Jev: create a TypeSafe API key (console.typesafe.ai/settings/keys), export `TYPESAFE_API_KEY` in the shell that launches pi.
2. Clef: from the firm's Cloudflare setup — account id + Workers AI API token (or whatever the firm announcement grants; record the exact grant shape). Export `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`.

Rules: env vars only; never committed or printed; revocable keys. Resolved when both backends answer one test question from this machine.
