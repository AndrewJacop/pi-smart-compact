# 09 — Validation gates (§11)

**What to build:** The three required validation gates, run per backend (clef default; others as keys allow) against the spike fixture with the default matrix — a throwaway RPC-driven harness (~100 lines, `--mode rpc`, compact request on stdin, no TUI, nothing ships in the package). Latency is recorded but ungated. **Reduction**: context delta ≥ 80% on the fixture (single-fixture fact, ~18 pp headroom). **Sanity**: wrong-drop = 0, hard — every ground-truth drop dropped; any drop of a keep/summarize-annotated unit fails unless the human pass explicitly blesses it; keep↔summarize confusion reported, not fatal; human SANE pass recorded. **Fallback fail-open**: 3/3 injected fail-modes (auth 401, injected timeout, HTTP 500) → native, asserted via the session file — persisted entry has `fromHook: false` and no smart-compact details. Decision latency p50/p95 per request recorded for the README. The spike branch is the working reference for harness shape (`run-one.sh`, decide-probe, sanity pass); the builder writes their own throwaway.

**Blocked by:** 03 — State-fitting ladder + batching; 04 — Live mode: targeted summarizer + composed document + reduction gate; 05 — Privacy redaction; 08 — Remaining backends (gates run per backend).

**Status:** ready-for-agent

- [ ] Reduction gate: ≥ 80% context delta on the fixture per backend, numbers recorded
- [ ] Sanity gate: wrong-drop = 0 vs ground truth (or human-blessed exceptions noted); keep↔summarize confusion reported; human SANE pass done
- [ ] Fallback gate: 3/3 injected failures → native, asserted from the persisted session entry (`fromHook: false`, no smart-compact details)
- [ ] Decision latency p50/p95 recorded per backend
- [ ] Harness is throwaway: runs from source, ships nothing into the package or repo dev scripts
