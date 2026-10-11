import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import smartCompact from "../extensions/smart-compact/index.ts";

interface Call {
	args: unknown[];
}

function setup(settings: unknown) {
	const handlers: Record<string, (event: any, ctx: any) => Promise<unknown>> = {};
	const pi: any = {
		on: (name: string, handler: (event: any, ctx: any) => Promise<unknown>) => {
			handlers[name] = handler;
			return () => {};
		},
		getSettings: () => ({ smartCompact: settings }),
	};
	smartCompact(pi);
	const ctx: any = { ui: { notify: (...args: unknown[]) => ctx.calls.push({ args }) } };
	ctx.calls = [] as Call[];
	return { handlers, ctx };
}

const compactEvt = {
	type: "session_before_compact",
	preparation: {
		messagesToSummarize: [],
		turnPrefixMessages: [],
		fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		tokensBefore: 0,
		firstKeptEntryId: "keep-1",
		settings: { reserveTokens: 16384 },
	},
	branchEntries: [],
	signal: new AbortController().signal,
};
const treeEvt = (wants: boolean) => ({ type: "session_before_tree", preparation: { userWantsSummary: wants }, signal: new AbortController().signal });

const ENV_KEY = "OPTOLLM_API_KEY";
let savedKey: string | undefined;
afterEach(() => {
	if (savedKey === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = savedKey;
});

test("registers both compaction hooks plus session_start", () => {
	const { handlers } = setup(undefined);
	assert.ok(handlers.session_before_compact, "session_before_compact registered");
	assert.ok(handlers.session_before_tree, "session_before_tree registered");
	assert.ok(handlers.session_start, "session_start registered");
});

/** Deferred toasts (§8.2, post-rebuild) land on a macrotask — flush before asserting. */
function tick(ms = 20) {
	return new Promise<void>((r) => setTimeout(r, ms));
}

test("no config + key present: native, silent (indistinguishable from native)", async () => {
	savedKey = process.env[ENV_KEY];
	process.env[ENV_KEY] = "sk-test";
	const { handlers, ctx } = setup(undefined);
	const r = await handlers.session_before_compact(compactEvt, ctx);
	assert.equal(r, undefined);
	assert.equal(ctx.calls.length, 0);
});

test("no config + missing key: native + one warn naming the env var", async () => {
	savedKey = process.env[ENV_KEY];
	delete process.env[ENV_KEY];
	const { handlers, ctx } = setup(undefined);
	assert.equal(await handlers.session_before_compact(compactEvt, ctx), undefined);
	await tick();
	assert.equal(ctx.calls.length, 1);
	assert.match(ctx.calls[0].args[0] as string, /OPTOLLM_API_KEY/);
	assert.equal(ctx.calls[0].args[1], "warning");

	// warn-once per session: second compaction stays silent
	await handlers.session_before_compact(compactEvt, ctx);
	assert.equal(ctx.calls.length, 1);

	// new session warns again
	await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
	await handlers.session_before_compact(compactEvt, ctx);
	await tick();
	assert.equal(ctx.calls.length, 2);
});

test("adding the key mid-session resumes the smart path (warn stops)", async () => {
	savedKey = process.env[ENV_KEY];
	delete process.env[ENV_KEY];
	const { handlers, ctx } = setup(undefined);
	await handlers.session_before_compact(compactEvt, ctx);
	await tick();
	assert.equal(ctx.calls.length, 1);

	process.env[ENV_KEY] = "sk-test";
	await handlers.session_before_compact(compactEvt, ctx);
	assert.equal(ctx.calls.length, 1); // no new warn, no rung-0
});

test("mode off is fully inert — no warn even with missing key and broken knobs", async () => {
	savedKey = process.env[ENV_KEY];
	delete process.env[ENV_KEY];
	const { handlers, ctx } = setup({ mode: "off", privacy: "bogus", keptMessages: -1 });
	assert.equal(await handlers.session_before_compact(compactEvt, ctx), undefined);
	assert.equal(await handlers.session_before_tree(treeEvt(true), ctx), undefined);
	assert.equal(ctx.calls.length, 0);
});

test("invalid config: loud warn naming the problem + native, every case", async () => {
	savedKey = process.env[ENV_KEY];
	process.env[ENV_KEY] = "sk-test"; // key present so the warn can only come from validation
	const cases: [string, unknown, RegExp][] = [
		["bad matrix row", { matrix: { user: ["kepp"] } }, /unknown action "kepp"/],
		["bad matrix row type", { matrix: { thinking: [] } }, /matrix\.thinking.*non-empty/],
		["unknown profile", { backend: "freejev" }, /backend/],
		["bad profile field", { profiles: { clef: { confidenceFloor: 9 } } }, /confidenceFloor/],
		["bad mode", { mode: "fast" }, /mode/],
		["bad privacy", { privacy: "nope" }, /privacy/],
		["bad minReductionPct", { minReductionPct: 101 }, /minReductionPct/],
		["bad keptMessages", { keptMessages: -1 }, /keptMessages/],
	];
	for (const [name, cfg, pattern] of cases) {
		const { handlers, ctx } = setup(cfg);
		assert.equal(await handlers.session_before_compact(compactEvt, ctx), undefined, name);
		await tick();
		assert.equal(ctx.calls.length, 1, `${name}: exactly one warn`);
		assert.match(ctx.calls[0].args[0] as string, /invalid config/, name);
		assert.match(ctx.calls[0].args[0] as string, pattern, name);
		assert.equal(ctx.calls[0].args[1], "warning", name);
	}
});

test("invalid config warns loud on every run (warn-once is rung 0 only)", async () => {
	const { handlers, ctx } = setup({ mode: "fast" });
	await handlers.session_before_compact(compactEvt, ctx);
	await handlers.session_before_compact(compactEvt, ctx);
	await tick();
	assert.equal(ctx.calls.length, 2);
});

test("tree navigation without summary is a pure no-op", async () => {
	savedKey = process.env[ENV_KEY];
	delete process.env[ENV_KEY];
	const { handlers, ctx } = setup({ mode: "fast" }); // invalid config AND no key
	assert.equal(await handlers.session_before_tree(treeEvt(false), ctx), undefined);
	assert.equal(ctx.calls.length, 0);
});

test("tree navigation with summary runs the same shell", async () => {
	savedKey = process.env[ENV_KEY];
	delete process.env[ENV_KEY];
	const { handlers, ctx } = setup(undefined);
	assert.equal(await handlers.session_before_tree(treeEvt(true), ctx), undefined);
	await tick();
	assert.equal(ctx.calls.length, 1);
	assert.match(ctx.calls[0].args[0] as string, /OPTOLLM_API_KEY/);
});

test("project settings reach the shell via pi.getSettings (merged view)", async () => {
	savedKey = process.env[ENV_KEY];
	process.env[ENV_KEY] = "sk-test";
	// pi deep-merges user+project before getSettings; simulate the merged result:
	// project matrix row wins, absent rows keep user/default values.
	const merged = { matrix: { thinking: ["drop"] } };
	const { handlers, ctx } = setup(merged);
	assert.equal(await handlers.session_before_compact(compactEvt, ctx), undefined);
	assert.equal(ctx.calls.length, 0); // merged config valid + keyed -> silent native
});


// ---- ticket 02 wiring: shadow pipeline behind the shell gates ----

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../extensions/smart-compact/index.ts";
import type { DecisionBatch, DecisionClient } from "../extensions/smart-compact/client.ts";
import { clientOptionsFor, effectiveProfile } from "../extensions/smart-compact/config.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

let savedAgentDir: string | undefined;
function withAgentDir(mutate: (dir: string) => void | Promise<void>) {
	return async () => {
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		const dir = mkdtempSync(join(tmpdir(), "sc-shell-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			await mutate(dir);
		} finally {
			if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		}
	};
}

const regionEvt = () => ({
	type: "session_before_compact",
	preparation: {
		messagesToSummarize: [
			{ role: "user", content: "build the thing", timestamp: 0 },
			{ role: "assistant", content: [{ type: "text", text: "on it" }], timestamp: 0 },
		],
	},
	signal: new AbortController().signal,
});

function ctxCapture() {
	const calls: unknown[][] = [];
	const ctx = { ui: { notify: (...args: unknown[]) => calls.push(args) } } as unknown as ExtensionContext;
	return { ctx, calls };
}

function stubClient(answers: unknown, calls: { n: number }) {
	return (_backend: string, _profile: unknown, _timeoutMs: number): DecisionClient => ({
		async decide(): Promise<DecisionBatch> {
			calls.n++;
			return { ok: true, answers: answers as Record<string, never>, model: "clef", inputTokens: 42 };
		},
	});
}

function shadowPi() {
	return { getSettings: () => ({ smartCompact: { mode: "shadow" } }) } as unknown as ExtensionAPI;
}

test("mode live with empty region: silent native (skip before any LLM use)", async () => {
	savedKey = process.env[ENV_KEY];
	process.env[ENV_KEY] = "sk-test";
	const { handlers, ctx } = setup({ mode: "live" });
	assert.equal(await handlers.session_before_compact(compactEvt, ctx), undefined);
	assert.equal(ctx.calls.length, 0);
});

test("shadow mode: pipeline runs, toast shows, telemetry record lands, native returned", async () => {
	await withAgentDir(async (dir) => {
		const { ctx, calls } = ctxCapture();
		const clientCalls = { n: 0 };
		const result = await run(shadowPi(), ctx, new Set<string>(), regionEvt() as never, "compact", stubClient({ u_1_text: { type: "choice", choice: "summarize", confidence: 0.9 } }, clientCalls));
		assert.equal(result, undefined); // shadow always returns native
		assert.equal(clientCalls.n, 1);
		await tick();
		assert.deepEqual(calls[0][1], "info");
		assert.match(String(calls[0][0]), /^smart-compact \[shadow\]: would keep 1 · summarize 1 · drop 0 .— native ran$/);
		const file = join(dir, "smart-compact", "telemetry.jsonl");
		assert.ok(existsSync(file), "telemetry written");
		const record = JSON.parse(readFileSync(file, "utf8").trim());
		assert.equal(record.mode, "shadow");
		assert.equal(record.kind, "compact");
		assert.equal(record.usage.decisionInputTokens, 42);
		assert.equal(record.units.length, 2);
	});
});

test("shadow mode with malformed questions.json: loud warn + native, no client call", async () => {
	await withAgentDir(async (dir) => {
		writeFileSync(join(dir, "smart-compact", "questions.json"), "{broken");
		const { ctx, calls } = ctxCapture();
		const clientCalls = { n: 0 };
		const result = await run(shadowPi(), ctx, new Set<string>(), regionEvt() as never, "compact", stubClient({}, clientCalls));
		assert.equal(result, undefined);
		assert.equal(clientCalls.n, 0, "no decision call");
		await tick();
		assert.equal(calls.length, 1);
		assert.match(String(calls[0][0]), /questions\.json/);
		assert.match(String(calls[0][0]), /not valid JSON/);
		assert.deepEqual(calls[0][1], "warning");
	});
});

test("shadow branch summary: same pipeline, [shadow][branch] toast, kind=branch record", async () => {
	await withAgentDir(async (dir) => {
		const { ctx, calls } = ctxCapture();
		const treeEvt = {
			type: "session_before_tree",
			preparation: {
				userWantsSummary: true,
				entriesToSummarize: [{ type: "message", message: { role: "user", content: "branch work", timestamp: 0 } }],
			},
			signal: new AbortController().signal,
		};
		await run(shadowPi(), ctx, new Set<string>(), treeEvt as never, "branch", stubClient({}, { n: 0 }));
		await tick();
		assert.match(String(calls[0][0]), /^smart-compact \[shadow\]\[branch\]/);
		const record = JSON.parse(readFileSync(join(dir, "smart-compact", "telemetry.jsonl"), "utf8").trim());
		assert.equal(record.kind, "branch");
	});
});

test("shadow + transport failure: native, warn toast, rung-1 record", async () => {
	await withAgentDir(async (dir) => {
		const { ctx, calls } = ctxCapture();
		const makeFailing = (): DecisionClient => ({
			async decide(): Promise<DecisionBatch> {
				return { ok: false, error: { kind: "timeout", retryable: false, rung: 1, message: "decision timed out after 5ms" } };
			},
		});
		await run(shadowPi(), ctx, new Set<string>(), regionEvt() as never, "compact", makeFailing);
		await tick();
		assert.deepEqual(calls[0][1], "warning");
		assert.match(String(calls[0][0]), /rung 1/);
		const record = JSON.parse(readFileSync(join(dir, "smart-compact", "telemetry.jsonl"), "utf8").trim());
		assert.equal(record.fallback.rung, 1);
	});
});

// ---- ticket 08: one adapter, per-backend factory dispatch ----

const p = (b: string) => effectiveProfile(b, undefined);

test("client factory dispatch: env key + wire deltas per backend", () => {
	const base = (endpoint: string) => ({ endpoint, timeoutMs: 5000 });
	assert.deepEqual(clientOptionsFor("clef", p("clef"), 5000, { OPTOLLM_API_KEY: "oc" }), {
		...base("https://optollm.optomatica.com/v1/systemone"),
		apiKey: "oc",
		omitModel: false,
		idempotency: false,
	});
	assert.deepEqual(clientOptionsFor("jev", p("jev"), 5000, { FREEJEV_API_KEY: "fj" }), {
		...base("https://freejev.org/api/v1/decisions"),
		apiKey: "fj",
		omitModel: true, // model pinned server-side
		idempotency: true, // mandatory Idempotency-Key
	});
	assert.deepEqual(clientOptionsFor("ollama", p("ollama"), 5000, {}), {
		...base("http://localhost:11434/v1/systemone"),
		apiKey: "",
		omitModel: false,
		idempotency: false,
	});
	assert.deepEqual(clientOptionsFor("jev-direct", p("jev-direct"), 5000, { TYPESAFE_API_KEY: "ts" }), {
		...base("https://api.typesafe.ai/v1/systemone"),
		apiKey: "ts",
		omitModel: false,
		idempotency: false,
	});
	// unwired profile: dead client, never called (decideRegion fails rung 1 first)
	assert.equal(clientOptionsFor("nope", null, 5000, {}).endpoint, "");
	assert.equal(clientOptionsFor("clef", p("clef"), 5000, {}).apiKey, "");
});
