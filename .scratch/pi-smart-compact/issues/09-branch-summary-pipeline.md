# 09 — branch summary pipeline
Type: grilling
Status: resolved
Assignee: pi session (grilling, claimed 2026-10-05)
Blocked by: 01

## Question
(HITL) How does the same decision pipeline map onto /tree branch summarization (`session_before_tree`: `entriesToSummarize`, no cut point, summary only used if `userWantsSummary`)? Decide whether v1 covers it with the full matrix or a reduced question set, and the UX when the user declines summarization.

## Answer
Resolved by grilling, 2026-10-05 (Andrew). The branch pipeline **is** the compaction pipeline — one code path, rung-for-rung identical, on pi's `session_before_tree` hook. Mechanics verified (ticket 01 + docs/compaction.md + types.d.ts:636,1104): the hook fires on every `/tree` navigation; `preparation.entriesToSummarize` = the abandoned branch's entries from old leaf back to `commonAncestorId`; a returned `summary` is used only when `userWantsSummary`; `{cancel}` cancels the *navigation* — never returned, same reasoning as ticket 08 (and more disruptive: it blocks the user's move).

### Semantics are gentler — same stakes, lower
There is no cut point: the abandoned branch stays in the session and navigable; the summary is *injected* into the new branch. "Drop" = omit from the injected summary; nothing vanishes from any live context path. This is why the full matrix is safe here without reduction.

### Same matrix, same defaults (one pipeline)
- **All six rows of ticket 07's matrix apply unchanged**, same v1 Safe defaults, same block-cluster unit splitting, same argmax∩subset + confidenceFloor → keep, same call-follows-result repair, same batching (≈1 decision request).
- **The whole ladder from ticket 08 applies rung-for-rung**: any pipeline failure → return `undefined` → pi's native branch summary (native branch summarization is itself an LLM call, so fail-open costs the same shape as compaction's). `minReductionPct` (default 50) gates here too — region → composed token math is identical. *(Amended by ticket 14, 2026-10-05: the gate measures the context delta, `tokensBefore` → `estimatedTokensAfter` — a region→composed ratio only equals it on first compaction, since the verbatim previous-summary head rides composed but not region.)*
- **Targeted summarizer gets branch-shaped `customInstructions`**: lean toward pi's own branch format (Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps) since the consumer is the new branch's context, not a compacted history. Composer/output format = whatever ticket 14 lands on, reused unchanged.
- **`label` override = `smart-compact`** on the produced `BranchSummaryEntry` so branch summaries are attributable at a glance.
- **`details` must carry pi's native file-list shape** (`readFiles`/`modifiedFiles`, docs/compaction.md branch-summary format): pi does NOT carry file lists across `fromHook` summaries — "extensions manage their own `details` format" — so without replicating the native extraction, cumulative file tracking silently breaks on the new branch. Extract file ops from the keep/summarize classes' tool calls into the native shape, alongside the standard run record. *(Amended by ticket 14, 2026-10-05: file ops come from pi's own `preparation.fileOps` — whole span, including dropped classes, native parity — instead of re-extraction; the native-shape-in-details decision stands, now unified with compaction as `{ readFiles, modifiedFiles, smartCompact }`.)*

### Decline UX — pure no-op
`userWantsSummary === false` → return `undefined` immediately: no decision call, no shadow run, no telemetry record, no toast, zero added latency. Any work would be invisible by definition; shadow-on-decline was rejected because it would tax every summary-free navigation with ~1–5s of decision latency and pollute ticket 12's calibration log with a second, structurally different region distribution. **The shadow/telemetry dataset stays compaction-only** — the distribution the thresholds actually gate.

### Surface parity
Same one-line toast as ticket 08 with a `[branch]` tag: `smart-compact [branch]: kept 4 · summarized 2 · dropped 6 — 18.2k → 1.1k tok (−94%)`; shadow branch runs prefix `[shadow][branch]`; fallbacks warn-level naming the rung. Same passive JSONL records (a `kind: "compact" \| "branch"` field distinguishes them; decline writes nothing). Same no-budget-knobs ruling.

### Surfaced
- Ticket 14 (output format) should note its composer is consumed by both hooks — no change to its question, just a constraint recorded here.
- No new tickets; no fog graduated.
