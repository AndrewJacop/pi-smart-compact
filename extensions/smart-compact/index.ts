// @andrewjacop/pi-smart-compact — fail-open shell (SPEC §2, §8; v1 ticket 01).
// Registers session_before_compact + session_before_tree. Every path but the smart
// one returns undefined = native pi compaction/branch summary: the extension is
// never worse than native.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isObject, missingBackendKey, validateSmartCompact } from "./config.ts";

export default function smartCompact(pi: ExtensionAPI) {
	// Warn-once-per-session state; a new session starts with a clean slate.
	const warned = new Set<string>();
	pi.on("session_start", () => warned.clear());

	pi.on("session_before_compact", async (_event, ctx) => run(pi, ctx, warned));

	pi.on("session_before_tree", async (event, ctx) => {
		// Decline UX is a pure no-op (SPEC §9): no decision call, no toast, no record.
		if (!event.preparation.userWantsSummary) return undefined;
		return run(pi, ctx, warned);
	});
}

/**
 * The fallback shell. Gates in order; the smart path lands behind the last gate
 * (tickets 02+). Every gate failing, and the skeleton itself, fail open to native.
 */
function run(pi: ExtensionAPI, ctx: ExtensionContext, warned: Set<string>): undefined {
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

	// Rung 0 (SPEC §8): no backend key. Checked live every run so the smart path
	// resumes automatically once the key appears; warn once per session.
	const missing = missingBackendKey(v.config.backend);
	if (missing) {
		warnOnce(warned, `key:${missing}`, `smart-compact: ${missing} is not set — using native compaction. Set the key to enable smart compaction.`, ctx);
		return undefined;
	}

	// Smart path: decision pipeline lands here (v1 tickets 02+).
	// The skeleton has no pipeline yet, so it always falls open to native.
	return undefined;
}

function warnOnce(warned: Set<string>, key: string, message: string, ctx: ExtensionContext): void {
	if (warned.has(key)) return;
	warned.add(key);
	ctx.ui.notify(message, "warning");
}
