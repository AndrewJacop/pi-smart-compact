# 02 — Decision pipeline in shadow mode

**What to build:** In `mode:"shadow"`, every compaction runs the real decision pipeline and then returns native — logging the counterfactual. The region splits into block-cluster decision units (assistant turns → thinking / text / tool-call group; user, tool-result, previous-summary are single units; six unit types with stable ids). Units are partitioned per the matrix: length-1 rows are pinned policy (never asked, incl. unknown → keep); length ≥ 2 rows become choice questions whose candidates are the row's allowed subset, text from the bundled default question set, overridable by the global user questions file (validated: known ids, candidate counts within backend caps; malformed → loud warn, smart path off). One shared state per request: orientation string + recent user prompts as goal + whole region with bulky content replaced by size notes, questions referencing unit ids. The clef (optollm gateway) profile runs with a 5 s per-call timeout and client-side state truncation. Answers map via argmax∩row-subject with the confidence floor escalating to keep; per-decision reason strings are recorded; tool-call/tool-result pairs repaired by `call := min(call, result)` by destructiveness rank.

Shadow runs write a telemetry JSONL record (identical schema to future live) — ts, kind, mode, backend, model, stage, units w/ confidence/probabilities/reason, classCounts, fallback, reductionPct, latencyMs, usage — and show the `[shadow]` toast (`would keep X · summarize Y · drop Z (−N%) — native ran`). Fallback rungs 0–2 are live: no key (rung 0), transport errors/429/5xx → native immediately, no in-hook retry (rung 1), malformed response → per-unit salvage to keep, wholly unusable → native (rung 2). Oversize state that can't fit yet → native (the state-fitting ladder is ticket 03).

**Blocked by:** 01 — Skeleton: package + hooks + config validation + fail-open shell.

**Status:** ready-for-agent

- [ ] Shadow compact on a small session: native entry persists, `[shadow]` toast shows counts + reduction, telemetry record written with units/classCounts/latency/usage
- [ ] Assistant turns split into thinking/text/tool-call units; unknown unit types classify keep (pinned), never asked
- [ ] Pinned rows and user/previous-summary/unknown never appear as questions; decidable rows ask exactly their row's subset
- [ ] User questions.json override loads and validates; malformed override → loud warn + native
- [ ] Confidence below floor → keep, with a recorded reason string; decisions carry argmax∩subset reasons
- [ ] Pairing repair: a dropped result forces its call out of keep; no orphan results
- [ ] Injected auth failure / timeout / HTTP 500 → native compaction, telemetry records the rung; no retry inside the hook
- [ ] Partial garbage response → invalid units keep, valid ones survive (per-unit salvage)
