# 13 — eval/benchmark plan for the spec's validation section
Type: grilling
Status: resolved
Assignee: pi session (grilling, 2026-10-05)
Blocked by:

## Question
What must the building effort measure to be faithful to the spec, and what is the cheap harness? Write the spec's validation section.

The spike (ticket 06) proved what is cheaply measurable with ~100 lines of throwaway harness (branch `spike/thin-spike`):
- **Token reduction %**: region tokens (pi's `estimateTokens`) → composed summary tokens, per compaction run.
- **Decision latency**: p50/p95 from N standalone requests (`decide-probe.ts`) — in-run latency varies with cold start (4.8s first vs 1.1s steady for clef).
- **Decision sanity vs ground truth**: fixture with annotated expected classes + `sanity.ts` agreement table; human pass on the table (worked well in ticket 06 — ~10 minutes).
- **Fallback behavior**: injected fail-modes (auth/timeout/http500) asserted via session-file inspection (`fromHook` false + no spike details = native fallback).

Decide:
1. Which of these become REQUIRED validation steps in the spec vs optional/recommended.
2. Fixture requirements for the building effort: how many fixtures, what ground-truth annotation format, real vs synthetic transcripts.
3. Acceptance thresholds: minimum reduction %, maximum decision-latency budget, agreement floor — numbers the spec should pin (ticket 06's single-fixture numbers are calibration data, not acceptance levels).
4. Whether the harness itself ships with the extension (as a dev dependency) or stays throwaway.

## Answer

Resolved by grilling, 2026-10-05 (Andrew). The spec's Validation section is the lightest acceptance that still proves the three promises — shrink context, decide sanely, fail safe: three required gates, one fixture, prose-only procedure.

### 1. Required gates: 3 of the 4 spike measurements; latency recorded, ungated

**Required**: token reduction %, decision sanity vs ground truth, fallback fail-open. **Decision latency is recorded but gates nothing** — it's backend-owned (decision p50 1.1s vs the ~12s summarizer that dominates `/compact`), the 2–5s per-call timeout already bounds it, and slowness degrades gracefully through the fallback gate; a latency acceptance would validate the backend, not the extension.

### 2. Fixture: the spike's single 40k fixture IS the validation set

No size ladder, no synthetic build-out, no real transcripts (Andrew chose minimal over the 3-fixture proposal). The fixture (~15-message region, ~42k tokens, per-unit ground-truth classes) lives on `spike/thin-spike` (`spike/fixture.ts`). Consequence the spec must state honestly: acceptance numbers are single-fixture facts, not distribution claims — same stance as ticket 12's floor values. The prose must describe the fixture precisely enough to rebuild (region shape, size, per-unit expected class) with the spike branch linked as the reference asset.

### 3. Acceptance thresholds (per backend, default matrix, on that fixture)

- **Reduction: region→composed ≥ 80%** (measured 97.8 clef / 98.0 freejev; ~18pp headroom absorbs matrix and composer tweaks — e.g. ticket 14's verbatim-keep head growth — without flapping acceptance, while staying far above the 50% runtime gate).
- **Sanity: wrong-drop = 0, hard.** Every ground-truth drop must be dropped (both backends already 5/5); any drop of a keep/summarize-annotated unit fails unless the ~10-minute human pass explicitly blesses it (the spike's "small passing-test output kept — defensible" precedent). Keep↔summarize confusion is reported, not fatal.
- **Fallback: 3/3 injected fail-modes → native** (auth 401, injected timeout, http500), asserted spike-style: persisted entry has `fromHook: false` and no smart-compact details.
- **Latency: p50/p95 per decision request recorded in the spec** as documentation numbers; no gate.

### 4. Harness: throwaway, prose-only

The spec describes the validation procedure in prose — the four measurements, the thresholds, the RPC-driven headless run (ticket 06 friction note 6) — and the builder writes their own ~100-line harness. Nothing ships: not in the package (ticket 12's no-user-tooling stance) and not as repo dev scripts (Andrew rejected that middle option). The spec links `spike/thin-spike` as the working reference implementation.

Surfaced: no new tickets, no fog graduated. The validation prose itself lands in ticket 15 (assemble-spec), which this resolution unblocks.
