# 10 — kept-region omissions: extend decision power beyond the summary?
Type: grilling
Status: open
Blocked by:

## Question
(HITL) Ticket 01 found that `context_edit` omission entries (`replacement: null`) let an extension drop even KEPT-region messages from model context — append-only, no history rewrite, applied via `turn_end`/`agent_before_settle` boundary drafts. That expands the decision model's reach beyond the summarized region, which charting had assumed was the limit.

Decide with the user: should v1 (a) confine decisions to the summarized region only (simpler, synchronous, one hook), (b) also use omissions for retroactive drops of stale kept-region content (more powerful, asynchronous second mechanism, more failure modes), or (c) spec (a) for v1 and name (b) as a v2 module? Consider that omissions are edit-aware (token estimates, cut points, summaries all run on the projected context) and require pi >= 0.87.1.
