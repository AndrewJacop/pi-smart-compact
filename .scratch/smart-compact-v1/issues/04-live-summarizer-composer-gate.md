# 04 — Live mode: targeted summarizer + composed document + reduction gate

**What to build:** `mode:"live"` replaces pi's LLM summary with the decision-driven composition. Only summarize-class units go to the LLM: the summarizer resolves its own auth off the session model (the `modelRegistry` auth path), reuses pi's exported summary-with-usage call, forwards the user's `/compact [focus]` instructions, and appends the standing scoping line so the summary knows the rest of the region survives verbatim alongside it. The composed document assembles in order: the previous compaction summary prepended untouched (verbatim head — keeps survive every compaction, never re-merged), the native-format LLM section (omitted when the summarize class is empty — all-keep costs zero LLM calls), the `## Kept verbatim` section of full serialized keep-blocks in region order (omitted when empty), then the native-parity read/modified file tags. The pairing repair leaves exactly one orphan shape — a surviving call whose result was dropped — which gets its single pseudo-serialization line; every other drop is silent in the document. The compaction entry carries `details` with read/modified file lists sourced from pi's own preparation fileOps (whole span, including dropped classes) plus the smart-compact run record. Region for decision and summary is `messagesToSummarize` ∪ the split-turn prefix messages as one union. The reduction gate (rung 4) measures the context delta — tokensBefore vs estimatedTokensAfter (composed summary + kept region) — and discards the composition for native when it misses `minReductionPct` (default 50, `0` disables); the same bar guards the all-keep re-trigger loop. Summarizer failure → native (rung 3, no salvage, no retry). Live toast: `kept X · summarized Y · dropped Z — A → B tok (−N%)`.

**Blocked by:** 02 — Decision pipeline in shadow mode. (For the fixture-sized regions of ticket 09, ticket 03's ladder is also required; this ticket is demoable on smaller regions without it.)

**Status:** ready-for-agent

- [ ] Live compact produces one persisted compaction entry (fromHook) whose document reads in order: verbatim head → LLM section → `## Kept verbatim` → file tags
- [ ] Only summarize-class units reach the LLM; `/compact [focus]` steers the summary; all-keep region → zero LLM calls
- [ ] Second compaction keeps the first document's keep-blocks verbatim inside the new head (no prose re-merge)
- [ ] Dropped result under a kept call shows the one orphan marker; no other drop traces in the document
- [ ] Entry `details` carry read/modified file lists covering the whole span (incl. dropped reads) + the run record
- [ ] Split-turn compaction summarizes the union (history + prefix) in one composed doc
- [ ] Composition missing minReductionPct → native entry, telemetry records rung 4; minReductionPct 0 disables the gate
- [ ] Summarizer auth failure/timeout → native (rung 3), no retry
- [ ] Empty classes omit their sections — no placeholders; live toast matches the spec format
