# 11 — privacy posture per backend
Type: grilling
Status: open
Blocked by:

## Question
Backends are now pinned (ticket 05): freejev-hosted Jev, firm optollm gateway serving clef, Ollama-local fallback. Decide the spec's privacy posture (HITL): what conversation state may leave the box per backend tier (hosted freejev / firm gateway / local Ollama), what the default redaction profile is before decision requests are sent, and whether/how the message-type matrix (ticket 07) can mark message types as local-only. Context: freejev's docs already warn inference is remote (OpenRouter/TypeSafe) — avoid secrets and sensitive data; the firm gateway keeps state on firm infrastructure; Ollama keeps everything on-box (ticket 03 made a "local-only" profile cheap to promise).
