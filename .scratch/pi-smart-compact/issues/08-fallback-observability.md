# 08 — fallback policy + observability surface
Type: grilling
Status: resolved
Assignee: pi session (grilling, claimed 2026-10-05)
Blocked by:

## Question
(HITL) Decide: the fallback ladder when the backend fails (no key / timeout / malformed / too-small reduction) — which rungs return nothing (native summary) vs cancel; shadow mode semantics (log counterfactuals without changing behavior?) and whether v1 ships it; user-facing surface: status/trace commands, toasts, telemetry file format (pi-jev's `/jev explain|trace|stats` is the reference shape); budget/rate limiting of decision calls.

## Answer
Resolved by grilling, 2026-10-05 (Andrew). One rule for the whole ladder: **any pipeline failure → native compaction** (return `undefined`). `{cancel}` is **never** returned — a canceled compaction leaves the session over threshold, re-arming pi's trigger (loop risk), while native always shrinks something. Warn, log, fail open. *(One documented exception added by ticket 10: `keptMessages: N` ≥ session length → `{cancel: true}` is correct — config-edge, verified clean on all paths by ticket 16.)*

### The ladder, in run order

| # | rung | detection | response |
|---|---|---|---|
| 0 | no key | pre-flight, local (zero latency) | native; warn-once toast per session naming the env var; key re-checked every compaction so the smart path resumes automatically when it appears; no telemetry record (nothing ran) |
| 1 | transport — timeout / network / 429 / 5xx | fetch / HTTP status | native immediately; **no in-hook retry** — decision calls are cheap to redo at the next compaction, and a bounded failure beats an unbounded wait inside `/compact` (ticket 06: fallback already pays decision-failure + full native latency) |
| 2 | malformed response | per-unit parse | **per-unit salvage**: invalid/missing unit answers → that unit keeps (extends ticket 07's unknown→keep and low-confidence→keep); only a wholly unusable response (zero valid answers, wrong envelope) → native |
| 3 | summarizer failure | LLM call error/timeout | native; **no special salvage path** — composing without summaries would silently lose the gist of every summarize-class message, exactly the content native preserves; no retry (dominant-latency step, ~12s) |
| 4 | too-small reduction | post-compose token math | composed summary must beat `minReductionPct` (config, default **50**) or it is discarded → native; below the bar the native summary very likely does better (it summarizes everything, keeps nothing verbatim); default value feeds ticket 12 calibration |

Rate limiting is rung 1: a 429 is a transport failure → native; the next compaction retries naturally.

### Shadow mode — ships in v1

Config `mode: "live" \| "shadow" \| "off"`, default **live** (the spike validated the live path end-to-end with a SANE human pass). Shadow = run the decision call, log the counterfactual, return native — **decisions-only**: the summarizer is skipped, so a shadow compaction costs only the ~1–5s decision call. The shadow log is the calibration dataset (confidences per backend, class distribution, cross-backend divergence) that ticket 12 consumes. `off` = extension inert: no decision call, native compaction, no toasts, no records.

### User-facing surface — no commands

pi-jev's `/jev explain\|trace\|stats` trio is **dropped** (Andrew: no need). The surface is one line, always, after every compaction — an info toast right after compaction completes (pi's own compaction message can't be edited from an extension; the spike's `ctx.ui.notify` path is the mechanism):

- live success: `smart-compact: kept 7 · summarized 3 · dropped 5 — 42.4k → 0.9k tok (−97.8%)`
- shadow: `smart-compact [shadow]: would keep 6 · summarize 4 · drop 5 (−97%) — native ran`
- any fallback rung: warn-level `smart-compact: fell back to native (<rung>)`, e.g. `(decision timeout)`
- no-key: the once-per-session warn IS its line

### Telemetry — passive JSONL, both modes

One append-only JSONL file, one record per run, **identical schema live and shadow** (a `mode` field distinguishes): ts, backend, model, mode, per-unit decisions + confidences + reasons, class counts, fallback rung/error, reduction %, decision/summary latency, token usage. Path: `$PI_CODING_AGENT_DIR/smart-compact/telemetry.jsonl` (default `~/.pi/agent/...`; docs must state the env override). No rotation cap in v1 (~1–3 KB/record). No-key runs write nothing. The compaction entry's `details` also carries the same record (spike pattern) so per-session traces ride the session file. This file is ticket 12's raw input and ticket 13's eval ground truth.

### Budget / rate limiting — none in v1

Batching already bounds cost: block-clusters chunk by request-token budget (ticket 04) into ≈1 request per compaction (spike: 11 questions, one call, 2.6k input tok ≈ $1e-4 at jev's $0.042/M; clef 64 q/req). Units beyond the chunk cap default to keep. No spend caps, no request-count knobs, no per-backend rate metadata — a spend cap is speculative at four decimal places. The spec fixes the **idempotency key = content-hash + attempt** (spike friction note 2), making any later retry safe and server-side dedupable.

### Surfaced

- Ticket 12 scope grows: `minReductionPct` default (50) joins the per-backend calibration set alongside `confidenceFloor`; the shadow-mode JSONL is its procedure input. (Edited ticket 12.)
- No new tickets; no fog graduated — the map's remaining open tickets (11, 12, 13, 14, 15) are untouched by this decision.
