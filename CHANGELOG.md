# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-07

First release.

### Added

- Decision pipeline: block-cluster unit splitting → decision-matrix classification
  (keep-verbatim / summarize / drop) → targeted LLM summary of only the summarize class →
  composed document (previous summary + LLM section + kept-verbatim blocks + file tags).
- Pluggable decision backends on one Jev-shape wire adapter: `clef` (default, via the optollm
  gateway), `jev` (freejev, smoke-test rate limits), self-hosted `ollama`, and `jev-direct`.
- Configurable per-unit-type action matrix with per-backend profiles (`maxQuestions`,
  `stateTokenBudget`, `maxBodyBytes`, `confidenceFloor`, `decisionTimeoutMs`).
- Kept-region clamp: `keptMessages: N` exempts the newest N messages from every decision.
- Branch summaries ride the same pipeline (`session_before_tree`, labeled `smart-compact`).
- Fallback ladder: any pipeline failure (no key, transport, malformed response, summarizer
  failure, too-small reduction) falls back to pi's native compaction — never worse than native.
- Privacy: default pattern redaction on all egress (decision state + summarizer input);
  `privacy: "full"` opts into verbatim.
- Telemetry: append-only JSONL per run (mode, backend, stage, per-unit decisions with
  confidence/probabilities/reason, fallback rung, reduction, latency, usage) + a docs-only
  confidence-floor calibration recipe.
- Per-request prompt ceilings measured against real backends (clef model context ≈ 16.5k
  server-counted tokens; optollm 64 KiB body cap) with per-batch decision states so large
  regions decide every askable unit instead of silently keeping everything.

### Fixed

- §8.2 compaction toast now survives pi's post-compaction transcript rebuild and is visible
  in the TUI (previously fired and was immediately erased; RPC modes were unaffected).
- Large regions no longer starve the question budget: a 451-unit region now decides every
  askable unit across batches (regression-tested) instead of defaulting all of them to keep.
