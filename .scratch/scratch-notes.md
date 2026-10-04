What was decided so far in this grilling session (scratch notes, will be folded into the map):

- Destination: validated spec to hand off (no code ships from this map; a later effort builds)
- Decision scope: "everything" — decision model classifies every compactable message, but CONFIGURABLE via a per-message-type decision matrix (what actions are allowed per type)
- Trigger: native pi trigger only (threshold/overflow/manual); extension replaces the *what* via session_before_compact, never the *when*
- Backend: pluggable Jev-shape client (hosted Jev / Clef on Workers AI / self-hosted Clef); thin adapter per provider; research ticket to verify wire-level compat
- Open: who writes summarize-class prose (ASKING NOW); matrix axes; fallback policy; shadow/observability; validation evidence; scope edges (branch summaries? proactive prune?)
