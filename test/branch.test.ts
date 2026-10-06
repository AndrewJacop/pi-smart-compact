import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DecisionBatch, DecisionRequest } from "../extensions/smart-compact/client.ts";
import { DEFAULT_MATRIX, effectiveProfile } from "../extensions/smart-compact/config.ts";
import { BRANCH_FOCUS, runLive, type LiveDeps, type LiveRegion } from "../extensions/smart-compact/live.ts";
import { run } from "../extensions/smart-compact/index.ts";
import { loadQuestionSet } from "../extensions/smart-compact/pipeline.ts";
import { assistant, toolResult, user, stubMakeClient, stubMakeSummarizer, SUMMARY_USAGE, useKey, restoreKey, withAgentDir, type Capture } from "./helpers.ts";

const DEFAULT_QUESTIONS = fileURLToPath(new URL("../extensions/smart-compact/questions.default.json", import.meta.url));
const PROFILE = effectiveProfile("clef", undefined);

// Same classification as the live fixture: think drop, text summarize, call keep, result drop.
// Indices over branchEntries(): u_0 prior summary (pinned), u_1 user (pinned), u_2 assistant, u_3 result.
const FIXTURE_ANSWERS = {
	u_2_think: { type: "choice", choice: "drop", confidence: 0.9 },
	u_2_text: { type: "choice", choice: "summarize", confidence: 0.9 },
	u_2_call: { type: "choice", choice: "keep", confidence: 0.9 },
	u_3: { type: "choice", choice: "drop", confidence: 0.9 },
};

/** The abandoned branch: a prior branch summary (cumulative file lists) + one full turn. */
function branchEntries(): never[] {
	return [
		{ type: "branch_summary", id: "bs1", summary: "earlier exploration notes", fromHook: false, details: { readFiles: ["prior.ts"], modifiedFiles: [] } },
		{ type: "message", id: "e1", message: user("Branch goal: speed up the test suite.") },
		{
			type: "message",
			id: "e2",
			message: assistant([
				{ type: "thinking", thinking: "Find the slow test first." },
				{ type: "text", text: "On it — profiling the suite." },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/store.ts" } },
			]),
		},
		{ type: "message", id: "e3", message: toolResult("c1", "read", `// src/store.ts dump\n${"x".repeat(5000)}`) },
	] as never[];
}

function treeEvt(over: Record<string, unknown> = {}): never {
	return {
		type: "session_before_tree",
		preparation: { userWantsSummary: true, entriesToSummarize: branchEntries(), customInstructions: "note the flaky test", ...over },
		signal: new AbortController().signal,
	} as never;
}

// ---- unit level: runLive with kind "branch" ----

function branchRegion(over: Partial<LiveRegion> = {}): LiveRegion {
	return {
		// Same unit order as branchEntries(): prior summary (u_0, pinned), user, assistant, toolResult —
		// so both fixture levels share FIXTURE_ANSWERS.
		messages: [
			{ role: "user", content: [{ type: "text", text: "earlier exploration notes" }], timestamp: 0 },
			user("Branch goal: speed up the test suite."),
			assistant([
				{ type: "thinking", thinking: "Find the slow test first." },
				{ type: "text", text: "On it — profiling the suite." },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/store.ts" } },
			]),
			toolResult("c1", "read", `// src/store.ts dump\n${"x".repeat(5000)}`),
		],
		previousSummary: undefined,
		fileOps: { read: new Set(["a.ts"]), written: new Set(), edited: new Set() },
		tokensBefore: 100_000,
		keptRegionTokens: 0,
		reserveTokens: 16384,
		firstKeptEntryId: "",
		customInstructions: undefined,
		signal: undefined,
		kind: "branch",
		...over,
	};
}

function liveDeps(capture: Capture): LiveDeps {
	const q = loadQuestionSet({ defaultPath: DEFAULT_QUESTIONS });
	assert.equal(q.ok, true, "bundled question set must load");
	return {
		client: {
			async decide(req: DecisionRequest): Promise<DecisionBatch> {
				capture.requests!.push(req);
				return { ok: true, answers: FIXTURE_ANSWERS as unknown as Record<string, never>, model: "clef", inputTokens: 321 };
			},
		},
		writeTelemetry: () => {},
		questionSet: q.ok ? q.questions : {},
		summarize: async (msgs, opts) => {
			capture.summarizeCalls.push({ msgs: [...msgs], opts });
			return { text: "## Goal\nbuild the limiter", usage: SUMMARY_USAGE };
		},
	};
}

test("branch runLive: telemetry record carries kind \"branch\" and the toast is tagged [branch]", async () => {
	const capture: Capture = { requests: [], summarizeCalls: [] };
	const collected: unknown[] = [];
	const deps = liveDeps(capture);
	deps.writeTelemetry = (record) => collected.push(record);
	const r = await runLive(deps, { backend: "clef", matrix: DEFAULT_MATRIX, minReductionPct: 0 }, PROFILE, branchRegion());
	assert.equal(r.outcome, "compacted");
	assert.match(r.toast, /^smart-compact \[branch\]: kept /);
	assert.match(r.toast, / — .+ → .+ tok \(−[\d.]+%\)$/);
	const record = collected[0] as { kind: string; mode: string };
	assert.equal(record.kind, "branch");
	assert.equal(record.mode, "live");
});

test("branch summarizer focus: BRANCH_FOCUS appended (section list stated) between the focus and the scoping line — never a prompt swap", async () => {
	const capture: Capture = { requests: [], summarizeCalls: [] };
	await runLive(liveDeps(capture), { backend: "clef", matrix: DEFAULT_MATRIX, minReductionPct: 0 }, PROFILE, branchRegion({ customInstructions: "note the flaky test" }));
	assert.equal(capture.summarizeCalls.length, 1);
	const instructions = (capture.summarizeCalls[0].opts as { customInstructions: string }).customInstructions;
	assert.match(instructions, /^note the flaky test/);
	assert.match(instructions, /Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps/);
	assert.match(instructions, /Summarize only the messages above; the rest of the region is preserved verbatim alongside this summary\.$/);
	// The branch directive is the shared constant — appended as focus text, not a replacement prompt.
	assert.ok(instructions.includes(BRANCH_FOCUS));
});

test("branch gate: minReductionPct still fails the rung on the region→composed delta (no cut point, kept region is zero)", async () => {
	const capture: Capture = { requests: [], summarizeCalls: [] };
	const collected: unknown[] = [];
	const deps = liveDeps(capture);
	deps.writeTelemetry = (record) => collected.push(record);
	const r = await runLive(deps, { backend: "clef", matrix: DEFAULT_MATRIX, minReductionPct: 100 }, PROFILE, branchRegion({ tokensBefore: 200 }));
	assert.equal(r.outcome, "fallback");
	assert.match(r.toast, /^smart-compact \[branch\]: fell back to native \(reduction .* below minReductionPct 100%\)$/);
	assert.equal((collected[0] as { kind: string; fallback: { rung: number } }).kind, "branch");
	assert.equal((collected[0] as { fallback: { rung: number } }).fallback.rung, 4);
});

// ---- shell wiring: live branch through run() ----

test("live branch: same pipeline summary labeled smart-compact, details file lists, kind=branch record, [branch] toast", async () => {
	useKey();
	try {
		await withAgentDir(async (dir) => {
			const calls: unknown[][] = [];
			const ctx = { ui: { notify: (...args: unknown[]) => calls.push(args) } } as unknown as ExtensionContext;
			const pi = { getSettings: () => ({ smartCompact: { mode: "live" } }) } as unknown as ExtensionAPI;
			const capture: Capture = { requests: [], summarizeCalls: [] };
			const result = await run(pi, ctx, new Set<string>(), treeEvt(), "branch", stubMakeClient(FIXTURE_ANSWERS, capture), stubMakeSummarizer(capture));

			// Result shape: pi consumes summary{summary,details,usage} + label.
			assert.ok(result && typeof result === "object" && "summary" in result && result.summary, "summary returned for pi to persist");
			assert.equal(result.label, "smart-compact");
			const { summary, details, usage } = result.summary;
			assert.deepEqual(usage, SUMMARY_USAGE);
			assert.equal((details as { smartCompact: { kind: string; mode: string } }).smartCompact.kind, "branch");
			assert.equal((details as { smartCompact: { mode: string } }).smartCompact.mode, "live");

			// The composed document: LLM section → Kept verbatim (prior summary + user pinned + kept call,
			// orphan marker for the dropped result) → file tags.
			assert.ok(summary.startsWith("## Goal\nbuild the limiter"));
			assert.ok(summary.includes("[User]: earlier exploration notes"), "prior branch summary rides the doc");
			assert.ok(summary.includes("[User]: Branch goal: speed up the test suite."));
			assert.ok(summary.includes('[Assistant tool calls]: read(path="src/store.ts")'));
			assert.equal(summary.split("[Tool result dropped:").length - 1, 1);
			// Whole-span file lists: the branch_summary's cumulative read + this turn's read tool call.
			assert.deepEqual((details as { readFiles: string[] }).readFiles, ["prior.ts", "src/store.ts"]);
			assert.deepEqual((details as { modifiedFiles: string[] }).modifiedFiles, []);

			// Dropped units appear in neither the injected summary nor its LLM input.
			assert.ok(!summary.includes("Find the slow test"), "dropped thinking absent from summary");
			assert.ok(!summary.includes("src/store.ts dump"), "dropped result body absent from summary");
			assert.equal(capture.summarizeCalls.length, 1);
			assert.deepEqual(capture.summarizeCalls[0].msgs[0], {
				...assistant([{ type: "text", text: "On it — profiling the suite." }]),
			});
			assert.ok(String((capture.summarizeCalls[0].opts as { customInstructions: string }).customInstructions).includes(BRANCH_FOCUS));

			// Toast + telemetry.
			assert.deepEqual(calls[0][1], "info");
			assert.match(String(calls[0][0]), /^smart-compact \[branch\]: kept 3 · summarized 1 · dropped 2 — .+ → .+ tok \(−[\d.]+%\)$/);
			const record = JSON.parse(readFileSync(join(dir, "smart-compact", "telemetry.jsonl"), "utf8").trim());
			assert.equal(record.kind, "branch");
			assert.equal(record.mode, "live");
			assert.equal(record.usage.summaryInputTokens, 111);
		});
	} finally {
		restoreKey();
	}
});

test("live branch fallback: decision failure → undefined (pi's native branch summary), [branch] warn, rung-1 record", async () => {
	useKey();
	try {
		await withAgentDir(async (dir) => {
			const calls: unknown[][] = [];
			const ctx = { ui: { notify: (...args: unknown[]) => calls.push(args) } } as unknown as ExtensionContext;
			const pi = { getSettings: () => ({ smartCompact: { mode: "live" } }) } as unknown as ExtensionAPI;
			const capture: Capture = { requests: [], summarizeCalls: [] };
			const failing = (_backend: string, _profile: unknown, _timeoutMs: number) => ({
				async decide(): Promise<DecisionBatch> {
					capture.requests!.push({} as DecisionRequest);
					return { ok: false, error: { kind: "timeout", retryable: false, rung: 1 as const, message: "decision timed out" } };
				},
			});
			const result = await run(pi, ctx, new Set<string>(), treeEvt(), "branch", failing, stubMakeSummarizer(capture));
			assert.equal(result, undefined, "fail-open → pi's native branch summary");
			assert.equal(capture.summarizeCalls.length, 0);
			assert.deepEqual(calls[0][1], "warning");
			assert.match(String(calls[0][0]), /^smart-compact \[branch\]: fell back to native \(rung 1/);
			const record = JSON.parse(readFileSync(join(dir, "smart-compact", "telemetry.jsonl"), "utf8").trim());
			assert.equal(record.kind, "branch");
			assert.equal(record.fallback.rung, 1);
		});
	} finally {
		restoreKey();
	}
});

test("live branch gate: minReductionPct 100 fails the rung even with clean decisions (delta is region→composed)", async () => {
	useKey();
	try {
		await withAgentDir(async () => {
			const calls: unknown[][] = [];
			const ctx = { ui: { notify: (...args: unknown[]) => calls.push(args) } } as unknown as ExtensionContext;
			const pi = { getSettings: () => ({ smartCompact: { mode: "live", minReductionPct: 100 } }) } as unknown as ExtensionAPI;
			const capture: Capture = { requests: [], summarizeCalls: [] };
			const result = await run(pi, ctx, new Set<string>(), treeEvt(), "branch", stubMakeClient(FIXTURE_ANSWERS, capture), stubMakeSummarizer(capture));
			assert.equal(result, undefined);
			assert.match(String(calls[0][0]), /^smart-compact \[branch\]: fell back to native \(reduction .* below minReductionPct 100%\)$/);
		});
	} finally {
		restoreKey();
	}
});

test("live branch with an empty region: skipped silently → native", async () => {
	useKey();
	try {
		await withAgentDir(async () => {
			const calls: unknown[][] = [];
			const ctx = { ui: { notify: (...args: unknown[]) => calls.push(args) } } as unknown as ExtensionContext;
			const pi = { getSettings: () => ({ smartCompact: { mode: "live" } }) } as unknown as ExtensionAPI;
			const capture: Capture = { requests: [], summarizeCalls: [] };
			const evt = treeEvt({ entriesToSummarize: [{ type: "label", id: "l1", label: "x" }] });
			const result = await run(pi, ctx, new Set<string>(), evt, "branch", stubMakeClient(FIXTURE_ANSWERS, capture), stubMakeSummarizer(capture));
			assert.equal(result, undefined);
			assert.equal(capture.requests!.length, 0, "no decision call");
			assert.equal(calls.length, 0, "no toast");
		});
	} finally {
		restoreKey();
	}
});
