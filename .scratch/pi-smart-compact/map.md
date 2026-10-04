# pi-smart-compact — wayfinder map

Labels: wayfinder:map

## Destination

A validated, hand-off-ready **spec** for `pi-smart-compact`: a publishable pi extension in which a pluggable decision-model backend (Jev-shape: hosted Jev, Cloudflare Clef, self-hosted) classifies every compactable message — per a configurable message-type matrix — as **keep-verbatim / summarize / drop**, with a targeted, configurable LLM summarizing only the "summarize" class. Native pi triggers untouched; the same pipeline covers branch summaries. Validated by a thin prototype against real backends with measured numbers. Done = another agent or human can build the extension from the spec without re-deciding anything.

## Notes

- **Domain**: pi extension (TypeScript), pi >= 0.85. Local pi docs: `/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/` — `compaction.md` and `extensions.md` are the canon; prefer them over the web for pi behavior. Source: github.com/earendil-works/pi.
- **Hard constraint**: sessions are append-only; the kept region (`firstKeptEntryId` onward) always reaches the model verbatim. Decision power = (a) shape the summarized region, (b) move the cut point, (c) encode decisions inside the summary text. `session_before_compact` returning `{compaction}` fully replaces the native summary — no double compaction; returning nothing = native fallback.
- **Standing decisions (charting grill)**: native triggers only (no veto, no proactive prune, no extension-initiated compaction); pluggable Jev-shape backend (one wire format, per-provider envelope adapter, per-backend threshold profiles); decision scope = every message type behind a configurable type-x-action matrix; targeted-LLM summarizer, model configurable (default = session model); branch summaries in scope; publishable package in scope.
- **Skills**: HITL tickets -> /grilling + /domain-modeling; spike -> /prototype; library API facts -> context7-docs.
- **Credentials policy**: backends auth via env vars (`TYPESAFE_API_KEY`, Cloudflare account + Workers AI token); never committed, never printed; revocable. User supplies keys — see ticket 05.
- **Prior art** (studied at charting): `@lienat/pi-jev-compaction` (pre-filters tool pairs in the summarized region, keeps native summary), `pi-jev-compaction` unscoped (replaces summary with verbatim encoding; falls back on no key/small reduction/errors), `@riposta/pi-jev` (5-module decision layer; its prune works at tool_result, not compaction), upstream `fast-jev-compaction` (Claude Code plugin by tamaratran, MIT — origin of all three). **Jev** = TypeSafe "System One" decision model: `{model, state, questions}` -> answers with probability distributions + confidence; types `noul`/`choice`/`score`; <=20 questions/request; ~0.2s. **Clef** = Cloudflare open-weight Jev-compatible (`clef` 27B, `clef-flash` 9B; <=64 q/req; REST envelope wraps answers in `{success, errors, result}`; images supported, irrelevant here).

## Decisions so far

- (charting resolves no tickets — research in flight; this index grows as tickets close)

## Not yet specified

- Targeted-summarizer **output format**: reuse pi's structured compaction format vs custom; depends on how the matrix bounds the "summarize" class (ticket 07).
- **Calibration procedure** for per-backend thresholds — how probabilities transfer between Jev/Clef and what shadow-mode recalibration looks like; needs spike measurements (ticket 06).
- **Eval/benchmark plan** for the spec's validation section — what the building effort must measure to be faithful to the spec; graduates after the spike shows what is cheaply measurable.
- **Packaging/distribution details** — npm publish flow, `pi install` compatibility range, key-setup docs; graduates once the spike proves the extension shape.
- **Per-tool override rules** in the matrix (v1.x candidate — user deferred: msg-type matrix only for v1).
- **Privacy posture** — what state content may leave the box per backend (hosted Jev vs Clef vs self-hosted), redaction defaults; sharpens once backends are pinned.

## Out of scope

- **Proactive tool-result pruning** (a la @riporta prune at tool_result): ruled out at charting — trigger policy is native-only; revisit as a separate effort if compaction pressure proves insufficient.
- **Extension-initiated smart trigger** (decision model chooses WHEN to compact): ruled out at charting — v1 keeps pi's threshold/overflow/manual triggers; pi's ctx "controls for compaction" make a future effort possible.
- **Building the production extension**: this map produces the spec only; the build is the next effort, handed the spec.
