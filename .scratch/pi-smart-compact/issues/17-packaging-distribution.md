# 17 — packaging and distribution
Type: grilling
Status: open
Blocked by:

## Question
(HITL) The extension shape is settled (tickets 07–14); the spec needs its publishing shell. Decide with the user:
1. **Package name** on npm (working title `pi-smart-compact` — check availability/collision; naming convention vs the prior arts: `@lienat/pi-jev-compaction`, `pi-jev-compaction`, `@riposta/pi-jev`).
2. **Install + compatibility range** — `pi install` invocation for the README; claimed range (research pinned ^1.0.2; context_edit needs ≥ 0.87.1 but v1 uses the `keptMessages` clamp + hooks, all 1.0.2 — confirm what we claim).
3. **Config surface and discovery** — where config lives (pi settings.json vs the extension's own file under `$PI_CODING_AGENT_DIR`), the keys it reads (matrix, per-backend profiles incl. `confidenceFloor`, `mode: live|shadow|off`, `privacy`, `minReductionPct`, summarizer model, `questions` file override per ticket 12), validation behavior (ticket 07: invalid config → warn loud, native fallback), and how docs present `questions.default.json` overriding.
4. **Backend key setup docs** — from ticket 05: env vars via gitignored `.env.local` (`FREEJEV_API_KEY`, `OPTOLLM_API_KEY`), per-backend base URLs/model ids, the freejev 1 req/min caveat, Ollama no-key fallback.
5. **README skeleton** for the hand-off spec (what ticket 15 assembles into it).

Output = the packaging/distribution section of ticket 15's spec. No pipeline decisions belong here.

## Answer
