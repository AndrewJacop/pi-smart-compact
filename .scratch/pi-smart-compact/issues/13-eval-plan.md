# 13 — eval/benchmark plan for the spec's validation section
Type: grilling
Status: open
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
