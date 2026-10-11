// @andrewjacop/pi-smart-compact — fail-open shell (SPEC §2, §8; v1 tickets 01+02+04).
// Registers session_before_compact + session_before_tree. Every path but the smart
// one returns undefined = native pi compaction/branch summary: the extension is
// never worse than native. Shadow mode = decisions only; live mode = decision-driven
// composition via the targeted summarizer + composer + reduction gate (ticket 04).
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionBeforeCompactResult, SessionBeforeTreeEvent, SessionBeforeTreeResult } from "@earendil-works/pi-coding-agent";
import { estimateTokens, generateSummaryWithUsage, prepareBranchEntries } from "@earendil-works/pi-coding-agent";
import { jevClient, type DecisionClient } from "./client.ts";
import { clientOptionsFor, effectiveProfile, isObject, missingBackendKey, validateSmartCompact, type BackendProfile } from "./config.ts";
import { keptRegionTokens, clampKeptRegion, runLive, type LiveFileOps, type LiveResult, type SummarizerFn } from "./live.ts";
import { loadQuestionSet, runShadow } from "./pipeline.ts";
import { appendTelemetry, telemetryDir } from "./telemetry.ts";
import { estimateTextTokens } from "./units.ts";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const DEFAULT_QUESTIONS = fileURLToPath(new URL("./questions.default.json", import.meta.url));

function overrideQuestionsPath(): string {
	return join(telemetryDir(), "questions.json");
}

function defaultMakeClient(backend: string, profile: BackendProfile | null, decisionTimeoutMs: number): DecisionClient {
	return jevClient(clientOptionsFor(backend, profile, decisionTimeoutMs));
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

/** pi's branchSummary.reserveTokens default (settings-manager) — the branch summarizer's reserve. */
const BRANCH_RESERVE_TOKENS = 16384;

/**
 * Branch region (SPEC §9, native parity): the abandoned branch's message entries verbatim;
 * prior compaction and branch-summary entries become user-role text units — already-distilled
 * summaries the matrix pins keep (§4), so they ride the composed doc like native's do (§1: never
 * worse than native). Custom messages pass in pi's own shape (pinned unknown → keep). Shadow
 * and live share this one source.
 */
function branchRegionMessages(event: SessionBeforeTreeEvent): Array<Record<string, unknown>> {
	return event.preparation.entriesToSummarize.flatMap((e): Array<Record<string, unknown>> => {
		switch (e.type) {
			case "message":
				// SAFETY: pi messages are plain JSON objects from the session file — the pipeline's
				// structural reads (role/content) are exactly what entry.message carries.
				return [e.message as unknown as Record<string, unknown>];
			case "compaction":
			case "branch_summary":
				// ≙ pi's createCompactionSummaryMessage/createBranchSummaryMessage (unexported),
				// normalized to user-role text both the pipeline and the summarizer render.
				return [{ role: "user", content: [{ type: "text", text: e.summary }], timestamp: e.timestamp }];
			case "custom_message":
				// ≙ pi's createCustomMessage (unexported); pinned keep (unknown unit), never summarized.
				return [{ role: "custom", customType: e.customType, content: e.content, display: e.display, details: e.details, timestamp: e.timestamp }];
			default:
				return [];
		}
	});
}

/** pi's native branch file ops over the whole span (incl. cumulative branch_summary details) — FileOperations ≡ LiveFileOps. */
function branchFileOps(event: SessionBeforeTreeEvent): LiveFileOps {
	return prepareBranchEntries(event.preparation.entriesToSummarize, 0).fileOps;
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
 * §8.2's toast must SURVIVE pi's post-compaction transcript rebuild: the hook notifies while
 * pi is still inside compact(), and compaction_end then clears + re-renders the chat (same for
 * the tree-navigation rebuild), erasing the line before anyone can read it (found live on the
 * 451-unit OPTOLINK run, 2026-10-07). Deferring by one macrotask lands the line after the
 * rebuild — at the end of the transcript in the TUI, ~instantly in RPC/print modes.
 */
function deferredNotify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	setTimeout(() => ctx.ui.notify(message, level), 0);
}

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
	makeClient: (backend: string, profile: BackendProfile | null, decisionTimeoutMs: number) => DecisionClient = defaultMakeClient,
	makeSummarizer: (ctx: ExtensionContext) => SummarizerFn = defaultMakeSummarizer,
): Promise<SessionBeforeCompactResult | SessionBeforeTreeResult | undefined> {
	const raw = (pi.getSettings() as Record<string, unknown>).smartCompact;

	// mode "off" is inert before anything else: no decision call, no toasts, no records.
	if (isObject(raw) && raw.mode === "off") {
		return undefined;
	}

	const v = validateSmartCompact(raw);
	if (!v.ok) {
		// Fail loud: name the problem, smart path off, native compaction. Never guess.
		// Loud means every run — warn-once is reserved for rung 0 (SPEC §8).
		deferredNotify(ctx, `smart-compact: invalid config — ${v.errors.join("; ")} — smart compaction off, using native compaction.`, "warning");
		return undefined;
	}
	const cfg = v.config;

	// Kept-region clamp (SPEC §7): live-mode cut movement only — shadow/off return native
	// and cannot move pi's cut. Runs BEFORE rung 0: N ≥ session length is a config edge,
	// the one documented cancel (manual throws "Compaction cancelled", auto returns false).
	const clamp =
		cfg.mode === "live" && kind === "compact" && cfg.keptMessages
			? clampKeptRegion((event as SessionBeforeCompactEvent).branchEntries, (event as SessionBeforeCompactEvent).preparation.firstKeptEntryId, cfg.keptMessages)
			: undefined;
	if (clamp?.cancel) {
		deferredNotify(
			ctx,
			`smart-compact: keptMessages ${cfg.keptMessages} exempts every summarizable message — compaction cancelled. Size N so summary + kept region fit under the trigger threshold.`,
			"warning",
		);
		return { cancel: true };
	}

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
		deferredNotify(ctx, `smart-compact: invalid questions override — ${q.errors.join("; ")} — smart compaction off, using native compaction.`, "warning");
		return undefined;
	}

	const profile = effectiveProfile(cfg.backend, cfg.profiles[cfg.backend]);
	const decisionDeps = {
		client: makeClient(cfg.backend, profile, cfg.decisionTimeoutMs),
		writeTelemetry: (record: unknown) => {
			appendTelemetry(telemetryDir(), record);
		},
		questionSet: q.questions,
	};

	if (cfg.mode === "live") {
		const liveOpts = { backend: cfg.backend, matrix: cfg.matrix, minReductionPct: cfg.minReductionPct, privacy: cfg.privacy };
		const notifyLive = (live: LiveResult) => {
			if (live.toast) deferredNotify(ctx, live.toast, live.outcome === "compacted" ? "info" : "warning");
		};
		if (kind === "branch") {
			// Branch summaries route through the SAME pipeline (ticket 07, SPEC §9): same matrix,
			// ladder, repair, composer, gate — only the region source, the gate's delta (no cut
			// point: "drop" omits from the summary only, the branch stays navigable), and the
			// result mapping differs. keptMessages stays compact-only: with no cut point, an exempt
			// tail would be silently lost from the summary. {cancel} is never returned from this hook.
			const evt = event as SessionBeforeTreeEvent;
			const prep = evt.preparation;
			const live = await runLive(
				{ ...decisionDeps, summarize: makeSummarizer(ctx) },
				liveOpts,
				profile,
				{
					messages: branchRegionMessages(evt),
					previousSummary: undefined,
					fileOps: branchFileOps(evt),
					// Gate "before": pi's estimator over the region's entries (tree events carry no
					// tokensBefore); prior summaries count via the same chars/4 formula. Custom-message
					// entries (rare) are skipped — makes the gate marginally stricter, never looser.
					tokensBefore: prep.entriesToSummarize.reduce((s, e) => {
						if (e.type === "message") return s + estimateTokens(e.message);
						if (e.type === "compaction" || e.type === "branch_summary") return s + estimateTextTokens(e.summary);
						return s;
					}, 0),
					keptRegionTokens: 0,
					reserveTokens: (pi.getSettings() as { branchSummary?: { reserveTokens?: number } }).branchSummary?.reserveTokens ?? BRANCH_RESERVE_TOKENS,
					customInstructions: prep.customInstructions,
					signal: evt.signal,
					kind: "branch",
				},
			);
			notifyLive(live);
			if (!live.compaction) return undefined;
			const { summary, details, usage } = live.compaction;
			return { summary: { summary, details, usage }, label: "smart-compact" };
		}
		const evt = event as SessionBeforeCompactEvent;
		const prep = evt.preparation;
		// The clamp result when the knob is unset/inactive: pi's cut verbatim, nothing exempt.
		const kept = clamp ?? { cancel: false as const, firstKeptEntryId: prep.firstKeptEntryId, exemptCount: 0 };
		// Exempt = the span messages the clamped cut retains (SPEC §3.2): sliced off before
		// splitting, they are never asked, never summarized, and stay verbatim via the cut.
		// The slice boundary assumes span messages ≡ spanMessageCount over raw entries —
		// exact without context edits (v1); re-derive via buildSessionProjection if that changes.
		const span = [...prep.messagesToSummarize, ...prep.turnPrefixMessages] as Array<Record<string, unknown>>;
		const live = await runLive(
			{ ...decisionDeps, summarize: makeSummarizer(ctx) },
			liveOpts,
			profile,
			{
				// Region for decision and summary: messagesToSummarize ∪ split-turn prefix (SPEC §6.7),
				// minus the kept-region exemption tail.
				messages: span.slice(0, Math.max(0, span.length - kept.exemptCount)),
				previousSummary: prep.previousSummary,
				fileOps: prep.fileOps,
				tokensBefore: prep.tokensBefore,
				// The gate reads the REAL kept region — the clamped one (§6.6 context delta).
				keptRegionTokens: keptRegionTokens(evt.branchEntries, kept.firstKeptEntryId),
				reserveTokens: prep.settings.reserveTokens,
				firstKeptEntryId: kept.firstKeptEntryId,
				customInstructions: evt.customInstructions,
				signal: evt.signal,
				kind: "compact",
			},
		);
		notifyLive(live);
		// LiveCompaction is a pi CompactionResult (details is the generic param; usage is pi's Usage).
		return live.compaction ? { compaction: live.compaction } : undefined;
	}

	// Region: the shared branch source for tree navigation; messagesToSummarize for compactions (SPEC §9).
	const messagesSource =
		kind === "compact"
			? (event as SessionBeforeCompactEvent).preparation.messagesToSummarize
			: branchRegionMessages(event as SessionBeforeTreeEvent);
	// Shadow is live's counterfactual (§8.1), so it exempts the same tail (SPEC §3.2) —
	// but never cancels: shadow cannot move pi's cut, so the config edge stays live-only.
	const shadowExempt =
		kind === "compact" && cfg.keptMessages
			? clampKeptRegion((event as SessionBeforeCompactEvent).branchEntries, (event as SessionBeforeCompactEvent).preparation.firstKeptEntryId, cfg.keptMessages)
			: undefined;
	const exemptCount = shadowExempt && !shadowExempt.cancel ? shadowExempt.exemptCount : 0;
	const messages = messagesSource.slice(0, Math.max(0, messagesSource.length - exemptCount));
	const previousSummary = kind === "compact" ? (event as SessionBeforeCompactEvent).preparation.previousSummary : undefined;

	const result = await runShadow(
		decisionDeps,
		{ backend: cfg.backend, matrix: cfg.matrix, privacy: cfg.privacy },
		profile,
		{ messages: messages as Array<Record<string, unknown>>, previousSummary, kind, signal: event.signal },
	);

	if (result.toast) deferredNotify(ctx, result.toast, result.outcome === "fallback" ? "warning" : "info");

	// Shadow always returns native — decisions-only, the counterfactual lives in telemetry.
	return undefined;
}

function warnOnce(warned: Set<string>, key: string, message: string, ctx: ExtensionContext): void {
	if (warned.has(key)) return;
	warned.add(key);
	deferredNotify(ctx, message, "warning");
}
