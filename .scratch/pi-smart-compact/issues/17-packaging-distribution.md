# 17 — packaging and distribution
Type: grilling
Status: resolved
Assignee: pi session (grilling, claimed 2026-10-05)
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

1. **Package name: `@andrewjacop/pi-smart-compact`** (npm scope `andrewjacop`). The bare working title is **taken** — `pi-smart-compact` on npm is an unrelated active package (v10.1.4 "Pi Continuity" by alpertarhan, same domain: pi context hygiene/compaction); `pi-jev-compact` is also taken. Scoped keeps the working title and is collision-free. Verified available under the scope decision (scope-gated, not name-gated).
2. **Install + compatibility**: `pi install npm:@andrewjacop/pi-smart-compact`. README claims **"Requires pi ≥ 1.0.2"** flat (research pin; v1 uses only 1.0.2-verified features — compaction hook, `keptMessages` clamp, branch-summary hook). Host-provided pi goes in `peerDependencies` as `"*"` per pi's packaging docs, so the compat claim is README text, not the npm range.
3. **Config surface** — two homes, clean split:
   - **Knobs** (matrix, backend profiles incl. `confidenceFloor`, `mode: live|shadow|off`, `privacy`, `minReductionPct`, summarizer model) live under a **`smartCompact` key in pi settings.json** — user-level `~/.pi/agent/settings.json` + project-level `.pi/settings.json`, merged free via `pi.getSettings()`. Per-project matrices/profiles therefore work. pi ignores unknown keys; the extension validates its own and **invalid config fails loud to native** (ticket 07).
   - **Question text** stays **out of settings.json**: the package ships bundled `questions.default.json`; the user override is a **separate file, global only**: `$PI_CODING_AGENT_DIR/smart-compact/questions.json`. Rationale (user decision): keeps long question text out of settings; overrides are global anyway — no project layering needed, no discovery rule beyond the one fixed path. Shares the dir with telemetry (`$PI_CODING_AGENT_DIR/smart-compact/telemetry.jsonl`, ticket 08).
4. **Backend key setup docs**: no new decision — spec assembles from ticket 05: env vars via gitignored `.env.local` (`FREEJEV_API_KEY`, `OPTOLLM_API_KEY`), per-backend base URLs/model ids, freejev hard 1 req/min caveat (smoke tests only), Ollama self-host no-key fallback; rotate keys after the spike.
5. **README skeleton** (problem-first, titled `@andrewjacop/pi-smart-compact`): 1. What it is (decision-model compaction, pluggable backend) · 2. Quickstart (install → key setup → minimal config) · 3. Configuration reference (matrix, profiles, mode, privacy, thresholds, questions.json) · 4. How decisions work (unit splitting → questions → argmax+floor) · 5. Backends (Jev / Clef / Ollama: keys, rate limits, privacy) · 6. Summaries & kept region (output format, `keptMessages` clamp) · 7. Fallback & observability (ladder, toast, telemetry.jsonl) · 8. Branch summaries · 9. Eval results (3 gates, spike numbers) · 10. Limitations & v2 (kept-region omissions).
