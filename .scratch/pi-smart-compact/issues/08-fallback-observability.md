# 08 — fallback policy + observability surface
Type: grilling
Status: open
Blocked by:

## Question
(HITL) Decide: the fallback ladder when the backend fails (no key / timeout / malformed / too-small reduction) — which rungs return nothing (native summary) vs cancel; shadow mode semantics (log counterfactuals without changing behavior?) and whether v1 ships it; user-facing surface: status/trace commands, toasts, telemetry file format (pi-jev's `/jev explain|trace|stats` is the reference shape); budget/rate limiting of decision calls.
