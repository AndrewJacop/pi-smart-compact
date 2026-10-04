# 07 — decision matrix shape and defaults
Type: grilling
Status: resolved
Assignee: pi session (grilling, 2026-10-05)
Blocked by: 04

## Question
(HITL) Design the configurable matrix with the user: axes = message types (user / assistant text / thinking / tool call / tool result / previous summary) x bounded actions (always-keep | decide(keep, summarize, drop) | always-drop); how probabilities + confidence map to actions and per-backend thresholds; the default matrix for v1; what is configurable vs hardcoded. Feed from ticket 04's inventory; sanity-check against spike results (06) if available.

## Answer
Resolved by grilling, 2026-10-05 (Andrew). Threshold *values* and calibration procedure stay with ticket 12; this ticket fixes the shape.

### Decision unit — split assistant turns
The unit a row decides is the **block-cluster**, not the message: an assistant turn splits into at most 3 units — its thinking block(s), its text, its tool-call group. User messages, tool-result messages, and the previous compaction summary are single units already. The ticket's six axes are literally the six matrix rows. pi's `serializeConversation` anatomy (`[Assistant thinking]` / `[Assistant]` / `[Assistant tool calls]` / `[Tool result]`) is the splitting guide; verbatim keeps compose from serialized block-clusters. Cost: ~1.5–2× more questions than message-level, but they batch in one request (spike: 15 msgs → 11 asked, p50 1.1s), and a huge thinking block can drop while its text keeps.

### Row shape — subset rows; singleton = pinned
`matrix: Record<UnitType, Action[]>` with `Action = "keep" | "summarize" | "drop"`. Length ≥ 2 = decide among that subset; length 1 = always-`x` pinned policy, never sent as a question; empty rows invalid. Spike-verified rationale: clef/optollm rejects a 1-candidate choice (2–26 enforced), and the forced-vs-askable partition cut the spike's questions 15 → 11.

### Pairing — call follows result
Tool-call and tool-result units get **independent questions**, then one hardcoded post-decision repair by destructiveness rank keep(0) < summarize(1) < drop(2):

```text
call := min(call, result)
```

A result never appears orphaned, a kept result can always show its call, and the repair costs at most one serialized call line. Matches fast-jev's precedent (keepResult ≥ t forces keepCall — ticket 04).

### v1 default matrix (Safe table)

| row | default | rationale |
| --- | --- | --- |
| `user` | `["keep"]` | never dropped by a model (both prior arts) |
| `previous-summary` | `["keep"]` | already distilled; dropping loses the most per token |
| unknown unit | `["keep"]` | fail-safe fallback |
| `assistant-text` | `["keep","summarize"]` | spike verdicts were keep-vs-summarize; drop too aggressive |
| `thinking` | `["summarize","drop"]` | ephemeral reasoning; summary only when it formed something durable (plans, decisions) |
| `tool-call` | `["keep","drop"]` | one serialized line — summarizing saves ~0 |
| `tool-result` | `["keep","summarize","drop"]` | bulk lives here; summarize is the middle path for logs/outputs |

All rows user-overridable; these are the shipped defaults.

### Probability + confidence → action
Per decide-question: `action = argmax(probabilities) ∩ row's allowed subset`; if `confidence < profile.confidenceFloor` → escalate to **keep** (do-nothing). Direction is hardcoded: uncertainty never becomes destructive. Shape matches ticket 12's measured finding — the decision is already the argmax; clef's confidences are bimodal (drops .57–.89, keeps/summarizes mostly <.15), so confidence can only be an *override trigger*, not the chooser, and one fixed threshold misfires across backends (clef keep .56 vs freejev summarize .03 on the same message). Floor values per backend profile = ticket 12's to calibrate.

### Configurable vs hardcoded
**Config (validated):** matrix rows; per-backend `confidenceFloor`; summarizer model (standing decision from charting).
**Code (v1):** call-follows-result repair; singleton = pinned; unknown → keep; low confidence → keep; question text + QUESTIONS_VERSION hash (ticket 04's invalidation pattern); unit splitting; per-decision reason strings in the log.
**Invalid config** → warn loudly, smart path off, native compaction. Never guess (pi-jev's ConfigError lesson adapted to our fail-open shape).

### Sanity vs spike (ticket 06)
- Single-action rows as policy, never questions — confirmed by the spike (friction note 1).
- Cross-backend keep/summarize divergence — confirms per-backend floors, feeds ticket 12.
- pi's 2k serialize cap bounds verbatim keeps of bulk results regardless — the summarize middle path stays valuable for gist-beyond-2k, feeds ticket 14.
- unknown → keep provides the escape hatch the inventory demands.

### Surfaced
- Graduated the map fog *targeted-summarizer output format* → ticket 14 (the summarize class is now bounded: assistant text + thinking + tool-result summaries).
- Created ticket 15 — assemble the hand-off spec (the map's destination had no producing ticket); blocked by all remaining open tickets.
