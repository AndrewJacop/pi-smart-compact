// Privacy redaction (SPEC §10; v1 ticket 05). `privacy: "redacted"` (the code-enforced
// default) scrubs ALL egress text on BOTH channels: the decision-request state/questions
// AND the summary request (the summarizer defaults to the session model — a remote LLM).
// Nothing is excluded: tool results and thinking still get asked and summarized, carrying
// redacted text. Privacy never touches the matrix and there is no per-profile bypass;
// `full` passes everything verbatim.
//
// The pattern list is code, not config — extending it is a PR. Redaction is deterministic
// and runs BEFORE the idempotency-key content hash (§8.4), so identical redacted content
// hashes identically. It is an EGRESS filter only: on-box text (session, composed keeps,
// telemetry JSONL) is untouched.
//
// Accepted trade-off (stated honestly in the README): pattern redaction is never complete
// — obfuscated keys, base64 blobs and non-key-shaped credentials slip through. The user
// chose simplicity over exclusion guarantees knowingly.
import type { Privacy } from "./config.ts";

export const REDACTED = "[REDACTED]";

// Ordered, most-specific first: PEM blocks (multiline) die before the KEY=value scan can
// nibble at their base64 bodies; header/bearer before fixed-shape keys; the greedy
// KEY=value assignments last. False positives redact conservatively (e.g. MAX_TOKEN=4096);
// the "never complete" risk is false negatives, accepted above.
const TEXT_PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
	/["']?\b(?:authorization|[-_a-z]*api[-_]?key)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|\S+(?:[ \t]+\S+)?)/gi,
	/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
	/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
	/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/g,
	/\b[A-Za-z0-9_-]*(?:api[-_]?key|auth[-_]?key|access[-_]?key|secret[-_]?key|private[-_]?key|encryption[-_]?key|secret|token|password|passwd|passphrase|credentials?)\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s'"\n]+)/gi,
];

/** Object keys naming credentials: string values under them are redacted whole. */
const CREDENTIAL_KEY = /(?:api[-_]?key|auth[-_]?key|access[-_]?key|secret[-_]?key|private[-_]?key|encryption[-_]?key|secret|token|password|passwd|passphrase|credentials?)$/i;

/** Egress payloads are JSON-shaped (pi messages, decision requests): strings, numbers, booleans, nulls, arrays, objects. */
type EgressValue = string | number | boolean | null | EgressValue[] | { [key: string]: EgressValue };

export function redactText(text: string): string {
	let out = text;
	for (const p of TEXT_PATTERNS) out = out.replace(p, REDACTED);
	return out;
}

/**
 * The single "redacted unless full" policy point (SPEC §10): every egress payload on both
 * channels passes through here — the decision request and the summary request. Absent or
 * "redacted" scrubs; only exactly "full" passes verbatim. There is no per-profile bypass.
 */
export function redactUnlessFull<T>(privacy: Privacy | undefined, value: T): T {
	return privacy === "full" ? value : redactEgress(value);
}

/**
 * Deep-walk a JSON-ish egress payload: every string leaf is pattern-redacted, and string
 * values under credential-named keys are redacted whole. Copies containers, never mutates
 * the input (summary-channel messages are shared with the session).
 */
export function redactEgress<T>(value: T): T {
	return walk(value as EgressValue, false) as T;
}

function walk(value: EgressValue, underCredentialKey: boolean): EgressValue {
	if (typeof value === "string") return underCredentialKey ? REDACTED : redactText(value);
	if (Array.isArray(value)) return value.map((v) => walk(v, false));
	if (value !== null && typeof value === "object") {
		const out: { [key: string]: EgressValue } = {};
		for (const [k, v] of Object.entries(value)) out[k] = walk(v, typeof v === "string" && CREDENTIAL_KEY.test(k));
		return out;
	}
	return value;
}
