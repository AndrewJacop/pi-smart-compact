# 10 — Packaging, README, calibration recipe

**What to build:** The package ships: scoped name `@andrewjacop/pi-smart-compact` (the unscoped name is taken by an unrelated package), pi in peerDependencies as `"*"`, installable via `pi install npm:@andrewjacop/pi-smart-compact`, compat claim ("Requires pi ≥ 1.0.2") as README text. The README follows the spec outline — what it is; quickstart (install → key setup → minimal config); configuration reference (matrix, profiles, mode, privacy, thresholds, questions.json override); how decisions work; backends (keys, rate limits, privacy per provider); summaries & kept region (output format, `keptMessages` clamp + churn hazard + minReductionPct interplay); fallback & observability (ladder, toasts, telemetry.jsonl path + env override); branch summaries; eval results (the three gates with ticket 09's measured numbers); limitations & v2 (kept-region omissions). Key setup docs: env vars via a gitignored `.env.local`, never committed or printed. The calibration recipe ships as docs only: shadow until ≥ 50 decisions, the jq bucketing one-liner, floor := (min of drop band) − ε or leave 0.1, confirm escalation rate ≈ 0; the fresh-log rule on question changes (`mv telemetry.jsonl telemetry.prev.jsonl`); `minReductionPct` stays 50 shared.

**Blocked by:** 09 — Validation gates (eval numbers feed the README).

**Status:** ready-for-agent

- [ ] `pi install npm:@andrewjacop/pi-smart-compact` succeeds in a clean pi environment; extension activates
- [ ] README covers all ten outline sections, titled with the scoped package name
- [ ] Eval section cites the measured gate numbers (not the spike's)
- [ ] Kept-region section documents the churn hazard and minReductionPct interplay
- [ ] Calibration recipe present with the fresh-log rule; no calibration tooling ships
- [ ] Key setup uses gitignored `.env.local` conventions; no key material anywhere in the repo
