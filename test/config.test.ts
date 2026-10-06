import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BACKENDS,
	DEFAULT_DECISION_TIMEOUT_MS,
	DEFAULT_MIN_REDUCTION_PCT,
	effectiveProfile,
	missingBackendKey,
	validateSmartCompact,
} from "../extensions/smart-compact/config.ts";

function ok(raw: unknown) {
	const v = validateSmartCompact(raw);
	assert.equal(v.ok, true, `expected valid, got errors: ${v.ok ? "" : v.errors.join(" | ")}`);
	return v.config;
}

function errors(raw: unknown): string[] {
	const v = validateSmartCompact(raw);
	assert.equal(v.ok, false, `expected invalid, got config: ${JSON.stringify(v.ok ? v.config : null)}`);
	return v.errors;
}

test("absent config yields safe defaults", () => {
	const cfg = ok(undefined);
	assert.equal(cfg.backend, "clef");
	assert.equal(cfg.mode, "live");
	assert.equal(cfg.privacy, "redacted");
	assert.equal(cfg.minReductionPct, DEFAULT_MIN_REDUCTION_PCT);
	assert.equal(cfg.decisionTimeoutMs, DEFAULT_DECISION_TIMEOUT_MS);
	assert.equal(cfg.keptMessages, undefined);
	// The Safe table (SPEC §4)
	assert.deepEqual(cfg.matrix.user, ["keep"]);
	assert.deepEqual(cfg.matrix["previous-summary"], ["keep"]);
	assert.deepEqual(cfg.matrix["assistant-text"], ["keep", "summarize"]);
	assert.deepEqual(cfg.matrix.thinking, ["summarize", "drop"]);
	assert.deepEqual(cfg.matrix["tool-call"], ["keep", "drop"]);
	assert.deepEqual(cfg.matrix["tool-result"], ["keep", "summarize", "drop"]);
	assert.deepEqual(cfg.profiles, {});
});

test("empty object yields safe defaults", () => {
	assert.equal(ok({}).mode, "live");
});

test("valid full config is preserved", () => {
	const cfg = ok({
		backend: "ollama",
		mode: "shadow",
		privacy: "full",
		minReductionPct: 80,
		keptMessages: 12,
		decisionTimeoutMs: 2500,
		profiles: {
			clef: { confidenceFloor: 0.2, maxQuestions: 32, model: "clef", truncateStateClientSide: true, stateTokenBudget: 25000 },
		},
	});
	assert.equal(cfg.backend, "ollama");
	assert.equal(cfg.mode, "shadow");
	assert.equal(cfg.privacy, "full");
	assert.equal(cfg.minReductionPct, 80);
	assert.equal(cfg.keptMessages, 12);
	assert.equal(cfg.decisionTimeoutMs, 2500);
	assert.deepEqual(cfg.profiles.clef, {
		confidenceFloor: 0.2,
		maxQuestions: 32,
		model: "clef",
		truncateStateClientSide: true,
		stateTokenBudget: 25000,
	});
});

test("partial matrix merges row-wise over the defaults", () => {
	const cfg = ok({ matrix: { thinking: ["drop"], user: ["keep"] } });
	assert.deepEqual(cfg.matrix.thinking, ["drop"]);
	assert.deepEqual(cfg.matrix.user, ["keep"]);
	// untouched rows keep the Safe defaults
	assert.deepEqual(cfg.matrix["assistant-text"], ["keep", "summarize"]);
	assert.deepEqual(cfg.matrix["tool-result"], ["keep", "summarize", "drop"]);
});

test("non-object config is invalid", () => {
	assert.match(errors("fast")[0], /must be an object/);
	assert.match(errors(42)[0], /must be an object/);
	assert.match(errors([["keep"]])[0], /must be an object/);
});

test("unknown top-level knobs are invalid", () => {
	assert.ok(errors({ keepdMessages: 5 }).some((e) => e.includes("keepdMessages")));
	// a backend name is not a knob — { clef: … } at top level is a misplaced profile override
	assert.ok(errors({ clef: { maxQuestions: 5 } }).some((e) => e.includes("clef")));
});

test("backend must name a shipped profile", () => {
	assert.match(errors({ backend: "freejev" })[0], /backend.*clef.*jev.*ollama/);
	assert.match(errors({ backend: 7 })[0], /backend/);
});

test("mode must be live, shadow or off", () => {
	assert.match(errors({ mode: "fast" })[0], /mode/);
	assert.match(errors({ mode: true })[0], /mode/);
});

test("privacy must be redacted or full", () => {
	assert.match(errors({ privacy: "none" })[0], /privacy/);
	assert.match(errors({ privacy: 0 })[0], /privacy/);
});

test("minReductionPct must be a number 0..100", () => {
	for (const bad of [-1, 101, "50", NaN, Infinity]) {
		assert.ok(errors({ minReductionPct: bad }).some((e) => /minReductionPct/.test(e)), `case ${String(bad)}`);
	}
	assert.equal(ok({ minReductionPct: 0 }).minReductionPct, 0); // 0 disables, valid
});

test("keptMessages must be a non-negative integer when present", () => {
	for (const bad of [-1, 1.5, "3", NaN]) {
		assert.ok(errors({ keptMessages: bad }).some((e) => /keptMessages/.test(e)), `case ${String(bad)}`);
	}
	assert.equal(ok({ keptMessages: 0 }).keptMessages, 0); // 0 = no-op, valid
});

test("decisionTimeoutMs must be a positive integer", () => {
	for (const bad of [0, -5, 1.5, "5s"]) {
		assert.ok(errors({ decisionTimeoutMs: bad }).some((e) => /decisionTimeoutMs/.test(e)), `case ${String(bad)}`);
	}
});

test("matrix rows: known unit types, length >= 1, valid unique actions", () => {
	assert.ok(errors({ matrix: { assistantText: ["keep"] } }).some((e) => /assistantText.*not a known unit type/.test(e)));
	assert.ok(errors({ matrix: "drop it" }).some((e) => /matrix.*must be an object/.test(e)));
	assert.ok(errors({ matrix: { user: [] } }).some((e) => /matrix\.user.*non-empty/.test(e)));
	assert.ok(errors({ matrix: { user: "keep" } }).some((e) => /matrix\.user/.test(e)));
	assert.ok(errors({ matrix: { user: ["kepp"] } }).some((e) => /unknown action "kepp"/.test(e)));
	assert.ok(errors({ matrix: { user: ["keep", "keep"] } }).some((e) => /duplicate action "keep"/.test(e)));
	assert.ok(errors({ matrix: { thinking: [] } }).some((e) => /matrix\.thinking.*non-empty/.test(e)));
});

test("profiles: keys must be shipped profiles, fields typed", () => {
	assert.match(errors({ profiles: "fast" })[0], /profiles.*must be an object/);
	assert.ok(errors({ profiles: { freejev: {} } }).some((e) => /profiles\.freejev.*not a known profile/.test(e)));
	assert.ok(errors({ profiles: { clef: { maxQuestions: 0 } } }).some((e) => /profiles\.clef\.maxQuestions.*positive integer/.test(e)));
	assert.ok(errors({ profiles: { clef: { confidenceFloor: 1.5 } } }).some((e) => /profiles\.clef\.confidenceFloor.*between 0 and 1/.test(e)));
	assert.ok(errors({ profiles: { clef: { truncateStateClientSide: "yes" } } }).some((e) => /profiles\.clef\.truncateStateClientSide/.test(e)));
	assert.ok(errors({ profiles: { clef: { stateTokenBudget: -1 } } }).some((e) => /profiles\.clef\.stateTokenBudget/.test(e)));
	assert.ok(errors({ profiles: { clef: { model: 3 } } }).some((e) => /profiles\.clef\.model/.test(e)));
	assert.ok(errors({ profiles: { clef: { nope: 1 } } }).some((e) => /profiles\.clef.*nope/.test(e)));
	assert.ok(errors({ profiles: { clef: "fast" } }).some((e) => /profiles\.clef.*must be an object/.test(e)));
	// valid overrides pass and merge over shipped behavior (empty override = shipped defaults)
	assert.deepEqual(ok({ profiles: { ollama: { confidenceFloor: 0.3 } } }).profiles.ollama, { confidenceFloor: 0.3 });
});

test("multiple problems are all reported", () => {
	const errs = errors({ mode: "fast", privacy: "nope", keptMessages: -2 });
	assert.equal(errs.length, 3);
});

test("BACKENDS table: key env vars per shipped profile (SPEC §5.2/§5.4)", () => {
	assert.equal(BACKENDS.clef.env, "OPTOLLM_API_KEY");
	assert.equal(BACKENDS.jev.env, "FREEJEV_API_KEY");
	assert.equal(BACKENDS.ollama.env, null);
	assert.equal(BACKENDS["jev-direct"].env, "TYPESAFE_API_KEY");
});

test("missingBackendKey reads the env live", () => {
	const env: Record<string, string | undefined> = {};
	assert.equal(missingBackendKey("clef", env), "OPTOLLM_API_KEY");
	assert.equal(missingBackendKey("clef", { OPTOLLM_API_KEY: "" }), "OPTOLLM_API_KEY"); // empty = missing
	assert.equal(missingBackendKey("clef", { OPTOLLM_API_KEY: "sk-x" }), null);
	assert.equal(missingBackendKey("ollama", env), null); // no key needed
	assert.equal(missingBackendKey("jev", env), "FREEJEV_API_KEY");
	assert.equal(missingBackendKey("jev-direct", env), "TYPESAFE_API_KEY");
});

test("all four shipped profiles exist with their §5.2 wire defaults", () => {
	for (const backend of ["clef", "jev", "ollama", "jev-direct"]) {
		assert.ok(effectiveProfile(backend, undefined), `${backend} ships`);
	}
	const jev = effectiveProfile("jev", undefined)!;
	assert.equal(jev.endpoint, "https://freejev.org/api/v1/decisions");
	assert.equal(jev.maxQuestions, 16); // ≤ 16 questions/req
	assert.match(jev.model, /^typesafe\/jev/); // server-pinned
	const ollama = effectiveProfile("ollama", undefined)!;
	assert.equal(ollama.endpoint, "http://localhost:11434/v1/systemone");
	assert.equal(ollama.model, "clef-flash");
	assert.equal(ollama.maxQuestions, 20);
	assert.equal(ollama.truncateStateClientSide, true);
	const direct = effectiveProfile("jev-direct", undefined)!;
	assert.equal(direct.model, "jev-1.13.0");
	assert.equal(direct.stateTokenBudget, 64000); // 64k tok/req, API enforces
	assert.equal(direct.truncateStateClientSide, false); // oversize → the API's 400, never truncated
});

test("per-profile overrides merge over each shipped profile (no cross-profile leakage)", () => {
	const jev = effectiveProfile("jev", { confidenceFloor: 0.4 });
	assert.equal(jev?.confidenceFloor, 0.4);
	assert.equal(effectiveProfile("clef", undefined)?.confidenceFloor, 0.1); // clef floor untouched
	assert.equal(effectiveProfile("ollama", { maxQuestions: 5 })?.maxQuestions, 5);
});
