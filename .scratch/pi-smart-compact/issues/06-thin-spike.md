# 06 — thin spike: decision-driven compaction end-to-end
Type: prototype
Status: open
Blocked by: 01, 02, 05

## Question
Raise fidelity: a minimal pi extension (`-e` loaded) that on `session_before_compact` (1) serializes the region, (2) asks a Jev-shape backend keep/drop/summarize per message per a naive matrix, (3) returns a custom compaction (verbatim encoding + one targeted LLM summary call for summarize-class). Run on a fixture transcript against BOTH hosted backends. Measure: token reduction %, decision latency, decision sanity vs a human pass, fallback behavior on injected failures. Prototype code is throwaway; numbers + friction notes feed the spec. Use /prototype skill.
