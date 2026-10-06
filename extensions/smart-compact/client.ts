// DecisionClient contract + the one canonical Jev-wire adapter (SPEC §5.1/§5.2, ticket 08).
// All four shipped backends (clef, jev/freejev, ollama, jev-direct) speak this shape:
// request { state, model?, questions }, questions carry `criteria` (action → description,
// 2–26 entries); answers keyed by question id: { type: "choice", choice, probabilities,
// confidence }; usage bills input only. Per-backend deltas are adapter options:
//   ollama     — no apiKey → no authorization header
//   jev        — server pins the model (omitModel) and mandates an Idempotency-Key
//                (§8.4): sha256 of the POST-redaction body + per-client attempt counter,
//                so identical runs derive the same key and a retry attempt a fresh one
// Fail-open is client policy — the client never retries, it reports ok:false (SPEC §8).

import { createHash } from "node:crypto";

export type DecisionErrorKind =
	| "auth"
	| "rate_limit"
	| "input_too_large"
	| "overloaded"
	| "network"
	| "timeout"
	| "other";

export interface DecisionError {
	kind: DecisionErrorKind;
	retryable: boolean;
	/** Fallback ladder rung: 1 = transport-class (→ native), 2 = malformed response (→ per-unit salvage, wholly unusable → native). */
	rung: 1 | 2;
	message: string;
}

export interface DecisionAnswer {
	type: "choice";
	choice: string;
	probabilities?: Record<string, number>;
	confidence?: number;
}

export interface DecisionQuestion {
	type: "choice";
	instructions: string;
	/** action → description; Object.keys = the candidates (backend caps: 2–26 for clef). */
	criteria: Record<string, string>;
}

export interface DecisionRequest {
	state: unknown;
	model: string;
	questions: Record<string, DecisionQuestion>;
}

export type DecisionBatch =
	| { ok: true; answers: Record<string, DecisionAnswer>; model: string; inputTokens: number }
	| { ok: false; error: DecisionError };

export interface DecisionClient {
	decide(req: DecisionRequest, signal?: AbortSignal): Promise<DecisionBatch>;
}

export interface JevClientOptions {
	endpoint: string;
	/** Empty = no authorization header (self-hosted ollama). */
	apiKey: string;
	timeoutMs: number;
	/** jev: the model is pinned server-side — omit it from the request body. */
	omitModel?: boolean;
	/** jev: mandatory Idempotency-Key = content-hash + attempt (SPEC §8.4). */
	idempotency?: boolean;
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

function err(kind: DecisionErrorKind, retryable: boolean, rung: 1 | 2, message: string): DecisionBatch {
	return { ok: false, error: { kind, retryable, rung, message } };
}

function statusKind(status: number): DecisionErrorKind {
	if (status === 401 || status === 403) return "auth";
	if (status === 429) return "rate_limit";
	if (status === 400 || status === 413) return "input_too_large";
	if (status >= 500) return "overloaded";
	return "other"; // 402 empty balance, 404, 418 — all rung 1, fail open to native
}

export function jevClient(opts: JevClientOptions): DecisionClient {
	const fetchImpl = opts.fetchImpl ?? fetch;
	let attempt = 0; // per-client (≈ per-run): identical runs restart at 1, retries on one client increment
	return {
		async decide(req, signal): Promise<DecisionBatch> {
			if (signal?.aborted) return err("timeout", false, 1, "aborted before the request");
			const body = opts.omitModel ? { state: req.state, questions: req.questions } : req;
			const bodyText = JSON.stringify(body);
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
			if (opts.idempotency) {
				headers["idempotency-key"] = `${createHash("sha256").update(bodyText).digest("hex").slice(0, 32)}-${++attempt}`;
			}
			const ctrl = new AbortController();
			const onOuter = () => ctrl.abort();
			signal?.addEventListener("abort", onOuter, { once: true });
			const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
			// Race the transport against abort: the injected/global fetch honors ctrl.signal,
			// but a fake or stuck transport must not hang the hook past the deadline.
			const abortP = new Promise<never>((_, reject) => {
				ctrl.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			});
			let res: Response;
			try {
				res = await Promise.race([
					fetchImpl(opts.endpoint, {
						method: "POST",
						headers,
						body: bodyText,
						signal: ctrl.signal,
					}),
					abortP,
				]);
			} catch (e) {
				if (e instanceof Error && e.name === "AbortError") return err("timeout", false, 1, `decision timed out after ${opts.timeoutMs}ms`);
				return err("network", true, 1, `fetch failed: ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onOuter);
			}
			if (!res.ok) {
				const text = (await res.text().catch(() => "")).slice(0, 200);
				const kind = statusKind(res.status);
				return err(kind, kind === "rate_limit" || kind === "overloaded", 1, `HTTP ${res.status}: ${text}`);
			}
			let json: unknown;
			try {
				json = await res.json();
			} catch {
				return err("other", false, 2, "response was not JSON");
			}
			const payload = (json as { result?: unknown })?.result ?? json;
			const answers = (payload as { answers?: unknown })?.answers;
			if (typeof answers !== "object" || answers === null) {
				return err("other", false, 2, `malformed response: answers is ${answers === undefined ? "missing" : typeof answers}`);
			}
			const p = payload as { model?: unknown; usage?: { input_tokens?: unknown } };
			return {
				ok: true,
				answers: answers as Record<string, DecisionAnswer>,
				model: typeof p.model === "string" ? p.model : "unknown",
				inputTokens: typeof p.usage?.input_tokens === "number" ? p.usage.input_tokens : 0,
			};
		},
	};
}
