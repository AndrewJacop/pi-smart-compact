# 14 — summarizer output format
Type: grilling
Status: open
Blocked by: 07

## Question
(HITL) The targeted summarizer compresses only the summarize class — now bounded by ticket 07 to assistant text + thinking + tool-result summaries. Decide the composed compaction's output format: reuse pi's structured native compaction format vs the spike's custom sections (decisions header / summary / kept-verbatim blocks / dropped-tombstones) vs something between. Constraints from the spike: verbatim keeps dominate summary size (1.0k → 3.0k tok when keeps became full blocks); `serializeConversation` caps tool results at 2000 chars, so a verbatim keep of bulk output is bounded anyway; drop tombstones bought auditability. Feed from ticket 04's format observations and the spike's composed-summary code (`spike/extension.ts`, branch `spike/thin-spike`).

Constraint added by ticket 09: the composer is consumed by BOTH hooks (`session_before_compact` and `session_before_tree`) — same output format on both paths, only the summarizer's `customInstructions` differs (branch-shaped). Branch summaries' `details` additionally carry pi's native readFiles/modifiedFiles shape.
