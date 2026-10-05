// Telemetry — passive JSONL, one record per run, identical schema live and shadow (SPEC §8.4).
// Path: $PI_CODING_AGENT_DIR/smart-compact/telemetry.jsonl (env-overridable). A telemetry
// failure must never break compaction — appendTelemetry swallows everything.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function telemetryDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "smart-compact");
}

export function appendTelemetry(dir: string, record: unknown): boolean {
	try {
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "telemetry.jsonl"), `${JSON.stringify(record)}\n`);
		return true;
	} catch {
		return false;
	}
}
