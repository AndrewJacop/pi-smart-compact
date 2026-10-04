# 04 — question design inventory
Type: research
Status: resolved
Blocked by:

## Question
How do existing implementations phrase compaction decisions to Jev? Inventory the actual question sets, types, batching, and probability thresholds of:
1. `fast-jev-compaction` (github.com/tamaratran/fast-jev-compaction) — the origin: reportedly two `noul` questions per tool call (keep call / keep full result), keepThreshold 0.5, state fitting stages, truncateHeadChars 300.
2. `@riposta/pi-jev` `src/questions.ts` (jsdelivr: https://cdn.jsdelivr.net/npm/@riposta/pi-jev@0.2.3/src/questions.ts) + `config.ts` thresholds — note the QUESTIONS_VERSION cache-invalidation pattern.
3. `clef-router` (pypi) — prompt -> tier choice questions.

Deliver: reusable patterns for per-message-type keep/summarize/drop questions (what to ask per msg type, how to batch, how thresholds map to actions), ready to feed ticket 07.

## Answer

All three sources verified against primary source code (cloned/fetched 2026-10-04). No 404 corrections needed except: the PyPI HTML page sits behind a JS challenge — the working URLs are `https://pypi.org/pypi/clef-router/json` (metadata + full README) and `https://github.com/Gjusev/clef-router` (source; capital G in `Gjusev`).

---

### 1. fast-jev-compaction (github.com/tamaratran/fast-jev-compaction, npm lib + Claude Code plugin)

The origin pattern: never summarize, only delete; every tool call gets scored in one batched pass over the whole-conversation state.

**Questions — exactly two `noul` per tool call** (`src/compact.ts` `questionsFor`), keyed `call_{tool_use_id}` / `result_{tool_use_id}`:

- `call_{id}` — *"Tool call {id} ({tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next"*
- `result_{id}` — *"The full output of tool call {id} ({tool}, {resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do"*

Note the phrasing style: declarative statements of what "should" happen, not questions; each embeds the decision-relevant metadata (tool name, result size) inline so the model can judge cost of loss vs. cost of re-running.

**State** (`src/state.ts`): `{ context, goal, history }`. `context` is a fixed orientation string stating the task ("A coding assistant conversation is being compacted to free context… Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file") — it justifies the destructive action and states the recovery path. `goal` = last 3 user prompts. `history` = whole conversation, oldest first, every tool result replaced by a size note (`ok, 4213 chars (omitted)`), inputs/texts included unsummarized. User/assistant text is never a deletion candidate — only tool calls/results are.

**State fitting — stage ladder, each applied only if the previous didn't fit `maxStateTokens` (25k)**, reported as `stats.stage`:

1. `full`
2. `inputs<=1000` → `inputs<=200` → `inputs<=60` (tool inputs truncated; `INPUT_CHARS = [1000, 200, 60]`)
3. `texts abridged` — long texts → head 400 + tail 150 chars with `[… N chars omitted …]` between, oldest non-pinned first, pinned last
4. `old messages collapsed` — non-pinned message text → `[… N chars omitted …]`
5. `old calls compacted` — each old call → one line: `{id} {tool} {input≤60ch} → ok|error {N}ch`
6. `old messages left out` — drop old entries that carry no call
7. `old calls merged` — runs of old call-only same-role messages folded into one entry
8. else throw (caller falls back)

Token estimation is tokenizer-free (word ≈ 6 letters, ½/digit, ~1/other symbol) calibrated slightly above Jev's reported counts.

**Batching** (`batchCalls`): pack candidate calls into batches so `state + questions ≤ maxRequestTokens` (30k, +20 overhead), i.e. budget = 30k − stateTokens − 20. The *same full state is resent with every batch*; batches run concurrently; answers merged by question key. Throws if a single call's questions don't fit.

**Thresholds → actions** (`decideCall`, `keepThreshold` 0.5):

- pinned (first message or newest `preserveRecentMessages`=6) → keep, no question asked
- `keepResult ≥ 0.5` → keep call + result verbatim
- else `keepCall ≥ 0.5` → keep call, truncate result to `truncateHeadChars`=300 + note `"[fast-jev-compaction truncated N chars of this tool result (error); re-run the tool if needed]"` (results ≤ headChars+120 kept whole)
- else → drop call *and* its result (a result never outlives its call)

Failure policy: any Jev error, malformed answer, missing key, or unfit-able history **throws**; the hook falls back to Claude Code's built-in summary. `reductionRatio(result) < 0.25` → caller advised to keep the original.

---

### 2. @riposta/pi-jev 0.2.3 — `src/questions.ts` + `src/config.ts` (jsdelivr URLs as given worked)

A full review-surface design: every judgement about a session lives in one file, each question commented with rationale + the failure it prevents.

**Question types used**: `noul` (yes-probability, action = `if`), `score` (position on an ordered spectrum, config places thresholds, fractional meaningful), `choice` (discrete options mapping onto code paths, always with an `other`/`none`/`unknown` escape).

**Router — once per user prompt** (6 core + speculative):

| id | type | phrasing (abridged) | thresholds in config.ts |
| --- | --- | --- | --- |
| `task_type` | choice | "What kind of work does `prompt` ask for?" — trivial_edit/localized_fix/feature/refactor/architecture/investigation/question/other | maps to model tier (cheap/standard/strong) |
| `reasoning_needed` | score 0–2 | "How much reasoning does `prompt` require beyond pattern matching?" | `reasoningBumpScore` 1.6 bumps tier; thinking bands: <0.75 off, <1.5 low, <3 high |
| `scope` | choice | "How much of the codebase is `prompt` likely to touch?" incl. `unknown` | |
| `is_underspecified` | noul | "Does `prompt` contain enough information to begin without guessing at a goal, constraint, or file?" | `clarifyThreshold` 0.7 → ask clarifying question; confidence floor 0.4 |
| `needs_write_tools` | noul | "Will completing `prompt` require creating or modifying files…?" | `readOnlyThreshold` 0.2; guarded — uncertain answer must not strip tools |
| `touches_sensitive` | noul | "Does `prompt` concern production systems, secrets, personal data, or a data migration?" | `sensitiveThreshold` 0.6 → residency allowlist |
| `domain` | choice | speculative, only read when `router.skillRouting` on — excluded from core set so tokens aren't paid for unread answers; rides the same request | |

Runtime-injected choices: `withModelChoice` adds `target_model` (stable keys `m0`, `m1`… so the human-readable model id never enters the question); `withSkillChoice` adds `target_skill` with `none` first so the classifier can say no; `withRuleQuestions` adds one noul per project rule — *"Does `change` violate the project rule `project_rules[i]`? Judge only that rule; unrelated concerns are not a violation."* — instructions stay static, pointing at indexed state paths, so project-authored text is never interpolated.

**Gate — once per classified tool call** (9 questions, one request):

- `blast_radius` — score 0–3: working files / git-restorable / shared resources / production-or-irreversible. "If `command` runs in `cwd_basename`, what is the worst realistic blast radius?"
- `reversible` — noul; `regenerable` — noul (added because real data showed `npm run build` and `git reset --hard` scored nearly the same on blast_radius+reversible — 1.05 vs 1.07 — so no threshold on those two could separate them; the missing distinction got its own question)
- `installs_software` — noul (installs 0.99 vs no safe command above 0.22); `privileged_or_remote` — noul (sudo 0.98, ssh 0.89, no safe command above 0.05)
- `touches_secrets`, `exfiltrates`, `matches_intent` (drift: "Does `command` fall within what `user_request` asked for?"), `unverified_code` (curl\|sh) — noul

Gate mapping: block if `blast_radius ≥ 3.0` or (`reversible < 0.3` + blast) or `unverified_code ≥ 0.8`; confirm at `blast_radius ≥ 2.0`, or irreversible-suspect `≥ 1.0` with `reversible < 0.75`, or any side-signal over its threshold (regenerable 0.6, installs 0.6, privileged 0.6, secrets 0.6, exfiltration 0.6, intent-drift 0.4); `confidenceFloor` 0.5 — below it, no confirm fires. Obvious cases (force push, `rm -r`, DROP) decided in a code fast-path so the gate works offline.

**Shield + prune — one shared request per tool_result** (`SHIELD_PRUNE_QUESTIONS = {...shield, ...prune, ...failure_type}`): `has_injection` (noul, 0.7 → content never enters context), `has_secret` (noul, 0.6), `has_personal_data` (noul, 0.6); `relevance` — score 0–2 irrelevant/peripheral/directly-needed, prune if < `relevanceThreshold` 0.6 and output ≥ `minLines` 150; `failure_type` — choice none/flaky/real_error/env_problem/config, speculative and cheap.

**Watchdog — every Nth turn (3, after minTurns 6)**: `progress` score 0–2 (display only), `looping` noul ≥ 0.75 (inject advice, never abort), `false_done` noul ≥ 0.7 (queue a verification follow-up).

**QUESTIONS_VERSION invalidation pattern**: `QUESTIONS_VERSION = sha256(questions.ts source).slice(0, 8)`, falling back to `sha256(JSON.stringify(ALL_QUESTIONS))` when the file can't be read (bundled). Changing anything — *even a comment* — changes the hash, which (a) invalidates the in-memory cache, (b) invalidates the on-disk gate cache, (c) marks log records as a different generation so calibration never mixes question generations. Design rules stated in the file header: every question carries a rationale comment and the failure it prevents; **no untrusted content is ever interpolated into `instructions`** — content lives in `state`, questions point at it with backticked paths (`` `prompt` ``, `` `project_rules[i]` ``, `` `command` ``); one judgement a knowledgeable person makes in a second — if a decision has several independent factors, each factor gets its own question and the *weights live in config.ts*, not in the question text. Config errors never fall back silently (ConfigError disables the extension); every module defaults `shadow: true` (log probabilities, don't act) until trusted.

---

### 3. clef-router 0.3.0 (pypi / github.com/Gjusev/clef-router)

Prompt → tier choice, two questions, one forward pass scores every option of every question (single small request, ~324 input tokens, p50 decision overhead 0.12 ms client-side).

**`DEFAULT_QUESTIONS`** (`src/clef_router/models.py`):

- `urgency` — **noul**: *"Decide whether the user's prompt is time-critical: an outage, an incident, a security problem, or anything that must be handled immediately rather than routinely."* criteria: true = "Time-critical: outages, incidents, security issues, deadlines in hours." / false = "Routine work: questions, drafts, research, refactors, low-stakes lookups."
- `team` — **choice**: *"Choose the model team that should handle this prompt. Prefer the cheaper team unless the prompt needs deep reasoning, code understanding, or high-stakes accuracy."* criteria (labels ARE the tiers, so the mapping stays explicit): `cheap` = "Fast inexpensive model: greetings, simple lookups, short rewrites, straightforward Q&A." / `frontier` = "Frontier model: reasoning, coding, multi-step analysis, nuanced or high-stakes work."

**Policy (`derive_tier`) — deliberately fail-safe toward the expensive tier**:

1. `team = frontier` → frontier
2. `team = cheap` and `confidence ≥ min_confidence` (0.45, `CLEF_MIN_CONFIDENCE`, 0 disables the gate) → cheap; below → escalate frontier
3. `team` names an unknown option → frontier
4. no usable `team`: `urgency noul ≥ 0.5` → frontier, `< 0.5` → cheap
5. no usable signal at all → frontier. "The router never silently picks the cheap tier without evidence."

**Bonus — its compactor** (`clef_router.compactor`, RAG-flavored but the same decision shape): one `score` question per document, id `doc_{index}`, *"How relevant is document number {index} to the query? Judge the document text against the query in the state, using the given scale."* Scale 0–3: Irrelevant / Background only / Relevant / Essential. `MAX_QUESTIONS = 64` per request (state carries query + indexed docs). Policy: cut `score < min_score` (1.0) *before* budget math, then keep highest-score-first until token budget; every cut carries a machine-readable reason (`"score 0 below min_score 1"`). Nothing is rewritten.

---

### Reusable patterns for our per-message-type keep/summarize/drop question set

**What to ask per message type** — one `noul` per independently-acting thing, phrased as a declarative "X should stay because Y" with the decision-relevant metadata inline:

- *tool call*: ask about the **call** and its **result separately** (fast-jev's two questions) — the call is knowledge ("this was done, with this input"), the result is data ("still needed verbatim; re-running wouldn't do"). Different loss costs, different questions. Results get a size hint (`N chars`) in the question so the model can weigh bulk.
- *user message*: never dropped by a model — pin or handle in code (both fast-jev and pi-jev keep user turns verbatim; fast-jev only scores tool calls/results).
- *assistant text / large outputs*: a `score` question (clef's 0–3 relevance, pi-jev's 0–2) maps naturally to tiers: 3 keep verbatim, 2 keep/head-truncate, ≤1 drop or collapse-to-note. Use `score` when a spectrum is real (config owns the cut lines); use `noul` when the response is a branch (`if keep ≥ t`); use `choice` when options map onto distinct code paths.
- *dedup / staleness*: pi-jev's `relevance` criterion "duplicated output" shows a duplicate check rides the same relevance scale — no separate question needed.
- Every question needs an escape hatch: `other` / `unknown` / `none` options (pi-jev `task_type.unknown`, clef's fail-safe escalation) so the model is never forced into a wrong concrete answer.

**How to batch many messages into few requests — state fitting** (fast-jev is the reference):

- Send ONE shared state: whole conversation, oldest first, all candidates still visible but their bulky content replaced by size notes; questions reference items by stable id (`call_{id}`, `doc_{index}`, `project_rules[i]`).
- Fit the state with a fixed, cheapest-first **stage ladder** (truncate inputs 1000→200→60; abridge head+tail; collapse old text to `[…N chars omitted…]`; one-line call summaries; fold call-runs) — each stage applied only if the previous didn't fit, and the stage used is reported so calibration data records context. Never degrade pinned/recent items.
- Budget questions by estimated request size: `maxRequestTokens − stateTokens − overhead` defines how many candidate items ride one request; resend the *same* state with each batch, run batches concurrently, merge by question key. Cap questions per request (clef: 64).
- Degrade gracefully: if even the deepest stage doesn't fit, throw and fall back (fast-jev), rather than silently deciding on an unreadable state.

**How probabilities + confidence map to actions**:

- Ladder the *cheap* action behind the *safe* signal, always erring toward what's recoverable: fast-jev's `keepResult ≥ t → keep all` / `keepCall ≥ t → keep call, truncate result to 300ch + note` / `else drop both` (a result never outlives its call; "re-run the tool" is the stated recovery path, written into the state context itself). clef-router generalizes it: cheap tier only on *named choice + confidence ≥ 0.45*; ambiguity, unknown answers, or parse failure escalate to the safe/expensive side — "never silently pick the cheap option without evidence."
- Low confidence is its own action: pi-jev's confidence floors mean an uncertain gate answer *fires nothing* (confirm skipped below 0.5, tools never stripped on uncertain `needs_write_tools`) — map uncertainty to "do nothing / keep as-is," not to a guess.
- Thresholds live in config, never in question text (pi-jev rule); one question per factor, weights combined in code (blast_radius + reversible + regenerable, because single-threshold combos provably can't separate `npm run build` from `git reset --hard`).
- Shadow-mode first: log probabilities per question (pi-jev `telemetry.logProbabilities`) before acting on them; version the question set (hash the file → `QUESTIONS_VERSION`) so any question-wording change invalidates caches and separates calibration generations.
- Always record a per-decision reason string (`"result_dropped"`, `"score 0 below min_score 1"`, `"team selected cheap with confidence 0.82"`) — it makes the decision log auditable and the fallback path debuggable.
