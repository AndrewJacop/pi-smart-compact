// Live mode (SPEC §6; v1 ticket 04): the shared decision core feeds a targeted
// summarizer — only summarize-class units reach the LLM — and the hybrid composer,
// in order: previous-summary head (verbatim) → native-format LLM section →
// `## Kept verbatim` (serialized keep-blocks, orphan-only drop markers) → file tags.
// The reduction gate (rung 4) guards the context delta; summarizer failure → native
// (rung 3, no salvage, no retry). Branch summaries join the pipeline in ticket 07.
import type { CompactionResult, SessionEntry, generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { DecisionClient } from "./client.ts";
import type { Action, BackendProfile, UnitType } from "./config.ts";
import { decideRegion, emptyRecord, type QuestionSet, type TelemetryRecord, type UnitRecord } from "./pipeline.ts";
import { estimateTextTokens, serializeUnit, splitUnits, type Unit } from "./units.ts";

/** pi's Usage, derived from its own summary call — the compaction entry persists it verbatim. */
type SummaryUsage = Awaited<ReturnType<typeof generateSummaryWithUsage>>["usage"];

/** Standing scoping line appended to every summary request (SPEC §6.2). */
export const SCOPING_LINE =
	"Summarize only the messages above; the rest of the region is preserved verbatim alongside this summary.";

export interface SummaryCall {
	text: string;
	usage: SummaryUsage;
}

/** Injectable summarizer: pi's generateSummaryWithUsage with the session model + modelRegistry auth. */
export type SummarizerFn = (
	summarizeMsgs: Array<Record<string, unknown>>,
	opts: { customInstructions: string; reserveTokens: number; signal?: AbortSignal },
) => Promise<SummaryCall>;

export interface LiveDeps {
	client: DecisionClient;
	writeTelemetry: (record: TelemetryRecord) => void;
	questionSet: QuestionSet;
	summarize: SummarizerFn;
}

export interface LiveOpts {
	backend: string;
	matrix: Record<UnitType, Action[]>;
	minReductionPct: number;
}

export interface LiveFileOps {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export interface LiveRegion {
	/** messagesToSummarize ∪ turnPrefixMessages as one union (SPEC §6.7). */
	messages: Array<Record<string, unknown>>;
	previousSummary?: string;
	fileOps: LiveFileOps;
	tokensBefore: number;
	/** Estimated tokens of the entries pi keeps outside the compaction entry (§6.6 context delta). */
	keptRegionTokens: number;
	reserveTokens: number;
	firstKeptEntryId: string;
	customInstructions?: string;
	signal?: AbortSignal;
}

export interface LiveCompaction {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter: number;
	usage?: SummaryUsage;
	details: { readFiles: string[]; modifiedFiles: string[]; smartCompact: TelemetryRecord };
}

export type LiveResult =
	| { outcome: "compacted"; toast: string; compaction: LiveCompaction }
	| { outcome: "fallback"; toast: string; compaction: undefined }
	| { outcome: "skipped"; toast?: undefined; compaction: undefined };

// ---------- composer (SPEC §6.3/§6.4) ----------

/**
 * Assemble the document in order: previous summary (untouched), LLM section,
 * `## Kept verbatim` keep-blocks with orphan-only drop markers. Empty classes
 * omit their sections — no placeholders (SPEC §6.8).
 */
export function composeDocument(units: Unit[], actions: Map<string, UnitRecord>, opts: { previousSummary?: string; llmSummary?: string }): string {
	const sections: string[] = [];
	if (opts.previousSummary) sections.push(opts.previousSummary); // verbatim head — keeps survive every compaction
	if (opts.llmSummary) sections.push(opts.llmSummary);

	const kept = units.filter((u) => u.type !== "previous-summary" && actions.get(u.id)?.action === "keep");
	if (kept.length > 0) {
		// The one surviving orphan shape (SPEC §6.4): a kept call whose result was dropped
		// gets one pseudo-serialization line; every other drop is silent in the document.
		const unitByCallId = new Map(units.flatMap((u) => (u.type === "tool-result" ? [[u.toolCallId ?? "", u] as const] : [])));
		const blocks = kept.map((u) => {
			let block = serializeUnit(u);
			if (u.type === "tool-call") {
				for (const c of u.calls ?? []) {
					const r = unitByCallId.get(c.id);
					if (r && actions.get(r.id)?.action === "drop") {
						block += `\n[Tool result dropped: ${r.chars.toLocaleString("en-US")} chars — re-run the command if needed]`;
					}
				}
			}
			return block;
		});
		sections.push(`## Kept verbatim\n${blocks.join("\n")}`);
	}
	return sections.join("\n\n");
}

// pi computes the file lists/tags with computeFileLists/formatFileOperations but does not
// export them — these mirrors keep native parity for the composed document (SPEC §6.5).
function fileLists(fileOps: LiveFileOps): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	return {
		readFiles: [...fileOps.read].filter((f) => !modified.has(f)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

function fileTags(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

/** Estimated tokens of pi's kept region: the message entries from firstKeptEntryId onward. */
// ponytail: compaction/label entries inside the kept span aren't counted — the message
// entries dominate the estimate; switch to pi's projection walk if the gate ever drifts.
export function keptRegionTokens(entries: SessionEntry[], firstKeptEntryId: string): number {
	const start = Math.max(0, entries.findIndex((e) => e.id === firstKeptEntryId)); // unknown id → keep-everything estimate (safe)
	let tokens = 0;
	for (const e of entries.slice(start)) {
		if (e.type === "message") tokens += estimateTokens(e.message);
	}
	return tokens;
}

function fmtTok(n: number): string {
	return n >= 1000 ? `${(Math.round(n / 100) / 10).toFixed(1)}k` : String(Math.round(n));
}

// ---------- pipeline ----------

/**
 * The summarizer input for the region: the messages hosting summarize-class units —
 * with mixed assistant messages reduced to their summarize-class blocks, so dropped
 * thinking and kept tool calls never reach the LLM (SPEC §6.1, §6.4 silent drops).
 * Block→unit mapping mirrors splitUnits: u_{i}_think / u_{i}_text / u_{i}_call.
 */
export function summarizeMessages(
	units: Unit[],
	actions: Map<string, UnitRecord>,
	messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	const SUFFIX: Record<string, string> = { thinking: "think", text: "text", toolCall: "call" };
	const idxs = [
		...new Set(units.flatMap((u) => (actions.get(u.id)?.action === "summarize" && u.index !== undefined ? [u.index] : []))),
	].sort((a, b) => a - b);
	return idxs.map((i) => {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;
		const actionById = new Map(units.flatMap((u) => (u.index === i ? [[u.id, actions.get(u.id)?.action] as const] : [])));
		const content = (msg.content as Array<{ type?: string }>).filter((b) => {
			const suffix = SUFFIX[b.type ?? ""];
			return suffix !== undefined && actionById.get(`u_${i}_${suffix}`) === "summarize";
		});
		return { ...msg, content };
	});
}

export async function runLive(deps: LiveDeps, opts: LiveOpts, profile: BackendProfile | null, region: LiveRegion): Promise<LiveResult> {
	if (splitUnits(region.messages, region.previousSummary).length === 0) return { outcome: "skipped", compaction: undefined };

	const outcome = await decideRegion(deps, opts, profile, {
		messages: region.messages,
		previousSummary: region.previousSummary,
		kind: "compact",
		signal: region.signal,
	});
	if ("empty" in outcome) return { outcome: "skipped", compaction: undefined };

	const record = emptyRecord("live", "compact", opts.backend, outcome.ok ? outcome.core.model : outcome.model, outcome.ok ? outcome.core.stage : outcome.stage);
	if (!outcome.ok) {
		record.fallback = { rung: outcome.rung, error: outcome.error };
		record.latencyMs.decision = outcome.decisionMs;
		deps.writeTelemetry(record);
		return {
			outcome: "fallback",
			toast: `smart-compact: fell back to native (rung ${outcome.rung}: ${outcome.error})`,
			compaction: undefined,
		};
	}
	const { units: all, actions, classCounts } = outcome.core;
	record.units = outcome.core.all;
	record.classCounts = classCounts;
	record.latencyMs.decision = outcome.core.decisionMs;
	record.usage.decisionInputTokens = outcome.core.inputTokens;

	// Targeted summarizer (SPEC §6.1/§6.2): only the summarize class reaches the LLM.
	// No previousSummary param — the composed head owns iteration. /compact [focus]
	// forwards as the focus; the scoping line rides along.
	let llmSummary: string | undefined;
	let usage: SummaryUsage | undefined;
	const summarizeMsgs = summarizeMessages(outcome.core.units, actions, region.messages);
	if (summarizeMsgs.length > 0) {
		const t1 = Date.now();
		try {
			const instructions = [region.customInstructions, SCOPING_LINE].filter(Boolean).join("\n\n");
			const r = await deps.summarize(summarizeMsgs, {
				customInstructions: instructions,
				reserveTokens: region.reserveTokens,
				signal: region.signal,
			});
			llmSummary = r.text;
			usage = r.usage;
			record.usage.summaryInputTokens = r.usage.input;
			record.usage.summaryOutputTokens = r.usage.output;
		} catch (e) {
			// Rung 3: summarizer failure → native; no salvage, no retry (SPEC §8).
			const error = e instanceof Error ? e.message : String(e);
			record.fallback = { rung: 3, error };
			record.latencyMs.summary = Date.now() - t1;
			deps.writeTelemetry(record);
			return {
				outcome: "fallback",
				toast: `smart-compact: fell back to native (rung 3: ${error})`,
				compaction: undefined,
			};
		}
		record.latencyMs.summary = Date.now() - t1;
	}

	// Compose (SPEC §6.3) + file tags (§6.5): whole-span file lists, incl. dropped reads.
	const { readFiles, modifiedFiles } = fileLists(region.fileOps);
	const composed = composeDocument(all, actions, { previousSummary: region.previousSummary, llmSummary }) + fileTags(readFiles, modifiedFiles);

	// Reduction gate (SPEC §6.6, rung 4): context delta tokensBefore → composed + kept region.
	// minReductionPct 0 disables; the bar also guards the all-keep re-trigger loop.
	const after = estimateTextTokens(composed) + region.keptRegionTokens;
	const reductionPct = region.tokensBefore > 0 ? Math.round((1 - after / region.tokensBefore) * 1000) / 10 : 0;
	record.reductionPct = reductionPct;
	if (opts.minReductionPct !== 0 && reductionPct < opts.minReductionPct) {
		record.fallback = { rung: 4, error: `reduction ${reductionPct}% below minReductionPct ${opts.minReductionPct}%` };
		deps.writeTelemetry(record);
		return {
			outcome: "fallback",
			toast: `smart-compact: fell back to native (reduction ${reductionPct}% below minReductionPct ${opts.minReductionPct}%)`,
			compaction: undefined,
		};
	}

	deps.writeTelemetry(record);
	const sign = reductionPct >= 0 ? "−" : "+";
	const toast = `smart-compact: kept ${classCounts.keep} · summarized ${classCounts.summarize} · dropped ${classCounts.drop} — ${fmtTok(region.tokensBefore)} → ${fmtTok(after)} tok (${sign}${Math.abs(reductionPct)}%)`;
	return {
		outcome: "compacted",
		toast,
		compaction: {
			summary: composed,
			firstKeptEntryId: region.firstKeptEntryId,
			tokensBefore: region.tokensBefore,
			estimatedTokensAfter: after,
			usage,
			details: { readFiles, modifiedFiles, smartCompact: record },
		},
	};
}

// The compaction we return IS a pi CompactionResult (usage is pi's Usage verbatim);
// only the injected summarizer's structural type is looser than pi's Usage shape.
export type LiveCompactionResult = CompactionResult<LiveCompaction["details"]>;
