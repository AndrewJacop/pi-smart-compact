# 07 — decision matrix shape and defaults
Type: grilling
Status: open
Blocked by: 04

## Question
(HITL) Design the configurable matrix with the user: axes = message types (user / assistant text / thinking / tool call / tool result / previous summary) x bounded actions (always-keep | decide(keep, summarize, drop) | always-drop); how probabilities + confidence map to actions and per-backend thresholds; the default matrix for v1; what is configurable vs hardcoded. Feed from ticket 04's inventory; sanity-check against spike results (06) if available.
