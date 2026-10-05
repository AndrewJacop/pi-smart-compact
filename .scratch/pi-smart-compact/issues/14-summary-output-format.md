# 14 — summarizer output format
Type: grilling
Status: resolved
Assignee: pi session (grilling, 2026-10-05)
Blocked by: 07

## Question
(HITL) The targeted summarizer compresses only the summarize class — now bounded by ticket 07 to assistant text + thinking + tool-result summaries. Decide the composed compaction's output format: reuse pi's structured native compaction format vs the spike's custom sections (decisions header / summary / kept-verbatim blocks / dropped-tombstones) vs something between. Constraints from the spike: verbatim keeps dominate summary size (1.0k → 3.0k tok when keeps became full blocks); `serializeConversation` caps tool results at 2000 chars, so a verbatim keep of bulk output is bounded anyway; drop tombstones bought auditability. Feed from ticket 04's format observations and the spike's composed-summary code (`spike/extension.ts`, branch `spike/thin-spike`).

Constraint added by ticket 09: the composer is consumed by BOTH hooks (`session_before_compact` and `session_before_tree`) — same output format on both paths, only the summarizer's `customInstructions` differs (branch-shaped). Branch summaries' `details` additionally carry pi's native readFiles/modifiedFiles shape.

## Answer
Resolved by grilling, 2026-10-05 (Andrew). **Hybrid composer**, identical on both hooks. Key fact discovered: the spike's LLM section was *already* in pi's native format — `generateSummaryWithUsage`'s built-in `SUMMARIZATION_PROMPT` emits the exact Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context structure, and the spike's custom text only rode along as "Additional focus:". So the real decision was what the composer wraps around a free native-shaped section.

### Composed summary skeleton (in order)
1. **Verbatim head** — the previous compaction summary, prepended untouched (omitted on first compaction).
2. **LLM section** — native-format summary over the summarize class only; omitted (no LLM call) when that class is empty.
3. **`## Kept verbatim`** — full serialized keep-blocks in region order, raw lines (no fences), orphan markers inline; omitted when empty. Per-block bulk stays bounded by `serializeConversation`'s 2k tool-result cap (spike friction 3) — "verbatim keep" means "keep pi's canonical serialization".
4. **`<read-files>` / `<modified-files>` tags** — appended, native parity.

Rejected: **pure native** (everything through the LLM paraphrases keeps — breaks the product) and **spike-as-is** (the `## Decisions` header and every-drop tombstones are auditability that ticket 08's surfaces already own — JSONL per-decision reasons, `details` run record, outcome toast — while summary text rides *every turn's context* until the next compaction: recurring token tax, near-zero model-facing value).

### Previous summary — verbatim head, never UPDATE-merged
composed-N+1 = doc-N + new LLM section + new keeps. Keeps survive verbatim across compactions; zero extra LLM work; honors the `previous-summary: ["keep"]` pin ("already distilled"). Deliberately *not* pi's UPDATE prompt (`previousSummary` param): a merge rewrites doc-N's keep-blocks as prose — keeps would die at the second compaction.
Growth is monotone; the guard is existing: once the head makes compaction unattractive, `minReductionPct` fails the rung → native fallback, whose merge semantics collapse the doc. That's the equilibrium.
Branch path already behaves this way mechanically (old branch summaries inside the span project as user-role → pinned keep → land in keeps). No special casing.

**Consequence for the reduction gate (amends ticket 09's letter; feeds 15):** the gate measures the *context delta* (`tokensBefore` → `estimatedTokensAfter`), not a region→composed ratio — the head rides composed but not region, so the ratio only equals the delta on first compaction. Spike's `estimatedTokensAfter` formula stands unchanged.

### Drop markers — orphan-only
The pairing repair (`call := min(call, result)`) leaves exactly one orphan shape: a surviving call whose result was dropped. That call's serialized block gets one pseudo-serialization line directly under it:

```text
[Assistant tool calls]: bash(cmd="npm test")
[Tool result dropped: 4,812 chars — re-run the command if needed]
```

Model-facing value (explains the missing result, states the recovery path — ticket 04's fast-jev precedent). Every other drop is silent: the LLM section or nothing covers it; telemetry logs each decision with its reason.

### Summarizer call
`generateSummaryWithUsage(summarizeMsgs, …)` with:
- a standing scoping line appended: *"Summarize only the messages above; the rest of the region is preserved verbatim alongside this summary."* (the LLM sees only its slice; without this it pads Goal with invented context);
- `event.customInstructions` forwarded (so `/compact [focus]` still focuses the summary);
- no `previousSummary` param (the head owns iteration). The spike's ad-hoc instruction is retired.

### details (both hooks)
`{ readFiles: string[], modifiedFiles: string[], smartCompact: <run record> }` — ticket 09's native file-list shape plus ticket 08's run record; carries the spike's `details.spike` practice. File lists are sourced from pi's own **`preparation.fileOps`** (whole span, including dropped classes — a file whose read was dropped still matters; native parity) rather than re-extraction from keep/summarize classes.

### Branch path
Same composer, byte-identical output format (09's constraint). The branch shape (no Critical Context) rides the branch-shaped `customInstructions` exactly as 09 recorded — `generateSummaryWithUsage` has no prompt-replacement param (only `generateBranchSummary` does, via `replaceInstructions`, but it takes entries, which would erase block-level decisions within assistant turns). The branch directive appends as the "Additional focus" and states the section list explicitly.

### Split turns (`isSplitTurn`)
Region := `messagesToSummarize` ∪ `turnPrefixMessages`; one composed doc over the union. pi's history/prefix two-summary split is native-internal merge mechanics and does not bind the hook. Supersedes the spike's bail-to-native on split turns.

### Edges
Empty classes → sections omitted, never placeholders. All-drop → LLM section only. All-keep → keeps + tags, zero LLM calls (the `minReductionPct` loop guard from ticket 12 catches the oversized-all-keep case). No summarize class and no keeps cannot co-occur with a passing gate.

### Surfaced
- Graduated the map fog *packaging/distribution* → ticket 17 (its trigger — "once the extension shape is settled" — is now true; this was the last shape decision before assembly).
- Ticket 09 amended: file ops from `preparation.fileOps` (whole span); reduction gate reads context delta.
- No other tickets; remaining fog (per-tool matrix overrides) is a deferred v1.x candidate, untouched.
