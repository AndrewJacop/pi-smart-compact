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
