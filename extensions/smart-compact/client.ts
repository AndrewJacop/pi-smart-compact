// DecisionClient contract + the clef (optollm gateway) adapter (SPEC §5.1/§5.2).
// Wire shape is spike-verified against live optollm: request { state, model, questions },
// questions carry `criteria` (action → description, 2–26 entries); answers keyed by
// question id: { type: "choice", choice, probabilities, confidence }; usage bills input only.
// Fail-open is client policy — the client never retries, it reports ok:false (SPEC §8).

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

export interface ClefClientOptions {
	endpoint: string;
	apiKey: string;
	timeoutMs: number;
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
	return "other";
}

export function clefClient(opts: ClefClientOptions): DecisionClient {
	const fetchImpl = opts.fetchImpl ?? fetch;
	return {
		async decide(req, signal): Promise<DecisionBatch> {
			if (signal?.aborted) return err("timeout", false, 1, "aborted before the request");
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
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${opts.apiKey}`,
						},
						body: JSON.stringify(req),
						signal: ctrl.signal,
					}),
					abortP,
				]);
			} catch (e) {
				const aborted = e instanceof Error && e.name === "AbortError";
				return err(aborted ? "timeout" : "network", !aborted, 1, aborted ? `decision timed out after ${opts.timeoutMs}ms` : `fetch failed: ${e instanceof Error ? e.message : String(e)}`);
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
