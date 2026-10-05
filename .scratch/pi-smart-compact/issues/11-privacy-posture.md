# 11 — privacy posture per backend
Type: grilling
Status: resolved
Assignee: pi session (grilling, 2026-10-04)
Blocked by:

## Question
Backends are now pinned (ticket 05): freejev-hosted Jev, firm optollm gateway serving clef, Ollama-local fallback. Decide the spec's privacy posture (HITL): what conversation state may leave the box per backend tier (hosted freejev / firm gateway / local Ollama), what the default redaction profile is before decision requests are sent, and whether/how the message-type matrix (ticket 07) can mark message types as local-only. Context: freejev's docs already warn inference is remote (OpenRouter/TypeSafe) — avoid secrets and sensitive data; the firm gateway keeps state on firm infrastructure; Ollama keeps everything on-box (ticket 03 made a "local-only" profile cheap to promise).

## Answer
Resolved by grilling, 2026-10-04 (Andrew). The "per backend" framing dissolved in questioning: the posture is **one orthogonal config axis, independent of backend choice** — no tiers, no coupling, no pairing validation. Simple as that.

### Decisions
1. **Enforced config, two values**: `privacy: "full" | "redacted"`, **default `"redacted"`**. The filter is code-enforced — within a profile there is no bypass flag; choosing `full` is the only way to send verbatim (hard gate, simplified shape).
2. **`redacted` (default)**: simple secret-pattern redaction applied to ALL egress text on **both channels** — decision-request state AND summary requests (which matters because the summarizer defaults to the session model, a remote LLM). Nothing excluded: tool results and thinking still get asked and summarized, carrying redacted text. One-line guarantee: whatever leaves the box is redacted.
3. **`full`**: verbatim egress, both channels.
4. **Matrix unchanged** (ticket 07's shape stands): no `local-only` row concept, no per-class exclusion — privacy never reaches the matrix. Per-class control, if ever truly needed, is a clean v2 addition that doesn't break the shape.

### Pattern list (code, not config — judgment in code per ticket 07's split)
Small fixed set in v1: OpenAI/TypeSafe-shaped keys (`sk-…`), bearer/authorization headers, AWS access keys, `KEY=value` env assignments for common credential names, PEM blocks. Replacement: `[REDACTED]`. Extending the list = PRs, not config. **Ticket 15 folds the exact list into the spec.** Pipeline order note: redact BEFORE the idempotency-key content hash, so identical content hashes identically.

### Accepted trade-off, stated honestly
Remote backend + `redacted` keeps full compaction power (the bulk still shrinks) at redacted-fidelity privacy — pattern redaction is never complete (obfuscated keys, base64 blobs, non-key-shaped credentials slip through). The user chose this simplicity over exclusion guarantees knowingly.

### Consequences
- Telemetry (ticket 08) records decisions locally in on-box JSONL — unaffected.
- No new tickets, no fog graduated: this answer exposed no further dependent questions; ticket 15 picks up the pattern list.
- No tickets invalidated: 07 (matrix), 08 (telemetry), 14 (summary output format) all stand unchanged.
