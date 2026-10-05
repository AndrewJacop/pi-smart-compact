# 06 — Kept region: `keptMessages` clamp

**What to build:** The `keptMessages: N` knob exempts the newest N messages from every decision — never asked, never summarized, never dropped, always verbatim. Pure cut-point movement on the existing hook: the effective cut clamps cut-earlier-only (keep MORE than pi chose — min of pi's token window and the Nth-newest-message boundary); the hook's `firstKeptEntryId` is consumed verbatim, and an unknown id safely degenerates to keep-everything. Value semantics: unset = pi default behavior (the clamp composes on top of pi's keepRecentTokens window, doesn't replace it); `N=0` is a no-op, not "retain none"; `N` ≥ session length returns `{cancel:true}` — the one documented exception to the never-cancel rule, verified clean on both manual (throws "Compaction cancelled") and auto (returns false) paths. The clamp subsumes pi's split-turn-prefix behavior for the kept tail. The README's kept-region section documents the churn hazard (summary + clamped region still over threshold → compaction re-fires every turn) and its interplay with `minReductionPct`.

**Blocked by:** 04 — Live mode: targeted summarizer + composed document + reduction gate.

**Status:** ready-for-agent

- [ ] With `keptMessages: N`, the newest N messages appear verbatim in the composed doc's kept region and were never sent as questions (verifiable in telemetry units)
- [ ] The clamp only ever keeps MORE than pi's own cut; no message pi would keep gets dropped
- [ ] Unset knob → byte-identical behavior to ticket 04's live mode
- [ ] `N=0` → no-op; `N` ≥ session length → compaction cancelled cleanly (manual + auto paths, no entry persisted)
- [ ] Summary + kept region under the trigger threshold → no re-fire loop on a normal session
