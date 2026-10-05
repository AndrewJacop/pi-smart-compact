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

const compactEvt = { type: "session_before_compact", preparation: {}, signal: new AbortController().signal };
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
	assert.equal(ctx.calls.length, 1);
	assert.match(ctx.calls[0].args[0] as string, /OPTOLLM_API_KEY/);
	assert.equal(ctx.calls[0].args[1], "warning");

	// warn-once per session: second compaction stays silent
	await handlers.session_before_compact(compactEvt, ctx);
	assert.equal(ctx.calls.length, 1);

	// new session warns again
	await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
	await handlers.session_before_compact(compactEvt, ctx);
	assert.equal(ctx.calls.length, 2);
});

test("adding the key mid-session resumes the smart path (warn stops)", async () => {
	savedKey = process.env[ENV_KEY];
	delete process.env[ENV_KEY];
	const { handlers, ctx } = setup(undefined);
	await handlers.session_before_compact(compactEvt, ctx);
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
