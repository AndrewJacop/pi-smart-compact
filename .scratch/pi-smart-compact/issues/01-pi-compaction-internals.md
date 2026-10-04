# 01 — pi compaction internals verification
Type: research
Status: open
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
