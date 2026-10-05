import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeUnit, splitUnits } from "../extensions/smart-compact/units.ts";

function assistant(content: unknown[], overrides: Record<string, unknown> = {}) {
	return { role: "assistant", content, stopReason: "stop", usage: {}, timestamp: 0, ...overrides };
}

test("assistant turns split into thinking / text / tool-call group units", () => {
	const msgs = [
		assistant([
			{ type: "thinking", thinking: "plan the approach" },
			{ type: "text", text: "On it." },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "c2", name: "grep", arguments: { pattern: "x" } },
		]),
	];
	const units = splitUnits(msgs);
	assert.deepEqual(
		units.map((u) => [u.id, u.type]),
		[
			["u_0_think", "thinking"],
			["u_0_text", "assistant-text"],
			["u_0_call", "tool-call"],
		],
	);
	const call = units[2];
	assert.equal(call.kind, "assistant");
	assert.deepEqual(call.calls, [
		{ id: "c1", name: "read", arguments: { path: "a.ts" } },
		{ id: "c2", name: "grep", arguments: { pattern: "x" } },
	]);
});

test("user and tool-result messages are single units with stable ids", () => {
	const msgs = [
		{ role: "user", content: "hello", timestamp: 0 },
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			isError: false,
			timestamp: 0,
		},
	];
	const units = splitUnits(msgs);
	assert.deepEqual(
		units.map((u) => [u.id, u.type]),
		[
			["u_0", "user"],
			["u_1", "tool-result"],
		],
	);
	assert.equal(units[1].toolCallId, "c1");
	assert.equal(units[1].toolName, "read");
});

test("previous summary becomes a single previous-summary unit first", () => {
	const msgs = [{ role: "user", content: "next prompt", timestamp: 0 }];
	const units = splitUnits(msgs, "earlier compacted summary");
	assert.deepEqual(
		units.map((u) => [u.id, u.type]),
		[
			["u_prev", "previous-summary"],
			["u_0", "user"],
		],
	);
	assert.equal(units[0].text, "earlier compacted summary");
});

test("unknown message roles classify as unknown units (pinned keep, never asked)", () => {
	const msgs = [{ role: "custom-thing", content: "weird", timestamp: 0 }];
	const units = splitUnits(msgs);
	assert.deepEqual(units.map((u) => u.type), ["unknown"]);
});

test("assistant with no decidable content yields no units", () => {
	const units = splitUnits([assistant([])]);
	assert.equal(units.length, 0);
});

test("image-only user message keeps its unit with empty text", () => {
	const msgs = [{ role: "user", content: [{ type: "image", data: "…" }], timestamp: 0 }];
	const units = splitUnits(msgs);
	assert.equal(units.length, 1);
	assert.equal(units[0].type, "user");
});

test("serializeUnit mirrors pi's serializeConversation anatomy", () => {
	assert.equal(serializeUnit({ id: "u_0", type: "user", text: "hi", chars: 2 }), "[User]: hi");
	const msgs = [
		assistant([
			{ type: "thinking", thinking: "hmm" },
			{ type: "text", text: "so" },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "ls" } },
		]),
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "out" }],
			isError: false,
			timestamp: 0,
		},
	];
	const units = splitUnits(msgs);
	assert.equal(serializeUnit(units[0]), "[Assistant thinking]: hmm");
	assert.equal(serializeUnit(units[1]), "[Assistant]: so");
	assert.equal(serializeUnit(units[2]), '[Assistant tool calls]: bash(cmd="ls")');
	assert.equal(serializeUnit(units[3]), "[Tool result]: out");
});
