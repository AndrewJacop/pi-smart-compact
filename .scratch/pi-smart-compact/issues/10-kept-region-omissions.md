# 10 — kept-region omissions: extend decision power beyond the summary?
Type: grilling
Status: resolved
Assignee: pi session (grilling, 2026-10-05)
Blocked by: 16

## Question
(HITL) Ticket 01 found that `context_edit` omission entries (`replacement: null`) let an extension drop even KEPT-region messages from model context — append-only, no history rewrite, applied via `turn_end`/`agent_before_settle` boundary drafts. That expands the decision model's reach beyond the summarized region, which charting had assumed was the limit.

### Direction set 2026-10-05 (Andrew) — decision deferred to after ticket 16
Andrew likes the omission idea, conditioned on a **configurable kept region**: the newest N messages are exempt from everything — not counted for compacting, never decided, never omitted, left as-is. "So we need to study how we can configure the kept region in our flow as well" → ticket **16 — kept-region control mechanics** (research) now verifies the mechanics (native cut-point math, moving `firstKeptEntryId`, a `keptMessages: N` clamp, omissions reachability). Once 16 reports, this ticket decides the actual v1 scope: omissions in/out, and what the kept-region config surface looks like.

## Answer
Resolved by grilling, 2026-10-05 (Andrew), on top of ticket 16's source-verified mechanics. **v1 ships the configurable kept region as a `keptMessages: N` clamp; kept-region omissions (the hiding mechanism) are a named v2 module, not v1.**

### v1 — `keptMessages: N` clamp (new: config)
The newest N messages are exempt from every decision: never asked as questions, never summarized, never dropped, never omitted — always verbatim, guaranteed. Implementation is pure cut-point movement on the hook we already use (synchronous, visible, one mechanism):

- **Clamp direction is cut-earlier-only** (keep MORE than pi chose). pi consumes our `firstKeptEntryId` verbatim with zero validation (agent-session.js:2181–2185/2474–2481); an unknown ID degenerates to keep-everything — a safe no-op, and it's where the clamp lands if N exceeds what the session can express.
- **Value semantics** (ticket 16 §3): unset = pi default (native `keepRecentTokens` token window, 20k default, user-configurable in settings.json — our clamp composes on top, it does not replace it); `N=0` = no-op, NOT "retain none" (the hook type can't express a null cut, so 0 must not be overloaded); **`N` ≥ session length → return `{cancel: true}`** — the one documented exception to ticket 08's never-cancel rule (config-edge, verified clean on all paths).
- Messages pulled into the kept region by the clamp are removed from the decision set before questioning and from summarizer input; pi recomputes `estimatedTokensAfter` itself, so the clamp adds no token math on our side.
- **Documented hazard** (ticket 16 §3): if summary + clamped region still exceeds the trigger threshold, compaction re-fires every turn (churn). The spec must warn on sizing N and note the interplay with `minReductionPct` (ticket 08) — both shrink what a single compaction can shed.
- The clamp subsumes pi's split-turn-prefix behavior (pi has no message-count floor today — token window only; ticket 16 §5).

### v2 — decision-driven kept-region omissions (named, not specified)
The spec carries one paragraph: `context_edit` omissions (`replacement: null`) can drop kept-region messages append-only, but are reachable ONLY via `turn_end`/`agent_before_settle` boundary drafts — an always-on, asynchronous, extension-initiated mechanism outside any compaction event (types.d.ts:1100–1103, 732–745; ticket 16 §4). Why v2: silent failure surface (no compaction moment, so the toast/ladder/telemetry surfaces don't apply), decision quality unvalidated on kept-region material, and omissions feed back edit-aware into every future token estimate and cut point. The v2 effort starts from branch `research/kept-region` (ticket 16's full note) and must respect the same `keptMessages` buffer — the buffer exempts from omissions too, by construction of "left as-is".

### Surfaced
- Ticket 08 amended: never-cancel rule gains its one documented exception (`keptMessages` N ≥ session length → cancel).
- No new tickets; no fog graduated. This closes the last architecture-shape question — remaining open: 11, 12, 13, 14, then 15 assembles the spec.

Decide with the user: should v1 (a) confine decisions to the summarized region only (simpler, synchronous, one hook), (b) also use omissions for retroactive drops of stale kept-region content (more powerful, asynchronous second mechanism, more failure modes), or (c) spec (a) for v1 and name (b) as a v2 module? Consider that omissions are edit-aware (token estimates, cut points, summaries all run on the projected context) and require pi >= 0.87.1.
