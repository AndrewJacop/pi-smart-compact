# @andrewjacop/pi-smart-compact

A [pi](https://github.com/earendil-works/pi) extension that replaces native compaction with **decision-model compaction**: a pluggable decision backend classifies every compactable message as **keep-verbatim / summarize / drop**, a targeted LLM summarizes only the "summarize" class, and everything else survives verbatim or is dropped. Any pipeline failure falls back to pi's native compaction — the extension either does its job or gets out of the way.

**Requires pi ≥ 1.0.2.**

## Contents

1. [What it is](#1-what-it-is)
2. [Quickstart](#2-quickstart)
3. [Configuration reference](#3-configuration-reference)
4. [How decisions work](#4-how-decisions-work)
5. [Backends](#5-backends)
6. [Summaries & kept region](#6-summaries--kept-region)
7. [Fallback & observability](#7-fallback--observability)
8. [Branch summaries](#8-branch-summaries)
9. [Eval results](#9-eval-results)
10. [Limitations & v2](#10-limitations--v2)
11. [Calibration recipe](#11-calibration-recipe)

## 1. What it is

pi's native compaction asks one LLM to summarize the whole conversation. That works, but it loses exact details: tool outputs, decisions, file paths — anything the summary prose doesn't happen to carry.

`@andrewjacop/pi-smart-compact` changes the shape of the question. On every compaction (and every branch summary), it:

1. Splits the region to summarize into small units (assistant thinking, assistant text, tool calls, tool results, user messages, prior summaries).
2. Asks a cheap decision backend — a classification model, not a chat model — which units to **keep verbatim**, **summarize**, or **drop**, per a configurable matrix.
3. Sends only the "summarize" units to an LLM.
4. Composes the final summary: previous summary → LLM section → kept-verbatim blocks → file tags.

The newest N messages (`keptMessages`) are exempt from every decision and always survive verbatim. Failures at any step fall through a ladder to native compaction, so smart compaction is never worse than native.

No commands, no new slash-verbs: install it, set one env var, optionally tune `smartCompact` in settings.json. It runs on pi's own compaction trigger.

## 2. Quickstart

**Install** (into your pi agent dir; use `pi install -l …` for project-local):

```bash
pi install npm:@andrewjacop/pi-smart-compact
```

**Set up a key.** Keys are plain env vars, sourced before launching pi from a gitignored `.env.local` — never committed, never printed:

```bash
# .env.local  (gitignored; keep it that way)
echo 'OPTOLLM_API_KEY=<your-key>' >> .env.local
set -a; source .env.local; set +a
pi
```

**That's the minimal config.** Defaults: backend `clef`, mode `live`, privacy `redacted`. If you want to pin behavior explicitly, add a `smartCompact` block to `~/.pi/agent/settings.json` (or `.pi/settings.json` for per-project settings):

```json
{
  "smartCompact": {
    "backend": "clef",
    "mode": "live"
  }
}
```

Run `/compact` (or let auto-compaction fire). You'll see one toast line, e.g.:

```text
smart-compact: kept 7 · summarized 3 · dropped 5 — 42.4k → 0.9k tok (−98%)
```

Start in `"mode": "shadow"` if you'd rather watch decisions without shipping them: shadow runs the decision call, toasts what it *would* do, and always lets native compaction proceed.

## 3. Configuration reference

All knobs live under the `smartCompact` key in pi settings (user `~/.pi/agent/settings.json` + project `.pi/settings.json`, merged). Invalid config fails loud: a warning names the problem, the smart path turns off, native compaction runs — the extension never guesses.

| Knob | Values | Default | Meaning |
| --- | --- | --- | --- |
| `backend` | `clef` · `jev` · `ollama` · `jev-direct` | `clef` | Which decision backend profile to use (§5). |
| `mode` | `live` · `shadow` · `off` | `live` | `live` = decision-driven compaction. `shadow` = decision call + counterfactual toast/telemetry, native always runs. `off` = fully inert. |
| `privacy` | `redacted` · `full` | `redacted` | `redacted` scrubs secret patterns from **all** egress text (decision requests AND summary requests). `full` sends verbatim (§5, privacy note). |
| `minReductionPct` | number 0–100 | `50` | Post-compose gate: the composed summary must shrink context by at least this %, or the run falls back to native. `0` disables the gate. |
| `keptMessages` | non-negative integer | unset | Newest N messages exempt from every decision, always verbatim (§6). Unset = pi's default behavior; `0` = no-op. |
| `decisionTimeoutMs` | positive integer ms | `5000` | Per decision-request timeout. Timeout → native immediately (§7). |
| `matrix` | per-unit-type action arrays | see below | Which actions each unit type may be assigned (§4). |
| `profiles` | per-backend overrides | see §5 | Override `{ model, maxQuestions, stateTokenBudget, truncateStateClientSide, confidenceFloor }` per backend. |

### The matrix

`matrix` maps each unit type to its allowed actions. A row with one action is **pinned policy** (never sent to the backend); two or more = the backend decides among that subset. An empty row is invalid.

| Row | Default | Rationale |
| --- | --- | --- |
| `user` | `["keep"]` | Never dropped by a model. |
| `previous-summary` | `["keep"]` | Already distilled; dropping loses the most per token. |
| `assistant-text` | `["keep", "summarize"]` | Drop is too aggressive for prose. |
| `thinking` | `["summarize", "drop"]` | Ephemeral; summarize only what formed something durable. |
| `tool-call` | `["keep", "drop"]` | One serialized line — summarizing saves ~0. |
| `tool-result` | `["keep", "summarize", "drop"]` | Bulk lives here; summarize is the middle path. |

Unknown unit types are pinned `keep`. Example override — let user messages be summarized too:

```json
{ "smartCompact": { "matrix": { "user": ["keep", "summarize"] } } }
```

### questions.json override

Question wording ships bundled (`questions.default.json`) and is user-overridable by design. The override file is **global only**: `$PI_CODING_AGENT_DIR/smart-compact/questions.json` (default `~/.pi/agent/smart-compact/questions.json`). It may override any of the four decidable rows (`tool-call`, `tool-result`, `assistant-text`, `thinking`); question ids and candidate counts are validated against the backend's caps. Malformed overrides fail loud — smart path off, native compaction. Static instructions only; no untrusted content is ever interpolated into questions.

If you change question text (or upgrade the extension to new shipped questions), see the [fresh-log rule](#11-calibration-recipe) before recalibrating.

## 4. How decisions work

Per compaction: **split → exempt → partition → ask → map → repair → compose**.

1. **Split into block-clusters.** An assistant turn yields at most three units — its thinking block(s), its text, its tool-call group. User messages, tool-result messages, and the previous compaction summary are single units. Finer units mean more precise decisions; they batch into ≈1 request.
2. **Exempt the kept region.** The newest `keptMessages` messages are removed before any questioning — never asked, never summarized, never dropped (§6).
3. **Partition pinned vs askable.** Matrix rows of length 1 are pinned (kept or dropped by policy, no question); length ≥ 2 becomes one choice question whose candidates are exactly that subset.
4. **Ask in concurrent batches over one shared state.** The request carries one orientation state (task, recent user prompts as goal, the whole region with bulky content replaced by size notes) plus a chunk of questions. Batches run concurrently against the same redacted state; answers merge by unit id. Units beyond the chunk cap default to keep. If the state exceeds the backend's token budget, it degrades through an ordered ladder of lossy-but-tracked stages (shrink pasted inputs → abridge long texts → collapse old text → one-line old call summaries → merge old call-runs); exhausting the ladder falls back to native. The stage used is recorded in telemetry.
5. **Map probabilities to actions.** `action = argmax(probabilities) ∩ row's allowed subset`. If the winning confidence is below the profile's `confidenceFloor` (default `0.1`), the action escalates to **keep** — uncertainty never becomes destructive. Every decision records its reason (`"dropped: drop 0.81"`, `"kept: floor 0.1 > confidence 0.03"`, `"kept: pinned policy"`).
6. **Pairing repair: call follows result.** Tool-call and tool-result units get independent questions, then one hardcoded repair — a call's action is relaxed to at least its result's action on the `keep < summarize < drop` destructiveness rank. A result never appears orphaned; a kept result can always show its call.

"Verbatim keep" means pi's canonical serialization, which truncates tool results at a hardcoded 2000 chars — so kept results are bounded, and verbatim keeps are exactly what pi would have shown native.

## 5. Backends

The decision backend is pluggable; shipped profiles:

| Backend | Key (env var) | Endpoint | Model | Notes |
| --- | --- | --- | --- | --- |
| `clef` *(default)* | `OPTOLLM_API_KEY` | `optollm.optomatica.com/v1/systemone` | `clef` | Via the optollm gateway; decision API only, never the chat endpoint. Probabilities are estimates. Choice questions use 2–26 candidates. |
| `jev` (freejev) | `FREEJEV_API_KEY` | `freejev.org/api/v1/decisions` | pinned server-side | **Hard 1 req/min on this key — smoke tests only.** ≤16 questions/request; 128 KB body cap. |
| `ollama` | none | `http://localhost:11434/v1/systemone` | `clef-flash` | Self-hosted fallback: `ollama pull clef-flash` (~11 GB). Keyless. Quantized accuracy unverified. |
| `jev-direct` | `TYPESAFE_API_KEY` | `api.typesafe.ai/v1/systemone` | `jev-1.13.0` | 64k tok/req envelope; oversize errors (400), never truncated server-side. TypeSafe signups currently paused. |

**Keys and rate limits.** Each key is an env var sourced from a gitignored `.env.local` (§2) — never committed, never printed. Rate limiting is treated as any transport failure: a 429 falls back to native immediately; the next compaction retries naturally. There is no in-hook retry — decisions are cheap to redo at the next compaction.

**Privacy per provider.** All four backends receive the same egress: redacted state and redacted messages by default (`privacy: "redacted"`), verbatim only if you opt into `full`. The summarizer defaults to your **session model** — also a remote LLM — and its input passes through the same redaction. Nothing is excluded from summarization on privacy grounds; the matrix, not privacy, decides what gets asked.

**The honest trade-off:** pattern redaction is **never complete**. Obfuscated keys, base64 blobs, and credentials that don't look like keys slip through. The pattern list (code, not config): PEM blocks, `authorization`/`bearer`/`api-key` header values, AWS access keys, `sk-`-shaped keys, `KEY=value` assignments for common credential names, and string values under credential-named object keys — replaced with `[REDACTED]`. The default chooses simplicity over exclusion guarantees, knowingly. If your transcripts hold credentials shaped outside this list, run `privacy: "full"` only on trusted backends, or don't enable smart compaction for that work.

## 6. Summaries & kept region

### Output format

The composed summary is a single document, in order:

1. **Verbatim head** — the previous compaction summary, prepended untouched (omitted on first compaction). Keeps survive every compaction; the head is never re-merged into prose.
2. **LLM section** — pi's native-format summary (Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context), generated **only over the "summarize" class**. Omitted when that class is empty — no LLM call.
3. **`## Kept verbatim`** — the kept units, serialized in region order. Omitted when empty.
4. **`<read-files>` / `<modified-files>` tags** — native parity, sourced from pi's own file ops over the whole span (including dropped units).

Drops are silent in the document except one orphan shape: a surviving tool call whose result was dropped gets a one-line marker —

```text
[Assistant tool calls]: bash(cmd="npm test")
[Tool result dropped: 4,812 chars — re-run the command if needed]
```

After composing, the result is gated on `minReductionPct` (default 50): the composed summary must shrink context by at least that percentage, or the whole run falls back to native. This gate also guards a degenerate all-keep region from producing a no-op compaction.

### `keptMessages: N`

The newest N messages are exempt from every decision: never asked, never summarized, never dropped — always verbatim, guaranteed.

- **Unset** = pi default behavior (pi's native `keepRecentTokens` token window). The clamp composes on top of pi's window; it moves the cut **earlier only** (keeps *more* than pi chose, never less).
- **`0`** = no-op, not "retain none".
- **`N ≥ session length`** (more precisely: whenever the clamp empties the summarizable span past the previous compaction boundary) → the compaction is **cancelled** — the one documented cancel. A manual `/compact` reports "Compaction cancelled"; auto-compaction returns false. No session entry is written.

### The churn hazard — and `minReductionPct`

Compaction re-fires whenever context is back over the trigger threshold. If **summary + clamped kept region still exceeds that threshold**, compaction re-fires *every turn*: each run re-compacts a region that just got bigger (the kept region), sheds little, and churns — one LLM summary call per turn for nothing.

Both keptMessages and `minReductionPct` shrink what one compaction can shed: a larger kept region leaves less summarizable mass, and the reduction gate can then fail rung 4 and send you to native — which is fine once, but if the kept region alone keeps you over the trigger, native re-fires every turn too. Size N so that **summary + N messages fit below the trigger threshold** with headroom; if you need the newest N messages but they're huge, they're not a kept-region problem — compact more often (lower the trigger) or let the tool-result matrix do its job.

## 7. Fallback & observability

**The one rule: any pipeline failure → native compaction.** The extension never makes compaction worse than native.

| Rung | Failure | Response |
| --- | --- | --- |
| 0 | Backend key not set | Native; warn-once per session naming the env var. Re-checked every compaction — the smart path resumes automatically once the key appears. |
| 1 | Transport (timeout, network, 429, 5xx) | Native immediately. No in-hook retry. |
| 2 | Malformed decision response | Per-unit salvage: invalid/missing unit answers → that unit keeps. Only a wholly unusable response → native. |
| 3 | Summarizer failure | Native; no salvage (composing without summaries loses exactly what native preserves). |
| 4 | Reduction below `minReductionPct` | Native. |

`{cancel}` is never returned — except the kept-region edge documented in §6.

### Toasts

One line per run, right after compaction:

```text
smart-compact: kept 7 · summarized 3 · dropped 5 — 42.4k → 0.9k tok (−95.4%)        # live
smart-compact [shadow]: would keep 6 · summarize 4 · drop 5 (−97%) — native ran     # shadow
smart-compact: fell back to native (rung 1: decision timeout)                       # fallback
smart-compact: OPTOLLM_API_KEY is not set — using native compaction. …              # no key
```

Branch runs tag the toast `[branch]` (shadow: `[shadow][branch]`).

### Telemetry

One append-only JSONL file, one record per run, identical schema live and shadow:

```text
$PI_CODING_AGENT_DIR/smart-compact/telemetry.jsonl
```

(default `~/.pi/agent/smart-compact/telemetry.jsonl`; the whole agent dir moves with the `PI_CODING_AGENT_DIR` env override). Each record carries the run's mode, backend, state-fitting stage, per-unit decisions with confidence/probabilities/reason strings, class counts, fallback rung + error, reduction %, latency split (decision vs summary), and token usage. Telemetry is on-box JSONL — redaction never touches it, and no-key runs write nothing. There is no rotation cap; it's a few KB per run.

## 8. Branch summaries

`/tree` navigation runs the **same pipeline** as compaction — same matrix, same splitting, same floor, same repair, same batching, same ladder, same reduction gate. Differences:

- There is no cut point on branches: **"drop" omits the unit from the injected summary only** — the abandoned branch itself stays fully navigable.
- The summarizer gets branch-shaped focus (pi's native branch format, stated explicitly) appended as additional focus; the native prompt structure is never replaced.
- Produced summaries are labeled `smart-compact` so they're attributable, and carry the same `details` shape (file lists + the run record).
- Declining a branch summary (`userWantsSummary: false`) is a pure no-op: no decision call, no toast, no telemetry record — the telemetry dataset stays compaction-only.

Shadow branch runs toast `smart-compact [shadow][branch]: …` and write `kind: "branch"` records.

## 9. Eval results

Three validation gates, run against the spike fixture (~42k tokens, ~15-message region, per-unit ground truth) with the default matrix, over pi RPC running the shipped extension from source. Single-fixture facts, not distribution claims. Latency is recorded, ungated (the 5 s decision timeout + fail-open already bound it).

| Gate | Threshold | Measured |
| --- | --- | --- |
| Reduction | ≥ 80% | **clef 98%** (region ≈ 41.5k → composed ≈ 1.1k tok). PASS. For completeness: the context delta (pi's own §6.6 quantity, `tokensBefore → estimatedTokensAfter`) measured **63.0%** — capped by pi's default kept tail (a ~24k-token checklist the clamp correctly preserves is 37% of context), not by pipeline behavior. |
| Sanity vs ground truth | wrong-drop = 0 (hard) | **9/9 ground-truth keys covered, wrong-drop = 0.** 2 keep↔summarize confusions, both keep-ward (one via confidence-floor escalation — working as designed). One reverse exception (a 700-char passing-test output kept instead of dropped) noted and passed by the human SANE review, matching the spike precedent "small passing-test output kept — defensible". Human SANE pass granted. |
| Fallback fail-open | every injected failure → native | **6/6** — clef 3/3 + jev 3/3 (real 401, injected timeout, injected HTTP 500), each asserted from the persisted session entry: `fromHook: false`, no smart-compact details. Control run ships `fromHook: true` + smartCompact details. |
| Latency (recorded, ungated) | — | clef p50 2.7 s / p95 2.9 s (n=10); jev p50 2.4 s / p95 2.5 s (n=3). Reduction/sanity runs used `decisionTimeoutMs: 30000` to absorb clef latency flakiness; the shipped default remains 5000 and no matrix row was touched. |

Backend coverage honesty: the `jev` (freejev) profile is **test-only** — its key is hard-limited to 1 req/min, and its 16-questions/request cap plus single-flight enforcement can never serve the shipped concurrent batching. `jev-direct` was skipped (no key available; TypeSafe signups paused); `ollama` skipped (no local server). The default path — clef — is the fully gated one.

## 10. Limitations & v2

- **Kept region is all-or-nothing.** `keptMessages` exempts whole messages; it cannot drop *or* summarize individual kept-region units. Decision-driven kept-region omissions are the named v2 effort: pi's append-only `context_edit` entries can drop kept-region messages, but they're reachable only via asynchronous boundary drafts (`turn_end` / `agent_before_settle`), outside any compaction event — a silent failure surface with no toast/ladder/telemetry moment, and it feeds back into every future token estimate. v2 starts there and must respect the same `keptMessages` buffer.
- **"Verbatim" = pi's serialization.** Tool results are truncated at a hardcoded 2000 chars by pi's own serializer; the extension inherits that bound (this is also what keeps keeps cheap).
- **Per-tool matrix overrides** (e.g. "always drop `web-search` results") are not in v1 — the matrix speaks unit types only.
- **`redacted` privacy is best-effort by construction** (§5). It is a filter, not an exclusion guarantee.
- No user-facing commands, no budget knobs: batching bounds decisions to ≈1 request per compaction (~2.6k input tokens ≈ $1e-4 on clef); a spend cap would be speculative at four decimal places.
- Compaction latency is dominated by the summarizer LLM (~12 s), not the decision call (~2–3 s).

## 11. Calibration recipe

Docs only — no calibration tooling ships. The `confidenceFloor` (default `0.1`, per-backend overridable via `profiles.<backend>.confidenceFloor`) ships shared at "escalate only when the backend is guessing." Per-backend *values* are earned from your own shadow telemetry, never shipped: confidences do not transfer across backends (the same unit can measure clef-keep 0.56 vs jev-summarize 0.03), so each profile calibrates its own — no cross-backend borrowing.

1. **Run `mode: "shadow"` until the log has ≥ 50 decisions** on your real workload.
2. **Bucket confidence by chosen class** with this jq one-liner (same backend, per unit type × chosen action):

   ```bash
   jq -s '[ .[] | select(.mode == "shadow" and .backend == "clef")
            | .units[] | select(.confidence != null)
            | {type, action, confidence} ]
          | group_by([.type, .action])
          | map({ band: (.[0].type + " / " + .[0].action),
                  n: length,
                  min: (map(.confidence) | min),
                  max: (map(.confidence) | max) })
          | .[] ' ~/.pi/agent/smart-compact/telemetry.jsonl
   ```

3. **Read the bands.** Set `floor := (min of the drop band) − ε` — just low enough that everything the backend confidently drops survives the floor, and anything it's guessing at escalates to keep. If bands overlap, leave the floor at `0.1`.
4. **Keep shadowing and confirm the escalation rate ≈ 0** on non-garbage decisions. If the floor is firing constantly, it's set wrong (or the backend is — reconsider the backend).

**Fresh-log rule:** changed the questions — edited your `questions.json` override or upgraded to an extension release with different shipped questions? Rotate the log first, so bands never mix eras:

```bash
mv ~/.pi/agent/smart-compact/telemetry.jsonl ~/.pi/agent/smart-compact/telemetry.prev.jsonl
```

**`minReductionPct` stays 50, shared across backends.** Per-backend reduction tuning was data-rejected: the backend moved reduction by 0.2 pp; the driver is the matrix × the transcript. Recalibrate it only if your telemetry ever shows a nonzero below-bar (rung 4) rate.
