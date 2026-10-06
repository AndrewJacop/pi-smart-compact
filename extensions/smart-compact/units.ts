// Decision units — the block-cluster split (SPEC §3.1).
// An assistant turn splits into at most 3 units (thinking / text / tool-call group);
// user, tool-result and the previous compaction summary are single units.
// Ids are stable within a run: u_{index} and u_{index}_think|_text|_call (u_prev = previous summary).

export type UnitType =
	| "user"
	| "previous-summary"
	| "assistant-text"
	| "thinking"
	| "tool-call"
	| "tool-result"
	| "unknown";

export interface ToolCallRef {
	id: string;
	name: string;
	arguments: unknown;
}

export interface Unit {
	id: string;
	type: UnitType;
	/** Index into the region's message array (absent for the previous summary). */
	index?: number;
	/** Plain text content, for state building and token estimates. */
	text: string;
	/** Raw text length before any truncation (feeds the {resultChars} slot and size notes). */
	chars: number;
	kind?: "assistant";
	/** tool-call units only: the turn's calls, for pairing with results. */
	calls?: ToolCallRef[];
	/** tool-result units only. */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => {
			if (typeof b === "string") return b;
			if (b && typeof b === "object" && "text" in b) return String((b as { text: unknown }).text ?? "");
			return "";
		})
		.join(" ")
		.trim();
}

/** Render call arguments as `k=v, …` — shared by unit splitting and the ladder's call-line stages. */
export function argsText(args: unknown): string {
	if (args === null || args === undefined || typeof args !== "object") return JSON.stringify(args) ?? "";
	return Object.entries(args as Record<string, unknown>)
		.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
		.join(", ");
}

/** One-line rendering of a tool-call group: `name(args…)` per call, args capped with a size note; optional per-call result summary. */
export function callsText(calls: ToolCallRef[], argCap = Infinity, resultByCallId?: Map<string, Unit>): string {
	return calls
		.map((c) => {
			const args = argsText(c.arguments);
			let line = `${c.name}(${argCap === Infinity || args.length <= argCap ? args : `${args.slice(0, argCap)}…(${args.length}ch)`})`;
			const r = resultByCallId?.get(c.id);
			if (r) line += ` → ${r.chars}ch${r.isError ? " (error)" : ""}`;
			return line;
		})
		.join("; ");
}

/** Split the compaction region into decision units, oldest first. */
export function splitUnits(messages: Array<Record<string, unknown>>, previousSummary?: string): Unit[] {
	const units: Unit[] = [];
	if (previousSummary) {
		units.push({ id: "u_prev", type: "previous-summary", text: previousSummary, chars: previousSummary.length });
	}
	messages.forEach((m, i) => {
		switch (m.role) {
			case "user": {
				const text = contentText(m.content);
				units.push({ id: `u_${i}`, type: "user", index: i, text, chars: text.length });
				break;
			}
			case "toolResult": {
				const text = contentText(m.content);
				units.push({
					id: `u_${i}`,
					type: "tool-result",
					index: i,
					text,
					chars: text.length,
					toolCallId: String(m.toolCallId ?? ""),
					toolName: String(m.toolName ?? ""),
					isError: Boolean(m.isError),
				});
				break;
			}
			case "assistant": {
				const content = Array.isArray(m.content) ? m.content : [];
				const thinking = content.flatMap((b) => ((b as { type?: string })?.type === "thinking" ? [String((b as { thinking?: string }).thinking ?? "")] : []));
				const text = contentText(content.filter((b) => (b as { type?: string })?.type === "text"));
				const calls: ToolCallRef[] = content.flatMap((b) => {
					if ((b as { type?: string })?.type !== "toolCall") return [];
					const call = b as { id?: string; name?: string; arguments?: unknown };
					return [{ id: String(call.id ?? ""), name: String(call.name ?? ""), arguments: call.arguments }];
				});
				if (thinking.length > 0) {
					const joined = thinking.join("\n");
					units.push({ id: `u_${i}_think`, type: "thinking", index: i, text: joined, chars: joined.length, kind: "assistant" });
				}
				if (text.length > 0) {
					units.push({ id: `u_${i}_text`, type: "assistant-text", index: i, text, chars: text.length, kind: "assistant" });
				}
				if (calls.length > 0) {
					const callsLine = callsText(calls);
					units.push({ id: `u_${i}_call`, type: "tool-call", index: i, text: callsLine, chars: callsLine.length, kind: "assistant", calls });
				}
				break;
			}
			default: {
				// Unknown unit type → keep (pinned, never asked; SPEC §3.3).
				const text = contentText(m.content);
				units.push({ id: `u_${i}`, type: "unknown", index: i, text, chars: text.length });
			}
		}
	});
	return units;
}

const UNIT_CAPS: Partial<Record<UnitType, number>> = { "tool-result": 2000 };

/** Serialize one unit the way pi's serializeConversation would render its block (2k tool-result cap, SPEC §3.7). */
export function serializeUnit(unit: Unit): string {
	switch (unit.type) {
		case "user":
			return `[User]: ${unit.text}`;
		case "previous-summary":
			return `[Previous summary]: ${unit.text}`;
		case "assistant-text":
			return `[Assistant]: ${unit.text}`;
		case "thinking":
			return `[Assistant thinking]: ${unit.text}`;
		case "tool-call":
			return `[Assistant tool calls]: ${unit.text}`;
		case "tool-result": {
			const cap = UNIT_CAPS["tool-result"] ?? 2000;
			const text =
				unit.text.length <= cap ? unit.text : `${unit.text.slice(0, cap)}\n\n[... ${unit.text.length - cap} more characters truncated]`;
			return `[Tool result]: ${text}`;
		}
		default:
			return `[Unknown]: ${unit.text}`;
	}
}

/** pi's token estimator is chars/4 (SPEC §3.4); applied to unit text directly. */
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
