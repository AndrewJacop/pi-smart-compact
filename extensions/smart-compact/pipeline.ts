// The decision pipeline in shadow mode (SPEC §3, §8.1; v1 ticket 02):
// split → partition (pinned vs askable) → shared state → questions → decide →
// map (argmax∩subset + confidence floor) → repair (call := min(call, result)).
// Shadow runs decisions only, records telemetry + the [shadow] toast, and always
// returns native (compaction: undefined).
import { readFileSync } from "node:fs";
import type { DecisionClient, DecisionQuestion } from "./client.ts";
import type { Action, BackendProfile, UnitType } from "./config.ts";
import { estimateTextTokens, serializeUnit, splitUnits, type Unit } from "./units.ts";

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

// ---------- shared state (SPEC §3.4, stage "full"; the fitting ladder is ticket 03) ----------

const FULL_TEXT_CAP = 2000; // stage "full": head stays inline, the tail becomes the size note
const GOAL_PROMPTS = 5;
const GOAL_PROMPT_CAP = 400;

const ORIENTATION =
	"A coding assistant conversation is being compacted. For each unit in the region below, choose the action " +
	"that loses the least information needed to continue the work later: whatever is not kept is summarized or " +
	"dropped, but the assistant can always re-run a tool or re-read a file.";

function inlineText(unit: Unit): string {
	if (unit.text.length <= FULL_TEXT_CAP) return unit.text;
	return `${unit.text.slice(0, FULL_TEXT_CAP)}\n[... ${unit.chars} chars (omitted)]`;
}

function buildState(units: Unit[], goalPrompts: string[]): Record<string, unknown> {
	return {
		orientation: ORIENTATION,
		goal: goalPrompts.slice(-GOAL_PROMPTS).map((p) => (p.length > GOAL_PROMPT_CAP ? `${p.slice(0, GOAL_PROMPT_CAP)}…` : p)),
		region: units.map((u) => ({ id: u.id, type: u.type, chars: u.chars, text: inlineText(u) })),
	};
}

/** Crude client-side pre-trim (clef profile): strip unit texts oldest-first, pinned types last. Never partial units. */
function fitsAfterTrim(state: Record<string, unknown>, budgetTokens: number): Record<string, unknown> | null {
	const region = state.region as { id: string; type: string; chars: number; text: string }[];
	const pinned = new Set<string>(["user", "previous-summary"]);
	const trimmed = region.map((r) => ({ ...r })); // oldest-first: the loop below iterates forward
	let tokens = Math.ceil(JSON.stringify({ ...state, region: trimmed }).length / 4);
	for (let i = 0; i < trimmed.length && tokens > budgetTokens; i++) {
		if (pinned.has(trimmed[i].type)) continue;
		trimmed[i] = { id: trimmed[i].id, type: trimmed[i].type, chars: trimmed[i].chars, text: `${trimmed[i].chars} chars (omitted)` };
		tokens = Math.ceil(JSON.stringify({ ...state, region: trimmed }).length / 4);
	}
	if (tokens > budgetTokens) return null;
	return { ...state, region: trimmed };
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

export interface ShadowOpts {
	backend: string;
	decisionTimeoutMs: number;
	matrix: Record<UnitType, Action[]>;
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
const RANK: Record<Action, number> = { keep: 0, summarize: 1, drop: 2 }; // destructiveness (SPEC §3.6)

// ponytail: shadow's −N% assumes the summarize class compresses 10× plus 200 tok of doc
// overhead — a placeholder until ticket 04's composer gives the real number.
const SUMMARY_ASSUMPTION = 10;
const DOC_OVERHEAD_TOKENS = 200;

function confStr(c: number): string {
	return String(Math.round(c * 100) / 100);
}

export async function runShadow(deps: ShadowDeps, opts: ShadowOpts, profile: BackendProfile | null, region: ShadowRegion): Promise<ShadowResult> {
	const units = splitUnits(region.messages, region.previousSummary);
	if (units.length === 0) return { outcome: "skipped", compaction: undefined };

	const t0 = Date.now();
	const mkRecord = (model: string, stage: string): TelemetryRecord => ({
		ts: new Date().toISOString(),
		kind: region.kind,
		mode: "shadow",
		backend: opts.backend,
		model,
		stage,
		units: [],
		classCounts: { keep: 0, summarize: 0, drop: 0 },
		fallback: { rung: null, error: null },
		reductionPct: null,
		latencyMs: { decision: 0, summary: 0 },
		usage: { decisionInputTokens: 0, summaryInputTokens: 0, summaryOutputTokens: 0 },
	});
	const finishFallback = (record: TelemetryRecord, rung: 1 | 2, error: string): ShadowResult => {
		record.fallback = { rung, error };
		record.latencyMs.decision = Date.now() - t0;
		deps.writeTelemetry(record);
		return { outcome: "fallback", toast: `smart-compact [shadow]${branchTag(region.kind)}: decision pipeline failed (rung ${rung}: ${error}) — native ran`, compaction: undefined };
	};

	// Unwired backend (ticket 08 ships the rest): fail open, honestly labeled.
	if (!profile) return finishFallback(mkRecord("unknown", "n/a"), 1, `backend "${opts.backend}" has no wired profile yet`);

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

	// Chunk cap: batching lands in ticket 03; the overflow classifies keep, loudly in its reason.
	const overflow = askable.slice(profile.maxQuestions);
	for (const u of overflow) {
		actions.set(u.id, { id: u.id, type: u.type, action: "keep", reason: `kept: over ${profile.maxQuestions}-question request cap (batching: ticket 03)` });
	}
	const batch = askable.slice(0, profile.maxQuestions);

	// Shared state; oversize that can't fit yet → native (the state-fitting ladder is ticket 03).
	const goalPrompts = units.filter((u) => u.type === "user").map((u) => u.text);
	let state = buildState(units, goalPrompts);
	let stage = "full";
	let stateTokens = Math.ceil(JSON.stringify(state).length / 4);
	if (stateTokens > profile.stateTokenBudget) {
		if (!profile.truncateStateClientSide) {
			return finishFallback(mkRecord(profile.model, stage), 1, `state ${stateTokens} tok exceeds budget ${profile.stateTokenBudget} and the backend truncates nothing (state-fitting ladder: ticket 03)`);
		}
		const trimmed = fitsAfterTrim(state, profile.stateTokenBudget);
		if (!trimmed) {
			return finishFallback(mkRecord(profile.model, stage), 1, `state ${stateTokens} tok cannot fit budget ${profile.stateTokenBudget} even truncated (state-fitting ladder: ticket 03)`);
		}
		state = trimmed;
		stage = "client-truncated";
		stateTokens = Math.ceil(JSON.stringify(state).length / 4);
	}

	// Questions: one choice per askable unit, candidates = the row's allowed subset.
	const questions: Record<string, DecisionQuestion> = {};
	for (const u of batch) {
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
		questions[u.id] = { type: "choice", instructions: fillInstructions(tpl.instructions, u), criteria };
	}

	let decisionMs = 0;
	let inputTokens = 0;
	let rawAnswers: Record<string, unknown> = {};
	if (Object.keys(questions).length > 0) {
		const res = await deps.client.decide({ state, model: profile.model, questions }, region.signal);
		decisionMs = Date.now() - t0;
		if (!res.ok) {
			return finishFallback(mkRecord(profile.model, stage), res.error.rung, `${res.error.kind}: ${res.error.message}`);
		}
		inputTokens = res.inputTokens;
		rawAnswers = res.answers as Record<string, unknown>;
	} else {
		decisionMs = Date.now() - t0;
	}

	// Map: argmax over probabilities ∩ row subset; floor escalates to keep (SPEC §3.5).
	let validAnswers = 0;
	for (const u of batch) {
		if (!questions[u.id]) continue; // skipped by caps above
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
	if (batch.length > 0 && Object.keys(questions).length > 0 && validAnswers === 0) {
		return finishFallback(mkRecord(profile.model, stage), 2, "no valid answers in response (wholly unusable)");
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

	// Telemetry + counterfactual toast; shadow always returns native.
	const all = units.map((u) => actions.get(u.id)).filter((d): d is UnitRecord => !!d);
	const classCounts: Record<Action, number> = { keep: 0, summarize: 0, drop: 0 };
	for (const d of all) classCounts[d.action]++;
	const unitTokens = (u: Unit) => estimateTextTokens(serializeUnit(u));
	const before = units.reduce((acc, u) => acc + unitTokens(u), 0);
	const keptTokens = units.reduce((acc, u) => acc + (actions.get(u.id)?.action === "keep" ? unitTokens(u) : 0), 0);
	const summarizeTokens = units.reduce((acc, u) => acc + (actions.get(u.id)?.action === "summarize" ? unitTokens(u) : 0), 0);
	const after = keptTokens + Math.ceil(summarizeTokens / SUMMARY_ASSUMPTION) + DOC_OVERHEAD_TOKENS;
	const reductionPct = before > 0 ? Math.max(0, Math.round((1 - after / before) * 1000) / 10) : 0;

	const record = mkRecord(profile.model, stage);
	record.units = all;
	record.classCounts = classCounts;
	record.reductionPct = reductionPct;
	record.latencyMs.decision = decisionMs;
	record.usage.decisionInputTokens = inputTokens;
	deps.writeTelemetry(record);

	const toast = `smart-compact [shadow]${branchTag(region.kind)}: would keep ${classCounts.keep} · summarize ${classCounts.summarize} · drop ${classCounts.drop} (−${reductionPct}%) — native ran`;
	return { outcome: "shadowed", toast, compaction: undefined };
}

function branchTag(kind: "compact" | "branch"): string {
	return kind === "branch" ? "[branch]" : "";
}
