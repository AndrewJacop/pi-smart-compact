// Ticket 06 — kept-region clamp (SPEC §7): keptMessages:N moves pi's cut earlier-only
// (keep MORE, never less), exempts the newest N messages from every decision, and
// cancels cleanly when the clamp empties the summarizable span (the one documented
// exception to never-cancel — manual throws "Compaction cancelled", auto returns false).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DecisionBatch, DecisionClient, DecisionRequest } from "../extensions/smart-compact/client.ts";
import { clampKeptRegion, keptRegionTokens } from "../extensions/smart-compact/live.ts";
import { run } from "../extensions/smart-compact/index.ts";

// ---------- entry fixtures (raw path entries, as branchEntries carries them) ----------

let seq = 0;
function msgEntry(role: string, text: string): SessionEntry {
	return {
		id: `e${++seq}`,
		type: "message",
		message: { role, content: [{ type: "text", text }], timestamp: 0 },
		timestamp: new Date().toISOString(),
	} as never;
}
function compactionEntry(): SessionEntry {
	return { id: `e${++seq}`, type: "compaction", summary: "HEAD-DOC v0", timestamp: new Date().toISOString() } as never;
}

const USER = "user";
const ASSISTANT = "assistant";
const TOOL_RESULT = "toolResult";

// ---------- the pure clamp ----------

test("clamp: unset or 0 is a no-op — pi's cut consumed verbatim, nothing exempt", () => {
	const entries = [msgEntry(USER, "a"), msgEntry(ASSISTANT, "b"), msgEntry(USER, "c")];
	for (const kept of [undefined, 0]) {
		const r = clampKeptRegion(entries, "e2", kept);
		assert.ok(!r.cancel);
		assert.equal(r.firstKeptEntryId, "e2");
		assert.equal(r.exemptCount, 0);
	}
});

test("clamp: moves the cut earlier to the Nth-newest-message boundary, stepping back over toolResults", () => {
	// pi keeps e4,e5 (2 newest); N=3 wants e3..e5 — e3 is a toolResult, so the cut
	// lands on e2 (results always keep their call). Exempt = span msgs e2..e3.
	seq = 0;
	const entries = [msgEntry(USER, "1"), msgEntry(ASSISTANT, "2"), msgEntry(TOOL_RESULT, "r"), msgEntry(USER, "4"), msgEntry(ASSISTANT, "5")];
	const r = clampKeptRegion(entries, "e4", 3);
	assert.ok(!r.cancel);
	assert.equal(r.firstKeptEntryId, "e2", "kept span now covers e2..e5 ⊇ newest 3");
	assert.equal(r.exemptCount, 2, "the two span messages the clamped cut retains");
});

test("clamp: never keeps fewer than pi — a window already covering N leaves the cut verbatim", () => {
	seq = 0;
	const entries = [msgEntry(USER, "1"), msgEntry(ASSISTANT, "2"), msgEntry(TOOL_RESULT, "r"), msgEntry(USER, "4"), msgEntry(ASSISTANT, "5")];
	const r = clampKeptRegion(entries, "e4", 2);
	assert.ok(!r.cancel);
	assert.equal(r.firstKeptEntryId, "e4", "pi's cut kept verbatim");
	assert.equal(r.exemptCount, 0);
});

test("clamp: unknown firstKeptEntryId is consumed verbatim (pi degenerates to keep-everything)", () => {
	seq = 0;
	const entries = [msgEntry(USER, "1"), msgEntry(ASSISTANT, "2")];
	const r = clampKeptRegion(entries, "no-such-id", 5);
	assert.ok(!r.cancel);
	assert.equal(r.firstKeptEntryId, "no-such-id");
	assert.equal(r.exemptCount, 0);
});

test("clamp: N ≥ session length cancels — nothing legal left to summarize", () => {
	seq = 0;
	const entries = [msgEntry(USER, "1"), msgEntry(ASSISTANT, "2"), msgEntry(USER, "3")];
	assert.ok(clampKeptRegion(entries, "e3", 3).cancel, "N == message count");
	assert.ok(clampKeptRegion(entries, "e3", 99).cancel, "N beyond the session");
});

test("clamp: reaching back past the previous compaction boundary cancels (span emptied)", () => {
	seq = 0;
	const entries = [compactionEntry(), msgEntry(USER, "1"), msgEntry(ASSISTANT, "2"), msgEntry(TOOL_RESULT, "r"), msgEntry(USER, "4")];
	assert.ok(clampKeptRegion(entries, "e5", 4).cancel, "newest 4 reach past the compaction");
	const r = clampKeptRegion(entries, "e5", 3);
	assert.ok(!r.cancel, "newest 3 stay inside the span");
	assert.equal(r.firstKeptEntryId, "e3");
	assert.equal(r.exemptCount, 2);
});

// ---------- run()-level wiring (live mode) ----------

const ENV_KEY = "OPTOLLM_API_KEY";
let savedKey: string | undefined;
afterEach(() => {
	if (savedKey === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = savedKey;
});

const SUMMARY_USAGE = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

interface LiveHarness {
	requests: DecisionRequest[];
	summarizeMsgs: unknown[];
	client: (answers: unknown) => DecisionClient;
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	calls: unknown[][];
}

function liveHarness(cfg: Record<string, unknown>): LiveHarness {
	const h: LiveHarness = { requests: [], summarizeMsgs: [], calls: [], client: undefined as never, pi: undefined as never, ctx: undefined as never };
	h.client = (answers: unknown): DecisionClient => ({
		async decide(req: DecisionRequest): Promise<DecisionBatch> {
			h.requests.push(req);
			return { ok: true, answers: answers as Record<string, never>, model: "clef", inputTokens: 42 };
		},
	});
	h.pi = { getSettings: () => ({ smartCompact: cfg }) } as unknown as ExtensionAPI;
	h.ctx = { ui: { notify: (...args: unknown[]) => h.calls.push(args) } } as unknown as ExtensionContext;
	return h;
}

/** e1 assistant-text, e2 assistant-text, e3 user (pi's cut — keeps e3..e4), e4 toolResult. */
function clampEntries() {
	seq = 0;
	return [msgEntry(ASSISTANT, "old work"), msgEntry(ASSISTANT, "mid work"), msgEntry(USER, "goal two"), msgEntry(TOOL_RESULT, "out")];
}

/** pi's span = the messages before keptId (turnPrefixMessages empty — not a split turn). */
function liveEvent(entries: SessionEntry[], keptId: string) {
	const msg = (e: SessionEntry) => (e as { message: unknown }).message;
	const cut = entries.findIndex((e) => (e as { id: string }).id === keptId);
	return {
		type: "session_before_compact",
		preparation: {
			messagesToSummarize: entries.slice(0, cut < 0 ? entries.length : cut).map(msg),
			turnPrefixMessages: [],
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
			tokensBefore: 50_000,
			firstKeptEntryId: keptId,
			settings: { reserveTokens: 16384 },
		},
		branchEntries: entries,
		signal: new AbortController().signal,
	};
}

function liveRun(h: LiveHarness, event: unknown) {
	return run(
		h.pi,
		h.ctx,
		new Set<string>(),
		event as never,
		"compact",
		() =>
			h.client({
				u_0_text: { type: "choice", choice: "summarize", confidence: 0.9 },
				u_1_text: { type: "choice", choice: "summarize", confidence: 0.9 },
			}),
		() => async (summarizeMsgs) => {
			h.summarizeMsgs.push(...summarizeMsgs);
			return { text: "SUMMARY", usage: SUMMARY_USAGE as never };
		},
	);
}

test("live run with keptMessages: cut clamps earlier, exempt tail never asked, result carries the clamped id", async () => {
	savedKey = process.env[ENV_KEY];
	process.env[ENV_KEY] = "sk-test";
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sc-kept-"));
	try {
		const entries = clampEntries();
		// N=3: newest 3 = e2,e3,e4 → boundary e2; pi kept e3..e4 → cut moves to e2,
		// exempting e2's message from the region (span tail).
		const h = liveHarness({ mode: "live", keptMessages: 3 });
		const r = await liveRun(h, liveEvent(entries, "e3"));
		assert.ok(r && "compaction" in r && r.compaction, "smart compaction returned");
		assert.equal(r.compaction.firstKeptEntryId, "e2", "clamped cut id returned to pi");
		// Only the surviving region was decided: e1's assistant text (u_0_text). e2's message
		// is exempt — never asked (ticket acceptance, telemetry units); e3's user is pinned.
		assert.equal(h.requests.length, 1);
		assert.deepEqual(Object.keys(h.requests[0].questions), ["u_0_text"]);
		// The exempt messages reached neither the summarizer nor the composed doc; the whole
		// surviving region summarized → the doc is the LLM section alone (no keeps left in it).
		assert.equal(h.summarizeMsgs.length, 1);
		assert.equal(JSON.stringify(h.summarizeMsgs[0]).includes("mid work"), false);
		assert.equal(r.compaction.summary.includes("mid work"), false);
		assert.equal(r.compaction.summary.includes("goal two"), false, "exempt/kept messages stay out of the doc (they live via the cut)");
		assert.ok(r.compaction.summary.includes("SUMMARY"));
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
	}
});

/** Deferred toasts (§8.2, post-rebuild) land on a macrotask — flush before asserting. */
function tick(ms = 20) {
	return new Promise<void>((r) => setTimeout(r, ms));
}

test("live run with keptMessages ≥ session length: clean cancel, warn, on manual and keyless paths alike", async () => {
	const entries = clampEntries();
	// With key (manual /compact path): {cancel:true} → pi throws "Compaction cancelled".
	savedKey = process.env[ENV_KEY];
	process.env[ENV_KEY] = "sk-test";
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sc-kept-"));
	try {
		const h = liveHarness({ mode: "live", keptMessages: 99 });
		const r = await liveRun(h, liveEvent(entries, "e3"));
		assert.deepEqual(r, { cancel: true });
		assert.equal(h.requests.length, 0, "no decision call");
		await tick();
		assert.equal(h.calls.length, 1);
		assert.match(String(h.calls[0][0]), /keptMessages 99/);
		assert.equal(h.calls[0][1], "warning");

		// Keyless: the cancel still fires — it precedes rung 0 (config edge, not a decision).
		delete process.env[ENV_KEY];
		const h2 = liveHarness({ mode: "live", keptMessages: 99 });
		const r2 = await liveRun(h2, liveEvent(entries, "e3"));
		assert.deepEqual(r2, { cancel: true });
		assert.equal(h2.requests.length, 0);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
	}
});

test("clamp feeds the reduction gate the CLAMPED kept region (§6.6 context delta)", () => {
	seq = 0;
	const entries = [msgEntry(USER, "1"), msgEntry(ASSISTANT, "2"), msgEntry(TOOL_RESULT, "r"), msgEntry(USER, "4"), msgEntry(ASSISTANT, "5")];
	const r = clampKeptRegion(entries, "e4", 3);
	assert.ok(!r.cancel);
	// The gate's "after" rides on this number — it must grow when the clamp keeps more,
	// so an oversized kept region fails rung 4 (→ native) instead of re-firing every turn.
	assert.ok(keptRegionTokens(entries, r.firstKeptEntryId) > keptRegionTokens(entries, "e4"));
});

// ---------- shadow mode: same exemption, never a cancel ----------

function shadowRun(h: { requests: DecisionRequest[] }, cfg: Record<string, unknown>, event: unknown) {
	const pi = { getSettings: () => ({ smartCompact: cfg }) } as unknown as ExtensionAPI;
	const ctx = { ui: { notify: () => {} } } as unknown as ExtensionContext;
	return run(
		pi,
		ctx,
		new Set<string>(),
		event as never,
		"compact",
		() => ({
			async decide(req: DecisionRequest): Promise<DecisionBatch> {
				h.requests.push(req);
				return { ok: true, answers: { u_0_text: { type: "choice", choice: "summarize", confidence: 0.9 } } as unknown as Record<string, never>, model: "clef", inputTokens: 42 };
			},
		}),
	);
}

test("shadow with keptMessages: the exempt tail is never asked (§3.2) and native is still returned", async () => {
	savedKey = process.env[ENV_KEY];
	process.env[ENV_KEY] = "sk-test";
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sc-kept-"));
	try {
		const entries = clampEntries(); // pi's span = e1..e2; pi keeps e3..e4 (2 newest)
		const h = { requests: [] as DecisionRequest[] };
		// N=3: newest 3 = e2,e3,e4 → boundary e2 → e2's message exempt from the shadow questions.
		const r = await shadowRun(h, { mode: "shadow", keptMessages: 3 }, liveEvent(entries, "e3"));
		assert.equal(r, undefined, "shadow always returns native");
		assert.equal(h.requests.length, 1);
		assert.deepEqual(Object.keys(h.requests[0].questions), ["u_0_text"], "only the surviving region asked");
		// No cancel from shadow even when the clamp would empty the span — live-only config edge.
		const h2 = { requests: [] as DecisionRequest[] };
		const r2 = await shadowRun(h2, { mode: "shadow", keptMessages: 99 }, liveEvent(entries, "e3"));
		assert.equal(r2, undefined);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
	}
});

test("live run with keptMessages 0 or unset: byte-identical to ticket 04 — pi's cut verbatim, full region decided", async () => {
	savedKey = process.env[ENV_KEY];
	process.env[ENV_KEY] = "sk-test";
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sc-kept-"));
	try {
		const entries = clampEntries();
		for (const kept of [0, undefined]) {
			const h = liveHarness({ mode: "live", keptMessages: kept });
			const r = await liveRun(h, liveEvent(entries, "e3"));
			assert.ok(r && "compaction" in r && r.compaction);
			assert.equal(r.compaction.firstKeptEntryId, "e3", "pi's cut untouched");
			// Full span decided: u_0_text (e1) and u_1_text (e2) asked; e3's user is outside the span.
			assert.equal(h.requests.length, 1);
			assert.deepEqual(Object.keys(h.requests[0].questions).sort(), ["u_0_text", "u_1_text"]);
			assert.equal(JSON.stringify(h.summarizeMsgs).includes("mid work"), true);
		}
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
	}
});
