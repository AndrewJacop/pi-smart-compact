# 12 — threshold & calibration model per backend
Type: grilling
Status: resolved
Assignee: pi session (grilling, 2026-10-05)
Blocked by:

## Question
How do per-backend threshold profiles and calibration actually work, now that the spike (ticket 06) measured real confidence distributions? Decide what the spec mandates.

Measured starting points (ticket 06, fixture with ground truth):
- **clef confidences are strongly bimodal by class**: drops 0.57–0.89, keep/summarize mostly <0.15 (one keep at 0.56). Raw thresholds like "keep if conf > 0.5" would flip nearly every keep to... nothing — the decision is already the argmax; confidence is a *override trigger*, not the chooser.
- **freejev spreads wider** (0.03–0.88) on the same fixture; identical 5/5 drops.
- Cross-backend agreement: drops identical; divergence confined to keep-vs-summarize on short assistant prose, low confidence both sides.

Decide:
1. What the threshold gates (e.g. conf below X → default to keep / do-nothing instead of argmax) — per-backend profile values, and whether defaults can be shared or must be measured per backend.
2. Whether probabilities/confidence transfer at all between Jev and Clef (fixture suggests class-conditional behavior differs more than scale) and what a shadow-mode recalibration procedure looks like (log decisions + human corrections → re-fit thresholds offline?).
3. Where thresholds live (config per ticket 04's standing decision) and how QUESTIONS_VERSION invalidation interacts.
4. *(added by ticket 08)* Calibrate the new rung's default: `minReductionPct` (shipped default 50) — accept-below-bar vs go-native tradeoff, per backend; the shadow/live JSONL from ticket 08 (`$PI_CODING_AGENT_DIR/smart-compact/telemetry.jsonl`, identical schema both modes) is the calibration dataset.

## Answer

Resolved by grilling, 2026-10-05 (Andrew). Measured data re-extracted for this ticket from `spike/out/run-clef2.jsonl` / `run-freejev2.jsonl` (15 asked units each); correction to ticket 06's prose: **one measured clef drop sat at 0.23**, below the quoted 0.57–0.89 range — strengthening the case against high floors.

### Measured confidence distributions (the calibration baseline)

| class | clef | freejev |
| --- | --- | --- |
| drop | 0.89 · 0.81 · 0.76 · 0.57 · **0.23** | 0.87 · 0.87 · 0.79 · 0.64 · 0.33 |
| keep | 0.78 · 0.56 · 0.12 · 0.01 · 0.003 | 0.21 · 0.11 |
| summarize | 0.11 · 0.11 · 0.02 | 0.88 · 0.30 · 0.25 · 0.22 · 0.04 · 0.03 |

Floor simulation: 0.1 escalates only three coin-flip summarizes (0.02/0.04/0.03) → keep, every drop survives; 0.2 deletes clef's entire summarize class; ≥0.3 catches clef's marginal 0.23 drop but the summarize class is already dead. **Clef's confidence encodes class identity (bimodal), not graded uncertainty — one floor cannot both guard marginal drops and keep summarize alive.**

### 1. The floor — shared default 0.1, per-backend override

`confidenceFloor` ships as **one shared default: 0.1** — "escalate only when the backend is essentially guessing." Inert on every decision the ticket 06 human pass called sane; per-backend override stays in config (ticket 07 mechanism unchanged). Per-backend *values* are **earned from shadow telemetry, not shipped** — the spec does not pretend to measure floors from a 15-unit fixture.

### 2. Transferability: no. Recalibration: docs-only recipe

Fixture fact (not a decision): **confidences do not transfer across backends** — same unit, clef keep @ 0.557 vs freejev summarize @ 0.03, an 18× gap *and* a different class. Each profile's thresholds are its own; no cross-backend borrowing.

The spec's **Calibration section** (recipe, no tooling ships):

1. Run `mode: "shadow"` until the log has ≥50 decisions.
2. jq one-liner: same backend, bucket confidence by chosen class.
3. Read the bands: `floor := (min of drop band) − ε` — or leave 0.1 if bands overlap.
4. Set it in config, keep shadowing, confirm escalation rate ≈ 0 on non-garbage decisions.

Skipped: analysis script, auto-refit. Add the script when someone recalibrates twice.

### 3. No question versioning; questions ship as an overridable file

**QUESTIONS_VERSION-style generation stamping is dropped** (Andrew: the set is small and stable; any change is self-inflicted and known to the changer). The recipe gains one line instead — **fresh-log rule**: *changed the questions (edit or extension upgrade)? rotate the log first* (`mv telemetry.jsonl telemetry.prev.jsonl`). Cost of being wrong — a mixed-era floor — is caught by recipe step 4's shadow-confirm. Telemetry schema stays exactly as ticket 08 defined it: no generation, no floor fields.

Reopening one line of ticket 07: **question text ships as `questions.default.json`**, user-overridable via a config `questions` file key (Andrew's design — completes the config-first stance: matrix, thresholds, privacy, summarizer, questions). Validation: known question ids, candidate counts within backend caps (clef 2–26, jev ≤20/request); malformed → warn loud, smart path off. The user's test loop is shadow mode + the log.

### 4. `minReductionPct`: 50, shared, 0 disables

The bar stays **50, shared** — per-backend is data-rejected (backend moved reduction 0.2pp: 97.8 vs 98.0; the driver is matrix × transcript). It fires only on pathological composes (all-keep configs, tiny regions) — and it doubles as the **re-trigger loop guard**: an all-keep compose ≈ region leaves the session over pi's threshold, re-arming the trigger every turn; without the bar that config loops. Escape hatch: **`minReductionPct: 0` disables the rung** ("I know my keeps eat the budget"). Docs must call out the keep-heavy footgun: below-bar discards *user-configured keeps* and swaps in native. Recalibrate only if telemetry ever shows a nonzero below-bar rate.

### Surfaced

- Ticket 07 amended (question text: Code → config file); telemetry schema untouched; ticket 08's rung 4 unchanged (default confirmed, escape hatch added here). No new tickets; no fog graduated — remaining open: 13 (eval plan), 14 (summary format), 15 (spec assembly).
