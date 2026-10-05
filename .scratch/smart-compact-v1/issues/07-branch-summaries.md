# 07 — Branch summaries (`session_before_tree`)

**What to build:** `/tree` navigation summaries run the same pipeline as compaction — one code path, rung-for-rung identical: same matrix and defaults, same unit splitting, same argmax+floor, same pairing repair, same batching and ladder. "Drop" omits from the injected summary only (no cut point; the abandoned branch stays navigable), so the full matrix is safe here without reduction, and `minReductionPct` still gates on the context delta. The summarizer receives branch-shaped focus instructions — lean toward pi's native branch format (Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps) since the consumer is the new branch's context, appended as the "Additional focus" stating the section list explicitly, never swapping out pi's whole prompt. The produced summary carries `label: "smart-compact"` and the same `details` shape as compaction. Decline UX is a pure no-op: `userWantsSummary === false` → return undefined immediately — no decision call, no shadow run, no telemetry record, no toast (the telemetry dataset stays compaction-only). Toast gains a `[branch]` tag (`[shadow][branch]` in shadow); JSONL records carry `kind: "branch"`. `{cancel}` is never returned from this hook.

**Blocked by:** 04 — Live mode: targeted summarizer + composed document + reduction gate.

**Status:** ready-for-agent

- [ ] Tree navigation with summary requested → branch summary produced by the same pipeline, labeled `smart-compact`, with details file lists
- [ ] Decline (`userWantsSummary === false`) → instant undefined: no decision call, no shadow log entry, no telemetry record, no toast
- [ ] Shadow-mode tree navigation → `[shadow][branch]` toast, `kind:"branch"` telemetry record
- [ ] Dropped units appear in neither the injected summary nor its LLM input, yet the abandoned branch remains fully navigable
- [ ] Branch summary reads in pi's native branch format with the smart-compact focus appended, not a replaced prompt
- [ ] Every fallback rung behaves identically to compaction (fail-open to pi's native branch summary)
