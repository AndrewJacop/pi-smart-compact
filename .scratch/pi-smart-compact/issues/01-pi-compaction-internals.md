# 01 — pi compaction internals verification
Type: research
Status: resolved
Blocked by:

## Question
From pi's actual source/types (not just docs): what exactly can an extension do at `session_before_compact`, and what guarantees can the spec build on?

Verify and record:
1. `SessionBeforeCompactEvent` / `SessionBeforeCompactResult` / `CompactionResult` exact shapes on the CURRENT published pi (docs target 0.85.1; check latest) — fields, `details`, `usage`, `fromHook` semantics.
2. Append-only: confirm no public API rewrites/deletes entries; what `context_edit` omissions can and cannot do (could omissions achieve "drop this kept message" without rewriting? that would change the architecture).
3. Does `ExtensionContext` expose compaction controls (trigger compaction programmatically)? Grep dist .d.ts.
4. `serializeConversation` / `convertToLlm` export shapes; the 2000-char tool-result truncation in serialization — configurable?
5. Which pi versions the spec should pin (compatibility range), given 0.85 -> 0.87+ drift.

Sources: local docs `/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/compaction.md` + `extensions.md`; installed dist types `/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/`; source github.com/earendil-works/pi (`packages/coding-agent/src/core/compaction/`).

## Answer
Verified against installed dist of **pi 1.0.2** (`pi --version` = latest published npm version; the ticket's 0.85.1 doc-target is stale). All file:line refs are `/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/...` unless noted; GitHub equivalents live under `packages/coding-agent/src/` of github.com/earendil-works/pi.

### 1. Exact shapes (current, 1.0.2)
`SessionBeforeCompactEvent` (core/extensions/types.d.ts:579): `type: "session_before_compact"`, `preparation: CompactionPreparation`, `branchEntries: SessionEntry[]`, `customInstructions?: string`, `reason: "manual" | "threshold" | "overflow"`, `willRetry: boolean`, `signal: AbortSignal`.
`SessionBeforeCompactResult` (types.d.ts:1100): `{ cancel?: boolean; compaction?: CompactionResult }`.
`CompactionResult<T = unknown>` (core/compaction/compaction.d.ts:18): `{ summary: string; firstKeptEntryId: string; tokensBefore: number; estimatedTokensAfter?: number; usage?: Usage; details?: T }`.
Runtime semantics (core/agent-session.js:2155–2210): `cancel: true` aborts compaction; returning `compaction` replaces pi's LLM summarization wholesale (summary, firstKeptEntryId, tokensBefore, usage, details are all taken from the extension) and the entry is persisted with `fromHook: true`.
`fromHook` semantics: optional bool on `CompactionEntry` (core/session-manager.d.ts:56; `SessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?, usage?)` at session-manager.d.ts:271). It means "this compaction came from an extension" — either via `session_before_compact` (`fromExtension=true`, agent-session.js:2197) or via an `agent_before_settle`/boundary compaction draft (always `true`, agent-session.js:586). One behavioral consequence: pi only inherits `details` file lists (readFiles/modifiedFiles) from **non-fromHook** compactions (core/compaction/compaction.js:21–32; comment says "fromHook field kept for session file compatibility"). SessionManager adds uuid/parentUuid on save (compaction.d.ts:138).

### 2. Append-only + context_edit omissions — YES, omissions can drop a kept message
- **Append-only confirmed.** SessionManager docs: "Entries cannot be modified or deleted" (core/session-manager.js:1105,1159); the only `_rewriteFile()` calls are header creation and version migration (session-manager.js:678,723,754). No public delete/rewrite API.
- **`ContextEditEntry`** (core/session-manager.d.ts:119–127): `{ type: "context_edit"; targetId: string; replacement: { content: ContextEditableContent } | null }`. Doc comment: "**Null omits the target from model context.** A value replaces only its content." Runtime: `projectContextEntry` returns `[]` when `replacement === null` (core/session-manager.js:239–241).
- **So yes — an extension can drop a KEPT message from model context without rewriting history**, via the boundary-draft API: a `turn_end` handler (`TurnEndEventResult = BoundaryResult`, types.d.ts:1048) or `agent_before_settle` handler returns `{ entries: [{ type: "context_edit", targetId, replacement: null }] }` (`SessionBoundaryDraft` includes `ContextEditEntryDraft`, types.d.ts:732–745); `_applyBoundaryDrafts` calls `appendContextEdit` (core/agent-session.js:570–592). pi itself uses exactly this for overflow recovery: "append context_edit omissions for the selected attempt" (docs/compaction.md:93).
- **Constraints that shape the architecture:**
  - Only projection changes; the raw JSONL entry survives ("Raw transcript history, exports, billing totals, and history-search extensions can still inspect the omitted attempt", docs/compaction.md:98). Undone by appending another context_edit with a value.
  - Applies only if `targetId` is on the **current context path** (post-latest-compaction kept range): edits are keyed from `buildContextEntries()` output (core/session-manager.js:261–267); pre-compaction edits are inert. Omitted entries contribute **nothing** to compaction either — `prepareCompaction` runs on `buildSessionProjection` (edit-aware), so omissions cut token estimates, cut point, and summary input (core/compaction/compaction.js:606–640).
  - One entry = all its projected messages (a message entry projects one message; roles user/assistant/toolResult/custom only). `appendContextEdit` validates only the replacement shape, not target existence (session-manager.js:962–994).
  - `ctx.sessionManager` is a **ReadonlySessionManager** (types.d.ts:225) — extensions canNOT call `appendContextEdit` directly; the boundary-draft returns are the only extension append path. `pi.appendEntry(customType, data)` (types.d.ts:1235) only makes non-context custom entries.

### 3. Compaction controls on ExtensionContext — YES
`ExtensionContext.compact(options?: CompactOptions): void` — "Trigger compaction without awaiting completion" (types.d.ts:249–250). `CompactOptions = { customInstructions?: string; onComplete?: (result: CompactionResult) => void; onError?: (error: Error) => void }` (types.d.ts:204–209). Also `ctx.getContextUsage(): ContextUsage | undefined` (types.d.ts:246) for threshold checks.

### 4. serializeConversation / convertToLlm; 2000-char truncation
- `serializeConversation(messages: Message[]): string` (core/compaction/utils.d.ts:37) — no options param. Truncation is `const TOOL_RESULT_MAX_CHARS = 2000` hardcoded (core/compaction/utils.js:82), replaced by `"[... N more characters truncated]"` (utils.js:91). **Not configurable** (docs/compaction.md:290 confirms).
- `convertToLlm(messages: AgentMessage[]): Message[]` (core/messages.d.ts:76) — maps `bashExecution` (skipping `excludeFromContext` ones) and `custom` roles to user messages with text content; used by agent prompt calls and `generateSummary`.
- Both exported from the package root (dist/index.d.ts:6,12). Docs example (compaction.md:308–343) shows the intended custom-summarization flow: `serializeConversation(convertToLlm(preparation.messagesToSummarize))`.

### 5. Version pinning
npm line: …0.85.1 → 0.86.x → 0.87.x → 0.99.0–0.99.2 → 1.0.0–1.0.2 (latest = 1.0.2, = installed here).
- Verified by tarball diff: `SessionBeforeCompactEvent` / `SessionBeforeCompactResult` / `CompactionResult` shapes are **byte-identical** 0.85.1 ↔ 1.0.2 — the hook API is stable.
- `ContextEditEntry` (with `replacement: null` omission) and `SessionBoundaryDraft`/`agent_before_settle` are **absent in 0.85.1**, present in **0.87.1** (same shape as 1.0.2).
- Recommendation: pin **`^1.0.2`**. If the spec leans on context_edit omissions, minimum supported is **0.87.1**; do not claim 0.85 compat for anything projection-related. Treat docs/compaction.md content about omissions/recovery ordering (lines 85–98, 138) as 0.99+/1.0 semantics.
