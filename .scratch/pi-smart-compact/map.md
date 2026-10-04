# pi-smart-compact — wayfinder map

Labels: wayfinder:map

## Destination

A validated, hand-off-ready **spec** for `pi-smart-compact`: a publishable pi extension in which a pluggable decision-model backend (Jev-shape: hosted Jev, Cloudflare Clef, self-hosted) classifies every compactable message — per a configurable message-type matrix — as **keep-verbatim / summarize / drop**, with a targeted, configurable LLM summarizing only the "summarize" class. Native pi triggers untouched; the same pipeline covers branch summaries. Validated by a thin prototype against real backends with measured numbers. Done = another agent or human can build the extension from the spec without re-deciding anything.

## Notes

- **Domain**: pi extension (TypeScript), pi ^1.0.2 (context_edit omissions need >= 0.87.1; compaction-hook API identical 0.85.1<->1.0.2 — see ticket 01). Local pi docs: `/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/` — `compaction.md` and `extensions.md` are the canon; prefer them over the web for pi behavior. Source: github.com/earendil-works/pi.
- **Hard constraint**: sessions are append-only; the kept region (`firstKeptEntryId` onward) always reaches the model verbatim. Decision power = (a) shape the summarized region, (b) move the cut point, (c) encode decisions inside the summary text. `session_before_compact` returning `{compaction}` fully replaces the native summary — no double compaction; returning nothing = native fallback.
- **Standing decisions (charting grill)**: native triggers only (no veto, no proactive prune, no extension-initiated compaction); pluggable Jev-shape backend (one wire format, per-provider envelope adapter, per-backend threshold profiles); decision scope = every message type behind a configurable type-x-action matrix; targeted-LLM summarizer, model configurable (default = session model); branch summaries in scope; publishable package in scope.
- **Skills**: HITL tickets -> /grilling + /domain-modeling; spike -> /prototype; library API facts -> context7-docs.
- **Credentials policy**: backends auth via env vars (`TYPESAFE_API_KEY`, Cloudflare account + Workers AI token); never committed, never printed; revocable. User supplies keys — see ticket 05.
- **Verified mechanics** (research, see tickets): `ctx.compact()` exists (fire-and-forget) on ExtensionContext; `serializeConversation` truncates tool results at a hardcoded 2000 chars; TypeSafe signups currently paused — Clef-flash is the zero-friction hosted default, Ollama self-host needs no key.
- **Prior art** (studied at charting): `@lienat/pi-jev-compaction` (pre-filters tool pairs in the summarized region, keeps native summary), `pi-jev-compaction` unscoped (replaces summary with verbatim encoding; falls back on no key/small reduction/errors), `@riposta/pi-jev` (5-module decision layer; its prune works at tool_result, not compaction), upstream `fast-jev-compaction` (Claude Code plugin by tamaratran, MIT — origin of all three). **Jev** = TypeSafe "System One" decision model: `{model, state, questions}` -> answers with probability distributions + confidence; types `noul`/`choice`/`score`; <=20 questions/request; ~0.2s. **Clef** = Cloudflare open-weight Jev-compatible (`clef` 27B, `clef-flash` 9B; <=64 q/req; REST envelope wraps answers in `{success, errors, result}`; images supported, irrelevant here).

## Decisions so far

- [pi compaction internals verification](issues/01-pi-compaction-internals.md) — on pi 1.0.2 the hook result `{cancel?, compaction?}` fully replaces the native summary (persists `fromHook: true`); `context_edit` omissions CAN drop kept messages from context append-only (architecture-expanding); `ctx.compact()` exists; pin ^1.0.2.
- [decision backend matrix (Jev / Clef)](issues/02-decision-backend-matrix.md) — one wire shape, tiny per-provider adapters; `jev-1.13.0` $0.042/M input (official API has NO 20-question cap; signups paused), clef/clef-flash 64 q/req $0.24/$0.09, Clef truncates over-limit state while Jev errors; recommend `DecisionClient.decide()` + fail-open to native.
- [self-hosted Clef serving](issues/03-clef-selfhost-serving.md) — realistic: Ollama serves clef/clef-flash natively on `/v1/systemone` (one command, 11–18 GB); transformers needs a ~20-line adapter; vLLM/generic endpoints cannot reproduce the decision head; Q4 GGUF fits 8–24 GB GPUs (accuracy unverified).
- [question design inventory](issues/04-question-design-inventory.md) — proven patterns: ask call and result separately; noul for branches, score for spectra, choice for escape-hatch paths; 8-stage state-fitting ladder to 25k tokens; batch by request-token budget; uncertainty -> do-nothing; thresholds + QUESTIONS_VERSION-style invalidation live in config.

## Not yet specified

- Targeted-summarizer **output format**: reuse pi's structured compaction format vs custom; depends on how the matrix bounds the "summarize" class (ticket 07).
- **Calibration procedure** for per-backend thresholds — how probabilities transfer between Jev/Clef and what shadow-mode recalibration looks like; needs spike measurements (ticket 06).
- **Eval/benchmark plan** for the spec's validation section — what the building effort must measure to be faithful to the spec; graduates after the spike shows what is cheaply measurable.
- **Packaging/distribution details** — npm publish flow, `pi install` compatibility range, key-setup docs; graduates once the spike proves the extension shape.
- **Per-tool override rules** in the matrix (v1.x candidate — user deferred: msg-type matrix only for v1).
- **Privacy posture** — what state content may leave the box per backend (hosted Jev vs Clef vs self-hosted), redaction defaults; sharpens once backends are pinned. Self-hosting is now proven cheap (Ollama, ticket 03), which makes a "local-only" profile a real option to design for.

## Out of scope

- **Proactive tool-result pruning** (a la @riporta prune at tool_result): ruled out at charting — trigger policy is native-only; revisit as a separate effort if compaction pressure proves insufficient.
- **Extension-initiated smart trigger** (decision model chooses WHEN to compact): ruled out at charting — v1 keeps pi's threshold/overflow/manual triggers. Research later verified `ctx.compact()` makes it feasible — a clean future effort, still out of scope here.
- **Building the production extension**: this map produces the spec only; the build is the next effort, handed the spec.
