# 06 — thin spike: decision-driven compaction end-to-end
Type: prototype
Status: resolved
Assignee: pi session (spike, 2026-10-04)
Blocked by: 01, 02, 05

## Question
Raise fidelity: a minimal pi extension (`-e` loaded) that on `session_before_compact` (1) serializes the region, (2) asks a Jev-shape backend keep/drop/summarize per message per a naive matrix, (3) returns a custom compaction (verbatim encoding + one targeted LLM summary call for summarize-class). Run on a fixture transcript against both live backends: **freejev** (Jev leg — hard 1 req/min, smoke tests only; batch aggressively or stub the rest) and the **optollm gateway** (`/v1/systemone`, model `clef` — measured runs; TypeSafe-SDK-style pass-through, not the Cloudflare REST envelope). Endpoints, model ids and limits: ticket 05. Measure: token reduction %, decision latency, decision sanity vs a human pass, fallback behavior on injected failures. Prototype code is throwaway; numbers + friction notes feed the spec. Use /prototype skill.

## Answer
Spike built and measured 2026-10-04. Prototype (throwaway, clearly marked): branch **`spike/thin-spike`** — `spike/extension.ts` (pi `-e` extension: `session_before_compact` → serialize → Jev-shape decision → targeted summary → custom compaction, fail-open to native), `spike/fixture.ts` (42k-token fixture with ground-truth classes), `spike/decide-probe.ts` (latency), `spike/sanity.ts` (decision table + agreement), `spike/run-one.sh` (RPC-driven single run). Metrics: per-run JSONL + persisted in the compaction entry `details.spike` (`fromHook: true`).

### Measured runs (fixture: 15-message region, 42,385 tok)
| | **clef** (optollm, measured) | **freejev** (Jev leg, smoke) |
|---|---|---|
| Token reduction (region → composed summary) | 42,385 → 918 tok = **97.8%** | 42,385 → 861 tok = **98.0%** |
| Decision latency | 4.8s in-run; **p50 1.1s / p95 4.9s / mean 1.5s** (n=10 probe) | 2.4s |
| Decision tokens | 2,618 in / **0 out** (prefill-only head) | 2,674 in / 411 out |
| Targeted summary (zai glm-5.3-flash, 3–6 msgs) | 11.9s | ~12s |
| Classes (keep/summarize/drop) | 7 / 3 / 5 (2 keeps policy-forced) | 4 / 6 / 5 |

### Decision sanity — human pass: **SANE** (Andrew, 2026-10-04)
- Big dumps → drop at high confidence on both backends (conf .57–.89); identical 5/5 drops cross-backend.
- Long analysis → summarize on both; users policy-kept; small passing-test output → keep on both (conf .78/.21) where ground truth guessed drop — defensible ("proof it worked"), noted.
- Only real split: the fix-explanation assistant message — clef keep (conf .56) vs freejev summarize (conf .03); low-stakes either way.
- **Clef confidences are low for keep/summarize (often <0.15) and high only for drops** — threshold profiles + uncertainty→keep direction are confirmed necessary for the spec (feeds ticket 12).

### Fallback on injected failures — all fail open correctly
- `auth` (bad key) → HTTP 401 → native compaction ran, persisted `fromHook: false`, no spike details.
- `timeout` (30ms injected abort) → fail-open → native ✓.
- `http500` (injected) → fail-open → native started; harness closed RPC stdin mid-native-summary → "Compaction cancelled" (artifact, but proves: **fail-open is not atomic** — fallback cost = decision failure + FULL native summary latency, and abandonment in that window loses the compaction).
- Success path persisted `fromHook: true` with `details.spike` (full run metrics) — observability via entry details works.

### Friction notes feeding the spec
1. **Single-action matrix rows are policy, never questions.** clef rejects a 1-candidate choice (`"criteria must contain 2–26 candidates"` — note: optollm enforces max **26**, not the 255 documented for raw Cloudflare clef). Extension partitions forced-vs-askable before the wire; this also cuts question count (15 msgs → 11 asked).
2. **freejev requires a request id** (`missing_request_id` 400) — ticket 05 recorded Idempotency-Key as "supported"; it is mandatory. Spec: derive from content-hash + attempt, not per-call uuid.
3. **pi truncates toolResults at 2000 chars in `serializeConversation`** (hardcoded, ticket 01) — so "verbatim keeps" of large tool output are bounded at 2k chars; keep-verbatim really means "keep pi's canonical serialization". Even so, verbatim keeps dominate summary size (stub: 1.0k → 3.0k tok when keeps became full blocks).
4. **No LLM API on ExtensionContext** — the targeted summarizer resolves auth itself: `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` (narrow the `{ok:false}` union; filter null header values) + reuse pi's exported `generateSummaryWithUsage` (accepts a message subset + customInstructions). zai call ≈ 12s.
5. **Decision + summary latency land inside `/compact`** — user-visible; RPC events bracket it (`compaction_start` → `compaction_end`). Keep per-call decision timeout 2–5s (ticket 02's rec) and treat summarizer latency as the dominant term.
6. RPC mode (`--mode rpc`, `{"type":"compact"}` on stdin) drives compaction headlessly — the eval harness (ticket 13) needs no TUI.

Consequence: the pipeline is real and cheap; the spec can commit to hook-replace + policy-partition + fail-open, with measured budgets for tickets 07/08/12/13.
