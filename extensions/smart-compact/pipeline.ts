// The decision pipeline (SPEC §3; v1 tickets 02–04): split → partition (pinned vs
// askable) → state-fitting ladder → chunked concurrent decide → map (argmax∩subset
// + confidence floor) → repair (call := min(call, result)). `decideRegion` is the
// shared core; shadow mode (decisions only, [shadow] toast, always native) and live
// mode (ticket 04's summarizer + composer + gate) both consume it.
import { readFileSync } from "node:fs";
import type { DecisionBatch, DecisionClient, DecisionQuestion } from "./client.ts";
import type { Action, BackendProfile, Privacy, UnitType } from "./config.ts";
import { redactUnlessFull } from "./privacy.ts";
import { callsText, estimateTextTokens, serializeUnit, splitUnits, type Unit } from "./units.ts";

export type { Action };

// Per-action criteria descriptions on the choice questions (spike-verified wording, live optollm).
const ACTION_CRITERIA: Record<Action, string> = {
	keep: "Encoding verbatim is worth the tokens: instructions, decisions, or short content still referenced.",
	summarize: "Prose worth compressing: context/helpful but not exact words; a summary preserves enough.",
	drop: "Ephemeral bulk: tool output, dumps, or traces superseded by later results; safe to lose entirely.",
};

// ---------- question set (bundled defaults + global user override, SPEC §5.3/§5.5) ----------

export type QuestionSet = Record<string, { type: "choice"; instructions: string }>;

const DECIDABLE_UNIT_TYPES = ["tool-call", "tool-result", "assistant-text", "thinking"] as const;

export interface QuestionSetLoad {
	defaultPath: string;
	overridePath?: string;
}

/** Load the bundled default question set and merge a validated global override over it. */
export function loadQuestionSet(opts: QuestionSetLoad): { ok: true; questions: QuestionSet } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	const defaults = parseQuestionFile(readFileSync(opts.defaultPath, "utf8"), opts.defaultPath, errors);
	if (errors.length > 0) return { ok: false, errors };

	let override: QuestionSet | undefined;
	if (opts.overridePath) {
		let raw: string | undefined;
		try {
			raw = readFileSync(opts.overridePath, "utf8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
				errors.push(`questions.json: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (raw !== undefined) override = parseQuestionFile(raw, "questions.json", errors);
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, questions: { ...defaults, ...override } };
}

function parseQuestionFile(raw: string, name: string, errors: string[]): QuestionSet {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		errors.push(`${name}: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		errors.push(`${name}: must be an object keyed by unit type`);
		return {};
	}
	const out: QuestionSet = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!(DECIDABLE_UNIT_TYPES as readonly string[]).includes(key)) {
			errors.push(`${name}: "${key}" is not a decidable question id (${DECIDABLE_UNIT_TYPES.join(", ")})`);
			continue;
		}
		const v = value as { type?: unknown; instructions?: unknown };
		if (v?.type !== "choice" || typeof v.instructions !== "string" || v.instructions.trim().length === 0) {
			errors.push(`${name}: "${key}" must be { type: "choice", instructions: non-empty string }`);
			continue;
		}
		out[key] = { type: "choice", instructions: v.instructions };
	}
	return out;
}

/** Fill the per-unit template slots ({id}, {tool}, {input}, {resultChars}). */
export function fillInstructions(template: string, unit: Unit): string {
	const tool = (unit.toolName ?? unit.calls?.map((c) => c.name).join(", ") ?? "unknown").slice(0, 80);
	const input = JSON.stringify(unit.calls?.[0]?.arguments ?? "")?.slice(0, 200) ?? "";
	return template
		.replaceAll("{id}", unit.id)
		.replaceAll("{tool}", tool)
		.replaceAll("{input}", input)
		.replaceAll("{resultChars}", String(unit.chars));
}

// ---------- shared state + the state-fitting ladder (SPEC §3.4, fast-jev's 8 stages) ----------

const FULL_TEXT_CAP = 2000; // stage "full": head stays inline, the tail becomes the size note
const GOAL_PROMPTS = 5;
const GOAL_PROMPT_CAP = 400;

export interface StateRegionEntry {
	id: string;
	type: string;
	chars: number;
	text: string;
}

export interface DecisionState {
	orientation: string;
	goal: string[];
	region: StateRegionEntry[];
}

export type LadderStage =
	| "full"
	| "inputs<=1000"
	| "inputs<=200"
	| "inputs<=60"
	| "abridged"
	| "collapsed"
	| "call-lines"
	| "call-less-omitted"
	| "merged-calls";

/** Deepest rung of the ladder — recorded in telemetry when even it cannot fit. */
const LAST_STAGE: LadderStage = "merged-calls";

const ORIENTATION =
	"A coding assistant conversation is being compacted. For each unit in the region below, choose the action " +
	"that loses the least information needed to continue the work later: whatever is not kept is summarized or " +
	"dropped, but the assistant can always re-run a tool or re-read a file.";

const PINNED_TYPES = new Set(["user", "previous-summary", "unknown"]); // unknown is pinned policy too (SPEC §3.3)
/** # ponytail: newest entries the ladder never touches; fast-jev's preserveRecentMessages=6 — revisit only if shadow telemetry shows recent-context misses */
const RECENT_UNITS = 6;

const ABRIDGE_HEAD = 400;
const ABRIDGE_TAIL = 150;
/** Abridging must save at least ~100 chars to be worth a stage. */
const ABRIDGE_MIN_CHARS = ABRIDGE_HEAD + ABRIDGE_TAIL + 100;
const CALL_LINE_ARG_CHARS = 60;

function inlineText(unit: Unit): string {
	if (unit.text.length <= FULL_TEXT_CAP) return unit.text;
	return `${unit.text.slice(0, FULL_TEXT_CAP)}\n[... ${unit.chars} chars (omitted)]`;
}

function estimateStateTokens(state: DecisionState): number {
	return estimateTextTokens(JSON.stringify(state));
}

/** One working region entry: the rendered state text plus the unit it came from (stages re-render from the unit). */
interface Ent extends StateRegionEntry {
	unit: Unit;
}

/**
 * Fit the shared state under `budgetTokens` through the ordered degradation ladder (SPEC §3.4);
 * each stage applies to eligible entries oldest-first, one entry at a time, only advancing when
 * the previous stage left the state over budget. Pinned and recent entries are never degraded.
 * Returns null when even the final stage cannot fit — the caller falls back to native.
 *
 * `only` restricts the region roll-call to one batch's units (per-batch states, SPEC §3.4 as
 * revised 2026-10): the request then carries that batch's units only, plus the orientation and
 * the user-goal prompts, which still span the WHOLE region. Without it the roll-call grows with
 * the unit count and starves the question budget on large regions — a 451-unit region filled
 * clef's entire request budget by itself and every unit silently defaulted to keep (2026-10-07
 * e2e finding, OPTOLINK import). Omitted → the whole-region state, as before.
 */
export function fitState(units: Unit[], budgetTokens: number, only?: ReadonlySet<string>): { state: DecisionState; stage: LadderStage } | null {
	let ents: Ent[] = units
		.filter((u) => !only || only.has(u.id))
		.map((u) => ({ id: u.id, type: u.type, chars: u.chars, text: inlineText(u), unit: u }));
	const resultByCallId = new Map<string, Unit>();
	const callOwner = new Map<string, Unit>();
	for (const u of units) {
		if (u.type === "tool-call") for (const c of u.calls ?? []) callOwner.set(c.id, u);
	}
	for (const u of units) {
		if (u.type !== "tool-result" || !u.toolCallId) continue;
		if (callOwner.has(u.toolCallId)) resultByCallId.set(u.toolCallId, u);
	}
	const goalPrompts = units.filter((u) => u.type === "user").map((u) => u.text);

	const build = (): DecisionState => ({
		orientation: ORIENTATION,
		goal: goalPrompts.slice(-GOAL_PROMPTS).map((p) => (p.length > GOAL_PROMPT_CAP ? `${p.slice(0, GOAL_PROMPT_CAP)}…` : p)),
		region: ents.map(({ id, type, chars, text }) => ({ id, type, chars, text })),
	});
	const fits = (): boolean => estimateStateTokens(build()) <= budgetTokens;
	if (fits()) return { state: build(), stage: "full" };

	// Eligible for degradation: not pinned, not among the newest entries.
	const eligible = (i: number): boolean => i < ents.length - RECENT_UNITS && !PINNED_TYPES.has(ents[i].type);

	// Apply a per-entry transform oldest-first until the state fits; leave it applied when it doesn't
	// (the next stage degrades further from here).
	const tryStage = (transform: (e: Ent) => Ent | null): boolean => {
		for (let i = 0; i < ents.length; i++) {
			if (!eligible(i)) continue;
			const t = transform(ents[i]);
			if (!t) continue;
			ents[i] = t;
			if (fits()) return true;
		}
		return false;
	};

	const inputsCap = (cap: number) => (e: Ent): Ent | null => {
		if (e.unit.type !== "tool-call") return null;
		const text = callsText(e.unit.calls ?? [], cap);
		return text === e.text ? null : { ...e, text };
	};
	const abridge = (e: Ent): Ent | null => {
		// head+tail of the RAW unit text — the baseline render already capped it at FULL_TEXT_CAP
		if (e.unit.type === "tool-call" || e.unit.text.length <= ABRIDGE_MIN_CHARS) return null;
		const omitted = e.unit.text.length - ABRIDGE_HEAD - ABRIDGE_TAIL;
		return { ...e, text: `${e.unit.text.slice(0, ABRIDGE_HEAD)}\n[… ${omitted} chars omitted …]\n${e.unit.text.slice(-ABRIDGE_TAIL)}` };
	};
	const collapse = (e: Ent): Ent | null => {
		if (e.unit.type === "tool-call") return null; // calls get their own stage next
		const text = `${e.chars} chars (omitted)`;
		return text === e.text ? null : { ...e, text };
	};

	const stages: Array<[LadderStage, (e: Ent) => Ent | null]> = [
		["inputs<=1000", inputsCap(1000)],
		["inputs<=200", inputsCap(200)],
		["inputs<=60", inputsCap(60)],
		["abridged", abridge],
		["collapsed", collapse],
	];
	for (const [stage, transform] of stages) {
		if (tryStage(transform)) return { state: build(), stage };
	}

	// One-line old call summaries: fold each eligible old call with its eligible paired result
	// into one line (`tool(args≤60) → Nch`), removing the separate result entry, oldest first.
	// Only folded results are reported in the line and summed into chars — unfolded (e.g. recent)
	// results keep their own entries.
	for (let i = 0; i < ents.length; i++) {
		const e = ents[i];
		if (!eligible(i) || e.unit.type !== "tool-call") continue;
		const resultIdxs: number[] = [];
		for (const c of e.unit.calls ?? []) {
			const j = ents.findIndex((x, k) => k > i && x.unit.type === "tool-result" && x.unit.toolCallId === c.id && eligible(k));
			if (j > i) resultIdxs.push(j);
		}
		if (resultIdxs.length === 0) continue;
		const foldedResults = new Map<string, Unit>();
		let foldedChars = 0;
		for (const k of resultIdxs) {
			const r = ents[k];
			foldedResults.set(r.unit.toolCallId ?? "", r.unit);
			foldedChars += r.chars;
		}
		ents[i] = { ...e, text: callsText(e.unit.calls ?? [], CALL_LINE_ARG_CHARS, foldedResults), chars: e.chars + foldedChars };
		for (const k of resultIdxs.sort((a, b) => b - a)) ents.splice(k, 1);
		if (fits()) return { state: build(), stage: "call-lines" };
	}

	// Leave out old call-less messages (assistant text / thinking; user & summary are pinned), oldest first.
	for (let i = 0; i < ents.length; ) {
		const e = ents[i];
		if (eligible(i) && e.unit.type !== "tool-call" && e.unit.type !== "tool-result") {
			ents.splice(i, 1);
			if (fits()) return { state: build(), stage: "call-less-omitted" };
			continue;
		}
		i++;
	}

	// Merge runs of old call+result entries into one entry that lists every member id.
	const isCallish = (e: Ent): boolean => e.unit.type === "tool-call" || e.unit.type === "tool-result";
	for (let i = 0; i < ents.length - 1; i++) {
		if (!eligible(i) || !isCallish(ents[i])) continue;
		let j = i + 1;
		while (j < ents.length && eligible(j) && isCallish(ents[j])) j++;
		if (j - i < 2) continue;
		const run = ents.slice(i, j);
		const merged: Ent = {
			id: run[0].id,
			type: run[0].type,
			chars: run.reduce((s, e) => s + e.chars, 0),
			text: `${run.length} calls and results (${run.map((e) => e.id).join(", ")}): ${run.map((e) => e.text).join(" | ")}`,
			unit: run[0].unit,
		};
		ents = [...ents.slice(0, i), merged, ...ents.slice(j)];
		if (fits()) return { state: build(), stage: "merged-calls" };
	}
	return null;
}

// ---------- pipeline ----------

export interface UnitRecord {
	id: string;
	type: string;
	action: Action;
	confidence?: number;
	probabilities?: Record<string, number>;
	reason: string;
}

export interface TelemetryRecord {
	ts: string;
	kind: "compact" | "branch";
	mode: "shadow" | "live";
	backend: string;
	model: string;
	stage: string;
	units: UnitRecord[];
	classCounts: Record<Action, number>;
	fallback: { rung: number | null; error: string | null };
	reductionPct: number | null;
	latencyMs: { decision: number; summary: number };
	usage: { decisionInputTokens: number; summaryInputTokens: number; summaryOutputTokens: number };
}

export interface DecisionOpts {
	backend: string;
	matrix: Record<UnitType, Action[]>;
	/** SPEC §10: "redacted" (default when absent) scrubs decision-request egress; "full" passes verbatim. */
	privacy?: Privacy;
}

export interface ShadowDeps {
	client: DecisionClient;
	writeTelemetry: (record: TelemetryRecord) => void;
	questionSet: QuestionSet;
}

export interface ShadowRegion {
	messages: Array<Record<string, unknown>>;
	previousSummary?: string;
	kind: "compact" | "branch";
	signal?: AbortSignal;
}

export interface ShadowResult {
	outcome: "shadowed" | "fallback" | "skipped";
	toast?: string;
	/** Shadow never composes — always undefined, the hook returns native. */
	compaction: undefined;
}

const PAST: Record<Action, string> = { keep: "kept", summarize: "summarized", drop: "dropped" };

/** An empty telemetry record; both mode tails fill what they know and write it. */
export function emptyRecord(mode: TelemetryRecord["mode"], kind: TelemetryRecord["kind"], backend: string, model: string, stage: string): TelemetryRecord {
	return {
		ts: new Date().toISOString(),
		kind,
		mode,
		backend,
		model,
		stage,
		units: [],
		classCounts: { keep: 0, summarize: 0, drop: 0 },
		fallback: { rung: null, error: null },
		reductionPct: null,
		latencyMs: { decision: 0, summary: 0 },
		usage: { decisionInputTokens: 0, summaryInputTokens: 0, summaryOutputTokens: 0 },
	};
}
const RANK: Record<Action, number> = { keep: 0, summarize: 1, drop: 2 }; // destructiveness (SPEC §3.6)

function confStr(c: number): string {
	return String(Math.round(c * 100) / 100);
}

// ---------- decision core (shared by shadow + live) ----------

export interface DecisionCore {
	units: Unit[];
	/** Per-unit decisions incl. pinned policy + salvage, by unit id. */
	actions: Map<string, UnitRecord>;
	all: UnitRecord[];
	classCounts: Record<Action, number>;
	stage: LadderStage | "n/a";
	model: string;
	decisionMs: number;
	inputTokens: number;
	/** Serialized-region token estimate (the "before" of the token tallies). */
	regionTokens: number;
	/** Serialized tokens per action class (shadow's counterfactual estimate uses these). */
	tokensByAction: Record<Action, number>;
}

export type DecisionOutcome =
	| { ok: true; core: DecisionCore }
	| { ok: false; empty: true }
	| { ok: false; rung: 1 | 2; error: string; model: string; stage: LadderStage | "n/a"; decisionMs: number };

/**
 * The full decision pipeline over one region — everything the modes share, through
 * the pairing repair and the token tally. No telemetry, no toast: tails own those.
 */
export async function decideRegion(
	deps: { client: DecisionClient; questionSet: QuestionSet },
	opts: DecisionOpts,
	profile: BackendProfile | null,
	region: ShadowRegion,
): Promise<DecisionOutcome> {
	const units = splitUnits(region.messages, region.previousSummary);
	if (units.length === 0) return { ok: false, empty: true };

	const t0 = Date.now();

	// Unwired backend (ticket 08 ships the rest): fail open, honestly labeled.
	if (!profile)
		return { ok: false, rung: 1, error: `backend "${opts.backend}" has no wired profile yet`, model: "unknown", stage: "n/a", decisionMs: Date.now() - t0 };

	// Partition: length-1 rows (and unknown unit types) are pinned policy, never asked (SPEC §3.3).
	const actions = new Map<string, UnitRecord>();
	const askable: Unit[] = [];
	for (const u of units) {
		const row = u.type === "unknown" ? undefined : opts.matrix[u.type as UnitType];
		if (!row || row.length <= 1) {
			const action: Action = row?.[0] ?? "keep";
			actions.set(u.id, {
				id: u.id,
				type: u.type,
				action,
				reason: u.type === "unknown" ? "kept: pinned policy (unknown unit type)" : `${PAST[action]}: pinned policy`,
			});
		} else {
			askable.push(u);
		}
	}

	// Per-batch state (SPEC §3.4, revised 2026-10). Each request's state covers only its own
	// units, plus the orientation and user-goal prompts which still span the whole region; the
	// one-shared-state design starved the question budget on large regions (see fitState). The
	// ladder still fits each request client-side per profile policy (§5.2): clef-family + freejev
	// fit state + questions under the per-request budget; jev-direct ships full-stage per-batch
	// state and lets the API enforce size (its 400 → rung 1). A batch whose state cannot fit even
	// at the final ladder stage defaults its units to keep (chunk cap) — the reduction gate, not
	// destructiveness, decides what that does. Privacy (§10): every request's state and questions
	// go through redactUnlessFull before the wire; the per-request idempotency key (§8.4) hashes
	// the redacted body inside the client, as before.
	const tokenBudget = profile.truncateStateClientSide ? profile.stateTokenBudget : Number.POSITIVE_INFINITY;
	// Gateway body caps are in BYTES, not tokens (clef's optollm: "request body must not exceed
	// 64 KiB", HTTP 413, measured 2026-10-07) — the token budget (~chars/4 ≈ bytes) never saw
	// them. Convert to a token ceiling with 10% envelope headroom; the per-batch fit then
	// guarantees state + questions land under it.
	const bodyTokCap = profile.maxBodyBytes ? Math.floor((profile.maxBodyBytes * 0.9) / 4) : Number.POSITIVE_INFINITY;

	// Questions: one choice per askable unit, candidates = the row's allowed subset.
	const questionOf = new Map<string, DecisionQuestion>();
	for (const u of askable) {
		const row = opts.matrix[u.type as UnitType];
		const tpl = deps.questionSet[u.type];
		if (!tpl) {
			actions.set(u.id, { id: u.id, type: u.type, action: "keep", reason: "kept: no question text for unit type" });
			continue;
		}
		if (row.length < profile.candidatesMin || row.length > profile.candidatesMax) {
			actions.set(u.id, { id: u.id, type: u.type, action: "keep", reason: `kept: ${row.length} candidates outside backend caps ${profile.candidatesMin}–${profile.candidatesMax}` });
			continue;
		}
		const criteria: Record<string, string> = {};
		for (const a of row) criteria[a] = ACTION_CRITERIA[a];
		questionOf.set(u.id, { type: "choice", instructions: fillInstructions(tpl.instructions, u), criteria });
	}

	const askableQ = askable.filter((u) => questionOf.has(u.id));
	const batches: Unit[][] = [];
	for (let i = 0; i < askableQ.length; i += profile.maxQuestions) batches.push(askableQ.slice(i, i + profile.maxQuestions));

	const STAGE_ORDER: LadderStage[] = ["full", "inputs<=1000", "inputs<=200", "inputs<=60", "abridged", "collapsed", "call-lines", "call-less-omitted", "merged-calls"];
	const deeper = (a: LadderStage, b: LadderStage): LadderStage => (STAGE_ORDER.indexOf(a) >= STAGE_ORDER.indexOf(b) ? a : b);

	const prepared = batches.map((batch) => {
		const questions: Record<string, DecisionQuestion> = {};
		for (const u of batch) {
			const q = questionOf.get(u.id);
			if (!q) continue; // unreachable: askableQ is filtered by questionOf.has
			questions[u.id] = redactUnlessFull(opts.privacy, q);
		}
		const questionTokens = Object.values(questions).reduce((s, q) => s + estimateTextTokens(JSON.stringify(q)), 0);
		return { batch, questions, fitted: fitState(units, Math.min(tokenBudget, bodyTokCap) - questionTokens, new Set(batch.map((u) => u.id))) };
	});
	for (const p of prepared) {
		if (p.fitted) continue;
		for (const u of p.batch)
			actions.set(u.id, { id: u.id, type: u.type, action: "keep", reason: `kept: state cannot fit the ${profile.stateTokenBudget}-tok request budget even at the final ladder stage "${LAST_STAGE}" (chunk cap)` });
	}
	const fired = prepared.filter((p): p is typeof p & { fitted: { state: DecisionState; stage: LadderStage } } => !!p.fitted);
	const stage: LadderStage | "n/a" = fired.length > 0 ? fired.map((p) => p.fitted.stage).reduce(deeper) : batches.length > 0 ? LAST_STAGE : "n/a";

	let decisionMs = 0;
	let inputTokens = 0;
	let rawAnswers: Record<string, unknown> = {};
	if (fired.length > 0) {
		// Batches fire in concurrent waves (measured 2026-10-07: 4-wide ≈ 12 s vs 9 s single — the
		// gateway queues mildly at 4, badly wider). A failing wave aborts before launching more:
		// still "no partial salvage", just no wasted requests after a known failure.
		const WAVE = 4;
		const results: DecisionBatch[] = [];
		let failed: Extract<DecisionBatch, { ok: false }> | undefined;
		for (let w = 0; w < fired.length && !failed; w += WAVE) {
			const wave = fired.slice(w, w + WAVE);
			const settled = await Promise.all(
				wave.map((p) =>
					deps.client.decide(
						{ state: redactUnlessFull(opts.privacy, p.fitted.state), model: profile.model, questions: p.questions },
						region.signal,
					),
				),
			);
			results.push(...settled);
			failed = settled.find((r): r is Extract<DecisionBatch, { ok: false }> => !r.ok);
		}
		decisionMs = Date.now() - t0;
		// Any transport-class failure fails the run to native — no partial salvage across batches.
		if (failed) {
			return { ok: false, rung: failed.error.rung, error: `${failed.error.kind}: ${failed.error.message}`, model: profile.model, stage, decisionMs };
		}
		for (const r of results) {
			if (!r.ok) continue;
			inputTokens += r.inputTokens;
			Object.assign(rawAnswers, r.answers);
		}
	} else {
		decisionMs = Date.now() - t0;
	}
	const askedIds = new Set(fired.flatMap((p) => p.batch.map((u) => u.id)));

	// Map: argmax over probabilities ∩ row subset; floor escalates to keep (SPEC §3.5).
	let validAnswers = 0;
	const questioned = askable.filter((u) => askedIds.has(u.id));
	for (const u of questioned) {
		const row = opts.matrix[u.type as UnitType];
		const a = rawAnswers[u.id] as { type?: unknown; choice?: unknown; probabilities?: unknown; confidence?: unknown } | undefined;
		const valid = !!a && a.type === "choice" && typeof a.choice === "string" && (row as string[]).includes(a.choice);
		if (!valid) {
			actions.set(u.id, { id: u.id, type: u.type, action: "keep", reason: "kept: salvage (invalid or missing answer)" });
			continue;
		}
		validAnswers++;
		const probs = a!.probabilities as Record<string, number> | undefined;
		const rowProbs: Record<string, number> = {};
		let hasProb = false;
		for (const action of row) {
			const v = probs?.[action];
			if (typeof v === "number") {
				rowProbs[action] = v;
				hasProb = true;
			}
		}
		// argmax ∩ row subset; ties go to the earlier row action (deterministic)
		let chosen = a!.choice as Action;
		if (hasProb) {
			for (const action of row) {
				if (rowProbs[action] !== undefined && rowProbs[action] > (rowProbs[chosen] ?? -Infinity)) chosen = action;
			}
		}
		const confidence = typeof a!.confidence === "number" ? (a!.confidence as number) : hasProb ? rowProbs[chosen] : 0;
		if (confidence < profile.confidenceFloor) {
			actions.set(u.id, { id: u.id, type: u.type, action: "keep", confidence, probabilities: hasProb ? rowProbs : undefined, reason: `kept: floor ${profile.confidenceFloor} > confidence ${confStr(confidence)}` });
		} else {
			actions.set(u.id, { id: u.id, type: u.type, action: chosen, confidence, probabilities: hasProb ? rowProbs : undefined, reason: `${PAST[chosen]}: ${chosen} ${confStr(confidence)}` });
		}
	}
	if (questioned.length > 0 && validAnswers === 0) {
		return { ok: false, rung: 2, error: "no valid answers in response (wholly unusable)", model: profile.model, stage, decisionMs };
	}

	// Pairing repair: call := min(call, result) by destructiveness rank (SPEC §3.6).
	// A kept/summarized result never outlives a dropped call; the one surviving orphan shape
	// is a kept call whose result was dropped (SPEC §6.4) — min() leaves it untouched.
	const callUnitByCallId = new Map<string, Unit>();
	for (const u of units) {
		if (u.type === "tool-call") for (const c of u.calls ?? []) callUnitByCallId.set(c.id, u);
	}
	for (const r of units) {
		if (r.type !== "tool-result") continue;
		const callUnit = callUnitByCallId.get(r.toolCallId ?? "");
		if (!callUnit) continue;
		const resultAction = actions.get(r.id)?.action;
		const callDec = actions.get(callUnit.id);
		if (resultAction === undefined || !callDec) continue;
		const candidate = RANK[callDec.action] <= RANK[resultAction] ? callDec.action : resultAction;
		if (candidate !== callDec.action) {
			callDec.action = candidate;
			callDec.reason += `; repaired: call follows result (result ${resultAction})`;
		}
	}

	// Token tally (serialized-region estimate); tails own telemetry, toasts, and their own "after".
	const all = units.map((u) => actions.get(u.id)).filter((d): d is UnitRecord => !!d);
	const classCounts: Record<Action, number> = { keep: 0, summarize: 0, drop: 0 };
	const unitTokens = (u: Unit) => estimateTextTokens(serializeUnit(u));
	let regionTokens = 0;
	const tokensByAction: Record<Action, number> = { keep: 0, summarize: 0, drop: 0 };
	for (const u of units) {
		const t = unitTokens(u);
		regionTokens += t;
		const a = actions.get(u.id);
		if (a) {
			classCounts[a.action]++;
			tokensByAction[a.action] += t;
		}
	}
	return {
		ok: true,
		core: { units, actions, all, classCounts, stage, model: profile.model, decisionMs, inputTokens, regionTokens, tokensByAction },
	};
}

// ---------- shadow tail (SPEC §8.1; decisions only, always native) ----------

export async function runShadow(deps: ShadowDeps, opts: DecisionOpts, profile: BackendProfile | null, region: ShadowRegion): Promise<ShadowResult> {
	const outcome = await decideRegion(deps, opts, profile, region);
	if ("empty" in outcome) return { outcome: "skipped", compaction: undefined };
	if (!outcome.ok) {
		const record = emptyRecord("shadow", region.kind, opts.backend, outcome.model, outcome.stage);
		record.fallback = { rung: outcome.rung, error: outcome.error };
		record.latencyMs.decision = outcome.decisionMs;
		deps.writeTelemetry(record);
		return {
			outcome: "fallback",
			toast: `smart-compact [shadow]${branchTag(region.kind)}: fell back to native (rung ${outcome.rung}: ${outcome.error})`,
			compaction: undefined,
		};
	}
	const { classCounts, tokensByAction, regionTokens: before } = outcome.core;

	// ponytail: shadow's −N% assumes the summarize class compresses 10× plus 200 tok of doc
	// overhead — a placeholder counterfactual; live mode's composer computes the real number.
	const SUMMARY_ASSUMPTION = 10;
	const DOC_OVERHEAD_TOKENS = 200;
	const after = tokensByAction.keep + Math.ceil(tokensByAction.summarize / SUMMARY_ASSUMPTION) + DOC_OVERHEAD_TOKENS;
	const reductionPct = before > 0 ? Math.max(0, Math.round((1 - after / before) * 1000) / 10) : 0;

	const record = emptyRecord("shadow", region.kind, opts.backend, outcome.core.model, outcome.core.stage);
	record.units = outcome.core.all;
	record.classCounts = classCounts;
	record.reductionPct = reductionPct;
	record.latencyMs.decision = outcome.core.decisionMs;
	record.usage.decisionInputTokens = outcome.core.inputTokens;
	deps.writeTelemetry(record);

	const toast = `smart-compact [shadow]${branchTag(region.kind)}: would keep ${classCounts.keep} · summarize ${classCounts.summarize} · drop ${classCounts.drop} (−${reductionPct}%) — native ran`;
	return { outcome: "shadowed", toast, compaction: undefined };
}

function branchTag(kind: "compact" | "branch"): string {
	return kind === "branch" ? "[branch]" : "";
}
