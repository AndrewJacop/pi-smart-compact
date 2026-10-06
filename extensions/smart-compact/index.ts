// @andrewjacop/pi-smart-compact — fail-open shell (SPEC §2, §8; v1 tickets 01+02+04).
// Registers session_before_compact + session_before_tree. Every path but the smart
// one returns undefined = native pi compaction/branch summary: the extension is
// never worse than native. Shadow mode = decisions only; live mode = decision-driven
// composition via the targeted summarizer + composer + reduction gate (ticket 04).
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionBeforeCompactResult, SessionBeforeTreeEvent } from "@earendil-works/pi-coding-agent";
import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import { clefClient, type DecisionClient } from "./client.ts";
import { effectiveProfile, isObject, missingBackendKey, validateSmartCompact } from "./config.ts";
import { keptRegionTokens, runLive, type SummarizerFn } from "./live.ts";
import { loadQuestionSet, runShadow } from "./pipeline.ts";
import { appendTelemetry, telemetryDir } from "./telemetry.ts";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const DEFAULT_QUESTIONS = fileURLToPath(new URL("./questions.default.json", import.meta.url));

function overrideQuestionsPath(): string {
	return join(telemetryDir(), "questions.json");
}

function defaultMakeClient(profile: { endpoint: string }, decisionTimeoutMs: number): DecisionClient {
	return clefClient({ endpoint: profile.endpoint, apiKey: process.env.OPTOLLM_API_KEY ?? "", timeoutMs: decisionTimeoutMs });
}

/** The default summarizer: pi's own summary-with-usage call, authed off the session model. */
function defaultMakeSummarizer(ctx: ExtensionContext): SummarizerFn {
	return async (msgs, opts) => {
		const model = ctx.model;
		if (!model) throw new Error("no session model to summarize with");
		// The summarizer resolves its own auth off the session model (modelRegistry path).
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		// No previousSummary param — the composed head owns iteration (SPEC §6.2/§6.3).
		const headers = auth.headers
			? (Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => entry[1] !== null)) as Record<string, string>)
			: undefined;
		const r = await generateSummaryWithUsage(msgs as never, model, opts.reserveTokens, auth.apiKey, headers, opts.signal, opts.customInstructions);
		return { text: r.text, usage: r.usage };
	};
}

export default function smartCompact(pi: ExtensionAPI) {
	// Warn-once-per-session state; a new session starts with a clean slate.
	const warned = new Set<string>();
	pi.on("session_start", () => warned.clear());

	pi.on("session_before_compact", async (event, ctx) => run(pi, ctx, warned, event, "compact"));

	pi.on("session_before_tree", async (event, ctx) => {
		// Decline UX is a pure no-op (SPEC §9): no decision call, no toast, no record.
		if (!event.preparation.userWantsSummary) return undefined;
		return run(pi, ctx, warned, event, "branch");
	});
}

type Kind = "compact" | "branch";

/**
 * The fallback shell. Gates in order; the smart path (shadow pipeline) sits behind
 * the last gate. Every gate failing, and any pipeline failure, fail open to native.
 */
export async function run(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	warned: Set<string>,
	event: SessionBeforeCompactEvent | SessionBeforeTreeEvent,
	kind: Kind,
	makeClient: (profile: { endpoint: string }, decisionTimeoutMs: number) => DecisionClient = defaultMakeClient,
	makeSummarizer: (ctx: ExtensionContext) => SummarizerFn = defaultMakeSummarizer,
): Promise<SessionBeforeCompactResult | undefined> {
	const raw = (pi.getSettings() as Record<string, unknown>).smartCompact;

	// mode "off" is inert before anything else: no decision call, no toasts, no records.
	if (isObject(raw) && raw.mode === "off") {
		return undefined;
	}

	const v = validateSmartCompact(raw);
	if (!v.ok) {
		// Fail loud: name the problem, smart path off, native compaction. Never guess.
		// Loud means every run — warn-once is reserved for rung 0 (SPEC §8).
		ctx.ui.notify(`smart-compact: invalid config — ${v.errors.join("; ")} — smart compaction off, using native compaction.`, "warning");
		return undefined;
	}
	const cfg = v.config;

	// Rung 0 (SPEC §8): no backend key. Checked live every run so the smart path
	// resumes automatically once the key appears; warn once per session.
	const missing = missingBackendKey(cfg.backend);
	if (missing) {
		warnOnce(warned, `key:${missing}`, `smart-compact: ${missing} is not set — using native compaction. Set the key to enable smart compaction.`, ctx);
		return undefined;
	}

	// Question text: bundled defaults + validated global override; malformed → loud, smart off.
	const q = loadQuestionSet({ defaultPath: DEFAULT_QUESTIONS, overridePath: overrideQuestionsPath() });
	if (!q.ok) {
		ctx.ui.notify(`smart-compact: invalid questions override — ${q.errors.join("; ")} — smart compaction off, using native compaction.`, "warning");
		return undefined;
	}

	const profile = effectiveProfile(cfg.backend, cfg.profiles[cfg.backend]);
	const decisionDeps = {
		client: makeClient({ endpoint: profile?.endpoint ?? "" }, cfg.decisionTimeoutMs),
		writeTelemetry: (record: unknown) => {
			appendTelemetry(telemetryDir(), record);
		},
		questionSet: q.questions,
	};

	if (cfg.mode === "live") {
		// Branch summaries route through the same pipeline in ticket 07; until then native (fail-open, silent).
		if (kind === "branch") return undefined;
		const evt = event as SessionBeforeCompactEvent;
		const prep = evt.preparation;
		const live = await runLive(
			{ ...decisionDeps, summarize: makeSummarizer(ctx) },
			{ backend: cfg.backend, matrix: cfg.matrix, minReductionPct: cfg.minReductionPct },
			profile,
			{
				// Region for decision and summary: messagesToSummarize ∪ split-turn prefix (SPEC §6.7).
				messages: [...prep.messagesToSummarize, ...prep.turnPrefixMessages] as Array<Record<string, unknown>>,
				previousSummary: prep.previousSummary,
				fileOps: prep.fileOps,
				tokensBefore: prep.tokensBefore,
				keptRegionTokens: keptRegionTokens(evt.branchEntries, prep.firstKeptEntryId),
				reserveTokens: prep.settings.reserveTokens,
				firstKeptEntryId: prep.firstKeptEntryId,
				customInstructions: evt.customInstructions,
				signal: evt.signal,
			},
		);
		if (live.toast) ctx.ui.notify(live.toast, live.outcome === "compacted" ? "info" : "warning");
		// LiveCompaction is a pi CompactionResult (details is the generic param; usage is pi's Usage).
		return live.compaction ? { compaction: live.compaction } : undefined;
	}

	// Region: messagesToSummarize for compactions; message entries for branch summaries (SPEC §9).
	const messages =
		kind === "compact"
			? (event as SessionBeforeCompactEvent).preparation.messagesToSummarize
			: (event as SessionBeforeTreeEvent).preparation.entriesToSummarize.flatMap((e) => (e.type === "message" ? [e.message] : []));
	const previousSummary = kind === "compact" ? (event as SessionBeforeCompactEvent).preparation.previousSummary : undefined;

	const result = await runShadow(
		decisionDeps,
		{ backend: cfg.backend, matrix: cfg.matrix },
		profile,
		{ messages: messages as Array<Record<string, unknown>>, previousSummary, kind, signal: event.signal },
	);

	if (result.toast) ctx.ui.notify(result.toast, result.outcome === "fallback" ? "warning" : "info");

	// Shadow always returns native — decisions-only, the counterfactual lives in telemetry.
	return undefined;
}

function warnOnce(warned: Set<string>, key: string, message: string, ctx: ExtensionContext): void {
	if (warned.has(key)) return;
	warned.add(key);
	ctx.ui.notify(message, "warning");
}
