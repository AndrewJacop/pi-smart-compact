# 04 — question design inventory
Type: research
Status: open
Blocked by:

## Question
How do existing implementations phrase compaction decisions to Jev? Inventory the actual question sets, types, batching, and probability thresholds of:
1. `fast-jev-compaction` (github.com/tamaratran/fast-jev-compaction) — the origin: reportedly two `noul` questions per tool call (keep call / keep full result), keepThreshold 0.5, state fitting stages, truncateHeadChars 300.
2. `@riposta/pi-jev` `src/questions.ts` (jsdelivr: https://cdn.jsdelivr.net/npm/@riposta/pi-jev@0.2.3/src/questions.ts) + `config.ts` thresholds — note the QUESTIONS_VERSION cache-invalidation pattern.
3. `clef-router` (pypi) — prompt -> tier choice questions.

Deliver: reusable patterns for per-message-type keep/summarize/drop questions (what to ask per msg type, how to batch, how thresholds map to actions), ready to feed ticket 07.
