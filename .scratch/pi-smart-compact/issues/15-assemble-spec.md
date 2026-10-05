# 15 — assemble the hand-off spec
Type: task
Status: resolved
Assignee: pi session (assembly, 2026-10-05)
Blocked by: 08, 09, 10, 11, 12, 13, 14, 17

## Question
(AFK) Produce the destination: a validated, hand-off-ready spec for `pi-smart-compact` that another agent or human can build from without re-deciding anything. Assemble it from the resolved tickets (01–07, 08–14): architecture and hook contract, decision pipeline (unit splitting → questions → argmax+floor → pairing repair), the matrix + v1 defaults, backend adapters + threshold profiles, targeted summarizer + output format, fallback/observability, branch summaries, kept-region omission stance, privacy posture, eval plan, packaging. No new decisions get made here — if assembly surfaces an unclosed decision, it goes back on the map as a ticket first.

## Answer

Resolved (AFK assembly), 2026-10-05. The destination artifact exists: **`SPEC.md`** at repo root — the complete, hand-off-ready build spec for `@andrewjacop/pi-smart-compact`.

Structure (all from resolved tickets, every section names its sources):
- §1 What it is · §2 Architecture & hook contract (01) · §3 Decision pipeline: split → exempt → partition → ask → map → repair (04, 06, 07) · §4 Matrix + v1 Safe defaults (07) · §5 Backends, adapters, profiles, `questions.default.json` draft (02, 03, 05, 12) · §6 Targeted summarizer + hybrid composer (14) · §7 `keptMessages` clamp + v2 omissions stance (10, 16) · §8 Fallback ladder, shadow, toast, telemetry schema, calibration recipe (08, 11, 12) · §9 Branch summaries (09, 14) · §10 Privacy + redaction pattern list (11) · §11 Validation: 3 gates, fixture, throwaway RPC harness (06, 13) · §12 Packaging (17) · §13 Out of scope · §14 Reference assets.

No new decisions were required — every spec line traces to a ticket decision. One assembly note, not a decision: the concrete default question text in `questions.default.json` (§5.5) was drafted here from ticket 04's verified phrasing patterns, because question text is user-overridable config by ticket 12's ruling — wording is execution, not policy. Flagging for visibility; amend the file if the wording bothers anyone.

With this ticket closed, every ticket on the map is resolved: the way to the destination is clear, no open tickets remain. The map is complete; the build is the next effort, handed `SPEC.md`.
