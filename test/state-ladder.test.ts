import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTextTokens, splitUnits, type Unit } from "../extensions/smart-compact/units.ts";
import { fitState, type DecisionState, type LadderStage } from "../extensions/smart-compact/pipeline.ts";
import { assistant, filler, toolResult, user } from "./helpers.ts";

const LADDER: LadderStage[] = [
	"full",
	"inputs<=1000",
	"inputs<=200",
	"inputs<=60",
	"abridged",
	"collapsed",
	"call-lines",
	"call-less-omitted",
	"merged-calls",
];

/** A region with material for every ladder stage: big call inputs, long texts, calls, call-less units, multiple call runs. */
function everythingRegion() {
	const messages: Array<Record<string, unknown>> = [user("Fix the flaky checkout tests. SQLite buckets, 512MB cap.")];
	for (let t = 0; t < 4; t++) {
		messages.push(
			assistant([
				{ type: "thinking", thinking: `Turn ${t}: ${filler(20, `thinking ${t}`)}` },
				{ type: "text", text: `Turn ${t} analysis. ${filler(40, `text ${t}`)}` },
				{ type: "toolCall", id: `c${t}`, name: "grep", arguments: { pattern: `p${t}`, context: filler(120, `args ${t}`) } },
			]),
		);
		messages.push(toolResult(`c${t}`, "grep", `Turn ${t} result. ${filler(60, `result ${t}`)}`));
		if (t === 1) messages.push(user("Also keep request-id logging intact."));
	}
	// recent tail: the ladder must never touch these
	messages.push(user("Final check, please."));
	messages.push(assistant([{ type: "text", text: "All green — the fix landed and the suite passes now." }]));
	return messages;
}

function stateTokens(s: DecisionState): number {
	return estimateTextTokens(JSON.stringify(s));
}

test("a small region fits at stage full — the ladder never fires", () => {
	const units = splitUnits([user("hi"), assistant([{ type: "text", text: "hello" }])], undefined);
	const r = fitState(units, 25000);
	assert.ok(r);
	assert.equal(r.stage, "full");
});

test("walking the budget down applies the ladder stages in order, each only when the previous didn't fit", () => {
	const units = splitUnits(everythingRegion(), undefined);
	let budget = stateTokens(fitState(units, Number.MAX_SAFE_INTEGER)!.state);
	const seen: LadderStage[] = [];
	for (;;) {
		const r = fitState(units, budget);
		if (!r) break;
		if (seen[seen.length - 1] !== r.stage) seen.push(r.stage);
		budget = stateTokens(r.state) - 1;
	}
	assert.deepEqual(seen, LADDER);
});

test("inputs stages cap call arguments oldest-first with a size note", () => {
	const args = filler(400, "args"); // ~17k chars
	const units = splitUnits(
		[
			user("go"),
			assistant([{ type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "x", context: args } }]),
			toolResult("c1", "grep", "ok"),
			// pad past the recent window so the call is old enough to degrade
			...Array.from({ length: 7 }, (_, i) => assistant([{ type: "text", text: `padding ${i}` }])),
		],
		undefined,
	);
	const fullTokens = stateTokens(fitState(units, Number.MAX_SAFE_INTEGER)!.state);
	const r = fitState(units, fullTokens - 1);
	assert.ok(r);
	assert.equal(r.stage, "inputs<=1000");
	const entry = r.state.region.find((e) => e.id === "u_1_call");
	assert.ok(entry);
	assert.ok(entry.text.length < args.length / 2, `capped args (${entry.text.length}) far below raw (${args.length})`);
	assert.match(entry.text, /…\(\d+ch\)/);
});

test("abridge keeps head and tail of long texts with an omission marker", () => {
	const longText = `Start of analysis. ${filler(300, "middle")} End of analysis, conclusion here.`;
	const units = splitUnits(
		[
			user("go"),
			assistant([{ type: "text", text: longText }]),
			// pad past the recent window so the long text is old enough to degrade
			...Array.from({ length: 7 }, (_, i) => assistant([{ type: "text", text: `padding ${i}` }])),
		],
		undefined,
	);
	let r = fitState(units, Number.MAX_SAFE_INTEGER);
	while (r && r.stage !== "abridged") {
		const next = fitState(units, stateTokens(r.state) - 1);
		if (!next) break;
		r = next;
	}
	assert.ok(r);
	assert.equal(r.stage, "abridged");
	const entry = r.state.region.find((e) => e.id === "u_1_text");
	assert.ok(entry);
	assert.match(entry.text, /^Start of analysis\./);
	assert.match(entry.text, /End of analysis, conclusion here\.$/);
	assert.match(entry.text, /… \d+ chars omitted …/);
	assert.ok(entry.text.length < 700);
});

test("pinned and recent entries are never degraded at any stage", () => {
	const units = splitUnits(
		[
			user(`Constraints: ${filler(200, "user constraints")}`), // pinned, index 0
			...Array.from({ length: 10 }, (_, i) => assistant([{ type: "text", text: `msg ${i}: ${filler(20, `m${i}`)}` }])),
		],
		"previous summary text that must survive verbatim in the state",
	);
	// walk the budget down to exhaustion; keep the last stage that still fit
	let r = fitState(units, Number.MAX_SAFE_INTEGER);
	for (;;) {
		const next = r && fitState(units, stateTokens(r.state) - 1);
		if (!next) break;
		r = next;
	}
	assert.ok(r);
	assert.equal(r.stage, "call-less-omitted"); // every eligible entry was old assistant text — all omitted
	const region = r.state.region;
	assert.equal(region.length, 8); // pinned prev + user + 6 recent
	const pinnedUser = region.find((e) => e.id === "u_0");
	assert.ok(pinnedUser);
	assert.match(pinnedUser.text, /^Constraints: line 0/); // intact (baseline head, not ladder-degraded)
	const prev = region.find((e) => e.id === "u_prev");
	assert.ok(prev);
	assert.match(prev.text, /^previous summary text/); // intact
	// the newest 6 entries keep readable text, never a size note
	const recent = region.slice(-6);
	assert.ok(recent.every((e) => /^msg \d+:/.test(e.text)), `recent entries readable: ${JSON.stringify(recent.map((e) => e.text))}`);
});

test("call-less old entries are left out; old call runs merge into one entry listing member ids", () => {
	const units = splitUnits(everythingRegion(), undefined);
	let r = fitState(units, Number.MAX_SAFE_INTEGER);
	const seen = new Set<LadderStage>();
	while (r) {
		seen.add(r.stage);
		if (r.stage === "merged-calls") break;
		r = fitState(units, stateTokens(r.state) - 1);
	}
	assert.ok(seen.has("call-less-omitted"), `omit stage reached, got ${[...seen].join(" > ")}`);
	assert.ok(r && r.stage === "merged-calls");
	const merged = r.state.region.filter((e) => /calls and results \(/.test(e.text));
	assert.ok(merged.length >= 1, "at least one run merged");
	assert.match(merged[0].text, /u_\d+_call/);
});

test("nothing eligible can shrink (all pinned/recent) → the ladder exhausts → null (native)", () => {
	const units = splitUnits([user(filler(400, "only user content"))], undefined);
	// the single entry is pinned AND recent: no stage can touch it
	assert.equal(fitState(units, 500), null);
});

test("a previous summary alone bigger than the budget cannot fit — pinned floor wins, null", () => {
	const units = splitUnits([], filler(2000, "giant previous summary"));
	assert.equal(fitState(units, 100), null);
});

test("fitted states always render every region entry with id/type/chars/text", () => {
	const units = splitUnits(everythingRegion(), "prev");
	for (const budget of [Number.MAX_SAFE_INTEGER, 2000, 800, 300]) {
		const r = fitState(units, budget);
		if (!r) continue;
		for (const e of r.state.region) {
			assert.equal(typeof e.id, "string");
			assert.equal(typeof e.type, "string");
			assert.equal(typeof e.chars, "number");
			assert.equal(typeof e.text, "string");
		}
		assert.ok(Array.isArray(r.state.goal) && r.state.goal.length <= 5);
		assert.match(r.state.orientation, /compacted/);
	}
});
