# 03 — State-fitting ladder + batching

**What to build:** Shadow decision runs fit any region size. The state-fitting ladder degrades the shared state through its ordered stages — full → inputs 1000→200→60 → abridge long texts (head 400 + tail 150, oldest first) → collapse old message text → one-line old call summaries → leave out old call-less messages → merge old call-runs — each stage applied only if the previous didn't fit `maxStateTokens` (25k), and never degrading pinned or recent items. If even the last stage doesn't fit → native (ladder throws into the fallback ladder). Token budgets use pi's `estimateTokens` (chars/4). Askable sets larger than the per-profile max questions chunk into concurrent batches — the same state resent with every batch, answers merged by question id; units beyond the chunk cap default to keep. The stage actually used is recorded in telemetry (calibration data must know what context the decisions saw).

**Blocked by:** 02 — Decision pipeline in shadow mode.

**Status:** done

- [x] The ~42k-token spike fixture region makes shadow decisions in one compaction run, with the ladder stage recorded in telemetry
- [x] Ladder applies stages in order and only as needed; a small region stays at "full"
- [x] Pinned/recent items are never degraded at any stage
- [x] A region that can't fit even at the last stage → native compaction, telemetry shows the fallback
- [x] More askables than the profile's per-request cap → concurrent batches share the same state, answers merge by question id, no duplicate or lost questions
- [x] Units beyond the chunk cap classify keep and say so in their reason strings
