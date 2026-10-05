import assert from "node:assert/strict";
import { test } from "node:test";
import { clefClient, type DecisionRequest } from "../extensions/smart-compact/client.ts";

const req: DecisionRequest = {
	state: { orientation: "test" },
	model: "clef",
	questions: { u_1: { type: "choice", instructions: "pick", criteria: { keep: "k", drop: "d" } } },
};

function okResponse(body: unknown) {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("posts the Jev-shape request with bearer auth and unwraps the result envelope", async () => {
	const seen: { url: string; init: RequestInit }[] = [];
	const client = clefClient({
		endpoint: "https://optollm.example/v1/systemone",
		apiKey: "sk-test",
		timeoutMs: 1000,
		fetchImpl: async (url, init) => {
			seen.push({ url: String(url), init: init ?? {} });
			return okResponse({
				result: {
					answers: { u_1: { type: "choice", choice: "keep", probabilities: { keep: 0.9, drop: 0.1 }, confidence: 0.9 } },
					model: "clef",
					usage: { input_tokens: 2618, output_tokens: 0 },
				},
			});
		},
	});
	const batch = await client.decide(req);
	assert.equal(batch.ok, true);
	if (!batch.ok) return;
	assert.equal(batch.model, "clef");
	assert.equal(batch.inputTokens, 2618);
	assert.equal(batch.answers.u_1.choice, "keep");
	assert.equal(seen.length, 1);
	assert.equal(seen[0].url, "https://optollm.example/v1/systemone");
	assert.equal((seen[0].init.headers as Record<string, string>).authorization, "Bearer sk-test");
	const body = JSON.parse(String(seen[0].init.body));
	assert.deepEqual(body, req);
});

test("tolerates an unwrapped response", async () => {
	const client = clefClient({
		endpoint: "https://x.example",
		apiKey: "k",
		timeoutMs: 1000,
		fetchImpl: async () =>
			okResponse({ answers: { u_1: { type: "choice", choice: "drop" } }, model: "clef", usage: { input_tokens: 5, output_tokens: 0 } }),
	});
	const batch = await client.decide(req);
	assert.equal(batch.ok, true);
	if (batch.ok) assert.equal(batch.answers.u_1.choice, "drop");
});

test("HTTP status maps to error kinds, rung 1, no retry", async () => {
	for (const [status, kind] of [
		[401, "auth"],
		[403, "auth"],
		[429, "rate_limit"],
		[400, "input_too_large"],
		[500, "overloaded"],
		[503, "overloaded"],
		[418, "other"],
	] as const) {
		const client = clefClient({
			endpoint: "https://x.example",
			apiKey: "k",
			timeoutMs: 1000,
			fetchImpl: async () => new Response("nope", { status }),
		});
		const batch = await client.decide(req);
		assert.equal(batch.ok, false, `status ${status}`);
		if (!batch.ok) {
			assert.equal(batch.error.kind, kind, `status ${status}`);
			assert.equal(batch.error.rung, 1, `status ${status}`);
		}
	}
});

test("transport failure is network, abort is timeout", async () => {
	const network = clefClient({
		endpoint: "https://x.example",
		apiKey: "k",
		timeoutMs: 1000,
		fetchImpl: async () => {
			throw new TypeError("fetch failed");
		},
	});
	const n = await network.decide(req);
	assert.equal(n.ok, false);
	if (!n.ok) assert.equal(n.error.kind, "network");

	const slow = clefClient({ endpoint: "https://x.example", apiKey: "k", timeoutMs: 20, fetchImpl: () => new Promise(() => {}) });
	const t = await slow.decide(req);
	assert.equal(t.ok, false);
	if (!t.ok) assert.equal(t.error.kind, "timeout");
});

test("malformed response is rung 2 (per-unit salvage territory, wholly unusable → native)", async () => {
	for (const body of ["<html>gateway error</html>", { nope: true }, { answers: "not-an-object" }]) {
		const client = clefClient({
			endpoint: "https://x.example",
			apiKey: "k",
			timeoutMs: 1000,
			fetchImpl: async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 }),
		});
		const batch = await client.decide(req);
		assert.equal(batch.ok, false, JSON.stringify(body));
		if (!batch.ok) assert.equal(batch.error.rung, 2, JSON.stringify(body));
	}
});

test("an already-aborted signal short-circuits to timeout", async () => {
	const client = clefClient({
		endpoint: "https://x.example",
		apiKey: "k",
		timeoutMs: 5000,
		fetchImpl: async () => {
			throw new Error("should not be called");
		},
	});
	const ctrl = new AbortController();
	ctrl.abort();
	const batch = await client.decide(req, ctrl.signal);
	assert.equal(batch.ok, false);
	if (!batch.ok) assert.equal(batch.error.kind, "timeout");
});
