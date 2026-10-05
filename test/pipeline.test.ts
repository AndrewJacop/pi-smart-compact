import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { DecisionBatch, DecisionRequest } from "../extensions/smart-compact/client.ts";
import { DEFAULT_MATRIX, effectiveProfile, type ProfileOverride } from "../extensions/smart-compact/config.ts";
import { loadQuestionSet, runShadow, type ShadowDeps } from "../extensions/smart-compact/pipeline.ts";

const DEFAULT_QUESTIONS = fileURLToPath(new URL("../extensions/smart-compact/questions.default.json", import.meta.url));

function user(text: string) {
	return { role: "user", content: text, timestamp: 0 };
}
function assistant(content: unknown[]) {
	return { role: "assistant", content, stopReason: "stop", usage: {}, timestamp: 0 };
}
function toolResult(callId: string, tool: string, text: string) {
	return { role: "toolResult", toolCallId: callId, toolName: tool, content: [{ type: "text", text }], isError: false, timestamp: 0 };
}

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

test("oversize state without client truncation → native at rung 1; with truncation the state is trimmed", async () => {
	const collected: unknown[] = [];
	const noTrim = await runShadow(deps(setupClient(REGION_ANSWERS), collected), OPTS, profile({ stateTokenBudget: 10, truncateStateClientSide: false }), {
		messages: bigRegion(),
		kind: "compact",
	});
	assert.equal(noTrim.outcome, "fallback");
	assert.equal((collected[0] as { fallback: { rung: number } }).fallback.rung, 1);

	collected.length = 0;
	const capture: { requests?: DecisionRequest[] } = {};
	const trimmed = await runShadow(deps(setupClient(REGION_ANSWERS, capture), collected), OPTS, profile({ stateTokenBudget: 600, truncateStateClientSide: true }), {
		messages: bigRegion(),
		kind: "compact",
	});
	assert.equal(trimmed.outcome, "shadowed");
	const state = capture.requests?.[0]?.state as { region: { id: string; text?: string }[] };
	const tokens = Math.ceil(JSON.stringify(state).length / 4);
	assert.ok(tokens <= 600, `trimmed state ${tokens} tok should fit budget 600`);
	const entriesWithText = state.region.filter((r) => r.text && r.text.length > 0 && !/omitted/.test(r.text));
	assert.ok(entriesWithText.length < state.region.length, "oldest-first texts were replaced by size notes");
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

test("askables beyond the profile's max questions classify keep with a reason (batching is ticket 03)", async () => {
	const messages = Array.from({ length: 30 }, (_, i) => assistant([{ type: "text", text: `msg ${i}` }]));
	const collected: unknown[] = [];
	const capture: { requests?: DecisionRequest[] } = {};
	const answers = Object.fromEntries(
		Array.from({ length: 10 }, (_, i) => [`u_${i}_text`, { type: "choice", choice: "keep", confidence: 0.9 }]),
	);
	await runShadow(deps(setupClient(answers, capture), collected), OPTS, profile({ maxQuestions: 10 }), { messages, kind: "compact" });
	assert.equal(Object.keys(capture.requests?.[0]?.questions ?? {}).length, 10);
	const record = collected[0] as { units: { id: string; type: string; action: string; reason: string }[] };
	const over = record.units.filter((u) => u.type === "assistant-text").slice(10);
	assert.ok(over.length === 20);
	assert.ok(over.every((u) => u.action === "keep" && /cap/.test(u.reason)));
});

// ---- question set loading + override ----

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
