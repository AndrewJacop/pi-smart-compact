// Ticket 10 contract: the README must cover all ten SPEC §12 outline sections, be titled
// with the scoped package name, carry the compat claim, and state the carried-over
// obligations (privacy trade-off, kept-region churn hazard, calibration recipe + fresh-log
// rule, key setup, telemetry path, ticket-09 measured eval numbers — not the spike's).
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const README = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "README.md"), "utf8");

const required = [
	// Title + scoped package + install + compat claim
	"# @andrewjacop/pi-smart-compact",
	"pi install npm:@andrewjacop/pi-smart-compact",
	"Requires pi ≥ 1.0.2",
	// Quickstart key setup: gitignored .env.local conventions
	".env.local",
	// Ten outline sections
	"## 1. What it is",
	"## 2. Quickstart",
	"## 3. Configuration reference",
	"## 4. How decisions work",
	"## 5. Backends",
	"## 6. Summaries & kept region",
	"## 7. Fallback & observability",
	"## 8. Branch summaries",
	"## 9. Eval results",
	"## 10. Limitations & v2",
	// Calibration recipe (docs-only) + fresh-log rule + shared minReductionPct stance
	"## 11. Calibration recipe",
	"telemetry.prev.jsonl",
	// Telemetry path + env override
	"$PI_CODING_AGENT_DIR/smart-compact/telemetry.jsonl",
	"PI_CODING_AGENT_DIR",
	// Privacy trade-off, stated honestly (carried from ticket 05)
	"never complete",
	"base64",
	// Kept-region churn hazard + minReductionPct interplay (carried from ticket 06)
	"re-fires",
	// Ticket-09 measured gate numbers (not the spike's)
	"98%",
	"63.0%",
	"6/6",
	"wrong-drop = 0",
	"p50 2.7 s",
];

for (const needle of required) {
	test(`README contains ${JSON.stringify(needle)}`, () => {
		assert.ok(README.includes(needle), `missing: ${needle}`);
	});
}

// The eval section must cite the measured gate numbers, not the spike's (−97.8% / −98.0%
// region reductions live only in SPEC history, never as the README's eval claim).
test("README eval section cites measured numbers, not the spike's", () => {
	assert.ok(!README.includes("−97.8%"), "spike number −97.8% must not appear as the eval claim");
	assert.ok(!README.includes("−98.0%"), "spike number −98.0% must not appear as the eval claim");
});

// No key material anywhere in the repo's own text: the README documents the env-var
// NAMES, never values (sk-… shapes would mean a committed credential).
test("README contains no key-shaped material", () => {
	assert.ok(!/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/.test(README), "possible committed key (sk-…)");
	assert.ok(!/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/.test(README), "possible committed AWS access key");
	assert.ok(!/=(?:your-key)?[A-Za-z0-9_-]{24,}\s*$/m.test(README), "possible committed key assignment");
});
