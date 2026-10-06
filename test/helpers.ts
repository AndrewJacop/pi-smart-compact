// Shared message-shape helpers for the pipeline + ladder tests.
export function user(text: string) {
	return { role: "user", content: text, timestamp: 0 };
}
export function assistant(content: unknown[]) {
	return { role: "assistant", content, stopReason: "stop", usage: {}, timestamp: 0 };
}
export function toolResult(callId: string, tool: string, text: string, isError = false) {
	return { role: "toolResult", toolCallId: callId, toolName: tool, content: [{ type: "text", text }], isError, timestamp: 0 };
}
export const filler = (n: number, tag: string) =>
	Array.from({ length: n }, (_, i) => `line ${i}: ${tag} bulk output that real sessions produce in walls.`).join("\n");

// ---- shared run()-level harness (live + branch shells) ----

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DecisionBatch, DecisionRequest } from "../extensions/smart-compact/client.ts";

/** pi's full Usage shape — summarizer stubs return it verbatim. */
export const SUMMARY_USAGE = {
	input: 111,
	output: 22,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 133,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface Capture {
	requests?: DecisionRequest[];
	summarizeCalls: { msgs: unknown[]; opts: unknown }[];
}

export function stubMakeClient(answers: unknown, capture: Capture) {
	capture.requests = [];
	return (_backend: string, _profile: unknown, _timeoutMs: number) => ({
		async decide(req: DecisionRequest): Promise<DecisionBatch> {
			capture.requests!.push(req);
			return { ok: true, answers: answers as Record<string, never>, model: "clef", inputTokens: 321 };
		},
	});
}

export function stubMakeSummarizer(capture: Capture) {
	return (_ctx: ExtensionContext) => async (msgs: unknown[], opts: unknown) => {
		capture.summarizeCalls.push({ msgs: [...msgs], opts });
		return { text: "## Goal\nbuild the limiter", usage: SUMMARY_USAGE };
	};
}

const ENV_KEY = "OPTOLLM_API_KEY";
let savedKey: string | undefined;

export function useKey(): void {
	savedKey = process.env[ENV_KEY];
	process.env[ENV_KEY] = "sk-test";
}

export function restoreKey(): void {
	if (savedKey === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = savedKey;
}

export async function withAgentDir(mutate: (dir: string) => void | Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "sc-test-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		await mutate(dir);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
	}
}
