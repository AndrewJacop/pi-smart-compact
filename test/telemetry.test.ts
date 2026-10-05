import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendTelemetry, telemetryDir } from "../extensions/smart-compact/telemetry.ts";

test("telemetryDir honors PI_CODING_AGENT_DIR and defaults to ~/.pi/agent", () => {
	assert.equal(telemetryDir({ PI_CODING_AGENT_DIR: "/custom/pi" }), join("/custom/pi", "smart-compact"));
	assert.equal(
		telemetryDir({}),
		join(process.env.HOME ?? "", ".pi", "agent", "smart-compact"),
	);
});

test("appendTelemetry creates the directory and appends one JSON line per record", () => {
	const dir = join(mkdtempSync(join(tmpdir(), "sc-tel-")), "smart-compact");
	const record = { ts: "t", kind: "compact", mode: "shadow" };
	assert.equal(appendTelemetry(dir, record), true);
	assert.equal(appendTelemetry(dir, { ts: "t2" }), true);
	const lines = readFileSync(join(dir, "telemetry.jsonl"), "utf8").trim().split("\n");
	assert.equal(lines.length, 2);
	assert.deepEqual(JSON.parse(lines[0]), record);
});

test("appendTelemetry never throws — telemetry failure must not break compaction", () => {
	const file = join(mkdtempSync(join(tmpdir(), "sc-tel-")), "blocked");
	writeFileSync(file, "not a dir");
	assert.equal(appendTelemetry(join(file, "sub"), { x: 1 }), false);
	assert.ok(!existsSync(join(file, "sub")));
});
