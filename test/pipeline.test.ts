import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { DecisionBatch, DecisionRequest } from "../extensions/smart-compact/client.ts";
import { DEFAULT_MATRIX, effectiveProfile, type ProfileOverride } from "../extensions/smart-compact/config.ts";
import { fitState, loadQuestionSet, runShadow, type ShadowDeps } from "../extensions/smart-compact/pipeline.ts";
import { estimateTextTokens, splitUnits } from "../extensions/smart-compact/units.ts";
import { assistant, filler, toolResult, user } from "./helpers.ts";

const DEFAULT_QUESTIONS = fileURLToPath(new URL("../extensions/smart-compact/questions.default.json", import.meta.url));

function setupClient(answers: unknown, capture: { requests?: DecisionRequest[]; calls?: number } = {}) {
	capture.requests ??= [];
	return {
		async decide(req: DecisionRequest): Promise<DecisionBatch> {
			capture.calls = (capture.calls ?? 0) + 1;
			capture.requests!.push(req); // initialized synchronously in setupClient
			return {
				ok: true,
				answers: answers as Record<string, { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number }>,
				model: "clef",
				inputTokens: 321,
			};
		},
	};
}

function deps(client: ShadowDeps["client"], collected: unknown[] = []): ShadowDeps {
	const q = loadQuestionSet({ defaultPath: DEFAULT_QUESTIONS });
	assert.equal(q.ok, true, "bundled question set must load");
	return { client, writeTelemetry: (record) => collected.push(record), questionSet: q.ok ? q.questions : {} };
}

function profile(overrides: ProfileOverride = {}) {
	return effectiveProfile("clef", overrides);
}

const OPTS = { backend: "clef", decisionTimeoutMs: 5000, matrix: DEFAULT_MATRIX };
// Valid answers for bigRegion's four askable units — {} means "zero valid answers" (rung 2).
const REGION_ANSWERS = {
	u_1_text: { type: "choice", choice: "summarize", confidence: 0.9 },
	u_1_think: { type: "choice", choice: "drop", confidence: 0.9 },
	u_1_call: { type: "choice", choice: "keep", confidence: 0.9 },
	u_2: { type: "choice", choice: "keep", confidence: 0.9 },
};

function bigRegion() {
	return [
		user("We are building a rate limiter for the checkout API. Hard constraints: SQLite buckets, memory under 512MB."),
		assistant([
			{ type: "thinking", thinking: "Find the store seam first." },
			{ type: "text", text: "On it. Let me look at the middleware chain." },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/store.ts" } },
		]),
		toolResult("c1", "read", `// src/store.ts dump\n${"x".repeat(5000)}`),
	];
}

test("partition: pinned rows never asked; decidable rows ask exactly their row's subset", async () => {
	const capture: { requests?: DecisionRequest[] } = {};
	const collected: unknown[] = [];
	await runShadow(deps(setupClient(REGION_ANSWERS, capture), collected), OPTS, profile(), {
		previousSummary: "earlier summary",
		messages: bigRegion(),
		kind: "compact",
	});
	const req = capture.requests?.[0];
	assert.ok(req);
	// user + previous-summary pinned; assistant turn splits: think/text/call asked, result asked
	assert.deepEqual(Object.keys(req.questions).sort(), ["u_1_call", "u_1_text", "u_1_think", "u_2"]);
	assert.deepEqual(Object.keys(req.questions.u_1_think.criteria), ["summarize", "drop"]);
	assert.deepEqual(Object.keys(req.questions.u_1_text.criteria), ["keep", "summarize"]);
	assert.deepEqual(Object.keys(req.questions.u_1_call.criteria), ["keep", "drop"]);
	assert.deepEqual(Object.keys(req.questions.u_2.criteria), ["keep", "summarize", "drop"]);
	const record = collected[0] as { units: { id: string; type: string; action: string; reason: string }[]; classCounts: Record<string, number> };
	// pinned units present in the record with pinned reasons, never in questions
	const prev = record.units.find((u) => u.id === "u_prev");
	assert.equal(prev?.action, "keep");
	assert.match(prev?.reason ?? "", /pinned/);
	const usr = record.units.find((u) => u.id === "u_0");
	assert.equal(usr?.type, "user");
	assert.match(usr?.reason ?? "", /pinned/);
});

test("state: orientation + recent user prompts as goal + size notes for bulky content", async () => {
	const capture: { requests?: DecisionRequest[] } = {};
	await runShadow(deps(setupClient({}, capture)), OPTS, profile(), { messages: bigRegion(), kind: "compact" });
	const state = capture.requests?.[0]?.state as { orientation: string; goal: string[]; region: { id: string; text: string }[] };
	assert.match(state.orientation, /compacted/);
	assert.match(state.orientation, /re-run a tool/);
	assert.deepEqual(state.goal, ["We are building a rate limiter for the checkout API. Hard constraints: SQLite buckets, memory under 512MB."]);
	const resultEntry = state.region.find((r) => r.id === "u_2");
	assert.ok(resultEntry);
	assert.ok(resultEntry.text.length < 5000, "bulky content replaced");
	assert.match(resultEntry.text, /omitted/);
	assert.match(resultEntry.text, /5021/); // original size is visible
});

test("answers map via argmax∩subset with the floor escalating to keep; reasons recorded", async () => {
	const answers = {
		u_1_text: { type: "choice", choice: "summarize", probabilities: { keep: 0.2, summarize: 0.75 }, confidence: 0.75 },
		u_1_think: { type: "choice", choice: "drop", probabilities: { drop: 0.03, summarize: 0.02 }, confidence: 0.03 },
		u_1_call: { type: "choice", choice: "keep", confidence: 0.9 },
		u_2: { type: "choice", choice: "drop", probabilities: { keep: 0.05, summarize: 0.1, drop: 0.81 }, confidence: 0.81 },
	};
	const collected: unknown[] = [];
	await runShadow(deps(setupClient(answers), collected), OPTS, profile(), { messages: bigRegion(), kind: "compact" });
	const record = collected[0] as { units: { id: string; action: string; reason: string; confidence?: number; probabilities?: unknown }[] };
	const byId = new Map(record.units.map((u) => [u.id, u]));
	assert.equal(byId.get("u_1_text")?.action, "summarize");
	assert.match(byId.get("u_1_text")?.reason ?? "", /^summarized: summarize 0\.75$/);
	assert.equal(byId.get("u_1_think")?.action, "keep"); // 0.03 < floor 0.1 → keep
	assert.match(byId.get("u_1_think")?.reason ?? "", /floor 0\.1 > confidence 0\.03/);
	assert.equal(byId.get("u_1_call")?.action, "keep");
	assert.match(byId.get("u_1_call")?.reason ?? "", /^kept: keep 0\.9$/);
	assert.equal(byId.get("u_2")?.action, "drop");
	assert.match(byId.get("u_2")?.reason ?? "", /^dropped: drop 0\.81$/);
	assert.deepEqual(byId.get("u_2")?.probabilities, { keep: 0.05, summarize: 0.1, drop: 0.81 });
});

test("pairing repair: a kept result forces its dropped call back to keep; no orphan results", async () => {
	const messages = [
		assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "npm test" } }]),
		toolResult("c1", "bash", "3 passing (90ms)"),
		assistant([{ type: "toolCall", id: "c2", name: "bash", arguments: { cmd: "npm run build" } }]),
		toolResult("c2", "bash", "built ok"),
	];
	const answers = {
		u_0_call: { type: "choice", choice: "drop", confidence: 0.9 }, // its result is kept → call must come back
		u_2_call: { type: "choice", choice: "keep", confidence: 0.9 }, // its result drops → §6.4 shape survives
		u_3: { type: "choice", choice: "drop", confidence: 0.9 },
	};
	const collected: unknown[] = [];
	await runShadow(deps(setupClient(answers), collected), OPTS, profile(), { messages, kind: "compact" });
	const record = collected[0] as { units: { id: string; action: string; reason: string }[] };
	const byId = new Map(record.units.map((u) => [u.id, u]));
	assert.equal(byId.get("u_0_call")?.action, "keep");
	assert.match(byId.get("u_0_call")?.reason ?? "", /result keep/);
	assert.equal(byId.get("u_1")?.action, "keep");
	assert.equal(byId.get("u_2_call")?.action, "keep"); // untouched — dropped result leaves a kept call (SPEC §6.4)
	assert.equal(byId.get("u_3")?.action, "drop");
});

test("wholly unusable response → per-unit salvage has nothing to save → native at rung 2", async () => {
	const collected: unknown[] = [];
	const result = await runShadow(deps(setupClient({ garbage: { type: "nonsense" } }), collected), OPTS, profile(), {
		messages: bigRegion(),
		kind: "compact",
	});
	assert.equal(result.outcome, "fallback");
	const record = collected[0] as { fallback: { rung: number; error: string }; units: unknown[] };
	assert.equal(record.fallback.rung, 2);
	assert.match(record.fallback.error, /no valid answers/);
});

test("partial garbage response → invalid units keep (salvage), valid ones survive", async () => {
	const answers = {
		u_1_text: { type: "choice", choice: "summarize", confidence: 0.9 },
		u_1_think: { type: "choice", choice: "explode", confidence: 0.9 }, // not in subset
		u_1_call: { nope: true },
		// u_2 missing entirely
	};
	const collected: unknown[] = [];
	const result = await runShadow(deps(setupClient(answers), collected), OPTS, profile(), { messages: bigRegion(), kind: "compact" });
	assert.equal(result.outcome, "shadowed");
	const record = collected[0] as { units: { id: string; action: string; reason: string }[] };
	const byId = new Map(record.units.map((u) => [u.id, u]));
	assert.equal(byId.get("u_1_text")?.action, "summarize");
	assert.equal(byId.get("u_1_think")?.action, "keep");
	assert.match(byId.get("u_1_think")?.reason ?? "", /salvage/);
	assert.equal(byId.get("u_1_call")?.action, "keep");
	assert.match(byId.get("u_1_call")?.reason ?? "", /salvage/);
	assert.equal(byId.get("u_2")?.action, "keep");
	assert.match(byId.get("u_2")?.reason ?? "", /salvage/);
});

test("transport failure (auth/timeout/500 shapes) → native at rung 1, exactly one client call, no retry", async () => {
	for (const kind of ["auth", "timeout", "overloaded"] as const) {
		const calls = { calls: 0 };
		const client = {
			async decide(): Promise<DecisionBatch> {
				calls.calls++;
				return { ok: false, error: { kind, retryable: false, rung: 1, message: `injected ${kind}` } };
			},
		};
		const collected: unknown[] = [];
		const result = await runShadow(deps(client, collected), OPTS, profile(), { messages: bigRegion(), kind: "compact" });
		assert.equal(result.outcome, "fallback", kind);
		assert.equal(calls.calls, 1, `${kind}: no in-hook retry`);
		const record = collected[0] as { fallback: { rung: number; error: string } };
		assert.equal(record.fallback.rung, 1, kind);
		assert.ok(String(record.fallback.error).includes(kind), kind);
	}
});

test("oversize state fits through the ladder at any truncateStateClientSide setting; exhaustion → native rung 1", async () => {
	const collected: unknown[] = [];
	// pad so bulky units sit outside the recent window and the ladder has material to degrade
	const padded = [...bigRegion(), ...Array.from({ length: 6 }, (_, i) => assistant([{ type: "text", text: `padding ${i}` }]))];
	// small budget forces a degraded stage, regardless of the (superseded) truncate flag
	for (const flag of [true, false]) {
		collected.length = 0;
		const capture: { requests?: DecisionRequest[] } = {};
		const trimmed = await runShadow(deps(setupClient(REGION_ANSWERS, capture), collected), OPTS, profile({ stateTokenBudget: 600, truncateStateClientSide: flag }), {
			messages: padded,
			kind: "compact",
		});
		assert.equal(trimmed.outcome, "shadowed");
		const state = capture.requests?.[0]?.state as { region: { id: string; text?: string }[] };
		const tokens = estimateTextTokens(JSON.stringify(state));
		assert.ok(tokens <= 600, `fitted state ${tokens} tok should fit budget 600`);
		const stage = (collected[0] as { stage: string }).stage;
		assert.notEqual(stage, "full");
	}

	// a budget below the pinned+recent floor exhausts the ladder → native at rung 1
	collected.length = 0;
	const exhausted = await runShadow(deps(setupClient(REGION_ANSWERS), collected), OPTS, profile({ stateTokenBudget: 5 }), {
		messages: bigRegion(),
		kind: "compact",
	});
	assert.equal(exhausted.outcome, "fallback");
	const record = collected[0] as { fallback: { rung: number; error: string }; stage: string };
	assert.equal(record.fallback.rung, 1);
	assert.match(record.fallback.error, /ladder/);
	assert.equal(record.stage, "merged-calls");
});

test("shadow success: native entry path (undefined), toast, and a full telemetry record", async () => {
	const collected: unknown[] = [];
	const result = await runShadow(deps(setupClient(REGION_ANSWERS), collected), OPTS, profile(), { messages: bigRegion(), kind: "compact" });
	assert.equal(result.outcome, "shadowed");
	assert.equal(result.compaction, undefined); // shadow always returns native
	assert.match(result.toast ?? "", /^smart-compact \[shadow\]: would keep \d+ · summarize \d+ · drop \d+ \(−\d+(\.\d+)?%\) — native ran$/);
	const record = collected[0] as Record<string, unknown> & {
		units: unknown[];
		classCounts: Record<string, number>;
		latencyMs: Record<string, number>;
		usage: Record<string, number>;
		fallback: { rung: unknown; error: unknown };
	};
	assert.equal(record.kind, "compact");
	assert.equal(record.mode, "shadow");
	assert.equal(record.backend, "clef");
	assert.equal(record.model, "clef");
	assert.equal(record.stage, "full");
	assert.ok(Array.isArray(record.units) && record.units.length >= 5);
	assert.equal(typeof record.classCounts.keep, "number");
	assert.equal(typeof record.reductionPct, "number");
	assert.ok(record.latencyMs.decision >= 0);
	assert.equal(record.latencyMs.summary, 0);
	assert.equal(record.usage.decisionInputTokens, 321);
	assert.equal(record.usage.summaryInputTokens, 0);
	assert.equal(record.usage.summaryOutputTokens, 0);
	assert.equal(record.fallback.rung, null);
	assert.equal(record.fallback.error, null);
	assert.equal(typeof record.ts, "string");
});

test("empty region → nothing runs, nothing recorded", async () => {
	const capture: { requests?: DecisionRequest[] } = {};
	const collected: unknown[] = [];
	const result = await runShadow(deps(setupClient({}, capture), collected), OPTS, profile(), { messages: [], kind: "compact" });
	assert.equal(result.outcome, "skipped");
	assert.equal(result.toast, undefined);
	assert.equal(collected.length, 0);
	assert.equal(capture.requests!.length, 0);
});

test("askables beyond the per-request cap chunk into concurrent batches sharing one state; answers merge by id", async () => {
	const messages = Array.from({ length: 30 }, (_, i) => assistant([{ type: "text", text: `msg ${i}` }]));
	const capture: { requests: DecisionRequest[]; calls: number } = { requests: [], calls: 0 };
	const pending: Array<{ resolve: (b: DecisionBatch) => void; req: DecisionRequest }> = [];
	const client = {
		decide(req: DecisionRequest): Promise<DecisionBatch> {
			capture.calls++;
			capture.requests.push(req);
			return new Promise((resolve) => pending.push({ resolve, req }));
		},
	};
	const collected: unknown[] = [];
	const runP = runShadow(deps(client, collected), OPTS, profile({ maxQuestions: 10 }), { messages, kind: "compact" });
	await new Promise((r) => setImmediate(r));
	// all three batches fired concurrently — none awaited serially
	assert.equal(capture.calls, 3);
	// the same state object is resent with every batch
	assert.ok(capture.requests[0].state === capture.requests[1].state);
	assert.ok(capture.requests[1].state === capture.requests[2].state);
	const ids = capture.requests.map((r) => Object.keys(r.questions).sort());
	for (const r of ids) assert.equal(r.length, 10);
	const union = new Set(ids.flat());
	assert.equal(union.size, 30, "no duplicate or lost questions across batches");
	// settle the batches out of order — answers must still merge by question id
	for (const { resolve, req } of [...pending].reverse()) {
		resolve({
			ok: true,
			answers: Object.fromEntries(Object.keys(req.questions).map((id, k) => [id, { type: "choice", choice: k % 2 ? "summarize" : "keep", confidence: 0.9 }])),
			model: "clef",
			inputTokens: 100,
		});
	}
	const result = await runP;
	assert.equal(result.outcome, "shadowed");
	const record = collected[0] as { units: { id: string; type: string; action: string; reason: string }[]; usage: { decisionInputTokens: number } };
	const decided = record.units.filter((u) => u.type === "assistant-text");
	assert.equal(decided.length, 30);
	assert.ok(decided.every((u) => u.action === "keep" || u.action === "summarize"), "every unit decided, none defaulted to cap-keep");
	assert.ok(decided.every((u) => !/cap/.test(u.reason)));
	assert.equal(record.usage.decisionInputTokens, 300, "input tokens summed across batches");
});

test("a batch-level transport failure fails the whole run to native at rung 1", async () => {
	const messages = Array.from({ length: 30 }, (_, i) => assistant([{ type: "text", text: `msg ${i}` }]));
	let calls = 0;
	const client = {
		async decide(): Promise<DecisionBatch> {
			calls++;
			if (calls === 2) return { ok: false, error: { kind: "overloaded", retryable: true, rung: 1, message: "injected 500 on batch 2" } };
			return { ok: true, answers: {}, model: "clef", inputTokens: 10 };
		},
	};
	const collected: unknown[] = [];
	const result = await runShadow(deps(client, collected), OPTS, profile({ maxQuestions: 10 }), { messages, kind: "compact" });
	assert.equal(result.outcome, "fallback");
	assert.equal(calls, 3, "all batches fired before the failure surfaced");
	assert.equal((collected[0] as { fallback: { rung: number } }).fallback.rung, 1);
});

test("a question too big for the request budget left after the state classifies keep with a reason", async () => {
	// budget = exactly the fitted state's size: nothing left for questions, so every askable defaults to keep
	const messages = [user("goal"), assistant([{ type: "text", text: "only askable" }])];
	const capture: { requests: DecisionRequest[]; calls: number } = { requests: [], calls: 0 };
	const fitted = fitState(splitUnits(messages, undefined), 10_000)!;
	const budget = estimateTextTokens(JSON.stringify(fitted.state)); // exactly the state's size
	const collected: unknown[] = [];
	const result = await runShadow(deps(setupClient({}, capture), collected), OPTS, profile({ stateTokenBudget: budget }), { messages, kind: "compact" });
	assert.equal(result.outcome, "shadowed");
	assert.equal(capture.calls, 0, "no request when nothing fits the chunk cap");
	const record = collected[0] as { units: { id: string; type: string; action: string; reason: string }[] };
	const unit = record.units.find((u) => u.type === "assistant-text");
	assert.ok(unit);
	assert.equal(unit.action, "keep");
	assert.match(unit.reason, /budget|chunk cap/);
});

// ---- the ~42k-token spike fixture region (SPEC §11 fixture, ticket 03 acceptance) ----

/** The spike fixture's message shapes: big droppable dumps, summarizable prose, must-keep user decisions. */
function spikeFixtureRegion() {
	return [
		user("We are building a rate limiter for the checkout API. Hard constraints: must use SQLite for the token buckets, memory under 512MB, and no new dependencies beyond what's already in package.json. Please start by looking at how the current middleware chain is structured."),
		assistant([
			{ type: "text", text: "I'll look at the middleware chain and the current storage setup." },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/middleware.ts" } },
			{ type: "toolCall", id: "c2", name: "read", arguments: { path: "src/store.ts" } },
		]),
		toolResult("c1", "read", `// src/middleware.ts — 40k-char dump of an outdated draft\n${filler(500, "middleware draft")}`),
		toolResult("c2", "read", `// src/store.ts — in-memory store, 30k chars\n${filler(400, "store source")}`),
		assistant([
			{ type: "text", text: `I've reviewed both files. Here is my detailed analysis of the middleware chain. The chain is composed in \`createApp()\` and runs five middlewares in order: request-id, auth, validation, handler, and error-wrap. ${filler(60, "analysis")} I recommend we implement a SlidingWindowStore class next to the existing one behind a feature flag and A/B them in staging first.` },
		]),
		user("Good analysis. Skip the feature flag and A/B — just replace the store directly. Also note: legal wants request-id to be logged for every request, don't lose that when you touch the chain."),
		assistant([
			{ type: "text", text: "On it. Let me find all the call sites first." },
			{ type: "toolCall", id: "c3", name: "grep", arguments: { pattern: "store\\." } },
		]),
		toolResult("c3", "grep", `src/middleware.ts:112: store.take(req.ip, 1)\n${filler(300, "grep matches wall")}`),
		assistant([
			{ type: "text", text: "Now implementing SlidingWindowStore on SQLite." },
			{ type: "toolCall", id: "c4", name: "edit", arguments: { path: "src/store.ts" } },
		]),
		toolResult("c4", "edit", "Applied 3 edits to src/store.ts"),
		assistant([
			{ type: "text", text: "Let me run the test suite to check the swap." },
			{ type: "toolCall", id: "c5", name: "bash", arguments: { command: "npm test" } },
		]),
		toolResult("c5", "bash", `npm error! TypeError: Cannot read properties of undefined (reading 'prepare')\n${filler(150, "stack trace and npm debug output")}`),
		assistant([{ type: "text", text: "The failure is at `db.prepare` — the store was constructed before `initDb()` ran. Fix: make the constructor lazy, opening the DB on first use." }]),
		assistant([
			{ type: "text", text: "Retrying the suite after the lazy-init fix." },
			{ type: "toolCall", id: "c6", name: "bash", arguments: { command: "npm test" } },
		]),
		toolResult("c6", "bash", `npm test\n  ✓ rate limiter takes token (12ms)\n  ✓ rate limiter rejects over limit (4ms)\n  ✓ request-id logged for every request (3ms)\n  3 passing (90ms)`),
		user(`Before we ship this, here's the full staging checklist I promised — it's long, but treat it as the working reference for the rest of this session:\n\n${filler(700, "staging checklist reference")}`),
		assistant([{ type: "text", text: "Got it — I'll keep the checklist as the reference. Ready for the next instruction whenever you are." }]),
		user("One more thing: confirm the request-id logging survives the new store swap."),
		assistant([{ type: "text", text: "Confirmed — the request-id middleware is untouched and the test 'request-id logged for every request' covers it. The store swap sits strictly downstream of logging." }]),
	];
}

/** Valid answer for any question: the row's first criterion, confidently. */
function echoClient(capture: { requests?: DecisionRequest[]; calls?: number } = {}) {
	const requests = (capture.requests ??= []);
	return {
		async decide(req: DecisionRequest): Promise<DecisionBatch> {
			capture.calls = (capture.calls ?? 0) + 1;
			requests.push(req);
			return {
				ok: true,
				answers: Object.fromEntries(
					Object.entries(req.questions).map(([id, q]) => [id, { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 0.9 }]),
				),
				model: "clef",
				inputTokens: 2600,
			};
		},
	};
}

const LADDER_STAGES = /^(full|inputs<=1000|inputs<=200|inputs<=60|abridged|collapsed|call-lines|call-less-omitted|merged-calls)$/;

test("the ~42k-token spike fixture region makes shadow decisions in one run, ladder stage recorded", async () => {
	const messages = spikeFixtureRegion();
	const rawTokens = estimateTextTokens("x".repeat(messages.reduce((s, m) => s + JSON.stringify(m).length, 0)));
	assert.ok(rawTokens >= 40_000, `fixture region should be ~42k tokens raw, got ${rawTokens}`);
	const capture: { requests?: DecisionRequest[]; calls?: number } = {};
	const collected: unknown[] = [];
	const result = await runShadow(deps(echoClient(capture), collected), OPTS, profile(), { messages, kind: "compact" });
	assert.equal(result.outcome, "shadowed");
	assert.equal(capture.calls, 1, "the whole askable set fits one request (state + questions ≤ budget)");
	assert.ok(Object.keys(capture.requests![0].questions).length > 0, "askables were asked");
	assert.match((collected[0] as { stage: string }).stage, LADDER_STAGES);

	// the same fixture under a squeezed budget still completes, with the engaged ladder stage recorded
	const squeezed: unknown[] = [];
	const squeezedCapture: { requests?: DecisionRequest[]; calls?: number } = {};
	const squeezedRun = await runShadow(deps(echoClient(squeezedCapture), squeezed), OPTS, profile({ stateTokenBudget: 2000 }), {
		messages,
		kind: "compact",
	});
	assert.equal(squeezedRun.outcome, "shadowed");
	const squeezedStage = (squeezed[0] as { stage: string }).stage;
	assert.match(squeezedStage, LADDER_STAGES);
	assert.notEqual(squeezedStage, "full", "the ladder engaged for the fixture under a tight budget");
});

test("a small leftover budget splits into one-question batches; every askable still asked", async () => {
	// the token dimension of chunking: state fills most of the budget, so each batch
	// carries ~one question — more requests, same total questions, nothing silently kept
	const messages = [user("goal"), ...Array.from({ length: 6 }, (_, i) => assistant([{ type: "text", text: `msg ${i}: ${filler(30, `m${i}`)}` }]))];
	const units = splitUnits(messages, undefined);
	const fullState = fitState(units, Number.MAX_SAFE_INTEGER)!.state;
	const fullTokens = estimateTextTokens(JSON.stringify(fullState));
	// measure real per-question size from an unbounded run
	const bigCapture: { requests?: DecisionRequest[]; calls?: number } = {};
	const answers = Object.fromEntries(units.filter((u) => u.type === "assistant-text").map((u) => [u.id, { type: "choice", choice: "keep", confidence: 0.9 }]));
	await runShadow(deps(setupClient(answers, bigCapture), []), OPTS, profile(), { messages, kind: "compact" });
	const perQuestion = Object.values(bigCapture.requests![0].questions).map((q) => estimateTextTokens(JSON.stringify(q)));
	const smallest = Math.min(...perQuestion);
	const budget = fullTokens + smallest; // room for exactly one question per request
	const capture: { requests?: DecisionRequest[]; calls?: number } = {};
	const collected: unknown[] = [];
	const result = await runShadow(deps(setupClient(answers, capture), collected), OPTS, profile({ stateTokenBudget: budget, maxQuestions: 64 }), {
		messages,
		kind: "compact",
	});
	assert.equal(result.outcome, "shadowed");
	assert.equal(capture.calls, 6, "one request per question");
	const asked = new Set(capture.requests!.flatMap((r) => Object.keys(r.questions)));
	assert.equal(asked.size, 6, "every askable still asked across batches");
	const record = collected[0] as { units: { id: string; type: string; action: string; reason: string }[] };
	assert.ok(record.units.filter((x) => x.type === "assistant-text").every((u) => u.action === "keep" && /^kept: keep/.test(u.reason)));
});

test("bundled default question set loads and fills per-unit slots", () => {
	const q = loadQuestionSet({ defaultPath: DEFAULT_QUESTIONS });
	assert.equal(q.ok, true);
	if (!q.ok) return;
	assert.match(q.questions["tool-result"].instructions, /\{resultChars\}/);
});

test("user questions.json override merges; malformed override fails loud with reasons", () => {
	const dir = mkdtempSync(join(tmpdir(), "sc-questions-"));
	const overridePath = join(dir, "questions.json");

	writeFileSync(overridePath, JSON.stringify({ "assistant-text": { type: "choice", instructions: "Custom wording?" } }));
	const merged = loadQuestionSet({ defaultPath: DEFAULT_QUESTIONS, overridePath });
	assert.equal(merged.ok, true);
	if (merged.ok) assert.equal(merged.questions["assistant-text"].instructions, "Custom wording?");

	writeFileSync(overridePath, "{not json");
	const broken = loadQuestionSet({ defaultPath: DEFAULT_QUESTIONS, overridePath });
	assert.equal(broken.ok, false);
	if (!broken.ok) assert.ok(broken.errors.some((e) => /questions\.json/.test(e)));

	writeFileSync(overridePath, JSON.stringify({ "not-a-unit": { type: "choice", instructions: "x" } }));
	const unknownId = loadQuestionSet({ defaultPath: DEFAULT_QUESTIONS, overridePath });
	assert.equal(unknownId.ok, false);
	if (!unknownId.ok) assert.ok(unknownId.errors.some((e) => /not-a-unit/.test(e)));

	writeFileSync(overridePath, JSON.stringify({ thinking: { type: "choice", instructions: "" } }));
	const empty = loadQuestionSet({ defaultPath: DEFAULT_QUESTIONS, overridePath });
	assert.equal(empty.ok, false);

	// absent override file = defaults only
	const absent = loadQuestionSet({ defaultPath: DEFAULT_QUESTIONS, overridePath: join(dir, "missing.json") });
	assert.equal(absent.ok, true);
});

test("branch kind tags the toast with [branch]", async () => {
	const result = await runShadow(deps(setupClient({})), OPTS, profile(), { messages: bigRegion(), kind: "branch" });
	assert.match(result.toast ?? "", /^smart-compact \[shadow\]\[branch\]/);
});

test("unwired backend profile → native at rung 1 (only clef ships in ticket 02)", async () => {
	const collected: unknown[] = [];
	const result = await runShadow(deps(setupClient({}), collected), { backend: "jev", decisionTimeoutMs: 5000, matrix: DEFAULT_MATRIX }, effectiveProfile("jev", undefined), {
		messages: bigRegion(),
		kind: "compact",
	});
	assert.equal(result.outcome, "fallback");
	assert.equal((collected[0] as { fallback: { rung: number } }).fallback.rung, 1);
});
