# 05 — Privacy redaction

**What to build:** The `privacy` axis (`"redacted"` default | `"full"`) scrubs egress text on both channels: the decision-request state AND the summary requests (the summarizer defaults to the session model, a remote LLM). Nothing is excluded from redaction — tool results and thinking still get asked and summarized, carrying redacted text; privacy never touches the matrix and there is no per-profile bypass. The pattern list is code, not config: OpenAI/TypeSafe-shaped keys, bearer/authorization headers, AWS access keys, `KEY=value` assignments for common credential names, PEM blocks — replaced by `[REDACTED]`. Pipeline order matters: redact BEFORE the idempotency-key content hash, so identical redacted content hashes identically. `full` passes everything verbatim. The README states the accepted trade-off honestly: pattern redaction is never complete; the user chose simplicity over exclusion guarantees. Telemetry is on-box JSONL and unaffected.

**Blocked by:** 02 — Decision pipeline in shadow mode; 04 — Live mode: targeted summarizer + composed document + reduction gate (both egress channels must exist).

**Status:** ready-for-agent

- [ ] Default (`redacted`): a seeded secret in a tool result reaches neither the decision state nor the summary request — both show `[REDACTED]`
- [ ] Each pattern class (API keys, bearer headers, AWS keys, credential env assignments, PEM blocks) is caught on both channels
- [ ] `privacy:"full"` sends verbatim text on both channels
- [ ] Idempotency-key content hashes are computed after redaction (same content, same hash, redacted or not)
- [ ] `privacy` never changes decisions' available actions or the matrix
