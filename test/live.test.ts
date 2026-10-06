import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { DecisionBatch, DecisionRequest } from "../extensions/smart-compact/client.ts";
import { DEFAULT_MATRIX, effectiveProfile } from "../extensions/smart-compact/config.ts";
import { keptRegionTokens, runLive, type LiveDeps, type LiveRegion } from "../extensions/smart-compact/live.ts";
import { loadQuestionSet } from "../extensions/smart-compact/pipeline.ts";
import { estimateTextTokens } from "../extensions/smart-compact/units.ts";
import { assistant, toolResult, user, stubMakeClient, stubMakeSummarizer, SUMMARY_USAGE, useKey, restoreKey, withAgentDir, type Capture } from "./helpers.ts";

const DEFAULT_QUESTIONS = fileURLToPath(new URL("../extensions/smart-compact/questions.default.json", import.meta.url));
const OPTS = (minReductionPct = 50) => ({ backend: "clef", matrix: DEFAULT_MATRIX, minReductionPct });
const PROFILE = effectiveProfile("clef", undefined);

// Answers classifying the standard fixture: think drop, text summarize, call keep, result drop
// (the repair's surviving orphan shape: a kept call whose result was dropped, SPEC §6.4).
const FIXTURE_ANSWERS = {
	u_1_think: { type: "choice", choice: "drop", confidence: 0.9 },
	u_1_text: { type: "choice", choice: "summarize", confidence: 0.9 },
	u_1_call: { type: "choice", choice: "keep", confidence: 0.9 },
	u_2: { type: "choice", choice: "drop", confidence: 0.9 },
};

function fixtureMessages() {
	return [
		user("We are building a rate limiter for the checkout API."),
		assistant([
			{ type: "thinking", thinking: "Find the store seam first." },
			{ type: "text", text: "On it. Let me look at the middleware chain." },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/store.ts" } },
		]),
		toolResult("c1", "read", `// src/store.ts dump\n${"x".repeat(5000)}`),
	];
}

function liveDeps(
	answers: unknown,
	capture: Capture,
	summarizeImpl?: (msgs: unknown[], opts: any) => Promise<{ text: string; usage: typeof SUMMARY_USAGE }>,
): LiveDeps {
	capture.requests = [];
	const q = loadQuestionSet({ defaultPath: DEFAULT_QUESTIONS });
	assert.equal(q.ok, true, "bundled question set must load");
	return {
		client: {
			async decide(req: DecisionRequest): Promise<DecisionBatch> {
				capture.requests!.push(req);
				return { ok: true, answers: answers as Record<string, never>, model: "clef", inputTokens: 321 };
			},
		},
		writeTelemetry: () => {},
		questionSet: q.ok ? q.questions : {},
		summarize: async (msgs, opts) => {
			capture.summarizeCalls.push({ msgs: [...msgs], opts });
			if (summarizeImpl) return await summarizeImpl(msgs, opts);
			return { text: "## Goal\nbuild the limiter", usage: SUMMARY_USAGE };
		},
	};
}

function liveRegion(over: Partial<LiveRegion> = {}): LiveRegion {
	return {
		messages: fixtureMessages(),
		previousSummary: "HEAD-DOC v1",
		fileOps: { read: new Set(["src/store.ts"]), written: new Set(), edited: new Set() },
		tokensBefore: 100_000,
		keptRegionTokens: 500,
		reserveTokens: 16384,
		firstKeptEntryId: "entry-keep",
		kind: "compact",
		...over,
	};
}

test("live compact: one composed document in order — verbatim head → LLM section → Kept verbatim (+ orphan marker) → file tags", async () => {
	const capture: Capture = { summarizeCalls: [] };
	const r = await runLive(liveDeps(FIXTURE_ANSWERS, capture), OPTS(), PROFILE, liveRegion());
	assert.equal(r.outcome, "compacted");
	assert.ok(r.compaction);
	// Exact document: head untouched, then the LLM section, then the kept blocks with the
	// one orphan marker line, then native-parity file tags.
	assert.equal(
		r.compaction!.summary,
		[
			"HEAD-DOC v1",
			"",
			"## Goal",
			"build the limiter",
			"",
			"## Kept verbatim",
			"[User]: We are building a rate limiter for the checkout API.",
			'[Assistant tool calls]: read(path="src/store.ts")',
			"[Tool result dropped: 5,021 chars — re-run the command if needed]",
			"",
			"<read-files>",
			"src/store.ts",
			"</read-files>",
		].join("\n"),
	);
	// Compaction entry shape: pi's cut + token fields ride through, details carry the record.
	assert.equal(r.compaction!.firstKeptEntryId, "entry-keep");
	assert.equal(r.compaction!.tokensBefore, 100_000);
	const expectedAfter = estimateTextTokens(r.compaction!.summary) + 500;
	assert.equal(r.compaction!.estimatedTokensAfter, expectedAfter);
	assert.deepEqual(r.compaction!.usage, SUMMARY_USAGE);
	assert.equal(r.compaction!.details.smartCompact.mode, "live");
});

test("only the summarize class reaches the LLM; /compact focus forwards and the scoping line appends", async () => {
	const capture: Capture = { summarizeCalls: [] };
	await runLive(liveDeps(FIXTURE_ANSWERS, capture), OPTS(), PROFILE, liveRegion({ customInstructions: "focus on the parser" }));
	assert.equal(capture.summarizeCalls.length, 1);
	// One message in, reduced to its summarize-class block: the dropped thinking and the kept
	// tool call never reach the LLM (SPEC §6.1, §6.4 silent drops).
	assert.equal(capture.summarizeCalls[0].msgs.length, 1);
	assert.deepEqual((capture.summarizeCalls[0].msgs[0] as { content: unknown }).content, [
		{ type: "text", text: "On it. Let me look at the middleware chain." },
	]);
	const opts = capture.summarizeCalls[0].opts as { customInstructions: string; reserveTokens: number };
	assert.match(opts.customInstructions, /^focus on the parser/);
	assert.match(
		opts.customInstructions,
		/Summarize only the messages above; the rest of the region is preserved verbatim alongside this summary\.$/,
	);
	assert.equal(opts.reserveTokens, 16384);
});

test("second compaction: the first document's keep-blocks survive verbatim inside the new head (no prose re-merge)", async () => {
	const head = "## Goal\nearlier work\n\n## Kept verbatim\n[User]: always keep the API contract notes";
	const capture: Capture = { summarizeCalls: [] };
	const r = await runLive(liveDeps(FIXTURE_ANSWERS, capture), OPTS(), PROFILE, liveRegion({ previousSummary: head }));
	assert.ok(r.compaction);
	assert.ok(r.compaction!.summary.startsWith(head), "head prepended untouched");
	// The head is not summarized again: the LLM input contains none of it.
	for (const call of capture.summarizeCalls) {
		assert.equal(call.msgs.length, 1); // only the new region's summarize unit
	}
});

test("dropped units leave no other trace in the document (orphan-only markers)", async () => {
	const capture: Capture = { summarizeCalls: [] };
	const r = await runLive(liveDeps(FIXTURE_ANSWERS, capture), OPTS(), PROFILE, liveRegion());
	assert.ok(r.compaction);
	assert.equal(capture.summarizeCalls.length, 1, "no extra LLM traffic");
	assert.ok(!r.compaction!.summary.includes("Find the store seam"), "dropped thinking absent");
	assert.ok(!r.compaction!.summary.includes("src/store.ts dump"), "dropped result body absent");
	assert.equal(r.compaction!.summary.split("[Tool result dropped:").length - 1, 1, "exactly one orphan marker");
});

test("details carry whole-span read/modified file lists (incl. dropped reads) + the run record", async () => {
	const capture: Capture = { summarizeCalls: [] };
	const r = await runLive(
		liveDeps(FIXTURE_ANSWERS, capture),
		OPTS(),
		PROFILE,
		liveRegion({
			fileOps: { read: new Set(["src/a.ts", "src/b.ts", "dropped-read.ts"]), written: new Set(), edited: new Set(["src/b.ts"]) },
		}),
	);
	assert.ok(r.compaction);
	// dropped-read.ts's read unit was classed drop — still listed (whole span, SPEC §6.5).
	assert.deepEqual(r.compaction!.details.readFiles, ["dropped-read.ts", "src/a.ts"]);
	assert.deepEqual(r.compaction!.details.modifiedFiles, ["src/b.ts"]);
	const record = r.compaction!.details.smartCompact;
	assert.equal(record.mode, "live");
	assert.equal(record.kind, "compact");
	// u_prev (the previous summary) is pinned keep and counts — it survives as the head.
	assert.deepEqual(record.classCounts, { keep: 3, summarize: 1, drop: 2 });
	assert.deepEqual(record.usage, { decisionInputTokens: 321, summaryInputTokens: 111, summaryOutputTokens: 22 });
	assert.ok(record.units.some((u) => u.id === "u_2" && u.action === "drop"));
});

test("split-turn compaction: history ∪ prefix summarized as one composed document", async () => {
	const capture: Capture = { summarizeCalls: [] };
	const r = await runLive(
		liveDeps(FIXTURE_ANSWERS, capture),
		OPTS(),
		PROFILE,
		liveRegion({
			messages: [
				...fixtureMessages(),
				user("split turn prompt"),
				assistant([{ type: "toolCall", id: "c9", name: "bash", arguments: { cmd: "npm test" } }]),
				toolResult("c9", "bash", "all green"),
			],
		}),
	);
	assert.equal(r.outcome, "compacted");
	assert.ok(r.compaction);
	// Prefix keeps ride verbatim in the same doc as the summarized history.
	assert.ok(r.compaction!.summary.includes("[User]: split turn prompt"));
	assert.ok(r.compaction!.summary.includes('[Assistant tool calls]: bash(cmd="npm test")'));
	assert.equal(capture.summarizeCalls[0].msgs.length, 1, "only the history's summarize unit reaches the LLM");
});

test("all-keep region: zero LLM calls, keeps + tags only; the gate still guards the re-trigger loop", async () => {
	const capture: Capture = { summarizeCalls: [] };
	const answers = {
		u_1_call: { type: "choice", choice: "keep", confidence: 0.9 },
		u_2: { type: "choice", choice: "keep", confidence: 0.9 },
	};
	const region = liveRegion({
		messages: [
			user("keep these instructions"),
			assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }]),
			toolResult("c1", "read", "tiny"),
		],
		previousSummary: undefined,
	});
	const r = await runLive(liveDeps(answers, capture), OPTS(0), PROFILE, region); // 0 disables the gate
	assert.equal(r.outcome, "compacted");
	assert.equal(capture.summarizeCalls.length, 0, "all-keep costs zero LLM calls");
	assert.ok(r.compaction);
	assert.ok(r.compaction!.summary.includes("[User]: keep these instructions"));
	assert.ok(!r.compaction!.usage, "no summarizer usage on an all-keep run");
	assert.equal(r.compaction!.details.smartCompact.usage.summaryInputTokens, 0);

	// Same region near the trigger threshold: the all-keep composition doesn't shrink the
	// context enough → the gate fails the run to native (re-trigger loop guard, SPEC §6.6).
	const collected: unknown[] = [];
	const deps2 = liveDeps(answers, capture);
	deps2.writeTelemetry = (record) => collected.push(record);
	const r4 = await runLive(deps2, OPTS(50), PROFILE, { ...region, tokensBefore: 200 });
	assert.equal(r4.outcome, "fallback");
	assert.equal(r4.compaction, undefined);
	assert.match(r4.toast, /fell back to native \(reduction .* below minReductionPct 50%\)/);
	const record = collected[0] as { fallback: { rung: number }; reductionPct: number };
	assert.equal(record.fallback.rung, 4);
	assert.ok(record.reductionPct < 50);
});

test("composition missing minReductionPct → native entry, telemetry records rung 4; minReductionPct 0 disables", async () => {
	const capture: Capture = { summarizeCalls: [] };
	const collected: unknown[] = [];
	const deps = liveDeps(FIXTURE_ANSWERS, capture);
	deps.writeTelemetry = (record) => collected.push(record);
	// A 100% bar can never pass → rung 4.
	const r = await runLive(deps, OPTS(100), PROFILE, liveRegion());
	assert.equal(r.outcome, "fallback");
	assert.equal(r.compaction, undefined);
	assert.match(r.toast, /fell back to native \(reduction .* below minReductionPct 100%\)$/);
	const record = collected[0] as { fallback: { rung: number; error: string }; mode: string; reductionPct: number };
	assert.equal(record.mode, "live");
	assert.equal(record.fallback.rung, 4);
	assert.match(record.fallback.error, /below minReductionPct 100%/);
	assert.ok(record.reductionPct < 100);

	// Gate disabled: the same composition persists.
	const r0 = await runLive(liveDeps(FIXTURE_ANSWERS, { summarizeCalls: [] }), OPTS(0), PROFILE, liveRegion());
	assert.equal(r0.outcome, "compacted");
});

test("summarizer failure → native at rung 3, no retry, no salvage", async () => {
	const capture: Capture = { summarizeCalls: [] };
	const collected: unknown[] = [];
	const deps = liveDeps(FIXTURE_ANSWERS, capture, async () => {
		throw new Error("auth failed: bad key");
	});
	deps.writeTelemetry = (record) => collected.push(record);
	const r = await runLive(deps, OPTS(), PROFILE, liveRegion());
	assert.equal(r.outcome, "fallback");
	assert.equal(r.compaction, undefined);
	assert.equal(capture.summarizeCalls.length, 1, "no retry after the single failure");
	assert.match(r.toast, /fell back to native \(rung 3: auth failed: bad key\)/);
	const record = collected[0] as { fallback: { rung: number; error: string }; latencyMs: { summary: number } };
	assert.equal(record.fallback.rung, 3);
	assert.match(record.fallback.error, /auth failed/);
	assert.equal(typeof record.latencyMs.summary, "number");
});

test("empty classes omit their sections — all-drop → LLM section only; no placeholders anywhere", async () => {
	const capture: Capture = { summarizeCalls: [] };
	const answers = {
		u_0_text: { type: "choice", choice: "summarize", confidence: 0.9 },
		u_0_call: { type: "choice", choice: "drop", confidence: 0.9 },
		u_1: { type: "choice", choice: "drop", confidence: 0.9 },
	};
	const r = await runLive(
		liveDeps(answers, capture),
		OPTS(0),
		PROFILE,
		liveRegion({
			messages: [
				assistant([{ type: "text", text: "prose worth compressing" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }]),
				toolResult("c1", "read", "bulk output"),
			],
			previousSummary: undefined,
		}),
	);
	assert.equal(r.outcome, "compacted");
	assert.ok(r.compaction);
	assert.ok(!r.compaction!.summary.includes("## Kept verbatim"), "empty keep class omitted");
	assert.ok(!r.compaction!.summary.includes("dropped"), "silent drops — no tombstones");
	assert.ok(r.compaction!.summary.startsWith("## Goal"), "LLM section leads the headless doc");
	assert.ok(r.compaction!.summary.endsWith("</read-files>"), "tags still appended");
	// Both the dropped call AND its dropped result are silent: repair min() keeps the pair consistent.
});

test("live toast matches the spec format: kept X · summarized Y · dropped Z — A → B tok (−N%)", async () => {
	const capture: Capture = { summarizeCalls: [] };
	const r = await runLive(liveDeps(FIXTURE_ANSWERS, capture), OPTS(), PROFILE, liveRegion());
	assert.ok(r.toast);
	// kept 3 = u_prev (the head) + user + call
	assert.match(
		r.toast,
		/^smart-compact: kept 3 · summarized 1 · dropped 2 — [\d.]+k? → [\d.]+k? tok \(−[\d.]+%\)$/,
	);
});

test("keptRegionTokens estimates the entries pi keeps outside the compaction entry", () => {
	const entries = [
		{ type: "message", id: "e1", message: { role: "user", content: "abcd" } }, // 1 tok
		{ type: "message", id: "e2", message: { role: "user", content: "x".repeat(80) } }, // 20 tok
		{ type: "compaction", id: "e3", summary: "not counted" },
		{ type: "message", id: "e4", message: { role: "user", content: "y".repeat(40) } }, // 10 tok
	] as never[];
	assert.equal(keptRegionTokens(entries, "e2"), 30);
	assert.equal(keptRegionTokens(entries, "missing"), 31, "unknown id → keep-everything estimate (safe)");
});

// ---- shell wiring: mode "live" through run() returns the compaction for pi to persist ----

import { run } from "../extensions/smart-compact/index.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

test("shell live mode: persisted compaction result + info toast; telemetry with live usage", async () => {
	useKey();
	try {
		await withAgentDir(async (dir) => {
			const calls: unknown[][] = [];
			const ctx = { ui: { notify: (...args: unknown[]) => calls.push(args) } } as unknown as ExtensionContext;
			const pi = { getSettings: () => ({ smartCompact: { mode: "live" } }) } as unknown as ExtensionAPI;
			const evt = {
				type: "session_before_compact",
				preparation: {
					messagesToSummarize: fixtureMessages(),
					turnPrefixMessages: [user("prefix prompt")],
					fileOps: { read: new Set(["src/store.ts"]), written: new Set(), edited: new Set() },
					tokensBefore: 100_000,
					previousSummary: "HEAD-DOC v1",
					firstKeptEntryId: "entry-keep",
					settings: { reserveTokens: 16384 },
				},
				customInstructions: "focus on the parser",
				branchEntries: [],
				signal: new AbortController().signal,
			};
			const capture: Capture = { summarizeCalls: [] };
			const result = await run(pi, ctx, new Set<string>(), evt as never, "compact", stubMakeClient(FIXTURE_ANSWERS, capture), stubMakeSummarizer(capture));

			assert.ok(result && typeof result === "object" && "compaction" in result && result.compaction, "compaction returned for pi to persist");
			assert.ok(capture.summarizeCalls[0].opts && String((capture.summarizeCalls[0].opts as { customInstructions: string }).customInstructions).includes("focus on the parser"));
			// The union region reached the pipeline: prefix user unit is present in the state.
			const state = capture.requests![0].state as { region: { id: string; text: string }[] };
			assert.ok(state.region.some((e) => e.text === "prefix prompt"));
			assert.ok(result.compaction.summary.includes("[User]: prefix prompt"));
			assert.ok(calls.length >= 1 && String(calls[0][0]).startsWith("smart-compact: kept "));
			assert.equal(calls[0][1], "info");
			assert.ok(!String(calls[0][0]).includes("[shadow]"), "no shadow tag on live toasts");

			// Telemetry record landed with mode live + summary usage.
			const record = JSON.parse(readFileSync(join(dir, "smart-compact", "telemetry.jsonl"), "utf8").trim());
			assert.equal(record.mode, "live");
			assert.equal(record.usage.summaryInputTokens, 111);
			assert.equal(record.usage.summaryOutputTokens, 22);
		});
	} finally {
		restoreKey();
	}
});

// Live-mode branch summaries are covered by test/branch.test.ts (ticket 07).
