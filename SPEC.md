# SPEC — @andrewjacop/pi-smart-compact

A pi extension in which a pluggable decision-model backend classifies every compactable message as **keep-verbatim / summarize / drop**, per a configurable message-type matrix, and a targeted LLM summarizes only the "summarize" class. Native pi triggers untouched; the same pipeline covers branch summaries.

This document is the complete build spec. It was assembled from the resolved tickets of the [pi-smart-compact wayfinder map](.scratch/pi-smart-compact/map.md) (tickets 01–17); every decision cited below is already made — the builder's job is execution plus the validation gates in §12, not re-design. Where a number came from measurement, the measurement is named. Throwaway reference implementation: branch `spike/thin-spike`.

---

## 1. What it is

- One pi extension, npm package **`@andrewjacop/pi-smart-compact`**.
- On every compaction (and every branch summarization), the extension replaces pi's native LLM summary with a **decision-driven composition**: a decision backend (Jev-shape: hosted Jev, Cloudflare Clef via a gateway, or self-hosted Ollama Clef) classifies each unit of the summarized region; the newest N messages are exempt; only "summarize"-classified units go to an LLM; everything "keep" survives verbatim inside the composed summary.
- Any pipeline failure falls back to pi's native compaction. The extension never makes compaction worse than native; it either does its job or gets out of the way.
- Validated by the thin spike: **clef −97.8% / freejev −98.0%** region reduction on a 42k-token fixture, decisions human-passed SANE, 3/3 injected failures fell back to native.

## 2. Architecture and hook contract

**Platform: pi ^1.0.2** (README claims flat "Requires pi ≥ 1.0.2"). All mechanics below are verified against installed pi 1.0.2 dist (ticket 01; kept-region mechanics ticket 16 — full note on branch `research/kept-region`).

### 2.1 Sessions are append-only — the three levers

No public API rewrites or deletes session entries. Decision power is exactly:

1. **Shape the summarized region** (what the decision matrix is for),
2. **Move the cut point** (`firstKeptEntryId` — the `keptMessages` clamp, §7),
3. **Encode decisions inside the summary text** (the composed document, §6).

### 2.2 `session_before_compact`

Event fields used: `preparation` (with `messagesToSummarize`, `firstKeptEntryId`, `settings`, `fileOps`), `customInstructions?`, `reason`, `signal`. Returning `{compaction}` **fully replaces** pi's LLM summarization — no double compaction; the entry persists with `fromHook: true`. Returning `undefined` = native fallback. `CompactionResult = { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter?, usage?, details? }`.

- pi consumes `firstKeptEntryId` **verbatim, zero validation**; an unknown id degenerates to keep-everything (safe). Cut-earlier (keep MORE) is the safe direction; pi recomputes `estimatedTokensAfter` itself post-append (our value is informational — but it is what the reduction gate reads, §6.6).
- pi only inherits `details` file lists from **non-fromHook** compactions — the extension must supply them (§6.5).

### 2.3 `session_before_tree`

Fires on every `/tree` navigation; `preparation.entriesToSummarize` = abandoned branch back to `commonAncestorId`; a returned summary is used only when `userWantsSummary`. `{cancel}` would cancel the *navigation* — **never returned** (same reasoning as the fallback ladder, §8). The branch pipeline is the compaction pipeline — see §9.

### 2.4 Summarizer plumbing (spike-verified, ticket 06 friction 4)

No LLM API exists on `ExtensionContext`. The targeted summarizer resolves auth itself:

- `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` (narrow the `{ok:false}` union; filter null header values);
- reuse pi's exported **`generateSummaryWithUsage`** (accepts a message subset + `customInstructions`).

Decision-backend auth: plain env vars (§5.4); `ctx.modelRegistry.getApiKeyAndHeaders` is not involved.

## 3. Decision pipeline

Per compaction: **split → exempt → partition → ask → map → repair → compose**.

### 3.1 Decision unit — the block-cluster

An assistant turn splits into at most 3 units: its **thinking block(s)**, its **text**, its **tool-call group**. User messages, tool-result messages, and the previous compaction summary are single units. Six unit types = the six matrix rows (§4). pi's `serializeConversation` anatomy (`[Assistant thinking]` / `[Assistant]` / `[Assistant tool calls]` / `[Tool result]`) is the splitting guide. Cost: ~1.5–2× more questions than message-level, but they batch into ≈1 request (spike: 15 msgs → 11 asked, p50 1.1s).

### 3.2 Kept-region exemption

Remove the newest `keptMessages` messages (§7) from the decision set **before** questioning and from summarizer input.

### 3.3 Partition: forced vs askable

A matrix row of length 1 is **pinned policy** — never sent as a question (clef/optollm rejects 1-candidate choices: 2–26 enforced). Length ≥ 2 = decide among that subset. Unknown unit types → keep (pinned).

### 3.4 State and question batching

- **One shared state** per request, oldest first: an orientation string stating the task and the recovery path ("a coding assistant conversation is being compacted… whatever is not kept is summarized or dropped, but the assistant can always re-run a tool or re-read a file"), plus recent user prompts as goal, plus the whole region with every candidate's bulky content replaced by a size note (`ok, 4213 chars (omitted)`). Questions reference units by stable id (`u_{entryId}`, `u_{entryId}_think|_text|_call`).
- **State-fitting ladder** (fast-jev's 8 stages, ticket 04 — cheapest first, each applied only if the previous didn't fit `maxStateTokens` 25k): full → inputs 1000→200→60 → abridge long texts (head 400 + tail 150, oldest first) → collapse old message text → one-line old call summaries → leave out old call-less messages → merge old call-runs → throw (→ native). Never degrade pinned/recent items. **Record the stage used in telemetry** — calibration data must know what context the decisions saw.
- Token budgets via pi's `estimateTokens` (chars/4). Chunk units so `state + questions` fits the per-request token budget (§5 profiles); the **same state is resent with every batch**, batches run concurrently, answers merge by question id. Units beyond the chunk cap default to **keep**.

### 3.5 Probability → action

Per decide-question (a `choice` whose candidates are the row's allowed actions):

```text
action = argmax(probabilities) ∩ row's allowed subset
if confidence < profile.confidenceFloor → action = keep   (uncertainty never becomes destructive)
```

Confidence is an **override trigger, not the chooser** — measured fact (ticket 12): clef's confidence encodes class identity (bimodal), not graded uncertainty. Per-decision reason strings are recorded (`"dropped: drop 0.81"`, `"kept: floor 0.1 > confidence 0.03"`, `"kept: pinned policy"`).

### 3.6 Pairing repair — call follows result

Tool-call and tool-result units get independent questions, then one hardcoded post-decision repair by destructiveness rank `keep(0) < summarize(1) < drop(2)`:

```text
call := min(call, result)
```

A result never appears orphaned; a kept result can always show its call; cost ≤ one serialized call line. This leaves exactly **one orphan shape** for the composer (§6.4).

### 3.7 `serializeConversation` bounds

`serializeConversation` truncates tool results at a **hardcoded 2000 chars** (not configurable). Consequences: "verbatim keep" means "keep pi's canonical serialization" (bulk results are bounded at 2k); verbatim keeps still dominate summary size (spike: 1.0k → 3.0k tok when keeps became full blocks) — the `minReductionPct` gate guards this (§6.6).

## 4. The matrix and v1 defaults

**Config (validated):** matrix rows, per-backend profiles incl. `confidenceFloor`, `mode`, `privacy`, `minReductionPct`, summarizer model, questions file (§5.3).
**Code (v1):** call-follows-result repair; singleton = pinned; unknown → keep; low confidence → keep; unit splitting; state ladder; per-decision reason strings; redaction patterns (§10).

`matrix: Record<UnitType, Action[]>`, `Action = "keep" | "summarize" | "drop"`. Length ≥ 2 = decide among the subset; length 1 = pinned; empty = invalid.

**v1 defaults (the Safe table):**

| row | default | rationale |
| --- | --- | --- |
| `user` | `["keep"]` | never dropped by a model |
| `previous-summary` | `["keep"]` | already distilled; dropping loses the most per token |
| unknown unit | `["keep"]` | fail-safe fallback |
| `assistant-text` | `["keep","summarize"]` | drop too aggressive for prose |
| `thinking` | `["summarize","drop"]` | ephemeral; summarize only when it formed something durable |
| `tool-call` | `["keep","drop"]` | one serialized line — summarizing saves ~0 |
| `tool-result` | `["keep","summarize","drop"]` | bulk lives here; summarize is the middle path |

**Invalid config fails loud to native** — warn, smart path off, never guess.

## 5. Backends and adapters

### 5.1 Wire format

The Jev "System One" shape is the canonical internal wire format (both hosted backends already speak it): request `{ state, model, questions: Record<id, Question> }`; answers keyed by id (`choice → {type, choice, probabilities, confidence}`), plus `usage {input_tokens, output_tokens}`. Clef always bills input only (`output_tokens: 0` — prefill-only decision head).

Internal contract:

```ts
interface DecisionClient {
  decide(req: { state: unknown; questions: Record<string, Question> }): Promise<DecisionBatch>
}
type DecisionBatch =
  | { ok: true; answers: Record<string, Answer>; model: string; inputTokens: number }
  | { ok: false; error: DecisionError }
interface DecisionError {
  kind: 'auth' | 'rate_limit' | 'input_too_large' | 'overloaded' | 'network' | 'timeout' | 'other'
  retryable: boolean; retryAfterMs?: number; providerCode?: string
}
```

Transport: `@typesafe-ai/sdk` with a custom `fetch` works for both providers (Clef path verified; unwrap envelope, rewrite URL, pass token as `apiKey`); plain `fetch` is an acceptable substitute — the wire is trivial.

### 5.2 Shipped profiles

| profile | endpoint | model | questions/req | notes |
| --- | --- | --- | --- | --- |
| `clef` (default, via optollm gateway) | `https://optollm.optomatica.com/v1/systemone` | `clef` | 64 schema cap; **optollm enforces 2–26 choice candidates** | decision API only, never the chat endpoint; probabilities are estimates |
| `jev` (freejev) | `https://freejev.org/api/v1/decisions` | pinned server-side (`typesafe/jev-1.13-20260917`) | ≤ 16; 128 KB body | **hard 1 req/min on this key** — smoke tests only; **`Idempotency-Key` mandatory** (§8.4); 402 on empty balance |
| `ollama` (self-host fallback) | `http://localhost:11434/v1/systemone` | `clef-flash` | 20 default | no key; `ollama pull clef-flash` (11 GB); quantized accuracy unverified |
| `jev` direct (first-class-when-keyed) | `https://api.typesafe.ai/v1/systemone` | `jev-1.13.0` | no documented cap (64k tok/req; 32k state+longest question; oversize → 400, never truncated) | TypeSafe signups currently paused |

Per-profile config: `{ model, maxQuestions, stateTokenBudget, truncateStateClientSide, confidenceFloor }`. `truncateStateClientSide: true` for Clef-family (Clef silently truncates over-limit state — pre-trim so decisions never see partial state; Jev errors instead).

**Fail-open is client policy on every backend:** any `ok:false` → native (§8). Per-call decision timeout: **5 s** default (decided range 2–5 s; SDK default 10 s is too slow inside `/compact`). **No in-hook retry** — decisions are cheap to redo at the next compaction.

### 5.3 Where each knob lives

- Knobs (matrix, profiles incl. `confidenceFloor`, `mode: "live"|"shadow"|"off"`, `privacy`, `minReductionPct`, summarizer model, `decisionTimeoutMs`) under a **`smartCompact` key in pi settings.json** (user `~/.pi/agent/settings.json` + project `.pi/settings.json`, merged via `pi.getSettings()` — per-project matrices work). pi ignores unknown keys; the extension validates its own; invalid → loud warn + native.
- Question text (§5.5) ships bundled as `questions.default.json`; user override is a separate file, **global only**: `$PI_CODING_AGENT_DIR/smart-compact/questions.json`. Validated on known question ids + candidate counts within backend caps; malformed → loud warn, smart path off.

### 5.4 Key setup (docs)

Env vars via a gitignored `.env.local` sourced before launching pi: `OPTOLLM_API_KEY` (clef), `FREEJEV_API_KEY` (jev, 1 req/min caveat), `TYPESAFE_API_KEY` (jev-direct), none for Ollama. Never commit or print keys. (Spike keys were rotated post-spike.)

### 5.5 Default question set (`questions.default.json`)

One `choice` question per decidable unit; candidates = the row's allowed subset (so the matrix alone defines what gets asked); instructions are static — **no untrusted content is ever interpolated**; decision-relevant metadata rides inline; every set carries the size hint for results. Draft (derived from ticket 04's verified phrasing patterns; wording is user-overridable config by design):

```json
{
  "tool-call":   { "type": "choice",
    "instructions": "Tool call {id} ({tool}) {input}: should it stay in the compacted history? Knowing this call was made, with its input, still matters for what the assistant does next." },
  "tool-result": { "type": "choice",
    "instructions": "The {resultChars}-char output of tool call {id} ({tool}): keep it verbatim, summarize it, or drop it? Re-running the tool can recover it; weigh the cost of losing the contents against the tokens it occupies." },
  "assistant-text": { "type": "choice",
    "instructions": "This assistant message: keep it verbatim or summarize it? Weigh whether its exact wording still matters for what the assistant does next." },
  "thinking":    { "type": "choice",
    "instructions": "This assistant thinking block: summarize or drop it? Keep (as a summary) only what formed something durable — plans, decisions, findings — not ephemeral reasoning." }
}
```

(`{id}`, `{tool}`, `{input}`, `{resultChars}` are template slots filled per unit before the wire; a filled question must stay within backend caps.) Escalation rules (unknown → keep, floor → keep) are code, not question text.

## 6. Targeted summarizer and the composed document

### 6.1 Scope

The LLM sees **only the summarize class** — bounded by the default matrix to assistant-text summaries, thinking summaries, and tool-result summaries.

### 6.2 The call

`generateSummaryWithUsage(summarizeMsgs, …)` with:

- a standing scoping line appended: *"Summarize only the messages above; the rest of the region is preserved verbatim alongside this summary."* (without it the LLM pads Goal with invented context);
- `event.customInstructions` forwarded (so `/compact [focus]` still focuses the summary);
- **no `previousSummary` param** — the head owns iteration (§6.3).

The built-in `SUMMARIZATION_PROMPT` emits pi's native structure (Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context) — no custom prompt needed. Summarizer model: config, **default = the session model**. Measured cost: ~12 s — the dominant `/compact` latency term.

### 6.3 Composed document — hybrid composer, in order

1. **Verbatim head** — the previous compaction summary, prepended untouched (omitted on first compaction). Keeps survive every compaction; never UPDATE-merged (a merge would rewrite doc-N's keep-blocks as prose — keeps would die at the second compaction).
2. **LLM section** — the native-format summary over the summarize class; omitted (no LLM call) when that class is empty.
3. **`## Kept verbatim`** — full serialized keep-blocks in region order, raw lines (no fences); omitted when empty. Per-block bulk bounded by the 2k serialize cap.
4. **`<read-files>` / `<modified-files>` tags** — appended, native parity.

Growth is monotone by design; the guard is the reduction gate below — once the head makes compaction unattractive, the gate fails the rung and native (whose merge semantics collapse the doc) takes over. That is the equilibrium.

### 6.4 Drop markers — orphan-only

The pairing repair (`call := min(call, result)`) leaves exactly one orphan shape: a surviving call whose result was dropped. That call's block gets one pseudo-serialization line directly under it:

```text
[Assistant tool calls]: bash(cmd="npm test")
[Tool result dropped: 4,812 chars — re-run the command if needed]
```

Every other drop is **silent** in the document — auditability lives in telemetry and `details`, not in a recurring per-turn token tax (the spike's `## Decisions` header and tombstones were rejected for exactly that reason).

### 6.5 `details` (both hooks)

```ts
{ readFiles: string[], modifiedFiles: string[], smartCompact: <run record — §8.4> }
```

File lists are sourced from pi's own **`preparation.fileOps`** (whole span, including dropped classes — a file whose read was dropped still matters), because pi does not carry file lists across `fromHook` summaries.

### 6.6 Reduction gate (rung 4)

The gate measures the **context delta** — `tokensBefore` → our `estimatedTokensAfter` (= estimateTokens(composed summary) + estimateTokens(kept region)) — **not** a region→composed ratio: the verbatim head rides composed but not region, so the ratio only equals the delta on first compaction. Below `minReductionPct` → discard, go native. The gate doubles as the **re-trigger loop guard** (§7 hazard, §8 rung 4).

### 6.7 Split turns

Region := `messagesToSummarize` ∪ `turnPrefixMessages`; one composed doc over the union. pi's history/prefix two-summary split is native-internal merge mechanics and does not bind the hook. (Supersedes the spike's bail-to-native on split turns.)

### 6.8 Edges

Empty classes → sections omitted, never placeholders. All-drop → LLM section only. All-keep → keeps + tags, zero LLM calls (the reduction gate catches the oversized-all-keep case). No summarize class and no keeps cannot co-occur with a passing gate.

## 7. Kept region — `keptMessages: N`

The newest N messages are exempt from every decision: never asked, never summarized, never dropped, never omitted — always verbatim, guaranteed. Pure cut-point movement on the hook we already use.

- **Clamp direction is cut-earlier-only** (keep MORE than pi chose): effective cut = min(pi's `keepRecentTokens` window, Nth-newest-message boundary). `firstKeptEntryId` consumed verbatim; unknown id = safe keep-everything; pi recomputes `estimatedTokensAfter` itself — the clamp adds no token math on our side.
- **Value semantics**: **unset** = pi default (native `keepRecentTokens` token window, 20k default, user-configurable — the clamp composes on top, does not replace it). **`N=0`** = no-op, NOT "retain none" (the hook type can't express a null cut). **`N` ≥ session length → return `{cancel: true}`** — the one documented exception to the never-cancel rule (config-edge, verified clean on all paths: manual throws "Compaction cancelled", auto returns false; no entry either way).
- The clamp strictly subsumes pi's split-turn-prefix behavior (pi has no message-count floor today; its prefix messages are summarized, not verbatim — our full-span summary replaces the prefix-merge).
- **Documented hazard**: if summary + clamped region still exceeds the trigger threshold, compaction re-fires every turn (churn). Size N so summary + N fits below the threshold; the interplay with `minReductionPct` (both shrink what one compaction can shed) goes in the README's kept-region section.

**v2 (named, not specified in v1)**: decision-driven kept-region omissions. `context_edit` entries (`replacement: null`) can drop kept-region messages append-only, but are reachable ONLY via `turn_end`/`agent_before_settle` boundary drafts — an always-on, asynchronous mechanism outside any compaction event, with a silent failure surface (no compaction moment → no toast/ladder/telemetry), unvalidated decision quality on kept material, and edit-aware feedback into every future token estimate. The v2 effort starts from branch `research/kept-region` and must respect the same `keptMessages` buffer.

## 8. Fallback ladder and observability

**The one rule: any pipeline failure → native compaction (return `undefined`).** `{cancel}` is never returned — except the `keptMessages` N ≥ session edge (§7). A canceled compaction leaves the session over threshold and re-arms pi's trigger (loop); native always shrinks something. Warn, log, fail open.

| # | rung | detection | response |
|---|---|---|---|
| 0 | no key | pre-flight, local (zero latency) | native; **warn-once per session** naming the env var; re-checked every compaction so the smart path resumes automatically; no telemetry record |
| 1 | transport (timeout / network / 429 / 5xx) | fetch / HTTP status | native immediately; **no in-hook retry** |
| 2 | malformed response | per-unit parse | **per-unit salvage**: invalid/missing unit answers → that unit keeps; only a wholly unusable response (zero valid answers, wrong envelope) → native |
| 3 | summarizer failure | LLM error/timeout | native; no salvage (composing without summaries would lose the gist of exactly the content native preserves); no retry (~12 s dominant-latency step) |
| 4 | too-small reduction | post-compose context delta (§6.6) | composed summary must beat `minReductionPct` (default **50**, shared, **`0` disables**) or → native; the bar also guards the all-keep re-trigger loop |

Rate limiting is rung 1: a 429 → native; the next compaction retries naturally.

### 8.1 Shadow mode — ships in v1

`mode: "live" | "shadow" | "off"`, default **live**. Shadow = run the decision call, log the counterfactual, return native — **decisions-only** (summarizer skipped; a shadow run costs ~1–5 s). The shadow log is the calibration dataset (§8.5). `off` = inert: no decision call, native compaction, no toasts, no records.

### 8.2 User-facing surface — no commands

No `/smart-compact explain|trace|stats` (dropped by decision). One line per run, via `ctx.ui.notify` right after compaction:

- live: `smart-compact: kept 7 · summarized 3 · dropped 5 — 42.4k → 0.9k tok (−97.8%)`
- shadow: `smart-compact [shadow]: would keep 6 · summarize 4 · drop 5 (−97%) — native ran`
- fallback: warn-level `smart-compact: fell back to native (<rung>)` — e.g. `(decision timeout)`
- no-key: the once-per-session warn IS its line

### 8.3 No budget knobs

Batching bounds cost to ≈1 request/compaction (spike: 11 questions, one call, 2.6k input tok ≈ $1e-4). No spend caps, no request-count knobs — a spend cap is speculative at four decimal places.

### 8.4 Telemetry — passive JSONL, both modes

One append-only JSONL file, one record per run, **identical schema live and shadow**:

```jsonc
// $PI_CODING_AGENT_DIR/smart-compact/telemetry.jsonl
{
  "ts": "…", "kind": "compact",        // "compact" | "branch"
  "mode": "live",                       // "live" | "shadow"
  "backend": "clef", "model": "clef",
  "stage": "inputs<=200",               // state-fitting stage used
  "units": [ { "id": "u_a1b2_call", "type": "tool-call", "action": "drop",
               "confidence": 0.81, "probabilities": {"keep":0.05,"drop":0.81},
               "reason": "dropped: drop 0.81" } ],
  "classCounts": { "keep": 7, "summarize": 3, "drop": 5 },
  "fallback": { "rung": null, "error": null },
  "reductionPct": 97.8,
  "latencyMs": { "decision": 1100, "summary": 11900 },
  "usage": { "decisionInputTokens": 2618, "summaryInputTokens": 0, "summaryOutputTokens": 0 }
}
```

Path: `$PI_CODING_AGENT_DIR/smart-compact/telemetry.jsonl` (docs must state the env override). No rotation cap in v1 (~1–3 KB/record). No-key runs write nothing. `userWantsSummary=false` writes nothing (§9). **Idempotency key = content-hash + attempt** — derived AFTER redaction (§10) so identical redacted content hashes identically; freejev requires the header, and it makes any later retry safe.

### 8.5 Calibration (docs-only recipe, no tooling ships)

`confidenceFloor` ships shared at **0.1** ("escalate only when the backend is guessing"); per-backend override in config; per-backend *values* are earned from shadow telemetry, never shipped. Confidences provably do not transfer across backends (same unit: clef keep 0.557 vs freejev summarize 0.03) — each profile calibrates its own; no cross-backend borrowing.

1. Run `mode: "shadow"` until the log has ≥ 50 decisions.
2. jq one-liner: same backend, bucket confidence by chosen class.
3. Read the bands: `floor := (min of drop band) − ε` — or leave 0.1 if bands overlap.
4. Set it, keep shadowing, confirm escalation rate ≈ 0 on non-garbage decisions.

**Fresh-log rule**: changed the questions (edit or extension upgrade)? rotate the log first (`mv telemetry.jsonl telemetry.prev.jsonl`). This replaces QUESTIONS_VERSION hash stamping (dropped — the set is small and stable; mixed-era floors are caught by step 4). `minReductionPct` stays 50 shared — per-backend was data-rejected (backend moved reduction 0.2 pp; the driver is matrix × transcript). Recalibrate only if telemetry ever shows a nonzero below-bar rate.

## 9. Branch summaries

The branch pipeline **is** the compaction pipeline on `session_before_tree` — one code path, rung-for-rung identical:

- Same matrix, same v1 defaults, same block-cluster splitting, same argmax∩subset + floor, same call-follows-result, same batching, same ladder. "Drop" = omit from the injected summary only — no cut point; the abandoned branch stays navigable, so the full matrix is safe here without reduction.
- `minReductionPct` gates here too; the gate reads the context delta (§6.6).
- Summarizer gets **branch-shaped `customInstructions`**: lean toward pi's native branch format (Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps) since the consumer is the new branch's context; the directive appends as the "Additional focus" and states the section list explicitly. (No `replaceInstructions`-style swap: the branch-summary variant takes whole entries and would erase block-level decisions.)
- **`label: "smart-compact"`** on the produced summary so branch summaries are attributable.
- **`details`** = the same `{ readFiles, modifiedFiles, smartCompact }` shape (§6.5).
- **Decline UX — pure no-op**: `userWantsSummary === false` → return `undefined` immediately: no decision call, no shadow run, no telemetry record, no toast. The telemetry dataset stays compaction-only — the distribution the thresholds actually gate.
- Same toast with a `[branch]` tag (`[shadow][branch]` in shadow); JSONL records carry `kind: "branch"`.

## 10. Privacy

One orthogonal config axis, independent of backend choice: **`privacy: "full" | "redacted"`, default `"redacted"`**. Code-enforced; within a profile there is no bypass flag.

- **`redacted` (default)**: simple secret-pattern redaction on **ALL egress text, both channels** — decision-request state AND summary requests (the summarizer defaults to the session model, a remote LLM). Nothing is excluded: tool results and thinking still get asked and summarized, carrying redacted text.
- **`full`**: verbatim egress, both channels.
- The matrix is unchanged — privacy never reaches it; no `local-only` row concept (per-class control, if ever needed, is a clean v2 addition).
- **Pattern list (code, not config — extending it = PRs)**: OpenAI/TypeSafe-shaped keys (`sk-…`), bearer/authorization headers, AWS access keys, `KEY=value` env assignments for common credential names, PEM blocks. Replacement: `[REDACTED]`.
- **Pipeline order**: redact BEFORE the idempotency-key content hash (§8.4).
- Accepted trade-off, stated honestly in the README: pattern redaction is never complete (obfuscated keys, base64 blobs slip through); the user chose simplicity over exclusion guarantees knowingly. Telemetry is on-box JSONL — unaffected.

## 11. Validation

Three required gates; decision latency recorded but **ungated** (backend-owned; the 2–5 s timeout + fail-open already bound it; slowness degrades gracefully through the fallback gate). Per backend, default matrix, on the fixture:

| gate | threshold | spike measured |
| --- | --- | --- |
| Reduction (context delta, §6.6) | **≥ 80%** | clef −97.8%, freejev −98.0% (single-fixture facts, ~18 pp headroom absorbs composer/matrix tweaks) |
| Sanity vs ground truth | **wrong-drop = 0, hard** — every ground-truth drop dropped; any drop of a keep/summarize-annotated unit fails unless the human pass explicitly blesses it (spike precedent: "small passing-test output kept — defensible"). Keep↔summarize confusion reported, not fatal | 5/5 drops identical cross-backend; human pass SANE |
| Fallback fail-open | **3/3 injected fail-modes → native** (auth 401, injected timeout, http500), asserted via session file: persisted entry has `fromHook: false` and no smart-compact details | 3/3 |
| Latency | p50/p95 per decision request, **recorded, no gate** | clef p50 1.1 s / p95 4.9 s |

**Fixture**: the spike's single fixture IS the validation set (~15-message region, ~42k tokens, per-unit ground-truth classes; lives on `spike/thin-spike` as `spike/fixture.ts`). Acceptance numbers are single-fixture facts, not distribution claims — same stance as threshold values. The prose above must be enough to rebuild it; the spike branch is the reference asset.

**Harness**: throwaway, ~100 lines, RPC-driven (`--mode rpc`, `{"type":"compact"}` on stdin — no TUI needed). Nothing ships: not in the package, not as repo dev scripts. The builder writes their own, using `spike/thin-spike` (`run-one.sh`, `decide-probe.ts`, `sanity.ts`) as the working reference.

## 12. Packaging and distribution

- **Package**: `@andrewjacop/pi-smart-compact` (bare `pi-smart-compact` is taken by an unrelated active package; scoped keeps the title, collision-free).
- **Install**: `pi install npm:@andrewjacop/pi-smart-compact`. Host pi in `peerDependencies` as `"*"`; the compat claim is README text ("Requires pi ≥ 1.0.2").
- **Config homes**: knobs under `smartCompact` in pi settings.json (§5.3); question text as bundled `questions.default.json` + global-only override at `$PI_CODING_AGENT_DIR/smart-compact/questions.json`; telemetry alongside at `$PI_CODING_AGENT_DIR/smart-compact/telemetry.jsonl`.
- **Key setup docs**: §5.4.
- **README outline** (problem-first, titled `@andrewjacop/pi-smart-compact`):
  1. What it is (decision-model compaction, pluggable backend)
  2. Quickstart (install → key setup → minimal config)
  3. Configuration reference (matrix, profiles, mode, privacy, thresholds, questions.json)
  4. How decisions work (unit splitting → questions → argmax+floor)
  5. Backends (Jev / Clef / Ollama: keys, rate limits, privacy)
  6. Summaries & kept region (output format, `keptMessages` clamp + churn hazard)
  7. Fallback & observability (ladder, toast, telemetry.jsonl)
  8. Branch summaries
  9. Eval results (3 gates, spike numbers)
  10. Limitations & v2 (kept-region omissions)

## 13. Out of scope (for the building effort)

Ruled out by the map and not to be re-litigated while building: proactive tool-result pruning; extension-initiated smart triggers (`ctx.compact()` makes it feasible — a clean future effort); decision-driven kept-region omissions (v2, §7); per-tool override rules in the matrix (v1.x candidate); any user-facing commands; budget knobs. This spec produces the v1 extension only.

## 14. Reference assets

| asset | where |
| --- | --- |
| Working prototype (throwaway) | branch `spike/thin-spike` — `spike/extension.ts` (hook → decide → compose, fail-open), `spike/fixture.ts` (validation fixture), `decide-probe.ts`, `sanity.ts`, `run-one.sh` |
| Kept-region mechanics note | branch `research/kept-region` — `research/kept-region.md` |
| Decision record | `.scratch/pi-smart-compact/` map + tickets 01–17 (each spec section above names its tickets) |
| Prior art studied | `@lienat/pi-jev-compaction`, `pi-jev-compaction` unscoped, `@riposta/pi-jev`, upstream `fast-jev-compaction` (tamaratran, MIT) |
| pi canon | local docs `compaction.md` + `extensions.md`; source github.com/earendil-works/pi (`packages/coding-agent/src/`) |
