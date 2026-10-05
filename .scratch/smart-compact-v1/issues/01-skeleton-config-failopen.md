# 01 — Skeleton: package + hooks + config validation + fail-open shell

**What to build:** The extension installs into pi (`@andrewjacop/pi-smart-compact`, pi in peerDependencies as `"*"`) and registers `session_before_compact` + `session_before_tree`. It loads its knobs from the `smartCompact` settings key (user + project settings merged) and validates them: matrix rows (length ≥ 1, valid actions, known unit types), per-backend profiles, `mode: "live"|"shadow"|"off"`, `privacy`, `minReductionPct`, `keptMessages`, `decisionTimeoutMs`. Invalid config fails loud — warn, smart path off, native compaction, never guess. `mode:"off"` is inert: no decision call, no toasts, no records. A missing backend key is rung 0 of the fallback ladder: native compaction with a warn-once-per-session message naming the env var, re-checked every compaction so the smart path resumes automatically.

End to end, this ticket delivers the never-worse guarantee: with the extension loaded, every compaction and tree navigation behaves exactly like native pi.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `pi install` of the package loads the extension; both hooks registered
- [x] With no config, compaction is indistinguishable from native
- [x] Missing backend key → native + one warn per session naming the env var; adding the key mid-session resumes the smart path on the next compaction
- [x] `mode:"off"` → native, no decision call, no toast, no telemetry record
- [x] Each invalid-config case (bad matrix row, unknown profile, bad mode/privacy/minReductionPct/keptMessages type) → loud warn naming the problem + native compaction, no partial smart behavior
- [x] Per-project matrices work (project settings override user settings)
