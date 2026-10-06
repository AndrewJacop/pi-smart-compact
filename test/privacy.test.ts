// Privacy redaction (SPEC §10; v1 ticket 05): `privacy: "redacted"` (default) scrubs ALL
// egress text on BOTH channels — the decision-request state/questions AND the summary
// request. `full` passes verbatim. Keeps in the composed document stay verbatim: redaction
// is an egress filter, it never touches the matrix, the actions, or on-box text.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionBatch, DecisionRequest } from "../extensions/smart-compact/client.ts";
import { DEFAULT_MATRIX, effectiveProfile } from "../extensions/smart-compact/config.ts";
import { runLive, type LiveDeps, type LiveRegion } from "../extensions/smart-compact/live.ts";
import { runShadow, type ShadowDeps } from "../extensions/smart-compact/pipeline.ts";
import { redactEgress, redactText } from "../extensions/smart-compact/privacy.ts";
import { loadQuestionSet } from "../extensions/smart-compact/pipeline.ts";
import { assistant, filler, toolResult, user } from "./helpers.ts";
import { fileURLToPath } from "node:url";

const DEFAULT_QUESTIONS = fileURLToPath(new URL("../extensions/smart-compact/questions.default.json", import.meta.url));
const PROFILE = effectiveProfile("clef", undefined);

// Seeded secrets — one per pattern class (SPEC §10's fixed list).
const SK_KEY = "sk-live-abcdef1234567890abcdef";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N0XgL0n3I9PlFUP0THsR8U";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA4\nyw4FfnQOZdNZjIL0\n-----END RSA PRIVATE KEY-----";

test("redactText catches each pattern class", () => {
	assert.equal(redactText(`the key is ${SK_KEY} ok`), "the key is [REDACTED] ok");
	// Auth-header family: whole assignment (scheme + value, any quote style) is replaced.
	assert.equal(redactText(`Authorization: Bearer ${JWT}`), "[REDACTED]");
	assert.equal(redactText(`"authorization": "Bearer ${JWT}"`), "[REDACTED]");
	assert.equal(redactText(`x-api-key: ${JWT}`), "[REDACTED]");
	assert.equal(redactText(`creds ${AWS_KEY} on account`), "creds [REDACTED] on account");
	assert.equal(redactText(`OPENAI_API_KEY=${SK_KEY}\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI123\npassword=hunter2`), "[REDACTED]\n[REDACTED]\n[REDACTED]");
	assert.equal(redactText(`paste:\n${PEM}\ndone`), "paste:\n[REDACTED]\ndone");
	// A credential-named assignment whose value carries no key shape still redacts.
	assert.equal(redactText("API_KEY=production-value"), "[REDACTED]");
});

test("redactText leaves non-credential text alone", () => {
	const plain = "NODE_ENV=production and MAX_TOKENS=4096, token count rose; the read path=" + "src/store.ts";
	assert.equal(redactText(plain), plain);
});

test("redactEgress walks string leaves and redacts values under credential-named object keys", () => {
	const payload = {
		note: `export API_KEY=${SK_KEY}`,
		env: { GITHUB_TOKEN: "ghp_plain_nonsense", keep: "untouched" },
		nested: [{ s: `Bearer ${JWT}` }],
		tokensIn: 42,
	};
	assert.deepEqual(redactEgress(payload), {
		note: "export [REDACTED]",
		env: { GITHUB_TOKEN: "[REDACTED]", keep: "untouched" },
		nested: [{ s: "[REDACTED]" }],
		tokensIn: 42,
	});
	// Deterministic — the idempotency-key content hash (SPEC §8.4) derives from this
	// redacted request, so identical redacted content must hash identically.
	assert.deepEqual(redactEgress(payload), redactEgress(payload));
});

// ---------- channel fixtures: one secret seeded per surface ----------

function secretRegion() {
	return [
		user(`deploy with ${AWS_KEY} please`),
		assistant([
			{ type: "thinking", thinking: `the token is ${SK_KEY} from the vault` },
			{ type: "text", text: "Running the deploy now." },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: `export API_KEY=${SK_KEY}` } },
		]),
		toolResult("c1", "bash", `deploy output\n${PEM}\n${filler(3, "ok")}`),
	];
}

function setupClient(answers: unknown, capture: { requests?: DecisionRequest[] }) {
	capture.requests = [];
	return {
		async decide(req: DecisionRequest): Promise<DecisionBatch> {
			capture.requests!.push(req);
			return { ok: true, answers: answers as Record<string, never>, model: "clef", inputTokens: 321 };
		},
	};
}

function shadowDeps(client: ShadowDeps["client"]): ShadowDeps {
	const q = loadQuestionSet({ defaultPath: DEFAULT_QUESTIONS });
	assert.equal(q.ok, true, "bundled question set must load");
	return { client, writeTelemetry: () => {}, questionSet: q.ok ? q.questions : {} };
}

const SHADOW_ANSWERS = {
	u_1_think: { type: "choice", choice: "drop", confidence: 0.9 },
	u_1_text: { type: "choice", choice: "summarize", confidence: 0.9 },
	u_1_call: { type: "choice", choice: "keep", confidence: 0.9 },
	u_2: { type: "choice", choice: "keep", confidence: 0.9 },
};

test("default (redacted): a seeded secret reaches neither the decision state nor the question text", async () => {
	const capture: { requests?: DecisionRequest[] } = {};
	await runShadow(shadowDeps(setupClient(SHADOW_ANSWERS, capture)), { backend: "clef", matrix: DEFAULT_MATRIX }, PROFILE, {
		messages: secretRegion(),
		kind: "compact",
	});
	const wire = JSON.stringify(capture.requests);
	assert.ok(wire.includes("[REDACTED]"), "redaction marker must ride the request");
	for (const secret of [SK_KEY, AWS_KEY, JWT, PEM]) assert.ok(!wire.includes(secret), `secret leaked to the decision channel: ${secret.slice(0, 12)}…`);
	// The tool-call arguments ride the question's {input} slot — redacted there too (the whole
	// KEY=value assignment is replaced, per SPEC §10).
	assert.match(capture.requests![0].questions.u_1_call.instructions, /export \[REDACTED\]/);
	assert.ok(!capture.requests![0].questions.u_1_call.instructions.includes("BEGIN RSA"));
});

test("full: both channels send verbatim text", async () => {
	const capture: { requests?: DecisionRequest[] } = {};
	await runShadow(shadowDeps(setupClient(SHADOW_ANSWERS, capture)), { backend: "clef", matrix: DEFAULT_MATRIX, privacy: "full" }, PROFILE, {
		messages: secretRegion(),
		kind: "compact",
	});
	const wire = JSON.stringify(capture.requests);
	assert.ok(!wire.includes("[REDACTED]"), "full must not redact");
	for (const secret of [SK_KEY, AWS_KEY]) assert.ok(wire.includes(secret), "full must pass verbatim");
});

test("privacy never changes the questions' available actions", async () => {
	const redacted: { requests?: DecisionRequest[] } = {};
	const full: { requests?: DecisionRequest[] } = {};
	const region = { messages: secretRegion(), kind: "compact" as const };
	await runShadow(shadowDeps(setupClient(SHADOW_ANSWERS, redacted)), { backend: "clef", matrix: DEFAULT_MATRIX }, PROFILE, region);
	await runShadow(shadowDeps(setupClient(SHADOW_ANSWERS, full)), { backend: "clef", matrix: DEFAULT_MATRIX, privacy: "full" }, PROFILE, region);
	const a = redacted.requests![0].questions;
	const b = full.requests![0].questions;
	assert.deepEqual(Object.keys(a), Object.keys(b));
	for (const id of Object.keys(b)) assert.deepEqual(a[id].criteria, b[id].criteria);
});

// ---------- summary channel ----------

const SUMMARY_USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function liveDeps(client: LiveDeps["client"], summarizeCalls: { msgs: unknown[] }[]): LiveDeps {
	const q = loadQuestionSet({ defaultPath: DEFAULT_QUESTIONS });
	assert.equal(q.ok, true, "bundled question set must load");
	return {
		client,
		writeTelemetry: () => {},
		questionSet: q.ok ? q.questions : {},
		summarize: async (msgs) => {
			summarizeCalls.push({ msgs: structuredClone(msgs) });
			return { text: "## Goal\ndeploy", usage: SUMMARY_USAGE };
		},
	};
}

// Result summarized (so the secret-carrying tool result reaches the LLM), call+text kept.
const LIVE_ANSWERS = {
	u_1_think: { type: "choice", choice: "drop", confidence: 0.9 },
	u_1_text: { type: "choice", choice: "keep", confidence: 0.9 },
	u_1_call: { type: "choice", choice: "keep", confidence: 0.9 },
	u_2: { type: "choice", choice: "summarize", confidence: 0.9 },
};

function liveRegion(over: Partial<LiveRegion> = {}): LiveRegion {
	return {
		messages: secretRegion(),
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		tokensBefore: 100_000,
		keptRegionTokens: 0,
		reserveTokens: 16384,
		firstKeptEntryId: "entry-keep",
		kind: "compact",
		...over,
	};
}

test("default (redacted): the seeded secret never reaches the summary request; keeps stay verbatim", async () => {
	const summarizeCalls: { msgs: unknown[] }[] = [];
	const r = await runLive(
		liveDeps(setupClient(LIVE_ANSWERS, {}), summarizeCalls),
		{ backend: "clef", matrix: DEFAULT_MATRIX, minReductionPct: 50 },
		PROFILE,
		liveRegion(),
	);
	assert.equal(r.outcome, "compacted");
	const wire = JSON.stringify(summarizeCalls);
	assert.ok(wire.includes("[REDACTED]"), "redaction marker must ride the summary request");
	assert.ok(!wire.includes(SK_KEY) && !wire.includes(AWS_KEY), "secret leaked to the summary channel");
	// Multiline secrets don't survive JSON.stringify matching — check the content text itself.
	const block = (summarizeCalls[0].msgs[0] as { content: Array<{ text: string }> }).content[0].text;
	assert.ok(!block.includes("BEGIN RSA") && !block.includes(AWS_KEY), "PEM/AWS secret leaked to the summary channel");
	// Redaction is an EGRESS filter: kept blocks in the composed (on-box) document stay verbatim.
	assert.ok(r.compaction!.summary.includes(SK_KEY));
});

test("full: the summary request carries verbatim text", async () => {
	const summarizeCalls: { msgs: unknown[] }[] = [];
	await runLive(
		liveDeps(setupClient(LIVE_ANSWERS, {}), summarizeCalls),
		{ backend: "clef", matrix: DEFAULT_MATRIX, minReductionPct: 50, privacy: "full" },
		PROFILE,
		liveRegion(),
	);
	const wire = JSON.stringify(summarizeCalls);
	assert.ok(!wire.includes("[REDACTED]"));
	const block = (summarizeCalls[0].msgs[0] as { content: Array<{ text: string }> }).content[0].text;
	assert.ok(block.includes(PEM) && block.includes("deploy output"), "full must pass the summarize-class text verbatim");
	// (sk- hosts are drop/keep class — the targeted summarizer never sees them.)
});
