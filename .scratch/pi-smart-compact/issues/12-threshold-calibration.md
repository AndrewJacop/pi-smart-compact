# 12 — threshold & calibration model per backend
Type: grilling
Status: open
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

## Answer
