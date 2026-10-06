import assert from "node:assert/strict";
import { test } from "node:test";
import { jevClient, type DecisionRequest } from "../extensions/smart-compact/client.ts";

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
	const client = jevClient({
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
	const client = jevClient({
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
		const client = jevClient({
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
			// rate_limit/overloaded are advisory-retryable (a LATER run may succeed — e.g. freejev's
			// 1 req/min); the client itself never retries in-hook either way (SPEC §8).
			assert.equal(batch.error.retryable, kind === "rate_limit" || kind === "overloaded", `status ${status}`);
		}
	}
});

test("transport failure is network, abort is timeout", async () => {
	const network = jevClient({
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

	const slow = jevClient({ endpoint: "https://x.example", apiKey: "k", timeoutMs: 20, fetchImpl: () => new Promise(() => {}) });
	const t = await slow.decide(req);
	assert.equal(t.ok, false);
	if (!t.ok) assert.equal(t.error.kind, "timeout");
});

test("malformed response is rung 2 (per-unit salvage territory, wholly unusable → native)", async () => {
	for (const body of ["<html>gateway error</html>", { nope: true }, { answers: "not-an-object" }]) {
		const client = jevClient({
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
	const client = jevClient({
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

// ---- ticket 08: the one adapter serves all four backends ----

test("no apiKey → no authorization header (ollama ships keyless)", async () => {
	const seen: RequestInit[] = [];
	const client = jevClient({
		endpoint: "http://localhost:11434/v1/systemone",
		apiKey: "",
		timeoutMs: 1000,
		fetchImpl: async (_url, init) => {
			seen.push(init ?? {});
			return okResponse({ answers: { u_1: { type: "choice", choice: "keep" } }, model: "clef-flash", usage: { input_tokens: 1 } });
		},
	});
	const batch = await client.decide(req);
	assert.equal(batch.ok, true);
	assert.equal((seen[0].headers as Record<string, string>).authorization, undefined);
});

test("omitModel ships state+questions only (freejev pins the model server-side); default sends it", async () => {
	const bodies: unknown[] = [];
	const mk = (omitModel: boolean) =>
		jevClient({
			endpoint: "https://x.example",
			apiKey: "k",
			timeoutMs: 1000,
			omitModel,
			fetchImpl: async (_url, init) => {
				bodies.push(JSON.parse(String(init?.body)));
				return okResponse({ answers: {}, model: "typesafe/jev-1.13-20260917", usage: { input_tokens: 1 } });
			},
		});
	await mk(true).decide(req);
	await mk(false).decide(req);
	assert.deepEqual(bodies[0], { state: req.state, questions: req.questions });
	assert.deepEqual(bodies[1], req);
});

test("402 (empty balance) → other, rung 1, non-retryable → native, no retry", async () => {
	const client = jevClient({
		endpoint: "https://freejev.example/api/v1/decisions",
		apiKey: "k",
		timeoutMs: 1000,
		fetchImpl: async () => new Response(JSON.stringify({ error: "empty balance" }), { status: 402 }),
	});
	const batch = await client.decide(req);
	assert.equal(batch.ok, false);
	if (!batch.ok) {
		assert.equal(batch.error.kind, "other");
		assert.equal(batch.error.rung, 1);
		assert.equal(batch.error.retryable, false);
	}
});

test("idempotency-key = content-hash + attempt: identical runs derive the same key, a retry attempt a fresh one", async () => {
	const keys: string[] = [];
	const mk = () =>
		jevClient({
			endpoint: "https://freejev.example/api/v1/decisions",
			apiKey: "k",
			timeoutMs: 1000,
			idempotency: true,
			fetchImpl: async (_url, init) => {
				keys.push((init?.headers as Record<string, string>)["idempotency-key"]);
				return okResponse({ answers: {}, model: "jev", usage: { input_tokens: 1 } });
			},
		});
	await mk().decide(req); // run 1, attempt 1
	await mk().decide(req); // run 2, identical redacted content → same key
	const retried = mk();
	await retried.decide(req); // attempt 1 → same key
	await retried.decide(req); // attempt 2 → fresh key
	assert.equal(keys[1], keys[0], "identical content, same attempt → same key");
	assert.equal(keys[2], keys[0], "fresh client restarts the attempt counter");
	assert.notEqual(keys[3], keys[0], "retry attempt derives a fresh key");
	assert.match(keys[0], /^[0-9a-f]{32}-1$/);
	assert.match(keys[3], /^[0-9a-f]{32}-2$/);
});

test("idempotency-key hashes the POST-redaction body: different content → different key", async () => {
	const keys: string[] = [];
	const mk = () =>
		jevClient({
			endpoint: "https://x.example",
			apiKey: "k",
			timeoutMs: 1000,
			idempotency: true,
			fetchImpl: async (_url, init) => {
				keys.push((init?.headers as Record<string, string>)["idempotency-key"]);
				return okResponse({ answers: {}, model: "jev", usage: { input_tokens: 1 } });
			},
		});
	await mk().decide(req);
	await mk().decide({ ...req, state: { orientation: "different" } });
	assert.notEqual(keys[1], keys[0]);
});
